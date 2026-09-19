#!/usr/bin/env bash
# scripts/wait-for-main-pipeline.sh — refuse to publish a release from a tag
# whose commit never passed its own `main` pipeline (#3909).
#
# GitLab pipelines are triggered per REF. Pushing `main` and a release tag at
# the same commit starts TWO INDEPENDENT pipelines: one for `main` (runs the
# full lint/analyze/test/security suite) and one for the tag (runs ONLY the
# publish/release jobs — .rules-scheduler / .rules-api / .rules-web etc. match
# `$CI_COMMIT_BRANCH == "main"` or an MR event, never `$CI_COMMIT_TAG`, so
# scheduler:test/api:test/web:test/lint/type-check do not exist in a
# tag-triggered pipeline at all). Nothing links the two pipelines. A failing
# `main` pipeline has never blocked a tag pipeline from publishing.
#
# This has shipped a real, broken release twice: 0.3.0-alpha.2, and again at
# 0.4.0-beta.2 (a scheduler test failure on the release commit — a stale
# README version pin — was discovered only after GHCR and PyPI had already
# published it, because the tag pipeline finished and published before anyone
# looked at the main pipeline it ran alongside). The comment above
# scheduler:publish already said the quiet part: "Push a `scheduler-vX.Y.Z`
# tag (after a green main pipeline) to release" — an informal rule nothing
# enforced.
#
# This script makes that rule load-bearing. Every tag-triggered publish/
# release job in .gitlab-ci.yml `needs:` a job that runs this, and it polls
# the GitLab API for a `main`-ref pipeline at $CI_COMMIT_SHA, failing closed
# unless one reaches status "success" within the timeout.
#
# Usage:
#   bash scripts/wait-for-main-pipeline.sh [sha]   # sha defaults to $CI_COMMIT_SHA
#   bash scripts/wait-for-main-pipeline.sh --self-test
#
# Env:
#   CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN — supplied by GitLab CI.
#   MAIN_PIPELINE_LIST (self-test / local use only) — command that, given a
#     SHA as $1, prints a JSON array of pipeline objects (the shape
#     GET .../pipelines?ref=main&sha=<sha> returns: at least `status`) to
#     stdout. Overriding this is what makes the polling/decision logic unit-
#     testable without a live GitLab API or a real wait.
#   WAIT_FOR_MAIN_TIMEOUT_SECONDS (default 1800), WAIT_FOR_MAIN_POLL_SECONDS
#     (default 20) — polling knobs, read fresh on every call so --self-test
#     can drive them down per case.
#
# Exit codes:
#   0  a main-ref pipeline at this SHA reached status "success"
#   1  it reached a non-success terminal status, or the wait timed out
#   2  invocation error (no SHA available, no way to reach the API)

set -euo pipefail

TERMINAL_FAILURE_STATUSES="failed canceled skipped"

# list_pipelines SHA — print a JSON array of pipeline objects for ref=main at
# SHA. Real implementation calls the GitLab API; MAIN_PIPELINE_LIST overrides
# it for self-test / local dry runs.
list_pipelines() {
  local sha="$1"
  if [ -n "${MAIN_PIPELINE_LIST:-}" ]; then
    $MAIN_PIPELINE_LIST "$sha"
    return
  fi
  if [ -z "${CI_API_V4_URL:-}" ] || [ -z "${CI_PROJECT_ID:-}" ]; then
    echo "ERROR: CI_API_V4_URL / CI_PROJECT_ID not set — not running in GitLab CI?" >&2
    exit 2
  fi
  curl -sSf --header "JOB-TOKEN: ${CI_JOB_TOKEN:-}" \
    "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/pipelines?ref=main&sha=${sha}&order_by=id&sort=desc"
}

# latest_status SHA — the status of the newest ref=main pipeline at SHA, or
# empty if none exists yet.
latest_status() {
  local sha="$1"
  list_pipelines "$sha" | python3 -c '
import json, sys
pipelines = json.load(sys.stdin)
print(pipelines[0]["status"] if pipelines else "")
'
}

wait_for_main() {
  local sha="$1"
  local timeout_seconds="${WAIT_FOR_MAIN_TIMEOUT_SECONDS:-1800}"
  local poll_seconds="${WAIT_FOR_MAIN_POLL_SECONDS:-20}"
  local elapsed=0
  local status=""

  while true; do
    status="$(latest_status "$sha")"

    if [ "$status" = "success" ]; then
      echo "OK: main pipeline at ${sha} succeeded — publish may proceed."
      return 0
    fi

    for bad in $TERMINAL_FAILURE_STATUSES; do
      if [ "$status" = "$bad" ]; then
        echo "ERROR: main pipeline at ${sha} finished with status '${status}'." >&2
        echo "       Refusing to publish a release built from a commit whose own" >&2
        echo "       main-branch pipeline did not pass. Fix main and re-tag." >&2
        return 1
      fi
    done

    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      if [ -z "$status" ]; then
        echo "ERROR: no main-ref pipeline found for ${sha} after ${timeout_seconds}s." >&2
        echo "       This tag's commit may not be on main, or main's pipeline was" >&2
        echo "       never created. Refusing to publish without proof it passed." >&2
      else
        echo "ERROR: main pipeline at ${sha} is still '${status}' after ${timeout_seconds}s." >&2
        echo "       Refusing to publish before it reaches a result." >&2
      fi
      return 1
    fi

    sleep "$poll_seconds"
    elapsed=$((elapsed + poll_seconds))
  done
}

# run_case LIST_SCRIPT TIMEOUT POLL SHA — run wait_for_main in a subshell with
# the polling knobs and fixture pinned for one self-test case, isolated from
# the caller's environment.
run_case() {
  local list="$1" timeout="$2" poll="$3" sha="$4"
  (
    export MAIN_PIPELINE_LIST="$list"
    export WAIT_FOR_MAIN_TIMEOUT_SECONDS="$timeout"
    export WAIT_FOR_MAIN_POLL_SECONDS="$poll"
    wait_for_main "$sha"
  )
}

self_test() {
  local failures=0

  check() {
    local desc="$1" expect_exit="$2"
    shift 2
    local actual_exit=0
    "$@" || actual_exit=$?
    if [ "$actual_exit" != "$expect_exit" ]; then
      echo "SELF-TEST FAIL: $desc (expected exit $expect_exit, got $actual_exit)" >&2
      failures=$((failures + 1))
    else
      echo "SELF-TEST OK: $desc."
    fi
  }

  local fixtures
  fixtures="$(mktemp -d)"

  cat > "$fixtures/success.sh" <<'EOF'
#!/usr/bin/env bash
echo '[{"status":"success","id":9999}]'
EOF
  cat > "$fixtures/failed.sh" <<'EOF'
#!/usr/bin/env bash
echo '[{"status":"failed","id":9998}]'
EOF
  cat > "$fixtures/none.sh" <<'EOF'
#!/usr/bin/env bash
echo '[]'
EOF
  # Simulates the real race: the tag pipeline starts before main's pipeline
  # is even visible, then main goes running, then succeeds. Proves the
  # polling loop actually re-checks rather than deciding on the first call.
  cat > "$fixtures/eventual-success.sh" <<'EOF'
#!/usr/bin/env bash
STATE_FILE="$0.calls"
calls="$( [ -f "$STATE_FILE" ] && cat "$STATE_FILE" || echo 0 )"
calls=$((calls + 1))
echo "$calls" > "$STATE_FILE"
if [ "$calls" -eq 1 ]; then echo '[]'
elif [ "$calls" -eq 2 ]; then echo '[{"status":"running","id":9997}]'
else echo '[{"status":"success","id":9997}]'
fi
EOF
  chmod +x "$fixtures"/*.sh

  check "a green main pipeline is accepted" 0 \
    run_case "$fixtures/success.sh" 5 1 abc123

  check "a failed main pipeline is rejected" 1 \
    run_case "$fixtures/failed.sh" 5 1 abc123

  check "no matching pipeline within the timeout is rejected" 1 \
    run_case "$fixtures/none.sh" 2 1 abc123

  check "polling waits through 'not found yet' then 'running' to 'success'" 0 \
    run_case "$fixtures/eventual-success.sh" 10 1 abc123

  rm -rf "$fixtures"

  echo ""
  if [ "$failures" -eq 0 ]; then
    echo "SELF-TEST: all cases passed."
    return 0
  else
    echo "SELF-TEST: $failures case(s) failed." >&2
    return 1
  fi
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
  fi

  local sha="${1:-${CI_COMMIT_SHA:-}}"
  if [ -z "$sha" ]; then
    echo "ERROR: no SHA given and CI_COMMIT_SHA is not set." >&2
    exit 2
  fi

  wait_for_main "$sha"
}

main "$@"
