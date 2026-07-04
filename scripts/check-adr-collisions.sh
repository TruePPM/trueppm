#!/usr/bin/env bash
# ADR number-collision gate (#918).
#
# Two ADR files that share a four-digit prefix silently corrupt the
# design-decision audit trail: a `per ADR-NNNN` reference in code, tests, or
# docs no longer resolves to a single file, and the next person to cite it
# guesses. This has recurred every time parallel branches each grabbed "the next
# free number" off a stale view of main (see #918 and the 2026-06-10 audit).
#
# This guard has two layers:
#
#   1. Same-tree scan (always): no two files under docs/adr/ may share the
#      leading NNNN prefix in the working tree. This is the durable half of #918
#      — it catches a collision that has already landed on a single branch.
#
#   2. Cross-branch scan (MR pipelines only): the same-tree scan is blind to the
#      case that actually recurs — two *separate* open branches that each add
#      the same NNNN off a stale main. Neither branch's tree contains the other's
#      file, so both pass layer 1 and the collision only appears once both merge
#      (the post-merge `main` job fails, after the damage is done). Layer 2 makes
#      it visible *before* merge by comparing the number(s) this MR adds against
#      (a) the ADR numbers already on the target branch — token-free, catches
#      "someone merged your number while your MR was open, rebase" — and (b) the
#      ADR numbers other *open* MRs add — via the GitLab API, catches two
#      simultaneously-open branches. A branch-local or pre-push check cannot see
#      (b): the colliding number exists only in the union of open MRs, which is a
#      server-side fact. That is why this layer lives in CI, not a git hook.
#
# Exit codes:
#   0  no duplicate ADR numbers
#   1  duplicate ADR number(s) found (CI fails; see output)
#   2  invocation error (ADR directory missing)
#
# Modes:
#   bash scripts/check-adr-collisions.sh             # scan docs/adr/ + (in CI MR context) cross-branch
#   bash scripts/check-adr-collisions.sh <dir>       # scan an explicit dir, same-tree only (used by --self-test)
#   bash scripts/check-adr-collisions.sh --self-test # synthesize a colliding fixture, assert exit 1
#
# Cross-branch scan (layer 2) reads these when present (all provided by GitLab CI
# in a merge_request_event pipeline):
#   CI_PIPELINE_SOURCE, CI_MERGE_REQUEST_TARGET_BRANCH_NAME, CI_MERGE_REQUEST_IID,
#   CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN
# The open-MR query uses the built-in CI_JOB_TOKEN — the same credential the
# sibling check-issue-boundary.sh / check-todo-grep.sh gates already use for
# same-project API reads, so there is no extra token to provision or rotate.
#   ADR_GATE_TOKEN   — OPTIONAL. A read_api project/group token, only needed on
#                      instances that have locked down the job-token API scope. If
#                      neither the job token nor this can query the API, the
#                      open-MR half is skipped with a warning (the target-branch
#                      half still runs); set ADR_GATE_STRICT=1 to fail instead.

set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  : >"$tmp/0042-alpha.md"
  : >"$tmp/0042-beta.md"   # deliberate collision
  : >"$tmp/0043-gamma.md"
  if bash "$0" "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a collision fixture was not detected" >&2
    exit 1
  fi
  echo "SELF-TEST PASSED: collision fixture correctly rejected"
  exit 0
fi

ADR_DIR="${1:-docs/adr}"

if [ ! -d "$ADR_DIR" ]; then
  echo "ERROR: ADR directory not found: $ADR_DIR" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Layer 1 — same-tree scan.
# Extract the leading 4-digit prefix of every NNNN-*.md file, then report any
# prefix that appears more than once. `basename` keeps the match anchored to the
# filename so a path component that happens to contain digits cannot false-trip.
# ---------------------------------------------------------------------------
dupes=$(
  for f in "$ADR_DIR"/[0-9][0-9][0-9][0-9]-*.md; do
    [ -e "$f" ] || continue
    basename "$f" | sed -E 's/^([0-9]{4})-.*/\1/'
  done | sort | uniq -d
)

if [ -n "$dupes" ]; then
  echo "✗ ADR number collision(s) detected — two files share a prefix:" >&2
  while IFS= read -r num; do
    [ -n "$num" ] || continue
    echo "  ADR-$num:" >&2
    for f in "$ADR_DIR/$num"-*.md; do
      echo "    - $f" >&2
    done
  done <<<"$dupes"
  echo >&2
  echo "Renumber the younger duplicate to the next free number (above the current" >&2
  echo "max), rename file + '# ADR-NNNN:' header, and re-point every external" >&2
  echo "'ADR-<old>' reference that means the moved file. See #918 for the playbook." >&2
  exit 1
fi

echo "✓ No same-tree ADR number collisions ($(ls "$ADR_DIR"/[0-9][0-9][0-9][0-9]-*.md 2>/dev/null | wc -l | tr -d ' ') ADRs scanned)"

# ---------------------------------------------------------------------------
# Layer 2 — cross-branch scan. Only meaningful in a GitLab MR pipeline, where we
# can compare against the live target branch and other open MRs. A non-CI run
# (local, or a non-MR pipeline) simply stops here.
# ---------------------------------------------------------------------------
if [ "${CI_PIPELINE_SOURCE:-}" != "merge_request_event" ]; then
  exit 0
fi

TARGET="${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-main}"

# Numbers THIS MR introduces relative to the merge base with target: added files
# (A) and the *destination* of a rename/copy (R/C) — a renumber `git mv`s a file
# to a new NNNN, which is a claim on that number just like a fresh add. Taking the
# last tab-field of --name-status yields the resulting path for all three.
# `|| true` on each pipeline: grep exits 1 when nothing matches, which would trip
# `set -e`/`pipefail` on the assignment before the emptiness guard below.
git fetch --quiet origin "$TARGET" 2>/dev/null || true
mine=$(
  git diff --name-status --diff-filter=ACR "origin/$TARGET...HEAD" 2>/dev/null \
    | awk -F'\t' '{print $NF}' \
    | { grep -E '^docs/adr/[0-9]{4}-.*\.md$' || true; } \
    | sed -E 's#^docs/adr/([0-9]{4})-.*#\1#' \
    | sort -u
)

if [ -z "$mine" ]; then
  echo "✓ Cross-branch ADR check: this MR adds no new ADRs — nothing to reserve."
  exit 0
fi

echo "· This MR adds ADR number(s): $(echo "$mine" | tr '\n' ' ')"

fail=0

# (a) vs. the target branch as it exists *now*. Catches a number that was merged
#     to the target while this MR was open (this branch is behind and re-uses it).
#     Pure git — no token, always runs.
target_nums=$(
  git ls-tree -r --name-only "origin/$TARGET" docs/adr/ 2>/dev/null \
    | { grep -E '^docs/adr/[0-9]{4}-.*\.md$' || true; } \
    | sed -E 's#^docs/adr/([0-9]{4})-.*#\1#' \
    | sort -u
)
while IFS= read -r n; do
  [ -n "$n" ] || continue
  if echo "$target_nums" | grep -qx "$n"; then
    echo "✗ ADR-$n is already present on '$TARGET' but this MR adds it again." >&2
    echo "  Rebase on the latest '$TARGET' and renumber your ADR to the next free number." >&2
    fail=1
  fi
done <<<"$mine"

# (b) vs. other *open* MRs targeting the same branch. This is the half that
#     catches two simultaneously-open branches — the exact failure mode of #918
#     that layers 1 and (a) cannot see.
#
#     Credential: the built-in CI_JOB_TOKEN. It authorizes same-project API reads
#     on default GitLab token scopes — the sibling gates check-issue-boundary.sh
#     and check-todo-grep.sh already rely on it for issue reads with no dedicated
#     token provisioned, so no new credential to rotate is introduced here.
#     ADR_GATE_TOKEN is an *optional* escape hatch for self-hosters who have
#     locked down their job-token API scope; it is not required.
auth_header=""
token_kind=""
if [ -n "${ADR_GATE_TOKEN:-}" ]; then
  auth_header="PRIVATE-TOKEN: ${ADR_GATE_TOKEN}"; token_kind="ADR_GATE_TOKEN"
elif [ -n "${CI_JOB_TOKEN:-}" ]; then
  auth_header="JOB-TOKEN: ${CI_JOB_TOKEN}"; token_kind="CI_JOB_TOKEN"
fi

api="${CI_API_V4_URL:-}"
pid="${CI_PROJECT_ID:-}"
iid="${CI_MERGE_REQUEST_IID:-}"

open_mr_check_ran=0
api_attempted=0
if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 \
   && [ -n "$auth_header" ] && [ -n "$api" ] && [ -n "$pid" ]; then
  api_attempted=1
  # List open MRs targeting the same branch (excluding this one).
  mrs_json=$(curl --fail --silent --show-error --max-time 20 \
    --header "$auth_header" \
    "$api/projects/$pid/merge_requests?state=opened&target_branch=$TARGET&per_page=100" 2>/dev/null) || mrs_json=""
  if [ -n "$mrs_json" ] && echo "$mrs_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    open_mr_check_ran=1
    for other in $(echo "$mrs_json" | jq -r --arg self "${iid:-}" '.[] | select((.iid|tostring) != $self) | .iid'); do
      changes=$(curl --fail --silent --show-error --max-time 20 \
        --header "$auth_header" \
        "$api/projects/$pid/merge_requests/$other/changes?per_page=200" 2>/dev/null) || continue
      others_nums=$(echo "$changes" \
        | jq -r '.changes[]? | select(.new_file == true) | .new_path' 2>/dev/null \
        | { grep -E '^docs/adr/[0-9]{4}-.*\.md$' || true; } \
        | sed -E 's#^docs/adr/([0-9]{4})-.*#\1#' | sort -u)
      [ -n "$others_nums" ] || continue
      while IFS= read -r n; do
        [ -n "$n" ] || continue
        if echo "$others_nums" | grep -qx "$n"; then
          echo "✗ ADR-$n is also added by open MR !$other." >&2
          echo "  Two open MRs claim the same ADR number. Coordinate: the second to" >&2
          echo "  merge must renumber to the next free number before merging." >&2
          fail=1
        fi
      done <<<"$mine"
    done
  fi
fi

if [ "$open_mr_check_ran" = 0 ]; then
  if [ "$api_attempted" = 1 ]; then
    # A token was present but the API call did not return an MR array — most
    # likely the job-token API scope is locked down on this instance.
    msg="⚠ Open-MR ADR check could not query the API with $token_kind (job-token scope may be restricted). Set the optional ADR_GATE_TOKEN (read_api) to enable it."
  else
    # No CI API context at all — a local run or a non-MR pipeline.
    msg="⚠ Open-MR ADR check skipped (no CI API context / curl / jq)."
  fi
  if [ "${ADR_GATE_STRICT:-0}" = "1" ]; then
    echo "$msg Failing because ADR_GATE_STRICT=1." >&2
    exit 1
  fi
  echo "$msg The target-branch check still ran; the post-merge main job remains the backstop."
fi

if [ "$fail" != 0 ]; then
  echo >&2
  echo "See #918 for the renumbering playbook." >&2
  exit 1
fi

echo "✓ Cross-branch ADR check passed — no number reused by '$TARGET' or an open MR."
exit 0
