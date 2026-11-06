"""Acceptance rows 5 (risk paths stop the fix), 6 (daily fix cap) and 7 (red teams gate the push).

These need stage C, which the builder writes last: until then they fail on the missing module or missing stage C.
"""

from __future__ import annotations

import re
import unittest

from helpers import (
    AGENT_KEY,
    CHILD_ENV_ALLOWED,
    GREETING_FIXED,
    PR_URL,
    STAGE_B_SIMPLE_FIX,
    VALID_STAGE_A,
    Harness,
    argv_value,
)

TITLE_RX = r"^(Shared|Lobby|GamePlay) Bug LUM-\d{6}: .+"


def _simple_fix_harness(test: unittest.TestCase | type, code: str, builder_writes: dict | None = None,
                        stage_b: dict | None = None, **report: object) -> Harness:
    h = Harness(test)
    h.worker.add_report(code, **report)
    h.set_stage("stage_a", mode="json", object=dict(VALID_STAGE_A))
    h.set_stage("stage_b", mode="json", object=dict(stage_b or STAGE_B_SIMPLE_FIX))
    h.set_stage("builder", mode="json", object={"summary": "edited"}, writes=builder_writes or {})
    return h


class Row05RiskPathEdited(unittest.TestCase):
    """Riga 5: verdetto simple_fix ma la correzione tocca `Inventory` → nessuna correzione, needs_person."""

    def _assert_blocked(self, h: Harness, code: str, reason: str) -> None:
        branch = "bugfix/" + code.lower()
        self.assertEqual(len(h.claude_calls("builder")), 1, "the builder ran (stage C started)")
        self.assertTrue([c for c in h.gw_calls() if "--branch" in c["argv"] and branch in c["argv"]],
                        f"stage C created its worktree on {branch} (so 'branch gone' is not vacuous)")
        self.assertEqual(h.redteam_calls(), [], "no red team after the path guard refused the diff")
        self.assertEqual(h.gh_calls(), [], "no gh call")
        self.assertEqual(h.fork_branches(), ["main"], "nothing pushed to fork")
        self.assertEqual(h.local_branches(), [], f"local {branch} deleted")
        self.assertEqual(h.worktrees(), [str(h.repo)], "stage C worktree removed")
        self.assertEqual(h.leftovers(h.tmp_root), [])
        notes = h.notes(code)
        self.assertTrue(notes and all(n.startswith("needs_person") for n in notes), f"status notes: {notes}")
        self.assertIn(f"needs_person: {reason}", notes)
        self.assertTrue(all(b.get("status") == "looking" for b in h.statuses(code)), "the report stays looking")
        self.assertEqual(h.one_triage(code)["verdict"], "simple_fix", "the triage itself is posted before stage C")

    def test_row05_builder_edits_inventory_service(self) -> None:
        code = "LUM-500001"
        h = _simple_fix_harness(self, code, {"src/Server/Inventory/InventoryService.luau": "--!strict\nreturn {}\n"})
        p = h.run()
        h.assert_round_ok(p)
        self._assert_blocked(h, code, "risk_path")

    def test_row05_builder_adds_a_new_untracked_file_under_inventory(self) -> None:
        code = "LUM-500002"
        h = _simple_fix_harness(self, code, {
            "src/Shared/Greeting.luau": GREETING_FIXED,
            "src/Server/Inventory/Extra.luau": "--!strict\nreturn {}\n",
        })
        p = h.run()
        h.assert_round_ok(p)
        self._assert_blocked(h, code, "risk_path")

    def test_row05_builder_edits_a_project_json(self) -> None:
        code = "LUM-500003"
        h = _simple_fix_harness(self, code, {"default.project.json": '{"name": "x", "tree": {}}\n'})
        p = h.run()
        h.assert_round_ok(p)
        self._assert_blocked(h, code, "risk_path")

    def test_row05_more_than_five_files_is_too_large(self) -> None:
        code = "LUM-500004"
        writes = {f"src/Shared/New{i}.luau": "--!strict\nreturn {}\n" for i in range(6)}
        h = _simple_fix_harness(self, code, writes)
        p = h.run()
        h.assert_round_ok(p)
        self._assert_blocked(h, code, "diff_too_large")

    def test_row05_builder_changes_nothing(self) -> None:
        code = "LUM-500005"
        h = _simple_fix_harness(self, code, {})
        p = h.run()
        h.assert_round_ok(p)
        self._assert_blocked(h, code, "no_change")


class Row05BuilderNeverStarted(unittest.TestCase):
    """Riga 5, prima del builder: stage B indica un percorso a rischio, o confidenza sotto 0.8."""

    def _assert_not_started(self, code: str, stage_b: dict, reason: str) -> None:
        h = _simple_fix_harness(self, code, {"src/Shared/Greeting.luau": GREETING_FIXED}, stage_b=stage_b)
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(len(h.claude_calls("stage_b")), 1, "stage B ran")
        self.assertEqual(h.claude_calls("builder"), [], "the builder is never started")
        self.assertEqual([c for c in h.gw_calls() if "--branch" in c["argv"]], [], "no stage C worktree")
        self.assertEqual(h.redteam_calls(), [])
        self.assertEqual(h.gh_calls(), [])
        self.assertIn(f"needs_person: {reason}", h.notes(code))
        h.assert_nothing_left()

    def test_row05_likely_files_names_an_inventory_path(self) -> None:
        sb = dict(STAGE_B_SIMPLE_FIX, likely_files=[
            {"path": "src/Server/Inventory/InventoryService.luau", "line": 4, "why": "count"}])
        self._assert_not_started("LUM-500101", sb, "risk_path")

    def test_row05_likely_files_names_a_top_level_inventory_file(self) -> None:
        # `**/Inventory*` matches any segment starting with Inventory, also directly under src/.
        sb = dict(STAGE_B_SIMPLE_FIX, likely_files=[{"path": "src/InventoryService.luau", "line": None, "why": "x"}])
        self._assert_not_started("LUM-500102", sb, "risk_path")

    def test_row05_non_empty_risk_paths(self) -> None:
        sb = dict(STAGE_B_SIMPLE_FIX, risk_paths=["src/Server/Currency/CurrencyService.luau"])
        self._assert_not_started("LUM-500103", sb, "risk_path")

    def test_row05_confidence_just_below_0_8(self) -> None:
        self._assert_not_started("LUM-500104", dict(STAGE_B_SIMPLE_FIX, confidence=0.79), "low_confidence")

    def test_row05_confidence_exactly_0_8_starts_the_builder(self) -> None:
        h = _simple_fix_harness(self, "LUM-500105", {"src/Shared/Greeting.luau": GREETING_FIXED},
                                stage_b=dict(STAGE_B_SIMPLE_FIX, confidence=0.8))
        p = h.run()
        h.assert_round_ok(p)
        self.assertEqual(len(h.claude_calls("builder")), 1, "confidence >= 0.8 is eligible (edge included)")


class Row06DailyFixCap(unittest.TestCase):
    """Riga 6: sesta correzione del giorno → saltata, annotata (DAILY_FIX_CAP=5)."""

    CODES = [f"LUM-60000{i}" for i in range(1, 7)]

    def _harness(self) -> Harness:
        # The builder changes nothing, so each started fix ends as `no_change` without pushes: the cap counts starts.
        h = Harness(self)
        for code in self.CODES:
            h.worker.add_report(code)
        h.set_stage("stage_b", mode="json", object=dict(STAGE_B_SIMPLE_FIX))
        h.set_stage("builder", mode="json", object={"summary": "nothing"}, writes={})
        return h

    def _assert_cap(self, h: Harness) -> None:
        self.assertEqual(len(h.claude_calls("stage_b")), 6, "all six reports were triaged")
        self.assertEqual(len(h.claude_calls("builder")), 5, "five builder runs at most in a UTC day")
        capped = [c for c in self.CODES if "needs_person: fix_cap" in h.notes(c)]
        self.assertEqual(capped, [self.CODES[-1]], "only the sixth (oldest first) is noted fix_cap")
        for code in self.CODES[:-1]:
            self.assertNotIn("needs_person: fix_cap", h.notes(code), f"{code} is within the cap")
        h.assert_nothing_left()

    def test_row06_sixth_fix_in_one_round(self) -> None:
        h = self._harness()
        p = h.run(DAILY_FIX_CAP="5", MAX_REPORTS_PER_ROUND="6")
        h.assert_round_ok(p)
        self._assert_cap(h)

    def test_row06_cap_holds_across_rounds_of_the_same_day(self) -> None:
        h = self._harness()
        for _ in range(2):
            p = h.run(DAILY_FIX_CAP="5", MAX_REPORTS_PER_ROUND="3")
            h.assert_round_ok(p)
        self._assert_cap(h)


class Row07RedTeamSaysFix(unittest.TestCase):
    """Riga 7: un red team dice fix → niente push, ramo cancellato, needs_person."""

    def _assert_stopped(self, h: Harness, code: str, reason: str) -> None:
        self.assertEqual(len(h.claude_calls("builder")), 1)
        self.assertGreaterEqual(len(h.redteam_calls()), 1, "the red team ran")
        self.assertEqual(h.fork_branches(), ["main"], "nothing pushed to fork")
        self.assertEqual(h.local_branches(), [], "local bugfix branch deleted")
        self.assertEqual(h.gh_calls(), [], "no gh call")
        self.assertIn(f"needs_person: {reason}", h.notes(code))
        self.assertFalse([b for b in h.statuses(code) if b.get("prUrl")], "no prUrl posted")
        h.assert_nothing_left()

    def test_row07_second_red_team_fails(self) -> None:
        code = "LUM-700001"
        h = _simple_fix_harness(self, code, {"src/Shared/Greeting.luau": GREETING_FIXED})
        h.scenario["redteam"] = {"default": 0, "claude": 1}
        h.save_scenario()
        p = h.run()
        h.assert_round_ok(p)
        calls = h.redteam_calls()
        self.assertEqual(len(calls), 2, "both red teams ran (the first passed)")
        self.assertNotEqual(calls[0]["backend"], "claude", "first red team on the default backend")
        self.assertEqual(calls[1]["backend"], "claude", "second red team with QG_REDTEAM_BACKEND=claude")
        self._assert_stopped(h, code, "redteam_fix")

    def test_row07_first_red_team_fails(self) -> None:
        code = "LUM-700002"
        h = _simple_fix_harness(self, code, {"src/Shared/Greeting.luau": GREETING_FIXED})
        h.scenario["redteam"] = {"default": 1, "claude": 0}
        h.save_scenario()
        p = h.run()
        h.assert_round_ok(p)
        self._assert_stopped(h, code, "redteam_fix")

    def test_row07_red_team_that_did_not_run_is_not_a_pass(self) -> None:
        code = "LUM-700003"
        h = _simple_fix_harness(self, code, {"src/Shared/Greeting.luau": GREETING_FIXED})
        h.scenario["redteam"] = {"default": 4, "claude": 0}
        h.save_scenario()
        p = h.run()
        h.assert_round_ok(p)
        self._assert_stopped(h, code, "redteam_not_run")


class Row07BothRedTeamsPass(unittest.TestCase):
    """Riga 7, percorso felice: entrambi passano → push del ramo, PR in bozza, stato looking con prUrl."""

    CODE = "LUM-700100"
    BRANCH = "bugfix/lum-700100"

    @classmethod
    def setUpClass(cls) -> None:
        # A summary with a backtick and an @ checks the title is cleaned before it reaches gh.
        sb = dict(STAGE_B_SIMPLE_FIX, summary="Greeting `misses` the mark for @everyone")
        cls.h = _simple_fix_harness(cls, cls.CODE, {"src/Shared/Greeting.luau": GREETING_FIXED}, stage_b=sb,
                                    where_area="lobby")
        cls.p = cls.h.run()

    def test_row07_branch_is_pushed_with_only_the_fix(self) -> None:
        self.h.assert_round_ok(self.p)
        self.assertIn(self.BRANCH, self.h.fork_branches(), "the fix branch is pushed to the fork remote")
        self.assertEqual(self.h.fork_diff_names(self.BRANCH), ["src/Shared/Greeting.luau"])
        self.assertEqual(self.h.fork_show(self.BRANCH, "src/Shared/Greeting.luau"), GREETING_FIXED)

    def test_row07_red_teams_saw_the_committed_fix(self) -> None:
        self.h.assert_round_ok(self.p)
        calls = self.h.redteam_calls()
        self.assertEqual(len(calls), 2)
        self.assertEqual([c["backend"] == "claude" for c in calls], [False, True])
        for c in calls:
            self.assertEqual(c["argv"][2:3], ["fork/main"], f"red team argv: {c['argv']}")
            self.assertTrue((c["head_subject"] or "").startswith(f"Bug {self.CODE}: "),
                            f"the fix is committed before the red team: {c['head_subject']!r}")
            self.assertEqual(c["worktree_status"], "", "nothing uncommitted when the red team looks")

    def test_row07_draft_pr_with_the_pinned_title(self) -> None:
        self.h.assert_round_ok(self.p)
        calls = self.h.gh_calls()
        self.assertEqual(len(calls), 1, "one gh call")
        argv = calls[0]["argv"]
        self.assertEqual(argv[:2], ["pr", "create"])
        self.assertIn("--draft", argv)
        self.assertEqual(argv_value(argv, "--repo"), "DamianStBeat/Lumina2")
        self.assertEqual(argv_value(argv, "--base"), "main")
        self.assertEqual(argv_value(argv, "--head"), self.BRANCH)
        title = argv_value(argv, "--title") or ""
        self.assertRegex(title, TITLE_RX)
        self.assertTrue(title.startswith(f"Lobby Bug {self.CODE}: "), f"lobby report → Lobby: {title!r}")
        self.assertNotIn("`", title, "backticks removed from the title")
        self.assertNotIn("@", title, "@ replaced in the title")
        self.assertLessEqual(len(title.split(": ", 1)[1]), 72)
        self.assertNotIn("merge", argv)
        self.assertIn(self.CODE, calls[0]["body"] or "", "the PR body names the report code")

    def test_row07_status_looking_with_pr_url(self) -> None:
        self.h.assert_round_ok(self.p)
        bodies = self.h.statuses(self.CODE)
        self.assertIn({"status": "looking", "prUrl": PR_URL},
                      [{k: b.get(k) for k in ("status", "prUrl")} for b in bodies], f"status POSTs: {bodies}")

    def test_row07_happy_path_leaves_nothing_behind(self) -> None:
        self.h.assert_round_ok(self.p)
        self.h.assert_nothing_left()

    def test_row07_children_get_a_clean_environment_without_agent_key(self) -> None:
        self.h.assert_round_ok(self.p)
        children = ([("claude", c["env"]) for c in self.h.claude_calls()]
                    + [("gh", c["env"]) for c in self.h.gh_calls()])
        self.assertTrue(children)
        for name, env in children:
            self.assertNotIn(AGENT_KEY, env.values(), f"{name} received AGENT_KEY")
            self.assertEqual(set(env) - CHILD_ENV_ALLOWED, set(), f"{name} env has more than HOME/PATH/USER/LANG/TERM")
        for c in self.h.redteam_calls():
            self.assertNotIn(AGENT_KEY, c["env"].values(), "red team received AGENT_KEY")
            self.assertNotIn("AGENT_KEY", c["env"])
            self.assertNotIn("PORTAL_API_BASE", c["env"])
        self.assertNotIn(AGENT_KEY, self.p.stderr)

    def test_row07_claude_tool_permissions_are_pinned(self) -> None:
        self.h.assert_round_ok(self.p)
        for c in self.h.claude_calls():
            argv = c["argv"]
            self.assertIn("-p", argv)
            self.assertEqual(argv_value(argv, "--model"), "claude-opus-5-5")
            self.assertFalse([a for a in argv if "dangerously" in a], f"{c['stage']}: {argv}")
        (a,) = self.h.claude_calls("stage_a")
        self.assertEqual(argv_value(a["argv"], "--tools"), "", "stage A has no tools")
        (b,) = self.h.claude_calls("stage_b")
        self.assertEqual(argv_value(b["argv"], "--tools"), "Read,Grep,Glob")
        self.assertEqual(argv_value(b["argv"], "--allowedTools"), "Read,Grep,Glob")
        self.assertTrue(b["cwd"].startswith(str(self.h.worktree_root)), "stage B runs in a worktree")
        self.assertIn("src", b["cwd_listing"] or [], "stage B cwd is a Lumina2 checkout")
        (f,) = self.h.claude_calls("builder")
        allowed = (argv_value(f["argv"], "--allowedTools") or "").split(",")
        self.assertNotIn("Bash", allowed, "the builder never gets unrestricted Bash")
        self.assertFalse([t for t in allowed if t.startswith("Bash(") and not re.match(r"^Bash\((stylua --check|selene):\*\)$", t)],
                         f"builder Bash limited to stylua --check / selene: {allowed}")


if __name__ == "__main__":
    unittest.main()
