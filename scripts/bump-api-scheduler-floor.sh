#!/usr/bin/env bash
# Set the trueppm-scheduler range in packages/api/pyproject.toml (#4080).
#
# Usage: bump-api-scheduler-floor.sh <floor-pep440> [<ceiling-basis-pep440>]
#   bump-api-scheduler-floor.sh 0.5.0a1            # >=0.5.0a1,<0.6
#   bump-api-scheduler-floor.sh 0.4.0b4 0.5.0a1    # >=0.4.0b4,<0.6
# The ceiling is `<major.(minor+1)` of the basis, which defaults to the floor.
# release.sh passes both: the floor stays on the published line (the new
# scheduler is not on PyPI until after the release commit's pipeline), while the
# ceiling must admit the scheduler being released, or the api image - which
# pip-installs the in-tree scheduler and then the api - is resolved back onto the
# old line. After the scheduler publishes, run it with one argument to raise the
# floor (release skill, Step 4).
# REPO_ROOT overrides the tree (the unit test points it at a fixture).
# Exits non-zero if the dependency line was not rewritten - a silent no-op is how
# the floor stayed at 0.1.0a0 for four minor releases.
set -euo pipefail
[ "$#" -eq 1 ] || [ "$#" -eq 2 ] || { echo "usage: $0 <floor-pep440> [<ceiling-basis-pep440>]" >&2; exit 64; }
NEW="$1"
BASIS="${2:-$1}"
ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
f="$ROOT/packages/api/pyproject.toml"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\. ]] || { echo "error: '$NEW' is not PEP 440 X.Y.Z..." >&2; exit 64; }
[[ "$BASIS" =~ ^([0-9]+)\.([0-9]+)\. ]] || { echo "error: '$BASIS' is not PEP 440 X.Y.Z..." >&2; exit 64; }
CEIL="${BASH_REMATCH[1]}.$((BASH_REMATCH[2] + 1))"
NEW="$NEW" CEIL="$CEIL" perl -pi -e 's/"trueppm-scheduler>=[^"]*"/"trueppm-scheduler>=$ENV{NEW},<$ENV{CEIL}"/' "$f"
grep -qF "\"trueppm-scheduler>=${NEW},<${CEIL}\"" "$f" || {
  echo "error: failed to set the trueppm-scheduler floor in $f" >&2; exit 1; }
