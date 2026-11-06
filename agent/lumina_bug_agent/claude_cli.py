"""Children (claude, ffmpeg, ...): clean environment, prompts on stdin, timeouts that kill the whole group."""

from __future__ import annotations

import base64
import json
import os
import secrets
import signal
import subprocess
from pathlib import Path
from typing import Any

from . import log
from .config import Config
from .schemas import STAGE_A_SCHEMA, STAGE_B_SCHEMA

CHILD_ENV_KEYS = ("HOME", "PATH", "USER", "LANG", "TERM")
MODEL = "claude-opus-5-5"
STAGE_A_TIMEOUT = 600
STAGE_B_TIMEOUT = 1200
PROMPTS = Path(__file__).resolve().parent.parent / "prompts"


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    # Never os.environ: AGENT_KEY and PORTAL_API_BASE live there.
    env = {k: os.environ[k] for k in CHILD_ENV_KEYS if k in os.environ}
    env.update(extra or {})
    return env


def run_child(
    argv: list[str], timeout: float, cwd: Path | None = None, stdin: bytes | None = None, env: dict[str, str] | None = None
) -> tuple[int, bytes, bytes]:
    """Raises subprocess.TimeoutExpired after killing the process group, OSError when argv[0] cannot start."""
    proc = subprocess.Popen(
        argv,
        cwd=cwd,
        env=env if env is not None else child_env(),
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = proc.communicate(stdin, timeout=timeout)
    except BaseException:
        # Timeout, SIGTERM turned into an exception, anything: no grandchild may outlive the round.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        raise
    return proc.returncode, out, err


def render(name: str, values: dict[str, str]) -> str:
    # str.replace, never str.format: player data may hold braces.
    text = (PROMPTS / name).read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def data_block(data: Any) -> tuple[str, str]:
    """(nonce, block) with the player-derived `data` as JSON inside nonce-delimited markers."""
    body = json.dumps(data, ensure_ascii=False, indent=2)
    nonce = secrets.token_hex(16)
    while nonce in body:  # a player cannot guess it, but the block must be unforgeable even by chance
        nonce = secrets.token_hex(16)
    return nonce, f"<<<PLAYER_DATA_{nonce}>>>\n{body}\n<<<END_PLAYER_DATA_{nonce}>>>"


def parse_result(stdout: bytes) -> Any:
    """The answer object of `claude -p` (json or stream-json), or None when there is no usable result."""
    result = None
    text = stdout.decode("utf-8", "replace")
    for line in [*text.splitlines(), text]:  # stream-json lines, or `--output-format json`'s one object
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if isinstance(msg, dict) and msg.get("type") == "result":
            result = msg
    if result is None or result.get("is_error") is not False:
        return None
    if isinstance(result.get("structured_output"), dict):
        return result["structured_output"]
    try:
        return json.loads(result.get("result") or "")
    except (TypeError, ValueError):
        return None


def stage_a(cfg: Config, prompt: str, images: list[Path], cwd: Path) -> Any:
    argv = [
        cfg.claude_bin, "-p", "--model", MODEL, "--restricted", "--tools", "",
        "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--no-session-persistence", "--strict-mcp-config", "--json-schema", json.dumps(STAGE_A_SCHEMA),
    ]  # fmt: skip
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for img in images:
        data = base64.b64encode(img.read_bytes()).decode("ascii")
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}})
    message = {"type": "user", "message": {"role": "user", "content": content}}
    try:
        code, out, _ = run_child(argv, STAGE_A_TIMEOUT, cwd=cwd, stdin=(json.dumps(message) + "\n").encode("utf-8"))
    except subprocess.TimeoutExpired:
        log("stage A timed out")
        return None
    except OSError:
        log("stage A could not start")
        return None
    if code != 0:
        log("stage A failed", exit=code)
        return None
    return parse_result(out)


def stage_b(cfg: Config, prompt: str, cwd: Path) -> Any:
    """Read-only triage inside the stage B worktree; the answer object, or None (timeout, failure, no result)."""
    tools = "Read,Grep,Glob"
    argv = [
        cfg.claude_bin, "-p", "--model", MODEL, "--restricted", "--tools", tools, "--allowedTools", tools,
        "--permission-mode", "dontAsk", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config",
        "--json-schema", json.dumps(STAGE_B_SCHEMA),
    ]  # fmt: skip
    try:
        code, out, _ = run_child(argv, STAGE_B_TIMEOUT, cwd=cwd, stdin=prompt.encode("utf-8"))
    except subprocess.TimeoutExpired:
        log("stage B timed out")
        return None
    except OSError:
        log("stage B could not start")
        return None
    if code != 0:
        log("stage B failed", exit=code)
        return None
    return parse_result(out)
