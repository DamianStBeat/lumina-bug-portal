"""Acceptance rows 1 and 2 (one round over a real mp4; a fake video that is an executable) and the media limits."""

from __future__ import annotations

import json
import re
import shutil
import unittest

from helpers import (
    AGENT_KEY,
    VALID_VERDICTS,
    Harness,
    file_entry,
    media_width,
    mp4_attachment,
    png_bytes,
    stage_a_payload,
    video_bytes,
)

PLAYER_TEXT = "Zebra-violet-17: the shop button stays grey after the second wave"


class Row01OneRoundWithVideo(unittest.TestCase):
    """Riga 1: coda con un report e un video mp4 di prova → claim, download, fogli caricati, triage, niente resti."""

    @classmethod
    def setUpClass(cls) -> None:
        # One round, read by several specs.
        cls.h = Harness(cls)
        cls.code = "LUM-482193"
        cls.h.worker.add_report(cls.code, what=PLAYER_TEXT, attachments=[mp4_attachment("att-mp4")])
        cls.p = cls.h.run()

    def test_row01_round_exits_cleanly(self) -> None:
        self.h.assert_round_ok(self.p)

    def test_row01_claims_downloads_uploads_frames_and_triages(self) -> None:
        self.h.assert_round_ok(self.p)
        w = self.h.worker
        claims = w.json_bodies("claim", self.code)
        self.assertEqual(len(claims), 1, "one claim POST for the report")
        self.assertIsInstance(claims[0].get("by"), str, "claim body carries `by`")
        self.assertLessEqual(int(claims[0].get("minutes", 999)), 60, "claim minutes must be <= 60")
        downloads = w.calls("download")
        self.assertEqual([r["attachment"] for r in downloads], ["att-mp4"], "the mp4 is downloaded once")
        frames = w.calls("frames", self.code)
        self.assertGreaterEqual(len(frames), 1, "at least one contact sheet must be uploaded")
        for r in frames:
            self.assertEqual(r["body"][:2], b"\xff\xd8", "every frames POST body is a JPEG (FF D8)")
            self.assertLessEqual(len(r["body"]), 10 * 1024 * 1024, "a sheet is at most 10 MB")
            self.assertEqual(r["headers"].get("content-type"), "image/jpeg")
            self.assertRegex(r["headers"].get("x-filename", ""), r"^frames-att-mp4-\d+\.jpg$",
                             "X-Filename names the attachment, never the player's filename")
        triage = self.h.one_triage(self.code)
        self.assertIn(triage.get("verdict"), VALID_VERDICTS)
        # Stage B said needs_person; the agent forwards its verdict, it does not invent one.
        self.assertEqual(triage["verdict"], "needs_person")
        self.assertEqual(triage["triage"]["stage_b"]["verdict"], "needs_person")
        self.assertLessEqual(len(json.dumps(triage["triage"]).encode()), 32 * 1024, "triage JSON <= 32 KB")
        order = [r["route"] for r in w.calls() if r["code"] == self.code or r["route"] == "download"]
        self.assertLess(order.index("claim"), order.index("download"), "claim comes before the download")
        self.assertLess(max(i for i, x in enumerate(order) if x == "frames"), order.index("triage"),
                        "frames are uploaded before the triage")

    def test_row01_stage_a_gets_the_contact_sheets(self) -> None:
        self.h.assert_round_ok(self.p)
        calls = self.h.claude_calls("stage_a")
        self.assertEqual(len(calls), 1, "one stage A call")
        _, images = stage_a_payload(calls[0])
        self.assertGreaterEqual(len(images), 1, "stage A receives the contact sheets as image blocks")
        self.assertTrue(all(data[:2] == b"\xff\xd8" for _, data in images), "sheets go to stage A as JPEG")

    def test_row01_nothing_left_behind(self) -> None:
        self.h.assert_round_ok(self.p)
        self.assertEqual(len(self.h.gw_calls()), 1, "stage B used one worktree (so the cleanup check is not vacuous)")
        self.h.assert_nothing_left()
        self.assertEqual(self.h.local_branches("*"), ["main"], "no extra local branch after a triage-only round")

    def test_row01_every_request_carries_the_bearer_and_logs_hold_no_player_text(self) -> None:
        self.h.assert_round_ok(self.p)
        reqs = self.h.worker.calls()
        self.assertTrue(reqs)
        for r in reqs:
            self.assertEqual(r["headers"].get("authorization"), f"Bearer {AGENT_KEY}", f"{r['method']} {r['path']}")
        self.assertNotIn(PLAYER_TEXT, self.p.stderr, "logs never contain the player's text")
        self.assertNotIn(AGENT_KEY, self.p.stderr + self.p.stdout, "logs never contain AGENT_KEY")


class Row02ExecutableDeclaredAsVideo(unittest.TestCase):
    """Riga 2: file dichiarato video ma è un eseguibile → saltato e annotato, nessun ffmpeg su quel file."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.h = Harness(cls)
        cls.code = "LUM-100200"
        with open(shutil.which("true") or "/bin/true", "rb") as f:
            cls.exe = f.read()
        # A real mp4 rides along so the shims provably record ffmpeg/ffprobe calls (the check is not vacuous).
        cls.h.worker.add_report(cls.code, attachments=[
            {"id": "att-exe", "kind": "video", "mime": "video/mp4", "filename": "clip.mp4", "data": cls.exe},
            mp4_attachment("att-mp4"),
        ])
        cls.p = cls.h.run()

    def test_row02_executable_is_skipped_as_not_media(self) -> None:
        self.h.assert_round_ok(self.p)
        entry = file_entry(self.h.one_triage(self.code), "att-exe")
        self.assertIsNotNone(entry, "triage.files must list the executable attachment")
        self.assertEqual(entry.get("status"), "skipped")
        self.assertEqual(entry.get("reason"), "not_media")

    def test_row02_no_ffmpeg_or_ffprobe_touches_the_executable(self) -> None:
        self.h.assert_round_ok(self.p)
        import hashlib

        exe_sha = hashlib.sha256(self.exe).hexdigest()
        mp4_sha = hashlib.sha256(video_bytes()).hexdigest()
        calls = self.h.media_calls()
        seen = {f["sha256"] for c in calls for f in c["files"]}
        self.assertIn(mp4_sha, seen, "the real mp4 went through the ffmpeg/ffprobe shims (FFMPEG_BIN/FFPROBE_BIN)")
        self.assertNotIn(exe_sha, seen, "no ffmpeg/ffprobe argv may name the executable")

    def test_row02_the_report_still_goes_on_with_the_good_file(self) -> None:
        self.h.assert_round_ok(self.p)
        self.assertGreaterEqual(len(self.h.worker.calls("frames", self.code)), 1)
        self.h.assert_nothing_left()


class MediaLimits(unittest.TestCase):
    """Edges of row 2's checks: size, duration, frame cap, images, uploads not complete, download errors."""

    def test_row02_declared_size_over_2gib_is_refused_before_download(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100201", attachments=[mp4_attachment("att-big", size_bytes=2 * 1024**3 + 1)])
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(h.worker.calls("download"), [], "a file declared over 2 GiB is never downloaded")
        entry = file_entry(h.one_triage("LUM-100201"), "att-big")
        self.assertEqual((entry or {}).get("reason"), "too_large", f"files entry: {entry}")

    def test_row02_attachment_still_uploading_is_not_downloaded(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100202", attachments=[mp4_attachment("att-up", status="uploading")])
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(h.worker.calls("download"), [], "only `complete` attachments are downloaded")
        self.assertEqual(len(h.triages("LUM-100202")), 1, "the report is still triaged from its text")

    def test_row02_video_longer_than_30_minutes_is_too_long(self) -> None:
        h = Harness(self)
        long_video = video_bytes(duration=1810, size="32x32", rate=1)
        h.worker.add_report("LUM-100203", attachments=[mp4_attachment("att-long", data=long_video)])
        p = h.run()
        h.assert_round_ok(p)
        entry = file_entry(h.one_triage("LUM-100203"), "att-long")
        self.assertEqual((entry or {}).get("status"), "skipped", f"files entry: {entry}")
        self.assertEqual((entry or {}).get("reason"), "too_long")
        self.assertEqual(h.worker.calls("frames"), [], "no sheet from a video over 30 minutes")

    def test_row01_video_under_30_minutes_gets_at_most_48_frames(self) -> None:
        h = Harness(self)
        video = video_bytes(duration=1790, size="32x32", rate=1)
        h.worker.add_report("LUM-100204", attachments=[mp4_attachment("att-1790", data=video)])
        p = h.run()
        h.assert_round_ok(p)
        sheets = h.worker.calls("frames", "LUM-100204")
        # 48 frames tiled 4x3 make at most 4 sheets; a 1790 s video has ~900 two-second samples, so the cap bites.
        self.assertGreaterEqual(len(sheets), 1, "a video just under 30 minutes is processed")
        self.assertLessEqual(len(sheets), 4, "at most 48 frames, 12 per sheet")
        entry = file_entry(h.one_triage("LUM-100204"), "att-1790")
        self.assertNotEqual((entry or {}).get("status"), "skipped", f"files entry: {entry}")

    def test_row01_image_goes_to_stage_a_scaled_and_is_not_uploaded(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100205", attachments=[
            {"id": "att-png", "kind": "image", "mime": "image/png", "filename": "shot.png", "data": png_bytes("2000x200")},
        ])
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(h.worker.calls("frames"), [], "images are given to stage A, not uploaded as frames")
        calls = h.claude_calls("stage_a")
        self.assertEqual(len(calls), 1)
        _, images = stage_a_payload(calls[0])
        self.assertGreaterEqual(len(images), 1, "the image reaches stage A")
        for _, data in images:
            self.assertLessEqual(media_width(data), 1280, "images are scaled to at most 1280 px wide")

    def test_row01_audio_is_never_extracted(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100206", attachments=[mp4_attachment("att-audio", data=video_bytes(audio=True))])
        p = h.run()
        h.assert_round_ok(p)
        runs = h.media_calls("ffmpeg")
        self.assertGreaterEqual(len(runs), 1, "ffmpeg ran on the video (through FFMPEG_BIN)")
        for r in runs:
            argv = r["argv"]
            self.assertIn("-an", argv, f"every ffmpeg call drops audio: {argv}")
            self.assertNotIn("-vn", argv, f"no ffmpeg call keeps only audio: {argv}")
            maps = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "-map"]
            self.assertFalse([m for m in maps if re.search(r":a\b|^a$|:a:", m)], f"no audio stream mapped: {argv}")
        self.assertGreaterEqual(len(h.worker.calls("frames")), 1)

    def test_row08_download_error_is_noted_and_the_report_goes_on(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100207", attachments=[mp4_attachment("att-err")])
        h.worker.fail("download", 500)
        p = h.run()
        h.assert_round_ok(p)
        entry = file_entry(h.one_triage("LUM-100207"), "att-err")
        self.assertEqual((entry or {}).get("reason"), "download_failed", f"files entry: {entry}")
        h.assert_nothing_left()


if __name__ == "__main__":
    unittest.main()
