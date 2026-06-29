#!/usr/bin/env bash
# scripts/tests/release-preflight.test.sh
#
# Guards the pre-tag api-image Trivy preflight in scripts/release.sh. The api
# Docker image is Trivy-scanned only in the tag-triggered api:publish job, so a
# fixable image CVE used to first surface AFTER a tag was cut — mid-release —
# which stranded both 0.3.0-alpha.1 and -alpha.2 (both failed only api:publish;
# #1388, #1391). release.sh now builds + scans the api image BEFORE cutting a tag
# and fails closed. (The web image is left to CI's web:publish — see release.sh
# for why it can't be built on an arm64 release host.)
#
# The real build + scan needs Docker + Trivy and is validated by hand on a
# release host (the pinned zero-install CI image has neither), so this guards the
# wiring structurally — the contract that makes the preflight effective:
#   1. release.sh defines preflight_image_scan;
#   2. it is CALLED after the version is confirmed and BEFORE any manifest bump,
#      so a failure aborts with a clean tree and before a tag exists;
#   3. the scan uses the EXACT publish-job Trivy flags (drift here would let the
#      preflight pass something the publish job rejects, defeating the point);
#   4. it honors RELEASE_SKIP_IMAGE_SCAN (the documented opt-out);
#   5. it builds the api image and does NOT try to build the web image locally;
#   6. its pinned Trivy version stays in lockstep with .gitlab-ci.yml — a CI bump
#      that forgets release.sh would silently scan with a different DB/engine;
#   7. the api image builds for linux/amd64 (the published architecture).
#
# Run: bash scripts/tests/release-preflight.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_SH="$REPO_ROOT/scripts/release.sh"
CI_YML="$REPO_ROOT/.gitlab-ci.yml"

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  if [[ "$2" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $1"
    fail=$((fail + 1))
  fi
}

# --- 1: defines the preflight function ---------------------------------------
echo "1: release.sh defines preflight_image_scan"
if grep -qE '^preflight_image_scan\(\) \{' "$RELEASE_SH"; then r=0; else r=1; fi
check "preflight_image_scan() is defined" "$r"

# --- 2: called after version-confirm, before the first manifest bump ---------
# The preflight must gate AFTER the operator confirms the version (don't build
# images for a release that may be aborted at the prompt) and BEFORE bump_manifest
# (so a CVE aborts with a clean tree and no tag). Compare line numbers of the
# call sites (the bare `preflight_image_scan` call, not its definition).
echo "2: preflight runs after confirm and before the first bump"
confirm_line="$(grep -nE '^confirm_or_override_version "' "$RELEASE_SH" | head -1 | cut -d: -f1)"
call_line="$(grep -nE '^preflight_image_scan$' "$RELEASE_SH" | head -1 | cut -d: -f1)"
bump_line="$(grep -nE '^bump_manifest ' "$RELEASE_SH" | head -1 | cut -d: -f1)"
if [[ -n "$confirm_line" && -n "$call_line" && -n "$bump_line" \
      && "$confirm_line" -lt "$call_line" && "$call_line" -lt "$bump_line" ]]; then
  r=0
else
  r=1
  echo "    (confirm=$confirm_line call=$call_line bump=$bump_line)"
fi
check "call site is between confirm_or_override_version and bump_manifest" "$r"

# --- 3: exact publish-job Trivy flags ----------------------------------------
echo "3: scan uses the exact publish-job Trivy flags"
if grep -qE 'trivy image .*--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1' "$RELEASE_SH"; then
  r=0; else r=1; fi
check "trivy invocation matches --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1" "$r"

# --- 4: honors the documented opt-out ----------------------------------------
echo "4: honors RELEASE_SKIP_IMAGE_SCAN"
if grep -q 'RELEASE_SKIP_IMAGE_SCAN' "$RELEASE_SH"; then r=0; else r=1; fi
check "RELEASE_SKIP_IMAGE_SCAN opt-out is wired" "$r"

# --- 5: builds the api image (repo-root context) -----------------------------
# Scoped to the api image: it is where every release hiccup has occurred and it
# builds reliably on the release host. The web image is gated by CI's web:publish
# (its rolldown bundler has no working build path on an arm64 release host), so
# the preflight must NOT try to build it — that would make it unrunnable locally.
echo "5: builds the api image and does not build the web image"
if grep -qE 'docker build .*-f packages/api/Dockerfile' "$RELEASE_SH" \
   && ! grep -qE 'cd packages/web && docker build' "$RELEASE_SH"; then r=0; else r=1; fi
check "builds api (repo-root context); does not build the web image locally" "$r"

# --- 6: Trivy version pin stays in lockstep with CI --------------------------
# release.sh prefers a host trivy but pins a containerized fallback; that pin and
# the version CI installs must match so both scan with the same engine/DB schema.
echo "6: TRIVY_VERSION matches the pin in .gitlab-ci.yml"
rel_ver="$(grep -E '^TRIVY_VERSION="[0-9.]+"' "$RELEASE_SH" | head -1 | sed -E 's/.*"([0-9.]+)".*/\1/')"
if [[ -n "$rel_ver" ]] && grep -qE "TRIVY_VERSION=${rel_ver}([^0-9.]|$)" "$CI_YML"; then
  r=0
else
  r=1
  echo "    (release.sh TRIVY_VERSION='${rel_ver}' not found as a pin in .gitlab-ci.yml)"
fi
check "release.sh TRIVY_VERSION ($rel_ver) is pinned identically in CI" "$r"

# --- 7: builds for the published architecture (linux/amd64) ------------------
# The CI runners publish linux/amd64 images; building host-arch on an Apple
# Silicon release host would scan a different artifact than what ships. The api
# build must pin --platform linux/amd64 (runs under emulation on an arm64 host).
echo "7: builds for linux/amd64 (the published architecture)"
if grep -qE 'docker build --platform linux/amd64 .*-f packages/api/Dockerfile' "$RELEASE_SH"; then
  r=0; else r=1; fi
check "api image build pins --platform linux/amd64" "$r"

echo ""
echo "release-preflight: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
