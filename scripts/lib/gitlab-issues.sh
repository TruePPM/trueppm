# shellcheck shell=bash
#
# Shared issue-state reader for the tracker-reading gates (#4452):
# check-todo-grep.sh, check-known-issues-freshness.sh, check-mr-followups.sh,
# check-suppression-issues.sh, check-scheduler-readme-limitations.sh,
# check-claude-md-stale-issues.sh and tracker-drift-report.sh. Also home of the
# MR-caused vs tracker-caused split those gates share (#4925, below).
#
# Each of them used to issue one GET /issues/:iid per reference, anonymously,
# with no retry. Anonymous calls get GitLab.com's lowest rate limit, keyed per
# IP, and every runner job leaves through one egress IP — so ~40 lookups from
# one gate plus whatever the other jobs were doing hit 429, and fail-closed
# turned each throttle into a red main on whichever issues happened to be last.
# Three things fix the class rather than the instance:
#
#   1. One batched list call (`iids[]=…`, up to 100 per page) instead of N GETs.
#   2. 429 / 5xx / network errors are retried, honoring Retry-After (bounded).
#   3. ISSUES_API_TOKEN (one project access token with read_api) is the shared
#      fallback for the per-script token variables. A 401 with a token falls
#      back to anonymous with a WARN, so an expired token degrades to the old
#      behavior instead of 401-ing every lookup (the #3043 failure shape).
#
# Never send a JOB-TOKEN header here: the Issues API is not a job-token
# endpoint, and any JOB-TOKEN header turns an anonymous 200 into a 401 (#3043).

# gitlab_issue_states <api> <project> <token-or-empty> <iid>...
#
# Prints one `iid<TAB>state<TAB>title` line per issue the tracker returned.
# An iid absent from the output does not exist or is not readable (deleted,
# moved, confidential) — the caller decides what that means.
# With GITLAB_ISSUES_WITH_PLAN=1 two more columns follow the title: the
# milestone title (`-` when none) and the comma-joined labels (#4724).
# Returns 2 when the tracker could not be read after retries; nothing useful
# is printed in that case, so callers must check the status, not the output.
# Returns 3 (GITLAB_TRANSIENT_EXIT) when the only cause was a transient outage
# that outlasted every retry (429 / 5xx / timeout) — a gate may choose to fail
# open on that and only that (#3953); a 401 or other 4xx stays 2.
gitlab_issue_states() {
  local api="$1" project="$2" token="$3"
  shift 3
  local -a iids=("$@") batch
  local i
  [ "${#iids[@]}" -eq 0 ] && return 0
  for ((i = 0; i < ${#iids[@]}; i += 100)); do
    batch=("${iids[@]:i:100}")
    _gitlab_issue_batch "$api" "$project" "$token" "${batch[@]}" || return $?
  done
}

# gitlab_issues_by_label <api> <project> <token-or-empty> <labels> [state]
#
# Prints the same `iid<TAB>state<TAB>title[<TAB>milestone<TAB>labels]` lines as
# gitlab_issue_states, for every issue carrying ALL of the comma-joined
# <labels>, filtered to <state> (opened|closed|all, default opened). Pages
# through the list so a growing label is never silently truncated at 100
# (#4720). Same retry/429/token behavior as the iid lookup; returns 2 when the
# tracker could not be read.
gitlab_issues_by_label() {
  local api="$1" project="$2" token="$3" labels="$4" state="${5:-opened}"
  local page=1 out n
  while :; do
    out=$(GITLAB_ISSUES_QUERY_OVERRIDE="state=${state}&labels=${labels}&page=${page}" \
      _gitlab_issue_batch "$api" "$project" "$token") || return 2
    [ -n "$out" ] && printf '%s\n' "$out"
    n=$(printf '%s' "$out" | grep -c . || true)
    [ "$n" -lt 100 ] && return 0
    page=$((page + 1))
  done
}

# gitlab_json_list <api> <project> <token-or-empty> <path> <query>
#
# Pages through any list endpoint under /projects/<project>/<path> (e.g.
# `milestones`, `issues`) and prints ONE merged JSON array of every row, so a
# caller that needs raw fields (created_at, description, due_date) does not
# re-implement paging or retry (#3444). Same retry/429/token behavior as the
# other readers; returns 2 when the tracker could not be read.
gitlab_json_list() {
  local api="$1" project="$2" token="$3" path="$4" query="$5"
  local page=1 body n acc="[]"
  while :; do
    body=$(_gitlab_get "${api}/projects/${project}/${path}?per_page=100&${query}&page=${page}" "$token") || return 2
    n=$(printf '%s' "$body" | jq 'length') || return 2
    acc=$(jq -c -s '.[0] + .[1]' <(printf '%s' "$acc") <(printf '%s' "$body")) || return 2
    [ "$n" -lt 100 ] && break
    page=$((page + 1))
  done
  printf '%s\n' "$acc"
}

_gitlab_issue_batch() {
  local api="$1" project="$2" token="$3"
  shift 3
  local query="per_page=100&${GITLAB_ISSUES_QUERY_OVERRIDE:-state=all}" iid body
  for iid in "$@"; do query+="&iids[]=${iid}"; done
  body=$(_gitlab_get "${api}/projects/${project}/issues?${query}" "$token") || return $?
  if [ "${GITLAB_ISSUES_WITH_PLAN:-0}" = "1" ]; then
    # Opt-in extra columns after the title: milestone title, comma-joined
    # labels. Off by default so every other caller's `cut -f3-` title read
    # is unchanged.
    printf '%s' "$body" | jq -r '.[] | [(.iid | tostring), .state, (.title | gsub("[\t\n]"; " ")), (.milestone.title // "-"), ((.labels // []) | join(","))] | @tsv'
  else
    printf '%s' "$body" | jq -r '.[] | [(.iid | tostring), .state, (.title | gsub("[\t\n]"; " "))] | @tsv'
  fi
}

# _gitlab_get <url> <token-or-empty>
#
# One GET with the retry / Retry-After / expired-token policy described at the
# top of this file. Prints the response body on HTTP 200; returns 3 when
# 429 / 5xx / network errors outlasted every retry (transient), 2 otherwise.
# The token travels only as a request header and is never echoed.
_gitlab_get() {
  local url="$1" token="$2" resp status code retry_after body
  local attempt=1 max="${GITLAB_ISSUES_MAX_ATTEMPTS:-5}" wait
  local -a auth=()
  [ -n "$token" ] && auth=(--header "PRIVATE-TOKEN: ${token}")

  while :; do
    # -g: the `[]` in iids[] is literal, not a curl URL glob.
    # Status line is `<code> <retry-after>`; %header{} needs curl >= 7.84.
    resp=$(curl -sg -w $'\n%{http_code} %header{retry-after}' \
      "${auth[@]+"${auth[@]}"}" "$url" 2>/dev/null || true)
    status="${resp##*$'\n'}"
    body="${resp%$'\n'*}"
    code="${status%% *}"
    retry_after="${status#* }"
    [ "$retry_after" = "$status" ] && retry_after=""

    case "$code" in
      200)
        printf '%s' "$body"
        return 0
        ;;
      401)
        if [ "${#auth[@]}" -gt 0 ]; then
          echo "WARN: issue lookup rejected the configured token (HTTP 401) — expired or revoked? Retrying anonymously." >&2
          auth=()
          continue
        fi
        echo "ERROR: GitLab issues API returned HTTP 401 anonymously — private tracker? Set ISSUES_API_TOKEN." >&2
        return 2
        ;;
      429 | 5?? | 000 | "") ;;
      *)
        echo "ERROR: GitLab issues API returned HTTP ${code} for ${url}" >&2
        return 2
        ;;
    esac

    if [ "$attempt" -ge "$max" ]; then
      echo "ERROR: GitLab issues API still failing after ${max} attempts (last HTTP ${code:-000})." >&2
      return 3
    fi
    if [[ "$retry_after" =~ ^[0-9]+$ ]]; then
      wait="$retry_after"
    else
      wait=$((2 ** attempt))
    fi
    [ "$wait" -gt 60 ] && wait=60
    echo "WARN: GitLab issues API returned HTTP ${code:-000}; retrying in ${wait}s (attempt ${attempt}/${max})." >&2
    sleep "${GITLAB_ISSUES_SLEEP_OVERRIDE:-$wait}"
    attempt=$((attempt + 1))
  done
}

# ---------------------------------------------------------------------------
# MR-caused vs tracker-caused split (#4925)
#
# The tracker-reading gates used to compare the whole tree against live issue
# state on every MR and main push, so filing or closing an issue turned main —
# and then every open MR — red with no code change (21 of 94 main pushes,
# 2026-10-27..11-10). Each gate now runs in one of two modes:
#
#   diff   (default; MR pipelines, main pushes, `make pre-push`) — fail only for
#          drift THIS change causes: a reference the diff adds to a closed or
#          missing issue, a reference the diff keeps to an issue the change
#          closes, or a required reference the diff removes.
#   drift  (TRACKER_GATE_MODE=drift; only scripts/tracker-drift-report.sh on the
#          nightly schedule) — the full-state check: every
#          reference against the tracker as it is now. Its findings land in one
#          tracking issue, not in a red pipeline nobody's commit can fix.
#
# Unreadable tracker, in either mode, still fails closed (exit 3 by convention).
# ---------------------------------------------------------------------------

# shellcheck disable=SC2034  # read by the gates that source this file
TRACKER_UNREADABLE_EXIT=3

# tracker_gate_mode — prints `diff` or `drift`; returns 2 on a bad value.
tracker_gate_mode() {
  case "${TRACKER_GATE_MODE:-diff}" in
    diff | drift) printf '%s\n' "${TRACKER_GATE_MODE:-diff}" ;;
    *)
      echo "ERROR: TRACKER_GATE_MODE must be 'diff' or 'drift', not '${TRACKER_GATE_MODE}'." >&2
      return 2
      ;;
  esac
}

# tracker_gate_base — prints the commit the change is measured against.
#
# Order: TRACKER_GATE_BASE (tests) → CI_MERGE_REQUEST_DIFF_BASE_SHA (MR
# pipeline) → CI_COMMIT_BEFORE_SHA (main push; all-zero on a new ref is
# skipped) → `git merge-base origin/main HEAD` (pre-push). A base missing from a
# shallow clone is fetched by sha (Gitaly serves any reachable sha). Returns 2
# when no base can be resolved — a diff gate with no base cannot tell what the
# change caused, so the caller fails closed rather than guessing.
tracker_gate_base() {
  local base="${TRACKER_GATE_BASE:-${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}}"
  if [ -z "$base" ] && [ -n "${CI_COMMIT_BEFORE_SHA:-}" ] &&
    [ -n "${CI_COMMIT_BEFORE_SHA//0/}" ]; then
    base="$CI_COMMIT_BEFORE_SHA"
  fi
  if [ -z "$base" ]; then
    base=$(git merge-base origin/main HEAD 2>/dev/null || true)
  fi
  # A non-MR CI pipeline with no before-sha (a schedule, a manual "Run
  # pipeline") carries no change to attribute: diff against HEAD itself.
  if [ -z "$base" ] && [ -n "${CI_PIPELINE_SOURCE:-}" ] &&
    [ "$CI_PIPELINE_SOURCE" != merge_request_event ]; then
    base=$(git rev-parse HEAD 2>/dev/null || true)
  fi
  if [ -z "$base" ]; then
    echo "ERROR: cannot resolve the diff base (no CI_MERGE_REQUEST_DIFF_BASE_SHA, CI_COMMIT_BEFORE_SHA or origin/main)." >&2
    return 2
  fi
  if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
    git fetch --quiet --depth=50 origin "$base" >/dev/null 2>&1 || true
  fi
  if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
    echo "ERROR: diff base ${base} is not in this clone and could not be fetched." >&2
    return 2
  fi
  printf '%s\n' "$base"
}

# tracker_gate_file_at_base <base> <file> — prints <file> as it was at <base>
# (empty when it did not exist). Resolved relative to the file's own directory
# so it works for any repo the file lives in, including self-test fixtures.
tracker_gate_file_at_base() {
  local base="$1" file="$2"
  git -C "$(dirname "$file")" show "${base}:./$(basename "$file")" 2>/dev/null || true
}

# closing_ids_from_text — reads text on stdin, prints the issue numbers a
# GitLab closing keyword would close (default closing pattern: close/fix/
# resolve/implement in any tense, optional colon, then a list of references).
# Deliberately NOT negation-aware: GitLab closes a negated keyword too (#4883),
# so a superset is the faithful answer. Used where no MR exists yet.
#
# Only references to THIS project count — GitLab's closes_issues filters by
# project, so a parser that did not would fail main after a green MR whose
# commit closes another project's issue. A reference is this project's when it
# is a bare `#N`, a `proj#N` / `group/proj#N` naming this project, or an
# `/-/issues/N` or `/-/work_items/N` URL whose path is this project's.
# The project is ${CI_PROJECT_PATH}, falling back to trueppm/trueppm (the
# default the gates already use for CI_PROJECT_ID). Paths compare
# case-insensitively, as GitLab routes them.
closing_ids_from_text() {
  local kw='(clos(e|es|ed|ing)|fix(es|ed|ing)?|resolv(e|es|ed|ing)|implement(s|ed|ing)?)'
  local url='https?://[^[:space:],]*/-/(issues|work_items)/[0-9]+'
  local ref="(${url}|[[:alnum:]_./-]*#[0-9]+)"
  local proj="${CI_PROJECT_PATH:-trueppm/trueppm}"
  grep -oiE "(^|[^[:alnum:]_])${kw}:? +(issues? +)?${ref}(( *, *| +and +| *, +and +)${ref})*" |
    grep -oE "${url}|[[:alnum:]_./-]*#[0-9]+" |
    awk -v p="$proj" '
      BEGIN { p = tolower(p); leaf = p; sub(/.*\//, "", leaf) }
      /^https?:\/\// {
        r = $0; n = $0
        sub(/^https?:\/\/[^\/]+\//, "", r)
        sub(/\/-\/(issues|work_items)\/[0-9]+$/, "", r)
        sub(/.*\//, "", n)
        if (tolower(r) == p) print n
        next
      }
      {
        i = index($0, "#"); pre = tolower(substr($0, 1, i - 1)); n = substr($0, i + 1)
        if (pre == "" || pre == p || pre == leaf) print n
      }' | sort -un || true
}

# tracker_gate_closing_ids <api> <project> <token> <base>
#
# Prints the iids this change will close when it merges, one per line.
#   - TRACKER_GATE_CLOSES set (even empty): used verbatim (self-tests).
#   - In an MR pipeline (CI_MERGE_REQUEST_IID): GitLab's own
#     GET /merge_requests/:iid/closes_issues — the authoritative set, covering
#     the description AND commit messages AND negated matches. Same token
#     policy as the issue reads; the job token is never sent (#3043).
#   - Otherwise (pre-push, main push): closing keywords in the commit messages
#     of <base>..HEAD.
# Returns 2 when the MR endpoint cannot be read, 3 when it was a transient
# outage that outlasted the retries (see gitlab_issue_states); the caller
# decides whether to fail closed.
tracker_gate_closing_ids() {
  local api="$1" project="$2" token="$3" base="$4" body
  if [ -n "${TRACKER_GATE_CLOSES+x}" ]; then
    printf '%s\n' $TRACKER_GATE_CLOSES | grep -E '^[0-9]+$' | sort -un || true
    return 0
  fi
  if [ -n "${CI_MERGE_REQUEST_IID:-}" ]; then
    body=$(_gitlab_get "${api}/projects/${project}/merge_requests/${CI_MERGE_REQUEST_IID}/closes_issues?per_page=100" "$token") || {
      local rc=$?
      echo "ERROR: could not read this MR's closes_issues from the GitLab API." >&2
      return "$rc"
    }
    # Only issues in THIS project: a cross-project close cannot stale a local #N.
    printf '%s' "$body" | jq -r --arg p "$project" \
      '.[] | select(($p | test("^[0-9]+$") | not) or ((.project_id | tostring) == $p)) | .iid' |
      sort -un
    return 0
  fi
  git log --format=%B "${base}..HEAD" 2>/dev/null | closing_ids_from_text
}

# tracker_gate_has <id> <newline-list> — 0 when <id> is in the list.
tracker_gate_has() {
  grep -qx "$1" <<<"$2"
}

# tracker_gate_minus <list-a> <list-b> — ids in a, not in b (one per line).
tracker_gate_minus() {
  local id
  for id in $1; do
    tracker_gate_has "$id" "$2" || printf '%s\n' "$id"
  done
}
