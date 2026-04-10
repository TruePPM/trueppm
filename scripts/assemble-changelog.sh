#!/usr/bin/env bash
# scripts/assemble-changelog.sh — collect changelog.d/ fragments into CHANGELOG.md
#
# Usage: bash scripts/assemble-changelog.sh
#
# Reads all fragment files in changelog.d/ (skipping README.md), groups entries
# by type (Added / Changed / Fixed / Security), appends them under the [Unreleased]
# section of CHANGELOG.md, then deletes the consumed fragment files.
#
# Called automatically by scripts/release.sh before rotating [Unreleased].
# Safe to call manually at any time (idempotent when no fragments exist).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CHANGELOG="CHANGELOG.md"
FRAGMENT_DIR="changelog.d"

# Collect fragments by type
declare -A ENTRIES
for type in added changed fixed security; do
  ENTRIES[$type]=""
done

found=0
for f in "$FRAGMENT_DIR"/*.added.md "$FRAGMENT_DIR"/*.changed.md "$FRAGMENT_DIR"/*.fixed.md "$FRAGMENT_DIR"/*.security.md; do
  [[ -f "$f" ]] || continue
  [[ "$(basename "$f")" == "README.md" ]] && continue

  # Determine type from filename suffix (e.g. foo.fixed.md → fixed)
  base="$(basename "$f")"
  type="${base%.*}"       # strip .md → foo.fixed
  type="${type##*.}"      # strip up to last dot → fixed

  content="$(cat "$f")"
  ENTRIES[$type]+="${content}"$'\n'
  found=$((found + 1))
done

if [[ $found -eq 0 ]]; then
  echo "No changelog fragments found in $FRAGMENT_DIR/ — nothing to assemble."
  exit 0
fi

echo "Assembling $found fragment(s) into $CHANGELOG..."

# Build the block to insert after [Unreleased]
INSERT=""
for type in security added changed fixed; do
  [[ -z "${ENTRIES[$type]}" ]] && continue
  # Capitalise heading
  heading="${type^}"
  INSERT+=$'\n'"### ${heading}"$'\n'"${ENTRIES[$type]}"
done

# Insert the block immediately after the ## [Unreleased] line
# Uses a temp file to avoid in-place sed portability issues (macOS / Linux)
awk -v block="$INSERT" '
  /^## \[Unreleased\]/ && !done {
    print
    printf "%s", block
    done=1
    next
  }
  { print }
' "$CHANGELOG" > "${CHANGELOG}.tmp" && mv "${CHANGELOG}.tmp" "$CHANGELOG"

# Delete consumed fragment files (not README.md)
for f in "$FRAGMENT_DIR"/*.added.md "$FRAGMENT_DIR"/*.changed.md "$FRAGMENT_DIR"/*.fixed.md "$FRAGMENT_DIR"/*.security.md; do
  [[ -f "$f" ]] || continue
  [[ "$(basename "$f")" == "README.md" ]] && continue
  rm "$f"
  echo "  Consumed: $f"
done

echo "Done. Review $CHANGELOG before committing."
