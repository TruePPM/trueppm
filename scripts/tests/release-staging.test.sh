#!/usr/bin/env bash
# scripts/tests/release-staging.test.sh
#
# Guards the release commit's file staging in scripts/release.sh. release.sh runs
# assemble-changelog.sh (which folds each changelog.d/ fragment into [Unreleased]
# and rm's it), then `git add`s the release files. If changelog.d/ is missing
# from that git-add list, the fragment deletions stay unstaged and every tag ends
# up pointing at a tree that still carries already-consumed fragments — a dangling
# diff on top of every release (#1386).
#
# release.sh as a whole is not unit-testable (it computes versions, edits real
# manifests, runs `uv lock`, and creates git tags), so this guards the specific
# staging contract two ways:
#   1. structurally — the real release.sh git-add block must stage changelog.d/;
#   2. behaviorally — staging changelog.d/ after assemble-changelog.sh consumes a
#      fragment must capture the deletion. This needs git; the pinned zero-install
#      CI image has none, so the behavioral case self-skips there and the
#      structural guard carries CI. It still runs for every local dev.
#
# Run: bash scripts/tests/release-staging.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_SH="$REPO_ROOT/scripts/release.sh"
ASSEMBLE_SH="$REPO_ROOT/scripts/assemble-changelog.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
skip=0
check() { # check "<description>" <condition-exit-code>
  if [[ "$2" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $1"
    fail=$((fail + 1))
  fi
}

# --- Case 1: structural — release.sh git-add stages changelog.d/ -------------
# Extract the `git add \ ... ` continuation block (from the `git add \` line
# through the first staged path with no trailing backslash) so the assertion
# tracks the real staging list in release.sh rather than a hand-copied one.
echo "Case 1: release.sh stages changelog.d/"
ADD_BLOCK="$(awk '
  /^git add \\$/      { inblock = 1 }
  inblock             { print }
  inblock && !/\\$/   { exit }
' "$RELEASE_SH")"
if printf '%s\n' "$ADD_BLOCK" | grep -qF 'changelog.d'; then r=0; else r=1; fi
check "git add block includes changelog.d/" "$r"

# --- Case 2: behavioral — staging captures the consumed-fragment deletion ----
echo "Case 2: staging changelog.d/ captures the fragment deletion"
if ! command -v git >/dev/null 2>&1; then
  echo "  SKIP: git not available (zero-install CI image); Case 1 carries CI"
  skip=$((skip + 1))
else
  D="$TMP/repo"
  mkdir -p "$D/scripts" "$D/changelog.d"
  cp "$ASSEMBLE_SH" "$D/scripts/assemble-changelog.sh"
  cat > "$D/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

_Nothing yet._
EOF
  printf -- '- Sample fix (#77).\n' > "$D/changelog.d/77.fixed.md"
  (
    cd "$D"
    git init -q
    git config user.email t@example.com
    git config user.name test
    git add -A
    git commit -qm init
    bash scripts/assemble-changelog.sh >/dev/null   # consumes + rm's the fragment
    git add CHANGELOG.md changelog.d                 # the staging under test (#1386 fix)
  )
  # The consumed fragment must show as a STAGED deletion (index), not unstaged.
  if ( cd "$D" && git diff --cached --name-status -- changelog.d \
        | grep -qE '^D[[:space:]]+changelog\.d/77\.fixed\.md$' ); then r=0; else r=1; fi
  check "consumed fragment deletion is staged" "$r"
  # And nothing about that fragment should remain in the unstaged worktree diff.
  if ( cd "$D" && git diff --name-only -- changelog.d | grep -q '77.fixed.md' ); then r=1; else r=0; fi
  check "no leftover unstaged fragment deletion" "$r"
fi

echo ""
echo "release-staging: $pass passed, $fail failed, $skip skipped"
[[ "$fail" -eq 0 ]]
