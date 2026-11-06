"""The risk list: paths an AI fix may never touch (saves, money, inventory, network, tooling). Given to stage B as
text and, in stage C, the path guard on every changed file."""

from __future__ import annotations

from fnmatch import fnmatchcase
from pathlib import PurePosixPath

RISK_PATTERNS = (
    "src/**/DataStore*", "**/Persistence/**", "**/Profile*", "**/Currency*", "**/Economy*", "**/Purchase*",
    "**/DeveloperProduct*", "**/Marketplace*", "**/Inventory*", "**/Migration/**", "**/Admin*", "**/Network*",
    "**/Remote*", "deploy-tools/**", ".github/**", "*.project.json", "aftman.toml", "rokit.toml",
)  # fmt: skip


def _match(pat: tuple[str, ...], parts: tuple[str, ...]) -> bool:
    if not pat:
        return not parts
    if pat[0] == "**":
        return any(_match(pat[1:], parts[i:]) for i in range(len(parts) + 1))
    return bool(parts) and fnmatchcase(parts[0], pat[0]) and _match(pat[1:], parts[1:])


def _segments(pattern: str) -> tuple[str, ...]:
    # A bare file name (`*.project.json`, `aftman.toml`) is matched at any depth: a nested project file is still
    # a project file, and the safe side of a doubt is to block.
    return tuple(("**/" + pattern if "/" not in pattern else pattern).split("/"))


_COMPILED = tuple(_segments(p) for p in RISK_PATTERNS)


def is_risky(path: str) -> bool:
    """True when `path` (relative to the repo root) or any directory above it matches a risk pattern, so that
    `**/Inventory*` covers `src/Server/Inventory/Foo.luau` as well as `src/InventoryService.luau`."""
    parts = tuple(p for p in PurePosixPath(path).parts if p not in ("", "."))
    return any(_match(pat, parts[:k]) for pat in _COMPILED for k in range(1, len(parts) + 1))


def risk_list_text() -> str:
    return "\n".join(f"- `{p}`" for p in RISK_PATTERNS)
