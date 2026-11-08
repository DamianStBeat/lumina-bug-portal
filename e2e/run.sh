#!/usr/bin/env bash
# End-to-end run of the bug portal on Valor1: real worker (wrangler dev, local mode), real site (vite preview), real
# Chromium, only the outside faked (Turnstile's script in the browser, siteverify on localhost). See e2e/README.md.
#   e2e/run.sh [--rows 1,2,3,4,5,6,7,8,9,10]   (the default is all of them)
# Exit 0 only if every asked row passes and nothing tried to leave localhost.
set -Eeuo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$HERE")
AGENTS_DIR=/home/damian/Developer/GitHub/_inbox/bp-integration/agents
LOG_ROOT=/home/damian/Developer/GitHub/_inbox/bp-integration/e2e-logs

# Fixed ports, not random ones: a leftover from an earlier run must fail here, loudly, not hide behind a new port.
WORKER_PORT=18787
INSPECTOR_PORT=18788
PREVIEW_PORT=18790
SITEVERIFY_PORT=18791

ROWS=1,2,3,4,5,6,7,8,9,10
while (($#)); do
  case "$1" in
    --rows) ROWS=${2:?--rows needs a list}; shift 2 ;;
    --rows=*) ROWS=${1#--rows=}; shift ;;
    -h|--help) sed -n '2,5p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "e2e: unknown argument $1" >&2; exit 2 ;;
  esac
done

die() { echo "e2e: $*" >&2; exit 2; }

[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || die "Node 24 is required, found $(node --version)"
[[ -d $ROOT/web/node_modules/playwright-core ]] || die "run npm ci in web/ first"
[[ -x $ROOT/worker/node_modules/.bin/wrangler ]] || die "run npm ci in worker/ first"
[[ -d $ROOT/bot/node_modules/discord.js ]] || die "run npm ci in bot/ first"
command -v ffmpeg >/dev/null || die "ffmpeg is required (rows 3 and 5)"
command -v ffprobe >/dev/null || die "ffprobe is required (row 3)"
compgen -G "$HOME/.cache/ms-playwright/chromium_headless_shell-*" >/dev/null || die "Chromium is not in ~/.cache/ms-playwright"
command -v ss >/dev/null || die "ss is required"

for p in "$WORKER_PORT" "$INSPECTOR_PORT" "$PREVIEW_PORT" "$SITEVERIFY_PORT"; do
  if ss -ltnH "sport = :$p" | grep -q .; then die "port $p is taken: another run, or a leftover. Nothing was started."; fi
done

mkdir -p "$AGENTS_DIR/tmp" "$LOG_ROOT"
STATE=$(mktemp -d "$AGENTS_DIR/tmp/e2e.XXXXXXXX")
RUN_ID=$(basename "$STATE")
LOGS=$STATE/logs
mkdir -p "$LOGS" "$STATE/tmp" "$STATE/xdg" "$STATE/persist"

# The mark every process of this run inherits. The cleanup and the memory sampler find a run's processes by it, not by
# name: a `pkill -f` on a name also matches the wrapper running it and whatever else on this machine has that name
# (a long-running Chromium of another project is on this server). Chromium rewrites its environ area, so its processes
# are found by the profile path inside the state dir instead (TMPDIR below puts it there).
export E2E_RUN=$RUN_ID
# Chromium's profile and Playwright's temporary files land in the state dir, so they are removed with it.
export TMPDIR=$STATE/tmp
# Wrangler's own files, and no telemetry or Cloudflare geolocation fetch: nothing leaves localhost.
export XDG_CONFIG_HOME=$STATE/xdg
export WRANGLER_SEND_METRICS=false
export CLOUDFLARE_CF_FETCH_ENABLED=false
export WRANGLER_LOG_PATH=$LOGS/wrangler-debug
export CI=1

PGIDS=()
SAMPLER_PID=
WRANGLER_DIR_CREATED=
[[ -e $ROOT/worker/.wrangler ]] || WRANGLER_DIR_CREATED=1

# Each server is its own process group and session (setsid execs in place here, so $! is the group id): the group takes
# the children with it, which is what wrangler's workerd and any npm-style wrapper need.
spawn() {
  local log=$1
  shift
  setsid "$@" >"$log" 2>&1 </dev/null &
  PGIDS+=("$!")
}

ours() {
  # Builtins only, no grep: a helper started by this function would itself carry the mark and match itself, and a grep
  # per pid takes seconds on this server, which the trap waits on.
  local d pid e hit
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [[ $pid == "$$" || $pid == "$BASHPID" ]] && continue
    hit=
    while IFS= read -r -d '' e; do
      if [[ $e == "E2E_RUN=$RUN_ID" ]]; then hit=1; break; fi
    done 2>/dev/null <"$d/environ"
    if [[ -z $hit ]]; then
      while IFS= read -r -d '' e; do
        if [[ $e == *"$STATE/"* ]]; then hit=1; break; fi
      done 2>/dev/null <"$d/cmdline"
    fi
    [[ -n $hit ]] && echo "$pid"
  done
  true
}

stop_sampler() {
  if [[ -n $SAMPLER_PID ]]; then
    kill -TERM "$SAMPLER_PID" 2>/dev/null || true
    wait "$SAMPLER_PID" 2>/dev/null || true
    SAMPLER_PID=
  fi
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM HUP
  set +e
  stop_sampler
  for g in "${PGIDS[@]:-}"; do [[ -n $g ]] && kill -TERM -- "-$g" 2>/dev/null; done
  local i left
  for i in {1..40}; do
    left=$(ours)
    [[ -z $left ]] && break
    sleep 0.25
  done
  for g in "${PGIDS[@]:-}"; do [[ -n $g ]] && kill -KILL -- "-$g" 2>/dev/null; done
  # Chromium is started detached by Playwright, in a group of its own: a harness that died hard leaves it behind.
  left=$(ours)
  if [[ -n $left ]]; then kill -KILL $left 2>/dev/null; fi
  # A SIGKILLed process with a large heap stays in /proc for a moment while the kernel frees it.
  for i in {1..20}; do
    left=$(ours)
    [[ -z $left ]] && break
    sleep 0.25
  done
  if [[ -n $left ]]; then
    echo "e2e: WARNING, still alive after SIGKILL:" >&2
    ps -o pid,ppid,stat,etime,cmd -p ${left//$'\n'/,} >&2
  fi

  if [[ -d $LOGS ]]; then
    mkdir -p "$LOG_ROOT/$RUN_ID"
    cp -a "$LOGS/." "$LOG_ROOT/$RUN_ID/" 2>/dev/null
    echo "logs: $LOG_ROOT/$RUN_ID"
  fi
  rm -rf "$STATE"
  [[ -n $WRANGLER_DIR_CREATED ]] && rm -rf "$ROOT/worker/.wrangler"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cat >"$STATE/worker.env" <<'EOF'
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
GAME_KEY=e2e-game-key-not-a-secret
AGENT_KEY=e2e-agent-key-not-a-secret
IP_SALT_SEED=e2e-ip-salt-seed-not-a-secret
EOF
chmod 600 "$STATE/worker.env"

PREVIEW_ORIGIN=http://127.0.0.1:$PREVIEW_PORT
WORKER_ORIGIN=http://127.0.0.1:$WORKER_PORT
WRANGLER=(node node_modules/wrangler/bin/wrangler.js)
VITE=(node node_modules/vite/bin/vite.js)

echo "state: $STATE"
echo "== migrations"
(cd "$ROOT/worker" && "${WRANGLER[@]}" d1 migrations apply DB --local --persist-to "$STATE/persist") \
  >"$LOGS/migrations.log" 2>&1 || { cat "$LOGS/migrations.log" >&2; die "the D1 migrations failed"; }

echo "== web build"
(cd "$ROOT/web" && VITE_API_BASE=$WORKER_ORIGIN/api/v1 VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA \
  "${VITE[@]}" build --outDir "$STATE/dist" --emptyOutDir) \
  >"$LOGS/vite-build.log" 2>&1 || { cat "$LOGS/vite-build.log" >&2; die "the site build failed"; }

echo "== start servers"
node "$HERE/sample-rss.mjs" "$RUN_ID" "$STATE/" "$LOGS/rss.txt" "$LOGS/outside-sockets.txt" >"$LOGS/sampler.log" 2>&1 &
SAMPLER_PID=$!

spawn "$LOGS/siteverify.log" node "$HERE/fake-siteverify.mjs" "$SITEVERIFY_PORT"

cd "$ROOT/worker"
spawn "$LOGS/wrangler.log" "${WRANGLER[@]}" dev --local --ip 127.0.0.1 --port "$WORKER_PORT" \
  --inspector-port "$INSPECTOR_PORT" --persist-to "$STATE/persist" --env-file "$STATE/worker.env" \
  --show-interactive-dev-session=false \
  --var "ENVIRONMENT:dev" --var "DESK_DEV_BYPASS:1" --var "ALLOWED_ORIGINS:$PREVIEW_ORIGIN" \
  --var "TURNSTILE_VERIFY_URL:http://127.0.0.1:$SITEVERIFY_PORT/siteverify"
cd "$ROOT/web"
spawn "$LOGS/vite-preview.log" "${VITE[@]}" preview --outDir "$STATE/dist" --host 127.0.0.1 --port "$PREVIEW_PORT" --strictPort
cd "$ROOT"

wait_for() {
  local name=$1 url=$2 want=$3 got=
  for _ in {1..120}; do
    got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null) || true
    [[ $got == "$want" ]] && return 0
    sleep 0.5
  done
  die "$name did not answer $want on $url (last answer: $got); see $LOGS"
}
# 404 not_found for an unknown code is the worker itself answering, D1 included.
wait_for worker "$WORKER_ORIGIN/api/v1/status/LUM-000000" 404
wait_for "vite preview" "$PREVIEW_ORIGIN/" 200
wait_for "fake siteverify" "http://127.0.0.1:$SITEVERIFY_PORT/hits" 200

echo "== rows $ROWS"
export E2E_LOGS=$LOGS E2E_STATE=$STATE E2E_ROWS=$ROWS E2E_WEB=$ROOT/web \
  E2E_WORKER_ORIGIN=$WORKER_ORIGIN E2E_PREVIEW_ORIGIN=$PREVIEW_ORIGIN \
  E2E_SITEVERIFY=http://127.0.0.1:$SITEVERIFY_PORT \
  E2E_GAME_KEY=e2e-game-key-not-a-secret E2E_AGENT_KEY=e2e-agent-key-not-a-secret
# In the background on purpose: bash runs a trap only when its foreground command ends, so a Ctrl-C or kill of this
# script would otherwise wait for the whole row to finish. `wait` is interrupted at once.
spawn "$LOGS/harness.log" node "$HERE/harness.mjs"
harness=${PGIDS[-1]}
tail --pid="$harness" -n +1 -f "$LOGS/harness.log" &
set +e
wait "$harness"
code=$?
set -e

# The sampler writes its table when it stops: stopping it here puts the table in this run's output and in the logs.
stop_sampler
echo
echo "== peak RSS (VmHWM, sampled once a second)"
cat "$LOGS/rss.txt" 2>/dev/null || echo "(no sample)"
echo
echo "== sockets to anything but localhost, by the run's processes"
if [[ -s $LOGS/outside-sockets.txt ]]; then
  cat "$LOGS/outside-sockets.txt"
  echo "e2e: FAIL, a process of the run opened a socket outside localhost" >&2
  [[ $code == 0 ]] && code=3
else
  echo "none seen"
fi
exit "$code"
