#!/usr/bin/env bash
# Put the pinned computer-use driver into a built gawkbot.app.
#
#   bash scripts/fetch-cua-driver-host.sh desktop/oswails/build/bin/gawkbot.app
#
# The version and checksum come from internal/hostcomputer/version.go, so
# the code and the bundle cannot drift. The archive is downloaded once into
# a cache and verified by SHA-256 every time before anything is copied.
# Run it after `wails build` and before codesign: the helper is signed with
# the app (--deep) and inherits the app's TCC identity when spawned from it.
set -euo pipefail

app="${1:-}"
if [ -z "$app" ] || [ ! -d "$app/Contents/MacOS" ]; then
  echo "usage: $0 <path to gawkbot.app>" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
versionfile="$root/internal/hostcomputer/version.go"
version="$(sed -n 's/^[[:space:]]*DriverVersion[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$versionfile" | head -1)"
sha="$(sed -n 's/^[[:space:]]*DriverDarwinUniversalSHA256[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$versionfile" | head -1)"
if [ -z "$version" ] || [ -z "$sha" ]; then
  echo "could not read the driver pin from $versionfile" >&2
  exit 1
fi
asset="cua-driver-rs-${version}-darwin-universal-binary.tar.gz"
url="https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${asset}"

cache="${GAWKBOT_DRIVER_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/gawkbot/cua-driver}"
mkdir -p "$cache"
archive="$cache/$asset"
if [ ! -s "$archive" ]; then
  echo "downloading $asset"
  curl -fsSL --retry 3 -o "$archive.part" "$url"
  mv "$archive.part" "$archive"
fi
got="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [ "$got" != "$sha" ]; then
  rm -f "$archive"
  echo "checksum mismatch for $asset: got $got, want $sha" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
bin="$(find "$work" -type f -name cua-driver | head -1)"
if [ -z "$bin" ]; then
  echo "no cua-driver binary in $asset" >&2
  exit 1
fi
mkdir -p "$app/Contents/Helpers"
install -m 0755 "$bin" "$app/Contents/Helpers/cua-driver"
"$app/Contents/Helpers/cua-driver" --version
echo "bundled the computer-use driver $version into $app/Contents/Helpers"
