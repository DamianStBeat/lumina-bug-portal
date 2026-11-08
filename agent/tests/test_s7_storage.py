"""Slice 7, the agent side of CONTRACT.md "Supabase deployment": the JSON manifest, the parts from storage, and the
retention fallback. Every spec runs the real agent; what it proves is read off the requests that reached the fakes, the
sha256 of the file ffprobe was given, and the triage's `files` entry.

Run by filter: `cd agent && python3 -m unittest discover -s tests -k test_s7`.
"""

from __future__ import annotations

import hashlib
import os
import unittest
from typing import Any

from helpers import AGENT_KEY, Harness, file_entry, mp4_attachment, png_bytes, video_bytes

MAX_BYTES = 2 * 1024**3


def three_part_report(h: Harness, code: str, att: str = "att-3p") -> bytes:
    data = video_bytes()
    h.worker.add_report(code, attachments=[mp4_attachment(att, data=data, parts=3)])
    return data


def entry_of(h: Harness, code: str, att: str) -> dict[str, Any]:
    entry = file_entry(h.one_triage(code), att)
    assert entry is not None, f"triage.files names {att}"
    return entry


def assert_probed(h: Harness, case: unittest.TestCase, data: bytes) -> None:
    """The file handed to ffprobe is, byte for byte, the original."""
    probes = h.media_calls("ffprobe")
    case.assertTrue(probes, "the joined file reached ffprobe")
    case.assertEqual(probes[0]["files"][0]["sha256"], hashlib.sha256(data).hexdigest(),
                     "the parts are joined in order, whole")  # fmt: skip


def assert_download_failed(h: Harness, case: unittest.TestCase, code: str, att: str) -> None:
    entry = entry_of(h, code, att)
    case.assertEqual(entry.get("status"), "skipped", f"files entry: {entry}")
    case.assertEqual(entry.get("reason"), "download_failed", f"files entry: {entry}")
    case.assertEqual(h.media_calls(), [], "a file that failed its checks is never given to ffprobe or ffmpeg")
    case.assertEqual(h.worker.calls("frames"), [], "no frames from it")
    case.assertEqual(len(h.claude_calls("stage_a")), 1, "the report still goes on with its text")
    h.assert_nothing_left()


class S7Row2ThreeParts(unittest.TestCase):
    """Riga 2: l'agente scarica un video in 3 parti → file unito nell'ordine giusto e della dimensione dichiarata."""

    def test_s7_row2_three_parts_are_joined_in_order_and_the_file_is_processed(self) -> None:
        h = Harness(self)
        data = three_part_report(h, "LUM-710001")
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual([r["attachment"] for r in h.worker.calls("download")], ["att-3p"], "one manifest")
        self.assertEqual(h.worker.storage.parts_asked("att-3p"), [1, 2, 3], "each part once, ascending")
        assert_probed(h, self, data)
        self.assertEqual(entry_of(h, "LUM-710001", "att-3p").get("status"), "ok")
        self.assertGreaterEqual(len(h.worker.calls("frames", "LUM-710001")), 1, "contact sheets from the joined file")
        h.assert_nothing_left()

    def test_s7_row2_a_single_part_image_is_downloaded_from_storage_too(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-710002", attachments=[
            {"id": "att-png", "kind": "image", "mime": "image/png", "filename": "shot.png", "data": png_bytes("400x200")},
        ])  # fmt: skip
        h.assert_round_ok(h.run())
        self.assertEqual(h.worker.storage.parts_asked("att-png"), [1])
        self.assertEqual(entry_of(h, "LUM-710002", "att-png").get("kind"), "image")

    def test_s7_row2_a_manifest_out_of_order_is_joined_by_n_or_refused_never_scrambled(self) -> None:
        h = Harness(self)
        data = three_part_report(h, "LUM-710003")
        h.worker.manifest_edit["att-3p"] = lambda m: {**m, "parts": list(reversed(m["parts"]))}
        h.assert_round_ok(h.run())
        entry = entry_of(h, "LUM-710003", "att-3p")
        if entry.get("status") == "skipped":
            self.assertEqual(entry.get("reason"), "download_failed", f"files entry: {entry}")
            self.assertEqual(h.media_calls(), [], "a refused manifest reaches no ffprobe")
        else:
            assert_probed(h, self, data)

    def test_s7_row2_no_key_on_storage_requests(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710004")
        h.assert_round_ok(h.run())
        seen = h.worker.storage.calls()
        self.assertEqual(len(seen), 3, "the bucket was reached")
        for r in seen:
            self.assertNotIn("authorization", r["headers"], "no bearer on a signed URL")
            self.assertNotIn(AGENT_KEY, " ".join(r["headers"].values()) + " " + r["path"] + r["token"],
                             "the agent key is nowhere in a storage request")  # fmt: skip

    def test_s7_row2_a_short_part_is_an_error(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710005")
        files = h.worker.storage.files["att-3p"]
        h.worker.storage.answer("att-3p", 2, body=files[1][:-1])  # one byte fewer, honest Content-Length
        h.assert_round_ok(h.run())
        assert_download_failed(h, self, "LUM-710005", "att-3p")

    def test_s7_row2_a_long_part_is_an_error(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710006")
        files = h.worker.storage.files["att-3p"]
        h.worker.storage.answer("att-3p", 2, body=files[1] + b"\0")
        h.assert_round_ok(h.run())
        assert_download_failed(h, self, "LUM-710006", "att-3p")

    def test_s7_row2_a_part_cut_off_mid_transfer_is_an_error(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710007")
        h.worker.storage.answer("att-3p", 3, cut_short=True)
        h.assert_round_ok(h.run())
        assert_download_failed(h, self, "LUM-710007", "att-3p")

    def test_s7_row2_parts_not_adding_up_to_the_declared_size_are_an_error(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710008")
        h.worker.manifest_edit["att-3p"] = lambda m: {**m, "sizeBytes": m["sizeBytes"] + 1}
        h.assert_round_ok(h.run())
        assert_download_failed(h, self, "LUM-710008", "att-3p")

    def test_s7_row2_a_manifest_that_answers_not_available_is_noted(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710009")
        h.worker.manifest_status["att-3p"] = (409, "not_available")
        h.assert_round_ok(h.run())
        self.assertEqual(h.worker.storage.calls(), [], "nothing to fetch")
        assert_download_failed(h, self, "LUM-710009", "att-3p")

    def test_s7_row2_a_manifest_that_is_broken_is_noted_without_a_crash(self) -> None:
        def no_key(key: str) -> Any:
            return lambda m: {k: v for k, v in m.items() if k != key}

        def part_field(key: str, value: Any = None, drop: bool = False) -> Any:
            def edit(m: dict[str, Any]) -> dict[str, Any]:
                part = dict(m["parts"][0])
                if drop:
                    del part[key]
                else:
                    part[key] = value
                return {**m, "parts": [part, *m["parts"][1:]]}
            return edit

        def renumber(numbers: list[int]) -> Any:
            def edit(m: dict[str, Any]) -> dict[str, Any]:
                return {**m, "parts": [{**p, "n": n} for p, n in zip(m["parts"], numbers, strict=True)]}
            return edit

        cases: list[tuple[str, Any]] = [
            ("not json", b"<html>gateway</html>"),
            ("no parts", no_key("parts")),
            ("parts not a list", lambda m: {**m, "parts": "all of them"}),
            ("empty parts", lambda m: {**m, "parts": []}),
            ("no sizeBytes", no_key("sizeBytes")),
            ("sizeBytes not a number", lambda m: {**m, "sizeBytes": "90"}),
            ("part without url", part_field("url", drop=True)),
            ("part url not a string", part_field("url", 7)),
            ("part without size", part_field("size", drop=True)),
            ("part size not a number", part_field("size", "90")),
            ("part without n", part_field("n", drop=True)),
            ("n repeated", renumber([1, 1, 2])),
            ("n with a gap", renumber([1, 2, 4])),
        ]
        for label, edit in cases:
            with self.subTest(label):
                h = Harness(self)
                code = "LUM-710010"
                three_part_report(h, code)
                h.worker.manifest_edit["att-3p"] = edit
                p = h.run()
                h.assert_round_ok(p)
                assert_download_failed(h, self, code, "att-3p")

    def test_s7_row2_a_local_file_url_is_refused_even_at_the_declared_size(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710013")
        # The local file holds the very bytes of the part it replaces: only the URL's scheme can refuse it. With a wrong
        # size the per-part check would fail it first and hide a missing scheme check.
        local = h.root / "not-the-bucket.bin"
        local.write_bytes(h.worker.storage.files["att-3p"][1])

        def edit(m: dict[str, Any]) -> dict[str, Any]:
            return {**m, "parts": [m["parts"][0], {**m["parts"][1], "url": local.as_uri()}, m["parts"][2]]}

        h.worker.manifest_edit["att-3p"] = edit
        h.assert_round_ok(h.run())
        assert_download_failed(h, self, "LUM-710013", "att-3p")

    def test_s7_row2_declared_over_the_cap_is_refused_before_any_part_is_fetched(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710011")

        def edit(m: dict[str, Any]) -> dict[str, Any]:
            first = {**m["parts"][0], "size": MAX_BYTES + 1 - sum(p["size"] for p in m["parts"][1:])}
            return {**m, "sizeBytes": MAX_BYTES + 1, "parts": [first, *m["parts"][1:]]}

        h.worker.manifest_edit["att-3p"] = edit
        h.assert_round_ok(h.run())
        entry = entry_of(h, "LUM-710011", "att-3p")
        self.assertEqual(entry.get("reason"), "too_large", f"files entry: {entry}")
        self.assertEqual(h.worker.storage.calls(), [], "nothing is fetched of a file already known to be too large")
        self.assertEqual(h.media_calls(), [])

    def test_s7_row2_declared_exactly_at_the_cap_is_not_too_large(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-710012")

        def edit(m: dict[str, Any]) -> dict[str, Any]:
            first = {**m["parts"][0], "size": MAX_BYTES - sum(p["size"] for p in m["parts"][1:])}
            return {**m, "sizeBytes": MAX_BYTES, "parts": [first, *m["parts"][1:]]}

        h.worker.manifest_edit["att-3p"] = edit
        h.assert_round_ok(h.run())
        entry = entry_of(h, "LUM-710012", "att-3p")
        # The cap is inclusive; the real parts are far shorter than this manifest says, so its check fails instead.
        self.assertNotEqual(entry.get("reason"), "too_large", f"files entry: {entry}")
        self.assertEqual(entry.get("reason"), "download_failed", f"files entry: {entry}")


class S7Row3UrlExpired(unittest.TestCase):
    """Riga 3: URL scaduto durante il download → 403 dallo storage → nuovo manifesto una volta, poi riprende."""

    def test_s7_row3_a_403_gets_one_new_manifest_and_the_download_resumes(self) -> None:
        h = Harness(self)
        data = three_part_report(h, "LUM-720001")
        h.worker.storage.expire("att-3p", 2)
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(len(h.worker.calls("download")), 2, "exactly one new manifest")
        self.assertEqual(h.worker.storage.parts_asked("att-3p"), [1, 2, 2, 3],
                         "it resumes from the expired part; a part already good is not fetched again")  # fmt: skip
        tokens = [r["token"] for r in h.worker.storage.calls("att-3p") if r["n"] == 2]
        self.assertNotEqual(tokens[0], tokens[1], "the second try is on the new manifest's URL")
        assert_probed(h, self, data)
        self.assertEqual(entry_of(h, "LUM-720001", "att-3p").get("status"), "ok")
        h.assert_nothing_left()

    def test_s7_row3_expiry_on_the_first_part(self) -> None:
        h = Harness(self)
        data = three_part_report(h, "LUM-720002")
        h.worker.storage.expire("att-3p", 1)
        h.assert_round_ok(h.run())
        self.assertEqual(len(h.worker.calls("download")), 2)
        assert_probed(h, self, data)

    def test_s7_row3_a_second_expiry_after_the_new_manifest_is_a_failed_download(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-720003")
        h.worker.storage.expire("att-3p", 2, manifest=1)
        h.worker.storage.expire("att-3p", 3, manifest=2)
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(len(h.worker.calls("download")), 2, "one new manifest, never a third")
        assert_download_failed(h, self, "LUM-720003", "att-3p")

    def test_s7_row3_the_same_expiry_twice_stops_after_one_new_manifest(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-720004")
        h.worker.storage.expire("att-3p", 2, manifest=1)
        h.worker.storage.expire("att-3p", 2, manifest=2)
        h.assert_round_ok(h.run())
        self.assertEqual(len(h.worker.calls("download")), 2, "one new manifest, never a third")
        assert_download_failed(h, self, "LUM-720004", "att-3p")

    def test_s7_row3_a_storage_server_error_is_not_an_expiry(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-720005")
        h.worker.storage.answer("att-3p", 2, status=500, body=b'{"error":"internal"}')
        h.assert_round_ok(h.run())
        self.assertEqual(len(h.worker.calls("download")), 1, "a 500 asks for no new manifest")
        assert_download_failed(h, self, "LUM-720005", "att-3p")

    def test_s7_row3_a_400_or_401_counts_as_an_expired_url_too(self) -> None:
        # Hosted Supabase may send an expired URL as HTTP 400 with `statusCode: "403"` in the body.
        expired = b'{"statusCode":"403","error":"Unauthorized","message":"exp claim timestamp check failed"}'
        for status in (400, 401):
            with self.subTest(status):
                h = Harness(self)
                data = three_part_report(h, "LUM-720008")
                h.worker.storage.answer("att-3p", 2, status=status, body=expired)
                h.assert_round_ok(h.run())
                self.assertEqual(len(h.worker.calls("download")), 2, "exactly one new manifest")
                self.assertEqual(h.worker.storage.parts_asked("att-3p"), [1, 2, 2, 3], "it resumes from the refused part")
                tokens = [r["token"] for r in h.worker.storage.calls("att-3p") if r["n"] == 2]
                self.assertNotEqual(tokens[0], tokens[1], "the second try is on the new manifest's URL")
                assert_probed(h, self, data)
                self.assertEqual(entry_of(h, "LUM-720008", "att-3p").get("status"), "ok")

    def test_s7_row3_a_404_is_not_an_expiry(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-720009")
        h.worker.storage.answer("att-3p", 2, status=404, body=b'{"error":"not_found"}')
        h.assert_round_ok(h.run())
        self.assertEqual(len(h.worker.calls("download")), 1, "a missing object asks for no new manifest")
        assert_download_failed(h, self, "LUM-720009", "att-3p")

    def test_s7_row3_a_new_manifest_with_other_part_sizes_is_a_failed_download(self) -> None:
        h = Harness(self)
        data = three_part_report(h, "LUM-720010")
        h.worker.storage.expire("att-3p", 2)
        first = len(h.worker.storage.files["att-3p"][0])
        served = 0

        def re_split_on_the_second_manifest(m: dict[str, Any]) -> dict[str, Any]:
            nonlocal served
            served += 1
            if served == 1:
                return m
            # The same bytes cut elsewhere, and the bucket holds these parts now: every part matches its own size and
            # the total is the same, so only the comparison of the two plans can tell that part 1 was cut differently.
            cuts = [0, first // 2, first + first // 2, len(data)]
            parts = [data[a:b] for a, b in zip(cuts, cuts[1:], strict=False)]
            h.worker.storage.files["att-3p"] = parts
            return {**m, "parts": [{**p, "size": len(b)} for p, b in zip(m["parts"], parts, strict=True)]}

        h.worker.manifest_edit["att-3p"] = re_split_on_the_second_manifest
        h.assert_round_ok(h.run())
        assert_download_failed(h, self, "LUM-720010", "att-3p")
        self.assertEqual(len(h.worker.calls("download")), 2, "the new manifest was asked for and read")
        self.assertEqual(h.worker.storage.parts_asked("att-3p"), [1, 2],
                         "part 1 was joined under the first plan; nothing of the second one is fetched")  # fmt: skip

    def test_s7_row3_each_attachment_has_its_own_new_manifest(self) -> None:
        h = Harness(self)
        a, b = video_bytes(), video_bytes(duration=2)
        h.worker.add_report("LUM-720006", attachments=[mp4_attachment("att-a", data=a, parts=3),
                                                       mp4_attachment("att-b", data=b, parts=3)])  # fmt: skip
        h.worker.storage.expire("att-a", 2)
        h.worker.storage.expire("att-b", 3)
        h.assert_round_ok(h.run())
        self.assertEqual(len(h.worker.calls("download")), 4, "one new manifest each, not one for the whole report")
        triage = h.one_triage("LUM-720006")
        self.assertEqual((file_entry(triage, "att-a") or {}).get("status"), "ok")
        self.assertEqual((file_entry(triage, "att-b") or {}).get("status"), "ok")

    def test_s7_row3_a_signed_url_never_reaches_the_logs(self) -> None:
        h = Harness(self)
        three_part_report(h, "LUM-720007")
        h.worker.storage.expire("att-3p", 2, manifest=1)
        h.worker.storage.expire("att-3p", 2, manifest=2)
        p = h.run()
        h.assert_round_ok(p)
        tokens = [r["token"] for r in h.worker.storage.calls()]
        self.assertTrue(tokens, "the scenario reached the bucket")
        for text in (p.stdout, p.stderr):
            for token in tokens:
                self.assertNotIn(token, text, "a signed URL is a credential: it stays out of the logs")
            self.assertNotIn("/storage/v1/", text)


class S7Row4RetentionFallback(unittest.TestCase):
    """Riga 4: RETENTION_FALLBACK non impostato → nessuna chiamata di retention."""

    def round_with(self, code: str | None = None, **env: str) -> tuple[Harness, Any]:
        h = Harness(self)
        if code is not None:
            h.worker.add_report(code)
        p = h.run(**env)
        h.assert_round_ok(p)
        return h, p

    def test_s7_row4_unset_means_no_retention_call(self) -> None:
        h, _ = self.round_with("LUM-740001")
        self.assertEqual(h.worker.calls("retention"), [])
        self.assertEqual(len(h.triages("LUM-740001")), 1, "the round itself ran")

    def test_s7_row4_only_the_value_1_turns_it_on(self) -> None:
        for value in ("0", "", "2", "true"):
            with self.subTest(value):
                h, _ = self.round_with("LUM-740002", RETENTION_FALLBACK=value)
                self.assertEqual(h.worker.calls("retention"), [])

    def test_s7_row4_on_calls_it_with_the_agent_key_until_done(self) -> None:
        h = Harness(self)
        h.worker.retention_rounds_left = 2
        h.assert_round_ok(h.run(RETENTION_FALLBACK="1"))
        calls = h.worker.calls("retention")
        self.assertEqual(len(calls), 3, "not done, not done, done: three calls, then it stops")
        for r in calls:
            self.assertEqual(r["method"], "POST")
            self.assertEqual(r["headers"].get("authorization"), f"Bearer {AGENT_KEY}")

    def test_s7_row4_done_on_the_first_answer_is_one_call(self) -> None:
        h, _ = self.round_with(None, RETENTION_FALLBACK="1")
        self.assertEqual(len(h.worker.calls("retention")), 1)

    def test_s7_row4_done_on_the_20th_answer_is_20_calls(self) -> None:
        h = Harness(self)
        h.worker.retention_rounds_left = 19
        h.assert_round_ok(h.run(RETENTION_FALLBACK="1"))
        self.assertEqual(len(h.worker.calls("retention")), 20)

    def test_s7_row4_never_done_stops_at_20_calls(self) -> None:
        h = Harness(self)
        h.worker.retention_rounds_left = 1000
        h.assert_round_ok(h.run(RETENTION_FALLBACK="1"))
        self.assertEqual(len(h.worker.calls("retention")), 20, "the bound of one run")

    def test_s7_row4_from_the_env_file_as_systemd_runs_it(self) -> None:
        h = Harness(self)
        env_file = h.root / "agent.env"
        env_file.write_text("RETENTION_FALLBACK=1\n", encoding="utf-8")
        os.chmod(env_file, 0o600)
        p = h.run("--env-file", str(env_file), "run-once")
        h.assert_round_ok(p)
        self.assertEqual(len(h.worker.calls("retention")), 1)

    def test_s7_row4_each_run_calls_it_again(self) -> None:
        h = Harness(self)
        h.assert_round_ok(h.run(RETENTION_FALLBACK="1"))
        h.assert_round_ok(h.run(RETENTION_FALLBACK="1"))
        self.assertEqual(len(h.worker.calls("retention")), 2)

    def test_s7_row4_a_dry_run_makes_no_post(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-740003")
        h.assert_round_ok(h.run(DRY_RUN="1", RETENTION_FALLBACK="1"))
        self.assertEqual(h.worker.calls("retention"), [], "a dry round makes GET requests only")

    def test_s7_row4_a_retention_that_fails_costs_nothing_else(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-740004")
        h.worker.fail("retention", 500)
        h.assert_round_ok(h.run(RETENTION_FALLBACK="1"))
        calls = h.worker.calls("retention")
        self.assertGreaterEqual(len(calls), 1)
        self.assertLessEqual(len(calls), 20)
        self.assertEqual(len(h.triages("LUM-740004")), 1, "the report is still triaged")

    def test_s7_row4_an_answer_without_a_true_done_stays_bounded(self) -> None:
        for label, answer in (("not json", b"<html></html>"), ("no done", {}), ("done not boolean", {"done": "yes"})):
            with self.subTest(label):
                h = Harness(self)
                h.worker.add_report("LUM-740005")
                h.worker.retention_answers = [answer] * 25
                h.assert_round_ok(h.run(RETENTION_FALLBACK="1"))
                calls = h.worker.calls("retention")
                self.assertGreaterEqual(len(calls), 1)
                self.assertLessEqual(len(calls), 20)


if __name__ == "__main__":
    unittest.main()
