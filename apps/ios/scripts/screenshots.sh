#!/usr/bin/env bash
# Boot a simulator, install the app in mock mode, and capture the
# conversation list and a thread. Output PNGs land in $OUT (default
# /tmp/gawkbot-ios-shots).
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
  build CODE_SIGNING_ALLOWED=NO -quiet
app=$(find build/Build/Products -name "Gawkbot.app" -maxdepth 3 | head -1)
xcrun simctl install "$udid" "$app"
xcrun simctl terminate "$udid" bot.gawk.ios 2>/dev/null || true
xcrun simctl launch "$udid" bot.gawk.ios -mock >/dev/null
sleep 3
xcrun simctl io "$udid" screenshot "$OUT/01-conversations.png" >/dev/null
xcrun simctl openurl "$udid" "gawkbot://thread/cos"
sleep 2
xcrun simctl io "$udid" screenshot "$OUT/02-thread-cos.png" >/dev/null
xcrun simctl openurl "$udid" "gawkbot://thread/designer"
sleep 2
xcrun simctl io "$udid" screenshot "$OUT/03-thread-designer-ask.png" >/dev/null
echo "screenshots in $OUT"
ls -1 "$OUT"
