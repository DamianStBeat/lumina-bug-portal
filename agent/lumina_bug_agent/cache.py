"""Local state in STATE_DIR/cache.sqlite3: daily caps, failed attempts, codes already dry-run."""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS counters(day TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(day, name));
CREATE TABLE IF NOT EXISTS failures(code TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dry_runs(code TEXT PRIMARY KEY, at INTEGER NOT NULL);
"""


def utc_day() -> str:
    return datetime.now(timezone.utc).date().isoformat()


class Cache:
    def __init__(self, path: Path) -> None:
        # isolation_level=None: every statement commits at once, so a killed round keeps what it already counted.
        self._db = sqlite3.connect(path, isolation_level=None, timeout=30)
        self._db.executescript(_SCHEMA)

    def close(self) -> None:
        self._db.close()

    def count(self, name: str) -> int:
        row = self._db.execute("SELECT n FROM counters WHERE day = ? AND name = ?", (utc_day(), name)).fetchone()
        return int(row[0]) if row else 0

    def bump(self, name: str) -> None:
        self._db.execute(
            "INSERT INTO counters(day, name, n) VALUES(?, ?, 1) ON CONFLICT(day, name) DO UPDATE SET n = n + 1",
            (utc_day(), name),
        )

    def failures(self, code: str) -> int:
        row = self._db.execute("SELECT n FROM failures WHERE code = ?", (code,)).fetchone()
        return int(row[0]) if row else 0

    def bump_failure(self, code: str) -> int:
        self._db.execute(
            "INSERT INTO failures(code, n) VALUES(?, 1) ON CONFLICT(code) DO UPDATE SET n = n + 1", (code,)
        )
        return self.failures(code)

    def clear_failures(self, code: str) -> None:
        self._db.execute("DELETE FROM failures WHERE code = ?", (code,))

    def dry_run_seen(self, code: str) -> bool:
        return self._db.execute("SELECT 1 FROM dry_runs WHERE code = ?", (code,)).fetchone() is not None

    def mark_dry_run(self, code: str) -> None:
        self._db.execute("INSERT OR REPLACE INTO dry_runs(code, at) VALUES(?, ?)", (code, int(time.time())))
