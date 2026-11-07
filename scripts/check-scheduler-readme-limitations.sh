#!/usr/bin/env bash
# Scheduler README "Known limitations" tracker-sync gate (#4720).
#
# packages/scheduler/README.md ships as the PyPI page. Its "Known limitations
# open against 0.4" section and the "May also land in 0.5, but not committed"
# paragraph were written by hand for #4534 and nothing re-synced them: by
# 2026-10-31 six committed wrong-result bugs were missing and six issues the
# README called "not committed" had been relabeled release::committed (#4720).
#
# The section is the text from the "**Known limitations open against 0.4**"
# line up to (not including) the "**Later" line. Rules:
#   (a) an issue referenced in the "but not committed" paragraph must NOT carry
#       release::committed — the README would be denying a promise the tracker
#       made;
#   (b) every OPEN scheduler+correctness issue that reports a defect must be
#       referenced somewhere in the section. "Defect" means the title is a
#       `fix(...)` or carries no conventional-commit type; test(), feat(),
#       chore(), docs(), perf(), ci(), refactor() and build() issues are not
#       user-visible limitations and are exempt;
#   (c) no issue referenced in the section may be closed — the section's own
#       contract is "nothing in this list is fixed yet", so a fixed item comes
#       off the list.
#
# Exit codes:
#   0  no violations
#   1  a rule failed, or (default) the tracker could not be read
#   2  invocation / setup error (README missing, CI_PROJECT_ID unset)
#
# Modes:
#   bash scripts/check-scheduler-readme-limitations.sh              # default README
#   bash scripts/check-scheduler-readme-limitations.sh <file>       # a given file
#   bash scripts/check-scheduler-readme-limitations.sh --self-test  # fixtures
#
# Auth and rate limits: all tracker reads go through scripts/lib/gitlab-issues.sh
# (batched, 429/Retry-After retry, ISSUES_API_TOKEN fallback) — the gates that
# bypassed it 429'd main (#4452). No JOB-TOKEN header (#3043).
#
# A gate that cannot reach its oracle must go red, not silently pass.
# SCHEDULER_README_ALLOW_UNRESOLVED=1 is the explicit opt-out for a context
# where the tracker is genuinely unavailable; it is not set in this repo's CI.

set -euo pipefail

README_DEFAULT="packages/scheduler/README.md"
START_RE='^\*\*Known limitations open against'
END_RE='^\*\*Later'
NC_RE='^May also land in .*but not committed'
ISSUE_URL_RE='trueppm/trueppm/-/issues/[0-9]+'
EXEMPT_TYPE_RE='^(test|feat|chore|docs|perf|ci|refactor|build)(\(|:)'

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  # A fake `curl` ahead of PATH serves a JSON tracker snapshot ($MOCK_DB) to the
  # real fetch/parse/decide code. It answers the two call shapes the shared
  # reader makes: `issues?…iids[]=N…` and `issues?…labels=a,b&state=opened`.
  # MOCK_UNFETCHABLE=1 simulates a network failure.
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
url="${*: -1}"
if [ "${MOCK_UNFETCHABLE:-0}" = 1 ]; then printf '\n000\n'; exit 0; fi
iids=$(printf '%s' "$url" | grep -oE 'iids\[\]=[0-9]+' | cut -d= -f2 | paste -sd, -)
if [ -n "$iids" ]; then
  jq -c --arg ids "$iids" '[.[] | select(.iid as $i | ($ids | split(",") | map(tonumber)) | index($i))]' "$MOCK_DB"
else
  labels=$(printf '%s' "$url" | grep -oE 'labels=[^&]+' | cut -d= -f2)
  page=$(printf '%s' "$url" | grep -oE '&page=[0-9]+' | cut -d= -f2)
  if [ "${page:-1}" != 1 ]; then echo '[]'; else
    jq -c --arg l "$labels" '[.[] | select(.state == "opened") | select(.labels as $have | ($l | split(",")) | all(. as $w | $have | index($w)))]' "$MOCK_DB"
  fi
fi
printf '200 \n'
CURLMOCK
  chmod +x "$tmp/bin/curl"
  export PATH="$tmp/bin:$PATH"
  export CI_PROJECT_ID="1"
  export GITLAB_ISSUES_SLEEP_OVERRIDE=0
  export MOCK_DB="$tmp/db.json"

  u() { printf '[#%s](https://gitlab.com/trueppm/trueppm/-/issues/%s)' "$1" "$1"; }
  # issue <iid> <state> <title> <label,...>
  issue() { jq -nc --argjson i "$1" --arg s "$2" --arg t "$3" --arg l "$4" \
    '{iid:$i,state:$s,title:$t,milestone:{title:"0.5"},labels:($l|split(","))}'; }
  mkdb() { jq -s . >"$MOCK_DB"; }
  mkreadme() { # mkreadme <ids in limitations> <ids in not-committed>
    {
      printf 'Intro prose mentioning %s outside the section.\n\n' "$(u 999)"
      printf '**Known limitations open against 0.4**, grouped by area:\n\n- **CPM**'
      for i in $1; do printf ' — %s' "$(u "$i")"; done
      printf '\n\nMay also land in 0.5, but not committed: '
      for i in $2; do printf '%s, ' "$(u "$i")"; done
      printf 'and nothing else.\n\n**Later — a sequence.**\n'
    } >"$tmp/README.md"
  }
  expect() { # expect <pass|fail> <message>
    local want="$1" msg="$2" rc=0
    bash "$0" "$tmp/README.md" >"$tmp/out.txt" 2>&1 || rc=$?
    if { [ "$want" = pass ] && [ "$rc" -ne 0 ]; } || { [ "$want" = fail ] && [ "$rc" -ne 1 ]; }; then
      echo "SELF-TEST FAILED: ${msg} (exit ${rc})" >&2
      cat "$tmp/out.txt" >&2
      exit 1
    fi
    echo "SELF-TEST OK: ${msg}"
  }

  { issue 10 opened "fix(scheduler): a defect" scheduler,correctness,release::committed
    issue 11 opened "fix(scheduler): a reserve defect" scheduler,correctness,release::reserve
    issue 12 opened "test(scheduler): a property test" scheduler,correctness,release::committed
    issue 13 opened "scheduler: a bare-title decision" scheduler,correctness
    issue 14 closed "fix(scheduler): already fixed" scheduler,correctness
    issue 999 opened "unrelated" scheduler; } | mkdb

  mkreadme "10 13" "11"
  expect pass "a synced section passes (typed test() issue exempt, reserve issue allowed in the not-committed list)"

  mkreadme "10" "11"
  expect fail "an open fix() scheduler+correctness issue missing from the section is rejected (rule b)"
  mkreadme "10 13" "11"
  mkreadme "13" "11"
  expect fail "a missing committed fix() issue is rejected even when others are present (rule b)"

  mkreadme "10 13" "10 11"
  expect fail "a release::committed issue listed as 'not committed' is rejected (rule a)"

  mkreadme "10 13 14" "11"
  expect fail "a closed issue left in the section is rejected (rule c)"

  mkreadme "10 13" "11"
  { issue 10 opened "fix(scheduler): a defect" scheduler,correctness,release::committed
    issue 11 opened "fix(scheduler): a reserve defect" scheduler,correctness,release::reserve
    issue 13 opened "scheduler: a bare-title decision" scheduler,correctness
    issue 15 opened "test(scheduler): a new test" scheduler,correctness
    issue 16 opened "feat(api): a feature" scheduler,correctness
    issue 999 opened "unrelated" scheduler; } | mkdb
  expect pass "new test()/feat() correctness issues do not need a README entry"

  { issue 10 opened "fix(scheduler): a defect" scheduler,correctness,release::committed
    issue 11 opened "fix(scheduler): a reserve defect" scheduler,correctness,release::reserve
    issue 13 opened "scheduler: a bare-title decision" scheduler,correctness
    issue 17 opened "fix(scheduler): not scheduler-labeled correctness" correctness
    issue 999 opened "unrelated" scheduler; } | mkdb
  expect pass "a correctness issue without the scheduler label is out of scope"

  printf 'no section here\n' >"$tmp/README.md"
  expect fail "a README with no Known limitations section is rejected"

  mkreadme "10 13" "11"
  if MOCK_UNFETCHABLE=1 bash "$0" "$tmp/README.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an unreadable tracker was silently accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an unreadable tracker fails closed by default."
  if ! MOCK_UNFETCHABLE=1 SCHEDULER_README_ALLOW_UNRESOLVED=1 bash "$0" "$tmp/README.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: SCHEDULER_README_ALLOW_UNRESOLVED=1 did not opt out." >&2
    exit 1
  fi
  echo "SELF-TEST OK: SCHEDULER_README_ALLOW_UNRESOLVED=1 opts out of an unreadable tracker."

  echo "ALL SELF-TESTS PASSED"
  exit 0
fi

README="${1:-$README_DEFAULT}"
if [ ! -f "$README" ]; then
  echo "ERROR: README not found: $README" >&2
  exit 2
fi
PROJECT="${CI_PROJECT_ID:-}"
if [ -z "$PROJECT" ]; then
  echo "ERROR: CI_PROJECT_ID is not set. This script is intended to run in CI." >&2
  exit 2
fi

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
# shellcheck source-path=SCRIPTDIR source=lib/gitlab-issues.sh
. "$(dirname "$0")/lib/gitlab-issues.sh"
# No JOB-TOKEN fallback: it cannot authenticate against this endpoint (#3043).
TOKEN="${SCHEDULER_README_TOKEN:-${ISSUES_API_TOKEN:-}}"
ALLOW_UNRESOLVED="${SCHEDULER_README_ALLOW_UNRESOLVED:-0}"
export GITLAB_ISSUES_WITH_PLAN=1

# Section = START line up to (not including) END line; the "not committed"
# paragraph = its first line through the next blank line.
section=$(awk -v s="$START_RE" -v e="$END_RE" '$0 ~ s {on=1} $0 ~ e {on=0} on' "$README")
if [ -z "$section" ]; then
  echo "ERROR: $README has no '**Known limitations open against' section (or no '**Later' terminator) — gate cannot run." >&2
  exit 1
fi
nc_para=$(printf '%s\n' "$section" | awk -v n="$NC_RE" '$0 ~ n {on=1} on && /^$/ {exit} on')

refs() { grep -oE "$ISSUE_URL_RE" | grep -oE '[0-9]+$' | sort -un || true; }
section_ids=$(printf '%s\n' "$section" | refs)
nc_ids=$(printf '%s\n' "$nc_para" | refs)

fail_unreadable() {
  if [ "$ALLOW_UNRESOLVED" = "1" ]; then
    echo "WARN: $1 — SCHEDULER_README_ALLOW_UNRESOLVED=1, skipping." >&2
    exit 0
  fi
  echo "ERROR: $1 — failing closed. Retry the job; this is a tracker-API problem, not a README problem." >&2
  exit 1
}

# shellcheck disable=SC2086
ref_rows=$(gitlab_issue_states "$API" "$PROJECT" "$TOKEN" $section_ids) ||
  fail_unreadable "could not read the issues the README references"
open_rows=$(gitlab_issues_by_label "$API" "$PROJECT" "$TOKEN" "scheduler,correctness" opened) ||
  fail_unreadable "could not list open scheduler+correctness issues"

violations=0
# Row: iid<TAB>state<TAB>title<TAB>milestone<TAB>labels
for id in $nc_ids; do
  labels=$(printf '%s\n' "$ref_rows" | awk -F'\t' -v i="$id" '$1 == i {print $5}')
  case ",$labels," in
    *,release::committed,*)
      echo "ERROR: #$id is listed under 'May also land in 0.5, but not committed' but carries release::committed — move it into the committed list." >&2
      violations=$((violations + 1))
      ;;
  esac
done

for id in $section_ids; do
  state=$(printf '%s\n' "$ref_rows" | awk -F'\t' -v i="$id" '$1 == i {print $2}')
  if [ "$state" = "closed" ]; then
    echo "ERROR: #$id is closed but still listed in the Known limitations section — the section's contract is that nothing in it is fixed; remove it." >&2
    violations=$((violations + 1))
  fi
done

while IFS=$'\t' read -r id _state title _rest; do
  [ -z "$id" ] && continue
  if grep -qE "$EXEMPT_TYPE_RE" <<<"$title"; then continue; fi
  if ! grep -qx "$id" <<<"$section_ids"; then
    echo "ERROR: open scheduler+correctness issue #$id (\"$title\") is not referenced in the README Known limitations section — add it to its area list." >&2
    violations=$((violations + 1))
  fi
done <<<"$open_rows"

if [ "$violations" -gt 0 ]; then
  echo "FAILED: $violations Known-limitations drift violation(s) in $README (#4720)." >&2
  exit 1
fi
echo "OK: $README Known limitations section matches the tracker ($(printf '%s\n' "$section_ids" | grep -c .) references checked)."
