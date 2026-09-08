#!/usr/bin/env bash
# Known-issues freshness gate (#3628).
#
# packages/website/src/content/docs/overview/known-issues.md states its own
# contract in the intro: "Every entry names the issue tracking it and the
# release it is fixed in. When an issue closes, its entry comes off this
# page." Nothing enforced that. A 2026-09-08 sweep found ten of the page's 28
# issue references pointing at closed issues — this is the third recorded
# instance of the class (#2594, #3607, #3628), so a mechanical gate replaces
# the next persona-panel sweep instead of waiting for one.
#
# Rule: every GitLab issue reference (a `/-/issues/NNNN` URL) on the page must
# resolve to an OPEN issue, UNLESS the SAME physical line also carries the ack
# marker below. The marker is the escape hatch for a reference the page cites
# on purpose — context for a decision that already shipped (e.g. an engine
# restriction lifting), or a closed issue cited as evidence a fix landed
# (e.g. #2689). Adding the marker is a claim a human made after checking
# `main`, not a way to make the gate quiet — see CLAUDE.md's "a closed issue
# is evidence the work merged, not that the entry's claim is now false."
#
#   ACK_MARKER: <!-- known-issues-ack:closed -->
#
# Exit codes:
#   0  no violations
#   1  a reference resolves to a closed issue with no ack marker on its own
#      line, or (default) a lookup could not be resolved at all
#   2  invocation / setup error (page missing, CI_PROJECT_ID unset)
#
# Modes:
#   bash scripts/check-known-issues-freshness.sh              # scan the default page
#   bash scripts/check-known-issues-freshness.sh <file>        # scan a given file
#   bash scripts/check-known-issues-freshness.sh --self-test   # synthesize fixtures, assert
#
# Auth: same reasoning as check-todo-grep.sh (#3043) — CI_JOB_TOKEN cannot
# authenticate against the Issues API on any endpoint, so a JOB-TOKEN header
# only ever turns a public project's anonymous 200 into a guaranteed 401. No
# auth header is sent unless KNOWN_ISSUES_TOKEN (a project/group access
# token with read_api) is set; it is not required for trueppm/trueppm itself
# because this project's issue tracker is public.
#
# A gate that cannot reach its oracle must go red, not silently pass.
# KNOWN_ISSUES_ALLOW_UNRESOLVED=1 is the explicit opt-out for a context where
# issue-state resolution is genuinely unavailable — a tracker-API timeout
# should retry the JOB, not be silenced (the same fail-closed caveat
# lint:todo-grep documents). It is not set anywhere in this repo's own CI.

set -euo pipefail

ACK_MARKER='<!-- known-issues-ack:closed -->'
PAGE_DEFAULT="packages/website/src/content/docs/overview/known-issues.md"

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  # A fake `curl` ahead of PATH drives the real fetch/parse/decide code below
  # without hitting the network. KNOWN_ISSUES_MOCK_MODE picks the response:
  #   open      -> {"state":"opened"}          200
  #   closed    -> {"state":"closed", "title":"..."}  200
  #   unfetchable -> curl "fails" (no output, matching a real network error)
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
case "${KNOWN_ISSUES_MOCK_MODE:-open}" in
  open)
    printf '%s\n%s\n' '{"state":"opened","title":"an open issue"}' "200"
    ;;
  closed)
    printf '%s\n%s\n' '{"state":"closed","title":"a closed issue"}' "200"
    ;;
  unfetchable)
    printf '\n%s\n' "000"
    ;;
esac
CURLMOCK
  chmod +x "$tmp/bin/curl"
  export PATH="$tmp/bin:$PATH"
  export CI_PROJECT_ID="1"

  # --- Case 1: an open issue reference passes ---
  cat >"$tmp/open.md" <<'EOF'
Tracked on [#100](https://gitlab.com/trueppm/trueppm/-/issues/100).
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=open bash "$0" "$tmp/open.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an open issue reference was rejected." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an open issue reference passes."

  # --- Case 2: a closed issue reference with no ack marker fails ---
  cat >"$tmp/closed_unmarked.md" <<'EOF'
Tracked on [#101](https://gitlab.com/trueppm/trueppm/-/issues/101).
EOF
  if KNOWN_ISSUES_MOCK_MODE=closed bash "$0" "$tmp/closed_unmarked.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an unmarked closed-issue reference was accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an unmarked closed-issue reference is rejected."

  # --- Case 3: a closed issue reference WITH the ack marker on its own line passes ---
  cat >"$tmp/closed_marked.md" <<'EOF'
Tracked on [#102](https://gitlab.com/trueppm/trueppm/-/issues/102). <!-- known-issues-ack:closed -->
EOF
  if ! KNOWN_ISSUES_MOCK_MODE=closed bash "$0" "$tmp/closed_marked.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an ack-marked closed-issue reference was rejected." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an ack-marked closed-issue reference passes."

  # --- Case 4: the marker on a DIFFERENT line from the reference does not launder it ---
  cat >"$tmp/closed_marked_wrong_line.md" <<'EOF'
Tracked on [#103](https://gitlab.com/trueppm/trueppm/-/issues/103).
<!-- known-issues-ack:closed -->
EOF
  if KNOWN_ISSUES_MOCK_MODE=closed bash "$0" "$tmp/closed_marked_wrong_line.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a marker on a different line laundered a closed reference." >&2
    exit 1
  fi
  echo "SELF-TEST OK: the ack marker must sit on the reference's own line."

  # --- Case 5: an unresolvable lookup fails closed by default ---
  cat >"$tmp/unfetchable.md" <<'EOF'
Tracked on [#104](https://gitlab.com/trueppm/trueppm/-/issues/104).
EOF
  if KNOWN_ISSUES_MOCK_MODE=unfetchable bash "$0" "$tmp/unfetchable.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an unresolvable lookup was silently accepted." >&2
    exit 1
  fi
  echo "SELF-TEST OK: an unresolvable lookup fails closed by default."

  # --- Case 6: KNOWN_ISSUES_ALLOW_UNRESOLVED=1 opts out of the failure ---
  if ! KNOWN_ISSUES_MOCK_MODE=unfetchable KNOWN_ISSUES_ALLOW_UNRESOLVED=1 \
      bash "$0" "$tmp/unfetchable.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: KNOWN_ISSUES_ALLOW_UNRESOLVED=1 did not opt out." >&2
    exit 1
  fi
  echo "SELF-TEST OK: KNOWN_ISSUES_ALLOW_UNRESOLVED=1 opts out of an unresolvable lookup."

  echo "ALL SELF-TESTS PASSED"
  exit 0
fi

PAGE="${1:-$PAGE_DEFAULT}"

if [ ! -f "$PAGE" ]; then
  echo "ERROR: page not found: $PAGE" >&2
  exit 2
fi

PROJECT="${CI_PROJECT_ID:-}"
if [ -z "$PROJECT" ]; then
  echo "ERROR: CI_PROJECT_ID is not set. This script is intended to run in CI." >&2
  exit 2
fi

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
CURL_AUTH_ARGS=()
if [ -n "${KNOWN_ISSUES_TOKEN:-}" ]; then
  CURL_AUTH_ARGS=(--header "PRIVATE-TOKEN: ${KNOWN_ISSUES_TOKEN}")
fi
# No `else` branch: a JOB-TOKEN header cannot authenticate against this
# endpoint (#3043) and only turns a potential anonymous 200 into a
# guaranteed 401, so the no-token case sends no auth header at all.

ALLOW_UNRESOLVED="${KNOWN_ISSUES_ALLOW_UNRESOLVED:-0}"

violations=0
line_no=0

while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))

  refs=$(printf '%s' "$line" | grep -oE '/-/issues/[0-9]+' | grep -oE '[0-9]+' || true)
  [ -z "$refs" ] && continue

  has_marker=0
  case "$line" in
    *"$ACK_MARKER"*) has_marker=1 ;;
  esac

  while IFS= read -r iid; do
    [ -z "$iid" ] && continue

    url="${API}/projects/${PROJECT}/issues/${iid}"
    # Status code on its own trailing line rather than relying on `curl -f`'s
    # exit status alone — see check-todo-grep.sh for why that ambiguity (401
    # vs 404 vs 000) makes a red gate expensive to diagnose.
    resp=$(curl -s -w $'\n%{http_code}' "${CURL_AUTH_ARGS[@]+"${CURL_AUTH_ARGS[@]}"}" "$url" || true)
    http_code="${resp##*$'\n'}"
    body="${resp%$'\n'*}"

    if [ "$http_code" != "200" ]; then
      if [ "$ALLOW_UNRESOLVED" = "1" ]; then
        echo "WARN: could not fetch issue #${iid} (HTTP ${http_code:-000}) — skipping (KNOWN_ISSUES_ALLOW_UNRESOLVED=1)." >&2
      else
        echo "ERROR: could not fetch issue #${iid} from GitLab API (HTTP ${http_code:-000}) — cannot verify line ${line_no}." >&2
        violations=$((violations + 1))
      fi
      continue
    fi

    state=$(printf '%s' "$body" | jq -r '.state // "unknown"')
    if [ "$state" = "closed" ] && [ "$has_marker" -ne 1 ]; then
      title=$(printf '%s' "$body" | jq -r '.title // ""')
      echo "ERROR: line ${line_no} references closed issue #${iid} (${title}) with no ack marker." >&2
      echo "  Either verify the entry against main and remove/reword it, or — only if the" >&2
      echo "  reference is a deliberate closed-issue citation, verified against main — add" >&2
      echo "  ${ACK_MARKER} to the SAME line." >&2
      violations=$((violations + 1))
    fi
  done <<<"$refs"
done <"$PAGE"

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "${violations} known-issues.md reference(s) need attention (see CLAUDE.md" >&2
  echo "'do not delete on issue state alone' before removing any entry)." >&2
  exit 1
fi

echo "OK: every issue reference on ${PAGE} is open, or ack-marked as a deliberate closed-issue citation."
