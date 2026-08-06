#!/usr/bin/env bash
# scripts/tests/helm-netpol-probe.test.sh
#
# Unit test for the probe-verdict logic in scripts/helm-netpol-drill.sh (#2647).
#
# The drill itself needs a kind cluster, Calico, and the release images, so it can
# only run in CI and only end to end. But the bug it carried was not in the cluster
# — it was in how a verdict is decided. `expect_probe` ran the probe exactly once
# and inferred DENIED from silence, so a genuinely-allowed connection that was
# merely slow (a pod whose Calico programming or CoreDNS answer had not landed yet)
# was reported as a policy denial. That misread `helm:netpol` red on ~17% of runs.
#
# The fix retries probes that expect ALLOWED. That retry is worth exactly as much
# as its two guarantees, and both are asserted below:
#
#   1. It must ABSORB a transient silence — otherwise the flake is still there.
#   2. It must NOT absorb a real denial — otherwise the drill has been converted
#      from flaky into useless, which is strictly worse: an over-restrictive
#      policy, or a #2560-style missing allow-list entry, would now pass.
#
# Negative probes must stay single-shot. Retrying them cannot fix anything (a
# dropped packet does not become a connection on the second try) and would add
# PROBE_TIMEOUT to every run.
#
# The helpers are extracted from the drill rather than copied, so this test reads
# the shipping definitions and cannot silently drift from them.
#
# Run: bash scripts/tests/helm-netpol-probe.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRILL="$REPO_ROOT/scripts/helm-netpol-drill.sh"

[ -f "$DRILL" ] || { echo "FAIL: $DRILL not found"; exit 1; }

# The drill is not sourceable — it creates a cluster on load — so lift out just the
# verdict logic. If a rename ever breaks these extractions the guards below fire,
# rather than the test vacuously passing against empty definitions.
eval "$(awk '/^log\(\) \{/,/^fail\(\) \{.*$/' "$DRILL")"
eval "$(awk '/^probe_until_allowed\(\) \{/,/^\}$/' "$DRILL")"
eval "$(awk '/^expect_probe\(\) \{/,/^\}$/' "$DRILL")"
for fn in log note fail probe_until_allowed expect_probe; do
  declare -F "$fn" >/dev/null \
    || { echo "FAIL: could not extract ${fn}() from helm-netpol-drill.sh — did it get renamed?"; exit 1; }
done

# Mirror the drill's defaults, except the backoff: the delay is real sleep time and
# nothing here is testing that it elapses.
# shellcheck disable=SC2034  # read by the eval'd drill functions, which shellcheck cannot see
PROBE_TIMEOUT=6
PROBE_ALLOW_ATTEMPTS=3
# shellcheck disable=SC2034  # ditto
PROBE_RETRY_DELAY=0

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Stub `probe` with a scripted sequence of verdicts. Its state lives in FILES, not
# variables: probe_until_allowed calls `probe` inside a `$(...)` capture — a
# subshell — so an in-memory counter would never advance in the parent, and every
# retry assertion below would pass vacuously against attempt 1.
probe() {
  local i
  i="$(cat "$TMP/idx")"
  echo $((i + 1)) > "$TMP/idx"
  sed -n "$((i + 1))p" "$TMP/seq"
}
setup() { printf '%s\n' "$@" > "$TMP/seq"; echo 0 > "$TMP/idx"; }
calls() { cat "$TMP/idx"; }

pass=0
fail_count=0
check() { # check "<description>" <expected> <actual>
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc — expected '$expected', got '$actual'"
    fail_count=$((fail_count + 1))
  fi
}

# --- The retry must absorb a transient silence ------------------------------

setup ALLOWED ALLOWED ALLOWED
check "connects first try: verdict" ALLOWED "$(probe_until_allowed n '{}' svc 80 2>/dev/null)"
check "connects first try: costs one probe (no retry on the happy path)" 1 "$(calls)"

setup DENIED ALLOWED
check "#2647 flake: silence then connection reads ALLOWED" \
  ALLOWED "$(probe_until_allowed n '{}' svc 80 2>/dev/null)"
check "#2647 flake: took two probes" 2 "$(calls)"

setup DENIED DENIED ALLOWED
check "recovers on the last permitted attempt" \
  ALLOWED "$(probe_until_allowed n '{}' svc 80 2>/dev/null)"
check "spends the whole budget to do it" 3 "$(calls)"

# --- The retry must NOT absorb a real denial --------------------------------
# If these pass while the ones above pass, the retry is discriminating rather
# than merely permissive.

setup DENIED DENIED DENIED
check "a real denial survives the retry budget" \
  DENIED "$(probe_until_allowed n '{}' svc 80 2>/dev/null)"
check "and stops at the budget rather than looping" 3 "$(calls)"

setup DENIED DENIED DENIED
( expect_probe ALLOWED "over-restrictive policy" n '{}' svc 80 ) >/dev/null 2>&1
check "expect_probe ALLOWED still fails the drill on a real denial" 1 "$?"

setup ALLOWED
( expect_probe DENIED "policy not enforced" n '{}' svc 80 ) >/dev/null 2>&1
check "expect_probe DENIED still fails the drill on an open port" 1 "$?"

setup DENIED ALLOWED
( expect_probe ALLOWED "positive probe" n '{}' svc 80 ) >/dev/null 2>&1
check "expect_probe ALLOWED passes through one flake" 0 "$?"

# --- Negative probes stay single-shot ---------------------------------------
# The sequence starts DENIED, so a retry would flip this to ALLOWED and fail the
# drill for the wrong reason. The call count is the real assertion.

setup DENIED ALLOWED
( expect_probe DENIED "negative probe" n '{}' svc 80 ) >/dev/null 2>&1
check "expect_probe DENIED passes on the first observation" 0 "$?"
check "expect_probe DENIED is never retried" 1 "$(calls)"

# --- The verdict must not be polluted by progress output --------------------
# probe_until_allowed echoes its verdict on stdout, so its retry notes have to go
# to stderr. A `log` there instead of `note` would make the captured verdict
# something like "==> retrying...\nALLOWED", which never equals "ALLOWED" — the
# drill would then fail every retried probe it was meant to rescue.

setup DENIED ALLOWED
check "verdict is a bare token, not verdict-plus-notes" \
  ALLOWED "$(probe_until_allowed n '{}' svc 80 2>/dev/null)"

setup DENIED ALLOWED
err="$(probe_until_allowed n '{}' svc 80 2>&1 >/dev/null)"
case "$err" in
  *"retrying in"*) check "a retry is announced on stderr" yes yes ;;
  *)               check "a retry is announced on stderr" yes no ;;
esac
# A probe that needs two attempts every run is a cluster degrading toward a real
# failure. Silently absorbing that is how this defect stayed invisible.
case "$err" in
  *"connected on attempt 2/${PROBE_ALLOW_ATTEMPTS}"*)
    check "a retry that succeeded is reported, not swallowed" yes yes ;;
  *)
    check "a retry that succeeded is reported, not swallowed" yes no ;;
esac

if [ "$fail_count" -gt 0 ]; then
  echo "helm-netpol-probe: ${fail_count} failed, ${pass} passed"
  exit 1
fi
echo "helm-netpol-probe: ${pass} checks passed"
