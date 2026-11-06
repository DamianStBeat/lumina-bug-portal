"""Hand-written validators for the model's answers, and the local prompt-injection check."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

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
