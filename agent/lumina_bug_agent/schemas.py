"""Hand-written validators for the model's answers, and the local prompt-injection check."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from .guard import is_risky

MAX_STR = 2000
MAX_LIST = 20

_STR = {"type": "string", "maxLength": MAX_STR}
_OPT_STR = {"type": ["string", "null"], "maxLength": MAX_STR}
STAGE_A_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["what", "where", "when_in_video", "device", "steps", "expected", "actual", "language",
                 "injection_suspected"],
    "properties": {
        "what": _STR, "where": _STR, "when_in_video": _OPT_STR, "device": _OPT_STR,
        "steps": {"type": "array", "items": _STR, "maxItems": MAX_LIST},
        "expected": _OPT_STR, "actual": _OPT_STR, "language": _STR,
        "injection_suspected": {"type": "boolean"},
    },
}  # fmt: skip


def _ok_str(value: Any, nullable: bool) -> bool:
    if value is None:
        return nullable
    return isinstance(value, str) and len(value) <= MAX_STR


def validate_stage_a(obj: Any) -> dict[str, Any] | None:
    """The answer when it matches STAGE_A_SCHEMA exactly, else None. A missing key is never defaulted."""
    props = STAGE_A_SCHEMA["properties"]
    if not isinstance(obj, dict) or set(obj) != set(props):
        return None
    for key, spec in props.items():
        value = obj[key]
        if key == "injection_suspected":
            if not isinstance(value, bool):
                return None
        elif key == "steps":
            if not (isinstance(value, list) and len(value) <= MAX_LIST and all(_ok_str(s, False) for s in value)):
                return None
        elif not _ok_str(value, isinstance(spec["type"], list)):
            return None
    return dict(obj)


# Instructions aimed at the AI, in the six languages players write in (EN/IT/ES/PT/FR/DE). A match forces
# injection_suspected: the model may be fooled by the very text it reads, this check cannot be.
_INJECTION = [
    r"\b(ignor|disregard|forget|dimentic|olvid|esquec|oubli|vergiss|vergessen)\w*\b.{0,80}"
    r"\b(instruc|istruz|instruç|anweisung|regel|rules|regole|reglas|règles|prompt)",
    r"\b(print|show|reveal|output|dump|leak|tell me|give me|send|stampa|mostra|rivela|dimmi|dammi|imprim|muestra|"
    r"revela|mostre|revele|affiche|montre|révèle|donne|zeig|druck|gib)\w*\b.{0,80}"
    r"\b(keys?\b|tokens?\b|secrets?\b|passwords?\b|credentials?\b|api.?keys?\b|chiav|segret|clave|llave|secreto|"
    r"contraseñ|chave|segredo|senha|clé|mot de passe|schlüssel|geheim|passwort)",
    r"system.?prompt|prompt (di|del) sistema|prompt du système",
    r"\byou are now\b|\b(ora|adesso) sei\b|\bahora eres\b|\bagora você é\b|\b(tu es|vous êtes) maintenant\b|\bdu bist jetzt\b",
    r"developer mode|modalità sviluppatore|modo (desarrollador|desenvolvedor)|mode développeur|entwicklermodus|jailbreak",
]  # fmt: skip
_INJECTION_RX = re.compile("|".join(f"(?:{p})" for p in _INJECTION), re.IGNORECASE | re.DOTALL)
_INVISIBLE = re.compile(r"[​-‏⁠-⁤﻿­]")


def looks_like_injection(*texts: Any) -> bool:
    for text in texts:
        if isinstance(text, str):
            # NFKC + no zero-width characters, so "ｉｇｎｏｒｅ" or "ig​nore" read as plain words.
            norm = _INVISIBLE.sub("", unicodedata.normalize("NFKC", text))
            if _INJECTION_RX.search(norm):
                return True
    return False


VERDICTS = ("simple_fix", "needs_person", "duplicate", "not_bug", "unclear")
FIX_SIZES = ("small", "medium", "large", "unknown")
CODE_RX = re.compile(r"LUM-\d{6}")
MAX_SUMMARY = 300
MAX_FILES = 10
MAX_PATH = 300
_PATH = {"type": "string", "maxLength": MAX_PATH}
STAGE_B_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["verdict", "confidence", "summary", "likely_files", "risk_paths", "duplicate_of", "fix_size"],
    "properties": {
        "verdict": {"type": "string", "enum": list(VERDICTS)},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "summary": {"type": "string", "maxLength": MAX_SUMMARY},
        "likely_files": {"type": "array", "maxItems": MAX_FILES, "items": {
            "type": "object", "additionalProperties": False, "required": ["path", "line", "why"],
            "properties": {"path": _PATH, "line": {"type": ["integer", "null"], "minimum": 0}, "why": _STR},
        }},
        "risk_paths": {"type": "array", "maxItems": MAX_LIST, "items": _PATH},
        "duplicate_of": {"type": ["string", "null"]},
        "fix_size": {"type": "string", "enum": list(FIX_SIZES)},
    },
}  # fmt: skip


def _ok_path(value: Any) -> bool:
    # Relative to the checkout and never climbing out of it: stage C and a person both open these paths.
    if not isinstance(value, str) or not value or len(value) > MAX_PATH or "\\" in value or "\x00" in value:
        return False
    parts = value.split("/")
    return not value.startswith(("/", "~")) and ".." not in parts


def _ok_number(value: Any, low: float, high: float | None) -> bool:
    # bool is an int in Python: `true` is not a confidence nor a line number.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return value >= low and (high is None or value <= high)


def validate_stage_b(obj: Any, codes: set[str]) -> dict[str, Any] | None:
    """The answer when it matches STAGE_B_SCHEMA, normalised; else None (the caller posts `unclear`).
    `codes` are the reports offered as possible duplicates: `duplicate_of` may only name one of them."""
    props = STAGE_B_SCHEMA["properties"]
    if not isinstance(obj, dict) or set(obj) != set(props):
        return None
    files, risks = obj["likely_files"], obj["risk_paths"]
    if (
        obj["verdict"] not in VERDICTS
        or obj["fix_size"] not in FIX_SIZES
        or not _ok_number(obj["confidence"], 0, 1)
        or not (isinstance(obj["summary"], str) and len(obj["summary"]) <= MAX_SUMMARY)
        or not (isinstance(files, list) and len(files) <= MAX_FILES)
        or not (isinstance(risks, list) and len(risks) <= MAX_LIST and all(_ok_path(p) for p in risks))
        or not (obj["duplicate_of"] is None or isinstance(obj["duplicate_of"], str))
    ):
        return None
    for f in files:
        if not (isinstance(f, dict) and set(f) == {"path", "line", "why"} and _ok_path(f["path"])
                and (f["line"] is None or (isinstance(f["line"], int) and _ok_number(f["line"], 0, None)))
                and _ok_str(f["why"], False)):  # fmt: skip
            return None
    out = dict(obj, likely_files=[dict(f) for f in files], risk_paths=list(risks))
    # A likely file on the risk list is a risk path even when the model did not say so: stage C reads risk_paths.
    for f in files:
        if is_risky(f["path"]) and f["path"] not in out["risk_paths"]:
            out["risk_paths"].append(f["path"])
    dup = out["duplicate_of"]
    if not (isinstance(dup, str) and CODE_RX.fullmatch(dup) and dup in codes):
        out["duplicate_of"] = None
        if out["verdict"] == "duplicate":
            out["verdict"] = "needs_person"  # "a duplicate of something unnamed" is a question for a person
    return out
