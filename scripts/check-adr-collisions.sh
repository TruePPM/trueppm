#!/usr/bin/env bash
# ADR number-collision gate (#918).
#
# Two ADR files that share a four-digit prefix silently corrupt the
# design-decision audit trail: a `per ADR-NNNN` reference in code, tests, or
# docs no longer resolves to a single file, and the next person to cite it
# guesses. This has recurred every time parallel branches each grabbed "the next
# free number" off a stale view of main (see #918 and the 2026-06-10 audit).
#
# This guard makes the invariant enforceable: no two files under docs/adr/ may
# share the leading NNNN prefix. It is the cheap, durable half of #918 — the
# renumbering fixed the existing collisions; this stops new ones from landing.
#
# Exit codes:
#   0  no duplicate ADR numbers
#   1  duplicate ADR number(s) found (CI fails; see output)
#   2  invocation error (ADR directory missing)
#
# Modes:
#   bash scripts/check-adr-collisions.sh             # scan docs/adr/
#   bash scripts/check-adr-collisions.sh <dir>       # scan an explicit dir (used by --self-test)
#   bash scripts/check-adr-collisions.sh --self-test # synthesize a colliding fixture, assert exit 1

set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  : >"$tmp/0042-alpha.md"
  : >"$tmp/0042-beta.md"   # deliberate collision
  : >"$tmp/0043-gamma.md"
  if bash "$0" "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a collision fixture was not detected" >&2
    exit 1
  fi
  echo "SELF-TEST PASSED: collision fixture correctly rejected"
  exit 0
fi

ADR_DIR="${1:-docs/adr}"

if [ ! -d "$ADR_DIR" ]; then
  echo "ERROR: ADR directory not found: $ADR_DIR" >&2
  exit 2
fi

# Extract the leading 4-digit prefix of every NNNN-*.md file, then report any
# prefix that appears more than once. `basename` keeps the match anchored to the
# filename so a path component that happens to contain digits cannot false-trip.
dupes=$(
  for f in "$ADR_DIR"/[0-9][0-9][0-9][0-9]-*.md; do
    [ -e "$f" ] || continue
    basename "$f" | sed -E 's/^([0-9]{4})-.*/\1/'
  done | sort | uniq -d
)

if [ -n "$dupes" ]; then
  echo "✗ ADR number collision(s) detected — two files share a prefix:" >&2
  while IFS= read -r num; do
    [ -n "$num" ] || continue
    echo "  ADR-$num:" >&2
    for f in "$ADR_DIR/$num"-*.md; do
      echo "    - $f" >&2
    done
  done <<<"$dupes"
  echo >&2
  echo "Renumber the younger duplicate to the next free number (above the current" >&2
  echo "max), rename file + '# ADR-NNNN:' header, and re-point every external" >&2
  echo "'ADR-<old>' reference that means the moved file. See #918 for the playbook." >&2
  exit 1
fi

echo "✓ No ADR number collisions ($(ls "$ADR_DIR"/[0-9][0-9][0-9][0-9]-*.md 2>/dev/null | wc -l | tr -d ' ') ADRs scanned)"
exit 0
