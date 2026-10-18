#!/usr/bin/env bash
# scripts/check-scheduler-sdist.sh — the trueppm-scheduler sdist ships the files
# it should and nothing a developer's working tree happened to hold (#4520).
#
# Why this exists. packages/scheduler/pyproject.toml had no
# [tool.hatch.build.targets.sdist] block, so hatchling packed everything not named in
# packages/scheduler/.gitignore (only `mutants/`). A local `python -m build` after a
# test run produced an sdist carrying `.coverage` (a SQLite DB with the developer's
# absolute paths) and `.hypothesis/`. CI's scheduler:publish builds from a clean
# checkout so it was never affected; the exposure is a manual/fallback release.
#
# How. The real run copies packages/scheduler into a temp dir, PLANTS dev artifacts
# in the copy (so the check is a live negative control, and the working tree is never
# touched), builds the sdist, and asserts on its member list:
#   1. every required file is present (LICENSE, NOTICE, README, CHANGELOG, ...);
#   2. every top-level member is on the allow-list;
#   3. no dev artifact (.coverage*, .hypothesis, .pytest_cache, .venv, __pycache__,
#      *.pyc, ...) appears anywhere, at any depth.
# Then it builds a wheel FROM the sdist, because the wheel force-includes
# CHANGELOG.md: an allow-list that dropped a file the wheel needs would only fail at
# publish time otherwise.
#
# --self-test exercises the listing assertions on synthetic member lists (no build,
# no network), so the gate proves it can still fail inside its own CI job.
#
# Portability: bash + tar + sed + grep -E only (no `grep --include`, no GNU-isms) —
# the CI image may be BusyBox/alpine.
#
# Usage:  scripts/check-scheduler-sdist.sh [--self-test]
# Exit:   0 clean · 1 violation

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REQUIRED="LICENSE NOTICE README.md CHANGELOG.md CITATION.cff pyproject.toml PKG-INFO src/trueppm_scheduler/__init__.py tests/conftest.py scripts/check_mutation_score.py"
# Top-level members the sdist may contain. Anything else is a leak by definition.
# .gitignore is always added by hatchling itself.
ALLOWED_TOP="src tests scripts .gitignore LICENSE NOTICE README.md CHANGELOG.md CITATION.cff pyproject.toml PKG-INFO"
DEV_ARTIFACT_RE='(^|/)(\.coverage[^/]*|\.hypothesis|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|mutants|__pycache__|\.DS_Store|[^/]*\.pyc)(/|$)'

# check_listing <file with one member path per line, top-level dir already stripped>
# Prints each violation; returns non-zero if any.
check_listing() {
  local list="$1" bad=0 f top
  for f in $REQUIRED; do
    if ! grep -qxF -- "$f" "$list"; then
      echo "MISSING required member: $f"; bad=1
    fi
  done
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    top="${f%%/*}"
    case " $ALLOWED_TOP " in
      *" $top "*) ;;
      *) echo "UNEXPECTED top-level member: $f"; bad=1 ;;
    esac
    if grep -Eq "$DEV_ARTIFACT_RE" <<<"$f"; then
      echo "DEV ARTIFACT in sdist: $f"; bad=1
    fi
  done < "$list"
  return "$bad"
}

# check_wheel_listing <file with one wheel member path per line>
# scripts/check-package-licenses.sh only inspects source files and pyproject
# declarations, not a built wheel, so the license text/NOTICE landing in
# .dist-info/licenses/ of the wheel built from the sdist is asserted here (#4177).
check_wheel_listing() {
  local list="$1" bad=0 name f
  for name in LICENSE NOTICE; do
    f="$(grep -E "(^|/)[^/]+\.dist-info/licenses/$name\$" "$list" || true)"
    if [ -z "$f" ]; then
      echo "WHEEL MISSING .dist-info/licenses/$name"; bad=1
    fi
  done
  return "$bad"
}

self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  local good="$tmp/good"
  { for f in $REQUIRED; do echo "$f"; done; echo "src/trueppm_scheduler/engine.py"; } > "$good"

  expect() { # expect <pass|fail> <name> <file>
    local want="$1" name="$2" file="$3" got=0
    check_listing "$file" > "$tmp/out" 2>&1 || got=1
    if { [ "$want" = pass ] && [ "$got" -eq 0 ]; } || { [ "$want" = fail ] && [ "$got" -eq 1 ]; }; then
      echo "ok   $name"
    else
      echo "FAIL $name (wanted $want)"; cat "$tmp/out"; rc=1
    fi
  }

  expect pass "clean listing passes" "$good"
  { cat "$good"; echo ".coverage"; } > "$tmp/a";                       expect fail ".coverage is flagged" "$tmp/a"
  { cat "$good"; echo ".hypothesis/constants/x"; } > "$tmp/b";         expect fail ".hypothesis is flagged" "$tmp/b"
  { cat "$good"; echo "tests/__pycache__/x.cpython-311.pyc"; } > "$tmp/c"; expect fail "nested __pycache__ is flagged" "$tmp/c"
  { cat "$good"; echo "uv.lock"; } > "$tmp/d";                         expect fail "unlisted top-level file is flagged" "$tmp/d"
  { cat "$good"; echo "notebooks/01.ipynb"; } > "$tmp/e";              expect fail "unlisted top-level dir is flagged" "$tmp/e"
  grep -vxF NOTICE "$good" > "$tmp/f";                                 expect fail "missing NOTICE is flagged" "$tmp/f"
  grep -vxF CHANGELOG.md "$good" > "$tmp/g";                           expect fail "missing CHANGELOG.md is flagged" "$tmp/g"
  printf '%s\n' "pkg-0.1.dist-info/METADATA" "pkg-0.1.dist-info/licenses/LICENSE" "pkg-0.1.dist-info/licenses/NOTICE" > "$tmp/w1"
  printf '%s\n' "pkg-0.1.dist-info/METADATA" "pkg-0.1.dist-info/licenses/LICENSE" > "$tmp/w2"
  printf '%s\n' "pkg-0.1.dist-info/METADATA" "pkg-0.1.dist-info/licenses/NOTICE" > "$tmp/w3"
  wexpect() { # wexpect <pass|fail> <name> <file>
    local want="$1" name="$2" file="$3" got=0
    check_wheel_listing "$file" > "$tmp/out" 2>&1 || got=1
    if { [ "$want" = pass ] && [ "$got" -eq 0 ]; } || { [ "$want" = fail ] && [ "$got" -eq 1 ]; }; then
      echo "ok   $name"
    else
      echo "FAIL $name (wanted $want)"; cat "$tmp/out"; rc=1
    fi
  }
  wexpect pass "wheel with LICENSE and NOTICE passes" "$tmp/w1"
  wexpect fail "wheel without NOTICE is flagged" "$tmp/w2"
  wexpect fail "wheel without LICENSE is flagged" "$tmp/w3"
  return "$rc"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  echo "SELF-TEST OK: check-scheduler-sdist.sh detects dev artifacts, leaks and missing files."
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$REPO_ROOT/packages/scheduler" "$work/scheduler"
rm -rf "$work/scheduler/mutants"

# Negative control: plant what a local test run leaves behind, in the COPY only.
echo planted > "$work/scheduler/.coverage"
echo planted > "$work/scheduler/.coverage.host.123.456"
mkdir -p "$work/scheduler/.hypothesis/constants" "$work/scheduler/.pytest_cache" "$work/scheduler/.venv/bin"
echo planted > "$work/scheduler/.hypothesis/constants/x"
echo planted > "$work/scheduler/.pytest_cache/x"
echo planted > "$work/scheduler/.venv/bin/x"
mkdir -p "$work/scheduler/src/trueppm_scheduler/__pycache__"
echo planted > "$work/scheduler/src/trueppm_scheduler/__pycache__/x.cpython-311.pyc"

dist="$work/dist"
if command -v uv >/dev/null 2>&1; then
  (cd "$work/scheduler" && uv build --sdist --out-dir "$dist" >/dev/null)
else
  (cd "$work/scheduler" && python3 -m build --sdist --outdir "$dist" >/dev/null)
fi

sdist="$(ls "$dist"/*.tar.gz)"
tar tzf "$sdist" | sed -e 's#^[^/]*/##' -e '/^$/d' -e '/\/$/d' > "$work/members"
echo "sdist members: $(wc -l < "$work/members" | tr -d ' ')"

rc=0
check_listing "$work/members" || rc=1

# The wheel is built from the sdist by `python -m build`; prove the sdist is sufficient.
mkdir -p "$work/unpacked"
tar xzf "$sdist" -C "$work/unpacked"
src_dir="$(ls -d "$work/unpacked"/*/)"
if command -v uv >/dev/null 2>&1; then
  (cd "$src_dir" && uv build --wheel --out-dir "$work/wheel" >/dev/null) || { echo "WHEEL BUILD FROM SDIST FAILED"; rc=1; }
else
  (cd "$src_dir" && python3 -m build --wheel --outdir "$work/wheel" >/dev/null) || { echo "WHEEL BUILD FROM SDIST FAILED"; rc=1; }
fi
whl="$(ls "$work"/wheel/*.whl 2>/dev/null || true)"
if [ -n "$whl" ]; then
  python3 -c 'import sys,zipfile; print("\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))' "$whl" > "$work/wheel-members"
  check_wheel_listing "$work/wheel-members" || rc=1
fi

if [ "$rc" -ne 0 ]; then
  echo "FAIL: the trueppm-scheduler sdist is not clean (#4520). Fix [tool.hatch.build.targets.sdist] in packages/scheduler/pyproject.toml."
  exit 1
fi
echo "OK: sdist contains the required files and no dev artifacts; wheel builds from it."
