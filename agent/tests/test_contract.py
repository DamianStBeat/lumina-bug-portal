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
agent/lumina_bug_agent/fix.py|{**json.loads(body), "expectedStatus": current}|json.loads(body)|test_contract_pending_resend_of_a_body_stored_without_the_key_* (audit 1 finding 6)
agent/lumina_bug_agent/run.py|self.post_triage(code, "unclear", None, None, [], ["agent_failed"], "received")|... "looking")|test_contract_give_up_* (audit 1 finding 2)
agent/lumina_bug_agent/run.py|after the report GET: a status other than `received` skips the report (`status superseded`)|no check: the status read goes on the triage|test_contract_row6_a_person_sets_fixed_on_the_claim_*, test_contract_every_other_status_* (audit 1 finding 1; red on b17d8f4, which is that mutation)
agent/lumina_bug_agent/run.py|the skip applies to a string status only|anything but `received` skips|test_contract_a_row_with_no_string_status_*
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


def _store_pending_without_the_key(h: Harness, code: str) -> dict[str, Any]:
    """Rewrites the status waiting in the agent's cache as an agent older than `expectedStatus` stored it; the body left."""
    conn = sqlite3.connect(h.state_dir / "cache.sqlite3")
    try:
        stored = json.loads(conn.execute("SELECT body FROM pending_status WHERE code = ?", (code,)).fetchone()[0])
        stored.pop("expectedStatus", None)
        with conn:
            conn.execute("UPDATE pending_status SET body = ? WHERE code = ?", (json.dumps(stored), code))
        return dict(stored)
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


    def test_contract_pending_resend_of_a_body_stored_without_the_key_carries_the_status_just_read(self) -> None:
        h, w = self._pending_after_round1()
        stored = _store_pending_without_the_key(h, self.CODE)
        self.assertNotIn("expectedStatus", stored, "scenario: the body predates the key")
        _, reqs = _round(h)
        sent = _bodies(reqs, "status", self.CODE)
        self.assertEqual(len(sent), 1, f"the pending status is sent once: {sent}")
        self.assertEqual(sent[0].get("expectedStatus"), "looking", f"the key is added, with the status just read: {sent[0]}")
        self.assertEqual({k: v for k, v in sent[0].items() if k != "expectedStatus"}, stored, "the rest of the body as stored")
        self.assertEqual(w.accepted("status", self.CODE), 1)
        self.assertNotIn(self.CODE, _pending_codes(h))

    def test_contract_pending_resend_of_a_body_stored_without_the_key_cannot_overwrite_a_person(self) -> None:
        h, w = self._pending_after_round1()
        _store_pending_without_the_key(h, self.CODE)
        # The window the key closes: send_pending reads `looking`, then the desk's `fixed` lands before its POST.
        w.before[("status", self.CODE)] = lambda: w.person_sets_status(self.CODE, "fixed")
        p, _ = _round(h)
        self.assertEqual(w.reports[self.CODE]["status"], "fixed", "an old body cannot overwrite the person's fixed")
        self.assertEqual(w.accepted("status", self.CODE), 0)
        self.assertNotIn(self.CODE, _pending_codes(h))
        lines = _superseded_lines(p.stderr, self.CODE)
        self.assertEqual(len(lines), 1, f"one log line:\n{p.stderr[-3000:]}")
        self.assertRegex(lines[0], r"\bcurrent=fixed\b")


class ContractGiveUp(unittest.TestCase):
    """Il triage `unclear` dopo tre tentativi falliti porta `expectedStatus: "received"` (quello che la coda ha mostrato)
    e il worker lo accetta; un `expectedStatus` sbagliato lo farebbe rifiutare ogni volta, e il report non uscirebbe mai
    dalla coda. Audit 1, finding 2: il solo test del give-up girava su un fake che ignora la chiave."""

    CODE = "LUM-670001"

    def _after_three_failed_rounds(self) -> tuple[Harness, CasWorker]:
        h, w = _cas_harness(self)
        w.add_report(self.CODE)
        w.fail("report", 503)
        for _ in range(3):
            _round(h)
            w.expire_lease(self.CODE)
        del w.always_fail["report"]
        self.assertEqual(w.calls("triage", self.CODE), [], "scenario: no give-up before the fourth round")
        self.assertEqual(w.reports[self.CODE]["status"], "received", "scenario: nothing was written")
        return h, w

    def test_contract_give_up_triage_carries_received_and_is_accepted(self) -> None:
        h, w = self._after_three_failed_rounds()
        p, reqs = _round(h)
        triages = _bodies(reqs, "triage", self.CODE)
        self.assertEqual(len(triages), 1, f"one give-up triage: {triages}\n{p.stderr[-3000:]}")
        self.assertEqual(triages[0].get("verdict"), "unclear")
        self.assertIn("agent_failed", triages[0]["triage"]["notes"])
        self.assertEqual(triages[0].get("expectedStatus"), "received", "the status the queue listed it under")
        self.assertEqual(w.accepted("triage", self.CODE), 1, "the worker's compare-and-set accepts it")
        self.assertEqual(w.reports[self.CODE]["status"], "looking", "the report leaves the queue")
        self.assertEqual(_superseded_lines(p.stderr, self.CODE), [], "nobody moved it: nothing is superseded")
        self.assertEqual(h.claude_calls(), [], "a give-up runs no stage")

    def test_contract_give_up_triage_refused_because_a_person_moved_it_leaves_the_person_s_status(self) -> None:
        h, w = self._after_three_failed_rounds()
        w.before[("triage", self.CODE)] = lambda: w.person_sets_status(self.CODE, "fixed")
        p, _ = _round(h)
        self.assertEqual(w.accepted("triage", self.CODE), 0)
        self.assertEqual(w.reports[self.CODE]["status"], "fixed", "the person's fixed stays")
        lines = _superseded_lines(p.stderr, self.CODE)
        self.assertEqual(len(lines), 1, f"one log line:\n{p.stderr[-3000:]}")
        self.assertRegex(lines[0], r"\bcurrent=fixed\b")


class ContractNoLongerReceivedIsSkipped(unittest.TestCase):
    """Decisione del lead (audit 1, finding 1): l'agente legge un report dalla coda, e se la GET risponde uno stato che
    non è `received` lo lascia a chi l'ha spostato: nessuna fase, nessun triage, nessuno stato, una riga di log `status
    superseded` col codice e lo stato attuale; il giro va avanti. La coda si legge una volta sola a inizio giro e i report
    girano uno dopo l'altro: senza questo controllo una modifica umana arrivata prima della GET diventerebbe lo stato
    "atteso" del triage, che la sovrascriverebbe."""

    A, B = "LUM-660001", "LUM-660002"
    OTHER_STATUSES = {"LUM-660011": "looking", "LUM-660012": "duplicate", "LUM-660013": "not_bug", "LUM-660014": "closed"}

    def _assert_skipped(self, h: Harness, w: CasWorker, p: Any, code: str, current: str) -> None:
        self.assertTrue(w.calls("report", code), f"scenario: {code} was read after its claim")
        self.assertEqual(w.calls("triage", code), [], f"no triage POST for {code}:\n{p.stderr[-3000:]}")
        self.assertEqual(w.calls("status", code), [], f"no status POST for {code}")
        self.assertEqual(w.calls("frames", code), [], f"no frames for {code}")
        lines = _superseded_lines(p.stderr, code)
        self.assertEqual(len(lines), 1, f"one `status superseded` line for {code}:\n{p.stderr[-3000:]}")
        self.assertRegex(lines[0], rf"\bcurrent={current}\b", "the line names the current status")
        self.assertNotIn(f"report error code={code}", p.stderr, "a skip is not a failed report")
        self.assertNotIn(f"report failed code={code}", p.stderr, "a skip is not a failed report")
        self.assertNotIn(code, _pending_codes(h), "nothing waits for a later round")

    def _assert_round_went_on(self, h: Harness, w: CasWorker, reqs: list[dict[str, Any]]) -> None:
        triages = _bodies(reqs, "triage", self.B)
        self.assertEqual(len(triages), 1, f"the round went on, B was triaged: {triages}")
        self.assertEqual(triages[0].get("expectedStatus"), "received", "a report still received is processed as before")
        self.assertEqual(w.accepted("triage", self.B), 1)
        self.assertEqual(w.reports[self.B]["status"], "looking")
        self.assertEqual(len(h.claude_calls("stage_a")), 1, "stage A ran for B and nothing else")
        self.assertEqual(len(h.claude_calls("stage_b")), 1, "stage B ran for B and nothing else")

    def test_contract_row6_a_person_sets_fixed_on_the_claim_the_report_is_skipped_and_stays_fixed(self) -> None:
        h, w = _cas_harness(self)
        w.add_report(self.A, attachments=[{"id": "att-skip-a", "data": b"never read: the report is skipped first"}])
        w.add_report(self.B)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        # After the queue listed A as received and before the agent reads it: the window of finding 1.
        w.before[("claim", self.A)] = lambda: w.person_sets_status(self.A, "fixed")
        p, reqs = _round(h)

        self.assertEqual(w.reports[self.A]["status"], "fixed", "row 6: the report stays fixed")
        self._assert_skipped(h, w, p, self.A, "fixed")
        self.assertEqual(w.calls("download"), [], "its files are not fetched")
        self._assert_round_went_on(h, w, reqs)

    def test_contract_every_other_status_read_after_the_claim_is_skipped_and_left_as_it_is(self) -> None:
        h, w = _cas_harness(self)
        for code, status in self.OTHER_STATUSES.items():
            w.add_report(code)
            w.before[("claim", code)] = lambda c=code, s=status: w.person_sets_status(c, s)
        w.add_report(self.B)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        p, reqs = _round(h)
        for code, status in self.OTHER_STATUSES.items():
            with self.subTest(status=status):
                self.assertEqual(w.reports[code]["status"], status, "the status stays what the person set")
                self._assert_skipped(h, w, p, code, status)
        self._assert_round_went_on(h, w, reqs)

    def test_contract_a_status_outside_the_list_is_also_skipped_and_reaches_the_log_only_as_a_safe_word(self) -> None:
        # "A status other than received" (brief 1e): a future status the agent does not know is someone else's too.
        h, w = _cas_harness(self)
        future, odd = "LUM-660021", "LUM-660022"
        w.add_report(future)
        w.add_report(odd)
        w.add_report(self.B)
        w.answer_report(future, body=dict(w.reports[future], status="archived"), times=None)
        w.answer_report(odd, body=dict(w.reports[odd], status="Odd Status\ninjected line"), times=None)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        p, reqs = _round(h)
        self._assert_skipped(h, w, p, future, "archived")
        self.assertEqual(w.calls("triage", odd), [], "no triage POST for the odd status")
        self.assertEqual(len(_superseded_lines(p.stderr, odd)), 1, f"one line for it:\n{p.stderr[-3000:]}")
        self.assertNotIn("injected line", p.stderr, "a value from the worker never reaches the log raw")
        self._assert_round_went_on(h, w, reqs)

    def test_contract_a_row_with_no_string_status_is_a_failed_read_not_a_person_s_change(self) -> None:
        # Not yet / unknown is not "someone moved it": today's handling (brief 1e), a failed attempt, retried later.
        h, w = _cas_harness(self)
        missing, null, number = "LUM-660031", "LUM-660032", "LUM-660033"
        w.add_report(missing)
        w.add_report(null)
        w.add_report(number)
        w.add_report(self.B)
        without = {k: v for k, v in w.reports[missing].items() if k != "status"}
        w.answer_report(missing, body=without, times=None)
        w.answer_report(null, body=dict(w.reports[null], status=None), times=None)
        w.answer_report(number, body=dict(w.reports[number], status=42), times=None)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        p, reqs = _round(h)
        for code in (missing, null, number):
            with self.subTest(code=code):
                self.assertEqual(_superseded_lines(p.stderr, code), [], f"nobody moved {code}:\n{p.stderr[-3000:]}")
                self.assertIn(f"report error code={code} error=ValueError attempts=1", p.stderr, "counted as a failed attempt")
                self.assertEqual(w.calls("triage", code), [])
                self.assertEqual(w.calls("status", code), [])
                self.assertEqual(w.reports[code]["status"], "received")
        self._assert_round_went_on(h, w, reqs)


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
