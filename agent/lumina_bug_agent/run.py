"""One round: lock, queue, then per report claim → files → stage A → stage B → triage → stage C."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from . import AGENT_VERSION, claude_cli, log, media
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


def run_stage_b(cfg: Config, cache: Cache, code: str, row: dict[str, Any], stage_a: dict[str, Any]) -> dict[str, Any] | None:
    """Seam for round 2 (triage.py): the validated stage B answer, or None while stage B does not exist yet."""
    return None


def run_stage_c(
    cfg: Config, client: Client, cache: Cache, code: str, row: dict[str, Any], stage_a: dict[str, Any],
    stage_b: dict[str, Any],
) -> None:  # fmt: skip
    """Seam for round 3 (fix.py): eligibility, the builder, the path guard, both red teams, the draft PR."""
    return None


def run_round(cfg: Config) -> int:
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


class Round:
    def __init__(self, cfg: Config, client: Client, cache: Cache) -> None:
        self.cfg, self.client, self.cache = cfg, client, cache

    def run(self) -> None:
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
            except WorkerError as exc:  # the sheets help a person; the triage does not depend on them
                log("frames upload failed", code=code, attachment=att_id, status=exc.status or "none")
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
            stage_b = run_stage_b(cfg, self.cache, code, row, stage_a)
            # Until round 2 lands stage B, a person looks at every report that stage A could read.
            verdict, notes = (stage_b["verdict"], []) if stage_b else ("needs_person", ["stage_b_not_run"])
        self.post_triage(code, verdict, stage_a, stage_b, files, notes)
        self.cache.clear_failures(code)
        if stage_a is not None and stage_b is not None:
            run_stage_c(cfg, self.client, self.cache, code, row, stage_a, stage_b)

    def stage_a_prompt(self, row: dict[str, Any]) -> str:
        data: dict[str, Any] = {k: row.get(k) for k in PLAYER_FIELDS}
        context = row.get("game_context")
        if isinstance(context, str):
            try:
                context = json.loads(context)
            except ValueError:
                pass
        data["game_context"] = context
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
