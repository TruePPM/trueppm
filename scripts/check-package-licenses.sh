#!/usr/bin/env bash
#
# check-package-licenses.sh — every separately-distributed package ships its own
# license text (#2632).
#
# WHY THIS IS NOT COVERED BY THE EXISTING LICENSE JOBS
#
# `license:check:py`, `license:check:web` and `wasm:license-check` all audit
# *dependency* licenses: they verify no copyleft third-party package entered the
# tree. `wasm:license-check` in particular runs cargo-deny against deny.toml, whose
# [licenses] block is an allow-list for what our dependencies may carry. None of
# them asserts that a package we publish ships OUR OWN license text. The gate was
# green while packages/wasm-scheduler declared `license = "Apache-2.0"` and had no
# LICENSE file on disk — the check and the requirement were about different things.
#
# WHY IT MATTERS
#
# Apache 2.0 §4(a) requires recipients of a distribution to receive a copy of the
# License. The root LICENSE covers the monorepo, but it does not travel with a
# separately-published artifact: a crates.io sdist, a PyPI wheel, a packaged Helm
# chart, or an app binary each leave the repo on their own.
#
# THE DRIFT GUARD
#
# The classification below is explicit rather than inferred, because "is this
# distributed?" is a judgement no heuristic makes reliably. To stop the list going
# stale — the exact failure mode that produced #2632 — the script also asserts that
# every directory under packages/ appears in ONE of the two lists. Adding a new
# package therefore forces a deliberate decision instead of silently defaulting to
# unchecked.

set -euo pipefail

cd "$(dirname "$0")/.."

# Separately distributed: the artifact leaves this repo on its own, so the root
# LICENSE does not reach its recipient.
DISTRIBUTED=(
  scheduler       # PyPI: trueppm-scheduler
  mcp             # PyPI: trueppm-mcp
  wasm-scheduler  # crates.io-publishable; compiled .wasm ships in the web bundle
  mobile          # app binary distributed to devices
  helm            # packaged chart tarball
)

# Not separately distributed: these ship *inside* the API image or the docs site,
# both of which carry the root LICENSE (packages/api/Dockerfile copies it).
BUNDLED=(
  api
  web
  website
)

fail=0

for pkg in "${DISTRIBUTED[@]}"; do
  if [[ ! -f "packages/$pkg/LICENSE" ]]; then
    echo "ERROR: packages/$pkg is separately distributed but has no LICENSE file." >&2
    echo "       Apache 2.0 §4(a) requires the license text to travel with it." >&2
    echo "       Fix: cp LICENSE packages/$pkg/LICENSE" >&2
    fail=1
  elif ! diff -q LICENSE "packages/$pkg/LICENSE" >/dev/null 2>&1; then
    echo "ERROR: packages/$pkg/LICENSE differs from the root LICENSE." >&2
    echo "       Every OSS package carries the same Apache 2.0 text." >&2
    fail=1
  fi
done

# Drift guard: a package classified as neither is an unmade decision, not a pass.
for dir in packages/*/; do
  pkg="$(basename "$dir")"
  found=0
  for known in "${DISTRIBUTED[@]}" "${BUNDLED[@]}"; do
    [[ "$pkg" == "$known" ]] && found=1 && break
  done
  if [[ $found -eq 0 ]]; then
    echo "ERROR: packages/$pkg is classified in neither DISTRIBUTED nor BUNDLED." >&2
    echo "       Decide which it is and add it to the matching list in $0." >&2
    echo "       If it ships as its own artifact it needs its own LICENSE." >&2
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  echo >&2
  echo "package-license check FAILED" >&2
  exit 1
fi

echo "package-license check passed (${#DISTRIBUTED[@]} distributed packages carry their own LICENSE)"
