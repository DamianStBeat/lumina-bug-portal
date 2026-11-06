"""Untrusted player files: magic sniff, ffprobe allowlist, frames into contact sheets. Audio is never extracted."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from . import log
from .claude_cli import run_child
from .config import Config

MAX_BYTES = 2 * 1024**3
MAX_SECONDS = 30 * 60
MAX_FRAMES = 48
PER_SHEET = 12  # tile 4x3
MAX_SHEET_BYTES = 10 * 1024 * 1024
FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,png_pipe,jpeg_pipe,gif,webp_pipe,image2"
IMAGE_FORMATS = {"png_pipe", "jpeg_pipe", "webp_pipe", "image2"}
PROBE_TIMEOUT = 60
FRAMES_TIMEOUT = 1200
SMALL_TIMEOUT = 120
# Safe input options for every ffmpeg/ffprobe call: local files only, allowlisted demuxers only.
_INPUT_GUARD = ["-protocol_whitelist", "file", "-format_whitelist", FORMATS]
# ffmpeg starts one decoder/filter/encoder thread per CPU (64 on Valor1), each with its own frame buffers: two keep
# a 1080p frame extraction near 106 MB instead of 208 MB, under the 250 MB per-process target.
_THREADS = ["-threads", "2"]


class MediaError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def sniff(path: Path) -> str | None:
    """'video', 'image' or None from the first bytes, before any ffmpeg code reads the file."""
    with open(path, "rb") as f:
        head = f.read(16)
    if head[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free") or head[:4] == b"\x1a\x45\xdf\xa3":
        return "video"
    if head[:4] == b"RIFF" and head[8:12] == b"AVI ":
        return "video"
    if head[:8] == b"\x89PNG\r\n\x1a\n" or head[:3] == b"\xff\xd8\xff" or head[:4] == b"GIF8":
        return "image"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image"
    return None


def _ffmpeg(cfg: Config, src: Path, tail: list[str], timeout: float, cwd: Path) -> None:
    argv = [cfg.ffmpeg_bin, "-nostdin", "-v", "error", "-filter_threads", "2", *_THREADS, *_INPUT_GUARD, "-i", str(src),
            "-an", "-sn", "-dn", *_THREADS, *tail]  # fmt: skip
    try:
        code, _, _ = run_child(argv, timeout, cwd=cwd)
    except (subprocess.TimeoutExpired, OSError):
        raise MediaError("ffmpeg_failed") from None
    if code != 0:
        raise MediaError("ffmpeg_failed")


def probe(cfg: Config, path: Path) -> dict[str, Any]:
    """{'kind': 'video'|'image', 'duration': float|None}; MediaError not_media / too_long otherwise."""
    if sniff(path) is None:
        raise MediaError("not_media")
    argv = [cfg.ffprobe_bin, "-v", "error", *_THREADS, *_INPUT_GUARD, "-show_format", "-show_streams", "-of", "json",
            str(path)]  # fmt: skip
    try:
        code, out, _ = run_child(argv, PROBE_TIMEOUT, cwd=path.parent)
        info = json.loads(out) if code == 0 else None
    except (subprocess.TimeoutExpired, OSError, ValueError):
        info = None
    fmt = (info or {}).get("format") or {}
    streams = (info or {}).get("streams") or []
    name = fmt.get("format_name")
    if not isinstance(name, str) or not set(name.split(",")) & set(FORMATS.split(",")):
        raise MediaError("not_media")
    if not any(isinstance(s, dict) and s.get("codec_type") == "video" for s in streams):
        raise MediaError("not_media")
    if set(name.split(",")) & IMAGE_FORMATS:
        return {"kind": "image", "duration": None}
    try:
        duration = float(fmt["duration"])
    except (KeyError, TypeError, ValueError):
        # A video whose length ffprobe cannot tell is not one we can bound: treat it as not a usable video.
        raise MediaError("not_media") from None
    if duration > MAX_SECONDS:
        raise MediaError("too_long")
    return {"kind": "video", "duration": duration}


def video_sheets(cfg: Config, src: Path, work: Path) -> tuple[int, list[Path]]:
    """(frames kept, sheets). Scene changes plus at least one frame every 2 s, thinned evenly to 48."""
    frames_dir = work / f"{src.stem}-frames"
    frames_dir.mkdir(mode=0o700)
    vf = r"scale=640:-2,select='gt(scene\,0.08)+isnan(prev_selected_t)+gte(t-prev_selected_t\,2)'"
    has_font = cfg.frame_font.is_file()  # FRAME_FONT, FreeSans by default
    if not has_font:
        log("no font file for timestamps, fontconfig Sans", font=cfg.frame_font)
    # Never a sheet without times: if drawtext cannot draw with either font, ffmpeg fails and the file is ffmpeg_failed.
    font = f"fontfile={cfg.frame_font}" if has_font else "font=Sans"
    vf += (
        f",drawtext={font}:text='%{{pts\\:gmtime\\:0\\:%M\\\\\\:%S}}'"
        ":x=8:y=8:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6"
    )
    _ffmpeg(cfg, src, ["-vf", vf, "-fps_mode", "vfr", "-q:v", "3", str(frames_dir / "f-%05d.jpg")],
            FRAMES_TIMEOUT, frames_dir)  # fmt: skip
    found = sorted(frames_dir.glob("f-*.jpg"))
    if len(found) > MAX_FRAMES:
        found = [found[round(i * (len(found) - 1) / (MAX_FRAMES - 1))] for i in range(MAX_FRAMES)]
    if not found:
        raise MediaError("ffmpeg_failed")
    for n, frame in enumerate(found, 1):
        frame.rename(frames_dir / f"s-{n:03d}.jpg")
    sheets_dir = work / f"{src.stem}-sheets"
    sheets_dir.mkdir(mode=0o700)
    _ffmpeg(cfg, frames_dir / "s-%03d.jpg", ["-vf", "tile=4x3", "-fps_mode", "vfr", "-q:v", "3",
            str(sheets_dir / "sheet-%d.jpg")], SMALL_TIMEOUT, sheets_dir)  # fmt: skip
    sheets = sorted(sheets_dir.glob("sheet-*.jpg"), key=lambda p: int(p.stem.split("-")[1]))
    kept = [s for s in sheets if s.stat().st_size <= MAX_SHEET_BYTES]
    if len(kept) < len(sheets):
        log("sheet over 10 MB dropped", count=len(sheets) - len(kept))
    return len(found), kept


def image_for_stage_a(cfg: Config, src: Path, work: Path) -> Path:
    out = work / f"{src.stem}-image.jpg"
    _ffmpeg(cfg, src, ["-vf", "scale='min(1280,iw)':-2", "-frames:v", "1", "-q:v", "3", str(out)], SMALL_TIMEOUT, work)
    return out
