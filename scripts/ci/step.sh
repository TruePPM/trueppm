#!/usr/bin/env bash
# scripts/ci/step.sh — run one named check inside an aggregate CI job without
# letting its failure hide the checks after it (#5090).
#
# Why this exists. GitLab caps the jobs active across open pipelines, and ~48
# single-script lint gates were each paying a container slot for seconds of
# work; 15 of 24 failed MR pipelines in one audit window ran ZERO jobs because
# of that cap. The static gates now run as aggregate jobs
# (`lint:repo-static`, `docs:static`, `api:static`, `api:analyze`,
# `scheduler:lint`, `scheduler:post-test`, `scheduler:lock-sdist`,
# `wasm:check`, `mobile:static`, `web:static`, `security:static`,
# `helm:template`, `mcp:test`). A plain `script:` list stops at the
# first failing line, so one red check would hide every later one. This wrapper
# turns each check into a step that:
#
#   * prints a `=== CHECK <name>` header and a `=== PASS|FAIL <name>` footer, so
#     the log names the failing check and a cited gate name still greps to it;
#   * records a failure and exits 0, so the next step still runs;
#   * leaves the verdict to `step.sh --finish`, the last line of the job, which
#     lists every failed check and exits non-zero.
#
# Usage:
#   bash scripts/ci/step.sh <check-name> <command> [args...]
#   bash scripts/ci/step.sh --finish
#
# Each step is its own process, so the aggregate does not depend on the job
# shell (alpine runners use sh, not bash). State lives in a per-job file.
# `CI_STEP_STATE` overrides its path (the self-test uses that).

set -u

STATE="${CI_STEP_STATE:-${TMPDIR:-/tmp}/ci-step-failed.${CI_JOB_ID:-local}}"

if [ "${1:-}" = "--finish" ]; then
  if [ -s "$STATE" ]; then
    echo
    echo "=== FAILED CHECKS ($(sort -u "$STATE" | wc -l | tr -d ' ')) ==="
    sort -u "$STATE" | sed 's/^/  - /'
    exit 1
  fi
  echo
  echo "=== ALL CHECKS PASSED ==="
  exit 0
fi

if [ "$#" -lt 2 ]; then
  echo "usage: step.sh <check-name> <command> [args...] | step.sh --finish" >&2
  exit 2
fi

name="$1"
shift

echo
echo "=== CHECK $name: $*"
"$@"
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "=== PASS  $name"
else
  echo "=== FAIL  $name (exit $rc): $*"
  echo "$name" >> "$STATE"
fi
# Always 0: the verdict is --finish's. A step that exited non-zero would stop
# the job's script list and hide every later check, which is the whole problem.
exit 0
