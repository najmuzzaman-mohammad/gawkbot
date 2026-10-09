#!/usr/bin/env bash
# Archive the app and send it to TestFlight.
#
#   TEAM_ID=XXXXXXXXXX scripts/testflight.sh            # archive, sign, upload
#   TEAM_ID=XXXXXXXXXX UPLOAD=0 scripts/testflight.sh   # stop at a signed .ipa
#   scripts/testflight.sh --check                       # no account needed
#
# --check archives the Release build unsigned and inspects the bundle for
# the things App Store Connect rejects an upload over. Run it before the
# real thing; it needs no Apple account.
#
# Signing is automatic. Xcode creates the certificate and the App Store
# profile for bot.gawk.ios, using either the account signed in under
# Xcode > Settings > Accounts, or an App Store Connect API key:
#
#   ASC_KEY_ID      the key's ID
#   ASC_ISSUER_ID   the issuer ID shown above the keys list
#   ASC_KEY_PATH    path to the AuthKey_<id>.p8 file
#
# The build number defaults to the UTC time, so every upload is higher than
# the last. Override with BUILD=. The version is MARKETING_VERSION in
# project.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
BUILD="${BUILD:-$(date -u +%Y%m%d%H%M)}"
ARCHIVE="build/Gawkbot.xcarchive"
EXPORT="build/export"

command -v xcodegen >/dev/null || { echo "xcodegen is missing; run: brew install xcodegen" >&2; exit 1; }
xcodegen generate >/dev/null
rm -rf "$ARCHIVE" "$EXPORT"

auth=()
if [ -n "${ASC_KEY_ID:-}" ] || [ -n "${ASC_ISSUER_ID:-}" ] || [ -n "${ASC_KEY_PATH:-}" ]; then
  : "${ASC_KEY_ID:?set all three of ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH}"
  : "${ASC_ISSUER_ID:?set all three of ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH}"
  : "${ASC_KEY_PATH:?set all three of ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH}"
  [ -f "$ASC_KEY_PATH" ] || { echo "no key file at $ASC_KEY_PATH" >&2; exit 1; }
  auth=(-authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID" -authenticationKeyPath "$ASC_KEY_PATH")
fi

if [ "$CHECK" = 1 ]; then
  xcodebuild archive -project Gawkbot.xcodeproj -scheme Gawkbot -configuration Release \
    -destination "generic/platform=iOS" -archivePath "$ARCHIVE" \
    CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION="$BUILD" -quiet
  app="$ARCHIVE/Products/Applications/Gawkbot.app"
  fail=0
  note() { echo "  ok    $1"; }
  bad() { echo "  FAIL  $1"; fail=1; }
  plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$app/Info.plist" 2>/dev/null; }

  check() { local label="$1"; shift; if "$@"; then note "$label"; else bad "$label"; fi; }
  icon="Gawkbot/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
  sip() { sips -g "$1" "$icon" | awk -v k="$1" '$1 == k":" {print $2}'; }

  check "bundle id bot.gawk.ios (is '$(plist CFBundleIdentifier)')" [ "$(plist CFBundleIdentifier)" = "bot.gawk.ios" ]
  check "build number $BUILD (is '$(plist CFBundleVersion)')" [ "$(plist CFBundleVersion)" = "$BUILD" ]
  check "version '$(plist CFBundleShortVersionString)'" [ -n "$(plist CFBundleShortVersionString)" ]
  check "export compliance answered (ITSAppUsesNonExemptEncryption is false)" [ "$(plist ITSAppUsesNonExemptEncryption)" = "false" ]
  for key in NSCameraUsageDescription NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription NSLocalNetworkUsageDescription; do
    check "$key" [ -n "$(plist "$key")" ]
  done
  check "privacy manifest in the bundle" [ -f "$app/PrivacyInfo.xcprivacy" ]
  check "asset catalog in the bundle" [ -f "$app/Assets.car" ]
  check "icon has no alpha channel (the App Store refuses one)" [ "$(sip hasAlpha)" = "no" ]
  check "icon is 1024 px" [ "$(sip pixelWidth)" = "1024" ]
  check "arm64 only (is '$(lipo -archs "$app/Gawkbot")')" [ "$(lipo -archs "$app/Gawkbot")" = "arm64" ]
  [ "$fail" = 0 ] || { echo "not ready for upload" >&2; exit 1; }
  echo "ready: the Release build archives and the bundle passes every check"
  exit 0
fi

: "${TEAM_ID:?set TEAM_ID to your Apple Developer team ID (developer.apple.com/account, Membership details)}"

xcodebuild archive -project Gawkbot.xcodeproj -scheme Gawkbot -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$ARCHIVE" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM_ID" \
  CURRENT_PROJECT_VERSION="$BUILD" -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} -quiet

destination=upload
[ "${UPLOAD:-1}" = "0" ] && destination="export"
options="build/ExportOptions.plist"
cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>$destination</string>
	<key>teamID</key><string>$TEAM_ID</string>
	<key>signingStyle</key><string>automatic</string>
	<key>uploadSymbols</key><true/>
	<key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$options" \
  -exportPath "$EXPORT" -allowProvisioningUpdates ${auth[@]+"${auth[@]}"}

if [ "$destination" = upload ]; then
  echo "uploaded build $BUILD; it shows in App Store Connect > TestFlight after processing (a few minutes)"
else
  echo "signed .ipa in $EXPORT"
fi
