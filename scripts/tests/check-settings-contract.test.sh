#!/usr/bin/env bash
# scripts/tests/check-settings-contract.test.sh
#
# Unit test for scripts/check-settings-contract.py (#3248). Leads with the cases that
# MUST fail: the built-in fixture rules, then the real tree against an EMPTY baseline
# (every recorded finding becomes NEW) and against a baseline carrying a stale entry.
# Then requires the committed tree to be clean against its committed baseline.
#
# Run: bash scripts/tests/check-settings-contract.test.sh
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
pass=0
check() { if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi; }

# A tree whose code/docs are the real ones but whose baseline we control. REPO is derived
# from the script's own location, so the copy under $TMP/scripts reads $TMP/packages.
mkdir -p "$TMP/scripts" "$TMP/packages/api"
cp "$REPO_ROOT/scripts/check-settings-contract.py" "$TMP/scripts/"
ln -s "$REPO_ROOT/packages/api/src" "$TMP/packages/api/src"
for d in website web mcp; do ln -s "$REPO_ROOT/packages/$d" "$TMP/packages/$d"; done
GATE="$TMP/scripts/check-settings-contract.py"
BASE="$TMP/packages/api/settings-contract-baseline.txt"

python3 "$GATE" --self-test >/dev/null 2>&1; check "built-in self-test passes" $?

: > "$BASE"
if CI_MERGE_REQUEST_DIFF_BASE_SHA=HEAD python3 "$GATE" >/dev/null 2>&1; then rc=1; else rc=0; fi
check "empty baseline: recorded findings are reported as NEW (must fail)" $rc

cp "$REPO_ROOT/packages/api/settings-contract-baseline.txt" "$BASE"
echo 'env-undocumented | TRUEPPM_NO_SUCH_VARIABLE | #1 | stale' >> "$BASE"
out="$(python3 "$GATE" 2>&1 >/dev/null || true)"
if [[ "$out" == *STALE* ]]; then rc=0; else rc=1; fi
check "a baseline entry that no longer reproduces is reported STALE" $rc

cp "$REPO_ROOT/packages/api/settings-contract-baseline.txt" "$BASE"
python3 "$GATE" >/dev/null 2>&1; check "committed baseline is clean against the committed tree" $?

echo "settings-contract tests: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
