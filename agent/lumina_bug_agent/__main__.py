"""`python3 -m lumina_bug_agent [--env-file PATH] run-once` (the systemd unit runs exactly this)."""

from __future__ import annotations

import argparse
import sys

from . import log
from .config import ConfigError, load
from .run import run_round


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lumina_bug_agent", description="Lumina bug report agent")
    parser.add_argument("--env-file", help="KEY=VALUE file (default ~/.config/lumina-bug-portal/agent.env)")
    parser.add_argument("command", choices=["run-once"])
    args = parser.parse_args(argv)
    try:
        cfg = load(args.env_file)
    except ConfigError as exc:
        log(f"configuration error: {exc}")
        return 2
    return run_round(cfg)


if __name__ == "__main__":
    sys.exit(main())
