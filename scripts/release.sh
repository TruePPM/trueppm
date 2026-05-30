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
# Pre-release CHANGELOG behaviour:
#   alpha/beta/rc: CHANGELOG [Unreleased] is NOT rotated — notes accumulate
#     until the final stable release.
#   release: [Unreleased] is rotated to the stable version as normal.
#
# Versioning note (two schemes, one release):
#   api + web carry the semver form (0.2.0-alpha.1); the scheduler is a PyPI
#   package and carries the PEP 440 form of the SAME version (0.2.0a1). The
#   canonical parse source is the API manifest (semver, parser-compatible);
#   the scheduler manifest is bumped via a semver→PEP 440 translation so it
#   always matches the `scheduler-v<PEP440>` publish tag and the CI version
#   check in scheduler:publish. Two tags are created: v<semver> (Docker/Helm
#   publish) and scheduler-v<PEP440> (PyPI publish).
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
  case "$1" in
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
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+\.[0-9]+)?$ ]] \
    || die "'$1' is not a valid semver (expected x.y.z or x.y.z-alpha|beta|rc.N)"
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
      echo "  tags    : v${suggested}, scheduler-v${pep440}"
      [[ "$suggested" == *-* ]] && echo "  note    : pre-release — CHANGELOG will not be rotated"
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
# Parse args
# ---------------------------------------------------------------------------

BUMP=""
PRE_ARG=""

# Strip the -y/--yes flag (also honored via RELEASE_ASSUME_YES=1) before the
# positional-arg count check, so it can appear in any position. No arrays —
# this script must run under macOS bash 3.2.
ASSUME_YES=false
[[ "${RELEASE_ASSUME_YES:-0}" == "1" ]] && ASSUME_YES=true
REST=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=true ;;
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
$IS_PRERELEASE && echo "  (pre-release — CHANGELOG will not be rotated)"

TODAY="$(date +%Y-%m-%d)"
TAG="v${NEW_VERSION}"
# The scheduler PyPI publish job triggers on scheduler-v<PEP440> and string-
# matches the tag against the scheduler manifest, so this tag must use the
# PEP 440 form (scheduler-v0.2.0a1, not scheduler-v0.2.0-alpha.1).
SCHEDULER_TAG="scheduler-v$(to_pep440 "$NEW_VERSION")"

git tag | grep -qxF "$TAG" && die "Tag $TAG already exists."
git tag | grep -qxF "$SCHEDULER_TAG" && die "Tag $SCHEDULER_TAG already exists."

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

bump_manifest packages/api/pyproject.toml \
  "s/^version = \"${CURRENT_ESCAPED}\"/version = \"${NEW_VERSION}\"/" \
  "version = \"${NEW_VERSION}\""

bump_manifest packages/web/package.json \
  "s/\"version\": \"${CURRENT_ESCAPED}\"/\"version\": \"${NEW_VERSION}\"/" \
  "\"version\": \"${NEW_VERSION}\""

echo "  Bumped manifests to $NEW_VERSION (scheduler PyPI: $NEW_PEP440)"

# ---------------------------------------------------------------------------
# CHANGELOG rotation (stable releases only)
# ---------------------------------------------------------------------------

CHANGELOG="CHANGELOG.md"

if ! $IS_PRERELEASE; then
  # Assemble any pending changelog fragments into [Unreleased] before rotating.
  bash scripts/assemble-changelog.sh

  if ! grep -q "## \[Unreleased\]" "$CHANGELOG"; then
    die "$CHANGELOG has no [Unreleased] section — add release notes before releasing."
  fi

  UNRELEASED_CONTENT="$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' "$CHANGELOG")"
  if [[ -z "$(echo "$UNRELEASED_CONTENT" | tr -d '[:space:]')" ]]; then
    die "$CHANGELOG [Unreleased] section is empty — add release notes before releasing."
  fi

  REPLACEMENT="## [Unreleased]\n\n## [${NEW_VERSION}] - ${TODAY}"

  awk -v rep="$REPLACEMENT" '
    /^## \[Unreleased\]/ && !done { print rep; done=1; next }
    { print }
  ' "$CHANGELOG" > "${CHANGELOG}.tmp" && mv "${CHANGELOG}.tmp" "$CHANGELOG"

  echo "  Updated CHANGELOG.md: [Unreleased] → [$NEW_VERSION] - $TODAY"
fi

# ---------------------------------------------------------------------------
# Commit and tag
# ---------------------------------------------------------------------------

git add \
  packages/scheduler/pyproject.toml \
  packages/api/pyproject.toml \
  packages/web/package.json \
  CHANGELOG.md

git commit -m "chore(release): bump version to ${NEW_VERSION}

Automated release commit. See CHANGELOG.md for details."

git tag -a "$TAG" -m "Release $TAG"
git tag -a "$SCHEDULER_TAG" -m "Release trueppm-scheduler ${NEW_PEP440}"

echo ""
echo "Done. Created commit and tags $TAG, $SCHEDULER_TAG."
echo ""
echo "Next steps:"
echo "  git push origin main $TAG          # triggers Docker + Helm publish"
echo "  git push origin $SCHEDULER_TAG     # triggers trueppm-scheduler PyPI publish"
if ! $IS_PRERELEASE; then
  echo "  # Then run the enterprise release script pinned to $TAG"
fi
