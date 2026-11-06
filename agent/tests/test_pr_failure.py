"""Acceptance row 7 family: both red teams passed, the push succeeded, then `gh pr create` fails or is ambiguous.

The lead's rule: the remote fix branch is deleted only when no PR can exist (gh exited non-zero and printed no PR
URL). Deleting the head branch of an open PR closes it on GitHub, so a printed URL keeps the branch (and the report
gets that URL), and a gh that exited 0 keeps it too even when its output carries no URL. Whatever gh did, the local
branch, the worktree and TMP_ROOT are cleaned and the round exits 0.

The fake gh of helpers.py prints PR_URL exactly when it exits 0, so these specs replace it with one whose stdout,
stderr and exit code come from the scenario. It also records the fork's branches at call time: that proves the push
happened before gh, so "branch gone from the fork" is never vacuous.
"""

from __future__ import annotations

import unittest

from helpers import (
    GREETING_FIXED,
    PYTHON,
    STAGE_B_SIMPLE_FIX,
    VALID_STAGE_A,
    Harness,
    _write_exec,
)

# A URL the agent can only know from this gh's stdout (helpers.PR_URL ends in /123).
PRINTED_URL = "https://github.com/DamianStBeat/Lumina2/pull/4567"

_SCRIPTED_GH = r'''
argv = sys.argv[1:]
heads = subprocess.run(["git", "--git-dir", FORK, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
                       capture_output=True, text=True).stdout.split()
_record(LOGDIR, {"argv": argv, "env": dict(os.environ), "cwd": os.getcwd(), "body": None, "fork_heads": heads})
sc = _scenario()["scripted_gh"]
if sc.get("stdout"):
    sys.stdout.write(sc["stdout"])
    sys.stdout.flush()
if sc.get("stderr"):
    sys.stderr.write(sc["stderr"])
    sys.stderr.flush()
sys.exit(int(sc["exit"]))
'''


def _pr_harness(test: unittest.TestCase, code: str, gh_exit: int, stdout: str = "", stderr: str = "") -> Harness:
    h = Harness(test)
    h.worker.add_report(code)
    h.set_stage("stage_a", mode="json", object=dict(VALID_STAGE_A))
    h.set_stage("stage_b", mode="json", object=dict(STAGE_B_SIMPLE_FIX))
    h.set_stage("builder", mode="json", object={"summary": "edited"}, writes={"src/Shared/Greeting.luau": GREETING_FIXED})
    h.scenario["redteam"] = {"default": 0, "claude": 0}
    h.scenario["scripted_gh"] = {"exit": gh_exit, "stdout": stdout, "stderr": stderr}
    h.save_scenario()
    consts = (f"SCENARIO = {str(h.scenario_path)!r}\nLOGDIR = {str(h.logs / 'gh')!r}\n"
              f"FORK = {str(h.fork)!r}\n")
    # GH_BIN points at this path; overwriting it keeps the agent's own lookup unchanged.
    _write_exec(h.bin / "gh", f"#!{PYTHON}\n" + consts, _SCRIPTED_GH)
    return h


class Row07PrFailure(unittest.TestCase):
    """Riga 7: red team superati e push riuscito, ma `gh pr create` fallisce o non dà un URL."""

    def _run_to_gh(self, h: Harness, code: str) -> None:
        p = h.run()
        h.assert_round_ok(p)
        branch = "bugfix/" + code.lower()
        self.assertEqual(len(h.redteam_calls()), 2, "both red teams ran")
        calls = h.gh_calls()
        self.assertEqual(len(calls), 1, "one gh call, never retried")
        self.assertEqual(calls[0]["argv"][:2], ["pr", "create"])
        self.assertIn(branch, calls[0]["fork_heads"], "the fix branch was on the fork when gh ran (push succeeded)")

    def _assert_cleaned(self, h: Harness) -> None:
        self.assertEqual(h.local_branches(), [], "local bugfix branch deleted")
        h.assert_nothing_left()

    def test_row07_pr_url_printed_but_gh_exits_1_keeps_the_branch_and_posts_the_url(self) -> None:
        code = "LUM-710001"
        h = _pr_harness(self, code, gh_exit=1, stdout=PRINTED_URL + "\n",
                        stderr="warning: could not request reviewers\n")
        self._run_to_gh(h, code)
        self.assertIn("bugfix/lum-710001", h.fork_branches(), "a PR URL was printed: its head branch stays on the fork")
        bodies = h.statuses(code)
        self.assertIn({"status": "looking", "prUrl": PRINTED_URL},
                      [{k: b.get(k) for k in ("status", "prUrl")} for b in bodies], f"status POSTs: {bodies}")
        notes = h.notes(code)
        self.assertFalse([n for n in notes if n.startswith("needs_person")], f"no needs_person note: {notes}")
        self._assert_cleaned(h)

    def test_row07_gh_exits_0_without_a_url_keeps_the_branch_and_needs_a_person(self) -> None:
        code = "LUM-710002"
        h = _pr_harness(self, code, gh_exit=0, stdout="")
        self._run_to_gh(h, code)
        self.assertIn("bugfix/lum-710002", h.fork_branches(), "gh exited 0: the PR may exist, its branch stays")
        self.assertIn("needs_person: pr_failed", h.notes(code))
        self.assertFalse([b for b in h.statuses(code) if b.get("prUrl")], "no prUrl posted without a URL")
        self._assert_cleaned(h)

    def test_row07_gh_exits_1_without_a_url_deletes_the_remote_branch(self) -> None:
        code = "LUM-710003"
        h = _pr_harness(self, code, gh_exit=1, stdout="", stderr="GraphQL: something went wrong (createPullRequest)\n")
        self._run_to_gh(h, code)
        self.assertEqual(h.fork_branches(), ["main"], "no PR can exist: the pushed fix branch is deleted from the fork")
        self.assertIn("needs_person: pr_failed", h.notes(code))
        self.assertFalse([b for b in h.statuses(code) if b.get("prUrl")], "no prUrl posted without a URL")
        self._assert_cleaned(h)


if __name__ == "__main__":
    unittest.main()
