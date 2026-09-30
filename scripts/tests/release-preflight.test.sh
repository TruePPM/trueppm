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
#   7. the api image build is parameterized by platform (not hardcoded to
#      linux/amd64) and is invoked once per architecture CI publishes — the
#      host's native architecture as the mandatory leg, the other as a
#      best-effort QEMU-emulated leg (#4245: the two architectures' published
#      images can disagree, so a single-architecture preflight can't catch it).
#
# Run: bash scripts/tests/release-preflight.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_SH="$REPO_ROOT/scripts/release.sh"
CI_YML="$REPO_ROOT/.gitlab-ci.yml"

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
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
confirm_line="$(grep -nE '^confirm_or_override_version "' "$RELEASE_SH" | sed -n 1p | cut -d: -f1)"
call_line="$(grep -nE '^preflight_image_scan$' "$RELEASE_SH" | sed -n 1p | cut -d: -f1)"
bump_line="$(grep -nE '^bump_manifest ' "$RELEASE_SH" | sed -n 1p | cut -d: -f1)"
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
rel_ver="$(grep -E '^TRIVY_VERSION="[0-9.]+"' "$RELEASE_SH" | sed -n 1p | sed -E 's/.*"([0-9.]+)".*/\1/')"
if [[ -n "$rel_ver" ]] && grep -qE "TRIVY_VERSION=${rel_ver}([^0-9.]|$)" "$CI_YML"; then
  r=0
else
  r=1
  echo "    (release.sh TRIVY_VERSION='${rel_ver}' not found as a pin in .gitlab-ci.yml)"
fi
check "release.sh TRIVY_VERSION ($rel_ver) is pinned identically in CI" "$r"

# --- 7: builds BOTH published architectures (native mandatory, other best-effort) ---
# CI publishes both linux/amd64 (api:publish) and linux/arm64 (api:publish:arm64),
# and #4245 showed they can disagree (a stale Docker cache masked a CVE on one
# architecture's runner but not the other's, on the identical commit). A preflight
# hardcoded to one architecture cannot catch that class of drift, so the build must
# be parameterized by a $platform variable and invoked once per architecture: the
# host's own architecture as the mandatory leg (real build, fails closed), the other
# as a best-effort leg under QEMU emulation (a build crash there only warns — an
# emulation-layer problem, not a code regression — but a Trivy FINDING still dies).
echo "7: builds both architectures (native mandatory, other best-effort)"
if grep -qE 'docker build --no-cache --platform "\$platform" .*-f packages/api/Dockerfile' "$RELEASE_SH" \
   && grep -qE 'native_platform="linux/arm64"; *other_platform="linux/amd64"' "$RELEASE_SH" \
   && grep -qE 'native_platform="linux/amd64"; *other_platform="linux/arm64"' "$RELEASE_SH" \
   && grep -qE '_preflight_scan_one "\$native_platform" 1' "$RELEASE_SH" \
   && grep -qE '_preflight_scan_one "\$other_platform" 0' "$RELEASE_SH"; then
  r=0; else r=1; fi
check "api image build is parameterized and scans both architectures, native mandatory / other best-effort" "$r"

# --- 8: the Helm chart is bumped and staged with the release (#3907) --------
# Chart.yaml is not a manifest the other bumps touch, and it sat at 0.4.0 through
# the whole beta line: the chart's default image tag is v<appVersion>, so the
# published beta chart pulled an image no pipeline ever pushed. Both fields must be
# bumped through bump_manifest (which fails loudly on drift) and staged into the
# release commit, or the bump is computed and then left dangling in the tree.
echo "8: release.sh bumps Chart.yaml version + appVersion and stages it"
if grep -qE '^bump_manifest packages/helm/Chart\.yaml' "$RELEASE_SH" \
   && [[ "$(grep -cE '^bump_manifest packages/helm/Chart\.yaml' "$RELEASE_SH")" -eq 2 ]] \
   && grep -qE '^  packages/helm/Chart\.yaml \\$' "$RELEASE_SH"; then r=0; else r=1; fi
check "Chart.yaml version and appVersion each go through bump_manifest and are git-added" "$r"

echo ""
echo "release-preflight: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
