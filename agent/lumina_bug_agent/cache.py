"""Local state in STATE_DIR/cache.sqlite3: daily caps, failed attempts, codes already dry-run, and the last
triaged reports that stage B compares a new one against (duplicate detection)."""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS counters(day TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(day, name));
CREATE TABLE IF NOT EXISTS failures(code TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dry_runs(code TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports(code TEXT PRIMARY KEY, title TEXT, summary TEXT, verdict TEXT, status TEXT,
  at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Status POSTs not delivered yet (fix.post_status), sent again at the start of each round.
CREATE TABLE IF NOT EXISTS pending_status(code TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL);
"""
KEEP_REPORTS = 200


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

    def remember(self, code: str, title: str, summary: str, verdict: str | None, status: str | None) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO reports(code, title, summary, verdict, status, at) VALUES(?, ?, ?, ?, ?, ?)",
            (code, title, summary, verdict, status, int(time.time())),
        )
        self._db.execute(
            "DELETE FROM reports WHERE code NOT IN (SELECT code FROM reports ORDER BY at DESC, rowid DESC LIMIT ?)",
            (KEEP_REPORTS,),
        )

    def recent(self, exclude: str) -> list[dict[str, str | None]]:
        rows = self._db.execute(
            "SELECT code, title, summary, verdict, status FROM reports WHERE code != ? ORDER BY at DESC, rowid DESC"
            " LIMIT ?",
            (exclude, KEEP_REPORTS),
        ).fetchall()
        return [dict(zip(("code", "title", "summary", "verdict", "status"), r)) for r in rows]

    def summary_of(self, code: str) -> str | None:
        """None: the report is not remembered; "" : remembered without a summary (cached before its triage)."""
        row = self._db.execute("SELECT summary FROM reports WHERE code = ?", (code,)).fetchone()
        return None if row is None else str(row[0] or "")

    def set_status(self, code: str, status: str) -> None:
        # Only reports already remembered: run.py seeds unknown ones from created/triaged events first.
        self._db.execute("UPDATE reports SET status = ? WHERE code = ?", (status, code))

    def add_pending_status(self, code: str, body: str) -> None:
        # One per report: a newer status of the same report replaces an older one that never got through.
        self._db.execute("INSERT OR REPLACE INTO pending_status(code, body, at) VALUES(?, ?, ?)",
                         (code, body, int(time.time())))  # fmt: skip

    def pending_statuses(self) -> list[tuple[str, str, int]]:
        """(code, body, at in unix seconds), oldest first."""
        rows = self._db.execute("SELECT code, body, at FROM pending_status ORDER BY at")
        return [(str(c), str(b), int(a)) for c, b, a in rows]

    def drop_pending_status(self, code: str) -> None:
        self._db.execute("DELETE FROM pending_status WHERE code = ?", (code,))

    def meta(self, key: str) -> str | None:
        row = self._db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return str(row[0]) if row else None

    def set_meta(self, key: str, value: str) -> None:
        self._db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", (key, value))
