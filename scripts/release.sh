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
# Pre-release CHANGELOG behaviour:
#   alpha/beta/rc: CHANGELOG [Unreleased] is NOT rotated — notes accumulate
#     until the final stable release.
#   release: [Unreleased] is rotated to the stable version as normal.
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

validate_semver() {
  # Accepts x.y.z and x.y.z-(alpha|beta|rc).N
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+\.[0-9]+)?$ ]] \
    || die "'$1' is not a valid semver (expected x.y.z or x.y.z-alpha|beta|rc.N)"
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

CURRENT_VERSION="$(grep '^version' packages/scheduler/pyproject.toml | head -1 | sed 's/version = "\(.*\)"/\1/')"

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

IS_PRERELEASE=false
[[ "$NEW_VERSION" == *-* ]] && IS_PRERELEASE=true

echo "Releasing: $CURRENT_VERSION → $NEW_VERSION"
$IS_PRERELEASE && echo "  (pre-release — CHANGELOG will not be rotated)"

TODAY="$(date +%Y-%m-%d)"
TAG="v${NEW_VERSION}"

git tag | grep -qxF "$TAG" && die "Tag $TAG already exists."

# ---------------------------------------------------------------------------
# Bump versions in manifests
# ---------------------------------------------------------------------------

# Escape dots in current version for sed pattern
CURRENT_ESCAPED="${CURRENT_VERSION//./\\.}"

sed -i.bak "s/^version = \"${CURRENT_ESCAPED}\"/version = \"${NEW_VERSION}\"/" \
  packages/scheduler/pyproject.toml && rm packages/scheduler/pyproject.toml.bak

sed -i.bak "s/^version = \"${CURRENT_ESCAPED}\"/version = \"${NEW_VERSION}\"/" \
  packages/api/pyproject.toml && rm packages/api/pyproject.toml.bak

sed -i.bak "s/\"version\": \"${CURRENT_ESCAPED}\"/\"version\": \"${NEW_VERSION}\"/" \
  packages/web/package.json && rm packages/web/package.json.bak

echo "  Bumped manifests to $NEW_VERSION"

# ---------------------------------------------------------------------------
# CHANGELOG rotation (stable releases only)
# ---------------------------------------------------------------------------

CHANGELOG="CHANGELOG.md"

if ! $IS_PRERELEASE; then
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

echo ""
echo "Done. Created commit and tag $TAG."
echo ""
echo "Next steps:"
echo "  git push origin main $TAG"
if ! $IS_PRERELEASE; then
  echo "  # Then run the enterprise release script pinned to $TAG"
fi
