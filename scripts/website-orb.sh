#!/usr/bin/env bash
# Bundles the bot character (web/src/lib/orbCharacter.ts) and the notch's
# sounds (web/src/notch/sounds.ts) for the website, as website/orb.js and
# website/orb.css. Re-run after changing either and commit the output:
#
#   bash scripts/website-orb.sh
set -euo pipefail
cd "$(dirname "$0")/.."
bun build web/src/lib/websiteOrb.ts \
  --outdir website \
  --entry-naming "orb.[ext]" \
  --asset-naming "orb.[ext]" \
  --minify \
  --target browser
ls -l website/orb.js website/orb.css
