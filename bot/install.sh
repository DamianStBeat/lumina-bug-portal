#!/usr/bin/env bash
# Installs the Lumina Bugs bot as a systemd user service. Dry run by default: prints every step.
# Usage: bash install.sh            (dry run)
#        bash install.sh --apply    (does it)
set -euo pipefail

APPLY=0
case "${1:-}" in
  "") ;;
  --apply) APPLY=1 ;;
  *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL_DIR="$HOME/Developer/GitHub/lumina-bug-portal/bot"
ENV_FILE="$HOME/.config/lumina-bug-portal/bot.env"
UNIT_NAME="lumina-bug-bot.service"
UNIT_SRC="$BOT_DIR/systemd/$UNIT_NAME"
UNIT_DIR="$HOME/.config/systemd/user"

if (( APPLY )); then echo "Installing (--apply)."; else echo "Dry run: nothing is changed. Add --apply to install."; fi

# Prints a step; runs it only with --apply.
step() {
  printf '+ %s\n' "$*"
  if (( APPLY )); then "$@"; fi
}

problems=0
refuse() {
  echo "REFUSED: $*" >&2
  problems=1
}

# The unit runs the canonical checkout, so that is the folder that must be installed.
if [[ "$BOT_DIR" != "$CANONICAL_DIR" ]]; then
  refuse "run this from $CANONICAL_DIR (the folder the service runs), not $BOT_DIR"
fi
# Only the file's existence and mode are read; its contents are never printed.
if [[ ! -f "$ENV_FILE" ]]; then
  refuse "$ENV_FILE is missing (copy bot.env.example there, fill it, chmod 600)"
elif [[ "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
  refuse "$ENV_FILE must be mode 600 (it is $(stat -c '%a' "$ENV_FILE")): chmod 600 $ENV_FILE"
fi
command -v npm >/dev/null || refuse "npm not found"
[[ -x /usr/bin/node ]] || refuse "/usr/bin/node not found (the unit's ExecStart uses it)"

if (( problems )); then
  if (( APPLY )); then exit 1; fi
  echo "--apply would stop here. The steps it would then run:"
fi

step npm ci --omit=dev --prefix "$BOT_DIR"
step mkdir -p "$UNIT_DIR"
step cp "$UNIT_SRC" "$UNIT_DIR/$UNIT_NAME"
step systemctl --user daemon-reload
step systemctl --user enable --now "$UNIT_NAME"

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
  echo "note: lingering is off, so the service stops at logout. Turn it on with: loginctl enable-linger $USER"
fi
if (( APPLY )); then
  echo "Done. Logs: journalctl --user -u lumina-bug-bot -f"
fi
exit "$problems"
