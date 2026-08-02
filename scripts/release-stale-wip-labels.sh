#!/usr/bin/env bash
# scripts/release-stale-wip-labels.sh — strip `status::wip` from CLOSED issues.
#
# Why this exists (#2693). `status::wip` is not decoration: it is a checked claim.
# `scripts/wt new` / `wt claim` set it and refuse an already-claimed issue, and
# `scripts/check-issue-collision.sh` (wired into `make pre-push`) reads it to warn when a
# branch's issue is claimed by another worktree.
#
# `wt remove` and `wt prune` already release the label — but only for work that went
# through a worktree AND was cleaned up. An issue closed any other way keeps the label
# forever: a merged MR whose worktree was never removed, work done with a plain
# `git checkout -b`, or an issue closed by hand in the GitLab UI. In July 2026 that left
# 28 closed issues still claimed.
#
# The failure mode is the usual one for a noisy gate: the collision warning fires on work
# that finished weeks ago, people learn to ignore it, and it stops catching the real
# duplicate it exists to catch (#1985 / !1352 / !1353). A claim signal is only worth
# having if it is trustworthy, so the release has to be automatic rather than a habit.
#
# Runs on the nightly schedule (see docs:… wip:release-stale in .gitlab-ci.yml). Safe to
# run by hand at any time.
#
# Usage:
#   scripts/release-stale-wip-labels.sh              # report only (default — no writes)
#   scripts/release-stale-wip-labels.sh --apply      # actually remove the label
#
# Auth: GITLAB_TOKEN, or WIP_SWEEP_TOKEN, or CI_JOB_TOKEN. A read-only token is enough
# for the default report; --apply needs `api` scope.
#
# Exit: 0 always in report mode (this is a janitor, not a gate — a stale label is not a
#       reason to red a pipeline). 1 only if the API is unreachable or --apply fails.

set -euo pipefail

LABEL="status::wip"
LABEL_ENC="status%3A%3Awip"
API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
PROJECT="${CI_PROJECT_ID:-trueppm%2Ftrueppm}"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

TOKEN="${GITLAB_TOKEN:-${WIP_SWEEP_TOKEN:-${CI_JOB_TOKEN:-}}}"

# Prefer glab when it is configured — a developer running this locally has glab auth and
# usually no GITLAB_TOKEN exported.
have_glab=0
if command -v glab >/dev/null 2>&1 && glab auth status >/dev/null 2>&1; then
  have_glab=1
fi

if [ "$have_glab" -eq 0 ] && [ -z "$TOKEN" ]; then
  echo "release-stale-wip-labels: no glab auth and no token (GITLAB_TOKEN / WIP_SWEEP_TOKEN / CI_JOB_TOKEN)" >&2
  exit 1
fi

api_get() {
  if [ "$have_glab" -eq 1 ]; then
    glab api "$1"
  else
    curl -fsSL -H "PRIVATE-TOKEN: ${TOKEN}" "${API}/projects/${PROJECT}/${1#projects/:id/}"
  fi
}

api_put() {
  if [ "$have_glab" -eq 1 ]; then
    glab api --method PUT "$1"
  else
    curl -fsSL -X PUT -H "PRIVATE-TOKEN: ${TOKEN}" "${API}/projects/${PROJECT}/${1#projects/:id/}"
  fi
}

# ---------------------------------------------------------------------------
# Collect closed issues that still carry the label.
#
# Filter server-side on the label and paginate: the label endpoint is far smaller than
# "all closed issues", and a naive first-N-pages scan of closed issues silently misses
# older ones (the project has >500 closed issues, and the 28 stale ones were among the
# oldest — a five-page scan reported zero).
# ---------------------------------------------------------------------------
stale=""
for page in $(seq 1 20); do
  batch="$(api_get "projects/:id/issues?labels=${LABEL_ENC}&state=closed&per_page=100&page=${page}" 2>/dev/null || echo '[]')"
  count="$(printf '%s' "$batch" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  [ "$count" = "0" ] && break
  stale="${stale}$(printf '%s' "$batch" | python3 -c '
import json,sys
for i in json.load(sys.stdin):
    print(i["iid"], i["title"][:70])
')
"
done

stale="$(printf '%s' "$stale" | sed '/^$/d')"

if [ -z "$stale" ]; then
  echo "release-stale-wip-labels: no closed issue carries '${LABEL}'. Nothing to do."
  exit 0
fi

n="$(printf '%s\n' "$stale" | wc -l | tr -d ' ')"
echo "release-stale-wip-labels: ${n} closed issue(s) still carry '${LABEL}':"
printf '%s\n' "$stale" | sed 's/^/  #/'

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "Report only. Re-run with --apply to remove the label."
  exit 0
fi

echo
failures=0
printf '%s\n' "$stale" | while read -r iid _rest; do
  if api_put "projects/:id/issues/${iid}?remove_labels=${LABEL_ENC}" >/dev/null 2>&1; then
    echo "  released #${iid}"
  else
    echo "  FAILED to release #${iid}" >&2
    failures=$((failures + 1))
  fi
done

exit 0
