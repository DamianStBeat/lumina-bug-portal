"""Acceptance row 8 with a worker that cuts its reply short (audit round 1, finding 1).

The worker declares a Content-Length larger than the bytes it sends and closes the connection. On the queue this is
the same "worker unreachable" case as a closed port; on an attachment download it is a failed download of one file,
and the report goes on with its text.
"""

from __future__ import annotations

import http.server
import json
import re
import unittest
import urllib.parse
from typing import Any

from helpers import FakeWorker, Harness, file_entry, mp4_attachment

# How many bytes the truncated reply claims beyond what it really sends.
_MISSING_BYTES = 4096

_TRUNCATABLE = [
    ("GET", re.compile(r"^/api/v1/agent/queue$"), "queue"),
    ("GET", re.compile(r"^/api/v1/agent/attachments/[^/]+/download$"), "download"),
]


class TruncatingWorker(FakeWorker):
    """The shared fake worker, except that chosen routes answer 200 with half the body and a larger Content-Length."""

    def __init__(self) -> None:
        super().__init__()
        self.truncate_next: dict[str, int] = {}  # route -> how many of the next 200 replies are cut short
        self.truncate_always: set[str] = set()
        self.truncated: list[str] = []  # routes actually cut short, so a spec knows its scenario happened

    def cut(self, route: str, times: int | None = None) -> None:
        with self._lock:
            if times is None:
                self.truncate_always.add(route)
            else:
                self.truncate_next[route] = self.truncate_next.get(route, 0) + times

    def _send(self, h: http.server.BaseHTTPRequestHandler, status: int, payload: Any, ctype: str = "application/json") -> None:
        route = None
        path = urllib.parse.urlsplit(h.path).path
        for method, rx, name in _TRUNCATABLE:
            if h.command == method and rx.match(path):
                route = name
                break
        cut = False
        if route is not None and status == 200:
            with self._lock:
                if route in self.truncate_always:
                    cut = True
                elif self.truncate_next.get(route, 0) > 0:
                    self.truncate_next[route] -= 1
                    cut = True
                if cut:
                    self.truncated.append(route)
        if not cut:
            return super()._send(h, status, payload, ctype)
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        h.send_response(status)
        h.send_header("Content-Type", ctype)
        h.send_header("Content-Length", str(len(data) + _MISSING_BYTES))
        h.send_header("Connection", "close")
        h.end_headers()
        h.wfile.write(data[: max(1, len(data) // 2)])
        h.wfile.flush()
        # The handler returns and the server closes the socket: the client sees EOF before the declared length.
        h.close_connection = True


def _truncating_harness(test: unittest.TestCase) -> tuple[Harness, TruncatingWorker]:
    h = Harness(test, worker_port=None)
    w = TruncatingWorker()
    test.addCleanup(w.stop)
    h.worker = w
    return h, w


class Row08WorkerTruncatedReply(unittest.TestCase):
    """Riga 8: il worker non risponde → errore registrato, nessun crash, riprova al giro dopo."""

    def test_row08_truncated_queue_reply_then_normal_worker(self) -> None:
        h, w = _truncating_harness(self)
        w.add_report("LUM-800101")
        w.cut("queue", times=1)
        p = h.run()
        self.assertEqual(w.truncated, ["queue"], "the first round's queue reply was cut short")
        h.assert_round_ok(p)
        self.assertTrue([l for l in p.stderr.splitlines() if l.startswith("lumina-bug-agent: ")],
                        f"the failure is logged on a `lumina-bug-agent: ` line:\n{p.stderr}")
        self.assertEqual(w.calls("claim"), [], "no claim when the queue reply is incomplete")
        self.assertEqual(h.claude_calls(), [], "no claude when the queue reply is incomplete")
        # Next round, same state dir, the worker answers normally: the report is processed.
        p2 = h.run()
        h.assert_round_ok(p2)
        self.assertEqual(len(h.triages("LUM-800101")), 1, "the next round processes the report")
        h.assert_nothing_left()

    def test_row08_truncated_attachment_download_is_skipped_and_the_report_goes_on(self) -> None:
        h, w = _truncating_harness(self)
        w.add_report("LUM-800102", attachments=[mp4_attachment("att-cut")])
        w.cut("download")
        p = h.run()
        self.assertIn("download", w.truncated, "the attachment download was cut short")
        h.assert_round_ok(p)
        triage = h.one_triage("LUM-800102")
        entry = file_entry(triage, "att-cut")
        self.assertIsNotNone(entry, f"triage.files names the attachment: {triage.get('triage')}")
        assert entry is not None
        self.assertEqual(entry.get("status"), "skipped", f"files entry: {entry}")
        self.assertEqual(entry.get("reason"), "download_failed", f"files entry: {entry}")
        self.assertEqual(h.media_calls(), [], "a partial download is never given to ffprobe or ffmpeg")
        self.assertEqual(w.calls("frames"), [], "no frames from a partial download")
        self.assertEqual(len(h.claude_calls("stage_a")), 1, "stage A still runs on the report's text")
        h.assert_nothing_left()


if __name__ == "__main__":
    unittest.main()
