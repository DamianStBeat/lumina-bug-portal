"""Acceptance rows 8 (worker down), 9 (dry run) and 10 (two rounds at once), plus configuration errors."""

from __future__ import annotations

import os
import socket
import threading
import unittest

from helpers import (
    AGENT_KEY,
    TRACEBACK,
    Harness,
    free_port,
    is_mode_700,
    make_lock_holder,
    mp4_attachment,
)


class Row08WorkerUnreachable(unittest.TestCase):
    """Riga 8: il worker non risponde → errore registrato, nessun crash, riprova al giro dopo."""

    def test_row08_closed_port_then_worker_up(self) -> None:
        port = free_port()  # nothing listens here yet
        h = Harness(self, worker_port=None)
        base = f"http://127.0.0.1:{port}/api/v1"
        p = h.run(PORTAL_API_BASE=base)
        h.assert_round_ok(p)
        self.assertIn("worker unreachable", p.stderr)
        self.assertTrue([l for l in p.stderr.splitlines() if "worker unreachable" in l and l.startswith("lumina-bug-agent: ")],
                        f"one `lumina-bug-agent: ` log line names the failure:\n{p.stderr}")
        self.assertEqual(h.claude_calls(), [])
        # Next round, same state dir, the worker is up on that port: the report is processed.
        w = h.start_worker(port)
        w.add_report("LUM-800001")
        p2 = h.run(PORTAL_API_BASE=base)
        h.assert_round_ok(p2)
        self.assertEqual(len(h.triages("LUM-800001")), 1, "the second round processes the report")

    def test_row08_queue_answering_503(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-800002")
        h.worker.fail("queue", 503)
        p = h.run()
        h.assert_round_ok(p)
        self.assertIn("worker unreachable", p.stderr)
        self.assertEqual(h.worker.calls("claim"), [], "no claim when the queue cannot be read")

    def test_row08_report_error_after_claim_is_retried_next_round(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-800003")
        h.worker.fail("report", 500, times=1)
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(h.triages(), [], "no triage when the report could not be read")
        self.assertEqual(h.claude_calls(), [])
        self.assertEqual(len(h.worker.calls("claim", "LUM-800003")), 1, "the first round claimed it")
        # The claim holds the report out of the queue for LEASE_MINUTES (the real worker does the same): the next
        # round that sees it again is the one after the lease ran out.
        h.worker.expire_lease("LUM-800003")
        p2 = h.run()
        h.assert_round_ok(p2)
        self.assertEqual(len(h.triages("LUM-800003")), 1, "the next round retries and triages it")
        h.assert_nothing_left()

    def test_row08_triage_post_error_does_not_crash(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-800004")
        h.worker.add_report("LUM-800005")
        h.worker.fail("triage", 500, times=1)
        p = h.run()
        h.assert_round_ok(p)
        # The first triage POST failed; the round moved on to the second report.
        self.assertEqual(len(h.triages("LUM-800005")), 1, "a report-level error does not stop the round")
        h.assert_nothing_left()


class Row09DryRun(unittest.TestCase):
    """Riga 9: DRY_RUN=1 → nessuna chiamata a claude e nessuna PR; log di cosa avrebbe fatto."""

    def _assert_dry(self, h: Harness, p, expect_would: bool = True) -> None:
        h.assert_round_ok(p)
        self.assertEqual(h.claude_calls(), [], "no claude in dry run")
        self.assertEqual(h.gh_calls(), [], "no gh in dry run")
        self.assertEqual(h.redteam_calls(), [], "no red team in dry run")
        self.assertEqual(h.gw_calls(), [], "no git worktree in dry run")
        posts = [f"{r['method']} {r['path']}" for r in h.worker.calls() if r["method"] != "GET"]
        self.assertEqual(posts, [], "the worker sees no POST in dry run (no claim, no frames, no triage)")
        if expect_would:
            self.assertTrue([l for l in p.stderr.splitlines() if "dry run: would" in l], f"stderr:\n{p.stderr}")
        h.assert_nothing_left()

    def test_row09_dry_run_one(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-900001", attachments=[mp4_attachment("att-dry")])
        p = h.run(DRY_RUN="1")
        self._assert_dry(h, p)
        self.assertTrue(h.worker.calls("queue"), "dry run still reads the queue")

    def test_row09_dry_run_is_the_default_when_unset(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-900002")
        p = h.run(unset=("DRY_RUN",))
        self._assert_dry(h, p)

    def test_row09_each_code_is_dry_run_once(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-900003", attachments=[mp4_attachment("att-dry2")])
        h.assert_round_ok(h.run(DRY_RUN="1"))
        self.assertEqual(len(h.worker.calls("download")), 1, "first dry round downloads the file")
        p = h.run(DRY_RUN="1")
        # A code already dry-run may be skipped silently, so the "would" lines are not required here.
        self._assert_dry(h, p, expect_would=False)
        self.assertEqual(len(h.worker.calls("download")), 1, "a second dry round does not download it again")


class Row10TwoRounds(unittest.TestCase):
    """Riga 10: due giri insieme → il secondo non prende lo stesso report (lease) né parte (lock file)."""

    def test_row10_lock_held_second_round_does_not_start(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100001")
        holder = make_lock_holder(h.state_dir / "agent.lock")
        self.addCleanup(holder.close)
        p = h.run()
        h.assert_round_ok(p)
        self.assertIn("another round is running", p.stderr)
        self.assertEqual(h.worker.calls(), [], "no worker request while another round holds the lock")
        self.assertEqual(h.claude_calls(), [])

    def test_row10_stale_lock_file_not_held_does_not_block(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100002")
        holder = make_lock_holder(h.state_dir / "agent.lock")
        holder.close()  # the file stays, nobody holds it: a crashed round must not block the next one
        p = h.run()
        h.assert_round_ok(p)
        self.assertNotIn("another round is running", p.stderr)
        self.assertEqual(len(h.triages("LUM-100002")), 1)

    def test_row10_claim_409_leased_means_no_download_and_no_claude(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100003", attachments=[mp4_attachment("att-leased")])
        h.worker.leased.add("LUM-100003")
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(len(h.worker.calls("claim", "LUM-100003")), 1, "the claim was tried")
        self.assertEqual(h.worker.calls("report", "LUM-100003"), [], "a leased report is not read")
        self.assertEqual(h.worker.calls("download"), [], "no download of a leased report")
        self.assertEqual(h.claude_calls(), [], "no claude call for a leased report")
        self.assertEqual(h.triages(), [])
        self.assertIn("leased", p.stderr)

    def test_row10_leased_report_is_skipped_and_the_next_one_processed(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100004")
        h.worker.add_report("LUM-100005")
        h.worker.leased.add("LUM-100004")
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(h.triages("LUM-100004"), [])
        self.assertEqual(len(h.triages("LUM-100005")), 1)

    def test_row10_real_double_start(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-100006")
        sock_path = str(h.root / "ctl.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(sock_path)
        listener.listen(1)
        listener.settimeout(60)
        self.addCleanup(listener.close)
        h.set_stage("stage_a", mode="json", object=h.scenario["stage_a"]["object"], block_socket=sock_path)
        first = h.popen()

        def _unblock_if_first_exits() -> None:
            # A first round that dies before stage A must not leave accept() waiting for the full timeout:
            # the watcher connects itself and says so.
            first.wait()
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                    s.connect(sock_path)
                    s.sendall(b"exited")
            except OSError:
                pass

        threading.Thread(target=_unblock_if_first_exits, daemon=True).start()
        # The first round is now inside stage A, holding the lock and the claim; wait for it (bounded).
        try:
            conn, _ = listener.accept()
        except OSError:
            conn = None
        if conn is not None:
            self.addCleanup(conn.close)
            hello = conn.recv(16)
        else:
            hello = b"timeout"
        if hello != b"started":
            if first.poll() is None:
                first.kill()
            out, err = first.communicate(timeout=30)
            self.fail(f"the first round never reached stage A ({hello!r}, exit {first.returncode}):\n{err[-3000:]}")
        before = len(h.worker.calls())
        second = h.run()
        after = len(h.worker.calls())
        conn.sendall(b"go")
        out, err = first.communicate(timeout=120)
        h.assert_round_ok(second)
        self.assertIn("another round is running", second.stderr)
        self.assertEqual(after, before, "the second round made no worker request")
        self.assertEqual(first.returncode, 0, err[-3000:])
        self.assertEqual(len(h.worker.calls("claim", "LUM-100006")), 1, "the report was claimed once")
        self.assertEqual(len(h.triages("LUM-100006")), 1)


class ConfigurationAndSecrets(unittest.TestCase):
    """Cross-cutting: configuration errors exit 2; the key stays out of children and logs; private temp dir."""

    def _assert_config_error(self, **kw) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-000001")
        p = h.run(**kw)
        self.assertEqual(p.returncode, 2, f"configuration error must exit 2 ({kw}):\n{p.stderr[-2000:]}")
        self.assertNotIn(TRACEBACK, p.stderr)
        self.assertEqual(h.worker.calls(), [], "no worker request with a bad configuration")
        self.assertNotIn(AGENT_KEY, p.stderr)

    def test_config_missing_agent_key_exits_2(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-000002")
        p = h.run(unset=("AGENT_KEY",))
        self.assertEqual(p.returncode, 2, p.stderr[-2000:])
        self.assertNotIn(TRACEBACK, p.stderr)
        self.assertEqual(h.worker.calls(), [])

    def test_config_empty_agent_key_exits_2(self) -> None:
        self._assert_config_error(AGENT_KEY="")

    def test_config_missing_portal_api_base_exits_2(self) -> None:
        h = Harness(self)
        p = h.run(unset=("PORTAL_API_BASE",))
        self.assertEqual(p.returncode, 2, p.stderr[-2000:])
        self.assertNotIn(TRACEBACK, p.stderr)

    def test_config_missing_lumina2_repo_exits_2(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-000003")
        p = h.run(unset=("LUMINA2_REPO",))
        self.assertEqual(p.returncode, 2, p.stderr[-2000:])
        self.assertEqual(h.worker.calls(), [])

    def test_config_bad_number_exits_2(self) -> None:
        self._assert_config_error(DAILY_FIX_CAP="five")

    def test_config_env_file_is_read_and_process_env_wins(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-000004")
        env_file = h.root / "agent.env"
        env_file.write_text(f"# test config\nAGENT_KEY={AGENT_KEY}\nDRY_RUN=1\n", encoding="utf-8")
        os.chmod(env_file, 0o600)
        p = h.run("--env-file", str(env_file), "run-once", unset=("AGENT_KEY",), DRY_RUN="0")
        h.assert_round_ok(p)
        self.assertEqual(len(h.worker.calls("claim")), 1, "AGENT_KEY from the file works and DRY_RUN=0 from the process wins")

    def test_report_temp_dir_is_private(self) -> None:
        h = Harness(self)
        h.worker.add_report("LUM-000005", attachments=[mp4_attachment("att-priv")])
        p = h.run()
        h.assert_round_ok(p)
        (a,) = h.claude_calls("stage_a")
        self.assertTrue(a["parent"].startswith(str(h.tmp_root) + os.sep), f"report temp dir under TMP_ROOT: {a['parent']}")
        self.assertTrue(is_mode_700(a["parent_mode"]), f"report temp dir mode must be 700, got {a['parent_mode']}")
        self.assertEqual(a["cwd_listing"], [], "stage A runs in an empty dir: it never sees the raw files")
        h.assert_nothing_left()


if __name__ == "__main__":
    unittest.main()
