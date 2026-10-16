# shellcheck shell=bash
#
# Shared issue-state reader for the tracker-reading gates (#4452):
# check-todo-grep.sh, check-known-issues-freshness.sh, check-mr-followups.sh and
# check-suppression-issues.sh.
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
# Returns 2 when the tracker could not be read after retries; nothing useful
# is printed in that case, so callers must check the status, not the output.
gitlab_issue_states() {
  local api="$1" project="$2" token="$3"
  shift 3
  local -a iids=("$@") batch
  local i
  [ "${#iids[@]}" -eq 0 ] && return 0
  for ((i = 0; i < ${#iids[@]}; i += 100)); do
    batch=("${iids[@]:i:100}")
    _gitlab_issue_batch "$api" "$project" "$token" "${batch[@]}" || return 2
  done
}

_gitlab_issue_batch() {
  local api="$1" project="$2" token="$3"
  shift 3
  local query="per_page=100&state=all" iid url resp status code retry_after body
  local attempt=1 max="${GITLAB_ISSUES_MAX_ATTEMPTS:-5}" wait
  local -a auth=()
  for iid in "$@"; do query+="&iids[]=${iid}"; done
  url="${api}/projects/${project}/issues?${query}"
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
        printf '%s' "$body" | jq -r '.[] | [(.iid | tostring), .state, (.title | gsub("[\t\n]"; " "))] | @tsv'
        return
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
      return 2
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
