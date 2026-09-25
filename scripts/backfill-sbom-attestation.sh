#!/usr/bin/env bash
# Backfill missing CycloneDX SBOM attestations onto an already-published
# ghcr.io image (#4064).
#
# For each linux/{amd64,arm64} manifest digest of <owner>/<image>:<tag>:
#   1. resolve the digest from the registry (read-only, curl + jq),
#   2. regenerate the SBOM with syft, named exactly as the publish jobs name it
#      (--source-name / --source-version, #3995) so metadata.component.name is
#      the image and not a temp path,
#   3. `cosign attest --type cyclonedx` it to that digest (keyless),
#   4. `cosign verify-attestation` it, and check the SBOM names its own arch.
#
# Attesting is keyless: the certificate identity is whatever GitLab job runs
# this, so it MUST run from the manual `release:backfill-sbom-attestation` CI
# job and never from a workstation. The script refuses to write outside GitLab
# CI. `--dry-run` performs step 1 only and is safe anywhere.
#
# Usage:
#   scripts/backfill-sbom-attestation.sh --image web --tag 0.4.0-beta.4 [--dry-run]
#     [--owner trueppm] [--force]
#
# Env (CI mode): GHCR_USER, GHCR_TOKEN (cosign login), SIGSTORE_ID_TOKEN
# (from id_tokens), optional VERIFY_IDENTITY / VERIFY_IDENTITY_REGEXP.
set -euo pipefail

OWNER="trueppm"
IMAGE=""
TAG=""
DRY_RUN=0
FORCE=0

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --owner) OWNER="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done

case "$IMAGE" in
  api|web) ;;
  *) echo "ERROR: --image must be api or web (got '${IMAGE}')" >&2; exit 2 ;;
esac
# Bare version as published on GHCR (no leading v), e.g. 0.4.0-beta.4.
if ! [[ "$TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]]; then
  echo "ERROR: --tag must be a bare release version like 0.4.0-beta.4 (got '${TAG}')" >&2
  exit 2
fi

REPO="${OWNER}/${IMAGE}"
REF_IMAGE="ghcr.io/${REPO}"

if [ "$DRY_RUN" -eq 0 ] && [ "${GITLAB_CI:-}" != "true" ]; then
  echo "ERROR: refusing to attest outside GitLab CI. Keyless identity must come" >&2
  echo "from the CI job, not a workstation (#4064). Use --dry-run locally." >&2
  exit 1
fi

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool not found" >&2; exit 1; }
done

# Anonymous pull token: the images are public, and this keeps digest
# resolution read-only and credential-free.
TOKEN=$(curl -sSf "https://ghcr.io/token?service=ghcr.io&scope=repository:${REPO}:pull" | jq -r '.token')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: could not get a pull token for ${REPO}" >&2
  exit 1
fi

INDEX=$(curl -sSf \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://ghcr.io/v2/${REPO}/manifests/${TAG}")

INDEX_MT=$(echo "$INDEX" | jq -r '.mediaType // empty')
case "$INDEX_MT" in
  application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json) ;;
  *) echo "ERROR: ${REF_IMAGE}:${TAG} is not a multi-arch index (mediaType='${INDEX_MT}')" >&2; exit 1 ;;
esac

for arch in amd64 arm64; do
  d=$(echo "$INDEX" | jq -r --arg a "$arch" \
    '.manifests[] | select(.platform.architecture==$a and .platform.os=="linux") | .digest' | awk 'NR==1')
  if [ -z "$d" ] || [ "$d" = "null" ]; then
    echo "ERROR: no linux/${arch} manifest in ${REF_IMAGE}:${TAG}" >&2
    exit 1
  fi
  eval "DIGEST_${arch}=\$d"
  echo "linux/${arch}: ${REF_IMAGE}@${d}"
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run: would regenerate the SBOM, attest and verify each digest above. No writes made."
  exit 0
fi

for tool in syft cosign; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool not found" >&2; exit 1; }
done
: "${GHCR_USER:?GHCR_USER must be set}" "${GHCR_TOKEN:?GHCR_TOKEN must be set}"
: "${SIGSTORE_ID_TOKEN:?SIGSTORE_ID_TOKEN must be set (id_tokens aud: sigstore)}"

echo "$GHCR_TOKEN" | cosign login ghcr.io -u "$GHCR_USER" --password-stdin

# What THIS run's certificate will say. A job on a branch produces
# .../.gitlab-ci.yml@refs/heads/<branch>, NOT the refs/tags/v* identity the
# tag-pipeline attestations carry; the docs' tag-only regexp will not match it.
if [ -n "${VERIFY_IDENTITY_REGEXP:-}" ]; then
  ID_FLAG=(--certificate-identity-regexp "$VERIFY_IDENTITY_REGEXP")
else
  ID="${VERIFY_IDENTITY:-https://gitlab.com/${CI_PROJECT_PATH}//.gitlab-ci.yml@${CI_COMMIT_REF_NAME:+refs/heads/}${CI_COMMIT_REF_NAME}}"
  ID_FLAG=(--certificate-identity "$ID")
fi
echo "verifying against: ${ID_FLAG[*]}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for arch in amd64 arm64; do
  eval "D=\$DIGEST_${arch}"
  TARGET="${REF_IMAGE}@${D}"
  SBOM="${WORK}/${IMAGE}-${TAG}-${arch}.cdx.json"

  # Same naming as api:publish / web:publish so the document says what it is
  # an SBOM of (#3995): name = image, version = <version>-<arch>.
  syft "registry:${TARGET}" \
    --source-name "${REF_IMAGE}" --source-version "${TAG}-${arch}" \
    -o "cyclonedx-json=${SBOM}"
  test -s "$SBOM" || { echo "ERROR: syft produced an empty SBOM for ${arch}" >&2; exit 1; }
  NAME=$(jq -r '.metadata.component.name' "$SBOM")
  if [ "$NAME" != "$REF_IMAGE" ]; then
    echo "ERROR: SBOM metadata.component.name is '${NAME}', expected '${REF_IMAGE}' (#3995)" >&2
    exit 1
  fi

  # Do not stack a duplicate on a digest that already verifies, unless --force.
  if [ "$FORCE" -eq 0 ] && cosign verify-attestation --type cyclonedx \
      --certificate-identity-regexp '^https://gitlab\.com/trueppm/trueppm//\.gitlab-ci\.yml@refs/(tags/v.*|heads/.*)$' \
      --certificate-oidc-issuer https://gitlab.com "$TARGET" >/dev/null 2>&1; then
    echo "linux/${arch} already carries a verifying CycloneDX attestation; skipping (use --force to add another)"
    continue
  fi

  cosign attest --yes --type cyclonedx --predicate "$SBOM" "$TARGET"

  cosign verify-attestation --type cyclonedx "${ID_FLAG[@]}" \
    --certificate-oidc-issuer https://gitlab.com "$TARGET" > "${WORK}/att-${arch}.json"
  FOUND=$(jq -r '.payload' "${WORK}/att-${arch}.json" \
    | while IFS= read -r P; do echo "$P" | base64 -d | jq -r '.predicate.metadata.component.version'; done \
    | sort -u | paste -sd, -)
  if [ "$FOUND" != "${TAG}-${arch}" ]; then
    echo "ERROR: linux/${arch} attestation reports '${FOUND}', expected '${TAG}-${arch}'" >&2
    exit 1
  fi
  echo "attested + verified linux/${arch}: ${TARGET}"
done
echo "backfill complete for ${REF_IMAGE}:${TAG}"
