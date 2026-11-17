#!/usr/bin/env bash
# List the Playwright spec files an MR adds or modifies, for web:e2e:soak (#2753).
#
# Usage:
#   scripts/ci/changed-e2e-specs.sh <base-sha> [head-ref]   # prints one path per line,
#                                                           # relative to packages/web
#   scripts/ci/changed-e2e-specs.sh --self-test
#
# Why a script and not an inline `git diff`: the soak job's spec list has to
# exclude what playwright.config.ts ignores (integration/** and
# marketing-shots.spec.ts), and a deleted spec must not be passed to Playwright
# (it errors on a missing path). A list that silently included either would turn
# the soak red for a reason unrelated to flakiness.
set -euo pipefail

list() { # list <base> <head>
  git diff --no-renames --name-only --diff-filter=AM "$1" "$2" -- 'packages/web/e2e/*.spec.ts' \
    | grep -v -e '^packages/web/e2e/integration/' -e '^packages/web/e2e/marketing-shots\.spec\.ts$' \
    | sed 's|^packages/web/||' || true
}

self_test() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  (
    cd "$tmp"
    git init -q . && git config user.email t@t && git config user.name t
    mkdir -p packages/web/e2e/integration
    for f in keep gone; do echo 1 > "packages/web/e2e/$f.spec.ts"; done
    echo 1 > packages/web/e2e/integration/live.spec.ts
    echo 1 > packages/web/e2e/marketing-shots.spec.ts
    git add . && git commit -qm base
    echo 2 >> packages/web/e2e/keep.spec.ts
    echo 1 > packages/web/e2e/new.spec.ts
    echo 2 >> packages/web/e2e/integration/live.spec.ts
    echo 2 >> packages/web/e2e/marketing-shots.spec.ts
    echo 2 > packages/web/e2e/helper.ts
    git rm -q packages/web/e2e/gone.spec.ts
    git add . && git commit -qm change
    got="$(list HEAD~1 HEAD | sort | tr '\n' ' ')"
    want="e2e/keep.spec.ts e2e/new.spec.ts "
    if [ "$got" != "$want" ]; then
      echo "self-test FAILED: got '$got', want '$want'" >&2
      exit 1
    fi
  )
  echo "changed-e2e-specs self-test ok"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi
[ $# -ge 1 ] || { echo "usage: $0 <base-sha> [head-ref]" >&2; exit 2; }
list "$1" "${2:-HEAD}"
