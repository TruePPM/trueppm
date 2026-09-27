#!/usr/bin/env bash
# scripts/check-mr-followups.sh — an MR that admits a follow-up must name the issue
# that tracks it, and that issue must be open.
#
# Why this exists (#4159). A post-merge audit on 2026-09-26 of the twenty most
# recently merged MRs found three that said, in their own description, that part of
# the issue was left for "a follow-up" — and no follow-up issue existed for any of
# them (#4153's demo sign-in copy, #4145's MS Project confirmation, #4080's step 5).
# The sentence reads as a plan. With no issue behind it, it is the only record the
# work was owed, and it disappears the moment the MR merges.
#
# The rule: every line of the MR description that says follow-up / deferred / left
# open / out of scope / not yet fixed must carry an issue reference (`#NNN`, or a
# cross-project `group/project#NNN`), and at least one same-project reference on that
# line must be an OPEN issue that this MR does not itself close. Pointing the
# follow-up at the issue being closed is the same hole with extra steps.
#
# Opt-out, per line: `followup-ok` anywhere on the line (e.g. inside an HTML
# comment) for a line that uses the words without owing anything — "deferred
# broadcast via transaction.on_commit()" is not a promise. Like every opt-out in
# this repo it is a rubber stamp; what it removes is the silence.
#
# Code is not scanned: fenced blocks and `inline code` are stripped first.
#
# Input, first that applies:
#   --file <path>                 a description in a local file (hand runs, self-test)
#   GitLab API, CI_MERGE_REQUEST_IID + CI_PROJECT_ID set
#                                 fetched at job time, so editing the description and
#                                 retrying the job re-checks the new text (the
#                                 predefined variable is frozen at pipeline creation)
#   CI_MERGE_REQUEST_DESCRIPTION  fallback when the API read fails
#
# Issue state is read from the public tracker with no auth header, exactly as
# scripts/check-todo-grep.sh does and for the same reason (#3043); MR_FOLLOWUPS_TOKEN
# (read_api) is only for a private fork. An unresolvable lookup fails the job;
# MR_FOLLOWUPS_ALLOW_UNRESOLVED=1 is the explicit escape hatch.
#
# Usage:  scripts/check-mr-followups.sh [--file <path>] | --self-test
# Exit:   0 clean or not an MR pipeline · 1 an untracked follow-up · 2 usage/fetch error
set -euo pipefail

TRIGGER_RE='follow[- ]?ups?|deferr(ed|ing)|defer(s)? (to|until)|left open|out of (this|the) (mr|issue|change)'"'"'s scope|out of scope (for|of|in) (this|the) (mr|issue|change)|not (yet )?(fixed|addressed|covered|done)|tracked (separately|later)|punt(ed|ing)?'

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
auth_args=()
if [ -n "${MR_FOLLOWUPS_TOKEN:-}" ]; then
  auth_args=(--header "PRIVATE-TOKEN: ${MR_FOLLOWUPS_TOKEN}")
fi

# Strip fenced code blocks and inline code spans; everything else is prose.
# shellcheck disable=SC2016  # the backticks are literal, not an expansion
prose() {
  awk 'BEGIN{f=0} /^[[:space:]]*(```|~~~)/{f=!f; next} !f{print}' |
    sed -E 's/`[^`]*`//g'
}

# issue_state <iid> -> prints opened|closed|missing, or returns 2 when unresolvable
issue_state() {
  local resp code body
  resp="$(curl -s -w $'\n%{http_code}' "${auth_args[@]+"${auth_args[@]}"}" \
    "${API}/projects/${CI_PROJECT_ID}/issues/$1" || true)"
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  case "$code" in
    200) printf '%s' "$body" | jq -r '.state // "unknown"' ;;
    404) echo missing ;;
    *) return 2 ;;
  esac
}

check_text() {
  local text="$1" closing line refs local_refs ok n fails=0 state
  closing="$(grep -oiE '^[[:space:]]*(closes|fixes|resolves)[[:space:]]+#[0-9]+' <<<"$text" |
    grep -oE '[0-9]+' | sort -u || true)"
  while IFS= read -r line; do
    grep -qiE "$TRIGGER_RE" <<<"$line" || continue
    grep -q 'followup-ok' <<<"$line" && continue
    refs="$(grep -oE '([A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+|[A-Za-z0-9_-]+)?#[0-9]+' <<<"$line" || true)"
    if [ -z "$refs" ]; then
      echo "UNTRACKED: ${line}" >&2
      fails=$((fails + 1))
      continue
    fi
    # A cross-project reference (trueppm-enterprise#45) is tracked somewhere this job
    # cannot read; accept it as the tracking reference.
    if grep -qE '[A-Za-z0-9_-]#[0-9]+' <<<"$refs"; then
      continue
    fi
    local_refs="$(grep -oE '[0-9]+' <<<"$refs" | sort -u)"
    ok=0
    for n in $local_refs; do
      if grep -qx "$n" <<<"$closing"; then
        continue
      fi
      if [ -z "${CI_PROJECT_ID:-}" ]; then
        ok=1 # no tracker to ask (hand run): a reference is the best we can check
        break
      fi
      if ! state="$(issue_state "$n")"; then
        if [ "${MR_FOLLOWUPS_ALLOW_UNRESOLVED:-}" = "1" ]; then
          ok=1
          break
        fi
        echo "ERROR: could not resolve #${n} against the tracker (set MR_FOLLOWUPS_ALLOW_UNRESOLVED=1 to override)" >&2
        return 2
      fi
      if [ "$state" = "opened" ]; then
        ok=1
        break
      fi
    done
    if [ "$ok" -ne 1 ]; then
      echo "UNTRACKED (no open issue other than one this MR closes): ${line}" >&2
      fails=$((fails + 1))
    fi
  done < <(prose <<<"$text")
  if [ "$fails" -gt 0 ]; then
    echo "FAIL: ${fails} follow-up line(s) with no open tracking issue (#4159)." >&2
    echo "      File the issue and reference it on the same line, or mark a line that owes nothing with 'followup-ok'." >&2
    return 1
  fi
  echo "OK: every follow-up the MR description names has an open issue."
}

fetch_description() {
  local resp code
  if [ -n "${CI_MERGE_REQUEST_IID:-}" ] && [ -n "${CI_PROJECT_ID:-}" ]; then
    resp="$(curl -s -w $'\n%{http_code}' "${auth_args[@]+"${auth_args[@]}"}" \
      "${API}/projects/${CI_PROJECT_ID}/merge_requests/${CI_MERGE_REQUEST_IID}" || true)"
    code="${resp##*$'\n'}"
    if [ "$code" = "200" ]; then
      printf '%s' "${resp%$'\n'*}" | jq -r '.description // ""'
      return 0
    fi
  fi
  if [ -n "${CI_MERGE_REQUEST_DESCRIPTION+x}" ]; then
    printf '%s' "$CI_MERGE_REQUEST_DESCRIPTION"
    return 0
  fi
  return 3
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/bin"
  # Fake tracker: #100 open, #200 closed, #300 missing, anything else unreachable.
  cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  */issues/100) printf '{"state":"opened"}\n200' ;;
  */issues/200) printf '{"state":"closed"}\n200' ;;
  */issues/300) printf '{"message":"404 Not found"}\n404' ;;
  *) printf '\n000' ;;
esac
CURLMOCK
  chmod +x "$tmp/bin/curl"
  st_fail() { echo "self-test FAIL: $1" >&2; exit 1; }
  run() { PATH="$tmp/bin:$PATH" CI_PROJECT_ID=1 check_text "$1" >/dev/null 2>&1; }
  expect_pass() { run "$2" || st_fail "$1 was rejected"; }
  expect_fail() { if run "$2"; then st_fail "$1 passed"; fi; }

  expect_pass "no follow-up language" $'## Summary\n- Fixes the thing.\n\nCloses #200'
  expect_pass "follow-up with an open issue" $'- Demo copy is a follow-up: #100'
  expect_fail "follow-up with no reference" $'- A demo-specific message would be a small follow-up.'
  expect_fail "deferred to a closed issue" $'- The MSP confirmation is deferred to #200.'
  expect_fail "deferred to a missing issue" $'- Deferred: see #300.'
  expect_fail "follow-up pointing at the issue this MR closes" $'- Rest is a follow-up in #100.\n\nCloses #100'
  expect_pass "cross-project reference" $'- Rate cards are out of scope for this MR (trueppm-enterprise#45).'
  expect_fail "out of scope for this MR, untracked" $'- The mobile view is out of scope for this MR.'
  expect_pass "a different sense of scope" $'- The fixture is classified out of the web conformance scope.'
  expect_pass "opt-out marker" $'- The broadcast is deferred to on_commit. <!-- followup-ok -->'
  expect_pass "trigger words inside a code fence" $'```\n# follow-up later\n```'
  expect_pass "trigger words inside inline code" $'- Uses `deferred_until` from the model.'
  expect_fail "second of two lines untracked" $'- Follow-up: #100\n- Left open: the mobile view.'
  # An unreachable tracker fails closed, and the escape hatch opens it.
  if PATH="$tmp/bin:$PATH" CI_PROJECT_ID=1 check_text $'- Follow-up in #999' >/dev/null 2>&1; then
    st_fail "an unresolvable issue lookup passed"
  fi
  PATH="$tmp/bin:$PATH" CI_PROJECT_ID=1 MR_FOLLOWUPS_ALLOW_UNRESOLVED=1 \
    check_text $'- Follow-up in #999' >/dev/null 2>&1 ||
    st_fail "MR_FOLLOWUPS_ALLOW_UNRESOLVED=1 did not admit an unresolvable lookup"
  echo "self-test OK"
  exit 0
fi

if [ "${1:-}" = "--file" ]; then
  [ -n "${2:-}" ] && [ -f "$2" ] || { echo "usage: $0 --file <path>" >&2; exit 2; }
  check_text "$(cat "$2")"
  exit $?
fi

if ! desc="$(fetch_description)"; then
  echo "SKIP: not a merge request pipeline (no MR IID or description) — nothing to check."
  exit 0
fi
check_text "$desc"
