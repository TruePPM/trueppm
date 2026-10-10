#!/usr/bin/env bash
# scripts/tests/resolve-prev-web-image.test.sh
#
# Unit test for scripts/resolve-prev-web-image.sh (ADR-1249, #4341): the choice
# of which published web image's assets a new image inherits. The publish jobs
# that consume it run only on a release tag, so a wrong pick would otherwise
# surface only at the next cut. WEB_TAGS and WEB_DIGEST stub the two registry
# reads; one case points at an unreachable host to prove a read failure is
# loud, not a silent "no prior assets".
#
# Covers: same-line pick, previous-line fallback (the path the GA
# sequential-minor guarantee depends on), the withdrawn-release skip list, and
# nothing published -> empty output plus a logged "no prior assets".
#
# Run: bash scripts/tests/resolve-prev-web-image.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/resolve-prev-web-image.sh"
DIGEST="sha256:$(printf 'a%.0s' $(seq 1 64))"

pass=0
fail_count=0
check() { # check "<description>" <expected> <actual>
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $1 — expected '$2', got '$3'"
    fail_count=$((fail_count + 1))
  fi
}

[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT not found" >&2; exit 1; }

# run <mode> <head> <tags|__UNSET__> [extra env...] — sets OUT, ERR, RC.
run() {
  local mode="$1" head="$2" tags="$3"
  shift 3
  local envs=(WEB_DIGEST="$DIGEST" "$@")
  [ "$tags" = "__UNSET__" ] || envs+=(WEB_TAGS="$tags")
  local errf
  errf="$(mktemp)"
  OUT="$(env "${envs[@]}" sh "$SCRIPT" "$mode" "$head" 2>"$errf")"
  RC=$?
  ERR="$(cat "$errf")"
  rm -f "$errf"
}

PREFIX="ghcr.io/trueppm/web@"

echo "resolve-prev-web-image:"

run --below 0.4.0-beta.9 "0.4.0-beta.6 0.4.0-beta.7 0.4.0-beta.8 0.4.0-beta.8-amd64 0.4.0-beta.8-arm64 latest arm64-smoke sha256-abc.sig"
check "same-line pick: beta.9 inherits beta.8, by digest" "${PREFIX}${DIGEST}" "$OUT"
check "same-line pick exits 0" 0 "$RC"
check "same-line pick logs the line" yes "$(grep -q 'same 0.4.x line' <<<"$ERR" && echo yes || echo no)"

run --below 0.5.0-beta.1 "0.3.0 0.4.0-beta.6 0.4.0 0.4.1 0.4.1-amd64"
check "previous-line fallback: first 0.5 image inherits the last 0.4.x" "${PREFIX}${DIGEST}" "$OUT"
check "previous-line fallback names 0.4.1" yes "$(grep -q 'web:0.4.1 (previous-line fallback' <<<"$ERR" && echo yes || echo no)"

run --below 1.3.0 "1.1.0 1.2.0 1.2.1 1.3.0-rc.1"
check "a 1.3.0 GA after its rc inherits the rc (same line beats the previous line)" yes "$(grep -q 'web:1.3.0-rc.1 (same 1.3.x line' <<<"$ERR" && echo yes || echo no)"

run --below 1.3.0 "1.1.0 1.2.0 1.2.1 1.4.0"
check "GA sequential minor: 1.3.0 with no 1.3 prerelease inherits 1.2.1, never the newer 1.4.0" yes "$(grep -q 'web:1.2.1 (previous-line fallback' <<<"$ERR" && echo yes || echo no)"

run --below 0.4.0-beta.8 "0.4.0-beta.5 0.4.0-beta.6 0.4.0-beta.7"
check "skip list: withdrawn beta.7 is dropped by default, beta.8 inherits beta.6" yes "$(grep -q 'web:0.4.0-beta.6 (same 0.4.x line; skipped: 0.4.0-beta.7)' <<<"$ERR" && echo yes || echo no)"

run --below 0.4.0-beta.8 "0.4.0-beta.6 0.4.0-beta.7" SKIP_PREV_WEB_VERSIONS=
check "an empty SKIP_PREV_WEB_VERSIONS disables the skip" yes "$(grep -q 'web:0.4.0-beta.7 ' <<<"$ERR" && echo yes || echo no)"

run --below 0.4.0-beta.8 "0.4.0-beta.6 0.4.0-beta.7" "SKIP_PREV_WEB_VERSIONS=0.4.0-beta.7 0.4.0-beta.6"
check "skip list honors every entry: nothing left -> empty" "" "$OUT"

run --below 0.4.0-beta.8 "0.4.0-beta.6 0.4.0-beta.7 0.4.0-beta.8"
check "--below never picks HEAD itself (a re-run publish job)" yes "$(grep -q 'web:0.4.0-beta.6 ' <<<"$ERR" && echo yes || echo no)"

run --at-or-below 0.4.0-beta.8 "0.4.0-beta.6 0.4.0-beta.7 0.4.0-beta.8"
check "--at-or-below picks HEAD when published (per-commit build after a cut)" yes "$(grep -q 'web:0.4.0-beta.8 ' <<<"$ERR" && echo yes || echo no)"

run --at-or-below v0.4.0-beta.7 "0.4.0-beta.6 0.4.0-beta.7"
check "--at-or-below with HEAD withdrawn falls to beta.6 (same release the Helm drill installs first)" yes "$(grep -q 'web:0.4.0-beta.6 ' <<<"$ERR" && echo yes || echo no)"

run --below 0.4.0-beta.1 "0.4.0-beta.1 0.4.0-beta.2 latest"
check "nothing published below HEAD: empty output" "" "$OUT"
check "nothing published below HEAD: exits 0, not a failure" 0 "$RC"
check "nothing published below HEAD: logs 'no prior assets'" yes "$(grep -q 'no prior assets' <<<"$ERR" && echo yes || echo no)"

run --below 0.4.0-beta.8 "0.4.0-beta.6" WEB_DIGEST=latest
check "a non-digest value is refused, never passed to the build as a mutable ref" 1 "$RC"

run --below 0.4.0-beta.8 __UNSET__ WEB_REGISTRY_HOST=127.0.0.1:9
check "an unreadable registry fails (exit 1) rather than silently building with no prior assets" 1 "$RC"

run --below not-a-version ""
check "a non-SemVer HEAD is a usage error" 1 "$RC"

echo
if [ "$fail_count" -gt 0 ]; then
  echo "resolve-prev-web-image: ${fail_count} failed, ${pass} passed"
  exit 1
fi
echo "resolve-prev-web-image: ${pass} checks passed"
