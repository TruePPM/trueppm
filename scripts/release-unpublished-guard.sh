#!/usr/bin/env bash
# scripts/release-unpublished-guard.sh <semver> — refuse to cut a version that
# is already published anywhere (#4061).
#
# release.sh used to guard against a re-cut with `git tag` alone. That reads
# only THIS clone: it says nothing about origin, and deleting a local tag makes
# it answer "no" for a version that is already live. At 0.4.0-beta.2 a second,
# never-pushed set of the three tags was made 16 minutes after the first had
# published — a clone that can no longer `git fetch --tags`, and one
# `push --force` from moving tags under three immutable PyPI uploads.
#
# Two remote sources of truth, both checked before any manifest is bumped:
#   1. origin's tags — for v<semver>, scheduler-v<pep440>, mcp-v<pep440>;
#   2. PyPI — trueppm-scheduler, trueppm-mcp and trueppm-api at <pep440>.
#      PyPI file uploads are immutable, so a published version is burned.
#
# Fails CLOSED: a network failure or an unexpected HTTP status is a distinct
# refusal, never "absent". A guard that goes quiet when it cannot see is the
# failure mode this exists to end.
#
# ## Overrides (used by scripts/tests/release-unpublished.test.sh)
#
# RELEASE_LS_REMOTE_CMD  command: prints `git ls-remote --tags` output for the
#                        ref pattern in $1, exits nonzero when it cannot read
#                        the remote          (default: git ls-remote --tags origin)
# RELEASE_PYPI_PROBE_CMD command: prints the HTTP status for the URL in $1, exits
#                        nonzero when it cannot reach PyPI
#                                            (default: curl HEAD-style status probe)
# RELEASE_SKIP_REMOTE_CHECK=1  skip both (offline cut; loud, never the default)
#
# Exit codes: 0 nothing published · 1 already published · 2 could not tell.

set -euo pipefail

NEW_VERSION="${1:-}"
[[ -n "$NEW_VERSION" ]] || { echo "usage: $0 <semver>" >&2; exit 2; }

if [[ "${RELEASE_SKIP_REMOTE_CHECK:-}" == "1" ]]; then
  echo "  ! Skipping the origin/PyPI published-version check (RELEASE_SKIP_REMOTE_CHECK=1)." >&2
  exit 0
fi

to_pep440() {
  local v="$1"
  v="${v/-alpha./a}"; v="${v/-beta./b}"; v="${v/-rc./rc}"
  echo "$v"
}
PEP="$(to_pep440 "$NEW_VERSION")"

ls_remote() {
  if [[ -n "${RELEASE_LS_REMOTE_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    $RELEASE_LS_REMOTE_CMD "$1"
  else
    git ls-remote --tags origin "$1"
  fi
}

pypi_status() {
  if [[ -n "${RELEASE_PYPI_PROBE_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    $RELEASE_PYPI_PROBE_CMD "$1"
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1"
  fi
}

published=0

for tag in "v${NEW_VERSION}" "scheduler-v${PEP}" "mcp-v${PEP}"; do
  if ! out="$(ls_remote "refs/tags/${tag}")"; then
    echo "error: could not read origin's tags to check ${tag} (network or auth). Refusing to assume it is absent; fix access, or set RELEASE_SKIP_REMOTE_CHECK=1 for a deliberate offline cut." >&2
    exit 2
  fi
  if [[ -n "$out" ]]; then
    sha="$(awk 'NR==1 {print $1}' <<<"$out")"
    echo "error: tag ${tag} already exists on origin (${sha:0:12}). A published version is never re-cut; cut the NEXT version." >&2
    published=1
  fi
done

for pkg in trueppm-scheduler trueppm-mcp trueppm-api; do
  url="https://pypi.org/pypi/${pkg}/${PEP}/json"
  if ! code="$(pypi_status "$url")"; then
    echo "error: could not reach PyPI to check ${pkg} ${PEP}. Refusing to assume it is unpublished." >&2
    exit 2
  fi
  case "$code" in
    200) echo "error: ${pkg} ${PEP} already exists on PyPI. Uploads are immutable; cut the NEXT version." >&2
         published=1 ;;
    404) ;;
    *)   echo "error: unexpected HTTP ${code} from ${url}. Refusing to assume ${pkg} ${PEP} is unpublished." >&2
         exit 2 ;;
  esac
done

[[ "$published" -eq 0 ]] || exit 1
echo "  Verified v${NEW_VERSION} is unpublished on origin and PyPI."
