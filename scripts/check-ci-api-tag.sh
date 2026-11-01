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
# The same mechanism covers `ci-scheduler` (#4791): it was an untagged `:py3.11`
# and `scheduler:mutation` passed on one runner and failed on another, same SHA,
# because their cached images held different pytest versions (#4787). Its tag is
# CI_SCHEDULER_TAG, digesting scheduler.Dockerfile plus the scheduler pyproject.
# Select it with `--image scheduler`; the default stays `api` so existing callers
# (release.sh, the Makefile, api:ci-api-tag) are unchanged.
#
# Modes (all accept `--image api|scheduler`, default api):
#   bash scripts/check-ci-api-tag.sh                  # check the tree
#   bash scripts/check-ci-api-tag.sh --self-test      # prove the check can fail
#   bash scripts/check-ci-api-tag.sh --print-expected # print the required tag
#
# --print-expected exists so scripts/release.sh can restamp CI_API_TAG from the
# same function this gate checks against, rather than scraping it out of the
# failure message (#4022). One definition, two readers — if they ever disagree
# the self-test below fails.
#
# Both inputs are injectable so --self-test runs the REAL check against fixture
# files rather than keeping a second copy of the parsing to drift (#3195).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TAG_PREFIX="py3.11"

# configure <api|scheduler> sets INPUTS (the files baked into the image — keep
# in sync with the matching ci:build-*-image `changes:` rules; if a file can
# alter the image, it belongs here), TAG_VAR and IMG_NAME.
configure() {
  case "$1" in
    api)
      TAG_VAR="CI_API_TAG"; IMG_NAME="ci-api"
      INPUTS=(
        ".gitlab/ci-images/api.Dockerfile"
        "packages/api/pyproject.toml"
        "packages/scheduler/pyproject.toml"
        "packages/mcp/pyproject.toml"
      ) ;;
    scheduler)
      TAG_VAR="CI_SCHEDULER_TAG"; IMG_NAME="ci-scheduler"
      INPUTS=(
        ".gitlab/ci-images/scheduler.Dockerfile"
        "packages/scheduler/pyproject.toml"
      ) ;;
    *) echo "check-ci-api-tag: unknown --image '$1' (api|scheduler)" >&2; exit 2 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@" | sha256sum | cut -d' ' -f1
  else shasum -a 256 "$@" | shasum -a 256 | cut -d' ' -f1; fi
}

# Expected tag = prefix + first 12 hex of a digest over every input's contents.
expected_tag() {
  local root="$1" f missing=0
  for f in "${INPUTS[@]}"; do
    [ -f "$root/$f" ] || { echo "check-ci-api-tag($IMG_NAME): missing input $f" >&2; missing=1; }
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
  python3 - "$1" "$TAG_VAR" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'^\s*' + re.escape(sys.argv[2]) + r':\s*"([^"]+)"', src, re.M)
print(m.group(1) if m else "")
PY
}

run_check() {
  local root="$1" ci_file="$2" fail=0 exp got

  exp="$(expected_tag "$root")" || return 1
  got="$(declared_tag "$ci_file")"

  if [ -z "$got" ]; then
    echo "✘ $TAG_VAR is not declared in $ci_file"
    fail=1
  elif [ "$got" != "$exp" ]; then
    echo "✘ $TAG_VAR is stale: declared '$got', expected '$exp'"
    echo "    An input to the $IMG_NAME image changed, so the image contents can"
    echo "    change — but the tag did not, and runners that cached the old tag"
    echo "    will keep serving it. Set $TAG_VAR to '$exp' in $ci_file."
    fail=1
  fi

  # A bare fixed tag anywhere re-opens the whole bug for that job.
  local bare
  bare="$(grep -nE "${IMG_NAME}:${TAG_PREFIX//./\\.}(\$|[^-])" "$ci_file" || true)"
  if [ -n "$bare" ]; then
    echo "✘ fixed $IMG_NAME:$TAG_PREFIX reference(s) — use \$$TAG_VAR:"
    printf '%s\n' "$bare" | sed 's/^/    /'
    fail=1
  fi

  if [ "$fail" -eq 0 ]; then
    echo "check-ci-api-tag: $TAG_VAR '$got' matches the image inputs."
  fi
  return "$fail"
}

self_test() {
  local rc=0 img
  for img in api scheduler; do
    configure "$img"
    echo "--- self-test: $img ($TAG_VAR)"
    self_test_one "$img" || rc=1
  done
  [ "$rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  return "$rc"
}

self_test_one() {
  local img="$1" tmp status rc=0 f
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp:-}"' RETURN

  _case() {
    local name="$1" expect="$2" root="$3" ci="$4"
    if run_check "$root" "$ci" >/dev/null 2>&1; then status=pass; else status=fail; fi
    if [ "$status" = "$expect" ]; then
      echo "SELF-TEST OK: $name"
    else
      echo "SELF-TEST FAILED: $name (expected $expect, got $status)"; rc=1
    fi
  }

  # Fixture tree with every input of the selected image present.
  local root="$tmp/repo"
  for f in "${INPUTS[@]}"; do
    mkdir -p "$root/$(dirname "$f")"
    echo "fixture $f" > "$root/$f"
  done
  # The input that matters for each image: a pin inside its own pyproject.
  local pin_file="packages/$img/pyproject.toml"
  [ "$img" = api ] || pin_file="packages/scheduler/pyproject.toml"
  echo 'pytest==9.1.0' > "$root/$pin_file"

  local good; good="$(expected_tag "$root")"
  local use="image: \$CI_REGISTRY_IMAGE/$IMG_NAME:\$$TAG_VAR"

  printf 'variables:\n  %s: "%s"\n  %s\n' "$TAG_VAR" "$good" "$use" > "$tmp/ok.yml"
  _case "matching tag accepted" pass "$root" "$tmp/ok.yml"

  printf 'variables:\n  %s: "py3.11-deadbeef1234"\n' "$TAG_VAR" > "$tmp/stale.yml"
  _case "stale tag rejected" fail "$root" "$tmp/stale.yml"

  printf 'variables:\n  SOMETHING_ELSE: "x"\n' > "$tmp/missing.yml"
  _case "undeclared $TAG_VAR rejected" fail "$root" "$tmp/missing.yml"

  printf 'variables:\n  %s: "%s"\n  image: $CI_REGISTRY_IMAGE/%s:py3.11\n' "$TAG_VAR" "$good" "$IMG_NAME" > "$tmp/bare.yml"
  _case "bare fixed tag rejected" fail "$root" "$tmp/bare.yml"

  # An input changing must move the expected tag — the property the gate exists for.
  echo 'pytest==9.2.0' > "$root/$pin_file"
  local moved; moved="$(expected_tag "$root")"
  if [ "$moved" != "$good" ]; then
    echo "SELF-TEST OK: changing an input moves the expected tag"
  else
    echo "SELF-TEST FAILED: input change did not move the expected tag"; rc=1
  fi
  _case "tag stale after input change rejected" fail "$root" "$tmp/ok.yml"

  # --print-expected must emit EXACTLY what run_check accepts. If the two ever
  # drift, release.sh would restamp the tag to a value this same gate then
  # rejects — turning the #4022 fix into the bug it was written to prevent.
  local printed
  printed="$(REPO_ROOT_OVERRIDE="$root" bash "${BASH_SOURCE[0]}" --image "$img" --print-expected)"
  if [ "$printed" = "$moved" ]; then
    echo "SELF-TEST OK: --print-expected agrees with the value the check demands"
  else
    echo "SELF-TEST FAILED: --print-expected emitted '$printed', check demands '$moved'"; rc=1
  fi
  printf 'variables:\n  %s: "%s"\n  %s\n' "$TAG_VAR" "$printed" "$use" > "$tmp/printed.yml"
  _case "a ci file stamped from --print-expected passes" pass "$root" "$tmp/printed.yml"

  return "$rc"
}

# Argument parsing: `--image X` may appear anywhere; one mode flag at most.
IMAGE=api
MODE=check
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2 ;;
    --self-test) MODE=self-test; shift ;;
    --print-expected) MODE=print; shift ;;
    *) echo "check-ci-api-tag: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
configure "$IMAGE"

case "$MODE" in
  self-test) self_test ;;
  print) expected_tag "${REPO_ROOT_OVERRIDE:-$REPO_ROOT}" ;;
  *) run_check "${REPO_ROOT_OVERRIDE:-$REPO_ROOT}" "${CI_FILE_OVERRIDE:-$REPO_ROOT/.gitlab-ci.yml}" ;;
esac
