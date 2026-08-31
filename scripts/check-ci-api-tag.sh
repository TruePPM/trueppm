#!/usr/bin/env bash
# scripts/check-ci-api-tag.sh — the ci-api image tag must change whenever the
# image's contents can change (#3275).
#
# Why this exists. `ci-api` was published as a fixed tag, `:py3.11`, and our
# self-hosted runners pull `if-not-present` — so a runner that already held
# `:py3.11` never re-pulled it, and served whatever it had cached. Three
# different digests ran the SAME commit during one batch: one reported 41 mypy
# errors, two reported none. The verdict of `api:type-check` was decided by how
# old a runner's image cache was, not by the code.
#
# This is the identical failure #2825 hit on `playwright-base:noble` — "a name
# that never changed when its contents did". The fix there was to version-stamp
# the tag, minting a name no runner can have cached. `pull_policy: always` is
# NOT an available substitute: these are self-hosted group runners and the job
# is rejected unless `allowed_pull_policies` is widened first.
#
# So the tag carries a digest of the image's own inputs. Change any of them and
# the expected tag changes; this gate fails until CI_API_TAG is updated to match,
# and the new tag name is by construction one no runner holds.
#
# Note what this does NOT cover: a scheduled rebuild pushes to the same computed
# tag when no input changed. That is safe only because the mypy toolchain is
# pinned exact in packages/api/pyproject.toml — a rebuild with identical inputs
# is meant to produce identical contents. If transitive drift ever reopens this,
# the fix is to stop the schedule from overwriting a stamped tag, not to widen
# this gate.
#
# Modes:
#   bash scripts/check-ci-api-tag.sh             # check the tree
#   bash scripts/check-ci-api-tag.sh --self-test # prove the check can fail
#
# Both inputs are injectable so --self-test runs the REAL check against fixture
# files rather than keeping a second copy of the parsing to drift (#3195).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The files baked into the image. Keep in sync with ci:build-api-image's
# `changes:` rules — if a file can alter the image, it belongs here.
INPUTS=(
  ".gitlab/ci-images/api.Dockerfile"
  "packages/api/pyproject.toml"
  "packages/scheduler/pyproject.toml"
  "packages/mcp/pyproject.toml"
)

TAG_PREFIX="py3.11"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@" | sha256sum | cut -d' ' -f1
  else shasum -a 256 "$@" | shasum -a 256 | cut -d' ' -f1; fi
}

# Expected tag = prefix + first 12 hex of a digest over every input's contents.
expected_tag() {
  local root="$1" f missing=0
  for f in "${INPUTS[@]}"; do
    [ -f "$root/$f" ] || { echo "check-ci-api-tag: missing input $f" >&2; missing=1; }
  done
  [ "$missing" -eq 0 ] || return 1
  local paths=()
  for f in "${INPUTS[@]}"; do paths+=("$root/$f"); done
  # Hash contents only — sha256sum embeds the path, which would make the tag
  # depend on the checkout directory and differ between a worktree and CI.
  local digest
  digest="$(cat "${paths[@]}" | sha256_of - | cut -c1-12)"
  printf '%s-%s\n' "$TAG_PREFIX" "$digest"
}

declared_tag() {
  python3 - "$1" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'^\s*CI_API_TAG:\s*"([^"]+)"', src, re.M)
print(m.group(1) if m else "")
PY
}

run_check() {
  local root="$1" ci_file="$2" fail=0 exp got

  exp="$(expected_tag "$root")" || return 1
  got="$(declared_tag "$ci_file")"

  if [ -z "$got" ]; then
    echo "✘ CI_API_TAG is not declared in $ci_file"
    fail=1
  elif [ "$got" != "$exp" ]; then
    echo "✘ CI_API_TAG is stale: declared '$got', expected '$exp'"
    echo "    An input to the ci-api image changed, so the image contents can"
    echo "    change — but the tag did not, and runners that cached the old tag"
    echo "    will keep serving it. Set CI_API_TAG to '$exp' in $ci_file."
    fail=1
  fi

  # A bare fixed tag anywhere re-opens the whole bug for that job.
  local bare
  bare="$(grep -nE "ci-api:${TAG_PREFIX//./\\.}(\$|[^-])" "$ci_file" || true)"
  if [ -n "$bare" ]; then
    echo "✘ fixed ci-api:$TAG_PREFIX reference(s) — use \$CI_API_TAG:"
    printf '%s\n' "$bare" | sed 's/^/    /'
    fail=1
  fi

  if [ "$fail" -eq 0 ]; then
    echo "check-ci-api-tag: CI_API_TAG '$got' matches the image inputs."
  fi
  return "$fail"
}

self_test() {
  local tmp status rc=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  _case() {
    local name="$1" expect="$2" root="$3" ci="$4"
    if run_check "$root" "$ci" >/dev/null 2>&1; then status=pass; else status=fail; fi
    if [ "$status" = "$expect" ]; then
      echo "SELF-TEST OK: $name"
    else
      echo "SELF-TEST FAILED: $name (expected $expect, got $status)"; rc=1
    fi
  }

  # Fixture tree with all four inputs present.
  local root="$tmp/repo"
  mkdir -p "$root/.gitlab/ci-images" "$root/packages/api" "$root/packages/scheduler" "$root/packages/mcp"
  echo "FROM python:3.11-slim" > "$root/.gitlab/ci-images/api.Dockerfile"
  echo 'mypy==1.20.2'          > "$root/packages/api/pyproject.toml"
  echo 'scheduler'             > "$root/packages/scheduler/pyproject.toml"
  echo 'mcp'                   > "$root/packages/mcp/pyproject.toml"

  local good; good="$(expected_tag "$root")"

  printf 'variables:\n  CI_API_TAG: "%s"\n  image: $CI_REGISTRY_IMAGE/ci-api:$CI_API_TAG\n' "$good" > "$tmp/ok.yml"
  _case "matching tag accepted" pass "$root" "$tmp/ok.yml"

  printf 'variables:\n  CI_API_TAG: "py3.11-deadbeef1234"\n' > "$tmp/stale.yml"
  _case "stale tag rejected" fail "$root" "$tmp/stale.yml"

  printf 'variables:\n  SOMETHING_ELSE: "x"\n' > "$tmp/missing.yml"
  _case "undeclared CI_API_TAG rejected" fail "$root" "$tmp/missing.yml"

  printf 'variables:\n  CI_API_TAG: "%s"\n  image: $CI_REGISTRY_IMAGE/ci-api:py3.11\n' "$good" > "$tmp/bare.yml"
  _case "bare fixed tag rejected" fail "$root" "$tmp/bare.yml"

  # An input changing must move the expected tag — the property the gate exists for.
  echo 'mypy==1.21.0' > "$root/packages/api/pyproject.toml"
  local moved; moved="$(expected_tag "$root")"
  if [ "$moved" != "$good" ]; then
    echo "SELF-TEST OK: changing an input moves the expected tag"
  else
    echo "SELF-TEST FAILED: input change did not move the expected tag"; rc=1
  fi
  _case "tag stale after input change rejected" fail "$root" "$tmp/ok.yml"

  [ "$rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  return "$rc"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_check "${REPO_ROOT_OVERRIDE:-$REPO_ROOT}" "${CI_FILE_OVERRIDE:-$REPO_ROOT/.gitlab-ci.yml}"
fi
