#!/usr/bin/env bash
# Exercises the release restamp (#4791) against a scratch tree: a stale
# CI_SCHEDULER_TAG is rewritten to what check-ci-api-tag.sh demands, CI_API_TAG
# is left alone, a missing variable line fails loudly, and release.sh uses it.
# Run: bash scripts/tests/release-restamp-ci-image-tag.test.sh
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
expect() { local name="$1"; shift; if ! "$@"; then echo "  FAIL: $name"; fail=$((fail + 1)); fi; return 0; }

R="$TMP/repo"
mkdir -p "$R/.gitlab/ci-images" "$R/packages/api" "$R/packages/scheduler" "$R/packages/mcp"
for f in .gitlab/ci-images/api.Dockerfile .gitlab/ci-images/scheduler.Dockerfile \
         packages/api/pyproject.toml packages/scheduler/pyproject.toml packages/mcp/pyproject.toml; do
  echo "fixture $f" >"$R/$f"
done
printf 'variables:\n  CI_API_TAG: "py3.11-aaaaaaaaaaaa"\n  CI_SCHEDULER_TAG: "py3.11-bbbbbbbbbbbb"\n' >"$R/.gitlab-ci.yml"
want="$(REPO_ROOT_OVERRIDE="$R" bash "$REPO_ROOT/scripts/check-ci-api-tag.sh" --image scheduler --print-expected)"

out="$(REPO_ROOT_OVERRIDE="$R" bash "$REPO_ROOT/scripts/release-restamp-ci-image-tag.sh" scheduler)"; rc=$?
expect "restamp exits 0" [ "$rc" -eq 0 ]
expect "prints the new tag" [ "$out" = "$want" ]
expect "CI_SCHEDULER_TAG written" grep -qF "  CI_SCHEDULER_TAG: \"$want\"" "$R/.gitlab-ci.yml"
expect "CI_API_TAG untouched" grep -qF '  CI_API_TAG: "py3.11-aaaaaaaaaaaa"' "$R/.gitlab-ci.yml"
expect "gate accepts the result" env REPO_ROOT_OVERRIDE="$R" CI_FILE_OVERRIDE="$R/.gitlab-ci.yml" bash "$REPO_ROOT/scripts/check-ci-api-tag.sh" --image scheduler

# api path too
REPO_ROOT_OVERRIDE="$R" bash "$REPO_ROOT/scripts/release-restamp-ci-image-tag.sh" api >/dev/null
expect "api restamp passes the gate" env REPO_ROOT_OVERRIDE="$R" CI_FILE_OVERRIDE="$R/.gitlab-ci.yml" bash "$REPO_ROOT/scripts/check-ci-api-tag.sh"

printf 'variables:\n  OTHER: "x"\n' >"$R/.gitlab-ci.yml"
rc=0; REPO_ROOT_OVERRIDE="$R" bash "$REPO_ROOT/scripts/release-restamp-ci-image-tag.sh" scheduler >/dev/null 2>&1 || rc=$?
expect "fails when the variable line is missing" [ "$rc" -ne 0 ]
rc=0; bash "$REPO_ROOT/scripts/release-restamp-ci-image-tag.sh" bogus >/dev/null 2>&1 || rc=$?
expect "rejects an unknown image" [ "$rc" -eq 2 ]

# shellcheck disable=SC2016
expect "release.sh restamps the scheduler tag via the script" \
  grep -qF 'scripts/release-restamp-ci-image-tag.sh scheduler' "$REPO_ROOT/scripts/release.sh"

[ "$fail" -eq 0 ] && echo "release-restamp-ci-image-tag: all cases passed." || exit 1
