#!/usr/bin/env bash
# Nightly tracker-drift report (#4925).
#
# The tracker-reading gates (README limitations, TODO(#N), known-issues,
# SUPPRESSED-UNTIL markers, CLAUDE.md stale claims) block an MR or main push
# only for drift that change causes (TRACKER_GATE_MODE=diff, see
# scripts/lib/gitlab-issues.sh). Drift caused by an edit to the TRACKER — an
# issue filed, closed from the UI, relabeled, re-milestoned — fails no pipeline
# any more, because no commit caused it and none of the MRs it used to red
# could fix it (21 of 94 main pushes, 2026-10-27..11-10).
#
# This script is where that drift goes instead. It runs every gate with
# TRACKER_GATE_MODE=drift (the full-state check) and keeps ONE tracking issue
# in sync with the result, found by its fixed title and the `tracker-drift`
# label:
#
#   drift found, no issue          -> create it
#   drift found, issue differs     -> rewrite its description (reopen if closed)
#   drift found, issue identical   -> nothing (a digest of the findings is kept
#                                     in the description, so an unchanged night
#                                     posts nothing)
#   clean, issue open              -> close it with a note
#   clean, no open issue           -> nothing
#
# It also folds in boundary:check (check-issue-boundary.sh). That gate is
# label-driven by design and keeps its own blocking job on main and schedule —
# an `enterprise`/`portfolio` label on an open OSS issue is a governance leak
# worth an immediate red, the fix is a relabel in seconds, and the job never
# runs on MR pipelines, so it cannot fail an unrelated MR. Listing it here as
# well puts a violation created from the UI into the same tracking issue.
#
# Exit status: 0 when the report was recorded (drift or not). Drift itself does
# not red this job: the tracking issue is the durable signal, and a red
# schedule that no commit can turn green every night trains people to ignore
# red. It exits 1 — fail closed, the issue left untouched — when any gate could
# not read the tracker (an incomplete report must not close a valid tracking
# issue) or a tracker write fails.
#
# Tokens: gates read with ISSUES_API_TOKEN (read_api) as everywhere else.
# Writes need TRACKER_DRIFT_TOKEN — a masked, protected project access token
# with `api` scope and at least Reporter role (Issues write). It is required
# only when a write is needed; without it the job prints the report and fails.
# The token is sent only as a request header and never echoed; never run this
# with `set -x`.
#
# Usage:
#   bash scripts/tracker-drift-report.sh             # in the TRACKER_DRIFT_NIGHTLY schedule
#   bash scripts/tracker-drift-report.sh --dry-run   # print the report, write nothing
#   bash scripts/tracker-drift-report.sh --self-test

set -euo pipefail

TITLE="Tracker drift: repo references out of sync with the issue tracker"
LABEL="tracker-drift"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_GATES="lint:scheduler-readme-limitations	bash $HERE/check-scheduler-readme-limitations.sh
lint:todo-grep	bash $HERE/check-todo-grep.sh
docs:known-issues-freshness	bash $HERE/check-known-issues-freshness.sh
lint:suppression-issues	bash $HERE/check-suppression-issues.sh
lint:claude-md-stale-issues	bash $HERE/check-claude-md-stale-issues.sh
boundary:check	bash $HERE/check-issue-boundary.sh"

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/bin" "$tmp/gates"
  # Fake gates: each exits with the code in $tmp/gates/<name>.rc.
  for g in a b; do
    printf '#!/usr/bin/env bash\n[ "$TRACKER_GATE_MODE" = drift ] || { echo "not drift mode"; exit 9; }\nrc=$(cat %s/%s.rc)\n[ "$rc" = 1 ] && echo "ERROR: gate %s finding $(cat %s/%s.msg 2>/dev/null)"\nexit "$rc"\n' \
      "$tmp/gates" "$g" "$g" "$tmp/gates" "$g" >"$tmp/gates/$g.sh"
  done
  export TRACKER_DRIFT_GATES="gate:a	bash $tmp/gates/a.sh
gate:b	bash $tmp/gates/b.sh"
  # Fake curl: writes (-X) are logged and answered 201; GET issue lists come
  # from $tmp/issues.json, GET /issues/:iid from $tmp/issue.json.
  cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
url="${*: -1}"
if grep -qx -- '-X' <<<"$(printf '%s\n' "$@")"; then
  { printf '%s' "$*" | tr '\n' ' '; echo; } >>"$MOCK_DIR/writes"
  printf '{}\n201'
  exit 0
fi
if [ "${MOCK_FAIL:-0}" = 1 ]; then printf '\n000 '; exit 0; fi
case "$url" in
  */issues/[0-9]*) cat "$MOCK_DIR/issue.json" ;;
  *) cat "$MOCK_DIR/issues.json" ;;
esac
printf '\n200 '
CURLMOCK
  chmod +x "$tmp/bin/curl"
  export PATH="$tmp/bin:$PATH" MOCK_DIR="$tmp" CI_PROJECT_ID=1 GITLAB_ISSUES_SLEEP_OVERRIDE=0 GITLAB_ISSUES_MAX_ATTEMPTS=1
  export TRACKER_DRIFT_TOKEN=write-secret
  fails=0
  run() { # run <want-rc> <want-writes-regex|none> <description>
    local rc=0
    : >"$tmp/writes"
    bash "$0" >"$tmp/out" 2>&1 || rc=$?
    if [ "$rc" != "$1" ] ||
      { [ "$2" = none ] && [ -s "$tmp/writes" ]; } ||
      { [ "$2" != none ] && ! grep -qE -- "$2" "$tmp/writes"; }; then
      echo "SELF-TEST FAILED: $3 (exit $rc)" >&2
      cat "$tmp/out" "$tmp/writes" >&2
      fails=1
      return
    fi
    if grep -q 'write-secret' "$tmp/out"; then
      echo "SELF-TEST FAILED: $3 — the write token leaked into the job log" >&2
      fails=1
      return
    fi
    echo "SELF-TEST OK: $3"
  }
  echo 0 >"$tmp/gates/a.rc"
  echo 0 >"$tmp/gates/b.rc"
  echo '[]' >"$tmp/issues.json"
  run 0 none "a clean report with no tracking issue writes nothing"

  echo 1 >"$tmp/gates/b.rc"
  echo "#20 missing" >"$tmp/gates/b.msg"
  run 0 '-X POST .*/projects/1/issues$' "drift with no tracking issue creates one (and the job stays green)"

  # The same findings, already recorded: reuse the digest the script computes.
  digest=$(TRACKER_DRIFT_PRINT_DIGEST=1 bash "$0" 2>/dev/null | tail -n1)
  jq -nc --arg t "Tracker drift: repo references out of sync with the issue tracker" \
    '[{iid: 7, state: "opened", title: $t}]' >"$tmp/issues.json"
  jq -nc --arg d "x <!-- tracker-drift-digest: ${digest} --> y" '{iid: 7, description: $d}' >"$tmp/issue.json"
  run 0 none "unchanged drift posts nothing"

  echo "#21 missing too" >"$tmp/gates/b.msg"
  run 0 '-X PUT .*/issues/7$' "changed drift rewrites the existing tracking issue"

  jq -nc --arg t "Tracker drift: repo references out of sync with the issue tracker" \
    '[{iid: 7, state: "closed", title: $t}]' >"$tmp/issues.json"
  run 0 'state_event=reopen' "drift returning after a clean night reopens the tracking issue"

  echo 0 >"$tmp/gates/b.rc"
  jq -nc --arg t "Tracker drift: repo references out of sync with the issue tracker" \
    '[{iid: 7, state: "opened", title: $t}]' >"$tmp/issues.json"
  run 0 'state_event=close' "a clean report closes the open tracking issue"

  echo 3 >"$tmp/gates/a.rc"
  run 1 none "a gate that cannot read the tracker fails the job and touches no issue"

  echo 0 >"$tmp/gates/a.rc"
  echo 1 >"$tmp/gates/b.rc"
  echo '[]' >"$tmp/issues.json"
  MOCK_FAIL=1 run 1 none "an unreadable tracking-issue lookup fails closed"
  TRACKER_DRIFT_TOKEN="" run 1 none "a needed write with no TRACKER_DRIFT_TOKEN fails rather than going quiet"

  [ "$fails" = 0 ] || exit 1
  echo "ALL SELF-TESTS PASSED"
  exit 0
fi

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

PROJECT="${CI_PROJECT_ID:-}"
if [ -z "$PROJECT" ]; then
  echo "ERROR: CI_PROJECT_ID is not set. This script is intended to run in CI." >&2
  exit 2
fi
API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
# shellcheck source-path=SCRIPTDIR source=lib/gitlab-issues.sh
. "$HERE/lib/gitlab-issues.sh"
READ_TOKEN="${ISSUES_API_TOKEN:-}"

# ---- 1. Run every gate in drift mode.
findings=""
errors=0
while IFS=$'\t' read -r name cmd; do
  [ -n "$name" ] || continue
  rc=0
  # shellcheck disable=SC2086  # cmd is "bash <path>", split on purpose
  out=$(TRACKER_GATE_MODE=drift $cmd 2>&1) || rc=$?
  case "$rc" in
    0) echo "drift-report: ${name}: clean" ;;
    1)
      echo "drift-report: ${name}: drift found"
      # Drop retry/INFO noise so the digest only moves when the findings do.
      body=$(printf '%s\n' "$out" | grep -vE '^(WARN|INFO|OK):|retrying in' | sed -n 1,200p || true)
      findings+="### \`${name}\`"$'\n\n```text\n'"${body}"$'\n```\n\n'
      ;;
    *)
      echo "drift-report: ${name}: could not run (exit ${rc}) — failing closed" >&2
      printf '%s\n' "$out" | sed 's/^/  /' >&2
      errors=$((errors + 1))
      ;;
  esac
done <<<"${TRACKER_DRIFT_GATES:-$DEFAULT_GATES}"

if [ "$errors" -gt 0 ]; then
  echo "ERROR: ${errors} gate(s) could not read the tracker; the tracking issue is left untouched (an incomplete report must not close it). Retry the job." >&2
  exit 1
fi

digest=$(printf '%s' "$findings" | sha256sum | cut -c1-16)
if [ "${TRACKER_DRIFT_PRINT_DIGEST:-0}" = 1 ]; then
  printf '%s\n' "$digest"
  exit 0
fi
[ -n "$findings" ] && printf '\n%s' "$findings"

# ---- 2. Find the tracking issue (lowest iid with the exact title).
rows=$(gitlab_issues_by_label "$API" "$PROJECT" "$READ_TOKEN" "$LABEL" all) || {
  echo "ERROR: could not list '${LABEL}' issues — failing closed." >&2
  exit 1
}
issue=$(printf '%s\n' "$rows" | awk -F'\t' -v t="$TITLE" '$3 == t' | sort -n | sed -n 1p || true)
iid=$(printf '%s' "$issue" | cut -f1)
state=$(printf '%s' "$issue" | cut -f2)

if [ -z "$findings" ] && [ "$state" != opened ]; then
  echo "OK: no tracker drift, and no open tracking issue."
  exit 0
fi

if [ -n "$findings" ] && [ "$state" = opened ]; then
  current=$(_gitlab_get "${API}/projects/${PROJECT}/issues/${iid}" "$READ_TOKEN") || {
    echo "ERROR: could not read tracking issue #${iid} — failing closed." >&2
    exit 1
  }
  if grep -qF "tracker-drift-digest: ${digest}" <<<"$(printf '%s' "$current" | jq -r '.description // ""')"; then
    echo "OK: drift unchanged since the last report (#${iid}); nothing posted."
    exit 0
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "DRY RUN: would update the tracking issue (${iid:-new}); nothing written."
  exit 0
fi
WRITE_TOKEN="${TRACKER_DRIFT_TOKEN:-}"
if [ -z "$WRITE_TOKEN" ]; then
  echo "ERROR: the tracking issue needs updating but TRACKER_DRIFT_TOKEN (api scope, Reporter+) is not set." >&2
  exit 1
fi

# tracker_write <METHOD> <path> <curl --data-urlencode args...>
tracker_write() {
  local method="$1" path="$2" resp code
  shift 2
  resp=$(curl -s -X "$method" -w $'\n%{http_code}' --header "PRIVATE-TOKEN: ${WRITE_TOKEN}" \
    "$@" "${API}/projects/${PROJECT}${path}" 2>/dev/null || true)
  code="${resp##*$'\n'}"
  case "$code" in
    2??) return 0 ;;
    *)
      echo "ERROR: ${method} ${path} returned HTTP ${code:-000}." >&2
      return 1
      ;;
  esac
}

pipeline="${CI_PIPELINE_URL:-a local run}"
if [ -z "$findings" ]; then
  tracker_write POST "/issues/${iid}/notes" --data-urlencode "body=Clean as of ${pipeline}: no tracker drift. Closing." &&
    tracker_write PUT "/issues/${iid}" --data-urlencode "state_event=close" || exit 1
  echo "OK: drift cleared; closed tracking issue #${iid}."
  exit 0
fi

description="Nightly report from \`tracker:drift-report\` (${pipeline}).

These references disagree with the tracker because of a **tracker edit** — an issue filed, closed outside an MR, relabeled or re-milestoned — not because of any commit, so they no longer fail MR or main pipelines (#4925). Fix them in a normal MR; this issue rewrites itself every night and closes when the report is clean.

${findings}<!-- tracker-drift-digest: ${digest} -->"

if [ -z "$iid" ]; then
  tracker_write POST "/issues" --data-urlencode "title=${TITLE}" --data-urlencode "labels=${LABEL},ci,harness" \
    --data-urlencode "description=${description}" || exit 1
  echo "OK: drift found; opened a tracking issue."
else
  args=(--data-urlencode "description=${description}")
  [ "$state" != opened ] && args+=(--data-urlencode "state_event=reopen")
  tracker_write PUT "/issues/${iid}" "${args[@]}" || exit 1
  echo "OK: drift found; updated tracking issue #${iid}."
fi
