#!/usr/bin/env bash
# scripts/tests/ci-step.test.sh — self-test for scripts/ci/step.sh (#5090).
#
# The aggregate lint jobs only keep the old per-gate guarantee if (a) a failing
# check still fails the job, (b) the log names it, and (c) checks after it still
# run. A wrapper that swallowed a failure would turn ~48 gates green at once and
# look identical to a clean tree, so each property is asserted separately.
#
# Run: bash scripts/tests/ci-step.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STEP="$REPO_ROOT/scripts/ci/step.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1" >&2; fail=1; }

# Case 1: every check passes -> finish exits 0.
export CI_STEP_STATE="$TMP/s1"
bash "$STEP" check-a true >/dev/null
bash "$STEP" check-b true >/dev/null
if bash "$STEP" --finish >/dev/null; then ok "all-pass aggregate exits 0"; else bad "all-pass aggregate exited non-zero"; fi

# Case 2: a failing check fails the aggregate, names itself, and does not stop
# the checks after it.
export CI_STEP_STATE="$TMP/s2"
out="$(
  bash "$STEP" check-a true
  bash "$STEP" check-broken sh -c 'echo planted violation; exit 3'
  bash "$STEP" check-after sh -c 'echo ran-after-failure'
  bash "$STEP" --finish
  echo "finish-rc=$?"
)"
case "$out" in *"finish-rc=1"*) ok "failing check makes --finish exit 1" ;; *) bad "--finish did not exit 1: $out" ;; esac
case "$out" in *"FAIL  check-broken (exit 3)"*) ok "failing check is named with its exit code" ;; *) bad "failure not named: $out" ;; esac
case "$out" in *"  - check-broken"*) ok "summary lists the failing check" ;; *) bad "summary missing the failing check: $out" ;; esac
case "$out" in *"ran-after-failure"*) ok "a later check still runs after a failure" ;; *) bad "later check did not run: $out" ;; esac
case "$out" in *"PASS  check-a"*) ok "a passing check is reported PASS" ;; *) bad "pass not reported: $out" ;; esac
case "$out" in *"  - check-a"*|*"  - check-after"*) bad "a passing check was listed as failed: $out" ;; *) ok "passing checks are not listed as failed" ;; esac

# Case 3: a command that does not exist is a failure, not a silent pass.
export CI_STEP_STATE="$TMP/s3"
bash "$STEP" check-missing /nonexistent/no-such-command >/dev/null 2>&1
if bash "$STEP" --finish >/dev/null 2>&1; then bad "missing command passed"; else ok "missing command fails the aggregate"; fi

# Case 4: two failures are both reported.
export CI_STEP_STATE="$TMP/s4"
bash "$STEP" one false >/dev/null
bash "$STEP" two false >/dev/null
out="$(bash "$STEP" --finish 2>&1)"
case "$out" in *"  - one"*"  - two"*) ok "multiple failures all listed" ;; *) bad "not all failures listed: $out" ;; esac

# Case 5: bad usage is rejected.
if bash "$STEP" onlyname >/dev/null 2>&1; then bad "usage error accepted"; else ok "missing command is a usage error"; fi

exit "$fail"
