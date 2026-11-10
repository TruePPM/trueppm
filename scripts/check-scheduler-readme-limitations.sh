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
# line up to (not including) the "**Later" line; the "but not (yet) committed"
# paragraph inside it is rule (a)'s subject. Rules:
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
# Which rules block where (#4925). The rules read live tracker state, so run as
# whole-tree checks on every pipeline they turned main — and every open MR — red
# whenever someone filed a scheduler bug (15 of 19 tracker-caused red jobs,
# 2026-10-27..11-10). Each rule is therefore split by cause:
#
#   rule | MR-caused (TRACKER_GATE_MODE=diff: MR, main push,  | tracker-caused (TRACKER_GATE_MODE=drift:
#        | make pre-push — blocks)                             | scripts/tracker-drift-report.sh, nightly)
#   (a)  | the diff ADDS a release::committed issue to the     | an issue already in the paragraph was
#        | "not committed" paragraph                           | relabeled release::committed
#   (b)  | the diff REMOVES an entry whose issue is still an   | a newly filed issue is not listed yet
#        | open scheduler+correctness defect (and the change   |
#        | does not close it)                                  |
#   (c)  | the change CLOSES a listed issue (GitLab's own      | a listed issue was closed outside an MR
#        | closes_issues set) and keeps its entry, or the diff |
#        | ADDS an entry for an already-closed issue           |
#
# "The change closes" is tracker_gate_closing_ids in scripts/lib/gitlab-issues.sh:
# GET /merge_requests/:iid/closes_issues on an MR pipeline (it sees commit-message
# keywords and negated matches a description regex misses, #4883), the branch's
# commit messages under pre-push. The structural checks (section and paragraph
# present) are tree-only and run in both modes.
#
# Exit codes:
#   0  no violations
#   1  a rule failed
#   2  invocation / setup error (README missing, CI_PROJECT_ID unset)
#   3  (default) the tracker or the diff base could not be read — fail closed
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
START_RE='^[*][*]Known limitations open against'
END_RE='^[*][*]Later'
NC_RE='^May also land in .*but not (yet )?committed'
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
  if [ "${MOCK_BIGPAGE:-0}" = 1 ]; then
    # Page 1 is a full page of exempt filler; the real issues sit on page 2.
    if [ "${page:-1}" = 1 ]; then
      jq -nc '[range(1000;1100) | {iid:., state:"opened", title:"test(scheduler): filler", milestone:null, labels:["scheduler","correctness"]}]'
    else
      jq -c --arg l "$labels" '[.[] | select(.state == "opened") | select(.labels as $have | ($l | split(",")) | all(. as $w | $have | index($w)))]' "$MOCK_DB"
    fi
  elif [ "${page:-1}" != 1 ]; then echo '[]'; else
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
  # The legacy cases below are full-state assertions — drift mode. The diff-mode
  # cases (#4925) set TRACKER_GATE_MODE=diff per call.
  export TRACKER_GATE_MODE=drift
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

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
      printf '\n\nMay also land in 0.5, but not yet committed: '
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

  { issue 10 opened "fix(scheduler): a defect" scheduler,correctness,release::committed
    issue 11 opened "fix(scheduler): a reserve defect" scheduler,correctness,release::reserve
    issue 13 opened "scheduler: a bare-title decision" scheduler,correctness
    issue 18 opened "fix(scheduler): found only on page 2" scheduler,correctness
    issue 999 opened "unrelated" scheduler; } | mkdb
  mkreadme "10 13" "11"
  rc=0
  MOCK_BIGPAGE=1 bash "$0" "$tmp/README.md" >"$tmp/out.txt" 2>&1 || rc=$?
  if [ "$rc" -ne 1 ] || ! grep -q '#18' "$tmp/out.txt"; then
    echo "SELF-TEST FAILED: an issue on page 2 of the label listing was not seen (exit ${rc})." >&2
    cat "$tmp/out.txt" >&2
    exit 1
  fi
  echo "SELF-TEST OK: the label listing pages past the first 100 issues."

  # ---- diff mode (#4925): fail only for what the change causes. $tmp is a git
  # repo; the committed README is the merge base, the working copy is the change.
  git -C "$tmp" init -q
  git_base() { # commit the current README as the base, export its sha
    git -C "$tmp" add README.md
    git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm base --allow-empty
    TRACKER_GATE_BASE=$(git -C "$tmp" rev-parse HEAD)
    export TRACKER_GATE_BASE
  }
  dexpect() { # dexpect <pass|fail> <closes> <message> [grep]
    local want="$1" closes="$2" msg="$3" pat="${4:-}" rc=0
    (cd "$tmp" && TRACKER_GATE_MODE=diff TRACKER_GATE_CLOSES="$closes" bash "$SELF" "$tmp/README.md") >"$tmp/out.txt" 2>&1 || rc=$?
    if { [ "$want" = pass ] && [ "$rc" -ne 0 ]; } || { [ "$want" = fail ] && [ "$rc" -ne 1 ]; } ||
      { [ -n "$pat" ] && ! grep -q "$pat" "$tmp/out.txt"; }; then
      echo "SELF-TEST FAILED: [diff] ${msg} (exit ${rc})" >&2
      cat "$tmp/out.txt" >&2
      exit 1
    fi
    echo "SELF-TEST OK: [diff] ${msg}"
  }
  { issue 10 opened "fix(scheduler): a defect" scheduler,correctness,release::committed
    issue 11 opened "fix(scheduler): a reserve defect" scheduler,correctness,release::reserve
    issue 13 opened "scheduler: a bare-title decision" scheduler,correctness
    issue 14 closed "fix(scheduler): closed from the UI" scheduler,correctness
    issue 20 opened "fix(scheduler): filed today" scheduler,correctness
    issue 999 opened "unrelated" scheduler; } | mkdb
  mkreadme "10 13 14" "11"
  git_base
  dexpect pass "" "a newly filed fix() issue and an issue closed from the UI fail no MR (tracker-caused)"
  expect fail "the same tree in drift mode reports both (the nightly report sees them)"
  grep -q '#20' "$tmp/out.txt" && grep -q '#14 is closed' "$tmp/out.txt" ||
    { echo "SELF-TEST FAILED: drift mode did not name #20 and #14." >&2; cat "$tmp/out.txt" >&2; exit 1; }
  echo "SELF-TEST OK: drift mode names the unlisted #20 and the closed #14"
  if ! (cd "$tmp" && MOCK_UNFETCHABLE=1 TRACKER_GATE_MODE=diff TRACKER_GATE_CLOSES="" bash "$SELF" "$tmp/README.md") >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: [diff] an unchanged README needed the tracker." >&2; exit 1
  fi
  echo "SELF-TEST OK: [diff] an unchanged README needs no tracker call"
  dexpect fail "13" "a change that closes a listed issue but keeps its entry fails before merge" '#13 is closed by this change'
  mkreadme "10 14" "11"
  dexpect pass "13" "a change that closes a listed issue and drops its entry passes while the issue is still open"
  mkreadme "13 14" "11"
  dexpect fail "" "a change that removes an open required entry without closing it fails (rule b)" 'removes #10'
  mkreadme "10 13 14 20" "11"
  dexpect pass "" "a change that adds today's open issue #20 passes"
  mkreadme "10 13 14" "11 10"
  dexpect fail "" "a change that adds a release::committed issue to 'not committed' fails (rule a)" '#10 is listed under'
  mkreadme "10 13 14" "11"
  git_base
  mkreadme "10 13 14 15" "11"
  { issue 10 opened "fix(scheduler): a defect" scheduler,correctness,release::committed
    issue 11 opened "fix(scheduler): a reserve defect" scheduler,correctness,release::committed
    issue 13 opened "scheduler: a bare-title decision" scheduler,correctness
    issue 14 closed "fix(scheduler): closed from the UI" scheduler,correctness
    issue 15 closed "fix(scheduler): already closed" scheduler,correctness
    issue 999 opened "unrelated" scheduler; } | mkdb
  dexpect fail "" "a change that adds an entry for an already-closed issue fails (rule c)" '#15 is closed and this change adds it'
  mkreadme "10 13 14" "11"
  dexpect pass "" "#11 relabeled release::committed while already in 'not committed' fails no MR (tracker-caused rule a)"
  mkreadme "10 13 14 15" "11"
  if (cd "$tmp" && MOCK_UNFETCHABLE=1 TRACKER_GATE_MODE=diff TRACKER_GATE_CLOSES="" bash "$SELF" "$tmp/README.md") >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: [diff] an unreadable tracker was accepted when the change adds a reference." >&2; exit 1
  fi
  echo "SELF-TEST OK: [diff] an unreadable tracker fails closed when the change adds a reference"
  unset TRACKER_GATE_BASE

  # An unlabeled (no release::) issue in the not-committed list is not a rule (a) violation.
  { issue 10 opened "fix(scheduler): a defect" scheduler,correctness,release::committed
    issue 19 opened "fix(scheduler): untriaged" scheduler,correctness
    issue 999 opened "unrelated" scheduler; } | mkdb
  mkreadme "10" "19"
  expect pass "an unlabeled issue under 'not yet committed' passes"

  printf 'no section here\n' >"$tmp/README.md"
  expect fail "a README with no Known limitations section is rejected"

  mkreadme "10 11 13" "11"
  sed 's/^May also land.*$/Reworded paragraph./' "$tmp/README.md" >"$tmp/README.reworded.md"
  mv "$tmp/README.reworded.md" "$tmp/README.md"
  bash "$0" "$tmp/README.md" >"$tmp/out.txt" 2>&1 || true
  if ! grep -q "rule (a) would check nothing" "$tmp/out.txt"; then
    echo "SELF-TEST FAILED: a missing 'not (yet) committed' paragraph was not rejected for that reason." >&2
    cat "$tmp/out.txt" >&2
    exit 1
  fi
  echo "SELF-TEST OK: a README without the 'not (yet) committed' paragraph is rejected (rule a cannot pass vacuously)"

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

if [ -z "$nc_para" ]; then
  # Without this, a missing or reworded paragraph leaves rule (a) with nothing
  # to check and the gate passes vacuously.
  echo "ERROR: $README has no 'May also land in 0.5, but not (yet) committed' paragraph — rule (a) would check nothing." >&2
  exit 1
fi

refs() { grep -oE "$ISSUE_URL_RE" | grep -oE '[0-9]+$' | sort -un || true; }
section_of() { awk -v s="$START_RE" -v e="$END_RE" '$0 ~ s {on=1} $0 ~ e {on=0} on'; }
nc_of() { awk -v n="$NC_RE" '$0 ~ n {on=1} on && /^$/ {exit} on'; }
section_ids=$(printf '%s\n' "$section" | refs)
nc_ids=$(printf '%s\n' "$nc_para" | refs)

fail_unreadable() {
  if [ "$ALLOW_UNRESOLVED" = "1" ]; then
    echo "WARN: $1 — SCHEDULER_README_ALLOW_UNRESOLVED=1, skipping." >&2
    exit 0
  fi
  echo "ERROR: $1 — failing closed. Retry the job; this is a tracker-API problem, not a README problem." >&2
  exit "$TRACKER_UNREADABLE_EXIT"
}

MODE=$(tracker_gate_mode) || exit 2
violations=0

# labels_of / state_of / title_of <id> read the `iid state title milestone labels` rows.
col_of() { printf '%s\n' "$ref_rows" | awk -F'\t' -v i="$1" -v c="$2" '$1 == i {print $c; exit}'; }
is_required() { # an open scheduler+correctness defect (rule b's population)
  local labels title
  [ "$(col_of "$1" 2)" = opened ] || return 1
  labels=",$(col_of "$1" 5),"
  title=$(col_of "$1" 3)
  [[ "$labels" == *,scheduler,* && "$labels" == *,correctness,* ]] || return 1
  ! grep -qE "$EXEMPT_TYPE_RE" <<<"$title"
}
report_a() { echo "ERROR: #$1 is listed under 'May also land in 0.5, but not committed' but carries release::committed — move it into the committed list." >&2; violations=$((violations + 1)); }
report_c() { echo "ERROR: #$1 is closed${2:+ $2} but still listed in the Known limitations section — the section's contract is that nothing in it is fixed; remove it." >&2; violations=$((violations + 1)); }

if [ "$MODE" = drift ]; then
  # Full-state check against the tracker as it is now (nightly report).
  # shellcheck disable=SC2086
  ref_rows=$(gitlab_issue_states "$API" "$PROJECT" "$TOKEN" $section_ids) ||
    fail_unreadable "could not read the issues the README references"
  open_rows=$(gitlab_issues_by_label "$API" "$PROJECT" "$TOKEN" "scheduler,correctness" opened) ||
    fail_unreadable "could not list open scheduler+correctness issues"
  for id in $nc_ids; do
    case ",$(col_of "$id" 5)," in *,release::committed,*) report_a "$id" ;; esac
  done
  for id in $section_ids; do
    [ "$(col_of "$id" 2)" = closed ] && report_c "$id"
  done
  while IFS=$'\t' read -r id _state title _rest; do
    [ -z "$id" ] && continue
    if grep -qE "$EXEMPT_TYPE_RE" <<<"$title"; then continue; fi
    if ! tracker_gate_has "$id" "$section_ids"; then
      echo "ERROR: open scheduler+correctness issue #$id (\"$title\") is not referenced in the README Known limitations section — add it to its area list." >&2
      violations=$((violations + 1))
    fi
  done <<<"$open_rows"
else
  # Only what this change causes; tracker drift goes to the nightly report.
  base=$(tracker_gate_base) || fail_unreadable "could not resolve the diff base"
  closing=$(tracker_gate_closing_ids "$API" "$PROJECT" "$TOKEN" "$base") ||
    fail_unreadable "could not read the issues this change closes"
  base_section=$(tracker_gate_file_at_base "$base" "$README" | section_of)
  base_section_ids=$(printf '%s\n' "$base_section" | refs)
  base_nc_ids=$(printf '%s\n' "$base_section" | nc_of | refs)
  new_section=$(tracker_gate_minus "$section_ids" "$base_section_ids")
  new_nc=$(tracker_gate_minus "$nc_ids" "$base_nc_ids")
  removed=$(tracker_gate_minus "$(tracker_gate_minus "$base_section_ids" "$section_ids")" "$closing")
  lookup=$(printf '%s\n' $new_section $new_nc $removed | grep . | sort -un || true)
  ref_rows=""
  if [ -n "$lookup" ]; then
    # shellcheck disable=SC2086
    ref_rows=$(gitlab_issue_states "$API" "$PROJECT" "$TOKEN" $lookup) ||
      fail_unreadable "could not read the issues this change adds or removes"
  fi
  for id in $new_nc; do
    case ",$(col_of "$id" 5)," in *,release::committed,*) report_a "$id" ;; esac
  done
  for id in $section_ids; do
    if tracker_gate_has "$id" "$closing"; then
      report_c "$id" "by this change (closes_issues)"
    elif tracker_gate_has "$id" "$new_section" && [ "$(col_of "$id" 2)" = closed ]; then
      report_c "$id" "and this change adds it"
    fi
  done
  for id in $removed; do
    if is_required "$id"; then
      echo "ERROR: this change removes #$id (\"$(col_of "$id" 3)\") from the README Known limitations section, but it is still an open scheduler+correctness defect and the change does not close it — keep the entry." >&2
      violations=$((violations + 1))
    fi
  done
  echo "INFO: diff mode (#4925) — checked $(printf '%s\n' $lookup | grep -c . || true) reference(s) this change adds or removes and $(printf '%s\n' $closing | grep -c . || true) issue(s) it closes; drift from tracker edits is reported by tracker:drift-report, not here."
fi

if [ "$violations" -gt 0 ]; then
  echo "FAILED: $violations Known-limitations violation(s) in $README ($MODE mode, #4720/#4925)." >&2
  exit 1
fi
echo "OK: $README Known limitations section ($MODE mode, $(printf '%s\n' "$section_ids" | grep -c . || true) references in the section)."
