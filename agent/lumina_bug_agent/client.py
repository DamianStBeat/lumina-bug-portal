"""The worker's `/agent/*` API over `urllib.request` (CONTRACT.md "Agent and bot")."""

from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

TIMEOUT = 30
CHUNK = 1 << 20


class WorkerError(Exception):
    """`status` is the HTTP status, or None when the worker could not be reached at all."""

    def __init__(self, status: int | None) -> None:
        super().__init__(f"worker status {status}")
        self.status = status


class TooLarge(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # urllib forwards Authorization on a redirect, possibly to another host: the worker never redirects us.
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class Client:
    def __init__(self, base: str, key: str) -> None:
        self._base = base
        self._key = key
        # No proxy from the environment either: the bearer goes only to PORTAL_API_BASE.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _open(self, method: str, path: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
        req = urllib.request.Request(self._base + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._key}")
        for name, value in (headers or {}).items():
            req.add_header(name, value)
        try:
            return self._opener.open(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise WorkerError(exc.code) from None
        # A bad status line or header from the worker comes out of urllib as http.client's own error, not OSError.
        except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
            raise WorkerError(None) from None

    def _json(self, method: str, path: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
        resp = self._open(method, path, data, headers)
        try:
            with resp:
                raw = resp.read()
            return json.loads(raw) if raw.strip() else None
        # A reply cut short (IncompleteRead) is an HTTPException, not an OSError: still "the worker failed".
        except (OSError, ValueError, http.client.HTTPException):
            raise WorkerError(resp.status) from None

    def get_json(self, path: str) -> Any:
        return self._json("GET", path)

    def post_json(self, path: str, body: Any) -> Any:
        data = json.dumps(body).encode("utf-8")
        return self._json("POST", path, data, {"Content-Type": "application/json"})

    def post_bytes(self, path: str, data: bytes, headers: dict[str, str]) -> Any:
        return self._json("POST", path, data, headers)

    def download(self, path: str, dest: Path, cap: int) -> int:
        """Streams to `dest`; past `cap` bytes it stops and raises TooLarge (the caller deletes the file)."""
        resp = self._open("GET", path)
        total = 0
        try:
            with resp, open(dest, "wb") as out:
                while chunk := resp.read(CHUNK):
                    total += len(chunk)
                    if total > cap:
                        raise TooLarge()
                    out.write(chunk)
        except (OSError, http.client.HTTPException):  # a download cut short: the caller notes download_failed
            raise WorkerError(None) from None
        # A streamed read(amt) returns short at EOF without raising: only the declared length shows a cut-off file,
        # which must never reach ffprobe. An absent or unreadable header leaves nothing to compare.
        declared = resp.headers.get("Content-Length", "").strip()
        if declared.isascii() and declared.isdigit() and int(declared) != total:
            raise WorkerError(resp.status)
        return total
