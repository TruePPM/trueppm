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

# Build the block to insert. Category order matches the Keep a Changelog
# convention used throughout CHANGELOG.md: Added → Changed → Fixed → Security.
INSERT=""
for type in added changed fixed security; do
  [[ -z "${ENTRIES[$type]}" ]] && continue
  # Capitalise heading
  heading="${type^}"
  INSERT+=$'\n'"### ${heading}"$'\n'"${ENTRIES[$type]}"
done

# Insert the block at the END of the [Unreleased] section — just before the next
# "## [" release heading (or EOF). This keeps any human-readable summary prose
# written at the top of [Unreleased] above the generated category lists, so
# release.sh can lift that prose into the dated section as the release summary.
# Uses a temp file to avoid in-place sed portability issues (macOS / Linux).
awk -v block="$INSERT" '
  /^## \[Unreleased\]/ { inu=1; print; next }
  inu && /^## \[/ { printf "%s\n", block; inu=0 }
  { print }
  END { if (inu) printf "%s\n", block }
' "$CHANGELOG" > "${CHANGELOG}.tmp" && mv "${CHANGELOG}.tmp" "$CHANGELOG"

# Delete consumed fragment files (not README.md)
for f in "$FRAGMENT_DIR"/*.added.md "$FRAGMENT_DIR"/*.changed.md "$FRAGMENT_DIR"/*.fixed.md "$FRAGMENT_DIR"/*.security.md; do
  [[ -f "$f" ]] || continue
  [[ "$(basename "$f")" == "README.md" ]] && continue
  rm "$f"
  echo "  Consumed: $f"
done

echo "Done. Review $CHANGELOG before committing."
