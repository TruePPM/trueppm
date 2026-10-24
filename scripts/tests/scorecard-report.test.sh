#!/usr/bin/env bash
# scripts/tests/scorecard-report.test.sh
#
# Unit test for scripts/scorecard-report.sh, the verdict step of the
# security:scorecard CI job (#4644). Its exit code decides orange vs green, so
# a regression silently turns a poor posture into a green-looking pass.
# Fixtures carry only the fields the script reads (.repo.name, .scorecard.version,
# .score, .checks[].{name,score,reason}).
#
# Run: bash scripts/tests/scorecard-report.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/scorecard-report.sh"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  if [[ "$2" -eq 0 ]]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

# run_report <args...> -> $OUT, $RC (never aborts under set -e)
run_report() {
  set +e
  OUT="$(sh "$SCRIPT" "$@" 2>&1)"
  RC=$?
  set -e
}

# mk <file> <name:score> ... writes a minimal Scorecard JSON document.
mk() {
  local f="$1"; shift
  local checks="" sep=""
  for pair in "$@"; do
    checks+="$sep{\"name\":\"${pair%%:*}\",\"score\":${pair##*:},\"reason\":\"r-${pair%%:*}\"}"
    sep=","
  done
  echo "{\"repo\":{\"name\":\"t\"},\"scorecard\":{\"version\":\"v0\"},\"score\":8,\"checks\":[$checks]}" > "$f"
}

mk "$TMP/ok.json" License:9 Security-Policy:10 Pinned-Dependencies:5
run_report "$TMP/ok.json"
check "all checks >= 5 -> exit 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "all ok -> no WARNING banner" "$([[ "$OUT" != *WARNING* ]] && echo 0 || echo 1)"

mk "$TMP/low.json" License:9 SAST:0 Fuzzing:4
run_report "$TMP/low.json"
check "a check < 5 -> exit 2" "$([[ $RC -eq 2 ]] && echo 0 || echo 1)"
check "low -> banner printed" "$([[ "$OUT" == *"WARNING: OpenSSF Scorecard checks scored below 5/10"* ]] && echo 0 || echo 1)"
check "low -> names SAST" "$([[ "$OUT" == *"0/10  SAST"* ]] && echo 0 || echo 1)"
check "low -> names Fuzzing" "$([[ "$OUT" == *"4/10  Fuzzing"* ]] && echo 0 || echo 1)"
check "low -> does not name a passing check in the banner" "$([[ "$OUT" != *"9/10  License"* ]] && echo 0 || echo 1)"

mk "$TMP/na.json" License:9 Packaging:-1 Token-Permissions:-1
run_report "$TMP/na.json"
check "only -1 below threshold -> exit 0 (n/a is not low)" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "-1 listed as n/a" "$([[ "$OUT" == *"n/a  Packaging"* ]] && echo 0 || echo 1)"
check "n/a names are summarized" "$([[ "$OUT" == *"Not evaluable on this target: Packaging, Token-Permissions"* ]] && echo 0 || echo 1)"

run_report "$TMP/low.json" 3
check "threshold arg respected (3 -> only the 0 is low)" "$([[ $RC -eq 2 && "$OUT" == *"0/10  SAST"* && "$OUT" != *"4/10  Fuzzing - r-Fuzzing"* ]] && echo 0 || echo 1)"
run_report "$TMP/low.json" 0
check "threshold 0 -> nothing is low -> exit 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"

: > "$TMP/empty.json"
run_report "$TMP/empty.json"
check "empty file -> exit 1" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
echo '{}' > "$TMP/notsc.json"
run_report "$TMP/notsc.json"
check "non-Scorecard JSON -> exit 1" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
echo 'not json' > "$TMP/bad.json"
run_report "$TMP/bad.json"
check "unparseable -> exit 1" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
run_report "$TMP/does-not-exist.json"
check "missing file -> exit 1" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"

run_report
check "no argument -> exit 3" "$([[ $RC -eq 3 ]] && echo 0 || echo 1)"

echo "scorecard-report.test.sh: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
