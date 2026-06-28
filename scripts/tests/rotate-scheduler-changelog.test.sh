#!/usr/bin/env bash
# scripts/tests/rotate-scheduler-changelog.test.sh
#
# Unit test for scripts/rotate-scheduler-changelog.sh. Release tooling has no
# other test harness, and the scheduler PyPI wheel's bundled release notes
# depend on this rotation, so guard it directly. Pure bash + python3, no fixtures
# on disk: each case builds a CHANGELOG in a temp dir and asserts the result.
#
# Run: bash scripts/tests/rotate-scheduler-changelog.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROTATE="$REPO_ROOT/scripts/rotate-scheduler-changelog.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  if [[ "$2" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $1"
    fail=$((fail + 1))
  fi
}
has() { grep -qF "$1" "$2"; }      # literal substring present
hasnt() { ! grep -qF "$1" "$2"; }  # literal substring absent

BASE_URL="https://gitlab.com/trueppm/trueppm/-/compare"

write_populated() {
  cat > "$1" <<EOF
# Changelog

Intro prose that must survive untouched.

## [Unreleased]

### Added

- Per-task calendars (#1117).

### Fixed

- Monte Carlo milestone handling.

## [0.2.0a1] - 2026-05-31

### Changed

- Settled the exported \`__all__\` API.

## [0.1.0a1] - 2026-05-15

### Added

- Initial public alpha.

[Unreleased]: $BASE_URL/scheduler-v0.2.0a1...main
[0.2.0a1]: $BASE_URL/scheduler-v0.1.0a1...scheduler-v0.2.0a1
[0.1.0a1]: https://gitlab.com/trueppm/trueppm/-/tags/scheduler-v0.1.0a1
EOF
}

write_empty() {
  cat > "$1" <<EOF
# Changelog

## [Unreleased]

_Nothing yet._

## [0.2.0a1] - 2026-05-31

### Changed

- Something.

[Unreleased]: $BASE_URL/scheduler-v0.2.0a1...main
[0.2.0a1]: $BASE_URL/scheduler-v0.1.0a1...scheduler-v0.2.0a1
EOF
}

# --- Case 1: populated [Unreleased] rotates into a dated section -----------
echo "Case 1: populated rotation"
CL="$TMP/case1.md"
write_populated "$CL"
bash "$ROTATE" 0.3.0a1 0.2.0a1 2026-06-28 "$CL" >/dev/null

check "dated [0.3.0a1] section created"        "$(has '## [0.3.0a1] - 2026-06-28' "$CL"; echo $?)"
check "Added content carried into 0.3.0a1"     "$(has 'Per-task calendars (#1117).' "$CL"; echo $?)"
check "Fixed content carried into 0.3.0a1"     "$(has 'Monte Carlo milestone handling.' "$CL"; echo $?)"
check "fresh [Unreleased] left behind"         "$(has '## [Unreleased]' "$CL"; echo $?)"
check "fresh [Unreleased] placeholder present" "$(has '_Nothing yet._' "$CL"; echo $?)"
check "intro prose preserved"                  "$(has 'Intro prose that must survive untouched.' "$CL"; echo $?)"
check "footer [Unreleased] advanced to new tag" \
  "$(has "[Unreleased]: $BASE_URL/scheduler-v0.3.0a1...main" "$CL"; echo $?)"
check "footer compare line for 0.3.0a1 inserted" \
  "$(has "[0.3.0a1]: $BASE_URL/scheduler-v0.2.0a1...scheduler-v0.3.0a1" "$CL"; echo $?)"
check "old footer [0.2.0a1] line retained" \
  "$(has "[0.2.0a1]: $BASE_URL/scheduler-v0.1.0a1...scheduler-v0.2.0a1" "$CL"; echo $?)"
check "stale footer [Unreleased]->v0.2.0a1 removed" \
  "$(hasnt "[Unreleased]: $BASE_URL/scheduler-v0.2.0a1...main" "$CL"; echo $?)"
# [Unreleased] must sit ABOVE the new dated section.
order_ok="$(awk '/^## \[Unreleased\]/{u=NR} /^## \[0.3.0a1\]/{v=NR} END{print (u>0 && v>0 && u<v)?0:1}' "$CL")"
check "[Unreleased] ordered above [0.3.0a1]" "$order_ok"

# --- Case 2: idempotent re-run is a no-op ----------------------------------
echo "Case 2: idempotent re-run"
before="$(cat "$CL")"
bash "$ROTATE" 0.3.0a1 0.2.0a1 2026-06-28 "$CL" >/dev/null
after="$(cat "$CL")"
[[ "$before" == "$after" ]] && r=0 || r=1
check "second run leaves file unchanged" "$r"
count="$(grep -cF '## [0.3.0a1] - 2026-06-28' "$CL")"
[[ "$count" -eq 1 ]] && r=0 || r=1
check "exactly one [0.3.0a1] section" "$r"

# --- Case 3: empty cycle still gets a dated 'no changes' entry --------------
echo "Case 3: empty cycle"
CL2="$TMP/case3.md"
write_empty "$CL2"
bash "$ROTATE" 0.3.0a1 0.2.0a1 2026-06-28 "$CL2" >/dev/null
check "dated section created for empty cycle"  "$(has '## [0.3.0a1] - 2026-06-28' "$CL2"; echo $?)"
check "records no library-facing changes"      "$(has '_No library-facing changes in this release._' "$CL2"; echo $?)"
check "footer advanced for empty cycle too" \
  "$(has "[0.3.0a1]: $BASE_URL/scheduler-v0.2.0a1...scheduler-v0.3.0a1" "$CL2"; echo $?)"

# --- Case 4: missing [Unreleased] is a hard error --------------------------
echo "Case 4: missing [Unreleased] errors"
CL3="$TMP/case4.md"
printf '# Changelog\n\n## [0.2.0a1] - 2026-05-31\n\n- x\n' > "$CL3"
if bash "$ROTATE" 0.3.0a1 0.2.0a1 2026-06-28 "$CL3" >/dev/null 2>&1; then
  check "rotation rejects file without [Unreleased]" 1
else
  check "rotation rejects file without [Unreleased]" 0
fi

echo ""
echo "rotate-scheduler-changelog: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
