"""Shared by the fakes the agent runs in the end-to-end rows (claude, gh). The agent gives its children only HOME, PATH,
USER, LANG and TERM (claude_cli.child_env), so the scenario and the call log are found through HOME: e2e/agent-rows.mjs
sets HOME to the rig's folder, writes `scenario.json` there before each round, and reads `calls.jsonl` after it."""

import json
import os
import urllib.request

HOME = os.environ["HOME"]


def scenario() -> dict:
    with open(os.path.join(HOME, "scenario.json"), encoding="utf-8") as f:
        return json.load(f)


def record(rec: dict) -> None:
    with open(os.path.join(HOME, "calls.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


def desk_post(action: dict | None) -> None:
    """A person on the desk, in the middle of the agent's round: the real status route, so the real compare-and-set
    answers the agent's next write. No proxy from the environment: this stays on localhost."""
    if not action:
        return
    req = urllib.request.Request(
        action["url"],
        data=json.dumps(action["body"]).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=20) as res:
        record({"tool": "desk_post", "url": action["url"], "status": res.status})
