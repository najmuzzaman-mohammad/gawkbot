#!/usr/bin/env bash
# scripts/check-site-claims.sh — the public copy must not drift from the repo.
#
# Two checks, both pure text (<1s):
#
#   1. website/robots.txt uses the real directive. A repo-wide agent→bot rename
#      once turned every `User-agent:` into `User-bot:`, which crawlers ignore
#      without complaint, so the file was inert while looking fine.
#   2. Every repo path cited in the README "Claim Status" table exists. The
#      table promises each claim maps to code; a cited file that was moved or
#      deleted makes that promise false.
#
# The script fails rather than covering less: it errors if it cannot find the
# table, or if the table yields fewer paths than MIN_PATHS, because a parser
# that silently matches nothing would report success.
#
# Portable to bash 3.2 (macOS stock).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROBOTS="$ROOT/website/robots.txt"
README="$ROOT/README.md"
MIN_PATHS=20

fail=0

[ -f "$ROBOTS" ] || { echo "check-site-claims: missing $ROBOTS" >&2; exit 1; }
[ -f "$README" ] || { echo "check-site-claims: missing $README" >&2; exit 1; }

if grep -n -i '^user-bot:' "$ROBOTS" >&2; then
  echo "check-site-claims: website/robots.txt says User-bot:, crawlers only read User-agent:" >&2
  fail=1
fi
if ! grep -q '^User-agent:' "$ROBOTS"; then
  echo "check-site-claims: website/robots.txt has no User-agent: line" >&2
  fail=1
fi

# The table runs from the "## Claim Status" heading to the next heading.
table="$(awk '/^## Claim Status/{on=1; next} on && /^## /{exit} on' "$README")"
if [ -z "$table" ]; then
  echo "check-site-claims: README.md has no \"## Claim Status\" section" >&2
  exit 1
fi

# Backticked tokens in table rows that look like repo paths: they contain a
# slash and do not start with one (routes), a scheme, or ~ (home paths).
# The backtick is built with printf so no quoted string contains one: a
# literal backtick inside single quotes reads as a mistake to shellcheck.
tick="$(printf '\140')"
paths="$(printf '%s\n' "$table" | grep '^|' | grep -o "${tick}[^${tick} ]*${tick}" | tr -d "$tick" \
  | grep '/' | grep -v -E '^(/|~|[a-z]+://)' | sort -u || true)"
count="$(printf '%s\n' "$paths" | grep -c . || true)"

if [ "$count" -lt "$MIN_PATHS" ]; then
  echo "check-site-claims: found $count paths in the claim table, expected at least $MIN_PATHS; the parser or the table changed" >&2
  exit 1
fi

while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ ! -e "$ROOT/$p" ]; then
    echo "check-site-claims: README claim table cites a path that does not exist: $p" >&2
    fail=1
  fi
done <<EOF2
$paths
EOF2

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "check-site-claims: OK ($count claim paths, robots.txt directives valid)"
