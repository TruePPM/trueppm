#!/usr/bin/env bash
# Release-commitment label gate (#3444). CLAUDE.md § Milestone commitment gives
# every open issue in a DATED milestone exactly one of release::committed /
# release::reserve / release::stretch. Nothing enforced it, so the axis decays
# one unlabeled issue at a time. Two checks, one per end of that decay:
#
#   1. Labeled end. For every ACTIVE milestone with a due date, every open issue
#      carries exactly one `release::*` label. Prints `#iid — title` per
#      offender. WARNS (never fails) when release::reserve issues outnumber the
#      reserve a milestone's description states ("reserve: 40", "reserve of
#      40"); no number in the description -> skipped.
#   2. Unmilestoned end. An issue is in no milestone's list, so check 1 cannot
#      see it. An open issue with NO milestone carrying an audit-batch label
#      (voc-audit, ux-audit-*, threat-model-*, *-audit-YYYYMMDD[-topic], red-team-YYYYMMDD,
#      prerelease-audit-*, release-audit-*) came from a deliberate sweep and is
#      expected to be scheduled: it FAILS, unless younger than
#      RELEASE_LABELS_GRACE_HOURS (default 24) where it only WARNS, so filing a
#      batch and milestoning it minutes later does not red main.
#
# The gate never applies a label: the value is a human's call on every move.
#
# Exit codes:
#   0  clean (warnings allowed)
#   1  violations
#   2  invocation error
#   3  tracker unreadable after retries (infrastructure: RETRY THE JOB, not the
#      code - the .gitlab-ci.yml job retries exit 3 automatically)
#
# Tracker reads go through scripts/lib/gitlab-issues.sh (retry, 429, token).
# Token: ISSUES_API_TOKEN (optional; the tracker is public). Never JOB-TOKEN.
#
# Usage:
#   bash scripts/check-release-labels.sh              # live (needs network)
#   bash scripts/check-release-labels.sh --self-test  # offline fixtures

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gitlab-issues.sh
. "${HERE}/lib/gitlab-issues.sh"

# Matched case-insensitively (test($re; "i")): real labels include
# Fable-audit-20260703-UI-Checks and Opus-Audit-20260706-priorities, and dated
# sweeps carry a topic suffix (fable-audit-20260702-perf) or are red-team-YYYYMMDD.
AUDIT_LABEL_RE='^(voc-audit|ux-audit-.*|threat-model-.*|.*-audit-[0-9]{8}(-.*)?|red-team-[0-9]{8}(-.*)?|prerelease-audit-.*|release-audit-.*)$'

# analyze <milestones-json> <issues-json> <orphans-json> <now-epoch> <grace-hours>
#
# Pure function over JSON, shared by the live run and --self-test. <issues-json>
# is the open issues of the dated milestones (each carries .milestone.title);
# <orphans-json> the open issues with no milestone. Prints FAIL:/WARN:/INFO:
# lines; exit status is 1 when any FAIL line was printed.
analyze() {
  local out="" ms_out orph_out
  # --slurpfile, not --argjson: a real tracker is ~1,200 issues and an argv that
  # size hits "Argument list too long", which a bare $(...) would swallow and
  # report as a clean run (the gate failing OPEN). jq errors return 2 instead.
  ms_out=$(jq -r --slurpfile issues_f <(printf '%s' "$2") '
    ($issues_f[0]) as $issues
    | def rel: [(.labels // [])[] | select(startswith("release::"))];
    .[] | select(.due_date != null and .state == "active") as $m
    | ($issues | map(select(.milestone.title == $m.title))) as $is
    | ( $is[] | select((rel | length) != 1)
        | "FAIL: milestone \($m.title): #\(.iid) — \(.title) (\(rel | length) release:: labels)" ),
      ( ($m.description // "" | capture("(?i)reserve[^0-9\\n]{0,40}(?<n>[0-9]+)")?) as $r
        | select($r != null)
        | ($is | map(select(rel == ["release::reserve"])) | length) as $c
        | select($c > ($r.n | tonumber))
        | "WARN: milestone \($m.title): \($c) release::reserve issues exceed the stated reserve of \($r.n)" )
    ' <<<"$1") || return 2
  orph_out=$(jq -r --argjson now "$4" --argjson grace "$5" --arg re "$AUDIT_LABEL_RE" '
    .[] | select([(.labels // [])[] | select(test($re; "i"))] | length > 0)
    | (($now - (.created_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) / 3600) as $age
    | if $age < $grace
      then "WARN: unmilestoned audit-batch issue #\(.iid) — \(.title) (younger than \($grace)h)"
      else "FAIL: unmilestoned audit-batch issue #\(.iid) — \(.title)" end' <<<"$3") || return 2
  out=$(printf '%s\n%s\n' "$ms_out" "$orph_out" | grep . || true)
  [ -n "$out" ] && printf '%s\n' "$out"
  grep -q '^FAIL:' <<<"$out" && return 1
  return 0
}

report() { # stdin: analyze output
  local lines fails warns
  lines=$(cat)
  fails=$(grep -c '^FAIL:' <<<"$lines" || true)
  warns=$(grep -c '^WARN:' <<<"$lines" || true)
  echo "release-labels: ${fails} violation(s), ${warns} warning(s)"
  if [ "$fails" -gt 0 ]; then
    cat <<'MSG'

Fix each with one command - the value is your call, the gate never guesses:
  - missing release:: label:  glab issue update <iid> -l release::committed|release::reserve|release::stretch
  - unmilestoned audit batch: glab issue update <iid> --milestone <title>   (or drop the audit label if it was not a sweep finding)
See CLAUDE.md § Milestone commitment.
MSG
  fi
}

self_test() {
  local ms issues orphans now=1800000000 rc out fail=0
  ms='[{"title":"0.5","state":"active","due_date":"2027-01-01","description":"Reserve: 1 slot"},
       {"title":"0.9","state":"active","due_date":null,"description":""}]'
  issues='[
   {"iid":1,"title":"ok","labels":["release::committed"],"milestone":{"title":"0.5"}},
   {"iid":2,"title":"bare","labels":["bug"],"milestone":{"title":"0.5"}},
   {"iid":3,"title":"two","labels":["release::reserve","release::stretch"],"milestone":{"title":"0.5"}},
   {"iid":4,"title":"r1","labels":["release::reserve"],"milestone":{"title":"0.5"}},
   {"iid":5,"title":"r2","labels":["release::reserve"],"milestone":{"title":"0.5"}},
   {"iid":6,"title":"undated ms","labels":[],"milestone":{"title":"0.9"}}]'
  orphans='[
   {"iid":10,"title":"old sweep","labels":["voc-audit"],"created_at":"2027-01-01T00:00:00.000Z"},
   {"iid":11,"title":"fresh sweep","labels":["ux-audit-20260101"],"created_at":"2027-01-15T07:59:00.000Z"},
   {"iid":12,"title":"plain backlog","labels":["backlog"],"created_at":"2020-01-01T00:00:00.000Z"},
   {"iid":13,"title":"dated family","labels":["ui-audit-20260906"],"created_at":"2020-01-01T00:00:00.000Z"},
   {"iid":14,"title":"suffixed","labels":["fable-audit-20260702-perf"],"created_at":"2020-01-01T00:00:00.000Z"},
   {"iid":15,"title":"capitalized","labels":["Opus-Audit-20260706-priorities"],"created_at":"2020-01-01T00:00:00.000Z"},
   {"iid":16,"title":"red team","labels":["red-team-20260709"],"created_at":"2020-01-01T00:00:00.000Z"},
   {"iid":17,"title":"not a sweep","labels":["audit-log","performance"],"created_at":"2020-01-01T00:00:00.000Z"}]'
  # now = 2027-01-15T08:00:00Z
  out=$(analyze "$ms" "$issues" "$orphans" "$now" 24) && rc=0 || rc=$?
  assert() { grep -qF -- "$1" <<<"$out" || { echo "SELF-TEST FAIL: expected: $1" >&2; fail=1; }; }
  refute() { grep -qF -- "$1" <<<"$out" && { echo "SELF-TEST FAIL: unexpected: $1" >&2; fail=1; } || true; }
  [ "$rc" -eq 1 ] || { echo "SELF-TEST FAIL: expected exit 1, got $rc" >&2; fail=1; }
  assert "FAIL: milestone 0.5: #2 — bare (0 release:: labels)"
  assert "FAIL: milestone 0.5: #3 — two (2 release:: labels)"
  refute "#1 — ok"
  refute "#6"
  assert "WARN: milestone 0.5: 2 release::reserve issues exceed the stated reserve of 1"
  assert "FAIL: unmilestoned audit-batch issue #10"
  assert "WARN: unmilestoned audit-batch issue #11 — fresh sweep (younger than 24h)"
  refute "FAIL: unmilestoned audit-batch issue #11"
  assert "FAIL: unmilestoned audit-batch issue #13"
  refute "#12"
  assert "FAIL: unmilestoned audit-batch issue #14"
  assert "FAIL: unmilestoned audit-batch issue #15"
  assert "FAIL: unmilestoned audit-batch issue #16"
  refute "#17"
  # A clean tracker passes; a warn-only tracker passes; orphans checked with no dated milestone.
  out=$(analyze "$ms" '[{"iid":1,"title":"ok","labels":["release::stretch"],"milestone":{"title":"0.5"}}]' '[]' "$now" 24) && rc=0 || rc=$?
  [ "$rc" -eq 0 ] || { echo "SELF-TEST FAIL: clean input exited $rc" >&2; fail=1; }
  out=$(analyze '[]' '[]' "$orphans" "$now" 24) && rc=0 || rc=$?
  [ "$rc" -eq 1 ] || { echo "SELF-TEST FAIL: orphans with no dated milestone exited $rc" >&2; fail=1; }
  assert "FAIL: unmilestoned audit-batch issue #10"
  # A tracker-sized payload (> ARG_MAX if passed as an argument) must be analyzed,
  # not silently dropped: 20k bare issues must yield 20k offenders.
  local big
  big=$(jq -nc '[range(20000) | {iid: ., title: ("t" + (. | tostring)), labels: [], milestone: {title: "0.5"}}]')
  out=$(analyze "$ms" "$big" '[]' "$now" 24) && rc=0 || rc=$?
  [ "$rc" -eq 1 ] && [ "$(grep -c '^FAIL: milestone 0.5' <<<"$out")" -eq 20000 ] ||
    { echo "SELF-TEST FAIL: large payload not fully analyzed (rc=$rc)" >&2; fail=1; }
  # An empty open-issue list means a wrong project id or a filter regression
  # (the tracker holds ~1,000), never a clean run: exit 3 so the job retries.
  out=$(require_nonempty_issues '[]' 2>&1) && rc=0 || rc=$?
  [ "$rc" -eq "$TRACKER_UNREADABLE_EXIT" ] && grep -q 'zero open issues' <<<"$out" ||
    { echo "SELF-TEST FAIL: empty issue list exited $rc, expected $TRACKER_UNREADABLE_EXIT" >&2; fail=1; }
  require_nonempty_issues '[{"iid":1}]' || { echo "SELF-TEST FAIL: non-empty list rejected" >&2; fail=1; }
  [ "$fail" -eq 0 ] && echo "self-test OK" || return 1
}

require_nonempty_issues() { # <issues-json>
  if [ "$(jq 'length' <<<"$1")" -eq 0 ]; then
    echo "ERROR: tracker returned zero open issues in dated milestones; the tracker holds ~1,000, so this is a wrong CI_PROJECT_ID or a filter regression, not a clean run." >&2
    return "$TRACKER_UNREADABLE_EXIT"
  fi
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
PROJECT="${CI_PROJECT_ID:-}"
if [ -z "$PROJECT" ]; then
  echo "ERROR: CI_PROJECT_ID is not set. This script is intended to run in CI." >&2
  exit 2
fi
TOKEN="${ISSUES_API_TOKEN:-}"
GRACE="${RELEASE_LABELS_GRACE_HOURS:-24}"

unreadable() {
  echo "ERROR: tracker unreadable - this is infrastructure, retry the job (exit ${TRACKER_UNREADABLE_EXIT})." >&2
  exit "$TRACKER_UNREADABLE_EXIT"
}

# One paged read of every open milestoned issue. The milestone object embedded in
# each issue carries title/state/due_date/description, so no call to the
# /milestones endpoint is needed - that endpoint 401s anonymously while the
# issues list is public, and one fewer token requirement is one fewer way for
# this gate to fail closed.
issues=$(gitlab_json_list "$API" "$PROJECT" "$TOKEN" issues "state=opened&milestone=Any") || unreadable
require_nonempty_issues "$issues" || exit $?
milestones=$(jq -c 'map(.milestone) | unique_by(.id)' <<<"$issues")
orphans=$(gitlab_json_list "$API" "$PROJECT" "$TOKEN" issues "state=opened&milestone=None") || unreadable

rc=0
result=$(analyze "$milestones" "$issues" "$orphans" "$(date +%s)" "$GRACE") || rc=$?
if [ "$rc" -eq 2 ]; then
  echo "ERROR: could not analyze the tracker data (jq failed); refusing to report a clean run." >&2
  exit 2
fi
[ -n "$result" ] && printf '%s\n' "$result"
printf '%s\n' "$result" | report
exit "$rc"
