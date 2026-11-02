#!/usr/bin/env bash
# scripts/release-restamp-ci-image-tag.sh <api|scheduler> — rewrite CI_API_TAG /
# CI_SCHEDULER_TAG in .gitlab-ci.yml to the value scripts/check-ci-api-tag.sh
# demands, then re-run that check. Used by release.sh after the manifest bump has
# invalidated the stamp (#4022, #4791). Factored out so the restamp is testable
# against a scratch tree (scripts/tests/release-restamp-ci-image-tag.test.sh).
#
# REPO_ROOT_OVERRIDE points both the digest inputs and .gitlab-ci.yml at a
# scratch tree.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${REPO_ROOT_OVERRIDE:-$(cd "$HERE/.." && pwd)}"
IMG="${1:-}"
case "$IMG" in
  api) VAR=CI_API_TAG ;;
  scheduler) VAR=CI_SCHEDULER_TAG ;;
  *) echo "usage: restamp-ci-image-tag.sh api|scheduler" >&2; exit 2 ;;
esac
CI="$ROOT/.gitlab-ci.yml"

NEW="$(REPO_ROOT_OVERRIDE="$ROOT" bash "$HERE/check-ci-api-tag.sh" --image "$IMG" --print-expected)" \
  || { echo "restamp: failed to compute the expected $VAR" >&2; exit 1; }
[ -n "$NEW" ] || { echo "restamp: empty expected $VAR" >&2; exit 1; }
sed -i.bak "s/^\(  $VAR: \).*\$/\1\"${NEW}\"/" "$CI" && rm "$CI.bak"
grep -qF "$VAR: \"${NEW}\"" "$CI" \
  || { echo "restamp: failed to write $VAR into .gitlab-ci.yml (expected a '  $VAR: \"...\"' line)" >&2; exit 1; }
# Ask the gate itself rather than trusting the sed.
REPO_ROOT_OVERRIDE="$ROOT" CI_FILE_OVERRIDE="$CI" bash "$HERE/check-ci-api-tag.sh" --image "$IMG" >/dev/null \
  || { echo "restamp: $VAR is still stale after restamping" >&2; exit 1; }
echo "$NEW"
