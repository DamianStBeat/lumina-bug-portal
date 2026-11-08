"""The worker's `/agent/*` API over `urllib.request` (CONTRACT.md "Agent and bot")."""

from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, BinaryIO

TIMEOUT = 30
CHUNK = 1 << 20
MAX_ERROR_BODY = 1024  # an error answer is one short JSON object: nothing longer is worth reading
# What the bucket answers when a signed URL expired. Hosted Supabase may send an expired one as HTTP 400 with
# `statusCode: "403"` in the body, so 400 counts too. A 5xx says nothing about the URL.
EXPIRED_URL = (400, 401, 403)


class WorkerError(Exception):
    """`status` is the HTTP status, or None when the worker could not be reached at all."""

    def __init__(self, status: int | None) -> None:
        super().__init__(f"worker status {status}")
        self.status = status


class StatusChanged(WorkerError):
    """409 `status_changed`: the report is no longer in the status this write named as `expectedStatus` (CONTRACT.md
    "Agent and bot"), so nothing was written. `current` is the status it has now, "" when the answer named none."""

    def __init__(self, current: str) -> None:
        super().__init__(409)
        self.current = current


class TooLarge(Exception):
    pass


class _UrlExpired(WorkerError):
    """The bucket refused a signed URL: a new manifest may help, once."""


def _is_count(value: Any) -> bool:
    return type(value) is int and value > 0  # type(): JSON's `true` is an int to isinstance


def _status_changed(exc: urllib.error.HTTPError) -> str | None:
    """The current status of a 409 `status_changed`; None for any other 409 (`leased`, `duplicate_cycle`, ...)."""
    try:
        answer = json.loads(exc.read(MAX_ERROR_BODY))
    except (OSError, ValueError, http.client.HTTPException):
        return None
    if not isinstance(answer, dict) or answer.get("error") != "status_changed":
        return None
    status = answer.get("status")
    return status if isinstance(status, str) else ""


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
            current = _status_changed(exc) if exc.code == 409 else None
            exc.close()
            if current is not None:
                raise StatusChanged(current) from None
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

    def _manifest(self, path: str, cap: int) -> list[tuple[str, int]]:
        """The (url, size) of each part, ascending n (CONTRACT.md "Download routes"). WorkerError for anything else than
        the contract's shape; TooLarge when the declared size is past `cap`, before a single byte is fetched."""
        answer = self.get_json(path)
        parts = answer.get("parts") if isinstance(answer, dict) else None
        if not isinstance(parts, list) or not parts:
            raise WorkerError(200)
        plan: list[tuple[str, int]] = []
        for n, part in enumerate(parts, 1):
            numbered = isinstance(part, dict) and _is_count(part.get("n")) and part["n"] == n
            url = part.get("url") if numbered and _is_count(part.get("size")) else None
            # urllib also opens file: and ftp: URLs: a broken manifest must not turn into a local file read.
            if not isinstance(url, str) or not url.startswith(("https://", "http://")):
                raise WorkerError(200)
            plan.append((url, part["size"]))
        declared = answer.get("sizeBytes")
        if not _is_count(declared) or declared != sum(size for _, size in plan):
            raise WorkerError(200)
        if declared > cap:
            raise TooLarge()
        return plan

    def _open_storage(self, url: str) -> Any:
        # A signed URL is its own credential: this request is built apart so the bearer can never go with it.
        try:
            return self._opener.open(urllib.request.Request(url), timeout=TIMEOUT)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise (_UrlExpired if exc.code in EXPIRED_URL else WorkerError)(exc.code) from None
        except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
            raise WorkerError(None) from None

    def _read_part(self, url: str, size: int, out: BinaryIO) -> None:
        resp = self._open_storage(url)
        got = 0
        try:
            with resp:
                while chunk := resp.read(CHUNK):
                    got += len(chunk)
                    if got > size:
                        raise WorkerError(resp.status)
                    out.write(chunk)
        except (OSError, http.client.HTTPException):  # a part cut short: the caller notes download_failed
            raise WorkerError(None) from None
        # A streamed read(amt) returns short at EOF without raising: only the size in the manifest shows a cut-off part,
        # which must never reach ffprobe.
        if got != size:
            raise WorkerError(resp.status)

    def download(self, path: str, dest: Path, cap: int) -> int:
        """Joins the parts of the manifest at `path` into `dest`, in order. Every part is checked against its declared
        size, so nothing past `cap` is ever written. A signed URL that expired gets one new manifest for the whole
        download and it goes on from that part (the caller deletes the file on any failure)."""
        plan = self._manifest(path, cap)
        renewed = False
        index = 0
        try:
            with open(dest, "wb") as out:
                while index < len(plan):
                    url, size = plan[index]
                    try:
                        self._read_part(url, size, out)
                    except _UrlExpired:  # refused before any byte of this part was written
                        if renewed:
                            raise
                        renewed = True
                        fresh = self._manifest(path, cap)
                        # The parts already joined were cut by the first manifest: another plan would mix two files.
                        if [s for _, s in fresh] != [s for _, s in plan]:
                            raise WorkerError(200) from None
                        plan = fresh
                        continue
                    index += 1
        except OSError:  # the disk, not the network: the caller notes download_failed all the same
            raise WorkerError(None) from None
        return sum(size for _, size in plan)
