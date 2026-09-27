#!/usr/bin/env bash
#
# check-package-licenses.sh — every separately-distributed package ships its own
# license text (#2632), and every PyPI package also ships the repo-root
# copyright notice (#4177).
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
# chart, or an app binary each leave the repo on their own. Apache 2.0 does not
# strictly require a NOTICE, but a standalone PyPI package with no copyright
# statement anywhere in it is an attribution-hygiene gap (#4177) — found on
# trueppm-scheduler's published wheel/sdist, and trueppm-mcp and trueppm-api
# carried the identical gap (trueppm-api shipped with neither LICENSE nor NOTICE
# at all, since its pyproject.toml declared no `license-files`).
#
# THE DRIFT GUARD
#
# The classification below is explicit rather than inferred, because "is this
# distributed?" is a judgement no heuristic makes reliably. To stop the list going
# stale — the exact failure mode that produced #2632 — the script also asserts that
# every directory under packages/ appears in ONE of the two lists. Adding a new
# package therefore forces a deliberate decision instead of silently defaulting to
# unchecked.
#
# Usage:  scripts/check-package-licenses.sh [ROOT] | --self-test
#
# ROOT defaults to the repository root and exists so --self-test can drive the real
# scan against a fixture tree. It is a filesystem comparison end to end — no
# network, no toolchain, no installed dependency tree — so a fixture root of eight
# empty directories and a stub LICENSE is a complete input to it.
#
# Exit:   0 every distributed package carries the root license (and, for PyPI
#           packages, NOTICE) text
#         1 a missing/divergent LICENSE or NOTICE, or an unclassified package
#         2 invocation error (ROOT is not a directory)

set -euo pipefail

# Absolute, so --self-test can re-invoke the real script after any cd.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# Separately distributed: the artifact leaves this repo on its own, so the root
# LICENSE does not reach its recipient.
DISTRIBUTED=(
  scheduler       # PyPI: trueppm-scheduler
  mcp             # PyPI: trueppm-mcp
  api             # PyPI: trueppm-api (api:publish:pypi) — distinct from the
                  # Docker image, which is bundled separately (Dockerfile
                  # COPYs the root LICENSE); the PyPI wheel/sdist is its own
                  # artifact and previously carried neither file (#4177)
  wasm-scheduler  # crates.io-publishable; compiled .wasm ships in the web bundle
  mobile          # app binary distributed to devices
  helm            # packaged chart tarball
)

# Not separately distributed: these ship *inside* the API image or the docs site,
# both of which carry the root LICENSE (packages/api/Dockerfile copies it).
BUNDLED=(
  web
  website
)

# Subset of DISTRIBUTED that also carries the repo-root NOTICE (#4177): the
# three PyPI packages, built with hatchling's `license-files` mechanism, which
# packages both files into the wheel's .dist-info/licenses/ and the sdist root.
# wasm-scheduler/mobile/helm are out of scope here — none of them is a hatchling
# PyPI build, and nothing has audited whether they need the same treatment.
NOTICE_REQUIRED=(
  scheduler
  mcp
  api
)

if [[ "${1:-}" == "--self-test" ]]; then
  # Prove the gate can still fail, in this job's own image, before it is trusted
  # to pass (#3195). Detection here was verified once by hand during the #3194
  # audit; a snapshot is not a guarantee, and this gate's failure mode is a green
  # pipeline. It already has form: license:check:py / license:check:web /
  # wasm:license-check were all green while packages/wasm-scheduler shipped no
  # LICENSE at all (#2632) — they were evidence about dependency licenses and
  # nothing else.
  #
  # Every case runs the REAL script against a fixture root, so there is no second
  # copy of the classification lists or the diff to drift out of step.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0

  st_probe() { # <name> <expect-pass|expect-fail> <root>
    if bash "$SELF" "$3" >/dev/null 2>&1; then
      if [[ "$2" == "expect-pass" ]]; then echo "SELF-TEST OK: $1 accepted."
      else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; st_rc=1; fi
    else
      if [[ "$2" == "expect-fail" ]]; then echo "SELF-TEST OK: $1 correctly rejected."
      else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; st_rc=1; fi
    fi
  }

  # A fixture root carrying the shape the gate reads: a root LICENSE and NOTICE,
  # every DISTRIBUTED package with a byte-identical LICENSE copy (and, for
  # NOTICE_REQUIRED packages, a byte-identical NOTICE copy too), every BUNDLED
  # package present and deliberately without either.
  st_fixture() { # <root>
    local root="$1" pkg
    printf 'Apache License 2.0 — self-test fixture, not the real license text.\n' \
      > "$root/LICENSE"
    printf 'Copyright 2026 Self-Test — not the real notice text.\n' > "$root/NOTICE"
    for pkg in "${DISTRIBUTED[@]}"; do
      mkdir -p "$root/packages/$pkg"
      cp "$root/LICENSE" "$root/packages/$pkg/LICENSE"
    done
    for pkg in "${NOTICE_REQUIRED[@]}"; do
      cp "$root/NOTICE" "$root/packages/$pkg/NOTICE"
    done
    for pkg in "${BUNDLED[@]}"; do
      mkdir -p "$root/packages/$pkg"
    done
  }

  d="$st_tmp/clean"; mkdir -p "$d"; st_fixture "$d"
  st_probe "every distributed package carries the root LICENSE and NOTICE" expect-pass "$d"

  # THE VIOLATION THIS GATE EXISTS FOR (#2632): a distributed package ships with
  # no license text, so the artifact leaves the repo without it.
  d="$st_tmp/removed"; mkdir -p "$d"; st_fixture "$d"
  rm -f "$d/packages/wasm-scheduler/LICENSE"
  st_probe "distributed package with its LICENSE removed" expect-fail "$d"

  # Present but not the same text is the same defect wearing a file: the recipient
  # gets *a* license, just not the one the project grants.
  d="$st_tmp/divergent"; mkdir -p "$d"; st_fixture "$d"
  printf 'GNU General Public License v3.\n' > "$d/packages/mcp/LICENSE"
  st_probe "distributed package whose LICENSE diverges from the root" expect-fail "$d"

  # THE VIOLATION THIS GATE EXISTS FOR (#4177): a PyPI package ships with no
  # copyright notice, so the wheel/sdist carry no attribution at all.
  d="$st_tmp/notice-removed"; mkdir -p "$d"; st_fixture "$d"
  rm -f "$d/packages/api/NOTICE"
  st_probe "PyPI package with its NOTICE removed" expect-fail "$d"

  d="$st_tmp/notice-divergent"; mkdir -p "$d"; st_fixture "$d"
  printf 'Copyright 1999 Somebody Else.\n' > "$d/packages/scheduler/NOTICE"
  st_probe "PyPI package whose NOTICE diverges from the root" expect-fail "$d"

  # The drift guard, which is what keeps the two lists from going stale — the
  # failure mode that produced #2632 in the first place.
  d="$st_tmp/unclassified"; mkdir -p "$d"; st_fixture "$d"
  mkdir -p "$d/packages/newthing"
  st_probe "package in neither DISTRIBUTED nor BUNDLED" expect-fail "$d"

  # The documented exemption has to hold too, or the gate becomes noisy enough to
  # get disabled — which is how the protection is really lost. A BUNDLED package
  # ships inside the API image or the docs site, both of which carry the root
  # LICENSE, so having none of its own is correct rather than overlooked.
  d="$st_tmp/bundled"; mkdir -p "$d"; st_fixture "$d"
  st_probe "bundled package with no LICENSE of its own" expect-pass "$d"

  # A DISTRIBUTED package outside NOTICE_REQUIRED (e.g. wasm-scheduler) needs no
  # NOTICE of its own — it is not a hatchling PyPI build, and that gap has not
  # been audited (see the NOTICE_REQUIRED comment above).
  d="$st_tmp/distributed-not-notice-required"; mkdir -p "$d"; st_fixture "$d"
  st_probe "distributed non-PyPI package with no NOTICE of its own" expect-pass "$d"

  [[ $st_rc -eq 0 ]] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [[ ! -d "$ROOT" ]]; then
  echo "ERROR: '$ROOT' is not a directory." >&2
  exit 2
fi

cd "$ROOT"

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

# NOTICE (#4177): a standalone PyPI package with no copyright statement anywhere
# in it is an attribution-hygiene gap, even though Apache 2.0 does not strictly
# require it. Scoped to NOTICE_REQUIRED, not all of DISTRIBUTED — see that
# array's comment.
for pkg in "${NOTICE_REQUIRED[@]}"; do
  if [[ ! -f "packages/$pkg/NOTICE" ]]; then
    echo "ERROR: packages/$pkg is a PyPI package but has no NOTICE file." >&2
    echo "       Its published wheel/sdist would carry no copyright statement." >&2
    echo "       Fix: cp NOTICE packages/$pkg/NOTICE" >&2
    fail=1
  elif ! diff -q NOTICE "packages/$pkg/NOTICE" >/dev/null 2>&1; then
    echo "ERROR: packages/$pkg/NOTICE differs from the root NOTICE." >&2
    echo "       Every OSS package carries the same copyright text." >&2
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

echo "package-license check passed (${#DISTRIBUTED[@]} distributed packages carry their own LICENSE, ${#NOTICE_REQUIRED[@]} PyPI packages carry their own NOTICE)"
