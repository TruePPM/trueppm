#!/usr/bin/env bash
# Tests for scripts/lib/gitlab-issues.sh (#4452): batching, 429 retry with
# Retry-After, the expired-token fallback, and fail-closed exhaustion. A fake
# `curl` scripted per call stands in for the tracker and logs every request.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../lib/gitlab-issues.sh
. "$ROOT/scripts/lib/gitlab-issues.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export MOCK_DIR="$tmp"
export GITLAB_ISSUES_SLEEP_OVERRIDE=0

# MOCK_SCRIPT holds one status per line (`200`, `429 7`, `401`, `000`, …),
# consumed one per call; the last line repeats. Every call appends its args to
# $MOCK_DIR/calls. A 200 answers with one opened issue per requested iid.
cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
# One line per call: the -w format itself carries a newline.
{ printf '%s' "$*" | tr '\n' ' '; echo; } >>"$MOCK_DIR/calls"
n=$(wc -l <"$MOCK_DIR/calls" | tr -d ' ')
status=$(sed -n "${n}p" "$MOCK_DIR/script")
[ -z "$status" ] && status=$(tail -n1 "$MOCK_DIR/script")
code="${status%% *}"
retry=""
[ "$code" != "$status" ] && retry="${status#* }"
if [ "${MOCK_REJECT_TOKEN:-}" = 1 ] && grep -q 'PRIVATE-TOKEN' <<<"$*"; then
  code=401
  retry=""
fi
url="${*: -1}"
if [ "$code" = 200 ] && [[ "$url" == *closes_issues* ]]; then
  printf '%s' "${MOCK_CLOSES:-[]}"
elif [ "$code" = 200 ]; then
  printf '%s' "$url" | grep -oE 'iids\[\]=[0-9]+' | cut -d= -f2 |
    jq -R 'tonumber | {iid: ., state: "opened", title: "t\tab"}' | jq -sc .
else
  printf '{"message":"x"}'
fi
printf '\n%s %s\n' "$code" "$retry"
CURLMOCK
chmod +x "$tmp/bin/curl"
export PATH="$tmp/bin:$PATH"

pass=0
fail() { echo "FAIL: $1" >&2; exit 1; }
ok() { pass=$((pass + 1)); }
reset() { : >"$tmp/calls"; printf '%s\n' "$@" >"$tmp/script"; }
calls() { wc -l <"$tmp/calls" | tr -d ' '; }

# 1. Many iids resolve in ONE request — the whole point of #4452.
reset 200
out=$(gitlab_issue_states https://api 1 "" 10 20 30 40)
[ "$(calls)" = 1 ] || fail "4 iids took $(calls) requests, want 1"
[ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 4 ] || fail "want 4 rows, got: $out"
grep -qx $'30\topened\tt ab' <<<"$out" || fail "row shape wrong (tab in title must not split): $out"
ok

# 2. More than 100 iids page in chunks of 100.
reset 200
gitlab_issue_states https://api 1 "" $(seq 1 150) >/dev/null
[ "$(calls)" = 2 ] || fail "150 iids took $(calls) requests, want 2"
ok

# 3. A 429 is retried and Retry-After is honored (logged as the wait).
reset "429 7" 200
err=$(gitlab_issue_states https://api 1 "" 5 2>&1 >/dev/null) || fail "429 then 200 should succeed"
[ "$(calls)" = 2 ] || fail "429 then 200 took $(calls) requests, want 2"
grep -q 'retrying in 7s' <<<"$err" || fail "Retry-After not honored: $err"
ok

# 4. A Retry-After above the cap is clamped to 60s.
reset "429 900" 200
err=$(gitlab_issue_states https://api 1 "" 5 2>&1 >/dev/null)
grep -q 'retrying in 60s' <<<"$err" || fail "Retry-After not clamped: $err"
ok

# 5. 5xx and network errors are retried too.
reset 503 000 200
gitlab_issue_states https://api 1 "" 5 >/dev/null 2>&1 || fail "503, 000, 200 should succeed"
[ "$(calls)" = 3 ] || fail "want 3 requests, got $(calls)"
ok

# 6. Persistent throttling fails CLOSED after the attempt budget.
reset 429
if gitlab_issue_states https://api 1 "" 5 >/dev/null 2>&1; then fail "endless 429 must fail"; fi
[ "$(calls)" = 5 ] || fail "want 5 attempts, got $(calls)"
ok

# 7. A rejected token falls back to anonymous once, with a warning.
reset 200
err=$(MOCK_REJECT_TOKEN=1 gitlab_issue_states https://api 1 tok 5 2>&1 >/dev/null) || fail "token fallback should succeed"
[ "$(calls)" = 2 ] || fail "want 2 requests, got $(calls)"
grep -q 'PRIVATE-TOKEN: tok' <<<"$(sed -n 1p "$tmp/calls")" || fail "first call did not send the token"
grep -q 'PRIVATE-TOKEN' <<<"$(sed -n 2p "$tmp/calls")" && fail "fallback call still sent the token"
grep -q 'WARN: .*401' <<<"$err" || fail "no warning on token fallback: $err"
ok

# 8. An anonymous 401 (private tracker) and a 404 are errors, not retried.
for code in 401 404; do
  reset "$code"
  if gitlab_issue_states https://api 1 "" 5 >/dev/null 2>&1; then fail "anonymous $code must fail"; fi
  [ "$(calls)" = 1 ] || fail "$code was retried ($(calls) requests)"
done
ok

# 9. Never a JOB-TOKEN header (#3043), and the iids[] brackets are not globbed.
grep -q 'JOB-TOKEN' "$tmp/calls" && fail "a JOB-TOKEN header was sent"
reset 200
gitlab_issue_states https://api 1 "" 5 >/dev/null
grep -q -- '-sg' "$tmp/calls" || fail "curl must run with -g so iids[] is not a URL glob"
ok

# 10. No iids is a no-op, not a request.
reset 200
gitlab_issue_states https://api 1 "" >/dev/null
[ "$(calls)" = 0 ] || fail "empty iid list made a request"
ok

# 11. closes_issues (#4925): an MR pipeline reads GitLab's own closing set,
#     keeps only this project's issues, and fails closed when unreadable.
reset 200
out=$(CI_MERGE_REQUEST_IID=7 MOCK_CLOSES='[{"iid":5,"project_id":1},{"iid":9,"project_id":2},{"iid":3,"project_id":1}]' \
  tracker_gate_closing_ids https://api 1 "" deadbeef)
[ "$out" = $'3\n5' ] || fail "closes_issues not filtered to this project: $out"
grep -q 'merge_requests/7/closes_issues' "$tmp/calls" || fail "closes_issues endpoint not called"
grep -q 'JOB-TOKEN' "$tmp/calls" && fail "a JOB-TOKEN header was sent to closes_issues"
reset 404
rc=0
CI_MERGE_REQUEST_IID=7 tracker_gate_closing_ids https://api 1 "" deadbeef >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "unreadable closes_issues did not fail closed (rc=$rc)"
ok

# 12. Commit-message closing keywords (pre-push, main push): GitLab's default
#     pattern, lists, URLs — and a NEGATED keyword still counts (#4883).
out=$(printf '%s\n' 'fix: x' '' 'Closes #10, #11 and #12' 'Does not fix #4883' \
  'Resolves: https://gitlab.com/trueppm/trueppm/-/issues/77' 'prefix #99 is not a keyword' 'Refs #55' |
  closing_ids_from_text)
[ "$out" = $'10\n11\n12\n77\n4883' ] || fail "closing keyword parse wrong: $(printf '%s' "$out" | tr '\n' ' ')"
out=$(TRACKER_GATE_CLOSES="4 2" tracker_gate_closing_ids https://api 1 "" x)
[ "$out" = $'2\n4' ] || fail "TRACKER_GATE_CLOSES override not honored: $out"
ok

# 13. Mode: diff by default, drift on request, anything else is an error.
[ "$(tracker_gate_mode)" = diff ] || fail "default mode is not diff"
[ "$(TRACKER_GATE_MODE=drift tracker_gate_mode)" = drift ] || fail "drift mode not honored"
TRACKER_GATE_MODE=bogus tracker_gate_mode >/dev/null 2>&1 && fail "a bogus mode was accepted"
ok

echo "gitlab-issues.test.sh: all ${pass} checks passed"
