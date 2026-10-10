#!/usr/bin/env bash
# Boot a simulator, install the app in mock mode, and capture the inbox,
# the conversation list, and a couple of threads. Output PNGs land in $OUT
# (default /tmp/gawkbot-ios-shots).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-/tmp/gawkbot-ios-shots}"
DEVICE="${DEVICE:-iPhone 17 Pro}"
mkdir -p "$OUT"

xcodegen generate >/dev/null
udid=$(xcrun simctl list devices available -j | python3 -c '
import json,sys,os
want=os.environ.get("DEVICE","iPhone 17 Pro")
d=json.load(sys.stdin)["devices"]
for rt,devs in d.items():
    if "iOS" not in rt: continue
    for dev in devs:
        if dev["name"]==want: print(dev["udid"]); raise SystemExit
for rt,devs in d.items():
    if "iOS" not in rt: continue
    for dev in devs:
        if dev["name"].startswith("iPhone"): print(dev["udid"]); raise SystemExit
')
[ -n "$udid" ] || { echo "no iPhone simulator; run: xcodebuild -downloadPlatform iOS" >&2; exit 1; }
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null

xcodebuild -project Gawkbot.xcodeproj -scheme Gawkbot -sdk iphonesimulator \
  -destination "id=$udid" -configuration Debug -derivedDataPath build \
  build -quiet
app=$(find build/Build/Products -name "Gawkbot.app" -maxdepth 3 | head -1)
xcrun simctl install "$udid" "$app"
# Each shot is its own launch with debug arguments. `simctl openurl` is not
# used: iOS answers it with an "Open in gawkbot?" prompt nothing can tap.
shot() {
  local name="$1"; shift
  xcrun simctl terminate "$udid" bot.gawk.ios 2>/dev/null || true
  xcrun simctl launch "$udid" bot.gawk.ios -mock "$@" >/dev/null
  sleep 4
  xcrun simctl io "$udid" screenshot "$OUT/$name.png" >/dev/null
}
shot 00-inbox
xcrun simctl ui "$udid" appearance dark
sleep 1
xcrun simctl io "$udid" screenshot "$OUT/00-inbox-dark.png" >/dev/null
xcrun simctl ui "$udid" appearance light
shot 01-agents -tab agents
xcrun simctl ui "$udid" appearance dark
sleep 1
xcrun simctl io "$udid" screenshot "$OUT/01-agents-dark.png" >/dev/null
xcrun simctl ui "$udid" appearance light
shot 02-thread-cos -open cos
shot 03-thread-designer-ask -open designer
shot 04-settings -tab settings
# Terminal sessions kept as members: one open (an empty thread, no composer)
# and one closed with past messages. Slugs are MockBroker's.
shot 05-thread-session -open cc-3f2a91c4
shot 06-thread-session-closed -open cc-a41c6e02
xcrun simctl ui "$udid" appearance dark
sleep 1
xcrun simctl io "$udid" screenshot "$OUT/06-thread-session-closed-dark.png" >/dev/null
xcrun simctl ui "$udid" appearance light
echo "screenshots in $OUT"
ls -1 "$OUT"
