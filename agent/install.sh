#!/usr/bin/env bash
# Installs the agent's systemd user units on Valor1.
#   bash install.sh           prints what it would install and where, and checks the env file (changes nothing)
#   bash install.sh --apply   copies the two units into ~/.config/systemd/user and reloads the user manager
# It never enables or starts the timer: it prints the command for that. It never prints the env file's contents.
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_FILE="$HOME/.config/lumina-bug-portal/agent.env"
UNITS=(lumina-bug-agent.service lumina-bug-agent.timer)
APPLY=0

case "${1:-}" in
  "") ;;
  --apply) APPLY=1 ;;
  *) echo "usage: bash install.sh [--apply]" >&2; exit 2 ;;
esac

# `%` is a systemd specifier and a newline would end the line: such a folder cannot be written into a unit as is.
if [[ "$AGENT_DIR" == *%* || "$AGENT_DIR" == *$'\n'* ]]; then
  echo "install.sh: the agent folder's path holds % or a newline; move it: $AGENT_DIR" >&2
  exit 1
fi

# POLL_SECONDS: from the process environment, else from the env file (only that one line is read), else 120.
POLL="${POLL_SECONDS:-}"
if [[ -z "$POLL" && -r "$ENV_FILE" ]]; then
  POLL="$(sed -n 's/^[[:space:]]*POLL_SECONDS[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]*\).*$/\1/p' "$ENV_FILE" | tail -n 1)"
fi
POLL="${POLL:-120}"
if ! [[ "$POLL" =~ ^[0-9]+$ ]] || ((10#$POLL < 10)); then
  echo "install.sh: POLL_SECONDS must be a whole number of seconds, at least 10" >&2
  exit 1
fi
POLL=$((10#$POLL))

if [[ ! -e "$ENV_FILE" ]]; then
  echo "WARNING: $ENV_FILE does not exist: copy agent.env.example there and chmod 600 it before enabling the timer"
else
  MODE="$(stat -c '%a' "$ENV_FILE")"
  OWNER="$(stat -c '%U' "$ENV_FILE")"
  if [[ "$MODE" != 600 || "$OWNER" != "$(id -un)" ]]; then
    echo "WARNING: $ENV_FILE has mode $MODE and owner $OWNER; it holds AGENT_KEY: chmod 600 it, owned by $(id -un)"
  else
    echo "ok: $ENV_FILE exists, mode 600"
  fi
fi

render() {
  local text
  text="$(<"$AGENT_DIR/systemd/$1")"
  text="${text//@AGENT_DIR@/"$AGENT_DIR"}"
  text="${text//@POLL_SECONDS@/"$POLL"}"
  printf '%s\n' "$text"
}

for unit in "${UNITS[@]}"; do
  if ((APPLY)); then
    mkdir -p "$UNIT_DIR"
    render "$unit" >"$UNIT_DIR/$unit.tmp"
    chmod 644 "$UNIT_DIR/$unit.tmp"
    mv -f "$UNIT_DIR/$unit.tmp" "$UNIT_DIR/$unit"
    echo "installed $UNIT_DIR/$unit"
  else
    echo "would install $UNIT_DIR/$unit:"
    render "$unit" | sed 's/^/    /'
  fi
done

if ((APPLY)); then
  systemctl --user daemon-reload
  echo "reloaded the user manager. To start the rounds (the agent stays in dry run while DRY_RUN=1 in the env file):"
else
  echo "nothing changed (dry print). To install: bash install.sh --apply; then, to start the rounds:"
fi
echo "    systemctl --user enable --now lumina-bug-agent.timer"
if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]]; then
  echo "note: lingering is off for $(id -un), so user timers stop at logout: loginctl enable-linger $(id -un)"
fi
