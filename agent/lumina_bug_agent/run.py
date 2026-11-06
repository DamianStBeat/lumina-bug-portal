"""One round: lock, queue, then per report claim → files → stage A → stage B → triage → stage C."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import tempfile
from pathlib import Path
from typing import Any

from . import AGENT_VERSION, claude_cli, fix, log, media, triage
from .cache import Cache
from .client import Client, TooLarge, WorkerError
from .config import Config
from .lock import round_lock
from .media import MediaError
from .schemas import looks_like_injection, validate_stage_a

CODE_RX = re.compile(r"LUM-\d{6}")
ATTACHMENT_ID_RX = re.compile(r"[A-Za-z0-9_-]{1,64}")
MAX_TRIAGE_BYTES = 32 * 1024
MAX_FAILURES = 3
PLAYER_FIELDS = ("source", "title", "what", "where_area", "device", "lang")
STATUSES = ("received", "looking", "fixed", "duplicate", "not_bug", "closed")
EVENT_PAGES = 10
MAX_SEEDS = 50  # GET /agent/reports/{code} per round for codes the cache does not know (sync_events)
SEED_STALL = "seed_stall"  # meta key: "<code> <rounds>", the code whose failing GET stopped the events cursor
STALL_ROUNDS = 3  # rounds in a row a failing seed may stop the cursor before it is let go


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _terminate(signum: int, _frame: Any) -> None:
    # systemd stops a unit with SIGTERM: as an exception every `finally` runs (worktrees, temp dirs, children).
    log("terminated", signal=signum)
    raise SystemExit(128 + signum)


def run_round(cfg: Config) -> int:
    signal.signal(signal.SIGTERM, _terminate)
    with round_lock(cfg.state_dir) as held:
        if not held:
            log("another round is running")
            return 0
        cache = Cache(cfg.state_dir / "cache.sqlite3")
        try:
            Round(cfg, Client(cfg.api_base, cfg.agent_key), cache).run()
        finally:
            cache.close()
    return 0


def _clip(value: Any, width: int) -> Any:
    if isinstance(value, str):
        return value[:width]
    if isinstance(value, list):
        return [_clip(v, width) for v in value[:10]]
    if isinstance(value, dict):
        return {k: _clip(v, width) for k, v in value.items()}
    return value


def fit_triage(triage: dict[str, Any]) -> dict[str, Any]:
    """The triage JSON within the worker's 32 KB: clipped strings first, then without the stage answers."""
    if len(json.dumps(triage)) <= MAX_TRIAGE_BYTES:
        return triage
    clipped = dict(triage, stage_a=_clip(triage["stage_a"], 200), stage_b=_clip(triage["stage_b"], 200))
    clipped["notes"] = [*triage["notes"], "triage_clipped"]
    if len(json.dumps(clipped)) <= MAX_TRIAGE_BYTES:
        return clipped
    return dict(clipped, stage_a=None, stage_b=None, files=triage["files"][:3], notes=["triage_too_large"])


def _game_context(row: dict[str, Any]) -> Any:
    context = row.get("game_context")  # a JSON string in D1; kept as text when it does not parse
    if isinstance(context, str):
        try:
            return json.loads(context)
        except ValueError:
            pass
    return context


class Round:
    def __init__(self, cfg: Config, client: Client, cache: Cache) -> None:
        self.cfg, self.client, self.cache = cfg, client, cache
        self.fetched = False  # `git fetch` once per round, on the first stage B
        self.seeds = 0  # reports fetched this round to fill the duplicate list (sync_events)
        self.stalled = False  # this round's events stopped on a seed whose GET failed (stall)

    def run(self) -> None:
        if not self.cfg.dry_run:
            fix.send_pending(self.client, self.cache)  # status POSTs an earlier round could not deliver
        try:
            answer = self.client.get_json(f"/agent/queue?limit={self.cfg.max_reports_per_round}")
        except WorkerError as exc:
            down = exc.status is None or exc.status >= 500
            log("worker unreachable" if down else "queue refused", status=exc.status or "none")
            return
        items = answer.get("reports") if isinstance(answer, dict) else answer
        if not isinstance(items, list):
            log("queue refused", status="bad_answer")
            return
        self.cfg.tmp_root.mkdir(parents=True, exist_ok=True)
        if items and not self.cfg.dry_run:
            self.sync_events()
        for item in items:
            code = item.get("code") if isinstance(item, dict) else None
            if not isinstance(code, str) or not CODE_RX.fullmatch(code):
                log("queue item skipped", reason="bad_code")
                continue
            if not self.cfg.dry_run and self.cache.count("triage") >= self.cfg.daily_triage_cap:
                log("daily triage cap reached", cap=self.cfg.daily_triage_cap)
                break
            self.report(code)

    def report(self, code: str) -> None:
        dry = self.cfg.dry_run
        if dry:
            if self.cache.dry_run_seen(code):
                return
            log("dry run: would claim", code=code)
        elif not self.claim(code):
            return
        tmp = Path(tempfile.mkdtemp(prefix="lba-r-", dir=self.cfg.tmp_root))
        try:
            os.chmod(tmp, 0o700)
            self.process(code, tmp)
        except WorkerError as exc:
            attempts = 0 if dry else self.cache.bump_failure(code)
            log("report failed", code=code, status=exc.status or "none", attempts=attempts)
        except Exception as exc:  # one bad report must not end the round, nor print a traceback holding its data
            attempts = 0 if dry else self.cache.bump_failure(code)
            log("report error", code=code, error=type(exc).__name__, attempts=attempts)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def claim(self, code: str) -> bool:
        body = {"by": self.cfg.agent_id, "minutes": self.cfg.lease_minutes}
        try:
            self.client.post_json(f"/agent/reports/{code}/claim", body)
        except WorkerError as exc:
            log("leased" if exc.status == 409 else "claim failed", code=code, status=exc.status or "none")
            return False
        return True

    def process(self, code: str, tmp: Path) -> None:
        cfg, dry = self.cfg, self.cfg.dry_run
        if not dry and self.cache.failures(code) >= MAX_FAILURES:
            self.post_triage(code, "unclear", None, None, [], ["agent_failed"])
            self.cache.clear_failures(code)
            return
        answer = self.client.get_json(f"/agent/reports/{code}")
        if not isinstance(answer, dict):
            raise ValueError("report answer is not an object")
        row = answer["report"] if isinstance(answer.get("report"), dict) else answer
        attachments = answer.get("attachments") or row.get("attachments") or []
        files, images, uploads = self.files(code, attachments if isinstance(attachments, list) else [], tmp)
        for att_id, n, sheet in uploads:
            if dry:
                log("dry run: would upload frames", code=code, attachment=att_id, sheet=n)
                continue
            headers = {"Content-Type": "image/jpeg", "X-Filename": f"frames-{att_id}-{n}.jpg"}
            try:
                self.client.post_bytes(f"/agent/reports/{code}/frames", sheet.read_bytes(), headers)
            except WorkerError as exc:
                # A failed attempt, before stage A: once triaged the report leaves the queue, its sheets unsent.
                log("frames upload failed", code=code, attachment=att_id, status=exc.status or "none")
                raise
        if dry:
            for step in ("run stage A", "run stage B", "post triage"):
                log(f"dry run: would {step}", code=code, images=len(images))
            self.cache.mark_dry_run(code)
            return
        work = tmp / "a"  # stage A's cwd: empty, the raw files stay outside it
        work.mkdir(mode=0o700)
        self.cache.bump("triage")
        stage_a = validate_stage_a(claude_cli.stage_a(cfg, self.stage_a_prompt(row), images, work))
        stage_b: dict[str, Any] | None = None
        if stage_a is None:
            verdict, notes = "unclear", ["stage_a_invalid"]
        else:
            if looks_like_injection(row.get("what"), row.get("title")):
                stage_a["injection_suspected"] = True
            stage_b = self.stage_b(code, row, stage_a)
            verdict, notes = (stage_b["verdict"], []) if stage_b else ("unclear", ["stage_b_invalid"])
        self.post_triage(code, verdict, stage_a, stage_b, files, notes)
        self.cache.clear_failures(code)
        if stage_a is not None:
            status = {"duplicate": "duplicate", "not_bug": "not_bug"}.get(verdict, "looking")  # as the worker sets it
            summary = stage_b["summary"] if stage_b else ""
            self.cache.remember(code, stage_a["what"][:300], summary, verdict, status)
        if stage_a is not None and stage_b is not None:
            # Eligibility, the builder, the path guard, both red teams, the draft PR; files under `tmp`.
            fix.run(cfg, self.client, self.cache, code, row, stage_a, stage_b, tmp)

    def stage_b(self, code: str, row: dict[str, Any], stage_a: dict[str, Any]) -> dict[str, Any] | None:
        if not self.fetched:
            triage.fetch(self.cfg)  # GitError: no verdict on stale or missing code, the report is retried
            self.fetched = True
        # The duplicate list carries stage A's summaries, never another report's raw text (see remember above).
        return triage.run(self.cfg, code, stage_a, _game_context(row), self.cache.recent(exclude=code))

    def sync_events(self) -> None:
        """Statuses of remembered reports, and unknown ones (seed), from GET /agent/events; a failure is not fatal.
        The cursor moves only past handled events: the first one not handled (its seed hit the cap or a failing GET)
        stops the reading, and it is read again next round with everything after it."""
        cursor = self.cache.meta("events_cursor") or "0"
        try:
            for _ in range(EVENT_PAGES):
                answer = self.client.get_json(f"/agent/events?after={cursor}&limit=200")
                events = answer.get("events") if isinstance(answer, dict) else None
                last = answer.get("last") if isinstance(answer, dict) else None
                if not isinstance(events, list) or isinstance(last, bool) or not isinstance(last, int):
                    raise ValueError("events answer")
                if not all(isinstance(ev, dict) and _is_int(ev.get("seq")) for ev in events):
                    raise ValueError("event seq")  # the cursor can only be saved at a seq it can trust
                handled = 0
                while handled < len(events) and self.apply_event(events[handled]):
                    handled += 1
                if handled < len(events):
                    if handled:
                        self.cache.set_meta("events_cursor", str(events[handled - 1]["seq"]))
                    break
                if not events or str(last) == cursor:
                    break
                cursor = str(last)
                self.cache.set_meta("events_cursor", cursor)
            if not self.stalled and self.cache.meta(SEED_STALL):
                self.cache.set_meta(SEED_STALL, "")  # this round did not stop on a failing GET: the count restarts
        except WorkerError as exc:
            log("events failed", status=exc.status or "none")
        except ValueError:
            log("events failed", status="bad_answer")

    def apply_event(self, ev: dict[str, Any]) -> bool:
        """False when the event is not handled yet (its seed must be tried again next round)."""
        if not isinstance(ev.get("code"), str):
            return True
        if ev.get("type") in ("created", "triaged") and not self.seed(ev["code"], refresh=ev.get("type") == "triaged"):
            return False
        data = ev.get("data")
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except ValueError:
                data = None
        status = (data.get("status") or data.get("to")) if isinstance(data, dict) else None
        if ev.get("type") == "duplicate_linked" and status is None:
            status = "duplicate"
        if status in STATUSES:
            self.cache.set_status(ev["code"], status)
        return True

    def seed(self, code: str, refresh: bool) -> bool:
        """An unknown report joins the duplicate list: its title and the triage's summary, never the player's text.
        `refresh` (a `triaged` event): a report cached before its triage, with no summary, is fetched again.
        False: not handled, to be tried next round (the cap of 50 reached, or a GET that may answer later)."""
        if not CODE_RX.fullmatch(code):
            return True
        known = self.cache.summary_of(code)
        if known is not None and (known or not refresh):
            return True
        if self.seeds >= MAX_SEEDS:
            return False
        self.seeds += 1
        try:
            answer = self.client.get_json(f"/agent/reports/{code}")
        except WorkerError as exc:
            if not fix.transient(exc.status):
                log("seed dropped", code=code, status=exc.status)  # deleted or refused: it must not hold the cursor
                return True
            log("seed failed", code=code, status=exc.status or "none")
            return self.stall(code)
        row = answer.get("report") if isinstance(answer, dict) and isinstance(answer.get("report"), dict) else answer
        if not isinstance(row, dict):
            log("seed failed", code=code, status="bad_answer")
            return self.stall(code)
        found = row.get("triage")  # a JSON string in D1, null until triaged
        if isinstance(found, str):
            try:
                found = json.loads(found)
            except ValueError:
                found = None
        stage_b = found.get("stage_b") if isinstance(found, dict) else None
        summary = stage_b.get("summary") if isinstance(stage_b, dict) else None
        title, verdict, status = row.get("title"), row.get("verdict"), row.get("status")
        self.cache.remember(code, title[:200] if isinstance(title, str) else "",
                            summary[:300] if isinstance(summary, str) else "",
                            verdict if isinstance(verdict, str) else None,  # None: not triaged yet, not a verdict
                            status if status in STATUSES else None)  # fmt: skip
        return True

    def stall(self, code: str) -> bool:
        """A seed GET failed. Not handled, unless the same code stopped the cursor the two rounds before as well: then
        it is let go (`seed skipped`), so one report the worker cannot serve never blocks the events for good."""
        before = (self.cache.meta(SEED_STALL) or "").split()
        rounds = int(before[1]) + 1 if len(before) == 2 and before[0] == code and before[1].isdigit() else 1
        if rounds >= STALL_ROUNDS:
            log("seed skipped", code=code, rounds=rounds)
            self.cache.set_meta(SEED_STALL, "")
            return True
        self.cache.set_meta(SEED_STALL, f"{code} {rounds}")
        self.stalled = True
        return False

    def stage_a_prompt(self, row: dict[str, Any]) -> str:
        data: dict[str, Any] = {k: row.get(k) for k in PLAYER_FIELDS}
        data["game_context"] = _game_context(row)
        nonce, block = claude_cli.data_block(data)
        # NONCE first: the player data is inserted last, so text in it is never treated as a placeholder.
        return claude_cli.render("stage_a.md", {"NONCE": nonce, "PLAYER_DATA": block})

    def files(self, code: str, attachments: list[Any], tmp: Path) -> tuple[list[dict[str, Any]], list[Path], list[Any]]:
        entries: list[dict[str, Any]] = []
        images: list[Path] = []
        uploads: list[tuple[str, int, Path]] = []
        for att in attachments:
            if not isinstance(att, dict) or att.get("kind") not in ("video", "image") or att.get("status") != "complete":
                continue
            att_id = att.get("id")
            if not isinstance(att_id, str) or not ATTACHMENT_ID_RX.fullmatch(att_id):
                log("attachment skipped", code=code, reason="bad_id")
                continue
            entry: dict[str, Any] = {"id": att_id, "status": "skipped"}
            try:
                entry = {"id": att_id, **self.one_file(att, tmp / f"{len(entries) + 1}.bin", images, uploads)}
            except MediaError as exc:
                entry["reason"] = exc.reason
            entries.append(entry)
            log("file checked", code=code, attachment=att_id, status=entry["status"], reason=entry.get("reason", "-"))
        return entries, images, uploads

    def one_file(self, att: dict[str, Any], dest: Path, images: list[Path], uploads: list[Any]) -> dict[str, Any]:
        size = att.get("size_bytes")
        if isinstance(size, int) and size > media.MAX_BYTES:
            raise MediaError("too_large")
        try:
            try:
                self.client.download(f"/agent/attachments/{att['id']}/download", dest, media.MAX_BYTES)
            except TooLarge:
                raise MediaError("too_large") from None
            except WorkerError:
                raise MediaError("download_failed") from None
            info = media.probe(self.cfg, dest)
            if info["kind"] == "image":
                images.append(media.image_for_stage_a(self.cfg, dest, dest.parent))
                return {"status": "ok", "kind": "image"}
            count, sheets = media.video_sheets(self.cfg, dest, dest.parent)
            images.extend(sheets)
            uploads.extend((att["id"], n, sheet) for n, sheet in enumerate(sheets, 1))
            return {"status": "ok", "kind": "video", "duration": round(info["duration"], 1), "frames": count,
                    "sheets": len(sheets)}  # fmt: skip
        finally:
            dest.unlink(missing_ok=True)  # up to 2 GiB each: gone as soon as the frames exist

    def post_triage(
        self, code: str, verdict: str, stage_a: Any, stage_b: Any, files: list[Any], notes: list[str]
    ) -> None:
        triage = {"stage_a": stage_a, "stage_b": stage_b, "files": files, "notes": notes, "agent": AGENT_VERSION}
        duplicate = stage_b.get("duplicate_of") if verdict == "duplicate" and isinstance(stage_b, dict) else None
        body = {"verdict": verdict, "triage": fit_triage(triage), "duplicateOf": duplicate}
        self.client.post_json(f"/agent/reports/{code}/triage", body)
        log("triaged", code=code, verdict=verdict, files=len(files))
