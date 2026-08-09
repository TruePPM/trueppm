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
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
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

# --- Case 3: structural — the PyPI publish contracts are closed --------------
# Same failure class as #1386, one level up: release.sh can bump a manifest and
# then not stage it, or cut a tag whose CI job does not exist. That is exactly
# how `trueppm-mcp` shipped for a whole release line with docs telling users to
# `pip install` a name that 404'd — nothing tied the manifest, the tag, and the
# publish job together (#2809). Assert the three ends meet, for BOTH PyPI
# packages, so a future package added to release.sh cannot repeat it.
echo "Case 3: every PyPI package's bump / stage / tag / job chain is closed"
CI_YML="$REPO_ROOT/.gitlab-ci.yml"

# Every path release.sh rewrites a version into must appear in the git-add block,
# or the bump is left unstaged and the tag points at the pre-bump tree.
for path in \
  packages/mcp/pyproject.toml \
  packages/mcp/uv.lock \
  packages/mcp/server.json \
  packages/mcp/src/trueppm_mcp/__init__.py
do
  if printf '%s\n' "$ADD_BLOCK" | grep -qF "$path"; then r=0; else r=1; fi
  check "git add block includes $path" "$r"
done

# release.sh must re-lock packages/mcp: mcp:publish materializes its SBOM with
# `uv sync --frozen`, which hard-fails on a lock whose self-entry still claims
# the previous version.
if grep -qF 'cd packages/mcp && uv lock' "$RELEASE_SH"; then r=0; else r=1; fi
check "release.sh re-locks packages/mcp/uv.lock after the bump" "$r"

# Each PyPI tag release.sh creates must be matched by a publish job rule, and
# vice versa — a tag with no job publishes nothing; a job with no tag never runs.
# Pairs are "<tag-prefix> <shell-var>", space-split rather than held in an array,
# for the same reason release.sh avoids arrays: macOS bash 3.2.
for pair in "scheduler SCHEDULER_TAG" "mcp MCP_TAG"; do
  # shellcheck disable=SC2086
  set -- $pair
  prefix="$1"; var="$2"

  if grep -qE "^${var}=\"${prefix}-v\\\$\(to_pep440 " "$RELEASE_SH"; then r=0; else r=1; fi
  check "release.sh computes a ${prefix}-v<PEP440> tag" "$r"

  if grep -qF "git tag -a \"\$${var}\"" "$RELEASE_SH"; then r=0; else r=1; fi
  check "release.sh cuts the ${prefix}-v tag" "$r"

  if grep -qE "CI_COMMIT_TAG =~ /\^${prefix}-v" "$CI_YML"; then r=0; else r=1; fi
  check "${prefix}:publish fires on ${prefix}-v* in .gitlab-ci.yml" "$r"

  # …and the top-level `workflow:` rules must ADMIT that tag. A tag push carries
  # no $CI_COMMIT_BRANCH, so a scheme missing from workflow: falls through the
  # catch-all and NO pipeline is created — the publish job never runs and the tag
  # looks like a clean release. Silent, and invisible until someone tries to
  # install the package. The rule must be inside `workflow:` specifically — the
  # job-level match above is satisfied by the publish job's own rules, which
  # never get evaluated if no pipeline is created. `workflow:` is not the first
  # key in the file, so the block runs from that line to the next unindented
  # line (top-level key or comment).
  WORKFLOW_BLOCK="$(awk '
    /^workflow:/                  { inblock = 1; next }
    inblock && /^[^[:space:]]/    { exit }
    inblock                       { print }
  ' "$CI_YML")"
  if printf '%s\n' "$WORKFLOW_BLOCK" | grep -qE "CI_COMMIT_TAG =~ /\^${prefix}-v"; then r=0; else r=1; fi
  check "workflow: rules create a pipeline for ${prefix}-v* tags" "$r"
done

echo ""
echo "release-staging: $pass passed, $fail failed, $skip skipped"
[[ "$fail" -eq 0 ]]
