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
#
# Portability: must run on bash 3.2 — the stock /bin/bash on macOS, where the
# maintainer cuts releases. That rules out bash 4+ constructs (associative
# arrays `declare -A`, `${var^}` case expansion); the four fragment types are a
# fixed, known set, so an explicit per-type accumulator is both simpler and
# portable (#1383).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CHANGELOG="CHANGELOG.md"
FRAGMENT_DIR="changelog.d"

# Collect fragments into one accumulator per type. The set is fixed (Added /
# Changed / Fixed / Security), so four named variables stand in for what would
# otherwise be an associative array — and keep the script bash 3.2 clean.
ENTRIES_added=""
ENTRIES_changed=""
ENTRIES_fixed=""
ENTRIES_security=""

found=0
for f in "$FRAGMENT_DIR"/*.added.md "$FRAGMENT_DIR"/*.changed.md "$FRAGMENT_DIR"/*.fixed.md "$FRAGMENT_DIR"/*.security.md; do
  [[ -f "$f" ]] || continue
  [[ "$(basename "$f")" == "README.md" ]] && continue

  # Determine type from filename suffix (e.g. foo.fixed.md → fixed)
  base="$(basename "$f")"
  type="${base%.*}"       # strip .md → foo.fixed
  type="${type##*.}"      # strip up to last dot → fixed

  content="$(cat "$f")"
  case "$type" in
    added)    ENTRIES_added+="${content}"$'\n' ;;
    changed)  ENTRIES_changed+="${content}"$'\n' ;;
    fixed)    ENTRIES_fixed+="${content}"$'\n' ;;
    security) ENTRIES_security+="${content}"$'\n' ;;
  esac
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
  case "$type" in
    added)    entries="$ENTRIES_added";    heading="Added" ;;
    changed)  entries="$ENTRIES_changed";  heading="Changed" ;;
    fixed)    entries="$ENTRIES_fixed";    heading="Fixed" ;;
    security) entries="$ENTRIES_security"; heading="Security" ;;
  esac
  [[ -z "$entries" ]] && continue
  INSERT+=$'\n'"### ${heading}"$'\n'"${entries}"
done

# Insert the block at the END of the [Unreleased] section — just before the next
# "## [" release heading (or EOF). This keeps any human-readable summary prose
# written at the top of [Unreleased] above the generated category lists, so
# release.sh can lift that prose into the dated section as the release summary.
#
# The block is read from a temp file via getline rather than passed with
# `awk -v`: BSD awk (stock on macOS, where releases are cut) rejects a -v value
# containing newlines with "awk: newline in string", so the multi-line category
# block cannot ride in on a variable. A file read is portable across BSD and GNU
# awk (#1383). A temp file also sidesteps in-place sed portability issues.
BLOCK_FILE="$(mktemp)"
trap 'rm -f "$BLOCK_FILE"' EXIT
printf '%s\n' "$INSERT" > "$BLOCK_FILE"
awk -v blockfile="$BLOCK_FILE" '
  function emit_block(   line) {
    while ((getline line < blockfile) > 0) print line
    close(blockfile)
  }
  /^## \[Unreleased\]/ { inu=1; print; next }
  inu && /^## \[/ { emit_block(); inu=0 }
  { print }
  END { if (inu) emit_block() }
' "$CHANGELOG" > "${CHANGELOG}.tmp" && mv "${CHANGELOG}.tmp" "$CHANGELOG"

# Delete consumed fragment files (not README.md)
for f in "$FRAGMENT_DIR"/*.added.md "$FRAGMENT_DIR"/*.changed.md "$FRAGMENT_DIR"/*.fixed.md "$FRAGMENT_DIR"/*.security.md; do
  [[ -f "$f" ]] || continue
  [[ "$(basename "$f")" == "README.md" ]] && continue
  rm "$f"
  echo "  Consumed: $f"
done

echo "Done. Review $CHANGELOG before committing."
