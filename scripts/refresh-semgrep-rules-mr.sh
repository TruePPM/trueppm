#!/usr/bin/env bash
# Scheduled refresh of the vendored Semgrep packs, delivered as an MR (#3103).
#
# Runs from CI job `semgrep:refresh-mr` on the nightly schedule. Does nothing
# until .semgrep/REFRESHED is older than REFRESH_AFTER_DAYS (default 7), then
# runs scripts/update-semgrep-rules.sh, and if the packs changed, pushes a
# branch and opens an MR so the rule-set change is reviewed, not applied
# silently (the clause of #1369's Option B that was never implemented).
#
# Fails loudly (exit 1) when it cannot do its job (no token, fetch failure,
# API/push failure): lint:semgrep-freshness is the backstop that goes red if
# this job itself is broken for 90 days, but a red job is the faster signal.
#
# Usage: scripts/refresh-semgrep-rules-mr.sh [--dry-run]   |   --self-test
#   --dry-run  fetch and report what would be pushed; no branch, no MR, no token.
# Needs (non-dry-run): SEMGREP_REFRESH_TOKEN (masked project access token,
# scopes api + write_repository, Developer+), CI_SERVER_HOST, CI_PROJECT_PATH,
# CI_API_V4_URL, CI_PROJECT_ID.
set -euo pipefail

REFRESH_AFTER_DAYS="${SEMGREP_REFRESH_AFTER_DAYS:-7}"

to_days() { # YYYY-MM-DD -> days since epoch (GNU or BSD date)
  local s
  s=$(date -u -d "$1" +%s 2>/dev/null || date -u -j -f %Y-%m-%d "$1" +%s)
  echo $((s / 86400))
}

# due <stamp-file> <today>: exit 0 when a refresh is due (stamp missing, bad, or old).
due() {
  local stamp="$1" today="$2" d
  [ -f "$stamp" ] || return 0
  d="$(tr -d '[:space:]' < "$stamp")"
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 0
  [ $(( $(to_days "$today") - $(to_days "$d") )) -ge "$REFRESH_AFTER_DAYS" ]
}

self_test() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo 2026-01-01 > "$tmp/s"
  due "$tmp/s" 2026-01-07 && { echo "self-test FAILED: 6 days old must not be due" >&2; exit 1; }
  due "$tmp/s" 2026-01-08 || { echo "self-test FAILED: 7 days old must be due" >&2; exit 1; }
  due "$tmp/none" 2026-01-08 || { echo "self-test FAILED: missing stamp must be due" >&2; exit 1; }
  echo garbage > "$tmp/s"
  due "$tmp/s" 2026-01-08 || { echo "self-test FAILED: bad stamp must be due" >&2; exit 1; }
  echo "semgrep-refresh self-test ok"
}

main() {
  local dry=0
  [ "${1:-}" = "--dry-run" ] && dry=1
  local root today
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$root"
  today="$(date -u +%Y-%m-%d)"

  if ! due .semgrep/REFRESHED "$today"; then
    echo "ok: packs refreshed within ${REFRESH_AFTER_DAYS} days ($(cat .semgrep/REFRESHED)); nothing to do"
    return 0
  fi

  if [ "$dry" -eq 0 ]; then
    : "${SEMGREP_REFRESH_TOKEN:?SEMGREP_REFRESH_TOKEN is not set: create a masked project access token (api + write_repository, Developer+) as a CI/CD variable}"
    local api="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}"
    local open
    open="$(curl -fsS --header "PRIVATE-TOKEN: ${SEMGREP_REFRESH_TOKEN}" \
      "${api}/merge_requests?state=opened&search=refresh+vendored+semgrep&in=title")"
    if [ "$(printf '%s' "$open" | grep -o '"iid"' | wc -l)" -gt 0 ]; then
      echo "ok: a refresh MR is already open; not opening another"
      return 0
    fi
  fi

  local backup=""
  if [ "$dry" -eq 1 ]; then
    # Restore afterwards by copy, not `git checkout`: a dry run must not
    # discard a working-tree refresh someone has not committed yet.
    backup="$(mktemp -d)"
    cp -R .semgrep/. "$backup/"
  fi
  bash scripts/update-semgrep-rules.sh
  # The stamp always changes; the packs themselves are what make an MR worth opening.
  if git diff --quiet -- .semgrep ':!.semgrep/REFRESHED'; then
    echo "packs unchanged upstream; stamp advanced to ${today} only"
  fi

  if [ "$dry" -eq 1 ]; then
    echo "dry-run: would push and open an MR with:"
    git diff --stat -- .semgrep
    cp -R "$backup/." .semgrep/
    rm -rf "$backup"
    return 0
  fi

  local branch="chore/semgrep-rules-refresh-${today//-/}"
  git config user.name "semgrep-refresh"
  git config user.email "semgrep-refresh@noreply.${CI_SERVER_HOST}"
  git checkout -b "$branch"
  git add .semgrep
  git commit -q -m "chore(ci): refresh vendored Semgrep rule packs" \
    -m "Scheduled refresh (scripts/refresh-semgrep-rules-mr.sh, #3103). Review the pack diff for rules that newly fail security:semgrep before merging."
  git push -q "https://oauth2:${SEMGREP_REFRESH_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git" "HEAD:refs/heads/${branch}"
  curl -fsS --request POST --header "PRIVATE-TOKEN: ${SEMGREP_REFRESH_TOKEN}" \
    --data-urlencode "source_branch=${branch}" \
    --data-urlencode "target_branch=main" \
    --data-urlencode "title=chore(ci): refresh vendored Semgrep rule packs" \
    --data-urlencode "labels=no-changelog,ci,tooling" \
    --data-urlencode "remove_source_branch=true" \
    --data-urlencode "description=Scheduled refresh of .semgrep/*.yml (#3103). The MR pipeline runs security:semgrep against the new packs: a red job here means an upstream rule newly flags existing code; triage it (fix, or an inline-justified nosemgrep) before merging. Do not hand-edit the packs." \
    "${api}/merge_requests" > /dev/null
  echo "opened refresh MR from ${branch}"
}

case "${1:-}" in
  --self-test) self_test ;;
  *) main "${1:-}" ;;
esac
