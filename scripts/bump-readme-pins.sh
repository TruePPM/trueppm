#!/usr/bin/env bash
# scripts/bump-readme-pins.sh — move the version pins the package READMEs carry
# from the release being left to the one being cut.
#
# scripts/release.sh bumps every manifest, but a README that tells a reader to
# `pip install trueppm-scheduler==X` is not a manifest, so it stayed at the
# previous release. packages/scheduler's own test suite (TestReleaseMetadata-
# Consistency) rejects that, so the 0.4.0-beta.4 release commit landed on main
# with scheduler:test red and the tags could not be pushed. The README is also
# the PyPI long description, so a stale pin is a wrong copy-paste install line on
# the package's landing page.
#
# Usage: bump-readme-pins.sh <old-pep440> <new-pep440> <old-semver> <new-semver>
#   e.g. bump-readme-pins.sh 0.4.0b3 0.4.0b4 0.4.0-beta.3 0.4.0-beta.4
#
# REPO_ROOT overrides the tree to edit (the unit test points it at a fixture).
#
# Only pins are rewritten: `trueppm-<pkg>[extra]==<version>` and the api README's
# "`<pep440>` on PyPI corresponds to git tag `v<semver>`" mapping. Prose that
# names an old version on purpose ("from 0.4.0-beta.3 or earlier") is history and
# is left alone. After rewriting, every pin in the three READMEs must equal the
# new version, otherwise this exits non-zero: a pin in a shape the rewrite did not
# recognize is exactly the silent no-op that stranded web at 0.1 (see
# bump_manifest in release.sh).

set -euo pipefail

[ "$#" -eq 4 ] || {
  echo "usage: $0 <old-pep440> <new-pep440> <old-semver> <new-semver>" >&2
  exit 64
}
OLD_PEP="$1" NEW_PEP="$2" OLD_SEMVER="$3" NEW_SEMVER="$4"
ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

READMES=(
  packages/scheduler/README.md
  packages/api/README.md
  packages/mcp/README.md
)

status=0
for rel in "${READMES[@]}"; do
  f="$ROOT/$rel"
  [ -f "$f" ] || { echo "error: $rel not found under $ROOT" >&2; exit 1; }

  OLD_PEP="$OLD_PEP" NEW_PEP="$NEW_PEP" OLD_SEMVER="$OLD_SEMVER" NEW_SEMVER="$NEW_SEMVER" \
    perl -pi -e '
      s/(trueppm-(?:scheduler|api|mcp)(?:\[[A-Za-z0-9_,-]+\])?==)\Q$ENV{OLD_PEP}\E(?![0-9A-Za-z.])/$1$ENV{NEW_PEP}/g;
      s/`\Q$ENV{OLD_PEP}\E`( on PyPI corresponds to git tag `v)\Q$ENV{OLD_SEMVER}\E`/`$ENV{NEW_PEP}`$1$ENV{NEW_SEMVER}`/g;
    ' "$f"

  # Every remaining pin must be the new version.
  while IFS= read -r pin; do
    [ -n "$pin" ] || continue
    if [ "${pin##*==}" != "$NEW_PEP" ]; then
      echo "error: $rel still pins '$pin', expected ==$NEW_PEP" >&2
      status=1
    fi
  done < <(grep -oE 'trueppm-(scheduler|api|mcp)(\[[A-Za-z0-9_,-]+\])?==[0-9][0-9A-Za-z.]*' "$f" || true)
done

# The scheduler README is the one whose pin is contractual (its test requires
# one), so a missing pin there is a failure, not a no-op.
grep -qE "trueppm-scheduler==${NEW_PEP//./\\.}" "$ROOT/packages/scheduler/README.md" || {
  echo "error: packages/scheduler/README.md has no trueppm-scheduler==$NEW_PEP pin" >&2
  status=1
}

[ "$status" -eq 0 ] && echo "  Bumped README version pins to $NEW_PEP"
exit "$status"
