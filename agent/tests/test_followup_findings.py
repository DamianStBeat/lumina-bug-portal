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
agent/lumina_bug_agent/run.py|pending status dropped when the fetched report's updated_at is newer than the pending row's at|keep the old unconditional resend|test_row1_person_sets_fixed_while_looking_is_pending_report_stays_fixed
agent/lumina_bug_agent/run.py|pending status resent when nobody touched the report (updated_at <= at)|compare updated_at >= at, or drop always|test_row1_control_untouched_report_gets_the_pending_status
agent/lumina_bug_agent/run.py|events cursor advances only past events handled (stops at the first code over the cap of 50)|advance to the page's `last`|test_row2_sixty_unknown_codes_are_all_cached_after_three_rounds
agent/lumina_bug_agent/cache.py|cap 50 seed fetches a round|no cap|test_row2_sixty_unknown_codes_are_all_cached_after_three_rounds
agent/lumina_bug_agent/run.py|failed seed fetch stops the cursor (retried next round)|advance anyway|test_row2_failed_seed_fetch_is_retried_next_round
agent/lumina_bug_agent/cache.py|`triaged` event for a cached code with an empty summary refetches and upserts the row|skip codes already cached|test_row3_created_then_triaged_event_stage_b_sees_the_summary
agent/lumina_bug_agent/media.py|FONT from env FRAME_FONT|hard-coded FreeSans path|test_row4_frame_font_existing_file_is_used_as_fontfile
agent/lumina_bug_agent/media.py|missing font file → drawtext font=Sans, no fontfile|always fontfile=<FONT>|test_row4_frame_font_missing_file_falls_back_to_fontconfig_sans
agent/lumina_bug_agent/media.py|FRAME_FONT default /usr/share/fonts/truetype/freefont/FreeSans.ttf|another default|test_row4_frame_font_unset_uses_freesans
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
    STAGE_B_NEEDS_PERSON,
    STAGE_B_SIMPLE_FIX,
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
        for i in range(n):
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


if __name__ == "__main__":
    unittest.main()
