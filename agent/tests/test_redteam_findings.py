"""Red team round (Astra, head ca1bbbf): one group of specs per finding, built to the lead's rule in brief-fix-3.md.

1. A frames POST that fails is a report-level failure before stage A: no claude, no triage, temp dir removed, the
   failed-attempt counter goes up (after 3: triage `unclear` with `agent_failed`); the report comes back after its lease.
2. A final status POST that fails is retried 3 times in the round, then stored; each later round re-sends it after the
   lock and before the queue, deleting it on 2xx or on a 4xx other than 429/408 (logged as dropped); never in dry run.
3. On a fresh cache, an event (`created`/`triaged`) for an unknown code makes the agent GET that report and add it to
   the duplicate list; at most 50 such GETs a round; a failed GET is not fatal; the player's `what` never enters the
   cache and the title is kept to 200 characters.
4. No contact sheet without time stamps: when drawtext fails, the file is `ffmpeg_failed`. The missing-font fallback
   (`font=Sans`) runs only on a machine without FreeSans.ttf: the path is hard-coded and this machine cannot hide it.
5. A GIT_WORKSPACE that created `bugfix/<code-lower>` and then failed leaves no local branch and no worktree.

Every spec runs the real agent (helpers.Harness); expected values come from the worker's records, the fakes' records,
git and the cache file, never from text the spec itself placed where it then looks.

Mutations (file|line to mutate|mutation|spec filter that must turn red; the builder's code was not readable when these
were written, so `old` describes the line):
agent/lumina_bug_agent/run.py|frames POST failure raises a report-level error|log it and go on to stage A|test_finding1_frames_503_stops_the_report_before_stage_a
agent/lumina_bug_agent/run.py|frames failure counted as a failed attempt|do not count it|test_finding1_three_frames_failures_post_unclear_agent_failed
agent/lumina_bug_agent/fix.py|status POST retried 3 times|1 try|test_finding2_status_503_three_times_is_stored_and_resent_before_the_queue
agent/lumina_bug_agent/cache.py|insert into pending_status after the last failed try|skip the insert|test_finding2_status_503_three_times_is_stored_and_resent_before_the_queue
agent/lumina_bug_agent/run.py|re-send pending statuses before GET /agent/queue|after the queue|test_finding2_status_503_three_times_is_stored_and_resent_before_the_queue
agent/lumina_bug_agent/run.py|delete pending on 2xx|keep it|test_finding2_status_503_three_times_is_stored_and_resent_before_the_queue
agent/lumina_bug_agent/run.py|4xx other than 429/408 dropped|keep every 4xx|test_finding2_pending_status_dropped_on_400
agent/lumina_bug_agent/run.py|429/408 kept|drop every 4xx|test_finding2_pending_status_kept_on_429 / _on_408
agent/lumina_bug_agent/run.py|no re-send in dry run|re-send in dry run|test_finding2_pending_status_is_not_sent_in_dry_run
agent/lumina_bug_agent/fix.py|pr_url status goes through the durable sender|plain post|test_finding2_pr_url_status_survives_a_failed_post
agent/lumina_bug_agent/cache.py|unknown event code → GET /agent/reports/{code} + insert|ignore unknown codes|test_finding3_triaged_event_for_an_unknown_code_seeds_the_duplicate_list
agent/lumina_bug_agent/cache.py|event types created and triaged|triaged only|test_finding3_created_event_for_an_unknown_code_seeds_the_duplicate_list
agent/lumina_bug_agent/cache.py|cap 50 fetches a round|no cap|test_finding3_at_most_50_report_fetches_a_round
agent/lumina_bug_agent/cache.py|fetch failure caught|let it raise|test_finding3_failed_fetch_is_not_fatal
agent/lumina_bug_agent/cache.py|title[:200]|title|test_finding3_triaged_event_for_an_unknown_code_seeds_the_duplicate_list
agent/lumina_bug_agent/media.py|drawtext failure → ffmpeg_failed|retry without drawtext|test_finding4_drawtext_failure_skips_the_file_as_ffmpeg_failed
agent/lumina_bug_agent/fix.py|branch -D in finally also when the worktree creation failed|only after a created worktree|test_finding5
"""

from __future__ import annotations

import http.server
import json
import os
import re
import unittest
import urllib.parse
from typing import Any

from helpers import (
    GREETING_FIXED,
    PR_URL,
    PYTHON,
    REAL_FFMPEG,
    STAGE_B_SIMPLE_FIX,
    VALID_STAGE_A,
    FakeWorker,
    Harness,
    _write_exec,
    file_entry,
    mp4_attachment,
    stage_a_payload,
)

FREESANS = "/usr/share/fonts/truetype/freefont/FreeSans.ttf"


def _since(h: Harness, start: int) -> list[dict[str, Any]]:
    """The worker's requests from index `start` on, so a spec can read one round at a time."""
    assert h.worker is not None
    with h.worker._lock:
        return list(h.worker.requests[start:])


def _mark(h: Harness) -> int:
    assert h.worker is not None
    with h.worker._lock:
        return len(h.worker.requests)


def _bodies(reqs: list[dict[str, Any]], route: str) -> list[Any]:
    return [json.loads(r["body"].decode("utf-8")) for r in reqs if r["route"] == route]


# --------------------------------------------------------------------------------------------------------------
# 1. Frames upload failure
# --------------------------------------------------------------------------------------------------------------


class Finding1FramesUploadFails(unittest.TestCase):
    """Un caricamento dei fotogrammi che fallisce ferma il report prima della fase A; torna dopo il lease."""

    CODE = "LUM-310001"

    def _harness(self) -> Harness:
        h = Harness(self)
        h.worker.add_report(self.CODE, attachments=[mp4_attachment("att-frames")])
        return h

    def test_finding1_frames_503_stops_the_report_before_stage_a(self) -> None:
        h = self._harness()
        h.worker.fail("frames", 503)
        p = h.run()
        h.assert_round_ok(p)
        self.assertTrue(h.worker.calls("frames", self.CODE), "the round made a sheet and tried to upload it")
        self.assertEqual(h.claude_calls(), [], "no claude call when the frames could not be uploaded")
        self.assertEqual(h.triages(), [], "no triage POST: the report is not triaged without its frames")
        self.assertEqual(h.statuses(), [], "no status POST either")
        h.assert_nothing_left()

        # The lease is still live: the next round does not see the report.
        del h.worker.always_fail["frames"]
        h.assert_round_ok(h.run())
        self.assertEqual(len(h.worker.calls("claim", self.CODE)), 1, "no second claim while the lease is live")
        self.assertEqual(h.triages(), [])

        # The lease ran out and frames work again: the report comes back and is triaged with its sheets.
        h.worker.expire_lease(self.CODE)
        start = _mark(h)
        p3 = h.run()
        h.assert_round_ok(p3)
        later = _since(h, start)
        self.assertTrue([r for r in later if r["route"] == "frames"], "the sheets are uploaded on the later round")
        self.assertEqual(len(h.triages(self.CODE)), 1, "the later round posts the triage")
        self.assertEqual(len(h.claude_calls("stage_a")), 1, "stage A ran once, on the later round")
        h.assert_nothing_left()

    def test_finding1_three_frames_failures_post_unclear_agent_failed(self) -> None:
        h = self._harness()
        h.worker.fail("frames", 503)
        triaged_at: list[int] = []
        for n in range(1, 6):
            p = h.run()
            h.assert_round_ok(p)
            if h.triages(self.CODE) and not triaged_at:
                triaged_at.append(n)
            h.worker.expire_lease(self.CODE)
        self.assertEqual(h.claude_calls(), [], "frames never uploaded: claude never runs")
        bodies = h.triages(self.CODE)
        self.assertEqual(len(bodies), 1, f"one triage after the failed attempts, got {len(bodies)}")
        self.assertIn(triaged_at[0], (3, 4), "not before the third failed attempt, and not later than the next round")
        self.assertEqual(bodies[0].get("verdict"), "unclear")
        self.assertIn("agent_failed", json.dumps(bodies[0]), f"the triage notes agent_failed: {bodies[0]}")
        h.assert_nothing_left()


# --------------------------------------------------------------------------------------------------------------
# 2. Final status POST failure
# --------------------------------------------------------------------------------------------------------------

# Stage B says simple_fix with a confidence under 0.8: the report's one final status is
# `looking` + `needs_person: low_confidence`, with no stage C (cheap, and the only status POST of the round).
LOW_CONFIDENCE = dict(STAGE_B_SIMPLE_FIX, confidence=0.5)


class Finding2StatusPostFails(unittest.TestCase):
    """Uno stato finale che il worker rifiuta non va perso: riprovato, salvato, rimandato al giro dopo."""

    CODE = "LUM-320001"

    def _harness(self) -> Harness:
        h = Harness(self)
        h.worker.add_report(self.CODE)
        h.set_stage("stage_b", mode="json", object=dict(LOW_CONFIDENCE))
        return h

    def _round1_fails(self, h: Harness) -> dict[str, Any]:
        h.worker.fail("status", 503)
        start = _mark(h)
        p = h.run()
        h.assert_round_ok(p)
        del h.worker.always_fail["status"]
        r1 = _since(h, start)
        self.assertEqual(len(h.triages(self.CODE)), 1, "the triage itself went through")
        sent = _bodies(r1, "status")
        self.assertEqual(len(sent), 3, f"the final status is tried 3 times in the round, got {len(sent)}")
        self.assertTrue(all(b == sent[0] for b in sent), f"the same body each time: {sent}")
        self.assertTrue(str(sent[0].get("note", "")).startswith("needs_person"), f"scenario: {sent[0]}")
        h.assert_nothing_left()
        return sent[0]

    def test_finding2_status_503_three_times_is_stored_and_resent_before_the_queue(self) -> None:
        h = self._harness()
        body = self._round1_fails(h)

        start = _mark(h)
        p2 = h.run()
        h.assert_round_ok(p2)
        r2 = _since(h, start)
        routes = [r["route"] for r in r2]
        self.assertIn("status", routes, f"round 2 re-sends the stored status: {routes}")
        self.assertIn("queue", routes, f"round 2 still reads the queue: {routes}")
        self.assertLess(routes.index("status"), routes.index("queue"), f"re-sent before the queue is read: {routes}")
        resent = [r for r in r2 if r["route"] == "status"]
        self.assertEqual({r["code"] for r in resent}, {self.CODE})
        self.assertEqual(_bodies(r2, "status"), [body], "re-sent once, with the body of the failed POST")

        start = _mark(h)
        h.assert_round_ok(h.run())
        self.assertEqual(_bodies(_since(h, start), "status"), [], "delivered: round 3 does not send it again")

    def _round2_answers(self, h: Harness, status: int) -> tuple[Any, list[dict[str, Any]]]:
        h.worker.fail("status", status)
        start = _mark(h)
        p2 = h.run()
        h.assert_round_ok(p2)
        del h.worker.always_fail["status"]
        r2 = _since(h, start)
        self.assertTrue(_bodies(r2, "status"), f"round 2 tried the stored status (answered {status})")
        start = _mark(h)
        h.assert_round_ok(h.run())
        return p2, _since(h, start)

    def test_finding2_pending_status_dropped_on_400(self) -> None:
        h = self._harness()
        self._round1_fails(h)
        p2, r3 = self._round2_answers(h, 400)
        self.assertEqual(_bodies(r3, "status"), [], "a 400 is final: the stored status is dropped")
        self.assertTrue([l for l in p2.stderr.splitlines() if l.startswith("lumina-bug-agent: ") and "dropped" in l],
                        f"the drop is logged:\n{p2.stderr}")

    def test_finding2_pending_status_kept_on_429(self) -> None:
        h = self._harness()
        body = self._round1_fails(h)
        _, r3 = self._round2_answers(h, 429)
        self.assertIn(body, _bodies(r3, "status"), "a 429 is not final: round 3 re-sends it")

    def test_finding2_pending_status_kept_on_408(self) -> None:
        h = self._harness()
        body = self._round1_fails(h)
        _, r3 = self._round2_answers(h, 408)
        self.assertIn(body, _bodies(r3, "status"), "a 408 is not final: round 3 re-sends it")

    def test_finding2_pending_status_is_not_sent_in_dry_run(self) -> None:
        h = self._harness()
        body = self._round1_fails(h)
        start = _mark(h)
        h.assert_round_ok(h.run(DRY_RUN="1"))
        posts = [f"{r['method']} {r['path']}" for r in _since(h, start) if r["method"] != "GET"]
        self.assertEqual(posts, [], "a dry round sends no POST, stored statuses included")
        start = _mark(h)
        h.assert_round_ok(h.run())
        self.assertEqual(_bodies(_since(h, start), "status"), [body], "the next real round re-sends it")

    def test_finding2_pr_url_status_survives_a_failed_post(self) -> None:
        code = "LUM-320002"
        h = Harness(self)
        h.worker.add_report(code)
        h.set_stage("stage_b", mode="json", object=dict(STAGE_B_SIMPLE_FIX))
        h.set_stage("builder", mode="json", object={"summary": "edited"},
                    writes={"src/Shared/Greeting.luau": GREETING_FIXED})
        h.worker.fail("status", 503)
        h.assert_round_ok(h.run())
        del h.worker.always_fail["status"]
        self.assertEqual(len(h.gh_calls()), 1, "scenario: stage C reached the PR")
        self.assertTrue([b for b in h.statuses(code) if b.get("prUrl") == PR_URL], "round 1 tried to post the PR URL")
        start = _mark(h)
        h.assert_round_ok(h.run())
        resent = _bodies(_since(h, start), "status")
        self.assertTrue([b for b in resent if b.get("prUrl") == PR_URL and b.get("status") == "looking"],
                        f"round 2 re-sends the PR link: {resent}")
        self.assertEqual(h.worker.reports[code].get("status"), "looking")
        self.assertEqual(len(h.gh_calls()), 1, "the PR is not opened twice")


# --------------------------------------------------------------------------------------------------------------
# 3. Duplicates on a fresh cache
# --------------------------------------------------------------------------------------------------------------


class EventsWorker(FakeWorker):
    """The shared fake worker plus an events log (CONTRACT.md `GET /agent/events`) and per-code report GET failures."""

    def __init__(self) -> None:
        super().__init__()
        self.events: list[dict[str, Any]] = []
        self.report_fails: set[str] = set()

    def add_event(self, code: str, type_: str, data: dict[str, Any] | None = None) -> None:
        self.events.append({"seq": len(self.events) + 1, "code": code, "at": 1_762_400_500_000 + len(self.events),
                            "type": type_, "data": data or {}})

    def _send(self, h: http.server.BaseHTTPRequestHandler, status: int, payload: Any, ctype: str = "application/json") -> None:
        parsed = urllib.parse.urlsplit(h.path)
        if h.command == "GET" and status == 200:
            if parsed.path == "/api/v1/agent/events":
                q = dict(urllib.parse.parse_qsl(parsed.query))
                after = int(q.get("after") or 0)
                limit = min(int(q.get("limit") or 100), 500)
                page = [e for e in self.events if e["seq"] > after][:limit]
                payload = {"events": page, "last": page[-1]["seq"] if page else after}
            m = re.match(r"^/api/v1/agent/reports/([^/]+)$", parsed.path)
            if m and m.group(1) in self.report_fails:
                return super()._send(h, 500, {"error": "internal"})
        return super()._send(h, status, payload, ctype)


OLD_WHAT = "Old report player text zq7 the crate opens twice when I tap fast"
OLD_SUMMARY = "Crate open handler runs twice on double tap"
# 200 characters, then a marker the next column of a SQLite record will not start with.
OLD_TITLE = ("Crate opens twice ok " * 10)[:200] + "~" * 50


def _events_harness(test: unittest.TestCase) -> tuple[Harness, EventsWorker]:
    h = Harness(test, worker_port=None)
    w = EventsWorker()
    test.addCleanup(w.stop)
    h.worker = w
    return h, w


def _old_report(w: EventsWorker, code: str, summary: str = OLD_SUMMARY) -> None:
    row = w.add_report(code, what=OLD_WHAT, title=OLD_TITLE)
    row["status"] = "looking"
    row["verdict"] = "needs_person"
    # The real worker returns `triage` parsed (worker/src/routes/agent.ts `report`), the agent's own triage body.
    row["triage"] = {"stage_a": None, "stage_b": dict(STAGE_B_SIMPLE_FIX, verdict="needs_person", summary=summary),
                     "files": [], "notes": [], "agent": "lumina-bug-agent/1"}


def _cache_bytes(h: Harness) -> bytes:
    return b"".join(p.read_bytes() for p in sorted(h.state_dir.glob("cache.sqlite3*")) if p.is_file())


class Finding3DuplicatesOnAFreshCache(unittest.TestCase):
    """Con una cache nuova, i report già esistenti visti negli eventi entrano nella lista dei duplicati."""

    OLD = "LUM-330001"
    NEW = "LUM-330002"

    def _seeded(self, event_type: str) -> tuple[Harness, EventsWorker]:
        h, w = _events_harness(self)
        _old_report(w, self.OLD)
        w.add_report(self.NEW, what="The crate opens two times")
        w.add_event(self.OLD, event_type, {"verdict": "needs_person"} if event_type == "triaged" else {})
        self.assertFalse(h.state_dir.exists(), "fresh STATE_DIR: the cache knows no report")
        p = h.run()
        h.assert_round_ok(p)
        self.assertTrue(w.calls("events"), "the round reads the events")
        return h, w

    def _assert_seeded(self, h: Harness, w: EventsWorker) -> str:
        self.assertEqual(len(w.calls("report", self.OLD)), 1, "the agent GETs the report it learned of from events")
        stage_b = h.claude_calls("stage_b")
        self.assertEqual(len(stage_b), 1, "stage B ran for the queued report")
        stdin = stage_b[0]["stdin"]
        self.assertIn(self.OLD, stdin, "the old code is in stage B's duplicate list")
        self.assertIn(OLD_SUMMARY, stdin, "with the stage B summary read from the fetched report")
        self.assertNotIn(OLD_WHAT, stdin, "the old report's player text is not given to stage B")
        h.assert_nothing_left()
        return stdin

    def test_finding3_triaged_event_for_an_unknown_code_seeds_the_duplicate_list(self) -> None:
        h, w = self._seeded("triaged")
        stdin = self._assert_seeded(h, w)
        self.assertNotIn(OLD_TITLE[:201], stdin, "the title reaches stage B at most 200 characters long")
        cache = _cache_bytes(h)
        self.assertTrue(cache, "the cache file exists after the round")
        self.assertNotIn(OLD_WHAT.encode(), cache, "the player's text never enters the cache")
        self.assertIn(OLD_SUMMARY.encode(), cache, "the fetched report's summary is cached")
        self.assertIn(OLD_TITLE[:200].encode(), cache, "the title is cached, up to 200 characters")
        self.assertNotIn(OLD_TITLE[:201].encode(), cache, "and not beyond 200 characters")

    def test_finding3_created_event_for_an_unknown_code_seeds_the_duplicate_list(self) -> None:
        h, w = self._seeded("created")
        self._assert_seeded(h, w)

    def test_finding3_at_most_50_report_fetches_a_round(self) -> None:
        h, w = _events_harness(self)
        olds = [f"LUM-34{n:04d}" for n in range(60)]
        for code in olds:
            _old_report(w, code, summary=f"Summary of {code}")
            w.add_event(code, "triaged", {"verdict": "needs_person"})
        w.add_report(self.NEW)
        h.assert_round_ok(h.run())
        fetched = [r for r in w.calls("report") if r["code"] in set(olds)]
        self.assertGreaterEqual(len(fetched), 1, "unknown codes from events are fetched")
        self.assertLessEqual(len(fetched), 50, f"at most 50 report GETs for event codes a round, got {len(fetched)}")
        self.assertEqual(len(h.triages(self.NEW)), 1, "the queued report is still triaged")

    def test_finding3_failed_fetch_is_not_fatal(self) -> None:
        h, w = _events_harness(self)
        _old_report(w, self.OLD)
        w.add_report(self.NEW)
        w.add_event(self.OLD, "triaged", {"verdict": "needs_person"})
        w.report_fails.add(self.OLD)
        p = h.run()
        h.assert_round_ok(p)
        self.assertTrue(w.calls("report", self.OLD), "the agent tried to GET the unknown report")
        self.assertEqual(len(h.triages(self.NEW)), 1, "a failed fetch does not stop the round")
        h.assert_nothing_left()


# --------------------------------------------------------------------------------------------------------------
# 4. Contact sheets always carry time stamps
# --------------------------------------------------------------------------------------------------------------

# An ffmpeg that refuses every call drawing text (drawtext unusable: no font, a broken build) and runs the real one
# otherwise. It records like the shared media shim, so media_calls() still sees every call.
_NO_DRAWTEXT_FFMPEG = r'''
argv = sys.argv[1:]
draws = any("drawtext" in a for a in argv)
_record(LOGDIR, {"tool": "ffmpeg", "argv": argv, "files": [], "refused": draws})
if draws:
    sys.stderr.write("[Parsed_drawtext_0] Cannot find a valid font\n")
    sys.exit(1)
os.execv(REAL, [REAL] + argv)
'''


class Finding4TimestampsOnEverySheet(unittest.TestCase):
    """Ogni foglio di fotogrammi ha il tempo scritto; senza il tempo il file è saltato `ffmpeg_failed`."""

    CODE = "LUM-340001"

    def test_finding4_drawtext_failure_skips_the_file_as_ffmpeg_failed(self) -> None:
        h = Harness(self)
        h.worker.add_report(self.CODE, attachments=[mp4_attachment("att-stamp")])
        consts = f"SCENARIO = {str(h.scenario_path)!r}\nLOGDIR = {str(h.logs / 'media')!r}\nREAL = {REAL_FFMPEG!r}\n"
        _write_exec(h.bin / "ffmpeg", f"#!{PYTHON}\n" + consts, _NO_DRAWTEXT_FFMPEG)
        p = h.run()
        h.assert_round_ok(p)
        refused = [c for c in h.media_calls("ffmpeg") if c.get("refused")]
        self.assertTrue(refused, "the agent tried to draw the time stamps")
        self.assertEqual(h.worker.calls("frames"), [], "no sheet is uploaded without time stamps")
        triage = h.one_triage(self.CODE)
        entry = file_entry(triage, "att-stamp")
        self.assertIsNotNone(entry, f"triage.files names the attachment: {triage.get('triage')}")
        assert entry is not None
        self.assertEqual(entry.get("status"), "skipped", f"files entry: {entry}")
        self.assertEqual(entry.get("reason"), "ffmpeg_failed", f"files entry: {entry}")
        calls = h.claude_calls("stage_a")
        self.assertEqual(len(calls), 1, "the report goes on with its text")
        self.assertEqual(stage_a_payload(calls[0])[1], [], "stage A gets no sheet without time stamps")
        h.assert_nothing_left()

    @unittest.skipIf(os.path.exists(FREESANS), f"{FREESANS} exists here and cannot be hidden from the agent: the path "
                     "is hard-coded in media.py and unprivileged mount namespaces are off on this machine "
                     "(kernel.apparmor_restrict_unprivileged_userns = 1); runs on a machine without the font")
    def test_finding4_missing_font_file_falls_back_to_fontconfig_sans(self) -> None:
        h = Harness(self)
        h.worker.add_report(self.CODE, attachments=[mp4_attachment("att-sans")])
        h.assert_round_ok(h.run())
        draws = [c for c in h.media_calls("ffmpeg") if any("drawtext" in a for a in c["argv"])]
        self.assertTrue(draws, "the time stamps are still drawn without the font file")
        self.assertTrue(all(re.search(r"font='?Sans", " ".join(c["argv"])) for c in draws),
                        "drawtext uses fontconfig `font=Sans`")
        self.assertTrue(h.worker.calls("frames", self.CODE), "the stamped sheets are uploaded")
        h.assert_nothing_left()


# --------------------------------------------------------------------------------------------------------------
# 5. Branch left when the stage C worktree creation fails
# --------------------------------------------------------------------------------------------------------------

# Stage B's detached worktree is made as the shared fake does. Stage C's (`--branch`) is made as the scenario says,
# then the script exits 1, as git-workspace.py does when a step after `git worktree add -b` fails.
_FAILING_GIT_WORKSPACE = r'''
argv = sys.argv[1:]
rest = list(argv[1:])
branch = None
if "--branch" in rest:
    i = rest.index("--branch")
    branch = rest[i + 1]
    del rest[i:i + 2]
repo, dst, ref = rest
os.makedirs(os.path.dirname(dst), exist_ok=True)
if branch is None:
    _record(LOGDIR, {"argv": argv})
    sys.exit(subprocess.call(["git", "-C", repo, "worktree", "add", "--detach", "--", dst, ref],
                             stdout=subprocess.DEVNULL))
mode = _scenario()["gw_branch_mode"]
if mode == "worktree_then_fail":
    rc = subprocess.call(["git", "-C", repo, "worktree", "add", "-b", branch, "--", dst, ref], stdout=subprocess.DEVNULL)
else:
    rc = subprocess.call(["git", "-C", repo, "branch", branch, ref], stdout=subprocess.DEVNULL)
heads = subprocess.run(["git", "-C", repo, "branch", "--list", "--format=%(refname:short)", "bugfix/*"],
                       capture_output=True, text=True).stdout.split()
_record(LOGDIR, {"argv": argv, "rc": rc, "heads_after": heads, "dst_exists": os.path.isdir(dst)})
sys.stderr.write("git-workspace: placement check failed\n")
sys.exit(1)
'''


class Finding5BranchLeftByAFailedWorktree(unittest.TestCase):
    """Se la creazione della worktree della correzione fallisce, non resta né il ramo bugfix né la worktree."""

    def _run(self, code: str, mode: str) -> Harness:
        h = Harness(self)
        h.worker.add_report(code)
        h.set_stage("stage_a", mode="json", object=dict(VALID_STAGE_A))
        h.set_stage("stage_b", mode="json", object=dict(STAGE_B_SIMPLE_FIX))
        h.scenario["gw_branch_mode"] = mode
        h.save_scenario()
        consts = f"SCENARIO = {str(h.scenario_path)!r}\nLOGDIR = {str(h.logs / 'gw')!r}\n"
        _write_exec(h.git_workspace, f"#!{PYTHON}\n" + consts, _FAILING_GIT_WORKSPACE)
        h.assert_round_ok(h.run())
        return h

    def _assert_cleaned(self, h: Harness, code: str, worktree_made: bool) -> None:
        branch = "bugfix/" + code.lower()
        made = [c for c in h.gw_calls() if "--branch" in c["argv"]]
        self.assertEqual(len(made), 1, "stage C asked git-workspace for its branch worktree once")
        self.assertEqual(made[0]["rc"], 0, "scenario: the branch was really created")
        self.assertIn(branch, made[0]["heads_after"], "scenario: the branch existed when git-workspace failed")
        self.assertEqual(made[0]["dst_exists"], worktree_made, "scenario: worktree directory as intended")
        self.assertEqual(h.claude_calls("builder"), [], "no builder without a worktree")
        self.assertEqual(h.local_branches(), [], f"local {branch} deleted")
        self.assertEqual(h.fork_branches(), ["main"], "nothing pushed")
        self.assertEqual(h.gh_calls(), [], "no gh call")
        h.assert_nothing_left()
        notes = h.notes(code)
        self.assertTrue([n for n in notes if re.match(r"^needs_person: \S+", n)], f"a needs_person reason is noted: {notes}")
        self.assertTrue(all(b.get("status") == "looking" for b in h.statuses(code)), "the report stays looking")

    def test_finding5_worktree_created_then_git_workspace_fails(self) -> None:
        code = "LUM-350001"
        h = self._run(code, "worktree_then_fail")
        self._assert_cleaned(h, code, worktree_made=True)

    def test_finding5_branch_created_then_git_workspace_fails_before_the_worktree(self) -> None:
        code = "LUM-350002"
        h = self._run(code, "branch_then_fail")
        self._assert_cleaned(h, code, worktree_made=False)


if __name__ == "__main__":
    unittest.main()
