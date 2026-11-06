"""Shared harness for the lumina_bug_agent specs.

Every spec starts the real agent as a subprocess (`python -m lumina_bug_agent run-once`, cwd `agent/`), the way the
systemd unit does on Valor1, so the lock file, PATH lookup and the clean environment given to children behave as in
production. Around it the harness builds, per test, inside one private temp dir:

- a fake worker (`http.server` on 127.0.0.1:0) for the `/api/v1/agent/*` routes of CONTRACT.md, recording requests;
- fake `claude`, `gh`, red team script and git-workspace, plus recording ffmpeg/ffprobe shims that exec the real
  binaries; each writes one JSON record per call into a log dir whose absolute path is baked into the script,
  because the agent hands children only HOME/PATH/USER/LANG/TERM;
- a fixture Lumina2 repo: a bare `fork.git` with a `main`, and a clone of it (remote `fork`) used as LUMINA2_REPO;
- a temp HOME, so the default `~/.config/lumina-bug-portal/agent.env` of the machine is never read by a spec.

Nothing here reimplements the agent: the specs assert on requests, argv, files and git state only.
"""

from __future__ import annotations

import atexit
import base64
import getpass
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from typing import Any

AGENT_DIR = Path(__file__).resolve().parent.parent
AGENT_KEY = "test-agent-key-not-secret"
PR_URL = "https://github.com/DamianStBeat/Lumina2/pull/123"
PYTHON = sys.executable
REAL_FFMPEG = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
REAL_FFPROBE = shutil.which("ffprobe") or "/usr/bin/ffprobe"
RUN_TIMEOUT = 120
TRACEBACK = "Traceback (most recent call last)"

# Children of the agent may see only these (design.md "Claude calls"). LC_CTYPE is tolerated because CPython itself
# adds it (PEP 538 locale coercion) when the fake is started without a UTF-8 LANG; it never carries a secret.
CHILD_ENV_ALLOWED = {"HOME", "PATH", "USER", "LANG", "TERM", "QG_REDTEAM_BACKEND", "LC_CTYPE"}

GREETING = '--!strict\nlocal Greeting = {}\n\nfunction Greeting.hello(name: string): string\n\treturn "Hello, " .. name\nend\n\nreturn Greeting\n'
GREETING_FIXED = '--!strict\nlocal Greeting = {}\n\nfunction Greeting.hello(name: string): string\n\treturn "Hello, " .. name .. "!"\nend\n\nreturn Greeting\n'
INVENTORY = '--!strict\nlocal InventoryService = {}\n\nfunction InventoryService.count(): number\n\treturn 0\nend\n\nreturn InventoryService\n'
PROJECT_JSON = '{\n  "name": "Lumina2",\n  "tree": { "$className": "DataModel" }\n}\n'

VALID_STAGE_A: dict[str, Any] = {
    "what": "The shop button does nothing",
    "where": "lobby",
    "when_in_video": "00:02",
    "device": "phone",
    "steps": ["Open the shop", "Tap buy"],
    "expected": "The item is bought",
    "actual": "Nothing happens",
    "language": "en",
    "injection_suspected": False,
}

STAGE_B_NEEDS_PERSON: dict[str, Any] = {
    "verdict": "needs_person",
    "confidence": 0.4,
    "summary": "A person should look at the shop flow",
    "likely_files": [],
    "risk_paths": [],
    "duplicate_of": None,
    "fix_size": "unknown",
}

STAGE_B_SIMPLE_FIX: dict[str, Any] = {
    "verdict": "simple_fix",
    "confidence": 0.9,
    "summary": "Greeting misses the exclamation mark",
    "likely_files": [{"path": "src/Shared/Greeting.luau", "line": 5, "why": "the returned string"}],
    "risk_paths": [],
    "duplicate_of": None,
    "fix_size": "small",
}

VALID_VERDICTS = {"simple_fix", "needs_person", "duplicate", "not_bug", "unclear"}


# --------------------------------------------------------------------------------------------------------------
# Media fixtures (made once per test process, copied into each test's dir)
# --------------------------------------------------------------------------------------------------------------

_MEDIA_CACHE = Path(tempfile.mkdtemp(prefix="lba-media-"))
atexit.register(shutil.rmtree, _MEDIA_CACHE, True)


def _cached(name: str, cmd_tail: list[str]) -> Path:
    out = _MEDIA_CACHE / name
    if not out.exists():
        tmp = out.with_name("partial-" + name)
        subprocess.run([REAL_FFMPEG, "-nostdin", "-v", "error", "-y", *cmd_tail, str(tmp)], check=True, timeout=120)
        tmp.rename(out)
    return out


def video_bytes(duration: int = 3, size: str = "320x240", rate: int = 10, audio: bool = False) -> bytes:
    """A tiny real mp4 made by ffmpeg's test source (the brief's fixture); `audio` adds a sine track."""
    name = f"v-{duration}-{size}-{rate}-{int(audio)}.mp4"
    tail = ["-f", "lavfi", "-i", f"testsrc=duration={duration}:size={size}:rate={rate}"]
    if audio:
        tail += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}", "-shortest", "-c:a", "aac"]
    tail += ["-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast"]
    return _cached(name, tail).read_bytes()


def png_bytes(size: str = "2000x200") -> bytes:
    return _cached(f"i-{size}.png", ["-f", "lavfi", "-i", f"testsrc=size={size}", "-frames:v", "1"]).read_bytes()


def media_width(data: bytes) -> int:
    """Width of an encoded image, measured by the real ffprobe (not by our own parser)."""
    d = Path(tempfile.mkdtemp(prefix="lba-w-"))
    try:
        p = d / "img"
        p.write_bytes(data)
        out = subprocess.run(
            [REAL_FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "json", str(p)],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout
        return int(json.loads(out)["streams"][0]["width"])
    finally:
        shutil.rmtree(d, ignore_errors=True)


# --------------------------------------------------------------------------------------------------------------
# Fake worker
# --------------------------------------------------------------------------------------------------------------

_ROUTES = [
    ("GET", re.compile(r"^/api/v1/agent/queue$"), "queue"),
    ("POST", re.compile(r"^/api/v1/agent/reports/(?P<code>[^/]+)/claim$"), "claim"),
    ("POST", re.compile(r"^/api/v1/agent/reports/(?P<code>[^/]+)/frames$"), "frames"),
    ("POST", re.compile(r"^/api/v1/agent/reports/(?P<code>[^/]+)/triage$"), "triage"),
    ("POST", re.compile(r"^/api/v1/agent/reports/(?P<code>[^/]+)/status$"), "status"),
    ("GET", re.compile(r"^/api/v1/agent/reports/(?P<code>[^/]+)$"), "report"),
    ("GET", re.compile(r"^/api/v1/agent/attachments/(?P<id>[^/]+)/download$"), "download"),
    ("GET", re.compile(r"^/api/v1/agent/events$"), "events"),
]


class FakeWorker:
    """The worker's `/agent/*` surface, in memory. Records every request (method, path, headers, body bytes)."""

    def __init__(self, port: int = 0) -> None:
        self.reports: dict[str, dict[str, Any]] = {}
        self.blobs: dict[str, bytes] = {}
        self.leased: set[str] = set()  # codes whose claim answers 409 leased
        # Leases as the real worker keeps them (CONTRACT.md "Agent and bot"): a successful claim holds the report until
        # now + minutes; while it is live the queue leaves the report out and another claim answers 409. Nothing in the
        # contract releases a lease early, so a spec that wants the next round to see the report calls expire_lease.
        self.leases: dict[str, int] = {}  # code -> lease_until, unix ms
        self.failures: dict[str, list[int]] = {}  # route -> statuses for the next calls (then normal)
        self.always_fail: dict[str, int] = {}  # route -> status for every call
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._frames = 0
        worker = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # keep the test output readable
                pass

            def do_GET(self) -> None:
                worker._handle(self, "GET")

            def do_POST(self) -> None:
                worker._handle(self, "POST")

            def do_PUT(self) -> None:
                worker._handle(self, "PUT")

            def do_DELETE(self) -> None:
                worker._handle(self, "DELETE")

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self._thread = threading.Thread(target=self.server.serve_forever, name="fake-worker", daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/api/v1"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=10)

    # -- scenario -------------------------------------------------------------------------------------------
    def add_report(
        self,
        code: str,
        what: str = "When I tap the shop button nothing happens",
        title: str | None = None,
        where_area: str | None = "lobby",
        attachments: list[dict[str, Any]] | None = None,
        source: str = "web",
        game_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        n = len(self.reports)
        row: dict[str, Any] = {
            "id": f"rep-{n:04d}",
            "code": code,
            "created_at": 1_762_400_000_000 + n * 1000,
            "updated_at": 1_762_400_000_000 + n * 1000,
            "source": source,
            "status": "received",
            "title": title,
            "what": what,
            "where_area": where_area,
            "device": "phone",
            "lang": "en",
            "roblox_name": None,
            "game_context": json.dumps(game_context) if game_context is not None else None,
            "verdict": None,
            "triage": None,
            "duplicate_of": None,
            "pr_url": None,
            "lease_until": None,
            "lease_by": None,
            "attachments": [],
        }
        for att in attachments or []:
            data: bytes = att["data"]
            meta = {
                "id": att["id"],
                "report_id": row["id"],
                "created_at": row["created_at"],
                "kind": att.get("kind", "video"),
                "filename": att.get("filename", "clip.mp4"),
                "mime": att.get("mime", "video/mp4"),
                "size_bytes": att.get("size_bytes", len(data)),
                "status": att.get("status", "complete"),
                "completed_at": row["created_at"],
            }
            row["attachments"].append(meta)
            self.blobs[att["id"]] = data
        self.reports[code] = row
        return row

    def fail(self, route: str, status: int, times: int | None = None) -> None:
        if times is None:
            self.always_fail[route] = status
        else:
            self.failures.setdefault(route, []).extend([status] * times)

    def expire_lease(self, code: str | None = None) -> None:
        """Moves the lease of `code` (every lease when None) into the past, as if its minutes had run out."""
        with self._lock:
            for c in [code] if code is not None else list(self.leases):
                if c in self.leases:
                    self.leases[c] = 0
                    if c in self.reports:
                        self.reports[c]["lease_until"] = 0

    def _live_lease(self, code: str) -> bool:
        return self.leases.get(code, 0) > int(time.time() * 1000)

    # -- inspection -----------------------------------------------------------------------------------------
    def calls(self, route: str | None = None, code: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            reqs = list(self.requests)
        return [r for r in reqs if (route is None or r["route"] == route) and (code is None or r.get("code") == code)]

    def json_bodies(self, route: str, code: str | None = None) -> list[Any]:
        out = []
        for r in self.calls(route, code):
            try:
                out.append(json.loads(r["body"].decode("utf-8")))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise AssertionError(f"{route} POST body is not JSON: {r['body'][:200]!r}") from exc
        return out

    # -- HTTP -----------------------------------------------------------------------------------------------
    def _read_body(self, h: http.server.BaseHTTPRequestHandler) -> bytes:
        if h.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while True:
                size = int(h.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    h.rfile.readline()
                    break
                chunks.append(h.rfile.read(size))
                h.rfile.readline()
            return b"".join(chunks)
        length = int(h.headers.get("Content-Length") or 0)
        return h.rfile.read(length) if length else b""

    def _send(self, h: http.server.BaseHTTPRequestHandler, status: int, payload: Any, ctype: str = "application/json") -> None:
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        h.send_response(status)
        h.send_header("Content-Type", ctype)
        h.send_header("Content-Length", str(len(data)))
        h.end_headers()
        h.wfile.write(data)

    def _handle(self, h: http.server.BaseHTTPRequestHandler, method: str) -> None:
        parsed = urllib.parse.urlsplit(h.path)
        body = self._read_body(h)
        route, params = "unknown", {}
        for m, rx, name in _ROUTES:
            match = rx.match(parsed.path)
            if m == method and match:
                route, params = name, match.groupdict()
                break
        record = {
            "method": method,
            "path": parsed.path,
            "query": dict(urllib.parse.parse_qsl(parsed.query)),
            "route": route,
            "code": params.get("code"),
            "attachment": params.get("id"),
            "headers": {k.lower(): v for k, v in h.headers.items()},
            "body": body,
        }
        with self._lock:
            self.requests.append(record)
            queued = self.failures.get(route) or []
            forced = queued.pop(0) if queued else self.always_fail.get(route)
        if h.headers.get("Authorization") != f"Bearer {AGENT_KEY}":
            return self._send(h, 401, {"error": "unauthorized"})
        if forced:
            return self._send(h, forced, {"error": "internal"})
        code = params.get("code")
        if route == "queue":
            limit = int(record["query"].get("limit", "50"))
            with self._lock:
                rows = [r for r in self.reports.values() if r["status"] == "received" and not self._live_lease(r["code"])]
            rows.sort(key=lambda r: r["created_at"])
            items = [{"code": r["code"], "created_at": r["created_at"], "status": r["status"]} for r in rows[:limit]]
            return self._send(h, 200, {"reports": items})
        if route in ("claim", "report", "frames", "triage", "status") and code not in self.reports:
            return self._send(h, 404, {"error": "not_found"})
        if route == "claim":
            try:
                claim = json.loads(body)
                by, minutes = claim.get("by"), claim.get("minutes")
            except (ValueError, AttributeError):
                return self._send(h, 400, {"error": "bad_json"})
            if not isinstance(by, str) or not by:
                return self._send(h, 400, {"error": "invalid_by"})
            if not isinstance(minutes, int) or isinstance(minutes, bool) or not 1 <= minutes <= 60:
                return self._send(h, 400, {"error": "invalid_minutes"})
            with self._lock:
                if code in self.leased or self._live_lease(code):
                    won = None
                else:
                    won = int(time.time() * 1000) + minutes * 60_000
                    self.leases[code] = won
                    self.reports[code]["lease_until"] = won
                    self.reports[code]["lease_by"] = by
            if won is None:
                return self._send(h, 409, {"error": "leased"})
            return self._send(h, 200, {"leaseUntil": won})
        if route == "report":
            return self._send(h, 200, self.reports[code])
        if route == "download":
            att = params.get("id")
            if att not in self.blobs:
                return self._send(h, 404, {"error": "not_found"})
            return self._send(h, 200, self.blobs[att], "application/octet-stream")
        if route == "frames":
            with self._lock:
                self._frames += 1
                n = self._frames
            return self._send(h, 201, {"attachmentId": f"frm-{n:04d}"})
        if route == "triage":
            try:
                verdict = json.loads(body).get("verdict")
            except (ValueError, AttributeError):
                return self._send(h, 400, {"error": "bad_json"})
            self.reports[code]["status"] = {"duplicate": "duplicate", "not_bug": "not_bug"}.get(verdict, "looking")
            return self._send(h, 200, {"ok": True})
        if route == "status":
            try:
                status = json.loads(body).get("status")
            except (ValueError, AttributeError):
                return self._send(h, 400, {"error": "bad_json"})
            self.reports[code]["status"] = status or self.reports[code]["status"]
            return self._send(h, 200, {"ok": True})
        if route == "events":
            return self._send(h, 200, {"events": [], "last": int(record["query"].get("after", "0") or 0)})
        return self._send(h, 404, {"error": "not_found"})


# --------------------------------------------------------------------------------------------------------------
# Fake executables
# --------------------------------------------------------------------------------------------------------------

# Shared prologue: an O_EXCL sequence number keeps records ordered when the agent runs children concurrently.
_PROLOGUE = r'''
import json, os, sys, subprocess, socket, stat, hashlib
def _record(logdir, rec):
    n = 1
    while True:
        p = os.path.join(logdir, "call-%05d.json" % n)
        try:
            fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            n += 1
            continue
        rec["seq"] = n
        with os.fdopen(fd, "w") as f:
            json.dump(rec, f)
        return n
def _scenario():
    with open(SCENARIO) as f:
        return json.load(f)
def _val(argv, flag):
    for i, a in enumerate(argv):
        if a == flag:
            return argv[i + 1] if i + 1 < len(argv) else None
        if a.startswith(flag + "="):
            return a[len(flag) + 1:]
    return None
def _mode(p):
    try:
        return oct(stat.S_IMODE(os.stat(p).st_mode))
    except OSError:
        return None
'''

_FAKE_CLAUDE = r'''
argv = sys.argv[1:]
tools = _val(argv, "--tools")
allowed = _val(argv, "--allowedTools") or ""
if _val(argv, "--input-format") == "stream-json":
    stage = "stage_a"
elif (tools is not None and "Edit" in tools) or "Edit" in allowed:
    stage = "builder"
elif tools is not None:
    stage = "stage_b"
else:
    stage = "unknown"
stdin = sys.stdin.buffer.read().decode("utf-8", "replace")
cwd = os.getcwd()
parent = os.path.dirname(cwd)
try:
    listing = sorted(os.listdir(cwd))
except OSError:
    listing = None
_record(LOGDIR, {"stage": stage, "argv": argv, "stdin": stdin, "cwd": cwd, "env": dict(os.environ),
                 "cwd_mode": _mode(cwd), "parent": parent, "parent_mode": _mode(parent), "cwd_listing": listing})
sc = _scenario().get(stage)
if sc is None:
    sys.stderr.write("fake claude: no scenario for stage %s\n" % stage)
    sys.exit(3)
if sc.get("block_socket"):
    # Lets a spec hold this round inside stage A while it starts a second one (row 10), bounded by a timeout.
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(30)
    try:
        s.connect(sc["block_socket"])
        s.sendall(b"started")
        s.recv(16)
    except OSError:
        pass
    finally:
        s.close()
for rel, content in (sc.get("writes") or {}).items():
    path = os.path.join(cwd, rel)
    if content is None:
        os.remove(path)
        continue
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
mode = sc.get("mode", "json")
def result_line(**kw):
    line = {"type": "result", "subtype": "success", "is_error": False, "duration_ms": 1, "num_turns": 1,
            "session_id": "00000000-0000-0000-0000-000000000000"}
    line.update(kw)
    return json.dumps(line)
if stage == "stage_a" and mode != "text":
    print(json.dumps({"type": "system", "subtype": "init", "session_id": "00000000-0000-0000-0000-000000000000",
                      "tools": [], "model": "claude-opus-5-5"}))
if mode == "json":
    obj = sc["object"]
    print(result_line(result=json.dumps(obj), structured_output=obj))
elif mode == "result_text":
    print(result_line(result=sc["text"]))
elif mode == "is_error":
    print(result_line(subtype="error_during_execution", is_error=True, result="something failed"))
elif mode == "text":
    print(sc["text"])
sys.stdout.flush()
sys.exit(int(sc.get("exit", 0)))
'''

_FAKE_GH = r'''
argv = sys.argv[1:]
body = None
bf = _val(argv, "--body-file")
if bf:
    try:
        with open(bf, encoding="utf-8") as f:
            body = f.read()
    except OSError as e:
        body = "<unreadable: %s>" % e
_record(LOGDIR, {"argv": argv, "env": dict(os.environ), "cwd": os.getcwd(), "body": body})
code = int(_scenario().get("gh_exit", 0))
if code == 0:
    print(PR_URL)
sys.exit(code)
'''

_FAKE_REDTEAM = r'''
argv = sys.argv[1:]
backend = os.environ.get("QG_REDTEAM_BACKEND")
wt = argv[1] if len(argv) > 1 else None
subject = status = None
if wt and os.path.isdir(wt):
    subject = subprocess.run(["git", "-C", wt, "log", "-1", "--format=%s"], capture_output=True, text=True).stdout.strip()
    status = subprocess.run(["git", "-C", wt, "status", "--porcelain"], capture_output=True, text=True).stdout
brief = None
if argv and os.path.isfile(argv[0]):
    with open(argv[0], encoding="utf-8", errors="replace") as f:
        brief = f.read()
_record(LOGDIR, {"argv": argv, "backend": backend, "env": dict(os.environ), "head_subject": subject,
                 "worktree_status": status, "brief": brief})
code = int((_scenario().get("redteam") or {}).get(backend or "default", 0))
if len(argv) > 3:
    with open(argv[3], "w") as f:
        f.write("verdict: %s\n" % ("pass" if code == 0 else "fix"))
sys.exit(code)
'''

_FAKE_GIT_WORKSPACE = r'''
argv = sys.argv[1:]
_record(LOGDIR, {"argv": argv})
rest = list(argv[1:])
branch = None
if "--branch" in rest:
    i = rest.index("--branch")
    branch = rest[i + 1]
    del rest[i:i + 2]
repo, dst, ref = rest
# The real git-workspace.py also runs the placement check; tests use temp dirs, so only the git part is kept.
cmd = ["git", "-C", repo, "worktree", "add"] + (["-b", branch] if branch else ["--detach"]) + ["--", dst, ref]
os.makedirs(os.path.dirname(dst), exist_ok=True)
sys.exit(subprocess.call(cmd))
'''

_MEDIA_SHIM = r'''
argv = sys.argv[1:]
files = []
for a in argv:
    p = a[5:] if a.startswith("file:") else a
    if os.path.isfile(p):
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        files.append({"arg": a, "sha256": h.hexdigest()})
_record(LOGDIR, {"tool": TOOL, "argv": argv, "files": files})
os.execv(REAL, [REAL] + argv)
'''


def _write_exec(path: Path, header: str, body: str) -> None:
    path.write_text(header + _PROLOGUE + body, encoding="utf-8")
    path.chmod(0o755)


# --------------------------------------------------------------------------------------------------------------
# Harness
# --------------------------------------------------------------------------------------------------------------


def _git(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True, timeout=60).stdout


class Harness:
    """One test's world. Everything lives under `self.root` and goes away in the test's cleanups."""

    def __init__(self, test: unittest.TestCase | type[unittest.TestCase], worker_port: int | None = 0) -> None:
        # A class may own the harness (setUpClass) so that several specs read one round: cleanups then run at
        # class teardown and assertions go through a plain TestCase instance.
        if isinstance(test, type):
            self.test = unittest.TestCase()
            self.add_cleanup = test.addClassCleanup
        else:
            self.test = test
            self.add_cleanup = test.addCleanup
        self.root = Path(tempfile.mkdtemp(prefix="lba-"))
        self.add_cleanup(shutil.rmtree, self.root, True)
        self.bin = self.root / "bin"
        self.logs = self.root / "logs"
        self.home = self.root / "home"
        self.state_dir = self.root / "state"
        self.tmp_root = self.root / "tmp"
        self.worktree_root = self.root / "worktrees"
        self.scenario_path = self.root / "scenario.json"
        for d in (self.bin, self.home, self.tmp_root, self.worktree_root):
            d.mkdir(parents=True)
        for name in ("claude", "gh", "redteam", "gw", "media"):
            (self.logs / name).mkdir(parents=True)
        self.git_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.home),
            "GIT_CONFIG_NOSYSTEM": "1",
            "LANG": "C.UTF-8",
        }
        self.scenario: dict[str, Any] = {
            "stage_a": {"mode": "json", "object": dict(VALID_STAGE_A)},
            "stage_b": {"mode": "json", "object": dict(STAGE_B_NEEDS_PERSON)},
            "builder": {"mode": "json", "object": {"summary": "edited"}, "writes": {}},
            "redteam": {"default": 0, "claude": 0},
            "gh_exit": 0,
        }
        self.save_scenario()
        self._write_fakes()
        self._make_repo()
        self.worker: FakeWorker | None = None
        if worker_port is not None:
            self.start_worker(worker_port)

    # -- setup ----------------------------------------------------------------------------------------------
    def start_worker(self, port: int = 0) -> FakeWorker:
        self.worker = FakeWorker(port)
        self.add_cleanup(self.worker.stop)
        return self.worker

    def save_scenario(self) -> None:
        self.scenario_path.write_text(json.dumps(self.scenario), encoding="utf-8")

    def set_stage(self, stage: str, **spec: Any) -> None:
        self.scenario[stage] = spec
        self.save_scenario()

    def _write_fakes(self) -> None:
        def consts(log: str) -> str:
            # Absolute paths are baked in: the agent gives its children a clean environment.
            return f"SCENARIO = {str(self.scenario_path)!r}\nLOGDIR = {str(self.logs / log)!r}\nPR_URL = {PR_URL!r}\n"

        shebang = f"#!{PYTHON}\n"
        _write_exec(self.bin / "claude", shebang + consts("claude"), _FAKE_CLAUDE)
        _write_exec(self.bin / "gh", shebang + consts("gh"), _FAKE_GH)
        # The red team fake is a sh/python polyglot: it works whether the agent execs it or runs `bash <script>`.
        polyglot = f"#!{PYTHON}\n''''exec {PYTHON} \"$0\" \"$@\" #'''\n"
        self.redteam_script = self.root / "redteam_fast.sh"
        _write_exec(self.redteam_script, polyglot + consts("redteam"), _FAKE_REDTEAM)
        self.git_workspace = self.root / "git-workspace.py"
        _write_exec(self.git_workspace, shebang + consts("gw"), _FAKE_GIT_WORKSPACE)
        for tool, real in (("ffmpeg", REAL_FFMPEG), ("ffprobe", REAL_FFPROBE)):
            _write_exec(self.bin / tool, shebang + consts("media") + f"TOOL = {tool!r}\nREAL = {real!r}\n", _MEDIA_SHIM)

    def _make_repo(self) -> None:
        self.fork = self.root / "fork.git"
        self.repo = self.root / "Lumina2"
        seed = self.root / "seed"
        env = self.git_env
        _git("init", "-q", "--bare", "-b", "main", str(self.fork), env=env)
        _git("init", "-q", "-b", "main", str(seed), env=env)
        files = {
            "src/Shared/Greeting.luau": GREETING,
            "src/Server/Inventory/InventoryService.luau": INVENTORY,
            "default.project.json": PROJECT_JSON,
        }
        for rel, content in files.items():
            p = seed / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
        _git("add", "--", *files, cwd=seed, env=env)
        _git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
             "commit", "-q", "-m", "fixture", cwd=seed, env=env)
        _git("push", "-q", str(self.fork), "main", cwd=seed, env=env)
        shutil.rmtree(seed)
        _git("clone", "-q", "-o", "fork", str(self.fork), str(self.repo), env=env)
        self.main_sha = _git("--git-dir", str(self.fork), "rev-parse", "main", env=env).strip()

    # -- running the agent ----------------------------------------------------------------------------------
    def env(self, **overrides: str) -> dict[str, str]:
        e = {
            "PATH": f"{self.bin}:/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.home),
            "USER": os.environ.get("USER") or getpass.getuser(),
            "LANG": "C.UTF-8",
            "TERM": "dumb",
            "TMPDIR": str(self.tmp_root),  # anything the agent leaves in the default temp dir shows up in TMP_ROOT
            "PYTHONDONTWRITEBYTECODE": "1",
            "GIT_CONFIG_NOSYSTEM": "1",
            "PORTAL_API_BASE": self.worker.base_url if self.worker else "http://127.0.0.1:9/api/v1",
            "AGENT_KEY": AGENT_KEY,
            "LUMINA2_REPO": str(self.repo),
            "STATE_DIR": str(self.state_dir),
            "TMP_ROOT": str(self.tmp_root),
            "WORKTREE_ROOT": str(self.worktree_root),
            "DRY_RUN": "0",
            "GIT_WORKSPACE": str(self.git_workspace),
            "REDTEAM_SCRIPT": str(self.redteam_script),
            "CLAUDE_BIN": str(self.bin / "claude"),
            "GH_BIN": str(self.bin / "gh"),
            "FFMPEG_BIN": str(self.bin / "ffmpeg"),
            "FFPROBE_BIN": str(self.bin / "ffprobe"),
        }
        e.update(overrides)
        return e

    def argv(self, *cli: str) -> list[str]:
        return [PYTHON, "-m", "lumina_bug_agent", *(cli or ("run-once",))]

    def run(self, *cli: str, unset: tuple[str, ...] = (), timeout: int = RUN_TIMEOUT, **overrides: str) -> subprocess.CompletedProcess[str]:
        e = self.env(**overrides)
        for k in unset:
            e.pop(k, None)
        return subprocess.run(self.argv(*cli), cwd=AGENT_DIR, env=e, capture_output=True, text=True, timeout=timeout)

    def popen(self, **overrides: str) -> subprocess.Popen[str]:
        p = subprocess.Popen(self.argv(), cwd=AGENT_DIR, env=self.env(**overrides), stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)

        def _reap() -> None:
            if p.poll() is None:
                p.kill()
            try:
                p.communicate(timeout=30)
            except (ValueError, OSError):  # already communicated by the spec
                pass

        self.add_cleanup(_reap)
        return p

    def assert_round_ok(self, p: subprocess.CompletedProcess[str]) -> None:
        msg = f"\n--- exit {p.returncode}\n--- stderr (tail)\n{p.stderr[-3000:]}"
        self.test.assertEqual(p.returncode, 0, "a round must exit 0" + msg)
        self.test.assertNotIn(TRACEBACK, p.stderr, "no Python traceback on stderr" + msg)

    # -- records of the fakes -------------------------------------------------------------------------------
    def _records(self, name: str) -> list[dict[str, Any]]:
        recs = [json.loads(p.read_text()) for p in sorted((self.logs / name).glob("call-*.json"))]
        return sorted(recs, key=lambda r: r["seq"])

    def claude_calls(self, stage: str | None = None) -> list[dict[str, Any]]:
        return [r for r in self._records("claude") if stage is None or r["stage"] == stage]

    def gh_calls(self) -> list[dict[str, Any]]:
        return self._records("gh")

    def redteam_calls(self) -> list[dict[str, Any]]:
        return self._records("redteam")

    def gw_calls(self) -> list[dict[str, Any]]:
        return self._records("gw")

    def media_calls(self, tool: str | None = None) -> list[dict[str, Any]]:
        return [r for r in self._records("media") if tool is None or r["tool"] == tool]

    # -- state ----------------------------------------------------------------------------------------------
    def worktrees(self) -> list[str]:
        out = _git("-C", str(self.repo), "worktree", "list", "--porcelain", env=self.git_env)
        return [line[len("worktree "):] for line in out.splitlines() if line.startswith("worktree ")]

    def local_branches(self, pattern: str = "bugfix/*") -> list[str]:
        out = _git("-C", str(self.repo), "branch", "--list", "--format=%(refname:short)", pattern, env=self.git_env)
        return [b for b in out.splitlines() if b]

    def fork_branches(self) -> list[str]:
        out = _git("--git-dir", str(self.fork), "for-each-ref", "--format=%(refname:short)", "refs/heads", env=self.git_env)
        return [b for b in out.splitlines() if b]

    def fork_diff_names(self, branch: str) -> list[str]:
        out = _git("--git-dir", str(self.fork), "diff", "--name-only", f"main...{branch}", env=self.git_env)
        return [b for b in out.splitlines() if b]

    def fork_show(self, branch: str, path: str) -> str:
        return _git("--git-dir", str(self.fork), "show", f"{branch}:{path}", env=self.git_env)

    def leftovers(self, d: Path) -> list[str]:
        return sorted(str(p.relative_to(d)) for p in d.rglob("*")) if d.exists() else []

    def assert_nothing_left(self) -> None:
        self.test.assertEqual(self.leftovers(self.tmp_root), [], "TMP_ROOT must be empty after the round")
        self.test.assertEqual(self.leftovers(self.worktree_root), [], "WORKTREE_ROOT must hold no worktree after the round")
        self.test.assertEqual(self.worktrees(), [str(self.repo)], "`git worktree list` must show only the main checkout")

    # -- worker views ---------------------------------------------------------------------------------------
    def triages(self, code: str | None = None) -> list[dict[str, Any]]:
        assert self.worker is not None
        return self.worker.json_bodies("triage", code)

    def one_triage(self, code: str) -> dict[str, Any]:
        bodies = self.triages(code)
        self.test.assertEqual(len(bodies), 1, f"exactly one triage POST for {code}, got {len(bodies)}")
        return bodies[0]

    def statuses(self, code: str | None = None) -> list[dict[str, Any]]:
        assert self.worker is not None
        return self.worker.json_bodies("status", code)

    def notes(self, code: str | None = None) -> list[str]:
        return [b.get("note") for b in self.statuses(code) if b.get("note") is not None]


# --------------------------------------------------------------------------------------------------------------
# Small helpers used by several spec files
# --------------------------------------------------------------------------------------------------------------


def argv_value(argv: list[str], flag: str) -> str | None:
    for i, a in enumerate(argv):
        if a == flag:
            return argv[i + 1] if i + 1 < len(argv) else None
        if a.startswith(flag + "="):
            return a[len(flag) + 1:]
    return None


def stage_a_payload(rec: dict[str, Any]) -> tuple[str, list[tuple[str, bytes]]]:
    """Text and images of the stream-json user message the agent wrote on stage A's stdin."""
    text_parts: list[str] = []
    images: list[tuple[str, bytes]] = []
    lines = [line for line in rec["stdin"].splitlines() if line.strip()]
    if not lines:
        raise AssertionError("stage A stdin is empty: the prompt must go on stdin as stream-json")
    for line in lines:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            raise AssertionError(f"stage A stdin line is not stream-json: {line[:200]!r}") from exc
        content = (msg.get("message") or {}).get("content")
        if isinstance(content, str):
            text_parts.append(content)
            continue
        for part in content or []:
            if part.get("type") == "text":
                text_parts.append(part.get("text", ""))
            elif part.get("type") == "image":
                src = part.get("source") or {}
                images.append((src.get("media_type", ""), base64.b64decode(src.get("data", ""))))
    return "\n".join(text_parts), images


PLAYER_BLOCK = re.compile(r"<<<PLAYER_DATA_([0-9a-f]{32})>>>(.*?)<<<END_PLAYER_DATA_\1>>>", re.S)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def mp4_attachment(att_id: str = "att-mp4", **kw: Any) -> dict[str, Any]:
    return {"id": att_id, "kind": "video", "mime": "video/mp4", "filename": "clip.mp4", "data": video_bytes(), **kw}


def file_entry(triage: dict[str, Any], att_id: str) -> dict[str, Any] | None:
    for f in (triage.get("triage") or {}).get("files") or []:
        if f.get("id") == att_id:
            return f
    return None


def is_mode_700(mode: str | None) -> bool:
    return mode == oct(0o700)


def make_lock_holder(path: Path) -> Any:
    """Opens and flocks `path` exclusively; returns the open file (close it to release)."""
    import fcntl

    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+")
    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    return f


__all__ = [name for name in dir() if not name.startswith("_")]
