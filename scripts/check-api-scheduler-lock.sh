#!/usr/bin/env bash
# Fail when packages/api/uv.lock resolves trueppm-scheduler to an older release
# LINE than the scheduler this tree ships, or when the api's declared range cannot
# admit that scheduler at all (#4080).
#
# The API imports scheduler symbols (derive.Quantity, engine privates) that only
# exist in the scheduler it is tagged with. `uv lock --check` cannot see this: it
# proves the lock satisfies pyproject.toml, and a floor of >=0.1.0a0 let the lock
# sit at 0.2.0a1 - a locked install that cannot even import the app.
#
# Compared on (major, minor) only, not the pre-release segment: pre-1.0 minors
# are where private symbols move, and the api's `>=X,<0.(minor+1)` range holds
# the rest.
#
# The one sanctioned exception is the release commit of a new minor. The api
# lock resolves the scheduler from PyPI, and the scheduler the release commit
# bumps to is published only AFTER that commit's main pipeline is green
# (tag:wait-for-main) - so at a minor boundary the lock cannot reach the new line
# on the commit that introduces it. It is tolerated exactly when:
#   - HEAD's subject is `chore(release): bump version to ...` (scripts/release.sh),
#   - HEAD is a single-parent commit (release.sh commits directly on main; an MR
#     lands as a merge commit, so its subject can never match here), and
#   - HEAD bumped packages/mcp to the same version in the same commit, as
#     release.sh's lockstep bump does - a hand-made MR commit that borrows the
#     subject but moves only the scheduler does not qualify,
#   - the lock sits on the line of the scheduler HEAD^ shipped (the release being
#     left, which is published) - so HEAD itself moved the scheduler onto a new
#     line, and the lock trails by that one line, never more.
# Every later commit fails until the post-publish raise lands (release skill,
# Step 4: bump-api-scheduler-floor.sh + `uv lock --upgrade-package`). The range
# check below is NOT relaxed on the release commit: release.sh widens the ceiling
# so the tree's own scheduler is admissible, or the api image (which pip-installs
# the in-tree scheduler, then the api) would be resolved back onto the old line.
#
#   bash scripts/check-api-scheduler-lock.sh             # check the tree
#   bash scripts/check-api-scheduler-lock.sh --self-test # prove it can fail
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RELEASE_SUBJECT_RE='^chore\(release\): bump version to '

line_of() { # "0.4.0b4" -> "0.4"
  printf '%s\n' "$1" | sed -E 's/^([0-9]+)\.([0-9]+).*/\1.\2/'
}
line_lt() { # line_lt 0.4 0.5 -> true when $1 < $2
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | sed -n 1p)" = "$1" ]
}
sched_version() { # stdin: scheduler pyproject.toml
  sed -nE 's/^version = "([^"]+)".*/\1/p' | sed -n 1p
}
git_() { git -c safe.directory='*' -C "$1" "${@:2}"; }

check() {
  local root="$1" want have range floor ceil subject prev parents mcp_now mcp_prev
  want="$(sched_version <"$root/packages/scheduler/pyproject.toml")"
  have="$(awk '/^name = "trueppm-scheduler"$/ {f=1; next} f && /^version = / {gsub(/[" ]|version=/, "", $0); sub(/^version=/, "", $0); print; exit}' \
    "$root/packages/api/uv.lock" | tr -d '"' | sed 's/^version *= *//')"
  if [ -z "$want" ] || [ -z "$have" ]; then
    echo "FAIL: could not read scheduler version ('$want') or api lock entry ('$have')" >&2
    return 1
  fi

  # The declared range must admit the scheduler this tree ships, always.
  range="$(sed -nE 's/.*"trueppm-scheduler>=([^,"]+),<([^"]+)".*/\1 \2/p' "$root/packages/api/pyproject.toml" | sed -n 1p)"
  floor="${range% *}"; ceil="${range#* }"
  if [ -z "$range" ]; then
    echo "FAIL: packages/api/pyproject.toml has no \"trueppm-scheduler>=X,<Y\" dependency" >&2
    return 1
  fi
  if line_lt "$(line_of "$want")" "$(line_of "$floor")" || ! line_lt "$(line_of "$want")" "$(line_of "$ceil")"; then
    echo "FAIL: packages/api/pyproject.toml declares trueppm-scheduler>=$floor,<$ceil, which excludes" >&2
    echo "      the scheduler this tree ships ($want). Run: bash scripts/bump-api-scheduler-floor.sh <floor> $want" >&2
    return 1
  fi

  if ! line_lt "$(line_of "$have")" "$(line_of "$want")"; then
    echo "OK: api lock trueppm-scheduler $have covers scheduler $want"
    return 0
  fi

  subject="$(git_ "$root" log -1 --format=%s 2>/dev/null || true)"
  parents="$(git_ "$root" rev-list --parents -n 1 HEAD 2>/dev/null | wc -w | tr -d ' ' || true)"
  prev="$(git_ "$root" show HEAD^:packages/scheduler/pyproject.toml 2>/dev/null | sched_version || true)"
  mcp_now="$(sched_version <"$root/packages/mcp/pyproject.toml" 2>/dev/null || true)"
  mcp_prev="$(git_ "$root" show HEAD^:packages/mcp/pyproject.toml 2>/dev/null | sched_version || true)"
  if printf '%s\n' "$subject" | grep -qE "$RELEASE_SUBJECT_RE" &&
     [ "$parents" = "2" ] &&
     [ -n "$prev" ] &&
     [ "$mcp_now" = "$want" ] && [ "$mcp_prev" != "$want" ] &&
     [ "$(line_of "$have")" = "$(line_of "$prev")" ]; then
    echo "OK (release commit): api lock trueppm-scheduler $have trails scheduler $want by one line;"
    echo "    $want is not on PyPI until this commit's tags publish. Raise it right after:"
    echo "    bash scripts/bump-api-scheduler-floor.sh $want && (cd packages/api && uv lock --upgrade-package trueppm-scheduler)"
    return 0
  fi

  echo "FAIL: packages/api/uv.lock pins trueppm-scheduler $have but the tree ships $want." >&2
  echo "      If $want is published, raise it (release skill, Step 4):" >&2
  echo "        bash scripts/bump-api-scheduler-floor.sh $want && (cd packages/api && uv lock --upgrade-package trueppm-scheduler)" >&2
  echo "      Only the release commit that bumped the scheduler may trail by one line." >&2
  return 1
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  st_fail() { echo "self-test FAIL: $1" >&2; exit 1; }
  # tree <scheduler> <api floor> <api ceiling> <lock> [mcp version, default = scheduler]
  tree() {
    mkdir -p "$tmp/packages/scheduler" "$tmp/packages/api" "$tmp/packages/mcp"
    printf 'version = "%s"\n' "$1" >"$tmp/packages/scheduler/pyproject.toml"
    printf 'version = "%s"\n' "${5:-$1}" >"$tmp/packages/mcp/pyproject.toml"
    printf 'dependencies = [\n    "trueppm-scheduler>=%s,<%s",\n]\n' "$2" "$3" >"$tmp/packages/api/pyproject.toml"
    printf '[[package]]\nname = "trueppm-scheduler"\nversion = "%s"\n' "$4" >"$tmp/packages/api/uv.lock"
  }
  commit() {
    git -C "$tmp" add -A >/dev/null
    git -C "$tmp" -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c core.hooksPath=/dev/null \
      commit -q --allow-empty -m "$1"
  }
  pass() { check "$tmp" >/dev/null 2>&1 || st_fail "$1 was rejected"; }
  reject() { ! check "$tmp" >/dev/null 2>&1 || st_fail "$1 passed"; }

  # Outside git (no history): the plain line comparison.
  tree 0.4.0b4 0.4.0b4 0.5 0.2.0a1; reject "0.2.0a1 lock under 0.4.0b4"
  tree 0.4.0b4 0.4.0b4 0.5 0.3.0a3; reject "0.3.0a3 lock under 0.4.0b4"
  tree 0.4.0b4 0.4.0b4 0.5 0.4.0b3; pass "same-line lock"
  tree 0.4.0b4 0.4.0b4 0.5 0.4.0b4; pass "exact lock"
  tree 0.4.0b4 0.4.0b4 0.4 0.4.0b4; reject "a ceiling that excludes the tree's scheduler"
  tree 0.4.0b4 0.5.0a1 0.6 0.5.0a1; reject "a floor above the tree's scheduler"

  git -C "$tmp" init -q
  tree 0.4.0b4 0.4.0b4 0.5 0.4.0b4; commit "feat: last commit before the cut"

  # The minor-boundary release commit release.sh produces: scheduler 0.5.0a1,
  # floor kept on the published line, ceiling widened, lock still 0.4.0b4.
  tree 0.5.0a1 0.4.0b4 0.6 0.4.0b4; commit "chore(release): bump version to 0.5.0-alpha.1"
  pass "minor-boundary release commit (lock one line behind)"

  # The same tree under any other commit: the raise is overdue.
  commit "feat: the next change after the release"
  reject "lock one line behind on a non-release commit"

  # A release commit that did not bump the scheduler (HEAD^ already 0.5.0a1).
  commit "chore(release): bump version to 0.5.0-alpha.2"
  reject "release subject without a scheduler bump in HEAD"

  # A hand-made scheduler bump that is not the release commit.
  git -C "$tmp" reset -q --hard HEAD~3
  tree 0.5.0a1 0.4.0b4 0.6 0.4.0b4; commit "chore(scheduler): bump to 0.5.0a1"
  reject "scheduler bumped to a new line outside a release commit"

  # Release commit, but the lock is two lines behind (#4080 itself at a cut).
  git -C "$tmp" reset -q --hard HEAD~1
  tree 0.5.0a1 0.4.0b4 0.6 0.3.0a3; commit "chore(release): bump version to 0.5.0-alpha.1"
  reject "release commit with the lock two lines behind"

  # Release commit written by the pre-fix fallback: ceiling left at <0.5.
  git -C "$tmp" reset -q --hard HEAD~1
  tree 0.5.0a1 0.4.0b4 0.5 0.4.0b4; commit "chore(release): bump version to 0.5.0-alpha.1"
  reject "release commit whose range excludes the new scheduler"

  # Release commit inside a line: the lock is already on it, no exemption needed.
  git -C "$tmp" reset -q --hard HEAD~1
  tree 0.4.0b5 0.4.0b4 0.5 0.4.0b4; commit "chore(release): bump version to 0.4.0-beta.5"
  pass "in-line release commit"

  # Borrowed subject on an MR commit that moved only the scheduler (mcp left behind).
  git -C "$tmp" reset -q --hard HEAD~1
  tree 0.5.0a1 0.4.0b4 0.6 0.4.0b4 0.4.0b4; commit "chore(release): bump version to 0.5.0-alpha.1"
  reject "release subject without the lockstep mcp bump"

  # The release commit arriving as a merge commit (an MR, not release.sh's direct push).
  git -C "$tmp" reset -q --hard HEAD~1
  git -C "$tmp" checkout -q -b side
  tree 0.5.0a1 0.4.0b4 0.6 0.4.0b4; commit "feat: side work"
  git -C "$tmp" checkout -q -
  git -C "$tmp" -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    merge -q --no-ff side -m "chore(release): bump version to 0.5.0-alpha.1"
  reject "release subject on a merge commit"

  # After publish: the raise lands and the tree is clean again.
  git -C "$tmp" reset -q --hard HEAD~1
  tree 0.5.0a1 0.4.0b4 0.6 0.4.0b4; commit "chore(release): bump version to 0.5.0-alpha.1"
  tree 0.5.0a1 0.5.0a1 0.6 0.5.0a1; commit "chore(api): raise the trueppm-scheduler floor to 0.5.0a1"
  pass "post-publish raise"

  echo "self-test OK"
  exit 0
fi
check "$REPO_ROOT"
