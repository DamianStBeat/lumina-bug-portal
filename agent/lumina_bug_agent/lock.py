"""One round at a time: an flock on STATE_DIR/agent.lock, released by the kernel even if the round crashes."""

from __future__ import annotations

import fcntl
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


def private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


@contextmanager
def round_lock(state_dir: Path) -> Iterator[bool]:
    """Yields True while this process holds the lock, False when another round holds it (never waits)."""
    fd = os.open(private_dir(state_dir) / "agent.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True
    finally:
        os.close(fd)
