#!/usr/bin/env bash
# scripts/tests/helm-install-drill-worker-restart-message.test.sh
#
# Unit test for celery_worker_restart_message() in scripts/helm-install-drill.sh
# (#4342).
#
# The drill's celery-worker check used to attribute EVERY nonzero restart count
# to "likely the OOMKill loop from an unpinned prefork pool (#2571)" — a specific,
# falsifiable causal claim the script's own diagnostics could refute in the same
# run. #2571 is closed and its fix (a pinned --concurrency) is asserted earlier in
# the same check, so a restart caused by anything else — a failed startup/liveness
# probe under a loaded CI host, observed directly in job 17069534639 (zero
# memory.events oom_kill anywhere on the node, lastState.terminated.reason=Error,
# exitCode=137) — got blamed on a regression that was not present.
#
# This needs a real kind cluster to exercise end to end, so it can only run in
# CI. What does not need a cluster is the message-building logic itself: given a
# restart count and the pod's lastState.terminated reason/exitCode (two plain
# strings), does it name #2571 ONLY when the evidence actually says OOMKilled,
# and otherwise report the real reason/exit instead?
#
# The function is EXTRACTED from the drill, not restated here, so this test
# cannot pass against a definition it invented. If a rename ever breaks the
# extraction, the guard below fires rather than the test vacuously passing.
#
# Run: bash scripts/tests/helm-install-drill-worker-restart-message.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRILL="$REPO_ROOT/scripts/helm-install-drill.sh"

[ -f "$DRILL" ] || { echo "FAIL: $DRILL not found"; exit 1; }

eval "$(awk '/^celery_worker_restart_message\(\) \{/,/^\}$/' "$DRILL")"
declare -F celery_worker_restart_message >/dev/null \
  || { echo "FAIL: could not extract celery_worker_restart_message() from helm-install-drill.sh — did it get renamed?"; exit 1; }

pass=0
fail_count=0
check() { # check "<description>" <expect-pattern> <actual>
  local desc="$1" pattern="$2" actual="$3"
  # shellcheck disable=SC2053  # deliberate glob match against an unquoted pattern arg
  if [[ "$actual" == $pattern ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    echo "    pattern: $pattern"
    echo "    actual:  $actual"
    fail_count=$((fail_count + 1))
  fi
}

# A genuine OOMKilled reason still names #2571 — the fix for that regression is
# only asserted (pinned --concurrency); it is not proof the regression can never
# recur, e.g. via a values override that raises concurrency past the pod's memory
# limit again.
msg="$(celery_worker_restart_message 2 OOMKilled 137)"
check "OOMKilled names #2571" "*OOMKilled*#2571*" "$msg"
check "OOMKilled includes the exit code" "*exit=137*" "$msg"

# This is the #4342 case: killed (exit 137) but Reason=Error, not OOMKilled —
# exactly what a failed probe produces. Must NOT name #2571, and must say what it
# actually observed.
msg="$(celery_worker_restart_message 2 Error 137)"
check "non-OOM Error does not name #2571 as the cause" "*NOT OOMKilled*" "$msg"
check "non-OOM Error message does not claim '#2571' is likely" "*not #2571*" "$msg"
check "non-OOM Error message reports the real reason" "*reason=Error*" "$msg"
check "non-OOM Error message reports the real exit code" "*exit=137*" "$msg"

# No lastState available at all (e.g. kubectl returned empty strings) — must
# still produce a non-#2571 message rather than silently defaulting to it, and
# must not crash on empty inputs.
msg="$(celery_worker_restart_message 1 "" "")"
check "unknown reason does not name #2571" "*NOT OOMKilled*" "$msg"
check "unknown reason reports <unknown> rather than blank" "*reason=<unknown>*" "$msg"

if [ "$fail_count" -gt 0 ]; then
  echo "helm-install-drill-worker-restart-message: ${fail_count} failed, ${pass} passed"
  exit 1
fi
echo "helm-install-drill-worker-restart-message: ${pass} checks passed"
