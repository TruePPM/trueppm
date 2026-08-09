#!/usr/bin/env bash
# Every Playwright version in the tree must equal the tag of the Docker image the
# Playwright-using CI jobs run in (#2797).
#
# The mcr.microsoft.com/playwright image bakes browser binaries into a
# version-stamped path (/ms-playwright/chromium_headless_shell-<rev>/…). A
# Playwright npm package only ever looks in the path matching ITS OWN revision,
# so an image/package mismatch is not a soft degrade — the launch fails outright
# with "Executable doesn't exist".
#
# That failure is loud in `web:e2e` (specs go red) but SILENT in `website:build`:
# rehype-mermaid's launch throws, Astro's starlight-docs-loader catches it, logs
# `[ERROR] Failed to parse Markdown file …`, drops the ENTIRE page body, still
# emits index.html, and `astro build` exits 0. Three docs pages published as bare
# navigation chrome for 19 days on green pipelines, because a caret in
# packages/website let `npm ci` float 1.58.2 → 1.61.1 under a v1.58.2-noble image.
#
# So the version is pinned in four places that have no automatic relationship to
# each other, and this gate is what ties them together. Both npm pins must be
# EXACT (no caret): a range re-opens exactly the drift this gate exists to catch,
# and `npm ci` resolves the lockfile without ever consulting the image.
#
# Modes:
#   bash scripts/check-playwright-pins.sh             # check the tree
#   bash scripts/check-playwright-pins.sh --self-test # prove the check can fail

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CI_YML=".gitlab-ci.yml"
DOCKERFILE=".gitlab/ci-images/integration.Dockerfile"
WEB_PKG="packages/web/package.json"
WEB_LOCK="packages/web/package-lock.json"
SITE_PKG="packages/website/package.json"
SITE_LOCK="packages/website/package-lock.json"

# Declared range for a dependency, from either dependency section.
declared() {
  python3 -c "
import json,sys
d = json.load(open(sys.argv[1]))
for sec in ('dependencies', 'devDependencies'):
    if sys.argv[2] in d.get(sec, {}):
        print(d[sec][sys.argv[2]]); break
" "$1" "$2"
}

# Version `npm ci` will actually install — the lockfile is the only thing that
# decides this, which is why checking package.json alone would not have caught
# #2797 (the caret was there from the start; the lockfile is what moved).
resolved() {
  python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['packages'].get('node_modules/' + sys.argv[2], {}).get('version', ''))
" "$1" "$2"
}

run_check() {
  local root="$1" fail=0 expected base_tag arg_tag

  _note() { echo "  VIOLATION: $1"; fail=1; }

  for f in "$CI_YML" "$DOCKERFILE" "$WEB_PKG" "$WEB_LOCK" "$SITE_PKG" "$SITE_LOCK"; do
    if [ ! -f "$root/$f" ]; then
      echo "ERROR: pinned file not found: $f" >&2
      echo "       If it moved, update the path list in $0 — do not delete the guard." >&2
      return 2
    fi
  done

  # The reference: the image tag CI actually runs. v1.58.2-noble -> 1.58.2
  base_tag="$(sed -n 's/^[[:space:]]*PLAYWRIGHT_BASE_TAG:[[:space:]]*"\(.*\)".*/\1/p' "$root/$CI_YML" | head -1)"
  if [ -z "$base_tag" ]; then
    echo "ERROR: could not read PLAYWRIGHT_BASE_TAG from $CI_YML" >&2
    return 2
  fi
  expected="${base_tag#v}"; expected="${expected%%-*}"

  # The Dockerfile ARG default keeps a local `docker build` honest.
  arg_tag="$(sed -n 's|^ARG PLAYWRIGHT_BASE=mcr.microsoft.com/playwright:\(.*\)$|\1|p' "$root/$DOCKERFILE" | head -1)"
  if [ -z "$arg_tag" ]; then
    _note "$DOCKERFILE: no 'ARG PLAYWRIGHT_BASE=mcr.microsoft.com/playwright:<tag>' line"
  elif [ "$arg_tag" != "$base_tag" ]; then
    _note "$DOCKERFILE ARG default is '$arg_tag', expected '$base_tag'"
  fi

  check_pkg() {
    local label="$1" pkg="$2" lock="$3" dep="$4" decl res
    decl="$(declared "$root/$pkg" "$dep")"
    res="$(resolved "$root/$lock" "$dep")"

    if [ -z "$decl" ]; then
      _note "$label: '$dep' is not declared in $pkg"
    else
      # An exact pin is the whole point — a caret is how #2797 happened.
      case "$decl" in
        [0-9]*.[0-9]*.[0-9]*) ;;
        *) _note "$label: $pkg declares \"$dep\": \"$decl\" — must be EXACT (no ^ or ~)" ;;
      esac
      [ "$decl" = "$expected" ] \
        || _note "$label: $pkg declares \"$dep\": \"$decl\", expected \"$expected\""
    fi

    if [ -z "$res" ]; then
      _note "$label: $lock has no resolved 'node_modules/$dep' entry"
    elif [ "$res" != "$expected" ]; then
      _note "$label: $lock resolves $dep to $res, expected $expected (run 'npm install --package-lock-only')"
    fi
  }

  # packages/web drives web:e2e; packages/website drives website:build + pages.
  check_pkg "packages/web"     "$WEB_PKG"  "$WEB_LOCK"  "@playwright/test"
  check_pkg "packages/website" "$SITE_PKG" "$SITE_LOCK" "playwright"

  # Both trees also carry a transitive playwright runtime; a stale one there is
  # the same launch failure, so hold it to the same version.
  local lock dep v
  for lock in "$WEB_LOCK" "$SITE_LOCK"; do
    for dep in playwright playwright-core; do
      v="$(resolved "$root/$lock" "$dep")"
      [ -z "$v" ] || [ "$v" = "$expected" ] \
        || _note "$lock resolves $dep to $v, expected $expected"
    done
  done

  if [ "$fail" -ne 0 ]; then
    cat <<EOF

Playwright pins disagree with the CI image (PLAYWRIGHT_BASE_TAG = $base_tag).

A mismatch fails the browser launch. In web:e2e that is loud; in website:build it
is SILENT — Astro drops the page body and still exits 0, publishing blank docs.

To bump Playwright, change ALL FOUR together, then regenerate both lockfiles
with 'npm install --package-lock-only':
  1. $CI_YML  ->  PLAYWRIGHT_BASE_TAG
  2. $DOCKERFILE  ->  ARG PLAYWRIGHT_BASE default
  3. $WEB_PKG  ->  "@playwright/test"  (exact)
  4. $SITE_PKG  ->  "playwright"  (exact)
EOF
    return 1
  fi

  echo "✅ Playwright pinned to $expected across CI image, integration.Dockerfile, packages/web, packages/website"
  return 0
}

# A gate that has only ever been observed passing is indistinguishable from a
# gate with a typo in its pattern. These cases are the two real failure shapes:
# the lockfile floating away from a correct declaration (#2797 itself), and an
# image bump that leaves the npm pins behind (the same outage, inverted).
self_test() {
  local tmp status
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  mkdir -p "$tmp/.gitlab/ci-images" "$tmp/packages/web" "$tmp/packages/website"

  _fixture() {  # $1 = image tag, $2 = web range, $3 = web resolved,
                # $4 = site range, $5 = site resolved
    printf 'variables:\n  PLAYWRIGHT_BASE_TAG: "%s"\n' "$1" > "$tmp/$CI_YML"
    # shellcheck disable=SC2016  # ${PLAYWRIGHT_BASE} is Dockerfile syntax, must stay literal
    printf 'ARG PLAYWRIGHT_BASE=mcr.microsoft.com/playwright:%s\nFROM ${PLAYWRIGHT_BASE}\n' "$1" \
      > "$tmp/$DOCKERFILE"
    printf '{"devDependencies":{"@playwright/test":"%s"}}\n' "$2" > "$tmp/$WEB_PKG"
    printf '{"packages":{"node_modules/@playwright/test":{"version":"%s"},"node_modules/playwright":{"version":"%s"},"node_modules/playwright-core":{"version":"%s"}}}\n' \
      "$3" "$3" "$3" > "$tmp/$WEB_LOCK"
    printf '{"devDependencies":{"playwright":"%s"}}\n' "$4" > "$tmp/$SITE_PKG"
    printf '{"packages":{"node_modules/playwright":{"version":"%s"},"node_modules/playwright-core":{"version":"%s"}}}\n' \
      "$5" "$5" > "$tmp/$SITE_LOCK"
  }

  # Case 1: everything agrees. Must pass.
  _fixture "v1.58.2-noble" "1.58.2" "1.58.2" "1.58.2" "1.58.2"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELF-TEST FAIL: a fully-agreeing tree was reported as drifted (exit $status)" >&2
    return 1
  fi

  # Case 2: #2797 exactly — website lockfile floated above its own declaration.
  _fixture "v1.58.2-noble" "1.58.2" "1.58.2" "^1.58.2" "1.61.1"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: a lockfile floated to 1.61.1 under a v1.58.2 image was not caught (exit $status)" >&2
    return 1
  fi

  # Case 3: image bumped, npm pins left behind — the same outage, inverted.
  _fixture "v1.61.1-noble" "1.58.2" "1.58.2" "1.58.2" "1.58.2"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: an image bump with stale npm pins was not caught (exit $status)" >&2
    return 1
  fi

  # Case 4: a caret that currently happens to resolve correctly is STILL a
  # violation — it is one `npm install` away from case 2, which is the state
  # packages/web was in when #2797 was found.
  _fixture "v1.58.2-noble" "^1.58.2" "1.58.2" "1.58.2" "1.58.2"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: a caret range resolving correctly today was not flagged (exit $status)" >&2
    return 1
  fi

  # Case 5: a pinned file that has moved must error, not silently pass.
  rm "$tmp/$SITE_LOCK"
  status=0; run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 2 ]; then
    echo "SELF-TEST FAIL: a missing pinned file exited $status, expected 2" >&2
    return 1
  fi

  echo "SELF-TEST OK: agreement passes; floated lockfile, stale pins after an image bump, a still-correct caret, and a missing file all caught."
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_check "$REPO_ROOT"
fi
