"""Stage C: for an eligible `simple_fix`, a builder claude in a fresh `bugfix/<code>` worktree, the path guard, both
red teams, then a push and a draft PR for a person. Never merges, never publishes, never force-pushes."""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from . import claude_cli, guard, log, triage
from .cache import Cache
from .client import Client, WorkerError
from .config import Config

MIN_CONFIDENCE = 0.8
MAX_FILES = 5
MAX_LINES = 150
BUILDER_TIMEOUT = 1800
REDTEAM_TIMEOUT = 1800
GH_TIMEOUT = 300
STATUS_PAUSES = (1, 2, 0)  # seconds after each of the 3 status tries: 3 s of backoff in all (the lead's cap: 5 s)
REDTEAM_NOT_RUN = 4  # redteam_fast.sh: no verdict (CLI, auth, network or usage limit); never a pass
PR_URL_RX = re.compile(r"https://github\.com/.+/pull/\d+")
PENDING_MAX_AGE = 7 * 86400  # seconds: a status still undelivered after a week is stale news, dropped (send_pending)
STATUS_RX = re.compile(r"[a-z_]{1,20}")  # a report status as it may appear in a log line
IDENTITY = ("DamianStBeat", "205100563+DamianStBeat@users.noreply.github.com")
CO_AUTHOR = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
GENERATED = "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
AREAS = {"lobby": "Lobby", "match": "GamePlay"}
# The builder may rewrite any file in its checkout, `.git` and nested repos included: hooks and fsmonitor are off on
# every git command run in the worktree, so nothing it wrote is ever executed by us.
SAFE_GIT = ("-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false")


class FixFailed(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def not_eligible(cfg: Config, cache: Cache, stage_a: dict[str, Any], stage_b: dict[str, Any]) -> str | None:
    if stage_a.get("injection_suspected") is not False:
        return "injection_suspected"
    if stage_b["risk_paths"] or any(guard.is_risky(f["path"]) for f in stage_b["likely_files"]):
        return "risk_path"
    if stage_b["confidence"] < MIN_CONFIDENCE:
        return "low_confidence"
    if cache.count("fix") >= cfg.daily_fix_cap:
        return "fix_cap"
    return None


def run(cfg: Config, client: Client, cache: Cache, code: str, row: dict[str, Any], stage_a: dict[str, Any],
        stage_b: dict[str, Any], tmp: Path) -> None:  # fmt: skip
    if stage_b["verdict"] != "simple_fix" or cfg.dry_run:
        return
    reason = not_eligible(cfg, cache, stage_a, stage_b)
    url = None
    if reason is None:
        cache.bump("fix")  # counted when started: a failed attempt spends the day's budget too
        log("stage C started", code=code)
        try:
            url = attempt(cfg, code, row, stage_a, stage_b, tmp)
        except FixFailed as exc:
            reason = exc.reason
        except Exception as exc:  # cleaned up by attempt's `finally`; a person must still hear of it
            log("stage C error", code=code, error=type(exc).__name__)
            reason = "agent_failed"
    body = {"status": "looking", "prUrl": url} if url else {"status": "looking", "note": f"needs_person: {reason}"}
    log("stage C", code=code, result="draft_pr" if url else reason)
    post_status(client, cache, code, body)


def post_status(client: Client, cache: Cache, code: str, body: dict[str, Any]) -> None:
    """3 tries in the round; still failing, it waits in the cache's pending_status for the next rounds (send_pending).
    The queue never offers this report again once triaged: without it the PR link or the note would be lost."""
    for pause in STATUS_PAUSES:
        try:
            client.post_json(f"/agent/reports/{code}/status", body)
            return
        except WorkerError as exc:
            log("status failed", code=code, status=exc.status or "none")
        time.sleep(pause)
    cache.add_pending_status(code, json.dumps(body))
    log("status pending", code=code)


def send_pending(client: Client, cache: Cache) -> None:
    """Once per round, before the queue, oldest first: each pending status once, and only onto a report still
    `looking`. Kept on a transient failure (no answer: then stop); dropped on another 4xx or after 7 days."""
    now = int(time.time())
    for code, body, at in cache.pending_statuses():
        if now - at > PENDING_MAX_AGE:
            log("status expired", code=code)
            cache.drop_pending_status(code)
            continue
        superseded = None
        try:
            current = _current(client, code)
            # Only the status decides: a person on the desk who moved the report off `looking` wins, a resend would put
            # `fixed` or `closed` back. Not updated_at: a player's upload moves it with no status change (uploads.ts),
            # and a `looking` resent onto `looking` changes no status, it only delivers the PR link or the note.
            if current is not None and current != "looking":
                superseded = current if STATUS_RX.fullmatch(current) else "other"
            elif current is not None:
                client.post_json(f"/agent/reports/{code}/status", json.loads(body))
        except WorkerError as exc:
            if transient(exc.status):
                log("status still pending", code=code, status=exc.status or "none")
                if exc.status is None:  # unreachable: every other try would wait its own timeout
                    break
                continue
            log("status dropped", code=code, status=exc.status)  # the worker refuses it: resending cannot help
        else:
            if current is None:  # kept: the 7 days bound a worker that keeps answering badly
                log("status still pending", code=code, status="bad_answer")
                continue
            if superseded:
                log("status superseded", code=code, current=superseded)  # the status read, never the stored body
            else:
                log("status sent", code=code)
        cache.drop_pending_status(code)


def _current(client: Client, code: str) -> str | None:
    """The report's status as the worker has it now; None for an answer without a string status."""
    answer = client.get_json(f"/agent/reports/{code}")
    row = answer.get("report") if isinstance(answer, dict) and isinstance(answer.get("report"), dict) else answer
    status = row.get("status") if isinstance(row, dict) else None
    return status if isinstance(status, str) else None


def transient(status: int | None) -> bool:
    """A worker failure worth trying again later: no answer, 5xx, 401/403 (a key being rotated), 408, 429, or a 2xx/
    other status raised for a body cut short or not JSON (client.py). Only another 4xx (deleted, gone) is final."""
    return status is None or not 400 <= status < 500 or status in (401, 403, 408, 429)


def attempt(cfg: Config, code: str, row: dict[str, Any], stage_a: dict[str, Any], stage_b: dict[str, Any],
            tmp: Path) -> str:  # fmt: skip
    branch = f"bugfix/{code.lower()}"
    brief = tmp / "fix-brief.md"  # the builder's brief is also the red teams' brief: one acceptance for both
    brief.write_text(prompt(code, stage_a, stage_b), encoding="utf-8")
    # rc 1: absent, so this attempt creates it and every way out deletes it; an existing one is not ours (a person's).
    if triage.git(cfg, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}") != 1:
        raise FixFailed("worktree_failed")
    wt: Path | None = None
    try:
        wt = triage.add_worktree(cfg, "c", code, branch=branch)  # a failed add removes its half-made worktree itself
        return build_and_open(cfg, code, row, stage_a, stage_b, wt, brief, tmp, branch)
    except triage.GitError:  # raised only by add_worktree: build_and_open's git calls return codes
        raise FixFailed("worktree_failed") from None
    finally:
        if wt is not None:
            triage.remove_worktree(cfg, wt)
        # On success too: the branch lives on the fork now, and the shared clone keeps no stale bugfix/* branches.
        triage.git(cfg, "branch", "-D", branch)


def build_and_open(cfg: Config, code: str, row: dict[str, Any], stage_a: dict[str, Any], stage_b: dict[str, Any],
                   wt: Path, brief: Path, tmp: Path, branch: str) -> str:  # fmt: skip
    dotgit = (wt / ".git").read_bytes()
    if not builder(cfg, brief.read_text(encoding="utf-8"), wt):
        raise FixFailed("builder_failed")
    files = changed_files(wt, dotgit)
    summary = one_line(stage_b["summary"])
    commit(wt, code, files, summary)
    for backend in (None, "claude"):
        out = tmp / f"redteam-{backend or 'default'}.md"
        extra = {"QG_REDTEAM_BACKEND": backend} if backend else {}
        argv = ["bash", str(cfg.redteam_script), str(brief), str(wt), f"{cfg.fork_remote}/main", str(out)]
        try:
            rc, _, _ = claude_cli.run_child(argv, REDTEAM_TIMEOUT, cwd=wt, env=claude_cli.child_env(extra))
        except (subprocess.TimeoutExpired, OSError):
            rc = REDTEAM_NOT_RUN
        log("red team", code=code, backend=backend or "default", exit=rc)
        if rc != 0:
            raise FixFailed("redteam_not_run" if rc == REDTEAM_NOT_RUN else "redteam_fix")
    if wt_git(wt, "push", "--quiet", cfg.fork_remote, f"refs/heads/{branch}:refs/heads/{branch}")[0] != 0:
        raise FixFailed("push_failed")
    return open_pr(cfg, code, row, stage_a, wt, tmp, branch, summary)


def wt_git(wt: Path, *args: str) -> tuple[int, bytes]:
    env = claude_cli.child_env({"GIT_TERMINAL_PROMPT": "0"})
    try:
        rc, out, _ = claude_cli.run_child(["git", "-C", str(wt), *SAFE_GIT, *args], triage.GIT_TIMEOUT, env=env)
    except (subprocess.TimeoutExpired, OSError):
        return -1, b""
    return rc, out


def builder(cfg: Config, brief: str, wt: Path) -> bool:
    tools = "Read,Grep,Glob,Edit,Write,Bash"
    allowed = "Read,Grep,Glob,Edit,Write,Bash(stylua --check:*),Bash(selene:*)"
    argv = [
        cfg.claude_bin, "-p", "--model", claude_cli.MODEL, "--restricted", "--tools", tools, "--allowedTools", allowed,
        "--permission-mode", "dontAsk", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config",
    ]  # fmt: skip
    try:
        rc, out, _ = claude_cli.run_child(argv, BUILDER_TIMEOUT, cwd=wt, stdin=brief.encode("utf-8"))
    except (subprocess.TimeoutExpired, OSError):
        return False
    text = out.decode("utf-8", "replace")
    results = []
    for line in [*text.splitlines(), text]:  # the builder answers in prose: only the result line's flag matters
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if isinstance(msg, dict) and msg.get("type") == "result":
            results.append(msg)
    return rc == 0 and bool(results) and results[-1].get("is_error") is False


def changed_files(wt: Path, dotgit: bytes) -> list[str]:
    """Every changed, deleted or untracked path, checked against the risk list and the size limits."""
    git_file = wt / ".git"
    if git_file.is_symlink() or not git_file.is_file() or git_file.read_bytes() != dotgit:
        raise FixFailed("risk_path")  # the builder pointed the checkout at another git dir
    rc, out = wt_git(wt, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if rc != 0:
        raise FixFailed("builder_failed")
    tokens = out.split(b"\0")
    paths: list[str] = []
    i = 0
    while i < len(tokens):
        entry = tokens[i]
        i += 1
        if not entry:
            continue
        try:
            paths.append(entry[3:].decode("utf-8"))
            if entry[:1] in (b"R", b"C"):  # a rename or copy names its source next
                paths.append(tokens[i].decode("utf-8"))
                i += 1
        except (UnicodeDecodeError, IndexError):
            raise FixFailed("risk_path") from None
    if not paths:
        raise FixFailed("no_change")
    for rel in paths:
        p = wt / rel
        # A trailing `/` is a nested repository, which `git add` would turn into a gitlink.
        if rel.endswith("/") or guard.is_risky(rel) or p.is_symlink() or (p.exists() and not p.is_file()):
            log("path guard", reason="risk_path")
            raise FixFailed("risk_path")
    if len(paths) > MAX_FILES:
        raise FixFailed("diff_too_large")
    if wt_git(wt, "add", "--", *paths)[0] != 0:
        raise FixFailed("builder_failed")
    rc, out = wt_git(wt, "diff", "--cached", "--numstat", "--no-renames")
    if rc != 0:
        raise FixFailed("builder_failed")
    lines = 0
    for row in out.decode("utf-8", "replace").splitlines():
        counts = row.split("\t")[:2]
        if not all(c.isdigit() for c in counts):  # `-` is a binary file, never a small Luau fix
            raise FixFailed("diff_too_large")
        lines += sum(int(c) for c in counts)
    if lines > MAX_LINES:
        raise FixFailed("diff_too_large")
    return paths


def commit(wt: Path, code: str, files: list[str], summary: str) -> None:
    ident = ("-c", f"user.name={IDENTITY[0]}", "-c", f"user.email={IDENTITY[1]}", "-c", "commit.gpgsign=false")
    # Only what `git add -- <files>` staged above: the index of a fresh worktree holds nothing else.
    if wt_git(wt, *ident, "commit", "--quiet", "--no-verify", "-m", f"Bug {code}: {summary}", "-m", CO_AUTHOR)[0]:
        raise FixFailed("builder_failed")
    log("fix committed", code=code, files=len(files))


def one_line(text: str, width: int = 72) -> str:
    """Safe in a PR title and a commit subject: no mention, no code span, no control or invisible character."""
    text = text.replace("@", "(at)").replace("`", "")
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in text).split())
    return text[:width].rstrip() or "bug report"


def prompt(code: str, stage_a: dict[str, Any], stage_b: dict[str, Any]) -> str:
    values = {"CODE": code, "RISK_LIST": guard.risk_list_text()}
    triage_data = {"summary": stage_b["summary"], "likely_files": stage_b["likely_files"]}
    blocks = []
    for name, label, data in (("STAGE_A", "Summary of the report (stage A JSON)", stage_a),
                              ("STAGE_B", "Triage of the code (stage B)", triage_data)):  # fmt: skip
        nonce, block = claude_cli.data_block(data)
        values[f"NONCE_{name}"] = nonce
        blocks.append(f"{label}:\n{block}")
    values["PLAYER_DATA"] = "\n\n".join(blocks)  # last and in one piece, as in stage B
    return claude_cli.render("fix.md", values)


def open_pr(cfg: Config, code: str, row: dict[str, Any], stage_a: dict[str, Any], wt: Path, tmp: Path, branch: str,
            summary: str) -> str:  # fmt: skip
    where = row.get("where_area") or stage_a.get("where") or ""
    title = f"{AREAS.get(str(where).lower(), 'Shared')} Bug {code}: {summary}"
    # ` and @ are the same characters to a JSON reader, but cannot close the fence or mention anyone.
    data = json.dumps(stage_a, indent=2, ensure_ascii=False).replace("`", "\\u0060").replace("@", "\\u0040")
    body = tmp / "pr-body.md"
    body.write_text(
        f"Report: {code}\n\nDraft opened by lumina-bug-agent on Valor1 for a person to review; it is never merged"
        f" automatically.\n\nSummary of the player's report (stage A, data from a player):\n\n```json\n{data}\n```\n\n"
        f"Red team (default backend): pass\nRed team (QG_REDTEAM_BACKEND=claude): pass\n\n{GENERATED}\n",
        encoding="utf-8",
    )
    argv = [cfg.gh_bin, "pr", "create", "--draft", "--repo", cfg.pr_repo, "--base", "main", "--head", branch,
            "--title", title, "--body-file", str(body)]  # fmt: skip
    try:
        rc, out, _ = claude_cli.run_child(argv, GH_TIMEOUT, cwd=wt)
    except (subprocess.TimeoutExpired, OSError):
        raise FixFailed("pr_failed") from None
    urls = [ln.strip() for ln in out.decode("utf-8", "replace").splitlines() if PR_URL_RX.fullmatch(ln.strip())]
    if urls:
        # gh printed the PR's URL, so the PR exists whatever gh's exit code says; deleting its head would close it.
        if rc != 0:
            log("gh pr create exited non-zero after printing a PR URL", code=code, exit=rc)
        return urls[-1]
    if rc != 0:
        # gh failed and printed no URL: no draft PR points at the pushed branch, so nobody would see the fix on the
        # fork. Delete it, best effort and never forced. An exit 0 without a URL keeps it (the PR may exist), and so
        # does a gh timeout above, since the PR may have been opened before the timeout.
        deleted = wt_git(wt, "push", "--quiet", cfg.fork_remote, "--delete", f"refs/heads/{branch}")[0]
        if deleted != 0:
            log("remote branch left", code=code, branch=branch, exit=deleted)
    raise FixFailed("pr_failed")
