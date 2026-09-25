#!/usr/bin/env bash
# Raise the trueppm-scheduler floor in packages/api/pyproject.toml to the release
# being cut, keeping the `<0.(minor+1)` ceiling in step (#4080).
#
# Usage: bump-api-scheduler-floor.sh <new-pep440>     e.g. 0.4.0b5
# REPO_ROOT overrides the tree (the unit test points it at a fixture).
# Exits non-zero if the dependency line was not rewritten - a silent no-op is how
# the floor stayed at 0.1.0a0 for four minor releases.
set -euo pipefail
[ "$#" -eq 1 ] || { echo "usage: $0 <new-pep440>" >&2; exit 64; }
NEW="$1"
ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
f="$ROOT/packages/api/pyproject.toml"
[[ "$NEW" =~ ^([0-9]+)\.([0-9]+)\. ]] || { echo "error: '$NEW' is not PEP 440 X.Y.Z..." >&2; exit 64; }
CEIL="${BASH_REMATCH[1]}.$((BASH_REMATCH[2] + 1))"
NEW="$NEW" CEIL="$CEIL" perl -pi -e 's/"trueppm-scheduler>=[^"]*"/"trueppm-scheduler>=$ENV{NEW},<$ENV{CEIL}"/' "$f"
grep -qF "\"trueppm-scheduler>=${NEW},<${CEIL}\"" "$f" || {
  echo "error: failed to set the trueppm-scheduler floor in $f" >&2; exit 1; }
