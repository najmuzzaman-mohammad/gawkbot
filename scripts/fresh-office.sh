#!/usr/bin/env bash
# fresh-office.sh — wipe a WUPHF runtime home back to first-run state and
# relaunch, WITHOUT losing the operator's provider credentials.
#
# Why this exists: a runtime home mixes two very different things. Most of it
# is disposable office state (roster, channels, tasks, wiki, built apps — the
# apps directory alone runs to five figures of files). But .wuphf/config.json
# also holds the operator's API key and their company name, which a naive
# `rm -rf` destroys and which cannot be recovered from anywhere else.
#
# So: preserve config.json, drop everything that makes the office "already
# onboarded", and leave the provider credential in place so the fresh wizard
# still detects a signed-in runtime.
#
# Usage:
#   scripts/fresh-office.sh                      # dry run: show what would go
#   scripts/fresh-office.sh --yes                # actually wipe
#   scripts/fresh-office.sh --yes --home <path>  # target a specific home
#   scripts/fresh-office.sh --yes --relaunch     # wipe, then start the stack
set -euo pipefail

HOME_DIR="${WUPHF_RUNTIME_HOME:-$HOME/.wuphf-demo-home}"
BIN="${WUPHF_BIN:-$HOME/.wuphf-bin/wuphf-dev}"
BROKER_PORT="${WUPHF_BROKER_PORT:-7899}"
WEB_PORT="${WUPHF_WEB_PORT:-7900}"
CONFIRM=0
RELAUNCH=0
HOME_EXPLICIT=0
# Did the caller actually choose these ports, or are they just the defaults?
PORTS_EXPLICIT=0
[ -n "${WUPHF_BROKER_PORT:-}${WUPHF_WEB_PORT:-}" ] && PORTS_EXPLICIT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) CONFIRM=1 ;;
    --relaunch) RELAUNCH=1 ;;
    --home) shift; HOME_DIR="$1"; HOME_EXPLICIT=1 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

W="$HOME_DIR/.wuphf"
if [ ! -d "$W" ]; then
  echo "no runtime home at $W — nothing to do" >&2
  exit 1
fi

# Check the thing we must preserve BEFORE we stop anyone's servers. Without
# this the script kills the stack, then dies on the `cp` under `set -e`,
# leaving the operator with no running office and no explanation.
if [ ! -f "$W/config.json" ]; then
  echo "no config.json at $W — refusing to wipe." >&2
  echo "That file holds the API key and company name and cannot be recovered." >&2
  echo "If this home genuinely has no config, it is already first-run state." >&2
  exit 1
fi

# KEEP-LIST, not a wipe-list. Everything in .wuphf goes EXCEPT these.
#
# This used to be the other way round — an explicit list of directories to
# delete (office team tasks apps wiki wiki.bak agent-scratch logs
# onboarded.json). That list was exactly right for the runtime home as it stood
# and silently wrong for the next one: any state directory added by a later
# feature (routines, skills, calendar, notebooks) is not in the list, survives
# the wipe, and leaves a "fresh" office carrying state from the old one. A
# half-wipe is worse than no wipe, because it looks like it worked.
#
# Inverting it means new state is covered the day it is added, and the only
# thing anyone has to remember is what must SURVIVE — which is the short list,
# and the one a human can actually keep correct.
KEEP=(config.json)
KEEP_GLOB='config.json.bak-*'

is_kept() {
  local name="$1"
  for k in "${KEEP[@]}"; do [ "$name" = "$k" ] && return 0; done
  # shellcheck disable=SC2254
  case "$name" in $KEEP_GLOB) return 0 ;; esac
  return 1
}

WIPE=()
while IFS= read -r entry; do
  name=$(basename "$entry")
  is_kept "$name" || WIPE+=("$name")
done < <(find "$W" -mindepth 1 -maxdepth 1)

echo "runtime home : $HOME_DIR"
echo "preserving   : .wuphf/config.json (API key, company name, provider choice)"
echo "removing     :"
# macOS ships bash 3.2, where "${ARR[@]}" on an EMPTY array is an unbound
# variable under `set -u`. The ${ARR[@]+...} guard keeps an already-clean home
# from failing instead of reporting that there is nothing to do.
if [ ${#WIPE[@]} -eq 0 ]; then
  echo "  (nothing — this home is already at first-run state)"
fi
for item in ${WIPE[@]+"${WIPE[@]}"}; do
  target="$W/$item"
  [ -e "$target" ] || continue
  if [ -d "$target" ]; then
    n=$(find "$target" -type f 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-16s %s files\n' "$item/" "$n"
  else
    printf '  %-16s (file)\n' "$item"
  fi
done

if [ "$CONFIRM" -ne 1 ]; then
  echo
  echo "DRY RUN — nothing deleted. Re-run with --yes to do it."
  exit 0
fi

# Stop anything holding the ports before removing state underneath it.
#
# BUT ONLY IF THOSE PORTS BELONG TO THE HOME WE ARE WIPING. `--home` used to
# retarget the wipe while leaving BROKER_PORT/WEB_PORT at their 7899/7900
# defaults, so pointing this script at a throwaway directory still killed
# whatever was serving the DEFAULT home. That is exactly what happened: a test
# run against /tmp killed the operator's live dev stack, which had nothing to
# do with the home being wiped and was not mentioned anywhere in the output.
#
# A wipe must not reach outside the home it was aimed at. If the caller named a
# home but not the ports, we have no reason to believe the default ports serve
# it, so we leave them alone and say so.
if [ "$HOME_EXPLICIT" -eq 1 ] && [ "$PORTS_EXPLICIT" -eq 0 ]; then
  echo "note: --home was given without explicit ports, so nothing on $BROKER_PORT/$WEB_PORT"
  echo "      will be stopped. Those ports serve the DEFAULT home, not this one."
  echo "      If a server is running against $HOME_DIR, stop it yourself, or set"
  echo "      WUPHF_BROKER_PORT / WUPHF_WEB_PORT so this script knows which to stop."
else
  for P in "$BROKER_PORT" "$WEB_PORT"; do
    for PID in $(lsof -nP -iTCP:"$P" -t 2>/dev/null || true); do
      CWD=$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//' || true)
      case "$CWD" in
        */Google\ Chrome*|*/Chrome*) continue ;;  # a browser holding the socket, not a server
      esac
      kill "$PID" 2>/dev/null || true
    done
  done
  sleep 1
fi

BACKUP="$W/config.json.bak-$(date +%s)"
cp "$W/config.json" "$BACKUP"
echo "config backed up to $BACKUP"

for item in ${WIPE[@]+"${WIPE[@]}"}; do
  rm -rf "${W:?}/${item:?}"
done
echo "wiped."

# The backup is the whole safety net, so prove it survived rather than assume
# the loop skipped it. A keep-list that silently stopped matching would take
# the API key with it, and this is the last moment anyone could notice.
if [ ! -f "$W/config.json" ]; then
  echo "config.json is GONE after the wipe — restoring from $BACKUP" >&2
  cp "$BACKUP" "$W/config.json"
  echo "restored. The keep-list is broken; do not run this again until it is fixed." >&2
  exit 1
fi

if [ "$RELAUNCH" -eq 1 ]; then
  [ -x "$BIN" ] || { echo "no binary at $BIN — build first: go build -o $BIN ./cmd/wuphf" >&2; exit 1; }
  WUPHF_RUNTIME_HOME="$HOME_DIR" WUPHF_BROKER_PORT="$BROKER_PORT" \
    nohup "$BIN" --web-port "$WEB_PORT" --no-open \
    > "$HOME_DIR/dev-stack.log" 2>&1 &
  echo "relaunched on http://localhost:$WEB_PORT (log: $HOME_DIR/dev-stack.log)"
fi
