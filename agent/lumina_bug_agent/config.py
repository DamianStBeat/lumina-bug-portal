"""Configuration: `agent.env` (KEY=VALUE) under the process environment, which wins."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ENV_FILE = "~/.config/lumina-bug-portal/agent.env"


class ConfigError(Exception):
    """Names the variable only; the message never carries a value (it could be the key)."""


@dataclass(frozen=True)
class Config:
    api_base: str
    agent_key: str
    lumina2_repo: Path
    daily_triage_cap: int
    daily_fix_cap: int
    poll_seconds: int
    dry_run: bool
    state_dir: Path
    tmp_root: Path
    worktree_root: Path
    git_workspace: Path
    redteam_script: Path
    claude_bin: str
    gh_bin: str
    ffmpeg_bin: str
    ffprobe_bin: str
    frame_font: Path  # the time stamps on the video sheets; a missing file falls back to fontconfig's Sans
    agent_id: str
    lease_minutes: int
    max_reports_per_round: int
    fork_remote: str
    pr_repo: str
    retention_fallback: bool = False  # RETENTION_FALLBACK=1: only where pg_cron or pg_net is not available


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def load(env_file: str | None) -> Config:
    path = Path(os.path.expanduser(env_file or DEFAULT_ENV_FILE))
    values: dict[str, str] = {}
    if path.is_file():
        try:
            values = read_env_file(path)
        except (OSError, UnicodeDecodeError) as exc:
            raise ConfigError(f"env file unreadable ({type(exc).__name__})") from None
    elif env_file is not None:
        # An explicit --env-file that is missing is a mistake; only the default file may be absent.
        raise ConfigError("env file not found")
    values.update(os.environ)

    def text(name: str, default: str | None = None) -> str:
        value = values.get(name, "").strip()
        if value:
            return value
        if default is None:
            raise ConfigError(f"missing {name}")
        return default

    def number(name: str, default: int, low: int = 0, high: int | None = None) -> int:
        raw = text(name, str(default))
        try:
            value = int(raw)
        except ValueError:
            raise ConfigError(f"{name} is not a whole number") from None
        if value < low or (high is not None and value > high):
            raise ConfigError(f"{name} is out of range")
        return value

    def path_of(name: str, default: str) -> Path:
        return Path(os.path.expanduser(text(name, default)))

    dry = text("DRY_RUN", "1").lower()
    if dry not in ("0", "1", "true", "false", "yes", "no"):
        raise ConfigError("DRY_RUN must be 0 or 1")
    return Config(
        api_base=text("PORTAL_API_BASE").rstrip("/"),
        agent_key=text("AGENT_KEY"),
        lumina2_repo=Path(os.path.expanduser(text("LUMINA2_REPO"))),
        daily_triage_cap=number("DAILY_TRIAGE_CAP", 40),
        daily_fix_cap=number("DAILY_FIX_CAP", 5),
        poll_seconds=number("POLL_SECONDS", 120, low=10),
        dry_run=dry in ("1", "true", "yes"),
        state_dir=path_of("STATE_DIR", "~/.local/state/lumina-bug-agent"),
        tmp_root=path_of("TMP_ROOT", tempfile.gettempdir()),
        worktree_root=path_of("WORKTREE_ROOT", "~/Developer/GitHub/Lumina2Workspace/bug-agent-worktrees"),
        git_workspace=path_of("GIT_WORKSPACE", "~/Developer/GitHub/_tools/git-workspace.py"),
        redteam_script=path_of("REDTEAM_SCRIPT", "~/.claude/skills/lumina2-pr/redteam_fast.sh"),
        claude_bin=text("CLAUDE_BIN", "claude"),
        gh_bin=text("GH_BIN", "gh"),
        ffmpeg_bin=text("FFMPEG_BIN", "ffmpeg"),
        ffprobe_bin=text("FFPROBE_BIN", "ffprobe"),
        frame_font=path_of("FRAME_FONT", "/usr/share/fonts/truetype/freefont/FreeSans.ttf"),
        agent_id=text("AGENT_ID", "valor1-agent"),
        lease_minutes=number("LEASE_MINUTES", 60, low=1, high=60),
        max_reports_per_round=number("MAX_REPORTS_PER_ROUND", 5, low=1, high=50),
        fork_remote=text("FORK_REMOTE", "fork"),
        pr_repo=text("PR_REPO", "DamianStBeat/Lumina2"),
        retention_fallback=text("RETENTION_FALLBACK", "0") == "1",
    )
