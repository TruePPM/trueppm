#!/usr/bin/env bash
# Fail when packages/api/uv.lock resolves trueppm-scheduler to an older release
# LINE than the scheduler this tree ships, or when the api's declared range cannot
# admit that scheduler at all (#4080). Also fail when packages/api/uv.lock resolves
# one of the LOCAL scheduler's own runtime dependencies (networkx, numpy, ...) to a
# version that does not satisfy what packages/scheduler/pyproject.toml declares
# (#4185).
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
# --- Transitive dependency check (#4185) -----------------------------------
# The api image installs the LOCAL scheduler source with `--no-deps` and
# excludes trueppm-scheduler from the lock export (`--no-emit-package
# trueppm-scheduler`, see packages/api/Dockerfile). So networkx and numpy come
# from whatever version packages/api/uv.lock resolved for the PyPI
# trueppm-scheduler entry - NOT from anything the local scheduler source
# declares. Both installs are --no-deps, so pip never cross-checks this; a
# same-line floor bump in packages/scheduler/pyproject.toml that has not yet
# been released to PyPI (so the api's own scheduler entry can't see it either)
# would go unenforced anywhere and only surface as a runtime import/behavior
# failure inside the built image.
#
# This walks every requirement in packages/scheduler/pyproject.toml's
# `[project] dependencies` array (not the dev/optional extras - those are
# never installed into the api image), resolves the matching package's locked
# version from packages/api/uv.lock, and checks the version satisfies every
# comma-separated clause of the declared specifier. A requirement whose
# environment marker evaluates false for the target runtime (Python 3.11,
# Linux - see packages/api/Dockerfile) is skipped, since it is never
# installed there either way. Anything else - a marker key this script does
# not recognize - is enforced rather than skipped: erring toward a false
# alarm is safer than erring toward silently dropping a real constraint.
#
#   bash scripts/check-api-scheduler-lock.sh             # check the tree
#   bash scripts/check-api-scheduler-lock.sh --self-test # prove it can fail
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RELEASE_SUBJECT_RE='^chore\(release\): bump version to '
# The api image's runtime interpreter/OS (packages/api/Dockerfile pins
# python:3.11-slim on a Debian/glibc Linux base) - the reference used to
# decide whether a scheduler dependency's environment marker applies.
SCHED_TARGET_PYTHON="3.11"
SCHED_TARGET_PLATFORM="linux"

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

# version_cmp() - compare two dotted version strings with `sort -V`.
# Prints "lt", "eq", or "gt" for $1 <=> $2.
version_cmp() {
  if [ "$1" = "$2" ]; then
    echo eq
    return
  fi
  local first
  first="$(printf '%s\n%s\n' "$1" "$2" | sort -V | sed -n 1p)"
  if [ "$first" = "$1" ]; then echo lt; else echo gt; fi
}

# version_cmp_ok VERSION OP BOUND -> exit 0 when "VERSION OP BOUND" holds.
# Only the operators that appear anywhere in this repo's pyproject.toml files
# today (==, !=, <, <=, >, >=) are handled; an unrecognized operator is a
# malformed requirement and fails loudly rather than being ignored.
version_cmp_ok() {
  local v="$1" op="$2" b="$3" cmp
  cmp="$(version_cmp "$v" "$b")"
  case "$op" in
  '==') [ "$cmp" = eq ] ;;
  '!=') [ "$cmp" != eq ] ;;
  '>=') [ "$cmp" = eq ] || [ "$cmp" = gt ] ;;
  '<=') [ "$cmp" = eq ] || [ "$cmp" = lt ] ;;
  '>') [ "$cmp" = gt ] ;;
  '<') [ "$cmp" = lt ] ;;
  *)
    echo "FAIL: unrecognized version comparison operator '$op'" >&2
    return 1
    ;;
  esac
}

# canon_name() - PEP 503-ish normalization so "trueppm-scheduler",
# "trueppm_scheduler" and "TruePPM-Scheduler" compare equal.
canon_name() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E 's/[-_.]+/-/g'
}

# sched_dependencies_of() - stdin: packages/scheduler/pyproject.toml ->
# one raw requirement string per line, from the `[project] dependencies`
# array only (never the `[project.optional-dependencies]` dev extras, which
# the api image never installs).
sched_dependencies_of() {
  awk '
    /^dependencies = \[/ { indeps = 1; next }
    indeps && /^\]/ { indeps = 0; next }
    indeps { print }
  ' | sed -nE 's/^[[:space:]]*"([^"]*)".*/\1/p'
}

# parse_requirement REQ -> prints NAME\nSPEC\nMARKER (3 lines). Strips a
# `[extra,extra]` marker-independent extras suffix on the name if present.
parse_requirement() {
  local req="$1" name body spec marker
  name="$(printf '%s' "$req" | sed -E 's/^([A-Za-z0-9][A-Za-z0-9_.-]*).*/\1/')"
  body="${req#"$name"}"
  body="${body#*]}" # drop a leading "[extra,...]" if present; no-op otherwise
  if [[ "$body" == *";"* ]]; then
    spec="${body%%;*}"
    marker="${body#*;}"
  else
    spec="$body"
    marker=""
  fi
  spec="$(printf '%s' "$spec" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  marker="$(printf '%s' "$marker" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  printf '%s\n%s\n%s\n' "$name" "$spec" "$marker"
}

# marker_applies MARKER -> exit 0 when the requirement applies to the api
# image's target runtime (or MARKER is empty). Recognizes python_version /
# python_full_version and sys_platform clauses; anything else is treated as
# applying, since this script cannot prove it does not (see file header).
marker_applies() {
  local marker="$1" op val
  [ -z "$marker" ] && return 0
  if [[ "$marker" =~ ^python_(full_)?version[[:space:]]*(==|!=|\<=|\>=|\<|\>)[[:space:]]*[\"\']([0-9][0-9A-Za-z.]*)[\"\']$ ]]; then
    op="${BASH_REMATCH[2]}"
    val="${BASH_REMATCH[3]}"
    version_cmp_ok "$SCHED_TARGET_PYTHON" "$op" "$val"
    return $?
  fi
  if [[ "$marker" =~ ^sys_platform[[:space:]]*(==|!=)[[:space:]]*[\"\']([A-Za-z0-9_]+)[\"\']$ ]]; then
    op="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    if [ "$op" = "==" ]; then
      [ "$val" = "$SCHED_TARGET_PLATFORM" ]
    else
      [ "$val" != "$SCHED_TARGET_PLATFORM" ]
    fi
    return $?
  fi
  return 0 # unrecognized marker key: cannot prove it doesn't apply -> enforce
}

# specifier_satisfied VERSION SPEC -> exit 0 when VERSION satisfies every
# comma-separated clause of SPEC (e.g. ">=3.0,<4").
specifier_satisfied() {
  local version="$1" spec="$2" clause op val
  IFS=',' read -ra clauses <<<"$spec"
  for clause in "${clauses[@]}"; do
    clause="$(printf '%s' "$clause" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [ -z "$clause" ] && continue
    if [[ "$clause" =~ ^(==|!=|\<=|\>=|\<|\>)[[:space:]]*([0-9][0-9A-Za-z.+_-]*)$ ]]; then
      op="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      version_cmp_ok "$version" "$op" "$val" || return 1
    else
      echo "FAIL: unrecognized version specifier clause '$clause' in \"$spec\" - cannot verify it" >&2
      return 1
    fi
  done
  return 0
}

# lock_version_of PKG -> stdin: a uv.lock file; prints the resolved version
# of the first `[[package]]` block whose name matches PKG (canonicalized), or
# nothing if PKG has no entry.
lock_version_of() {
  local want
  want="$(canon_name "$1")"
  awk -v want="$want" '
    /^\[\[package\]\]/ { name = "" }
    /^name = / {
      name = $0
      sub(/^name = "/, "", name)
      sub(/".*$/, "", name)
    }
    /^version = / && name != "" {
      canon = tolower(name)
      gsub(/[-_.]+/, "-", canon)
      if (canon == want) {
        v = $0
        sub(/^version = "/, "", v)
        sub(/".*$/, "", v)
        print v
        exit
      }
      name = "" # only the first version= line per block is the package version
    }
  '
}

# check_scheduler_deps ROOT -> exit 0 when every requirement in
# packages/scheduler/pyproject.toml's dependencies array is satisfied by the
# version packages/api/uv.lock resolved for that package (#4185).
check_scheduler_deps() {
  local root="$1" req name spec marker locked lines status=0
  while IFS= read -r req; do
    [ -z "$req" ] && continue
    lines="$(parse_requirement "$req")"
    name="$(sed -n 1p <<<"$lines")"
    spec="$(sed -n 2p <<<"$lines")"
    marker="$(sed -n 3p <<<"$lines")"
    if ! marker_applies "$marker"; then
      continue
    fi
    locked="$(lock_version_of "$name" <"$root/packages/api/uv.lock")"
    if [ -z "$locked" ]; then
      echo "FAIL: packages/scheduler/pyproject.toml requires \"$req\", but packages/api/uv.lock has no" >&2
      echo "      entry for '$name'. The api installs the local scheduler with --no-deps, so this lock" >&2
      echo "      entry is the ONLY source of that dependency at runtime." >&2
      status=1
      continue
    fi
    if [ -n "$spec" ] && ! specifier_satisfied "$locked" "$spec"; then
      echo "FAIL: packages/api/uv.lock resolves $name==$locked, which does not satisfy the local" >&2
      echo "      scheduler's declared requirement \"$req\" (packages/scheduler/pyproject.toml)." >&2
      echo "      Both the local scheduler and the api install with --no-deps, so pip never catches" >&2
      echo "      this; it would surface only as a runtime failure. Raise packages/api/uv.lock's" >&2
      echo "      $name pin, or lower the scheduler's floor to a version already released to PyPI." >&2
      status=1
    fi
  done < <(sched_dependencies_of <"$root/packages/scheduler/pyproject.toml")
  return $status
}

check() {
  local root="$1" want have range floor ceil subject prev parents mcp_now mcp_prev
  local own_line_status=0 deps_status=0
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
  else
    subject="$(git_ "$root" log -1 --format=%s 2>/dev/null || true)"
    parents="$(git_ "$root" rev-list --parents -n 1 HEAD 2>/dev/null | wc -w | tr -d ' ' || true)"
    prev="$(git_ "$root" show HEAD^:packages/scheduler/pyproject.toml 2>/dev/null | sched_version || true)"
    mcp_now="$(sched_version <"$root/packages/mcp/pyproject.toml" 2>/dev/null || true)"
    mcp_prev="$(git_ "$root" show HEAD^:packages/mcp/pyproject.toml 2>/dev/null | sched_version || true)"
    if grep -qE "$RELEASE_SUBJECT_RE" <<<"$subject" &&
      [ "$parents" = "2" ] &&
      [ -n "$prev" ] &&
      [ "$mcp_now" = "$want" ] && [ "$mcp_prev" != "$want" ] &&
      [ "$(line_of "$have")" = "$(line_of "$prev")" ]; then
      echo "OK (release commit): api lock trueppm-scheduler $have trails scheduler $want by one line;"
      echo "    $want is not on PyPI until this commit's tags publish. Raise it right after:"
      echo "    bash scripts/bump-api-scheduler-floor.sh $want && (cd packages/api && uv lock --upgrade-package trueppm-scheduler)"
    else
      echo "FAIL: packages/api/uv.lock pins trueppm-scheduler $have but the tree ships $want." >&2
      echo "      If $want is published, raise it (release skill, Step 4):" >&2
      echo "        bash scripts/bump-api-scheduler-floor.sh $want && (cd packages/api && uv lock --upgrade-package trueppm-scheduler)" >&2
      echo "      Only the release commit that bumped the scheduler may trail by one line." >&2
      own_line_status=1
    fi
  fi

  check_scheduler_deps "$root" || deps_status=1

  [ "$own_line_status" -eq 0 ] && [ "$deps_status" -eq 0 ]
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
  # tree_deps <scheduler+api version> <dep requirement, e.g. "networkx>=3.0,<4 ; python_version >= '3.0'"> <dep locked version>
  # A minimal fixture isolating the transitive-dependency check (#4185): the
  # scheduler's OWN version line always matches the lock exactly, so only the
  # declared dependency's satisfaction (or lack of it) can flip the result.
  tree_deps() {
    local dep_name
    dep_name="$(printf '%s' "$2" | sed -E 's/^([A-Za-z0-9][A-Za-z0-9_.-]*).*/\1/')"
    mkdir -p "$tmp/packages/scheduler" "$tmp/packages/api" "$tmp/packages/mcp"
    printf 'version = "%s"\ndependencies = [\n    "%s",\n]\n' "$1" "$2" >"$tmp/packages/scheduler/pyproject.toml"
    printf 'version = "%s"\n' "$1" >"$tmp/packages/mcp/pyproject.toml"
    printf 'dependencies = [\n    "trueppm-scheduler>=%s,<9.9",\n]\n' "$1" >"$tmp/packages/api/pyproject.toml"
    printf '[[package]]\nname = "trueppm-scheduler"\nversion = "%s"\n\n[[package]]\nname = "%s"\nversion = "%s"\n' \
      "$1" "$dep_name" "$3" >"$tmp/packages/api/uv.lock"
  }
  # tree_deps_missing <scheduler+api version> <dep requirement> - same as
  # tree_deps but writes NO matching [[package]] entry for the dependency.
  tree_deps_missing() {
    mkdir -p "$tmp/packages/scheduler" "$tmp/packages/api" "$tmp/packages/mcp"
    printf 'version = "%s"\ndependencies = [\n    "%s",\n]\n' "$1" "$2" >"$tmp/packages/scheduler/pyproject.toml"
    printf 'version = "%s"\n' "$1" >"$tmp/packages/mcp/pyproject.toml"
    printf 'dependencies = [\n    "trueppm-scheduler>=%s,<9.9",\n]\n' "$1" >"$tmp/packages/api/pyproject.toml"
    printf '[[package]]\nname = "trueppm-scheduler"\nversion = "%s"\n' "$1" >"$tmp/packages/api/uv.lock"
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

  # --- transitive scheduler dependency checks (#4185) ---
  tree_deps 0.4.0b4 "networkx>=3.0,<4" 3.6.1
  pass "locked networkx 3.6.1 satisfies the tree's declared >=3.0,<4"
  tree_deps 0.4.0b4 "numpy>=1.26,<3" 2.4.6
  pass "locked numpy 2.4.6 satisfies the tree's declared >=1.26,<3"
  tree_deps 0.4.0b4 "networkx>=5.0,<6" 3.6.1
  reject "a local scheduler floor (>=5.0) raised above the PyPI-resolved lock (3.6.1) - the fixture the issue asked for"
  tree_deps 0.4.0b4 "networkx>=3.0,<4" 4.1.0
  reject "a locked version (4.1.0) above the scheduler's declared ceiling (<4)"
  tree_deps 0.4.0b4 "numpy==1.26.0" 1.26.4
  reject "an exact-pin requirement the locked version does not match"
  tree_deps_missing 0.4.0b4 "networkx>=3.0,<4"
  reject "a scheduler dependency with no matching entry in the api lock at all"
  # A marker that does not apply to the api image's target runtime (Python
  # 3.11) must be skipped even though the bare specifier would fail loudly.
  tree_deps 0.4.0b4 "impossible-pkg<1.0 ; python_version < '3.0'" 999.0.0
  pass "a requirement whose python_version marker does not apply is skipped, not enforced"
  tree_deps 0.4.0b4 "impossible-pkg<1.0 ; python_version >= '3.0'" 999.0.0
  reject "a requirement whose python_version marker DOES apply is still enforced"
  tree_deps 0.4.0b4 "impossible-pkg<1.0 ; sys_platform == 'win32'" 999.0.0
  pass "a requirement scoped to a sys_platform the api image never runs on is skipped"

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
