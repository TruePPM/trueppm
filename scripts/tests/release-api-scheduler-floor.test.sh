#!/usr/bin/env bash
# Guards the API scheduler-floor bump (#4080): bump-api-scheduler-floor.sh rewrites
# the range, fails loudly when there is nothing to rewrite, and release.sh calls it
# with the published floor and the new ceiling, before CI_API_TAG is restamped.
# Run: bash scripts/tests/release-api-scheduler-floor.test.sh
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUMP="$REPO_ROOT/scripts/bump-api-scheduler-floor.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [[ "$2" -ne 0 ]]; then echo "  FAIL: $1"; fail=$((fail + 1)); fi; }
expect() { local name="$1"; shift; if ! "$@"; then echo "  FAIL: $name"; fail=$((fail + 1)); fi; }

mkdir -p "$TMP/a/packages/api"
printf 'dependencies = [\n    "trueppm-scheduler>=0.4.0b4,<0.5",\n    "django>=5.2,<6.0",\n]\n' >"$TMP/a/packages/api/pyproject.toml"
REPO_ROOT="$TMP/a" bash "$BUMP" 0.4.0b5; check "bump exits 0" $?
grep -qF '"trueppm-scheduler>=0.4.0b5,<0.5",' "$TMP/a/packages/api/pyproject.toml"; check "floor moved to 0.4.0b5" $?
grep -qF '"django>=5.2,<6.0"' "$TMP/a/packages/api/pyproject.toml"; check "other deps untouched" $?
REPO_ROOT="$TMP/a" bash "$BUMP" 0.5.0a1; check "minor bump exits 0" $?
grep -qF '"trueppm-scheduler>=0.5.0a1,<0.6",' "$TMP/a/packages/api/pyproject.toml"; check "ceiling follows the minor" $?
# The release-commit form: floor on the published line, ceiling from the new one.
REPO_ROOT="$TMP/a" bash "$BUMP" 0.4.0b4 0.5.0a1; check "two-argument bump exits 0" $?
grep -qF '"trueppm-scheduler>=0.4.0b4,<0.6",' "$TMP/a/packages/api/pyproject.toml"; check "ceiling follows the basis, floor stays" $?
rc=0; REPO_ROOT="$TMP/a" bash "$BUMP" 0.4.0b4 nope >/dev/null 2>&1 || rc=$?
expect "rejects a non-PEP 440 ceiling basis" [ "$rc" -eq 64 ]

mkdir -p "$TMP/b/packages/api"
printf 'dependencies = ["django"]\n' >"$TMP/b/packages/api/pyproject.toml"
rc=0; REPO_ROOT="$TMP/b" bash "$BUMP" 0.4.0b5 >/dev/null 2>&1 || rc=$?
expect "fails when no scheduler dependency line exists" [ "$rc" -ne 0 ]

# shellcheck disable=SC2016 # literal release.sh source text
grep -qF 'bump-api-scheduler-floor.sh "$CURRENT_PEP440" "$NEW_PEP440"' "$REPO_ROOT/scripts/release.sh"; check "release.sh keeps the published floor and widens the ceiling" $?
# packages/api/pyproject.toml is a CI_API_TAG digest input: rewriting it after the
# restamp leaves the tag stale and reds api:ci-api-tag on the release commit.
bump_at="$(grep -n '^bash scripts/bump-api-scheduler-floor.sh' "$REPO_ROOT/scripts/release.sh" | sed -n 1p | cut -d: -f1)"
tag_at="$(grep -n 'check-ci-api-tag.sh --print-expected)' "$REPO_ROOT/scripts/release.sh" | sed -n 1p | cut -d: -f1)"
expect "range rewrite precedes the CI_API_TAG restamp" [ "${bump_at:-999999}" -lt "${tag_at:-0}" ]
expect "release.sh rewrites the range exactly once" \
  [ "$(grep -c '^bash scripts/bump-api-scheduler-floor.sh' "$REPO_ROOT/scripts/release.sh")" -eq 1 ]
grep -q 'packages/api/pyproject.toml' "$REPO_ROOT/scripts/release.sh"; check "release.sh stages api pyproject" $?

if [[ $fail -eq 0 ]]; then echo "release-api-scheduler-floor: all checks passed"; else echo "release-api-scheduler-floor: $fail FAILED"; exit 1; fi
