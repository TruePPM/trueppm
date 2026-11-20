#!/usr/bin/env bash
# Scheduled refresh of the vendored Semgrep packs, delivered as an MR (#3103).
#
# Runs from CI job `semgrep:refresh-mr` on the nightly schedule. Does nothing
# until .semgrep/REFRESHED is older than REFRESH_AFTER_DAYS (default 7), then
# runs scripts/update-semgrep-rules.sh, and only if a pack changed pushes a
# branch and opens an MR so the rule-set change is reviewed, not applied
# silently (the clause of #1369's Option B that was never implemented). When
# upstream is unchanged the stamp is restored and no MR is opened, so
# .semgrep/REFRESHED records the last refresh that CHANGED the packs: the job
# re-fetches every night while stale, and lint:semgrep-freshness can still warn
# after 45 days of an unchanged upstream.
# Also skips while a refresh MR is open or was closed within the last 7 days
# (a closed-unmerged MR must not reopen every night).
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
# Test seams (used by --self-test): SEMGREP_UPDATE_CMD (default
# `bash scripts/update-semgrep-rules.sh`), SEMGREP_REFRESH_ROOT, SEMGREP_PUSH_URL.
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
  self_test_flow
  echo "semgrep-refresh self-test ok"
}

# Drives main() in a throwaway git repo with a stubbed updater, a stubbed curl
# and a local bare repo as the push target, so both outcomes are exercised.
self_test_flow() {
  local t me
  # A git hook (pre-push) exports GIT_INDEX_FILE/GIT_DIR/...; inherited, the
  # throwaway repo's `git add`/`commit` would rewrite the REAL index.
  unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_COMMON_DIR
  t="$(mktemp -d)"
  me="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  mkdir -p "$t/bin" "$t/repo/.semgrep"
  git init -q --bare "$t/remote.git"
  cat > "$t/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  *state=opened*) cat "$STUB_DIR/open.json" ;;
  *state=closed*) cat "$STUB_DIR/closed.json" ;;
esac
SH
  chmod +x "$t/bin/curl"
  cat > "$t/unchanged.sh" <<'SH'
date -u +%Y-%m-%d > .semgrep/REFRESHED
SH
  cat > "$t/changed.sh" <<'SH'
date -u +%Y-%m-%d > .semgrep/REFRESHED
echo "rules: [new]" > .semgrep/a.yml
SH
  (
    cd "$t/repo"
    git init -q -b main
    git config user.email t@example.com; git config user.name t
    echo "rules: []" > .semgrep/a.yml; echo 2020-01-01 > .semgrep/REFRESHED
    git add . && git commit -q -m base
  )
  runit() {
    env "PATH=$t/bin:$PATH" "STUB_DIR=$t" "STUB_LOG=$t/curl.log" "SEMGREP_REFRESH_ROOT=$t/repo" \
      "SEMGREP_PUSH_URL=$t/remote.git" SEMGREP_REFRESH_TOKEN=x CI_API_V4_URL=http://api CI_PROJECT_ID=1 \
      CI_SERVER_HOST=h CI_PROJECT_PATH=p/p "SEMGREP_UPDATE_CMD=bash $t/$1" bash "$me" >/dev/null
  }
  fail() { echo "self-test FAILED: $1" >&2; rm -rf "$t"; exit 1; }
  reset() {
    git -C "$t/repo" checkout -q -f main && git -C "$t/repo" reset -q --hard "$(git -C "$t/repo" rev-list --max-parents=0 main)"
    git -C "$t/repo" branch --list 'chore/*' | tr -d ' *' | xargs -n1 git -C "$t/repo" branch -q -D 2>/dev/null || true
    git -C "$t/remote.git" branch --list | tr -d ' *' | xargs -n1 git -C "$t/remote.git" branch -q -D 2>/dev/null || true
    : > "$t/curl.log"; echo '[]' > "$t/open.json"; echo '[]' > "$t/closed.json"
  }
  branches() { git -C "$t/remote.git" branch --list | wc -l | tr -d ' '; }

  # 1. unchanged upstream: no branch, no push, no POST, stamp restored.
  reset
  runit unchanged.sh || fail "unchanged run errored"
  [ "$(branches)" = 0 ] || fail "unchanged upstream pushed a branch"
  grep -q -- '--request POST' "$t/curl.log" && fail "unchanged upstream opened an MR"
  [ "$(cat "$t/repo/.semgrep/REFRESHED")" = 2020-01-01 ] || fail "unchanged upstream did not restore the stamp"
  [ -z "$(git -C "$t/repo" status --porcelain)" ] || fail "unchanged upstream left the tree dirty"

  # 2. changed pack: branch pushed and MR POSTed.
  reset
  runit changed.sh || fail "changed run errored"
  [ "$(branches)" = 1 ] || fail "changed pack did not push exactly one branch"
  grep -q -- '--request POST' "$t/curl.log" || fail "changed pack did not open an MR"

  # 3. open MR: skip. 4. recently closed refresh MR: skip. 5. unrelated closed MR: proceeds.
  reset
  echo '[{"iid":1}]' > "$t/open.json"
  runit changed.sh || fail "open-MR run errored"
  [ "$(branches)" = 0 ] || fail "an open refresh MR did not suppress a new one"
  echo '[]' > "$t/open.json"
  echo '[{"iid":2,"source_branch":"chore/semgrep-rules-refresh-20260101"}]' > "$t/closed.json"
  runit changed.sh || fail "closed-MR run errored"
  [ "$(branches)" = 0 ] || fail "a recently closed refresh MR did not suppress a new one"
  echo '[{"iid":3,"source_branch":"feat/unrelated"}]' > "$t/closed.json"
  runit changed.sh || fail "unrelated-closed run errored"
  [ "$(branches)" = 1 ] || fail "an unrelated closed MR suppressed the refresh"
  rm -rf "$t"
}

main() {
  local dry=0
  [ "${1:-}" = "--dry-run" ] && dry=1
  local root today
  root="${SEMGREP_REFRESH_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
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
    # A refresh MR closed unmerged in the last 7 days is a "no" from a human;
    # without this, the stamp stays old and a new MR would open every night.
    local since closed
    since="$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)"
    closed="$(curl -fsS --header "PRIVATE-TOKEN: ${SEMGREP_REFRESH_TOKEN}" \
      "${api}/merge_requests?state=closed&updated_after=${since}&search=refresh+vendored+semgrep&in=title")"
    if grep -q '"source_branch": *"chore/semgrep-rules-refresh-' <<<"$closed"; then
      echo "ok: a refresh MR was closed within the last 7 days; not opening another"
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
  bash -c "${SEMGREP_UPDATE_CMD:-bash scripts/update-semgrep-rules.sh}"
  # The stamp always changes; the packs themselves are what make an MR worth
  # opening. Unchanged upstream: put the stamp back (it records the last refresh
  # that CHANGED the packs) and stop. status, not diff, so a new pack file counts.
  if [ -z "$(git status --porcelain -- .semgrep ':!.semgrep/REFRESHED')" ]; then
    if [ "$dry" -eq 1 ]; then
      cp -R "$backup/." .semgrep/; rm -rf "$backup"
    else
      git checkout -- .semgrep/REFRESHED
    fi
    echo "packs unchanged upstream; no MR to open"
    return 0
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
  git push -q "${SEMGREP_PUSH_URL:-https://oauth2:${SEMGREP_REFRESH_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git}" "HEAD:refs/heads/${branch}"
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
