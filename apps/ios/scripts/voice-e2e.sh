#!/usr/bin/env bash
# Hold-to-talk, end to end on a simulator, with real speech. The UI test
# holds the mic in the Chief of Staff thread (demo office); while it holds,
# this script says a sentence through the Mac's speakers, and the simulator
# hears it through the Mac's microphone. Passes when most of the sentence
# lands in the message box.
#
#   scripts/voice-e2e.sh                 # speak, expect the words
#   SILENT=1 scripts/voice-e2e.sh        # no speech: expect an empty box
#
# Needs a Mac with a microphone and speakers, and the volume up. Plays out
# loud.
set -euo pipefail
cd "$(dirname "$0")/.."
DEVICE="${DEVICE:-iPhone 17}"
SENTENCE="${SENTENCE:-please send the weekly report to the design team}"
GO=/tmp/gawkbot-voice-e2e.go

xcodegen generate >/dev/null
udid=$(xcrun simctl list devices available | grep -F "    $DEVICE (" | grep -oE "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}" | head -1)
[ -n "$udid" ] || { echo "no simulator named $DEVICE" >&2; exit 1; }
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl privacy "$udid" grant microphone bot.gawk.ios 2>/dev/null || true

expect="$SENTENCE"
[ "${SILENT:-0}" = 1 ] && expect=""
rm -f "$GO"
(
  # Speak once the test is holding the mic; it creates $GO just before.
  [ "${SILENT:-0}" = 1 ] && exit 0
  for _ in $(seq 1 600); do
    if [ -f "$GO" ]; then sleep 1.2; say -r 165 "$SENTENCE"; exit 0; fi
    sleep 0.2
  done
) &
speaker=$!

set +e
TEST_RUNNER_VOICE_E2E_EXPECT="$expect" xcodebuild test -project Gawkbot.xcodeproj -scheme Gawkbot \
  -destination "id=$udid" -derivedDataPath build \
  -only-testing:GawkbotUITests/VoiceDictationUITests 2>&1 | tee build/voice-e2e.log | grep -E "VOICE_E2E_TRANSCRIPT|error:|Test Case|TEST (SUCCEEDED|FAILED)"
status=${PIPESTATUS[0]}
set -e
kill "$speaker" 2>/dev/null || true
rm -f "$GO"
exit "$status"
