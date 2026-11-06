"""Follow-up of red team round 2 (brief-followup.md): the three acceptance rows and finding 4.

1. Lo stato di una persona vince su uno stato dell'agente in attesa: una persona mette `fixed` mentre un `looking` è in
   attesa di invio → giro dopo → il report resta `fixed`. Controllo: nessuno lo tocca → il `looking` in attesa arriva.
2. 60 codici sconosciuti negli eventi → tre giri → tutti e 60 nella cache, mai più di 50 GET di semina per giro.
3. Un evento `created` e poi un `triaged` → la fase B vede il riassunto.
4. Il font dei tempi sui fogli si sceglie con `FRAME_FONT` (default FreeSans): file mancante → `font=Sans`, file
   esistente → `fontfile=<quel percorso>`. Gira su ogni macchina (sostituisce lo spec che saltava su Valor1).

Every spec runs the real agent (helpers.Harness). The rounds are driven against the fake worker, whose rows change
only through the agent's requests or through the person helper (`FakeWorker.person_sets_status`); expected values come
from the worker's records, the cache file, the ffmpeg shim's argv and the fake claude's stdin.

Run by filter: `cd agent && python3 -m unittest tests.test_followup_findings` (or `python3 -m unittest discover tests
-k test_followup`).

Mutations (file|line to mutate|mutation|spec filter that must turn red; the builder's code was not read when these were
written, so `old` describes the line):
agent/lumina_bug_agent/run.py|pending status resent only while the fetched report is still `looking`|skip the status check|test_row1_person_sets_fixed_while_looking_is_pending_report_stays_fixed
agent/lumina_bug_agent/run.py|pending status resent when nobody touched the report|drop always|test_row1_control_untouched_report_gets_the_pending_status
agent/lumina_bug_agent/run.py|events cursor advances only past events handled (stops at the first code over the cap of 50)|advance to the page's `last`|test_row2_sixty_unknown_codes_are_all_cached_after_three_rounds
agent/lumina_bug_agent/cache.py|cap 50 seed fetches a round|no cap|test_row2_sixty_unknown_codes_are_all_cached_after_three_rounds
agent/lumina_bug_agent/run.py|failed seed fetch stops the cursor (retried next round)|advance anyway|test_row2_failed_seed_fetch_is_retried_next_round
agent/lumina_bug_agent/cache.py|`triaged` event for a cached code with an empty summary refetches and upserts the row|skip codes already cached|test_row3_created_then_triaged_event_stage_b_sees_the_summary
agent/lumina_bug_agent/media.py|FONT from env FRAME_FONT|hard-coded FreeSans path|test_row4_frame_font_existing_file_is_used_as_fontfile
agent/lumina_bug_agent/media.py|missing font file → drawtext font=Sans, no fontfile|always fontfile=<FONT>|test_row4_frame_font_missing_file_falls_back_to_fontconfig_sans
agent/lumina_bug_agent/media.py|FRAME_FONT default /usr/share/fonts/truetype/freefont/FreeSans.ttf|another default|test_row4_frame_font_unset_uses_freesans

Follow-up audit (bp-agent-fix/audit.md), the `test_audit<N>_*` specs, filter `-k audit`. Findings 1-2 were red on
4b25711 (the code they describe); 3-10 guard rules already there. Mutations on 4b25711 (file|old|new|label), each red:
agent/lumina_bug_agent/fix.py|        if now - at > PENDING_MAX_AGE:|        if False:|M1 test_audit3
agent/lumina_bug_agent/fix.py|(current[0] != "looking" or current[1] > at * 1000)|(current[1] > at * 1000)|M2 test_audit4
(M3 and M5 guarded the `updated_at` rule that round 3 removed: audit5 and audit6 are rewritten, see below.)
agent/lumina_bug_agent/fix.py|status >= 500 or status in (408, 429)|status >= 500 or status in (404, 408, 429)|M7 test_audit7
agent/lumina_bug_agent/fix.py|status is None or status >= 500 or status in (408, 429)|status is None or status in (408, 429)|M6 test_audit7
agent/lumina_bug_agent/run.py|        if rounds >= STALL_ROUNDS:|        if False:|M10 test_audit8
agent/lumina_bug_agent/run.py|                if not all(isinstance(ev, dict) and _is_int(ev.get("seq")) for ev in events):|                if False:|M13 test_audit9
agent/lumina_bug_agent/run.py|self.cache.set_meta("events_cursor", str(events[handled - 1]["seq"]))|pass|M17 test_audit10
agent/lumina_bug_agent/run.py|str(events[handled - 1]["seq"]))|str(events[handled]["seq"]))|M18 test_audit10
For findings 1-2 the mutation is the code of 4b25711 itself: `transient()` back to `status >= 500` (bad 200 final),
and the `triaged` refresh without the cached `verdict is None` condition.

Round 3 red team (bp-agent-fix/brief-fix-redteam.md, lead's rules 1-3): the `test_round3_*` specs and the rewritten
`test_audit5_*`/`test_audit6_*`. Filter: `cd agent && python3 -m unittest tests.test_followup_findings -k round3
-k audit5 -k audit6`. The builder's code did not exist when these were written, so `old` describes the line; for the
specs red on e2c4974 the mutation is e2c4974 itself (the `updated_at` comparison, 401/403 final, the stall record
kept across a failed events read).
agent/lumina_bug_agent/fix.py|send_pending resends only while the fetched status is `looking`|resend whatever the status|test_row1_person_sets_fixed_while_looking_is_pending_report_stays_fixed, test_audit4
agent/lumina_bug_agent/fix.py|send_pending: status `looking` → resend, updated_at not read|drop when updated_at > at * 1000 (e2c4974)|test_round3_rule1_player_upload_does_not_drop_the_pending_pr_link, test_audit5
agent/lumina_bug_agent/fix.py|send_pending: answer without updated_at but with status `looking` → resend|keep it as a bad answer (e2c4974)|test_audit6_report_answer_without_updated_at_still_looking_is_delivered
agent/lumina_bug_agent/fix.py|send_pending: missing or non-string `status` → bad answer, kept|treat it as `looking`, or as superseded|test_audit6_report_answer_without_a_string_status_keeps_the_pending_status
agent/lumina_bug_agent/fix.py|transient(): 401 and 403 transient|final again (e2c4974)|test_round3_rule2_seed_401_then_403_then_200_is_cached_and_never_passed, test_round3_rule2_pending_status_kept_when_its_report_get_answers_401_or_403
agent/lumina_bug_agent/fix.py|transient(): the other 4xx final|every 4xx transient|test_round3_rule2_seed_400_or_404_is_dropped_and_the_events_after_it_are_read, test_audit7
agent/lumina_bug_agent/run.py|sync_events reads and clears the stall record first|clear it only after the events were read (e2c4974)|test_round3_rule3_events_failure_between_stalls_restarts_the_count
agent/lumina_bug_agent/run.py|n = previous n + 1 only when the same code stopped the previous sync|previous n + 1 for any code|test_round3_rule3_another_code_stopping_restarts_the_count_at_one
agent/lumina_bug_agent/run.py|at n = 3 the event is handled (`seed skipped`)|never let go|test_audit8, test_round3_rule3_another_code_stopping_restarts_the_count_at_one
"""

from __future__ import annotations

import json
import re
import shutil
import sqlite3
import sys
import time
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))  # `python3 -m unittest tests.test_followup_findings` from agent/

from helpers import (  # noqa: E402
    GREETING_FIXED,
    PR_URL,
    STAGE_B_NEEDS_PERSON,
    STAGE_B_SIMPLE_FIX,
    VALID_STAGE_A,
    EventsWorker,
    Harness,
    mp4_attachment,
)

FREESANS = "/usr/share/fonts/truetype/freefont/FreeSans.ttf"


def _mark(h: Harness) -> int:
    assert h.worker is not None
    with h.worker._lock:
        return len(h.worker.requests)


def _since(h: Harness, start: int) -> list[dict[str, Any]]:
    assert h.worker is not None
    with h.worker._lock:
        return list(h.worker.requests[start:])


def _status_bodies(reqs: list[dict[str, Any]], code: str) -> list[dict[str, Any]]:
    return [json.loads(r["body"].decode("utf-8")) for r in reqs if r["route"] == "status" and r["code"] == code]


def _events_harness(test: unittest.TestCase) -> tuple[Harness, EventsWorker]:
    h = Harness(test, worker_port=None)
    w = EventsWorker()
    test.addCleanup(w.stop)
    h.worker = w
    return h, w


def _cached_values(h: Harness) -> set[str]:
    """Every value of every row of the cache's `reports` table, as text (no column name is assumed)."""
    db = h.state_dir / "cache.sqlite3"
    if not db.exists():
        return set()
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = conn.execute("SELECT * FROM reports").fetchall()
    finally:
        conn.close()
    return {str(v) for row in rows for v in row if v is not None}


# --------------------------------------------------------------------------------------------------------------
# Row 1. A person's status wins over a pending agent status
# --------------------------------------------------------------------------------------------------------------

# simple_fix with confidence under 0.8: the round's one final status is `looking` + `needs_person: low_confidence`,
# posted after the triage, with no stage C.
LOW_CONFIDENCE = dict(STAGE_B_SIMPLE_FIX, confidence=0.5)


class Row1PersonStatusWins(unittest.TestCase):
    """Una persona mette `fixed` mentre un `looking` dell'agente è in attesa → giro dopo → resta `fixed`."""

    CODE = "LUM-410001"

    def _round1_status_fails(self) -> Harness:
        h = Harness(self)
        assert h.worker is not None
        h.worker.add_report(self.CODE)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        h.worker.fail("status", 503)  # every try of round 1
        start = _mark(h)
        h.assert_round_ok(h.run())
        del h.worker.always_fail["status"]
        r1 = _status_bodies(_since(h, start), self.CODE)
        self.assertEqual(len(h.triages(self.CODE)), 1, "scenario: the triage went through")
        self.assertTrue(r1, "scenario: round 1 tried to post the final status")
        self.assertTrue(all(b.get("status") == "looking" for b in r1), f"scenario: the pending status is looking: {r1}")
        self.assertEqual(h.worker.reports[self.CODE]["status"], "looking", "scenario: the triage set looking")
        return h

    def test_row1_person_sets_fixed_while_looking_is_pending_report_stays_fixed(self) -> None:
        h = self._round1_status_fails()
        assert h.worker is not None
        time.sleep(0.01)  # the person's change is strictly later than anything round 1 stored, in ms
        h.worker.person_sets_status(self.CODE, "fixed")
        start = _mark(h)
        for _ in range(2):  # the status route is healthy again; two rounds, so a "kept for later" resend shows too
            h.assert_round_ok(h.run())
        after = _status_bodies(_since(h, start), self.CODE)
        self.assertEqual([b for b in after if b.get("status") == "looking"], [],
                         f"no `looking` status reaches the worker after the person's `fixed`: {after}")
        self.assertEqual(h.worker.reports[self.CODE]["status"], "fixed", "the report is still fixed")
        h.assert_nothing_left()

    def test_row1_control_untouched_report_gets_the_pending_status(self) -> None:
        h = self._round1_status_fails()
        assert h.worker is not None
        start = _mark(h)
        h.assert_round_ok(h.run())
        resent = _status_bodies(_since(h, start), self.CODE)
        self.assertEqual(len(resent), 1, f"nobody touched the report: the pending status is delivered once: {resent}")
        self.assertEqual(resent[0].get("status"), "looking")
        self.assertTrue(str(resent[0].get("note", "")).startswith("needs_person"), f"the stored body: {resent[0]}")
        self.assertEqual(h.worker.reports[self.CODE]["status"], "looking")
        h.assert_nothing_left()


# --------------------------------------------------------------------------------------------------------------
# Row 2. Sixty unknown codes in events
# --------------------------------------------------------------------------------------------------------------


def _triaged_row(w: EventsWorker, code: str, summary: str) -> None:
    """A report the agent never handled: already triaged elsewhere, so it is not in the queue."""
    row = w.add_report(code, what=f"Player text of {code}")
    row["status"] = "looking"
    row["verdict"] = "needs_person"
    row["triage"] = {"stage_a": None, "stage_b": dict(STAGE_B_NEEDS_PERSON, summary=summary),
                     "files": [], "notes": [], "agent": "lumina-bug-agent/1"}


class Row2SixtyUnknownCodes(unittest.TestCase):
    """60 codici sconosciuti negli eventi → tre giri → tutti e 60 nella cache."""

    OLDS = [f"LUM-42{n:04d}" for n in range(60)]

    def _rounds(self, h: Harness, w: EventsWorker, n: int) -> list[int]:
        """Runs `n` rounds, each with one fresh report in the queue (events are synced only in a round that has one).
        Returns the number of seed GETs (report GETs for the 60 codes) of each round."""
        olds = set(self.OLDS)
        per_round = []
        for _ in range(n):
            # A new code every round of the test, across calls: a claimed report keeps its lease and leaves the queue.
            i = self._fresh = getattr(self, "_fresh", -1) + 1
            fresh = f"LUM-429{i:03d}"
            w.add_report(fresh, what=f"Fresh report number {i}")
            start = _mark(h)
            h.assert_round_ok(h.run())
            self.assertEqual(len(h.triages(fresh)), 1, f"scenario: round {i + 1} triaged its queued report")
            per_round.append(len([r for r in _since(h, start) if r["route"] == "report" and r["code"] in olds]))
        return per_round

    def test_row2_sixty_unknown_codes_are_all_cached_after_three_rounds(self) -> None:
        h, w = _events_harness(self)
        for i, code in enumerate(self.OLDS):
            _triaged_row(w, code, f"Summary of {code}")
            w.add_event(code, "created" if i % 2 == 0 else "triaged", {} if i % 2 == 0 else {"verdict": "needs_person"})
        self.assertFalse(h.state_dir.exists(), "scenario: fresh STATE_DIR, events cursor 0")
        per_round = self._rounds(h, w, 3)
        self.assertTrue(all(n <= 50 for n in per_round), f"at most 50 seed GETs a round: {per_round}")
        cached = _cached_values(h)
        missing = [c for c in self.OLDS if c not in cached]
        self.assertEqual(missing, [], f"all 60 codes cached after three rounds (seed GETs per round {per_round})")
        h.assert_nothing_left()

    def test_row2_failed_seed_fetch_is_retried_next_round(self) -> None:
        # Past the edge of "fetched": a GET that fails in round 1 is not lost, the code is cached once it answers.
        h, w = _events_harness(self)
        for i, code in enumerate(self.OLDS[:3]):
            _triaged_row(w, code, f"Summary of {code}")
            w.add_event(code, "triaged", {"verdict": "needs_person"})
        bad = self.OLDS[1]
        w.report_fails.add(bad)
        self._rounds(h, w, 1)
        self.assertTrue(w.calls("report", bad), "scenario: round 1 tried to fetch the code")
        self.assertNotIn(bad, _cached_values(h), "scenario: a failed fetch caches nothing")
        w.report_fails.discard(bad)
        self._rounds(h, w, 1)
        self.assertIn(bad, _cached_values(h), "the code whose fetch failed is fetched and cached on the next round")
        h.assert_nothing_left()


# --------------------------------------------------------------------------------------------------------------
# Row 3. A created then a triaged event
# --------------------------------------------------------------------------------------------------------------


class Row3CreatedThenTriaged(unittest.TestCase):
    """Un evento `created` e poi un `triaged` → la fase B vede il riassunto."""

    X = "LUM-430001"
    Z = "LUM-430002"  # round 1's queued report
    Y = "LUM-430003"  # round 2's queued report
    SUMMARY = "Quokka lantern flickers zx41 after the third wave"

    def test_row3_created_then_triaged_event_stage_b_sees_the_summary(self) -> None:
        h, w = _events_harness(self)
        # X is new and untriaged, held out of the queue by a live lease taken elsewhere (another claim).
        w.add_report(self.X, what="The lantern flickers")
        w.leases[self.X] = int(time.time() * 1000) + 3_600_000
        w.reports[self.X]["lease_until"] = w.leases[self.X]
        w.add_event(self.X, "created")
        w.add_report(self.Z, what="Something else entirely")
        h.assert_round_ok(h.run())
        self.assertEqual(len(w.calls("report", self.X)), 1, "scenario: round 1 learned of X from its created event")
        self.assertEqual(h.triages(self.X), [], "scenario: the agent did not triage X itself")
        self.assertIn(self.X, _cached_values(h), "scenario: X is cached after round 1")
        self.assertNotIn(self.SUMMARY, " ".join(_cached_values(h)), "scenario: with no summary yet")

        # X is triaged elsewhere.
        row = w.reports[self.X]
        row["status"] = "looking"
        row["verdict"] = "needs_person"
        row["triage"] = {"stage_a": None, "stage_b": dict(STAGE_B_NEEDS_PERSON, summary=self.SUMMARY),
                         "files": [], "notes": [], "agent": "lumina-bug-agent/1"}
        row["updated_at"] = int(time.time() * 1000)
        w.add_event(self.X, "triaged", {"verdict": "needs_person"})

        w.add_report(self.Y, what="The lantern flickers on wave three")
        h.assert_round_ok(h.run())
        stage_b = h.claude_calls("stage_b")
        self.assertEqual(len(stage_b), 2, "scenario: stage B ran for Z and for Y")
        self.assertIn(self.X, stage_b[1]["stdin"], "X is in Y's duplicate list")
        self.assertIn(self.SUMMARY, stage_b[1]["stdin"], "with the summary X got when it was triaged")
        h.assert_nothing_left()


# --------------------------------------------------------------------------------------------------------------
# Row 4 (finding 4). The time stamp font comes from FRAME_FONT
# --------------------------------------------------------------------------------------------------------------

_SANS = re.compile(r"(?<![A-Za-z])font='?Sans\b")


class Row4FrameFont(unittest.TestCase):
    """Il font dei tempi si sceglie con FRAME_FONT; senza file si usa `font=Sans` di fontconfig."""

    CODE = "LUM-440001"

    def _draws(self, h: Harness, **env: str) -> list[str]:
        assert h.worker is not None
        h.worker.add_report(self.CODE, attachments=[mp4_attachment("att-font")])
        h.assert_round_ok(h.run(**env))
        draws = [" ".join(c["argv"]) for c in h.media_calls("ffmpeg") if any("drawtext" in a for a in c["argv"])]
        self.assertTrue(draws, "the time stamps are drawn")
        self.assertTrue(h.worker.calls("frames", self.CODE), "the stamped sheets are uploaded")
        h.assert_nothing_left()
        return draws

    def test_row4_frame_font_missing_file_falls_back_to_fontconfig_sans(self) -> None:
        h = Harness(self)
        missing = h.root / "fonts" / "NoSuchFont.ttf"
        self.assertFalse(missing.exists())
        for argv in self._draws(h, FRAME_FONT=str(missing)):
            self.assertRegex(argv, _SANS, "drawtext uses fontconfig `font=Sans`")
            self.assertNotIn("fontfile=", argv, "no fontfile when FRAME_FONT names a missing file")

    def test_row4_frame_font_existing_file_is_used_as_fontfile(self) -> None:
        candidates = [FREESANS, *sorted(str(p) for p in Path("/usr/share/fonts").rglob("*.ttf"))]
        source = next((c for c in candidates if Path(c).is_file()), None)
        if source is None:
            self.skipTest("no .ttf font on this machine to copy")
        h = Harness(self)
        font = h.root / "fonts" / "LbaFrameFont.ttf"  # a path the agent cannot know unless it reads FRAME_FONT
        font.parent.mkdir()
        shutil.copyfile(source, font)
        rx = re.compile(r"fontfile='?" + re.escape(str(font)) + r"'?(?::|,|$|\s)")
        for argv in self._draws(h, FRAME_FONT=str(font)):
            self.assertRegex(argv, rx, f"drawtext carries fontfile={font}")

    @unittest.skipUnless(Path(FREESANS).is_file(), f"{FREESANS} is not installed here")
    def test_row4_frame_font_unset_uses_freesans(self) -> None:
        # The "not set" state is not the "missing file" state: no FRAME_FONT → the FreeSans default.
        h = Harness(self)
        for argv in self._draws(h):
            self.assertRegex(argv, r"fontfile='?" + re.escape(FREESANS), "the default font is FreeSans")


# --------------------------------------------------------------------------------------------------------------
# Follow-up audit (bp-agent-fix/audit.md), findings 1-10. Filter: `python3 -m unittest tests.test_followup_findings -k audit`
# --------------------------------------------------------------------------------------------------------------

PENDING_BODY = json.dumps({"status": "looking", "note": "needs_person: low_confidence"})
WEEK = 7 * 86400
NOT_JSON = b"<html><body>502 Bad Gateway</body></html>"


def _db(h: Harness, sql: str, args: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    """Rows of the agent's own STATE_DIR/cache.sqlite3, read only; [] while the file does not exist yet."""
    db = h.state_dir / "cache.sqlite3"
    if not db.exists():
        return []
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def _pending(h: Harness) -> dict[str, int]:
    """code -> `at` (unix s) of the status POSTs still waiting in the cache."""
    return {str(c): int(a) for c, a in _db(h, "SELECT code, at FROM pending_status")}


def _cursor(h: Harness) -> int | None:
    """The saved events cursor; None while the agent never saved one (not the same as a saved 0)."""
    rows = _db(h, "SELECT value FROM meta WHERE key = 'events_cursor'")
    return int(rows[0][0]) if rows and str(rows[0][0]).strip() else None


def _round(h: Harness) -> tuple[Any, list[dict[str, Any]]]:
    start = _mark(h)
    p = h.run()
    h.assert_round_ok(p)
    return p, _since(h, start)


def _fresh_round(test: unittest.TestCase, h: Harness, w: EventsWorker) -> tuple[Any, list[dict[str, Any]]]:
    """One round with one new report in the queue: the agent reads the events only in a round that has one."""
    i = len([c for c in w.reports if c.startswith("LUM-48")])  # fresh codes of this test's worker so far
    fresh = f"LUM-48{i:04d}"
    w.add_report(fresh, what=f"Fresh report number {i}")
    p, reqs = _round(h)
    test.assertEqual(len(h.triages(fresh)), 1, f"scenario: round {i + 1} triaged its queued report {fresh}")
    return p, reqs


def _pending_after_round1(test: unittest.TestCase, code: str) -> Harness:
    """Round 1 triages `code` (simple_fix, low confidence → final `looking` + needs_person note) while every status
    POST answers 503, so the note waits in the cache. The status route is healthy again afterwards."""
    h = Harness(test)
    assert h.worker is not None
    h.worker.add_report(code)
    h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
    h.worker.fail("status", 503)
    _, r1 = _round(h)
    del h.worker.always_fail["status"]
    test.assertEqual(len(h.triages(code)), 1, "scenario: the triage went through")
    test.assertTrue(_status_bodies(r1, code), "scenario: round 1 tried to post the final status")
    test.assertEqual(h.worker.reports[code]["status"], "looking", "scenario: the triage set looking")
    test.assertIn(code, _pending(h), "scenario: the undelivered status waits in the cache")
    return h


def _insert_pending(h: Harness, rows: list[tuple[str, int]]) -> None:
    """Pending status rows with a chosen `at` (unix s), written into the agent's cache after a first round made it."""
    conn = sqlite3.connect(h.state_dir / "cache.sqlite3")
    try:
        with conn:
            conn.executemany("INSERT INTO pending_status(code, body, at) VALUES(?, ?, ?)",
                             [(c, PENDING_BODY, at) for c, at in rows])
    finally:
        conn.close()


def _looking_report(h: Harness, code: str) -> None:
    """A report the agent triaged long ago (status `looking`, `updated_at` from 2025): a pending status may land on it."""
    assert h.worker is not None
    h.worker.add_report(code)["status"] = "looking"


class AuditFinding1BadTwoHundred(unittest.TestCase):
    """Finding 1: un GET del report che risponde 200 con un corpo non JSON o tagliato non è una risposta finale."""

    CODE = "LUM-450001"
    A, X, B = "LUM-450011", "LUM-450012", "LUM-450013"

    def _pending_stays(self, **answer: Any) -> None:
        h = _pending_after_round1(self, self.CODE)
        assert h.worker is not None
        h.worker.answer_report(self.CODE, **answer)
        p2, r2 = _round(h)
        self.assertTrue([r for r in r2 if r["route"] == "report" and r["code"] == self.CODE],
                        "scenario: round 2 read the report before resending")
        self.assertEqual(_status_bodies(r2, self.CODE), [], "nothing POSTed on a bad 200 answer")
        self.assertIn(self.CODE, _pending(h), f"a bad 200 answer keeps the pending status:\n{p2.stderr[-1500:]}")
        _, r3 = _round(h)
        resent = _status_bodies(r3, self.CODE)
        self.assertEqual([b.get("status") for b in resent], ["looking"], "delivered once the worker answers normally")
        self.assertTrue(str(resent[0].get("note", "")).startswith("needs_person"), f"the stored note: {resent[0]}")

    def test_audit1_pending_status_kept_when_report_get_is_not_json(self) -> None:
        self._pending_stays(raw=NOT_JSON)

    def test_audit1_pending_status_kept_when_report_get_is_cut_short(self) -> None:
        self._pending_stays(body={"report": {"status": "looking", "updated_at": 0}}, cut_short=True)

    def _seed_not_handled(self, **answer: Any) -> None:
        h, w = _events_harness(self)
        for code in (self.A, self.X, self.B):
            _triaged_row(w, code, f"Summary of {code}")
            w.add_event(code, "triaged", {"verdict": "needs_person"})
        x_seq = w.events[1]["seq"]
        w.answer_report(self.X, **answer)
        _fresh_round(self, h, w)
        self.assertTrue(w.calls("report", self.X), "scenario: round 1 tried to fetch X")
        self.assertNotIn(self.X, _cached_values(h), "a bad 200 answer caches nothing")
        cursor = _cursor(h)
        self.assertTrue(cursor is None or cursor < x_seq, f"the events cursor stays before X's event (seq {x_seq}): {cursor}")
        _fresh_round(self, h, w)
        cached = _cached_values(h)
        self.assertIn(self.X, cached, "X is fetched again and cached once the worker answers normally")
        self.assertIn(f"Summary of {self.X}", cached, "with its summary")
        self.assertIn(self.B, cached, "and the events after it are read too")

    def test_audit1_seed_not_handled_when_report_get_is_not_json(self) -> None:
        self._seed_not_handled(raw=NOT_JSON)

    def test_audit1_seed_not_handled_when_report_get_is_cut_short(self) -> None:
        self._seed_not_handled(body={"report": {"code": self.X, "title": None}}, cut_short=True)


class AuditFinding2OwnTriagedEvent(unittest.TestCase):
    """Finding 2: l'evento `triaged` del report che l'agente ha triato da sé (fase B non valida) non lo rilegge."""

    R = "LUM-460001"
    OWN_WHAT = "Crate opens twice on a fast double tap"

    def test_audit2_own_triage_with_invalid_stage_b_is_not_refetched_on_its_triaged_event(self) -> None:
        h, w = _events_harness(self)
        w.add_report(self.R, what="the crate thing")  # a web report: the worker's `title` is None
        h.set_stage("stage_a", mode="json", object=dict(VALID_STAGE_A, what=self.OWN_WHAT))
        h.set_stage("stage_b", mode="json", object={"verdict": "not a verdict"})
        _round(h)
        self.assertEqual(len(h.triages(self.R)), 1, "scenario: the agent triaged R itself")
        self.assertEqual(h.one_triage(self.R).get("verdict"), "unclear", "scenario: stage B was invalid")
        before = _db(h, "SELECT title, summary, verdict FROM reports WHERE code = ?", (self.R,))
        self.assertEqual(len(before), 1, "scenario: R is cached after its own triage")
        self.assertEqual(before[0][1] or "", "", "scenario: cached with an empty summary")
        self.assertIsNotNone(before[0][2], "scenario: cached with the verdict the agent posted")

        w.add_event(self.R, "triaged", {"verdict": "unclear"})  # the worker's event for the agent's own triage
        h.set_stage("stage_a", mode="json", object=dict(VALID_STAGE_A, what="Another player's shop problem"))
        h.set_stage("stage_b", mode="json", object=dict(STAGE_B_NEEDS_PERSON))
        _, r2 = _fresh_round(self, h, w)
        self.assertEqual([r["path"] for r in r2 if r["route"] == "report" and r["code"] == self.R], [],
                         "the agent's own triaged event does not fetch R again")
        after = _db(h, "SELECT title FROM reports WHERE code = ?", (self.R,))
        self.assertEqual(after, [(before[0][0],)], "R's cached title is unchanged")
        stage_b = h.claude_calls("stage_b")
        self.assertIn(before[0][0], stage_b[-1]["stdin"], "the next report's duplicate list still shows R's description")


class AuditFinding3PendingExpiry(unittest.TestCase):
    """Finding 3: uno stato in attesa da più di 7 giorni si scarta; appena dentro i 7 giorni si invia."""

    OLD, YOUNG = "LUM-470001", "LUM-470002"

    def test_audit3_pending_status_older_than_seven_days_is_dropped_unsent(self) -> None:
        h = Harness(self)
        assert h.worker is not None
        _round(h)  # an empty queue: the agent makes its cache
        _looking_report(h, self.OLD)
        _looking_report(h, self.YOUNG)
        now = int(time.time())
        _insert_pending(h, [(self.OLD, now - WEEK - 1), (self.YOUNG, now - WEEK + 120)])
        _, r = _round(h)
        self.assertEqual(_status_bodies(r, self.OLD), [], "a status pending for more than 7 days is not sent")
        self.assertNotIn(self.OLD, _pending(h), "and it leaves the cache")
        self.assertEqual(len(_status_bodies(r, self.YOUNG)), 1, "one just inside the 7 days is still sent")
        self.assertEqual(_pending(h), {}, "nothing left pending")


class AuditFinding4To6PendingReadsTheReport(unittest.TestCase):
    """Findings 4-6: il reinvio di uno stato in attesa legge il report; dal giro 3 decide solo lo stato."""

    CODE = "LUM-470901"

    def test_audit4_person_closed_with_an_old_updated_at_gets_no_looking(self) -> None:
        h = _pending_after_round1(self, self.CODE)
        assert h.worker is not None
        old = h.worker.reports[self.CODE]["created_at"]  # the report's first updated_at
        h.worker.person_sets_status(self.CODE, "closed")
        h.worker.reports[self.CODE]["updated_at"] = old  # the worker's clock is behind
        self.assertLessEqual(old, _pending(h)[self.CODE] * 1000, "scenario: only the status tells the person's change")
        for _ in range(2):
            _, r = _round(h)
            self.assertEqual(_status_bodies(r, self.CODE), [], "no `looking` over the person's `closed`")
        self.assertEqual(h.worker.reports[self.CODE]["status"], "closed")
        self.assertNotIn(self.CODE, _pending(h), "the superseded status leaves the cache")

    def test_audit5_still_looking_but_updated_after_the_pending_status_is_delivered(self) -> None:
        # Round 3, rule 1: only the status decides. A newer write that leaves the report `looking` (a person setting
        # `looking` again, a player's upload) is not a decision against the agent's `looking`: the note still goes out.
        h = _pending_after_round1(self, self.CODE)
        assert h.worker is not None
        time.sleep(0.01)
        h.worker.person_sets_status(self.CODE, "looking")  # same status, newer write
        self.assertGreater(h.worker.reports[self.CODE]["updated_at"], _pending(h)[self.CODE] * 1000,
                           "scenario: the report was written after the pending status was stored")
        _, r2 = _round(h)
        resent = _status_bodies(r2, self.CODE)
        self.assertEqual([b.get("status") for b in resent], ["looking"], "the pending `looking` is delivered once")
        self.assertTrue(str(resent[0].get("note", "")).startswith("needs_person"), f"with its stored note: {resent[0]}")
        self.assertNotIn(self.CODE, _pending(h), "and it leaves the cache")
        _, r3 = _round(h)
        self.assertEqual(_status_bodies(r3, self.CODE), [], "never twice")

    def test_audit6_report_answer_without_a_string_status_keeps_the_pending_status(self) -> None:
        # "Not yet": an answer that does not say the status is no decision, neither `looking` nor another one.
        updated = 1_762_400_000_000
        for label, row in (("missing", {"updated_at": updated}), ("null", {"status": None, "updated_at": updated}),
                           ("number", {"status": 5, "updated_at": updated})):
            with self.subTest(status=label):
                h = _pending_after_round1(self, self.CODE)
                assert h.worker is not None
                h.worker.answer_report(self.CODE, body={"report": row})
                _, r2 = _round(h)
                self.assertTrue([r for r in r2 if r["route"] == "report" and r["code"] == self.CODE],
                                "scenario: round 2 read the report")
                self.assertEqual(_status_bodies(r2, self.CODE), [], "nothing POSTed on an answer without a status")
                self.assertIn(self.CODE, _pending(h), "the pending status is kept")
                _, r3 = _round(h)
                self.assertEqual([b.get("status") for b in _status_bodies(r3, self.CODE)], ["looking"],
                                 "and delivered once the worker answers in full")
                self.assertNotIn(self.CODE, _pending(h))

    def test_audit6_report_answer_without_updated_at_still_looking_is_delivered(self) -> None:
        # Round 3, rule 1: `updated_at` is no longer read, so an answer carrying only the status is a full answer.
        h = _pending_after_round1(self, self.CODE)
        assert h.worker is not None
        h.worker.answer_report(self.CODE, body={"report": {"status": "looking"}})
        _, r2 = _round(h)
        self.assertEqual([b.get("status") for b in _status_bodies(r2, self.CODE)], ["looking"],
                         "the status `looking` alone is enough to deliver the pending one")
        self.assertNotIn(self.CODE, _pending(h), "and it leaves the cache")


class AuditFinding7PendingGetFails(unittest.TestCase):
    """Finding 7: GET del report 404 → stato scartato; 503 → tenuto, e la riga dopo si prova lo stesso."""

    GONE, BUSY, FINE = "LUM-490001", "LUM-490002", "LUM-490003"

    def test_audit7_pending_get_404_drops_503_keeps_and_the_next_row_is_tried(self) -> None:
        h = Harness(self)
        assert h.worker is not None
        _round(h)
        for code in (self.GONE, self.BUSY, self.FINE):
            _looking_report(h, code)
        now = int(time.time())
        _insert_pending(h, [(self.GONE, now - 30), (self.BUSY, now - 20), (self.FINE, now - 10)])  # oldest first
        h.worker.answer_report(self.GONE, status=404)
        h.worker.answer_report(self.BUSY, status=503)
        _, r1 = _round(h)
        self.assertEqual(_status_bodies(r1, self.GONE), [], "404: nothing POSTed")
        self.assertEqual(_status_bodies(r1, self.BUSY), [], "503: nothing POSTed this round")
        self.assertEqual(len(_status_bodies(r1, self.FINE)), 1, "the row after a 503 is still tried")
        self.assertEqual(set(_pending(h)), {self.BUSY}, "404 dropped, 503 kept")
        _, r2 = _round(h)
        self.assertEqual(len(_status_bodies(r2, self.BUSY)), 1, "the kept one is delivered next round")
        self.assertEqual(_status_bodies(r2, self.GONE), [], "the dropped one never comes back")


class AuditFinding8To10Events(unittest.TestCase):
    """Findings 8-10: blocco su un seme che fallisce, `seq` non valido, cursore su una pagina fermata."""

    BAD, AFTER = "LUM-491001", "LUM-491002"

    def test_audit8_stall_guard_lets_a_failing_seed_go_in_round_three(self) -> None:
        h, w = _events_harness(self)
        for code in (self.BAD, self.AFTER):
            _triaged_row(w, code, f"Summary of {code}")
            w.add_event(code, "triaged", {"verdict": "needs_person"})
        w.report_fails.add(self.BAD)  # 500 on every GET
        for n in (1, 2):
            _fresh_round(self, h, w)
            self.assertNotIn(self.AFTER, _cached_values(h), f"round {n}: the code after the failing one waits")
        before = len(w.calls("report", self.BAD))
        _fresh_round(self, h, w)
        self.assertEqual(len(w.calls("report", self.BAD)), before + 1, "scenario: round 3 tried the failing code again")
        self.assertIn(self.AFTER, _cached_values(h), "round 3 lets the failing code go and caches the ones after it")
        self.assertNotIn(self.BAD, _cached_values(h))

    def test_audit9_event_without_an_int_seq_is_a_bad_answer_cursor_unchanged(self) -> None:
        for label, broken in (("missing", None), ("string", "2")):
            with self.subTest(seq=label):
                h, w = _events_harness(self)
                _triaged_row(w, self.BAD, "Summary one")
                w.add_event(self.BAD, "triaged", {"verdict": "needs_person"})
                _fresh_round(self, h, w)
                self.assertEqual(_cursor(h), 1, "scenario: round 1 read the first event")
                _triaged_row(w, self.AFTER, "Summary two")
                w.add_event(self.AFTER, "triaged", {"verdict": "needs_person"})
                w.add_event(self.AFTER, "status_changed", {"from": "looking", "to": "fixed"})
                if broken is None:
                    del w.events[1]["seq"]
                else:
                    w.events[1]["seq"] = broken
                p, _ = _fresh_round(self, h, w)  # the round itself goes on: exit 0, its queued report triaged
                self.assertRegex(p.stderr, r"lumina-bug-agent: events failed\b.*bad_answer", "logged as a bad answer")
                self.assertEqual(_cursor(h), 1, "the cursor is not moved by a page it cannot trust")

    def test_audit10_stopped_page_saves_the_cursor_at_the_last_handled_event(self) -> None:
        h, w = _events_harness(self)
        for i in range(10):  # handled without a seed: status changes of codes the cache does not know
            w.add_event(f"LUM-49{i:04d}", "status_changed", {"from": "looking", "to": "fixed"})
        olds = [f"LUM-492{n:03d}" for n in range(60)]
        for i, code in enumerate(olds):
            _triaged_row(w, code, f"Summary of {code}")
            w.add_event(code, "created" if i % 2 == 0 else "triaged", {} if i % 2 == 0 else {"verdict": "needs_person"})
        seeded = [e["seq"] for e in w.events if e["type"] in ("created", "triaged")]
        _, r1 = _fresh_round(self, h, w)
        gets = [r["code"] for r in r1 if r["route"] == "report" and r["code"] in set(olds)]
        self.assertEqual(len(gets), 50, "scenario: the cap of 50 stopped the page")
        self.assertEqual(_cursor(h), seeded[49], "the cursor is saved at the seq of the 50th seeded event")


# --------------------------------------------------------------------------------------------------------------
# Round 3 red team (brief-fix-redteam.md, the lead's rules 1-3). Filter: `-k round3 -k audit5 -k audit6`
# --------------------------------------------------------------------------------------------------------------


class Round3Rule1StatusDecides(unittest.TestCase):
    """Regola 1: un `{status: looking, prUrl}` in attesa, report ancora `looking` ma `updated_at` mosso dal caricamento
    di un giocatore → il giro dopo il link della PR arriva."""

    CODE = "LUM-493001"

    def test_round3_rule1_player_upload_does_not_drop_the_pending_pr_link(self) -> None:
        h = Harness(self)
        assert h.worker is not None
        h.worker.add_report(self.CODE)
        h.set_stage("stage_b", mode="json", object=dict(STAGE_B_SIMPLE_FIX))
        h.set_stage("builder", mode="json", object={"summary": "edited"},
                    writes={"src/Shared/Greeting.luau": GREETING_FIXED})
        h.worker.fail("status", 500)  # the status route fails after stage C opened the draft PR
        _, r1 = _round(h)
        del h.worker.always_fail["status"]
        self.assertEqual(len(h.gh_calls()), 1, "scenario: stage C opened the draft PR")
        self.assertTrue([b for b in _status_bodies(r1, self.CODE) if b.get("prUrl") == PR_URL],
                        "scenario: round 1 tried to post the PR link")
        self.assertIn(self.CODE, _pending(h), "scenario: the PR link waits in the cache")
        time.sleep(0.01)
        h.worker.player_uploads(self.CODE)  # updated_at moves, the status does not
        self.assertEqual(h.worker.reports[self.CODE]["status"], "looking", "scenario: the report is still looking")
        self.assertGreater(h.worker.reports[self.CODE]["updated_at"], _pending(h)[self.CODE] * 1000,
                           "scenario: the upload is newer than the stored status")
        _, r2 = _round(h)
        sent = [(b.get("status"), b.get("prUrl")) for b in _status_bodies(r2, self.CODE)]
        self.assertEqual(sent, [("looking", PR_URL)], "the PR link is delivered after a player's upload")
        self.assertNotIn(self.CODE, _pending(h), "and it leaves the cache")
        self.assertEqual(h.worker.reports[self.CODE]["status"], "looking")
        self.assertEqual(len(h.gh_calls()), 1, "the PR is not opened again")


class Round3Rule2AuthAnswersAreTransient(unittest.TestCase):
    """Regola 2: 401 e 403 sono transitori (semina e stati in attesa); gli altri 4xx (400, 404, …) sono finali."""

    A, X, B = "LUM-494001", "LUM-494002", "LUM-494003"
    CODE = "LUM-494101"

    def _three_events(self, w: EventsWorker) -> int:
        for code in (self.A, self.X, self.B):
            _triaged_row(w, code, f"Summary of {code}")
            w.add_event(code, "triaged", {"verdict": "needs_person"})
        return int(w.events[1]["seq"])

    def test_round3_rule2_seed_401_then_403_then_200_is_cached_and_never_passed(self) -> None:
        h, w = _events_harness(self)
        x_seq = self._three_events(w)
        w.answer_report(self.X, status=401)
        w.answer_report(self.X, status=403)  # queued after the 401: round 1 gets 401, round 2 gets 403
        for n in (1, 2):
            before = len(w.calls("report", self.X))
            _fresh_round(self, h, w)
            self.assertEqual(len(w.calls("report", self.X)), before + 1, f"scenario: round {n} fetched X once")
            cached = _cached_values(h)
            self.assertNotIn(self.X, cached, f"round {n}: a refused GET caches nothing")
            cursor = _cursor(h)
            self.assertTrue(cursor is None or cursor < x_seq,
                            f"round {n}: the events cursor stays before X's event (seq {x_seq}): {cursor}")
            self.assertNotIn(self.B, cached, f"round {n}: the event after X waits")
        _fresh_round(self, h, w)
        cached = _cached_values(h)
        self.assertIn(self.X, cached, "X is cached once the worker answers 200")
        self.assertIn(f"Summary of {self.X}", cached, "with its summary")
        self.assertIn(self.B, cached, "and the events after it are read")

    def test_round3_rule2_seed_400_or_404_is_dropped_and_the_events_after_it_are_read(self) -> None:
        # Past each edge of 401-403: the other 4xx stay final, so they never hold the cursor.
        for status in (400, 404):
            with self.subTest(status=status):
                h, w = _events_harness(self)
                x_seq = self._three_events(w)
                w.answer_report(self.X, status=status, times=None)
                _fresh_round(self, h, w)
                self.assertTrue(w.calls("report", self.X), "scenario: round 1 fetched X")
                cached = _cached_values(h)
                self.assertNotIn(self.X, cached, "a final answer caches nothing")
                self.assertIn(self.B, cached, "the event after X is read in the same round")
                cursor = _cursor(h)
                self.assertTrue(cursor is not None and cursor > x_seq, f"the cursor passed X's event: {cursor}")

    def test_round3_rule2_pending_status_kept_when_its_report_get_answers_401_or_403(self) -> None:
        for status in (401, 403):
            with self.subTest(status=status):
                h = _pending_after_round1(self, self.CODE)
                assert h.worker is not None
                h.worker.answer_report(self.CODE, status=status)
                _, r2 = _round(h)
                self.assertTrue([r for r in r2 if r["route"] == "report" and r["code"] == self.CODE],
                                "scenario: round 2 read the report before resending")
                self.assertEqual(_status_bodies(r2, self.CODE), [], f"nothing POSTed on a {status}")
                self.assertIn(self.CODE, _pending(h), f"a {status} keeps the pending status")
                _, r3 = _round(h)
                self.assertEqual([b.get("status") for b in _status_bodies(r3, self.CODE)], ["looking"],
                                 "delivered once the worker lets the agent in again")
                self.assertNotIn(self.CODE, _pending(h))


class Round3Rule3ConsecutiveStalls(unittest.TestCase):
    """Regola 3: il conto dei blocchi è consecutivo: X fallisce nei giri 1 e 2, gli eventi falliscono nel giro 3, X
    fallisce nel giro 4 → l'evento di X non si salta; nel giro 5 X risponde e si mette in cache."""

    X, Y, B = "LUM-495001", "LUM-495002", "LUM-495003"

    def _events(self, w: EventsWorker, codes: tuple[str, ...]) -> dict[str, int]:
        for code in codes:
            _triaged_row(w, code, f"Summary of {code}")
            w.add_event(code, "triaged", {"verdict": "needs_person"})
        return {e["code"]: int(e["seq"]) for e in w.events}

    def _held_before(self, h: Harness, seq: int, after: str, label: str) -> None:
        cursor = _cursor(h)
        self.assertTrue(cursor is None or cursor < seq, f"{label}: the cursor stays before seq {seq}: {cursor}")
        self.assertNotIn(after, _cached_values(h), f"{label}: the event after it waits")

    def test_round3_rule3_events_failure_between_stalls_restarts_the_count(self) -> None:
        h, w = _events_harness(self)
        seqs = self._events(w, (self.X, self.B))
        w.report_fails.add(self.X)  # 500 on every GET of X
        for n in (1, 2):
            before = len(w.calls("report", self.X))
            _fresh_round(self, h, w)
            self.assertEqual(len(w.calls("report", self.X)), before + 1, f"scenario: sync {n} tried X")
            self._held_before(h, seqs[self.X], self.B, f"sync {n}")
        events_before, x_before = len(w.calls("events")), len(w.calls("report", self.X))
        w.fail("events", 503, times=1)
        _fresh_round(self, h, w)
        self.assertEqual(len(w.calls("events")), events_before + 1, "scenario: sync 3 read the events once")
        self.assertEqual(len(w.calls("report", self.X)), x_before, "scenario: sync 3 never reached X")
        _fresh_round(self, h, w)
        self.assertEqual(len(w.calls("report", self.X)), x_before + 1, "scenario: sync 4 tried X again")
        self._held_before(h, seqs[self.X], self.B, "sync 4 (X failed in 1, 2 and 4, not three syncs in a row)")
        w.report_fails.discard(self.X)
        _fresh_round(self, h, w)
        cached = _cached_values(h)
        self.assertIn(self.X, cached, "sync 5: X answers and is cached")
        self.assertIn(f"Summary of {self.X}", cached, "with its summary")
        self.assertIn(self.B, cached, "and the event after it is read")

    def test_round3_rule3_another_code_stopping_restarts_the_count_at_one(self) -> None:
        h, w = _events_harness(self)
        seqs = self._events(w, (self.X, self.Y, self.B))
        w.report_fails.add(self.X)
        _fresh_round(self, h, w)  # sync 1: X stops it (X 1)
        self._held_before(h, seqs[self.X], self.Y, "sync 1")
        w.report_fails.discard(self.X)
        w.report_fails.add(self.Y)
        _fresh_round(self, h, w)  # sync 2: X answers, Y stops it: Y's count is 1, not X's 1 + 1
        self.assertIn(self.X, _cached_values(h), "scenario: sync 2 cached X")
        self._held_before(h, seqs[self.Y], self.B, "sync 2")
        _fresh_round(self, h, w)  # sync 3: Y 2
        self._held_before(h, seqs[self.Y], self.B, "sync 3 (Y stopped only syncs 2 and 3)")
        _fresh_round(self, h, w)  # sync 4: Y 3, let go
        self.assertIn(self.B, _cached_values(h), "sync 4: Y stopped three syncs in a row, the event after it is read")
        self.assertNotIn(self.Y, _cached_values(h))


if __name__ == "__main__":
    unittest.main()
