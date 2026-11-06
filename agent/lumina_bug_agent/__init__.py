"""lumina-bug-agent: triages Lumina bug reports on Valor1 (see design.md of the agent slice and CONTRACT.md)."""

import sys

AGENT_VERSION = "lumina-bug-agent/1"


def log(event: str, **fields: object) -> None:
    # One line per event. Callers pass only codes, ids, counts, verdicts and reasons: never the key or player text.
    tail = "".join(f" {k}={v}" for k, v in fields.items())
    sys.stderr.write(f"lumina-bug-agent: {event}{tail}\n")
    sys.stderr.flush()
