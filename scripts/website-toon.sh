#!/usr/bin/env bash
# Bundles the toon characters (web/src/lib/toon) and the notch's sounds
# (web/src/notch/sounds.ts) for the website, as website/toon.js and
# website/toon.css. Re-run after changing either and commit the output:
#
#   bash scripts/website-toon.sh
set -euo pipefail
cd "$(dirname "$0")/.."
bun build web/src/lib/websiteToon.ts \
  --outdir website \
  --entry-naming "toon.[ext]" \
  --asset-naming "toon.[ext]" \
  --minify \
  --target browser \
  --format iife
ls -l website/toon.js website/toon.css
