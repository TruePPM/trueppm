#!/usr/bin/env bash
# scripts/tests/helm-upgrade-leg-version.test.sh
#
# Unit test for scripts/helm-install-drill.sh's resolve_previous_chart_version()
# (#3941) — the function that turns "the previous released chart version" into
# an actual version string instead of a hardcoded one. It needs a kind cluster
# to run for real (DRILL_LEG=upgrade), so this is the part that can be checked
# in milliseconds with no cluster or network: whether the version-selection
# ALGORITHM picks the right "previous" version across the shapes that actually
# occur — HEAD already published, HEAD ahead of everything published, no prior
# release at all, a stray bare X.Y.Z beside its betas (#3914), and CHART_TAGS
# carrying stray cosign sha256-* tags.
#
# The function is extracted from the shipping drill (via the same "not
# sourceable, the script boots a kind cluster on load" workaround
# scripts/tests/helm-celery-probe-overrides.test.sh uses for
# CELERY_PROBE_OVERRIDES) so this test cannot pass against a definition it
# invented — a rename or reformat that breaks the extraction fails loudly
# below rather than silently testing nothing.
#
# Run: bash scripts/tests/helm-upgrade-leg-version.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRILL="$REPO_ROOT/scripts/helm-install-drill.sh"

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
die() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$DRILL" ] || die "$DRILL not found"

# --- Extract resolve_previous_chart_version() + the log/fail it calls -------
FUNC_BODY="$(awk '/^resolve_previous_chart_version\(\) \{/,/^\}$/' "$DRILL")"
case "$FUNC_BODY" in
  resolve_previous_chart_version*'}') ;;
  *) die "could not extract resolve_previous_chart_version() from helm-install-drill.sh — did it get renamed or reformatted? (#3941)" ;;
esac
[ -n "$FUNC_BODY" ] || die "resolve_previous_chart_version() extracted as empty (#3941)"

# log() prints to stdout here (not stderr) so a test run's "skip" message is
# visible without ceremony; fail() records instead of exiting so a bad case
# reports as a FAIL below rather than aborting the whole test file.
#
# <CHART_TAGS> of the literal string __UNSET__ means "do not set CHART_TAGS at
# all" (as opposed to set-but-empty, which still takes the CHART_TAGS branch
# in the function under test) — needed to exercise the real network-read
# branch's failure path against a bad host.
run_case() { # run_case <desc> <CHART_TAGS|__UNSET__> <HEAD_CHART_VERSION> [CHART_GHCR_HOST]
  local desc="$1" tags="$2" head="$3" ghcr_host="${4:-}"
  local envs=(HEAD_CHART_VERSION="$head")
  [ "$tags" = "__UNSET__" ] || envs+=(CHART_TAGS="$tags")
  [ -z "$ghcr_host" ] || envs+=(CHART_GHCR_HOST="$ghcr_host")
  local out rc
  out="$(
    env "${envs[@]}" bash -c '
      log() { echo "$*"; }
      fail() { echo "FAIL: $*" >&2; exit 1; }
      '"$FUNC_BODY"'
      resolve_previous_chart_version
      echo "RESULT=${PREV_CHART_VERSION:-<empty>}"
    ' 2>&1
  )"
  rc=$?
  RUN_DESC="$desc"; RUN_OUT="$out"; RUN_RC="$rc"
}

echo "resolve_previous_chart_version:"

run_case "HEAD already published (0.4.0-beta.3): upgrades FROM that published artifact, the path operators on the latest release take next (#4000)" \
  "0.4.0-beta.1 0.4.0-beta.2 0.4.0-beta.3 sha256-deadbeef.sig" "0.4.0-beta.3"
check "$RUN_DESC" 0 "$RUN_RC"
check "$RUN_DESC — RESULT" "RESULT=0.4.0-beta.3" "$(printf '%s\n' "$RUN_OUT" | grep '^RESULT=')"

run_case "a stray bare 0.4.0 in the registry (#3914) ranks ABOVE its betas, so it is never picked for a beta HEAD" \
  "0.4.0 0.4.0-beta.1 0.4.0-beta.2 0.4.0-beta.3" "0.4.0-beta.3"
check "$RUN_DESC" 0 "$RUN_RC"
check "$RUN_DESC — RESULT" "RESULT=0.4.0-beta.3" "$(printf '%s\n' "$RUN_OUT" | grep '^RESULT=')"

run_case "stable HEAD after its betas resolves to the stable, not a beta" \
  "0.4.0-beta.2 0.4.0-beta.3 0.4.0" "0.4.0"
check "$RUN_DESC" 0 "$RUN_RC"
check "$RUN_DESC — RESULT" "RESULT=0.4.0" "$(printf '%s\n' "$RUN_OUT" | grep '^RESULT=')"

run_case "stable HEAD not yet published resolves to its last beta" \
  "0.4.0-beta.2 0.4.0-beta.3" "0.4.0"
check "$RUN_DESC" 0 "$RUN_RC"
check "$RUN_DESC — RESULT" "RESULT=0.4.0-beta.3" "$(printf '%s\n' "$RUN_OUT" | grep '^RESULT=')"

run_case "HEAD bumped ahead of anything published: falls back to the highest published" \
  "0.4.0-beta.1 0.4.0-beta.2" "0.4.0-beta.3"
check "$RUN_DESC" 0 "$RUN_RC"
check "$RUN_DESC — RESULT" "RESULT=0.4.0-beta.2" "$(printf '%s\n' "$RUN_OUT" | grep '^RESULT=')"

run_case "an older stable line does not get picked over a newer beta" \
  "0.3.0 0.4.0-beta.1 0.4.0-beta.2" "0.4.0-beta.3"
check "$RUN_DESC" 0 "$RUN_RC"
check "$RUN_DESC — RESULT" "RESULT=0.4.0-beta.2" "$(printf '%s\n' "$RUN_OUT" | grep '^RESULT=')"

run_case "a newer published version than HEAD is never picked" \
  "0.4.0-beta.2 0.4.0-beta.3 0.5.0-beta.1" "0.4.0-beta.3"
check "$RUN_DESC" 0 "$RUN_RC"
check "$RUN_DESC — RESULT" "RESULT=0.4.0-beta.3" "$(printf '%s\n' "$RUN_OUT" | grep '^RESULT=')"

run_case "cosign sha256-* tags are excluded from the candidate set" \
  "0.4.0-beta.1 0.4.0-beta.2 sha256-3aada sha256-be9e.sig" "0.4.0-beta.2"
check "$RUN_DESC" 0 "$RUN_RC"
check "$RUN_DESC — RESULT" "RESULT=0.4.0-beta.2" "$(printf '%s\n' "$RUN_OUT" | grep '^RESULT=')"

run_case "nothing published at or below HEAD (first-ever release): skips via exit 0, not a fail" \
  "0.4.0-beta.2" "0.4.0-beta.1"
check "$RUN_DESC — exits 0 (skip), not 1 (fail)" 0 "$RUN_RC"
check "$RUN_DESC — logs a skip, not a version" yes "$(grep -qi 'nothing to upgrade FROM yet' <<<"$RUN_OUT" && echo yes || echo no)"

run_case "an unreadable registry (CHART_TAGS unset, bad host) fails rather than silently skipping" \
  "__UNSET__" "0.4.0-beta.3" "127.0.0.1:9"
check "$RUN_DESC" 1 "$RUN_RC"

echo
if [ "$fail_count" -gt 0 ]; then
  echo "helm-upgrade-leg-version: ${fail_count} failed, ${pass} passed"
  exit 1
fi
echo "helm-upgrade-leg-version: ${pass} checks passed"
