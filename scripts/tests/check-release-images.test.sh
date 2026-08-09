#!/usr/bin/env bash
# scripts/tests/check-release-images.test.sh
#
# Unit test for scripts/check-release-images.sh — the nightly release-image
# existence gate (#2803).
#
# The gate is only worth having if it FAILS when an image is gone, so the cases
# below are weighted toward proving that. The bug it guards against produced a
# green pipeline and a 404 registry for a full day: the tag pipeline had passed,
# the cleanup policy deleted the images afterwards, and every signal we had kept
# reading green. A check that has only ever been observed passing against a
# healthy registry would reproduce exactly that, so the missing-image path is
# tested first and hardest.
#
# The registry is stubbed via RELEASE_IMAGE_PROBE, so no daemon, no network, and
# no registry credentials are needed — the logic under test is the verdict, not
# the transport.
#
# Run: bash scripts/tests/check-release-images.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-release-images.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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

# A stub probe: exits 0 for any reference listed in $TMP/present, else 1.
cat > "$TMP/probe.sh" <<'SH'
#!/usr/bin/env bash
grep -Fxq "$1" "$PRESENT_FILE"
SH
chmod +x "$TMP/probe.sh"

# present <ref>... — declare exactly which references the registry serves.
present() {
  : > "$TMP/present"
  local ref
  for ref in "$@"; do echo "$ref" >> "$TMP/present"; done
}

run_gate() { # sets $OUT and $RC; never aborts under `set -e`
  set +e
  OUT="$(
    CI_REGISTRY_IMAGE="registry.example.com/trueppm/trueppm" \
    RELEASE_IMAGE_PROBE="$TMP/probe.sh" \
    PRESENT_FILE="$TMP/present" \
    bash "$GATE" "$@" 2>&1
  )"
  RC=$?
  set -e
}

API_TAG="registry.example.com/trueppm/trueppm/api:v0.3.0-alpha.3"
WEB_TAG="registry.example.com/trueppm/trueppm/web:v0.3.0-alpha.3"

# --- Must FAIL: the reaped-release-image case that produced #2803 -----------

echo "check-release-images: both images reaped (the #2803 case)"
present  # registry serves nothing
run_gate "v0.3.0-alpha.3"
check "exits 1 when both release images are gone" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
check "names the missing api reference" "$(grep -q "$API_TAG" <<<"$OUT" && echo 0 || echo 1)"
check "names the missing web reference" "$(grep -q "$WEB_TAG" <<<"$OUT" && echo 0 || echo 1)"
check "points at the cleanup policy as the cause" \
  "$(grep -qi "name_regex_keep" <<<"$OUT" && echo 0 || echo 1)"

echo "check-release-images: one image reaped, one surviving"
present "$API_TAG"
run_gate "v0.3.0-alpha.3"
check "exits 1 when only one image is missing" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
check "does not list the surviving image as missing" \
  "$(grep -q "MISSING $API_TAG" <<<"$OUT" && echo 1 || echo 0)"
check "lists the missing image" "$(grep -q "MISSING $WEB_TAG" <<<"$OUT" && echo 0 || echo 1)"

# --- Must PASS: a healthy registry ------------------------------------------

echo "check-release-images: both images present"
present "$API_TAG" "$WEB_TAG"
run_gate "v0.3.0-alpha.3"
check "exits 0 when every release image exists" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "reports the tag it verified" \
  "$(grep -q "v0.3.0-alpha.3" <<<"$OUT" && echo 0 || echo 1)"

# --- Invocation errors must be distinguishable from a missing image ---------
# A gate that exits 1 because it could not find a tag to check would page the
# release manager for a broken clone and read identically to a reaped image.

echo "check-release-images: no registry configured"
set +e
OUT="$(CI_REGISTRY_IMAGE="" RELEASE_IMAGE_PROBE="$TMP/probe.sh" PRESENT_FILE="$TMP/present" \
  bash "$GATE" "v0.3.0-alpha.3" 2>&1)"
RC=$?
set -e
check "exits 2 (not 1) when CI_REGISTRY_IMAGE is unset" "$([[ $RC -eq 2 ]] && echo 0 || echo 1)"

echo "check-release-images: no v* tag resolvable"
mkdir -p "$TMP/notags"
git -C "$TMP/notags" init -q 2>/dev/null
set +e
OUT="$(cd "$TMP/notags" && CI_REGISTRY_IMAGE="registry.example.com/trueppm/trueppm" \
  RELEASE_IMAGE_PROBE="$TMP/probe.sh" PRESENT_FILE="$TMP/present" \
  bash "$GATE" 2>&1)"
RC=$?
set -e
check "exits 2 (not 1) when no v* tag exists to check" "$([[ $RC -eq 2 ]] && echo 0 || echo 1)"

# --- Tag resolution ---------------------------------------------------------
# Version sort, not lexical: v0.10.0 must beat v0.9.0, which a plain sort
# reverses — and picking the wrong tag would probe an image nobody ships.

echo "check-release-images: resolves the newest v* tag by version sort"
REPO="$TMP/tagged"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
for t in v0.9.0 v0.10.0 v0.3.0-alpha.3; do git -C "$REPO" tag "$t"; done
present "registry.example.com/trueppm/trueppm/api:v0.10.0" \
        "registry.example.com/trueppm/trueppm/web:v0.10.0"
set +e
OUT="$(cd "$REPO" && CI_REGISTRY_IMAGE="registry.example.com/trueppm/trueppm" \
  RELEASE_IMAGE_PROBE="$TMP/probe.sh" PRESENT_FILE="$TMP/present" \
  bash "$GATE" 2>&1)"
RC=$?
set -e
check "picks v0.10.0 over v0.9.0 (version sort, not lexical)" \
  "$(grep -q "tag: v0.10.0" <<<"$OUT" && echo 0 || echo 1)"
check "exits 0 for the resolved tag" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"

# --- Image set is configurable ---------------------------------------------

echo "check-release-images: RELEASE_IMAGES override"
present "registry.example.com/trueppm/trueppm/api:v0.3.0-alpha.3"
set +e
OUT="$(CI_REGISTRY_IMAGE="registry.example.com/trueppm/trueppm" \
  RELEASE_IMAGES="api" RELEASE_IMAGE_PROBE="$TMP/probe.sh" PRESENT_FILE="$TMP/present" \
  bash "$GATE" "v0.3.0-alpha.3" 2>&1)"
RC=$?
set -e
check "exits 0 when the narrowed image set is fully present" \
  "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "does not probe images outside RELEASE_IMAGES" \
  "$(grep -q "/web:" <<<"$OUT" && echo 1 || echo 0)"

# --- ACCEPTED_GAPS is opt-in and exact-match only ---------------------------
# Defaults to empty so every case above stays exactly as strict as before
# ACCEPTED_GAPS existed; this block proves the escape hatch itself, isolated.

echo "check-release-images: ACCEPTED_GAPS skips only the named image:tag pair"
present  # registry serves nothing — api is skipped, web must still fail
set +e
OUT="$(
  CI_REGISTRY_IMAGE="registry.example.com/trueppm/trueppm" \
  RELEASE_IMAGE_PROBE="$TMP/probe.sh" \
  PRESENT_FILE="$TMP/present" \
  ACCEPTED_GAPS="api:v0.3.0-alpha.3" \
  bash "$GATE" "v0.3.0-alpha.3" 2>&1
)"
RC=$?
set -e
check "still exits 1 — the accepted gap does not mask the other missing image" \
  "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
check "reports the accepted image as SKIP, not MISSING" \
  "$(grep -q "SKIP    $API_TAG" <<<"$OUT" && echo 0 || echo 1)"
check "does not list the accepted image among the failure's missing refs" \
  "$(grep -q "MISSING $API_TAG" <<<"$OUT" && echo 1 || echo 0)"
check "still lists the non-accepted missing image" \
  "$(grep -q "MISSING $WEB_TAG" <<<"$OUT" && echo 0 || echo 1)"

echo "check-release-images: ACCEPTED_GAPS does not match a different tag"
present  # registry serves nothing
set +e
OUT="$(
  CI_REGISTRY_IMAGE="registry.example.com/trueppm/trueppm" \
  RELEASE_IMAGE_PROBE="$TMP/probe.sh" \
  PRESENT_FILE="$TMP/present" \
  ACCEPTED_GAPS="api:v0.3.0-alpha.3" \
  bash "$GATE" "v0.9.9" 2>&1
)"
RC=$?
set -e
check "exits 1 — an entry for one tag never covers another" \
  "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
check "reports the api image at the other tag as MISSING, not SKIP" \
  "$(grep -q "MISSING registry.example.com/trueppm/trueppm/api:v0.9.9" <<<"$OUT" && echo 0 || echo 1)"

echo
if [[ "$fail" -gt 0 ]]; then
  echo "check-release-images.test.sh: $pass passed, $fail FAILED"
  exit 1
fi
echo "check-release-images.test.sh: $pass passed"
