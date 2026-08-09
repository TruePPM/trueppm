#!/usr/bin/env bash
# scripts/release.sh — bump versions and cut a release commit + tag
#
# Usage:
#   Stable bumps:
#     ./scripts/release.sh patch            # 0.1.0 → 0.1.1
#     ./scripts/release.sh minor            # 0.1.0 → 0.2.0
#     ./scripts/release.sh major            # 0.1.0 → 1.0.0
#
#   Start a pre-release series (bumps the base version, resets to .1):
#     ./scripts/release.sh minor alpha      # 0.1.0 → 0.2.0-alpha.1
#     ./scripts/release.sh minor beta       # 0.1.0 → 0.2.0-beta.1
#     ./scripts/release.sh minor rc         # 0.1.0 → 0.2.0-rc.1
#
#   Increment within the current pre-release stage:
#     ./scripts/release.sh alpha            # 0.2.0-alpha.1 → 0.2.0-alpha.2
#     ./scripts/release.sh beta             # 0.2.0-alpha.2 → 0.2.0-beta.1  (promotes stage, resets to .1)
#     ./scripts/release.sh rc               # 0.2.0-beta.1  → 0.2.0-rc.1
#
#   Finalize a pre-release to stable:
#     ./scripts/release.sh release          # 0.2.0-rc.1 → 0.2.0
#
#   Explicit version (must be valid semver, pre-release suffixes allowed):
#     ./scripts/release.sh 1.0.0-rc.2
#     ./scripts/release.sh 1.0.0
#
# Confirmation gate:
#   Before any manifest is bumped, the computed version is shown as a
#   suggestion and you are asked to confirm it (Enter to accept), override it
#   inline by typing an explicit semver, or abort. Two immutable tags are cut
#   per release, so this is the last human gate. Pass -y/--yes (or set
#   RELEASE_ASSUME_YES=1) to accept the computed version non-interactively;
#   without it, a non-TTY run fails closed rather than auto-cutting a tag.
#
# CHANGELOG behaviour:
#   Every release — alpha/beta/rc and stable — rotates [Unreleased] into a dated
#   section, so the changelog the team ships always has a human-readable entry
#   for the tag (TruePPM ships its releases as alphas pre-1.0). The dated section
#   OPENS with a summary (the "main part" of the release): by default the prose
#   already written under [Unreleased] during the cycle, overridable with
#   --summary "<text>" or the RELEASE_SUMMARY env var. Pending changelog.d
#   fragments are assembled into the section first, and a fresh empty
#   [Unreleased] is left on top for the next cycle.
#
#   The standalone scheduler package ships its OWN changelog
#   (packages/scheduler/CHANGELOG.md, force-included into the PyPI wheel). Its
#   [Unreleased] section is hand-maintained during the cycle and rotated into a
#   dated [<PEP440>] section here too, via scripts/rotate-scheduler-changelog.sh,
#   so every scheduler-v<PEP440> tag publishes dated release notes (enforced by
#   the scheduler:publish CI job). packages/mcp has no standalone changelog —
#   the root CHANGELOG.md is its release record — so nothing is rotated for it.
#
# Versioning note (two schemes, one release):
#   api + web carry the semver form (0.2.0-alpha.1); the scheduler and the MCP
#   server are PyPI packages and carry the PEP 440 form of the SAME version
#   (0.2.0a1). The canonical parse source is the API manifest (semver,
#   parser-compatible); the PyPI manifests are bumped via a semver→PEP 440
#   translation so they always match their `<pkg>-v<PEP440>` publish tags and
#   the CI version checks in scheduler:publish / mcp:publish. Three tags are
#   created: v<semver> (Docker/Helm publish), scheduler-v<PEP440> and
#   mcp-v<PEP440> (PyPI publishes).
#
#   packages/mcp/server.json (the MCP registry manifest) carries BOTH forms —
#   semver at the top level, PEP 440 under packages[0] — and both are bumped
#   here. mcp:publish refuses to upload if either has drifted from
#   packages/mcp/pyproject.toml.
#
# Enterprise note:
#   The enterprise repo has its own release script that pins to a specific
#   OSS tag (TRUEPPM_OSS_TAG) and bumps its own version independently.
#   Run this script first, push the tag, then run the enterprise release.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() { echo "error: $*" >&2; exit 1; }

# Parse x.y.z or x.y.z-pre.N into components.
# Sets: MAJOR MINOR PATCH PRE_STAGE PRE_NUM (empty if stable)
parse_version() {
  local v="${1#v}"
  # Split on '-' to separate core from pre-release
  local core="${v%%-*}"
  local pre=""
  [[ "$v" == *-* ]] && pre="${v#*-}"

  IFS='.' read -r MAJOR MINOR PATCH <<< "$core"
  if [[ -n "$pre" ]]; then
    PRE_STAGE="${pre%%.*}"
    PRE_NUM="${pre#*.}"
  else
    PRE_STAGE=""
    PRE_NUM=""
  fi
}

stage_rank() {
  local stage="$1"
  case "$stage" in
    alpha) echo 1 ;;
    beta)  echo 2 ;;
    rc)    echo 3 ;;
    *)     echo 0 ;;
  esac
}

# Translate a semver version to the PEP 440 form used by the scheduler PyPI
# package: 0.2.0-alpha.1 → 0.2.0a1, -beta.1 → b1, -rc.1 → rc1. Stable versions
# (no pre-release suffix) are identical in both schemes. Each suffix occurs at
# most once, so a single substitution per stage is sufficient.
to_pep440() {
  local v="$1"
  v="${v/-alpha./a}"
  v="${v/-beta./b}"
  v="${v/-rc./rc}"
  echo "$v"
}

validate_semver() {
  # Accepts x.y.z and x.y.z-(alpha|beta|rc).N
  local v="$1"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+\.[0-9]+)?$ ]] \
    || die "'$v' is not a valid semver (expected x.y.z or x.y.z-alpha|beta|rc.N)"
}

# confirm_or_override_version SUGGESTED
# Last human gate before manifests are bumped and immutable tags are cut. The
# computed bump is a *suggestion*, not a mandate: show the operator what will be
# cut (version + both tags) and let them accept it (Enter), override it inline
# with an explicit semver, or abort. An override loops back so the operator
# re-confirms the new version and the tags it implies — a wrong stage or a
# stale base can't silently become a tag. Sets global NEW_VERSION to the result.
#
# Fails closed: with no TTY and no opt-in (--yes / RELEASE_ASSUME_YES=1) we
# refuse rather than auto-cut a tag nobody approved. Prompts go to stderr so a
# caller capturing stdout is unaffected.
confirm_or_override_version() {
  local suggested="$1"

  if [[ "$ASSUME_YES" == true ]]; then
    echo "Version confirmed via --yes: $CURRENT_VERSION → $suggested" >&2
    NEW_VERSION="$suggested"
    return
  fi

  if [[ ! -t 0 ]]; then
    die "No TTY to confirm the release version. Re-run with --yes (or RELEASE_ASSUME_YES=1) to accept the computed version ($suggested) non-interactively."
  fi

  local reply pep440
  while true; do
    pep440="$(to_pep440 "$suggested")"
    {
      echo ""
      echo "About to cut a release:"
      echo "  current : $CURRENT_VERSION"
      echo "  new     : $suggested   <- suggested"
      echo "  tags    : v${suggested}, scheduler-v${pep440}, mcp-v${pep440}"
    } >&2

    read -r -p "Enter to accept ${suggested}, type an explicit version to override, or 'q' to abort: " reply

    if [[ -z "$reply" ]]; then
      NEW_VERSION="$suggested"
      return
    fi
    case "$reply" in
      q|Q|quit|n|N) die "Aborted by operator — no release cut." ;;
    esac

    # Anything else is treated as an explicit version override. Re-validate and
    # loop so the resulting tags are shown and re-confirmed before we proceed.
    reply="${reply#v}"
    if [[ "$reply" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+\.[0-9]+)?$ ]]; then
      suggested="$reply"
    else
      echo "  '$reply' is not a valid semver (expected x.y.z or x.y.z-alpha|beta|rc.N) — try again." >&2
    fi
  done
}

# compute_new_version CURRENT BUMP [PRE_STAGE]
# BUMP: major | minor | patch | alpha | beta | rc | release | <explicit>
compute_new_version() {
  local current="$1"
  local bump="$2"
  local new_pre="${3:-}"  # only used when bump is major/minor/patch + pre

  parse_version "$current"

  case "$bump" in

    # --- stable bumps (no pre arg) ---
    major) echo "$((MAJOR + 1)).0.0" ;;
    minor) echo "${MAJOR}.$((MINOR + 1)).0" ;;
    patch) echo "${MAJOR}.${MINOR}.$((PATCH + 1))" ;;

    # --- start a pre-release series: bump base + set stage.1 ---
    # called when bump is major/minor/patch AND new_pre is set (handled externally)

    # --- pre-release stage commands ---
    alpha|beta|rc)
      local target_stage="$bump"
      if [[ -n "$PRE_STAGE" ]]; then
        # Already in a pre-release — either increment or promote
        local cur_rank; cur_rank="$(stage_rank "$PRE_STAGE")"
        local new_rank; new_rank="$(stage_rank "$target_stage")"
        if (( new_rank < cur_rank )); then
          die "Cannot move backwards from $PRE_STAGE to $target_stage"
        elif (( new_rank == cur_rank )); then
          # Same stage — increment the number
          echo "${MAJOR}.${MINOR}.${PATCH}-${PRE_STAGE}.$((PRE_NUM + 1))"
        else
          # Promote to a later stage — reset to .1
          echo "${MAJOR}.${MINOR}.${PATCH}-${target_stage}.1"
        fi
      else
        # On a stable version; bump minor and start alpha/beta/rc at .1
        echo "${MAJOR}.$((MINOR + 1)).0-${target_stage}.1"
      fi
      ;;

    # --- finalize pre-release to stable ---
    release)
      [[ -n "$PRE_STAGE" ]] || die "Current version $current is already stable; use patch/minor/major."
      echo "${MAJOR}.${MINOR}.${PATCH}"
      ;;

    # --- explicit version ---
    *)
      local explicit="${bump#v}"
      validate_semver "$explicit"
      echo "$explicit"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Pre-tag publish-gate preflight (api image Trivy scan)
# ---------------------------------------------------------------------------
#
# The api Docker image is Trivy-scanned ONLY in the tag-triggered api:publish
# job. A fixable HIGH/CRITICAL CVE therefore first surfaces AFTER a tag is cut —
# mid-release — which is the expensive failure mode that stranded both
# 0.3.0-alpha.1 and -alpha.2 (both failed *only* api:publish, on the base image's
# build-tool CVEs; #1388, #1391). Run the SAME build + scan here, before any
# manifest is bumped or tag created, and fail closed if the image would fail.
#
# Mirrors api:publish exactly: same Dockerfile + build context (repo root), built
# for linux/amd64 (the architecture CI publishes and users `docker pull`, so we
# scan exactly what ships — on an arm64 host this runs under emulation), and the
# same `trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`.
# Prefer a host trivy; otherwise scan with the same pinned Trivy version the CI
# job installs, in a container. Keep TRIVY_VERSION in lockstep with the pin in
# .gitlab-ci.yml (.docker-publish-base).
#
# The web image is deliberately NOT scanned here: it has never failed the gate
# (its surface is the nginx base, and -alpha.1/-alpha.2 both passed web:publish),
# and its rolldown bundler has no working build path on an arm64 host — neither
# native (no arm64 binary) nor emulated (the amd64 binary faults under QEMU) — so
# building it locally would make this preflight unrunnable on the macOS release
# host for reasons unrelated to any release risk. CI's web:publish (native amd64)
# remains its authoritative Trivy gate.
#
# Opt out with RELEASE_SKIP_IMAGE_SCAN=1 (e.g. a host without Docker); the tag
# pipeline still runs the authoritative scan, so this is fast feedback, not the
# only gate.
TRIVY_VERSION="0.71.0"   # keep in lockstep with .gitlab-ci.yml .docker-publish-base

trivy_scan_tar() {
  # trivy_scan_tar <image-tar> — exit non-zero on a fixable HIGH/CRITICAL CVE,
  # using the exact severity/ignore flags the publish job uses.
  local tar="$1"
  if command -v trivy >/dev/null 2>&1; then
    trivy image --input "$tar" --no-progress --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1
  else
    docker run --rm -v "$tar:/scan/image.tar:ro" "aquasecurity/trivy:${TRIVY_VERSION}" \
      image --input /scan/image.tar --no-progress --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1
  fi
}

preflight_image_scan() {
  if [[ "${RELEASE_SKIP_IMAGE_SCAN:-0}" == "1" ]]; then
    echo "  ! Skipping pre-tag api image Trivy scan (RELEASE_SKIP_IMAGE_SCAN=1)." >&2
    echo "    The tag pipeline still scans; a CVE there fails the release AFTER the tag is cut." >&2
    return 0
  fi

  command -v docker >/dev/null 2>&1 || die \
"Docker is required for the pre-tag api image scan (mirrors the api:publish Trivy
   gate so a CVE can't strand a freshly-cut tag). Install Docker, or re-run with
   RELEASE_SKIP_IMAGE_SCAN=1 to bypass — the tag pipeline still scans."

  local scan_dir="${TMPDIR:-/tmp}/trueppm-release-preflight"
  rm -rf "$scan_dir"; mkdir -p "$scan_dir"

  echo "" >&2
  echo "Pre-tag publish-gate preflight: building + Trivy-scanning the api image." >&2
  echo "(Mirrors api:publish so a CVE fails HERE, not after the tag is cut. On an arm64" >&2
  echo " host the linux/amd64 build runs under emulation. Bypass: RELEASE_SKIP_IMAGE_SCAN=1.)" >&2

  echo "  • building api image (linux/amd64, context: repo root) ..." >&2
  docker build --platform linux/amd64 -f packages/api/Dockerfile -t trueppm-api:release-preflight . \
    || die "api image failed to build — fix the build before cutting a tag."
  docker save trueppm-api:release-preflight -o "$scan_dir/api-image.tar"
  echo "  • scanning api image ..." >&2
  trivy_scan_tar "$scan_dir/api-image.tar" || die \
"api image FAILED the Trivy gate (a fixable HIGH/CRITICAL CVE). This is exactly what
   would fail api:publish AFTER the tag is cut. Patch or remove the offending dependency
   in packages/api/Dockerfile and re-run. Bypass: RELEASE_SKIP_IMAGE_SCAN=1."

  rm -rf "$scan_dir"
  echo "  ✓ api image passes the Trivy gate." >&2
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------

BUMP=""
PRE_ARG=""

# Strip the -y/--yes flag (also honored via RELEASE_ASSUME_YES=1) before the
# positional-arg count check, so it can appear in any position. No arrays —
# this script must run under macOS bash 3.2.
ASSUME_YES=false
[[ "${RELEASE_ASSUME_YES:-0}" == "1" ]] && ASSUME_YES=true
# Human-readable release summary captured from --summary "<text>" (space-safe:
# the value is read from the next "$@" element, which preserves embedded spaces,
# into its own variable rather than the space-joined REST). Env RELEASE_SUMMARY
# is the non-interactive fallback; the flag wins over it.
RELEASE_SUMMARY_ARG=""
EXPECT_SUMMARY=false
REST=""
for arg in "$@"; do
  if $EXPECT_SUMMARY; then RELEASE_SUMMARY_ARG="$arg"; EXPECT_SUMMARY=false; continue; fi
  case "$arg" in
    -y|--yes) ASSUME_YES=true ;;
    --summary) EXPECT_SUMMARY=true ;;
    *) REST="$REST $arg" ;;
  esac
done
# shellcheck disable=SC2086
set -- $REST

case $# in
  1) BUMP="$1" ;;
  2)
    BUMP="$1"
    PRE_ARG="$2"
    [[ "$PRE_ARG" =~ ^(alpha|beta|rc)$ ]] \
      || die "Second argument must be alpha, beta, or rc (got '$PRE_ARG')"
    [[ "$BUMP" =~ ^(major|minor|patch)$ ]] \
      || die "With a pre-release stage, first argument must be major, minor, or patch"
    ;;
  *)
    die "Usage: $0 <major|minor|patch|alpha|beta|rc|release|x.y.z> [alpha|beta|rc]"
    ;;
esac

# ---------------------------------------------------------------------------
# Guard: clean working tree on main
# ---------------------------------------------------------------------------

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Working tree is not clean. Commit or stash changes first."
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  die "Releases must be cut from main (currently on '$CURRENT_BRANCH')."
fi

# ---------------------------------------------------------------------------
# Compute new version
# ---------------------------------------------------------------------------

# Canonical version source is the API manifest (semver form). The scheduler
# manifest is the same release in PEP 440 form (0.2.0a1) and would break the
# semver parser, so it must NOT be the parse source.
CURRENT_VERSION="$(grep '^version' packages/api/pyproject.toml | head -1 | sed 's/version = "\(.*\)"/\1/')"

if [[ -n "$PRE_ARG" ]]; then
  # e.g. ./scripts/release.sh minor alpha → bump base version then add pre suffix
  parse_version "$CURRENT_VERSION"
  case "$BUMP" in
    major) BASE="$((MAJOR + 1)).0.0" ;;
    minor) BASE="${MAJOR}.$((MINOR + 1)).0" ;;
    patch) BASE="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  esac
  NEW_VERSION="${BASE}-${PRE_ARG}.1"
else
  NEW_VERSION="$(compute_new_version "$CURRENT_VERSION" "$BUMP")"
fi

validate_semver "$NEW_VERSION"

# Human gate: confirm or override the computed version before anything is
# written. May reassign NEW_VERSION (override path), so everything below —
# IS_PRERELEASE, the tags, the existence checks — derives from the confirmed
# value, not the originally-computed one.
confirm_or_override_version "$NEW_VERSION"
validate_semver "$NEW_VERSION"

IS_PRERELEASE=false
[[ "$NEW_VERSION" == *-* ]] && IS_PRERELEASE=true

echo "Releasing: $CURRENT_VERSION → $NEW_VERSION"
$IS_PRERELEASE && echo "  (pre-release)"

TODAY="$(date +%Y-%m-%d)"
TAG="v${NEW_VERSION}"
# The scheduler PyPI publish job triggers on scheduler-v<PEP440> and string-
# matches the tag against the scheduler manifest, so this tag must use the
# PEP 440 form (scheduler-v0.2.0a1, not scheduler-v0.2.0-alpha.1).
SCHEDULER_TAG="scheduler-v$(to_pep440 "$NEW_VERSION")"
# Same contract for the MCP server (#2809): mcp:publish triggers on
# mcp-v<PEP440> and string-matches the tag against packages/mcp/pyproject.toml.
MCP_TAG="mcp-v$(to_pep440 "$NEW_VERSION")"

git tag | grep -qxF "$TAG" && die "Tag $TAG already exists."
git tag | grep -qxF "$SCHEDULER_TAG" && die "Tag $SCHEDULER_TAG already exists."
git tag | grep -qxF "$MCP_TAG" && die "Tag $MCP_TAG already exists."

# Build + Trivy-scan the api and web images BEFORE bumping manifests or cutting a
# tag, so a fixable image CVE aborts the release cleanly here rather than failing
# api:publish / web:publish after the tag is already pushed (#1391). The working
# tree is still clean at this point; the version bump only rewrites version
# strings, never dependencies, so the pre-bump image's CVE posture is identical
# to the tagged one.
preflight_image_scan

# ---------------------------------------------------------------------------
# Bump versions in manifests
# ---------------------------------------------------------------------------

# Semver form (api + web) and PEP 440 form (scheduler) of both the current and
# the new version. The scheduler is anchored on its own PEP 440 string, not the
# semver one, so its sed actually matches.
CURRENT_ESCAPED="${CURRENT_VERSION//./\\.}"
CURRENT_PEP440="$(to_pep440 "$CURRENT_VERSION")"
NEW_PEP440="$(to_pep440 "$NEW_VERSION")"
CURRENT_PEP440_ESCAPED="${CURRENT_PEP440//./\\.}"

# Bump one manifest, then VERIFY the new version actually landed. A silent
# sed no-op — the manifest's current version not matching what we expected —
# is the failure mode that left web stranded at 0.1 while api/scheduler moved
# to 0.2. Fail loudly with the drift instead of committing a half-bumped tree.
bump_manifest() {
  local file="$1" sed_expr="$2" verify="$3"
  sed -i.bak "$sed_expr" "$file" && rm "${file}.bak"
  grep -qF "$verify" "$file" || die \
"Failed to bump $file to $NEW_VERSION.
   Expected its current version to be '$CURRENT_VERSION' (scheduler: '$CURRENT_PEP440').
   The manifests have drifted out of lockstep — reconcile them before releasing."
}

bump_manifest packages/scheduler/pyproject.toml \
  "s/^version = \"${CURRENT_PEP440_ESCAPED}\"/version = \"${NEW_PEP440}\"/" \
  "version = \"${NEW_PEP440}\""

# The MCP server is the second PyPI package (#2809) and takes the PEP 440 form,
# same as the scheduler. Its version lives in four places that must move
# together: the manifest, the package's own __version__ (exported in __all__ and
# reported to MCP clients), and BOTH version fields in server.json. The uv.lock
# self-entry is refreshed by the `uv lock` below.
bump_manifest packages/mcp/pyproject.toml \
  "s/^version = \"${CURRENT_PEP440_ESCAPED}\"/version = \"${NEW_PEP440}\"/" \
  "version = \"${NEW_PEP440}\""

bump_manifest packages/mcp/src/trueppm_mcp/__init__.py \
  "s/^__version__ = \"${CURRENT_PEP440_ESCAPED}\"/__version__ = \"${NEW_PEP440}\"/" \
  "__version__ = \"${NEW_PEP440}\""

# server.json's top-level "version" is the registry manifest's own semver
# version; the nested packages[].version is the PyPI (PEP 440) one. Both are
# anchored on their leading whitespace so the two substitutions cannot cross
# over onto each other's line.
bump_manifest packages/mcp/server.json \
  "s/^  \"version\": \"${CURRENT_ESCAPED}\",/  \"version\": \"${NEW_VERSION}\",/" \
  "\"version\": \"${NEW_VERSION}\""

bump_manifest packages/mcp/server.json \
  "s/^      \"version\": \"${CURRENT_PEP440_ESCAPED}\",/      \"version\": \"${NEW_PEP440}\",/" \
  "\"version\": \"${NEW_PEP440}\""

bump_manifest packages/api/pyproject.toml \
  "s/^version = \"${CURRENT_ESCAPED}\"/version = \"${NEW_VERSION}\"/" \
  "version = \"${NEW_VERSION}\""

bump_manifest packages/web/package.json \
  "s/\"version\": \"${CURRENT_ESCAPED}\"/\"version\": \"${NEW_VERSION}\"/" \
  "\"version\": \"${NEW_VERSION}\""

# The Rust/WASM engine carries the SAME semver string as api/web (#2602). It is
# one semantic artifact held in CI conformance with the Python engine, so the
# version has to name which semantics you get — a reader must be able to tell
# that trueppm-wasm-scheduler and trueppm-scheduler implement the same CPM rules.
# It sat at 0.1.0 through three releases because it was never in this list; that
# is the drift this entry closes. Cargo takes the semver form directly (it is the
# same grammar), so no PEP 440 translation is needed.
bump_manifest packages/wasm-scheduler/Cargo.toml \
  "s/^version = \"${CURRENT_ESCAPED}\"/version = \"${NEW_VERSION}\"/" \
  "version = \"${NEW_VERSION}\""

# Cargo.lock records the local crate's own version under its self-entry, exactly
# as uv.lock does (#1389) — bumping the manifest without it leaves the lock
# claiming the previous version. Done with a range-scoped sed rather than by
# shelling out to cargo, deliberately: a release must not require a Rust
# toolchain on the release machine, and the self-entry's version carries no
# dependency-resolution semantics, so rewriting that one line cannot change what
# resolves. The range anchors on the package's `name =` line so a dependency that
# happens to share the current version string can never be rewritten instead.
bump_manifest packages/wasm-scheduler/Cargo.lock \
  "/^name = \"trueppm-wasm-scheduler\"$/,/^version = / s/^version = \"${CURRENT_ESCAPED}\"/version = \"${NEW_VERSION}\"/" \
  "version = \"${NEW_VERSION}\""

echo "  Bumped manifests to $NEW_VERSION (scheduler PyPI: $NEW_PEP440)"

# Re-lock after bumping the Python manifests. Each uv.lock records the project's
# own version under its self-entry, so a manifest bump without a re-lock leaves
# the lock claiming the previous version and turns the post-tag main pipeline red
# via api:uv-lock-check / scheduler:uv-lock-check (uv lock --check is --locked
# semantics) — that was #1389. Dependency constraints are untouched here, so each
# `uv lock` changes only the `version = ` line under the package's own entry.
command -v uv >/dev/null 2>&1 || die \
  "uv not found — required to regenerate uv.lock after the version bump.
   Install uv (https://docs.astral.sh/uv/) and retry."
( cd packages/scheduler && uv lock ) || die "Failed to regenerate packages/scheduler/uv.lock"
( cd packages/api && uv lock ) || die "Failed to regenerate packages/api/uv.lock"
# packages/mcp joined the re-lock list with mcp:publish (#2809): its SBOM step
# runs `uv sync --frozen`, which hard-fails on a lock whose self-entry still
# claims the previous version, and mcp:uv-lock-check would go red on main.
( cd packages/mcp && uv lock ) || die "Failed to regenerate packages/mcp/uv.lock"
echo "  Regenerated uv.lock for scheduler, api, and mcp"

# Regenerate the OpenAPI schema so its info.version matches the tag.
#
# SPECTACULAR_SETTINGS["VERSION"] used to be a literal that this script rewrote
# by sed at tag time — which meant it was correct only at the moment of a
# release and drifted for the whole cycle after it. It read "0.3.0" against a
# 0.4.0-beta.1 package, so every generated client and schema consumer was told
# the wrong version (#2605). It is now derived from TRUEPPM_VERSION, so there is
# nothing left to bump here.
#
# TRUEPPM_VERSION is passed explicitly rather than relying on the default: that
# default reads *installed* package metadata, and the pyproject bump above has
# not been re-installed into the venv at this point, so a bare regenerate would
# emit the previous version. The env var is the same knob an operator uses to
# override the reported build identity.
#
# The suffix is no longer stripped. The schema used to claim "0.2.0" for
# 0.2.0-alpha.1; a pre-release schema now says so, because a consumer generating
# a client deserves to know it is building against a beta.
TRUEPPM_VERSION="$NEW_PEP440" bash scripts/export-openapi.sh
echo "  Regenerated docs/api/openapi.json at info.version $NEW_PEP440"

# ---------------------------------------------------------------------------
# CHANGELOG rotation (every release — alpha/beta/rc and stable)
# ---------------------------------------------------------------------------
#
# Rotate [Unreleased] into a dated section that OPENS with a human-readable
# summary (the "main part" of the release), so the changelog reads as prose, not
# just a bullet dump. Pending changelog.d fragments are assembled into the
# section first. The summary defaults to the prose already written under
# [Unreleased] during the cycle and is overridable with --summary / RELEASE_SUMMARY.

CHANGELOG="CHANGELOG.md"

# Assemble any pending changelog fragments into [Unreleased] before rotating.
bash scripts/assemble-changelog.sh

if ! grep -q "## \[Unreleased\]" "$CHANGELOG"; then
  die "$CHANGELOG has no [Unreleased] section — add release notes before releasing."
fi

UNRELEASED_CONTENT="$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' "$CHANGELOG")"
if [[ -z "$(echo "$UNRELEASED_CONTENT" | tr -d '[:space:]')" ]]; then
  die "$CHANGELOG [Unreleased] section is empty — add release notes before releasing."
fi

# Default summary: the prose written under [Unreleased] (everything before the
# first ### category heading), trimmed of surrounding blank lines.
DEFAULT_SUMMARY="$(python3 - "$CHANGELOG" <<'PY'
import sys
lines = open(sys.argv[1]).read().split("\n")
buf, f = [], False
for l in lines:
    if l.strip() == "## [Unreleased]":
        f = True
        continue
    if f and (l.startswith("### ") or l.startswith("## [")):
        break
    if f:
        buf.append(l)
print("\n".join(buf).strip("\n"))
PY
)"

# Summary precedence: --summary flag > RELEASE_SUMMARY env > [Unreleased] prose.
# On a TTY (and not --yes) the default is shown for confirmation; Enter accepts
# it, or a typed line replaces it.
RELEASE_SUMMARY="${RELEASE_SUMMARY_ARG:-${RELEASE_SUMMARY:-}}"
if [[ -z "$RELEASE_SUMMARY" ]]; then
  RELEASE_SUMMARY="$DEFAULT_SUMMARY"
  if [[ "$ASSUME_YES" != true && -t 0 && -n "$DEFAULT_SUMMARY" ]]; then
    {
      echo ""
      echo "Release summary (opens the $NEW_VERSION changelog section):"
      echo "----------------------------------------------------------"
      echo "$DEFAULT_SUMMARY"
      echo "----------------------------------------------------------"
    } >&2
    read -r -p "Enter to accept this summary, or type a one-line replacement: " reply
    [[ -n "$reply" ]] && RELEASE_SUMMARY="$reply"
  fi
fi

if [[ -z "$(echo "$RELEASE_SUMMARY" | tr -d '[:space:]')" ]]; then
  die "No release summary. Write a summary paragraph under [Unreleased] in $CHANGELOG, pass --summary \"<text>\", or set RELEASE_SUMMARY."
fi

# Rotate: replace [Unreleased] and its prose with a fresh empty [Unreleased] and
# a dated section that opens with the summary; the assembled ### categories follow.
RELEASE_SUMMARY="$RELEASE_SUMMARY" NEW_VERSION="$NEW_VERSION" TODAY="$TODAY" \
python3 - "$CHANGELOG" <<'PY'
import os, sys

path = sys.argv[1]
version = os.environ["NEW_VERSION"]
today = os.environ["TODAY"]
summary = os.environ["RELEASE_SUMMARY"].strip("\n")

lines = open(path).read().split("\n")
out, i, n = [], 0, len(lines)
while i < n:
    if lines[i].strip() == "## [Unreleased]":
        # Skip the old prose (up to the first ### category or next ## [ heading);
        # it is being lifted into the dated section as the summary.
        j = i + 1
        while j < n and not lines[j].startswith("### ") and not lines[j].startswith("## ["):
            j += 1
        out += [
            "## [Unreleased]", "",
            "_Nothing yet._", "",
            f"## [{version}] — {today}", "",
            *summary.split("\n"), "",
        ]
        i = j
        continue
    out.append(lines[i])
    i += 1

# Collapse any 2+ consecutive blank lines to a single blank.
cleaned, blank = [], False
for l in out:
    b = (l.strip() == "")
    if b and blank:
        continue
    cleaned.append(l)
    blank = b
open(path, "w").write("\n".join(cleaned).rstrip("\n") + "\n")
PY

echo "  Updated CHANGELOG.md: [Unreleased] → [$NEW_VERSION] — $TODAY (with summary)"

# Rotate the standalone scheduler package CHANGELOG too, so the PyPI wheel ships
# a dated release-notes section for this tag rather than a perpetual [Unreleased].
# It carries the PEP 440 version + scheduler-v<PEP440> compare links, so it is a
# separate rotation from the root (semver) CHANGELOG above.
bash scripts/rotate-scheduler-changelog.sh "$NEW_PEP440" "$CURRENT_PEP440" "$TODAY"

# ---------------------------------------------------------------------------
# Remove stale "Ships in 0.X" / "Coming in 0.X" docs callouts (#2694)
# ---------------------------------------------------------------------------
#
# Once a version is promoted to the roadmap's "## Shipped" section, every
# :::note[Ships in 0.X] / :::caution[Ships in 0.X] / "Coming in 0.X" callout
# for that version documents something that is no longer true — the same
# misinformation the version-status gate polices, in the other direction
# (CLAUDE.md "Version-status tense": delete the callout once 0.X ships). 57
# such callouts across 44 pages made that a release-day chore easy to skip
# (#2694), so it runs here instead of by hand.
#
# Scoped to MAJOR.MINOR (the roadmap's "### 0.X" grain), not the full semver
# just bumped — a 0.4.0-beta.2 release and the eventual 0.4.0 stable release
# share the same "0.4" callouts. scripts/remove-ships-in-callouts.sh's own
# safety gate refuses (exit 2) unless "0.4" already appears under the
# roadmap's "## Shipped" heading, which is a human docs edit this version
# bump does not imply — so on every pre-1.0 alpha/beta/rc cut before that
# promotion, this call is an expected, harmless no-op, not a release
# blocker. Only a non-refusal failure (bad invocation, missing roadmap)
# aborts the release.
parse_version "$NEW_VERSION"
ROADMAP_MM="${MAJOR}.${MINOR}"
set +e
bash scripts/remove-ships-in-callouts.sh "$ROADMAP_MM" --apply
CALLOUT_STATUS=$?
set -e
case "$CALLOUT_STATUS" in
  0) echo "  Removed stale 'Ships in $ROADMAP_MM' / 'Coming in $ROADMAP_MM' docs callouts" ;;
  2) echo "  Skipped callout removal — $ROADMAP_MM is not yet in the roadmap's '## Shipped' section" ;;
  *) die "scripts/remove-ships-in-callouts.sh failed (exit $CALLOUT_STATUS) — fix before releasing." ;;
esac

# ---------------------------------------------------------------------------
# Commit and tag
# ---------------------------------------------------------------------------

# Stage the bumped manifests, both rotated CHANGELOGs, and the regenerated
# schema — plus changelog.d/ itself, so the fragment deletions that
# assemble-changelog.sh just made (it consumes each fragment into [Unreleased]
# and rm's it) are committed WITH the release. Without changelog.d/ here those
# deletions stay unstaged, leaving the tag pointing at a tree that still carries
# already-consumed fragments — a dangling diff on top of every release (#1386).
# Also stage the docs tree: remove-ships-in-callouts.sh above may have deleted
# stale "Ships in 0.X" callouts in --apply mode, and those edits belong in the
# same release commit, not left dangling unstaged (#2694).
git add \
  packages/scheduler/pyproject.toml \
  packages/scheduler/uv.lock \
  packages/scheduler/CHANGELOG.md \
  packages/mcp/pyproject.toml \
  packages/mcp/uv.lock \
  packages/mcp/server.json \
  packages/mcp/src/trueppm_mcp/__init__.py \
  packages/api/pyproject.toml \
  packages/api/uv.lock \
  packages/web/package.json \
  packages/wasm-scheduler/Cargo.toml \
  packages/wasm-scheduler/Cargo.lock \
  packages/api/src/trueppm_api/settings/base.py \
  docs/api/openapi.json \
  packages/website/src/content/docs \
  CHANGELOG.md \
  changelog.d

git commit -m "chore(release): bump version to ${NEW_VERSION}

Automated release commit. See CHANGELOG.md for details."

git tag -a "$TAG" -m "Release $TAG"
git tag -a "$SCHEDULER_TAG" -m "Release trueppm-scheduler ${NEW_PEP440}"
git tag -a "$MCP_TAG" -m "Release trueppm-mcp ${NEW_PEP440}"

echo ""
echo "Done. Created commit and tags $TAG, $SCHEDULER_TAG, $MCP_TAG."
echo ""
echo "Next steps:"
echo "  git push origin main $TAG          # triggers Docker + Helm publish"
echo "  git push origin $SCHEDULER_TAG     # triggers trueppm-scheduler PyPI publish"
echo "  git push origin $MCP_TAG           # triggers trueppm-mcp PyPI publish"
echo ""
echo "  # First mcp-v* tag only: the PyPI Trusted Publisher for 'trueppm-mcp' must"
echo "  # already exist (GitLab / trueppm / trueppm / .gitlab-ci.yml / environment"
echo "  # 'pypi-mcp'). Without it mcp:publish fails closed at the mint-token step."
if ! $IS_PRERELEASE; then
  echo "  # Then run the enterprise release script pinned to $TAG"
fi
