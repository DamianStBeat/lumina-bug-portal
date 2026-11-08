#!/usr/bin/env bash
# The agent's REDTEAM_SCRIPT in the end-to-end rows: passes, on both backends, the way the agent calls it
# (`bash redteam.sh <brief> <worktree> <base> <out file>`). The real script needs Codex and Claude, which are the outside.
printf 'verdict: pass\n' >"$4"
exit 0
