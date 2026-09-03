#!/usr/bin/env bash
# Boot the v3 MVP broker against an isolated state dir while keeping the
# user's real claude-code login. WUPHF state lives in $WUPHF_HOME/.wuphf;
# claude-code reads ~/.claude.json + the user's keychain through the
# inherited shell env (HOME, USER, LOGNAME). Do NOT use `env -i` here —
# claude-code's keychain lookup needs USER/LOGNAME to resolve the right
# login.keychain-db.
#
# What this rebuilds, in order:
#   1. web/dist  (vite + tsc)            — the FE bundle the broker serves
#   2. wuphf-mvp Go binary               — broker + embedded prompts
#   3. broker process on :PORT_WEB       — fresh state if --reset
#
# Why the FE rebuild matters: the broker hosts the FE from web/dist/ at
# http://127.0.0.1:7891. Without rebuilding dist, FE changes never reach
# the office surface even after a broker restart — the browser keeps
# loading the stale bundle. Vite's hot-reload on :5273 helps for
# component-only work but is NOT what users hit.
#
# Flags:
#   --reset       Wipe WUPHF_RUNTIME_HOME before starting (default keeps state).
#
# Env:
#   PORT_WEB      Web UI port (default 7891). PORT_BROKER defaults to
#                 PORT_WEB-1, so PORT_WEB=7899 gives you 7898/7899 and leaves
#                 a real office on 7890/7891 alone.
#   PORT_BROKER   Broker port (default PORT_WEB-1).
#   --skip-fe     Skip the web bundle rebuild (use when you only touched Go).
#   --skip-go     Skip the Go binary rebuild (use when you only touched FE/CSS).
set -euo pipefail

WUPHF_HOME="${WUPHF_HOME:-/tmp/wuphf-mvp-home}"
BROKER_BIN="${BROKER_BIN:-./wuphf-mvp}"
LOG="${LOG:-/tmp/wuphf-mvp.log}"
PORT_WEB="${PORT_WEB:-7891}"
# Broker port. Derived from PORT_WEB so overriding one port moves the whole
# instance: the default pair is 7890/7891, so web-1 keeps that relationship.
PORT_BROKER="${PORT_BROKER:-$((PORT_WEB - 1))}"

RESET_STATE=0
SKIP_FE=0
SKIP_GO=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)    RESET_STATE=1; shift ;;
    --skip-fe)  SKIP_FE=1; shift ;;
    --skip-go)  SKIP_GO=1; shift ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\033[36m[dev-mvp]\033[0m %s\n' "$*"; }

if [[ "$RESET_STATE" == "1" ]]; then
  # Guard against accidental wipes when WUPHF_HOME is mis-set (empty, root,
  # the cwd, or a home directory). Refuse to recursively delete anything
  # that does not look like a wuphf workspace — must either already contain
  # a .wuphf/ subdir OR live at a path whose basename matches a wuphf-*
  # pattern (covers fresh --reset runs against /tmp/wuphf-mvp-home).
  case "$WUPHF_HOME" in
    ""|"/"|"."|"./"|"$HOME"|"$HOME/")
      log "refusing to wipe unsafe WUPHF_HOME='$WUPHF_HOME'"
      exit 1
      ;;
  esac
  base="$(basename -- "$WUPHF_HOME")"
  if [[ ! -d "$WUPHF_HOME/.wuphf" && ! "$base" =~ ^wuphf[-_].+ && ! "$base" =~ ^\.wuphf ]]; then
    log "refusing to wipe '$WUPHF_HOME' — does not contain .wuphf/ and basename does not match wuphf-*"
    exit 1
  fi
  log "wiping $WUPHF_HOME (per --reset)"
  rm -rf -- "$WUPHF_HOME"
fi

mkdir -p "$WUPHF_HOME"

if [[ "$SKIP_FE" != "1" ]]; then
  log "rebuilding web/dist (vite + tsc)..."
  (cd web && bun run build) >/tmp/wuphf-mvp-build.log 2>&1 || {
    log "FE build failed. tail:"
    tail -30 /tmp/wuphf-mvp-build.log
    exit 1
  }
fi

if [[ "$SKIP_GO" != "1" || ! -x "$BROKER_BIN" ]]; then
  log "building $BROKER_BIN..."
  go build -o "$BROKER_BIN" ./cmd/wuphf
fi

for port in "$PORT_WEB" "$PORT_BROKER"; do
  if lsof -i :"$port" -P -n >/dev/null 2>&1; then
    PID=$(lsof -ti :"$port" -sTCP:LISTEN)
    log "stopping existing broker (pid $PID) on :$port"
    kill "$PID" 2>/dev/null || true
    sleep 1
  fi
done

# Pass the ports to the BINARY, not just to the checks below.
#
# These flags used to be missing, so PORT_WEB only ever decided which port the
# script pre-killed and health-checked while the broker bound its defaults
# (7890/7891) regardless. Running with PORT_WEB=7899 therefore reported
# "broker failed to bind :7899" while the broker had in fact taken 7890/7891 —
# the ports a developer's real office runs on. It killed a live office on
# 2026-09-03.
log "starting broker on web :$PORT_WEB / broker :$PORT_BROKER with WUPHF_RUNTIME_HOME=$WUPHF_HOME"
WUPHF_RUNTIME_HOME="$WUPHF_HOME" "$BROKER_BIN" --no-open \
  --web-port "$PORT_WEB" --broker-port "$PORT_BROKER" >"$LOG" 2>&1 &
PID=$!

# Poll for the bind instead of sleeping a fixed 2s and hoping. Boot does wiki
# reconcile and skill seeding first, so on a cold state dir the listener can
# take well over two seconds — the old fixed sleep reported "failed to bind"
# for a broker that was starting fine, while leaving it running in the
# background for the next run to trip over.
for _ in $(seq 1 60); do
  lsof -i :"$PORT_WEB" -P -n >/dev/null 2>&1 && break
  kill -0 "$PID" 2>/dev/null || break   # died; stop waiting and report
  sleep 0.5
done

if ! lsof -i :"$PORT_WEB" -P -n >/dev/null 2>&1; then
  log "broker failed to bind :$PORT_WEB within 30s. see $LOG:"
  tail -20 "$LOG"
  kill "$PID" 2>/dev/null || true
  exit 1
fi

echo
log "broker pid: $PID"
log "state dir:  $WUPHF_HOME/.wuphf"
log "log:        $LOG"
log "office:     http://127.0.0.1:$PORT_WEB  ← what users hit; serves web/dist/"
log "broker:     http://127.0.0.1:$PORT_BROKER"
log "vite:       http://127.0.0.1:5273       ← hot-reload, component-only"
echo
log "after FE edits: re-run this script (or 'bash scripts/dev-mvp.sh --skip-go')."
log "hard-reload the office tab (Cmd+Shift+R) to pick up the new bundle hashes."
