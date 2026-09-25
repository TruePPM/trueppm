#!/usr/bin/env bash
# Guards the API scheduler-floor bump (#4080): bump-api-scheduler-floor.sh rewrites
# the range, fails loudly when there is nothing to rewrite, and release.sh calls it.
# Run: bash scripts/tests/release-api-scheduler-floor.test.sh
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUMP="$REPO_ROOT/scripts/bump-api-scheduler-floor.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [[ "$2" -ne 0 ]]; then echo "  FAIL: $1"; fail=$((fail + 1)); fi; }

mkdir -p "$TMP/a/packages/api"
printf 'dependencies = [\n    "trueppm-scheduler>=0.4.0b4,<0.5",\n    "django>=5.2,<6.0",\n]\n' >"$TMP/a/packages/api/pyproject.toml"
REPO_ROOT="$TMP/a" bash "$BUMP" 0.4.0b5; check "bump exits 0" $?
grep -qF '"trueppm-scheduler>=0.4.0b5,<0.5",' "$TMP/a/packages/api/pyproject.toml"; check "floor moved to 0.4.0b5" $?
grep -qF '"django>=5.2,<6.0"' "$TMP/a/packages/api/pyproject.toml"; check "other deps untouched" $?
REPO_ROOT="$TMP/a" bash "$BUMP" 0.5.0a1; check "minor bump exits 0" $?
grep -qF '"trueppm-scheduler>=0.5.0a1,<0.6",' "$TMP/a/packages/api/pyproject.toml"; check "ceiling follows the minor" $?

mkdir -p "$TMP/b/packages/api"
printf 'dependencies = ["django"]\n' >"$TMP/b/packages/api/pyproject.toml"
REPO_ROOT="$TMP/b" bash "$BUMP" 0.4.0b5 >/dev/null 2>&1; [[ $? -ne 0 ]]; check "fails when no scheduler dependency line exists" $?

grep -q 'bump-api-scheduler-floor.sh' "$REPO_ROOT/scripts/release.sh"; check "release.sh calls the floor bump" $?
grep -q 'packages/api/pyproject.toml' "$REPO_ROOT/scripts/release.sh"; check "release.sh stages api pyproject" $?

if [[ $fail -eq 0 ]]; then echo "release-api-scheduler-floor: all checks passed"; else echo "release-api-scheduler-floor: $fail FAILED"; exit 1; fi
