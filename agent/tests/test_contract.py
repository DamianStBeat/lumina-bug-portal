"""The status compare-and-set of CONTRACT.md "Agent and bot" (`expectedStatus`) as the agent uses it, and Damian's row 6
of the integration slice:

6. Una persona segna `fixed` mentre l'agente manda `looking` → giro → resta `fixed`; l'agente riceve `status_changed` e
   lo annota.

Every spec runs the real agent (helpers.Harness) against helpers.CasWorker, the shared fake worker plus the worker's
compare-and-set: `expectedStatus` different from the stored status → 409 `{"error":"status_changed","status":<current>}`,
nothing written. A person's change comes only through `FakeWorker.person_sets_status`, run inside the agent's own
request (`CasWorker.before`) or while stage C's builder is held on a socket. The log line the agent writes on a 409 is
the one fix.py already writes for a superseded pending status: `status superseded code=<code> current=<status>`.

Run by filter: `cd agent && python3 -m unittest tests.test_contract` (or `python3 -m unittest discover tests -k
test_contract`).

Mutations (file|old|new|label). All these specs were red on 9dfbb0a, which sends no `expectedStatus`: that code is
their first mutation. The builder's code did not exist when these were written, so `old` describes the line.
agent/lumina_bug_agent/run.py|triage body carries expectedStatus = the status read by GET /agent/reports/{code}|drop the key|test_contract_triage_and_status_posts_carry_expected_status
agent/lumina_bug_agent/fix.py|status body carries expectedStatus = the status the agent knows (looking)|drop the key, or send the status being posted|test_contract_triage_and_status_posts_carry_expected_status, test_contract_row6_*
agent/lumina_bug_agent/fix.py|post_status: 409 status_changed → no retry, no pending, `status superseded`|treat 409 like any failure (3 tries, then pending)|test_contract_status_409_*
agent/lumina_bug_agent/run.py|post_triage: 409 status_changed → drop the triage, nothing more for the report|raise as a report failure, or go on to stage C|test_contract_triage_409_*
agent/lumina_bug_agent/fix.py|send_pending: resend carries expectedStatus = the status just read; 409 → dropped|resend without the key, or keep it pending|test_contract_pending_*
"""

from __future__ import annotations

import json
import re
import socket
import sqlite3
import sys
import threading
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))  # `python3 -m unittest tests.test_contract` from agent/

from helpers import (  # noqa: E402
    GREETING_FIXED,
    STAGE_B_SIMPLE_FIX,
    VALID_STAGE_A,
    CasWorker,
    Harness,
)

# simple_fix under 0.8: the triage, then one final status (`looking` + `needs_person: low_confidence`), no stage C.
LOW_CONFIDENCE = dict(STAGE_B_SIMPLE_FIX, confidence=0.5)


def _cas_harness(test: unittest.TestCase) -> tuple[Harness, CasWorker]:
    h = Harness(test, worker_port=None)
    w = CasWorker()
    test.addCleanup(w.stop)
    h.worker = w
    return h, w


def _round(h: Harness) -> tuple[Any, list[dict[str, Any]]]:
    assert h.worker is not None
    with h.worker._lock:
        start = len(h.worker.requests)
    p = h.run()
    h.assert_round_ok(p)
    with h.worker._lock:
        return p, list(h.worker.requests[start:])


def _bodies(reqs: list[dict[str, Any]], route: str, code: str) -> list[dict[str, Any]]:
    return [json.loads(r["body"].decode("utf-8")) for r in reqs if r["route"] == route and r["code"] == code]


def _pending_codes(h: Harness) -> set[str]:
    """Codes whose status POST waits in the agent's cache for a later round; empty while the cache does not exist."""
    db = h.state_dir / "cache.sqlite3"
    if not db.exists():
        return set()
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return {str(r[0]) for r in conn.execute("SELECT code FROM pending_status").fetchall()}
    finally:
        conn.close()


def _superseded_lines(stderr: str, code: str) -> list[str]:
    return [line for line in stderr.splitlines() if re.match(rf"^lumina-bug-agent: status superseded code={code}( |$)", line)]


class ContractExpectedStatus(unittest.TestCase):
    """Ogni POST di triage e di stato porta `expectedStatus` = lo stato che l'agente ha letto per quel report."""

    def test_contract_triage_and_status_posts_carry_expected_status(self) -> None:
        h, w = _cas_harness(self)
        code = "LUM-610001"
        w.add_report(code)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        _, reqs = _round(h)
        read = [r for r in reqs if r["route"] == "report" and r["code"] == code]
        self.assertTrue(read, "scenario: the agent read the report before its triage")
        triages = _bodies(reqs, "triage", code)
        self.assertEqual(len(triages), 1, f"one triage POST: {triages}")
        self.assertEqual(triages[0].get("expectedStatus"), "received",
                         f"the triage names the status the agent read at claim (received): {triages[0]}")
        statuses = _bodies(reqs, "status", code)
        self.assertEqual(len(statuses), 1, f"one status POST: {statuses}")
        self.assertEqual(statuses[0].get("expectedStatus"), "looking",
                         f"the status POST names the status its triage left (looking): {statuses[0]}")
        self.assertEqual(w.accepted("triage", code), 1)
        self.assertEqual(w.accepted("status", code), 1, "nobody else wrote: both writes go through")
        self.assertEqual(w.reports[code]["status"], "looking")


class ContractStatus409(unittest.TestCase):
    """409 `status_changed` su un POST di stato: niente altro per quel report nel giro, nessuno stato in attesa, una riga
    di log con il codice e lo stato attuale; il giro va avanti con gli altri report."""

    A, B = "LUM-620001", "LUM-620002"

    def test_contract_status_409_drops_the_write_logs_once_and_the_round_goes_on(self) -> None:
        h, w = _cas_harness(self)
        w.add_report(self.A)
        w.add_report(self.B)  # queued after A (oldest first)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        # The desk's `fixed` lands while A's final status POST is on its way.
        w.before[("status", self.A)] = lambda: w.person_sets_status(self.A, "fixed")
        p, reqs = _round(h)

        self.assertEqual(w.reports[self.A]["status"], "fixed", "A stays fixed")
        self.assertEqual(w.accepted("status", self.A), 0, "no status write of the agent reached A")
        a_posts = [r for r in reqs if r["code"] == self.A and r["method"] == "POST"]
        first_status = next(i for i, r in enumerate(a_posts) if r["route"] == "status")
        self.assertEqual(a_posts[first_status + 1:], [], "nothing more is sent for A after the 409 (no retry)")
        self.assertNotIn(self.A, _pending_codes(h), "the refused status does not wait for a later round")
        lines = _superseded_lines(p.stderr, self.A)
        self.assertEqual(len(lines), 1, f"one log line for A's 409:\n{p.stderr[-3000:]}")
        self.assertRegex(lines[0], r"\bcurrent=fixed\b", "the line names the current status")

        self.assertEqual(w.accepted("triage", self.B), 1, "the round went on: B triaged")
        self.assertEqual(w.accepted("status", self.B), 1, "and B's status written")
        self.assertEqual(w.reports[self.B]["status"], "looking")

        _, later = _round(h)
        self.assertEqual(_bodies(later, "status", self.A), [], "no status for A in the next round either")
        self.assertEqual(w.reports[self.A]["status"], "fixed")


class ContractTriage409(unittest.TestCase):
    """409 `status_changed` sul POST di triage: il triage è scartato, niente stato né fase C per quel report."""

    A, B = "LUM-630001", "LUM-630002"

    def test_contract_triage_409_drops_the_triage_and_nothing_more_is_written(self) -> None:
        h, w = _cas_harness(self)
        w.add_report(self.A)
        w.add_report(self.B)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        # A person marks A fixed while the agent was looking at its files (claim and read already done).
        w.before[("triage", self.A)] = lambda: w.person_sets_status(self.A, "fixed")
        p, reqs = _round(h)

        triages = _bodies(reqs, "triage", self.A)
        self.assertEqual(len(triages), 1, f"one triage POST for A: {triages}")
        self.assertEqual(triages[0].get("expectedStatus"), "received")
        self.assertEqual(w.accepted("triage", self.A), 0)
        self.assertEqual(w.reports[self.A]["status"], "fixed", "A stays fixed")
        self.assertEqual(_bodies(reqs, "status", self.A), [], "no status POST for A after its triage was refused")
        self.assertNotIn(self.A, _pending_codes(h))
        lines = _superseded_lines(p.stderr, self.A)
        self.assertEqual(len(lines), 1, f"one log line for A's 409:\n{p.stderr[-3000:]}")
        self.assertRegex(lines[0], r"\bcurrent=fixed\b")

        self.assertEqual(w.accepted("triage", self.B), 1, "the round went on: B triaged")
        self.assertEqual(w.reports[self.B]["status"], "looking")


class ContractPendingResend(unittest.TestCase):
    """Uno stato in attesa si rimanda con `expectedStatus` = lo stato appena letto; 409 → scartato."""

    CODE = "LUM-640001"

    def _pending_after_round1(self) -> tuple[Harness, CasWorker]:
        h, w = _cas_harness(self)
        w.add_report(self.CODE)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        w.fail("status", 503)  # every try of round 1
        _round(h)
        del w.always_fail["status"]
        self.assertIn(self.CODE, _pending_codes(h), "scenario: the undelivered status waits in the cache")
        self.assertEqual(w.reports[self.CODE]["status"], "looking", "scenario: the triage set looking")
        return h, w

    def test_contract_pending_resend_carries_expected_status(self) -> None:
        h, w = self._pending_after_round1()
        _, reqs = _round(h)
        sent = _bodies(reqs, "status", self.CODE)
        self.assertEqual(len(sent), 1, f"the pending status is sent once: {sent}")
        self.assertEqual(sent[0].get("expectedStatus"), "looking", f"it names the status just read: {sent[0]}")
        self.assertEqual(w.accepted("status", self.CODE), 1)
        self.assertNotIn(self.CODE, _pending_codes(h))

    def test_contract_pending_409_in_the_read_to_write_window_is_dropped_and_logged(self) -> None:
        h, w = self._pending_after_round1()
        # send_pending reads `looking`, then the desk's `fixed` lands before its POST.
        w.before[("status", self.CODE)] = lambda: w.person_sets_status(self.CODE, "fixed")
        p, _ = _round(h)
        self.assertEqual(w.reports[self.CODE]["status"], "fixed", "the person's fixed stays")
        self.assertEqual(w.accepted("status", self.CODE), 0)
        self.assertNotIn(self.CODE, _pending_codes(h), "dropped, not kept for another try")
        lines = _superseded_lines(p.stderr, self.CODE)
        self.assertEqual(len(lines), 1, f"one log line:\n{p.stderr[-3000:]}")
        self.assertRegex(lines[0], r"\bcurrent=fixed\b")
        _, later = _round(h)
        self.assertEqual(_bodies(later, "status", self.CODE), [], "nothing resent afterwards")


class ContractRow6EndToEnd(unittest.TestCase):
    """Riga 6: la persona segna `fixed` mentre la fase C lavora → l'agente manda `looking` col link → resta `fixed`."""

    CODE = "LUM-650001"

    def test_contract_row6_person_sets_fixed_while_the_fix_stage_runs_report_stays_fixed(self) -> None:
        h, w = _cas_harness(self)
        w.add_report(self.CODE)
        sock_path = str(h.root / "builder.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(sock_path)
        listener.listen(1)
        listener.settimeout(90)
        self.addCleanup(listener.close)
        h.set_stage("stage_a", mode="json", object=dict(VALID_STAGE_A))
        h.set_stage("stage_b", mode="json", object=dict(STAGE_B_SIMPLE_FIX))
        h.set_stage("builder", mode="json", object={"summary": "edited"},
                    writes={"src/Shared/Greeting.luau": GREETING_FIXED}, block_socket=sock_path)
        proc = h.popen()

        def _unblock_if_round_exits() -> None:
            # A round that ends before stage C must not leave accept() waiting for the whole timeout.
            proc.wait()
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                    s.connect(sock_path)
                    s.sendall(b"exited")
            except OSError:
                pass

        threading.Thread(target=_unblock_if_round_exits, daemon=True).start()
        try:
            conn, _ = listener.accept()
        except OSError:
            conn = None
        hello = conn.recv(16) if conn is not None else b"timeout"
        if hello != b"started":
            if proc.poll() is None:
                proc.kill()
            _, err = proc.communicate(timeout=30)
            self.fail(f"the round never reached the builder ({hello!r}, exit {proc.returncode}):\n{err[-3000:]}")
        assert conn is not None
        self.addCleanup(conn.close)
        self.assertEqual(w.reports[self.CODE]["status"], "looking", "scenario: the triage set looking before stage C")
        w.person_sets_status(self.CODE, "fixed")  # the desk, while the builder works
        conn.sendall(b"go")
        _, err = proc.communicate(timeout=180)
        self.assertEqual(proc.returncode, 0, err[-3000:])
        self.assertNotIn("Traceback (most recent call last)", err)

        self.assertEqual(len(h.gh_calls()), 1, "scenario: stage C went on to its draft PR")
        self.assertEqual(w.reports[self.CODE]["status"], "fixed", "row 6: the report stays fixed")
        self.assertEqual(w.accepted("status", self.CODE), 0, "no `looking` of the agent was written over it")
        for b in h.statuses(self.CODE):
            self.assertEqual(b.get("expectedStatus"), "looking", f"any status POST names the status it expects: {b}")
        self.assertNotIn(self.CODE, _pending_codes(h))
        lines = _superseded_lines(err, self.CODE)
        self.assertEqual(len(lines), 1, f"the agent notes it once (`status superseded`):\n{err[-3000:]}")
        self.assertRegex(lines[0], r"\bcurrent=fixed\b")

        _, later = _round(h)
        self.assertEqual(_bodies(later, "status", self.CODE), [], "and sends nothing for it in the next round")
        self.assertEqual(w.reports[self.CODE]["status"], "fixed")
        h.assert_nothing_left()


if __name__ == "__main__":
    unittest.main()
