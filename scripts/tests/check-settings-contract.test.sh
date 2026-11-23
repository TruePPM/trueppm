#!/usr/bin/env bash
# scripts/tests/check-settings-contract.test.sh
#
# Unit test for scripts/check-settings-contract.py (#3248). Leads with the cases that
# MUST fail: the built-in fixture rules, then the real tree against a baseline carrying a
# stale entry, and against an EMPTY baseline (which must report exactly the committed
# baseline's entries as NEW -- every real finding is parked by a line naming an issue).
# Then requires the committed tree to be clean against its committed baseline.
# Every python3 call is wrapped (`|| rc=$?`) so `set -e` cannot abort before `check`
# prints the FAIL label.
#
# Run: bash scripts/tests/check-settings-contract.test.sh
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR
# $TMP is not a git repo: with a CI base ref set, the gate (correctly) fails closed.
# The base-ref ratchet is covered by --self-test, so run the copies without one.
unset CI_MERGE_REQUEST_DIFF_BASE_SHA TRUEPPM_SETTINGS_CONTRACT_BASE_REF

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

rc=0; python3 "$GATE" --self-test >/dev/null 2>&1 || rc=$?; check "built-in self-test passes" $rc

: > "$BASE"
# Against an empty baseline, the NEW findings are exactly the committed baseline's entries.
out="$(python3 "$GATE" 2>&1 >/dev/null || true)"
got="$(printf '%s\n' "$out" | sed -n 's/^NEW  \([^ ]*\) | \([^ ]*\) .*/\1 | \2/p' | sort)"
want="$(grep -v '^#' "$REPO_ROOT/packages/api/settings-contract-baseline.txt" | grep . | awk -F' [|] ' '{print $1" | "$2}' | sort)"
if [[ -n "$want" && "$got" == "$want" ]]; then rc=0; else rc=1; echo "    got: $got"; echo "    want: $want"; fi
check "empty baseline: the NEW findings are exactly the committed baseline's entries" $rc

cp "$REPO_ROOT/packages/api/settings-contract-baseline.txt" "$BASE"
echo 'env-undocumented | TRUEPPM_NO_SUCH_VARIABLE | #1 | stale' >> "$BASE"
out="$(python3 "$GATE" 2>&1 >/dev/null || true)"
if [[ "$out" == *STALE* ]]; then rc=0; else rc=1; fi
check "a baseline entry that no longer reproduces is reported STALE" $rc

cp "$REPO_ROOT/packages/api/settings-contract-baseline.txt" "$BASE"
rc=0; python3 "$GATE" >/dev/null 2>&1 || rc=$?
check "committed baseline is clean against the committed tree" $rc

echo "settings-contract tests: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
