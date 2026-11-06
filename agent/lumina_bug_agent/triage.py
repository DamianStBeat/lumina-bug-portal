"""Stage B: a read-only look at the Lumina2 code in a throwaway detached worktree of `fork/main`.

The worktree helpers are shared with stage C (fix.py), which adds `--branch bugfix/<code>`."""

from __future__ import annotations

import secrets
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import claude_cli, log
from .config import Config
from .guard import risk_list_text
from .schemas import validate_stage_b

GIT_TIMEOUT = 300


class GitError(Exception):
    """fetch or worktree failed: nothing was judged, so the report is retried next round, not triaged."""


def git(cfg: Config, *args: str) -> int:
    # A clean environment like every child, and no prompt for credentials: a round must never hang on a TTY.
    env = claude_cli.child_env({"GIT_TERMINAL_PROMPT": "0"})
    try:
        code, _, _ = claude_cli.run_child(["git", "-C", str(cfg.lumina2_repo), *args], GIT_TIMEOUT, env=env)
    except (subprocess.TimeoutExpired, OSError):
        return -1
    return code


def fetch(cfg: Config) -> None:
    if git(cfg, "fetch", "--quiet", cfg.fork_remote, "main") != 0:
        raise GitError("fetch")


def add_worktree(cfg: Config, prefix: str, code: str, branch: str | None = None) -> Path:
    """A new worktree WORKTREE_ROOT/<prefix>-<code-lower>-<rand> on `<fork>/main` through git-workspace.py (which
    also runs the workspace placement check). The caller removes it with remove_worktree in a `finally`."""
    cfg.worktree_root.mkdir(parents=True, exist_ok=True)
    dst = cfg.worktree_root / f"{prefix}-{code.lower()}-{secrets.token_hex(4)}"
    argv = [sys.executable, str(cfg.git_workspace), "worktree", *(["--branch", branch] if branch else [])]
    argv += [str(cfg.lumina2_repo), str(dst), f"{cfg.fork_remote}/main"]
    ok = False
    try:
        try:
            rc, _, _ = claude_cli.run_child(argv, GIT_TIMEOUT, env=claude_cli.child_env({"GIT_TERMINAL_PROMPT": "0"}))
        except (subprocess.TimeoutExpired, OSError):
            rc = -1
        ok = rc == 0 and dst.is_dir()
    finally:
        if not ok:  # also on SIGTERM mid-add: a half-made worktree is removed like a whole one
            remove_worktree(cfg, dst)
    if not ok:
        raise GitError("worktree")
    return dst


def remove_worktree(cfg: Config, dst: Path) -> None:
    # Never raises: it runs in `finally` blocks, also while a SIGTERM is unwinding the round.
    git(cfg, "worktree", "remove", "--force", str(dst))
    shutil.rmtree(dst, ignore_errors=True)
    git(cfg, "worktree", "prune")


def prompt(stage_a: dict[str, Any], game_context: Any, duplicates: list[dict[str, Any]]) -> str:
    values: dict[str, str] = {"RISK_LIST": risk_list_text()}
    blocks = []
    for name, label, data in (
        ("STAGE_A", "Summary of the report (stage A JSON)", stage_a),
        ("CONTEXT", "Game context sent by the game client", game_context),
        ("DUPLICATES", "Reports already triaged, newest first (possible duplicates)", duplicates),
    ):
        nonce, block = claude_cli.data_block(data)
        values[f"NONCE_{name}"] = nonce
        blocks.append(f"{label}:\n{block}")
    # Inserted last and in one piece, so text in the data is never read as a placeholder by a later replace.
    values["PLAYER_DATA"] = "\n\n".join(blocks)
    return claude_cli.render("stage_b.md", values)


def run(cfg: Config, code: str, stage_a: dict[str, Any], game_context: Any, duplicates: list[dict[str, Any]]) -> Any:
    """The validated stage B answer, or None when claude gave no valid one. Raises GitError (see above)."""
    dst = add_worktree(cfg, "b", code)
    try:
        answer = claude_cli.stage_b(cfg, prompt(stage_a, game_context, duplicates), dst)
    finally:
        remove_worktree(cfg, dst)
    result = validate_stage_b(answer, {d["code"] for d in duplicates})
    log("stage B", code=code, verdict=result["verdict"] if result else "invalid")
    return result
