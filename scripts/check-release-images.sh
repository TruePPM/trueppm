#!/usr/bin/env bash
# Fail when the latest v* release tag is no longer pullable from the registry.
#
# The beta-readiness audit (#2803) found that the project's container-registry
# cleanup policy had been running with `name_regex: .*` and `name_regex_keep:
# null` — matching every tag and protecting none — so its daily sweep deleted
# the released `api:v0.3.0-alpha.3` and `web:v0.3.0-alpha.3` images along with
# the commit-SHA tags they were meant to reap. The publish jobs had succeeded;
# the images were removed weeks later, by a project setting that lives outside
# this repo and that no pipeline asserts.
#
# That is the failure this gate exists for. A release image disappearing is not
# a diff event — there is no commit to review, no job to go red, and the tag
# pipeline that produced it stays green forever. The only way to notice is to
# go and look, on a schedule.
#
# Deliberately NOT allow_failure in CI: a self-hoster who cannot pull the
# version we told them to run has no working install, so this is a release
# defect and must read red.
#
# ## Overrides
#
# RELEASE_IMAGES        space-separated image names under $CI_REGISTRY_IMAGE
#                       (default "api web")
# RELEASE_IMAGE_PROBE   command that receives one image reference and exits 0
#                       when it exists. Defaults to `docker manifest inspect`.
#                       Overridable so the probe decision logic can be unit
#                       tested without a daemon or a registry — the part that
#                       was actually wrong here is *what we conclude*, and a
#                       gate observed only on a healthy registry is
#                       indistinguishable from one that always passes.
# ACCEPTED_GAPS         space-separated "<image>:<tag>" pairs to report as
#                       SKIP instead of MISSING. Empty by default — this gate
#                       exists to fail on absence, so silence is opt-in only,
#                       set per-entry by the CI job with a comment naming the
#                       decision issue, never defaulted here. Each entry must
#                       be a documented, permanent, single-tag exception (e.g.
#                       an old pre-release image a CVE gate keeps a rebuild
#                       from ever reproducing, #2822) — not a way to quiet the
#                       gate for an image that is expected to come back.
#
# Usage:
#   scripts/check-release-images.sh [tag]
#
# With no argument the tag is resolved from the repository as the highest
# `v*` tag by version sort.
#
# Exit codes:
#   0  every image exists at that tag
#   1  at least one image is missing
#   2  invocation error (no registry configured, or no v* tag to check)

set -euo pipefail

REGISTRY_IMAGE="${CI_REGISTRY_IMAGE:-}"
RELEASE_IMAGES="${RELEASE_IMAGES:-api web}"
RELEASE_IMAGE_PROBE="${RELEASE_IMAGE_PROBE:-}"
ACCEPTED_GAPS="${ACCEPTED_GAPS:-}"

# Resolve the newest release tag. `--sort=-v:refname` orders by version rather
# than lexically, so v0.10.0 sorts above v0.9.0. Pre-release tags (v0.3.0-alpha.3)
# sort below their own final release under this comparison, which is what we
# want: once v0.3.0 exists, it is the thing operators are told to pull.
resolve_latest_release_tag() {
  git tag --list 'v*' --sort=-v:refname 2>/dev/null | head -n 1
}

# Exact "<image>:<tag>" match against ACCEPTED_GAPS — no globbing, so an
# accepted gap can never widen to cover an image or tag nobody reviewed.
is_accepted_gap() {
  local image="$1" tag="$2" entry
  for entry in $ACCEPTED_GAPS; do
    if [ "$entry" = "${image}:${tag}" ]; then
      return 0
    fi
  done
  return 1
}

# Default probe: ask the registry for the manifest. Requires a prior
# `docker login` (in CI, gitlab-ci-token + CI_JOB_TOKEN against CI_REGISTRY).
probe_image() {
  local ref="$1"
  if [ -n "$RELEASE_IMAGE_PROBE" ]; then
    "$RELEASE_IMAGE_PROBE" "$ref" >/dev/null 2>&1
  else
    docker manifest inspect "$ref" >/dev/null 2>&1
  fi
}

main() {
  if [ -z "$REGISTRY_IMAGE" ]; then
    echo "ERROR: CI_REGISTRY_IMAGE is not set — nothing to probe." >&2
    exit 2
  fi

  local tag="${1:-}"
  if [ -z "$tag" ]; then
    tag="$(resolve_latest_release_tag)"
  fi
  if [ -z "$tag" ]; then
    echo "ERROR: no v* release tag found — cannot verify release images." >&2
    echo "       In CI this usually means the clone has no tags; fetch them first." >&2
    exit 2
  fi

  echo "Verifying release images for tag: $tag"

  local missing=""
  local image ref
  for image in $RELEASE_IMAGES; do
    ref="${REGISTRY_IMAGE}/${image}:${tag}"
    if is_accepted_gap "$image" "$tag"; then
      echo "  SKIP    $ref (accepted gap, see ACCEPTED_GAPS)"
    elif probe_image "$ref"; then
      echo "  OK      $ref"
    else
      echo "  MISSING $ref"
      missing="${missing} ${ref}"
    fi
  done

  if [ -n "$missing" ]; then
    echo
    echo "ERROR: released image(s) missing from the container registry:" >&2
    local ref_out
    for ref_out in $missing; do
      echo "  - $ref_out" >&2
    done
    echo >&2
    echo "A published release tag must stay pullable. Check Settings → Packages" >&2
    echo "and registries → Clean up image tags: name_regex_keep must protect" >&2
    echo "release tags (^v.*\$|^latest\$), or the daily sweep will delete them" >&2
    echo "again (#2803). Re-run the tag pipeline's publish jobs to restore." >&2
    exit 1
  fi

  echo
  echo "OK: all release images present for $tag"
}

main "$@"
