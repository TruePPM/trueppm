#!/usr/bin/env bash
# CLAUDE.md stale-issue-claim gate (#4404).
#
# CLAUDE.md is loaded on every agent turn, so a sentence that describes a CLOSED
# issue as a live hole ("... is open", "... today", "... currently") is believed
# on every turn and can make an agent refuse a correct fix. #4404: the e2e
# schema-guard rule kept calling #3649 and #3652 open holes after both closed.
#
# Rule: in each CLAUDE.md, split the text into sentences; a sentence that cites
# `#NNN` where #NNN is CLOSED, AND asserts a live defect, fails. "Asserts a live
# defect" is a small word list (case-insensitive, whole words): open, today,
# currently, "still <unbound|open|broken|missing|wrong|fail(s)|unfixed|unresolved>", "not yet", "yet to", "no fix", unfixed, "checks nothing", and
# present-tense "wrongly <verb>s" (e.g. "the schema wrongly declares"; the past
# "wrongly declared" is deliberately NOT matched, it is how a fix is narrated).
# Fix the sentence (past tense, or say what the issue delivered) or, for a
# deliberate historical sentence, add the marker `stale-ok` in that sentence.
#
# Known to fire by design: a sentence citing an issue that is open today and
# says "today" (e.g. CLAUDE.md "Until the datastore issues in #3408 ship ...
# today") turns this gate red the day that issue closes. That is the intended
# signal, and the red names the sentence to rewrite.
#
# NOT covered (honest limits): a stale claim with no word from the list above
# (e.g. "X is a gap (#N)", "X is unbound (#N)"); a claim whose issue number is
# not written next to it (cited in a neighbouring sentence, or only in prose);
# claims about milestones, MRs or releases rather than issues; and any wording
# the list does not name. The list was kept short because each added word buys
# false positives on narration of fixes (bare "still" was dropped: "`cp` aside
# is still simplest (#3110)" and "citation still resolves (#3744)" are benign). The self-test replays the two #4404
# sentences verbatim, so those exact shapes stay caught.
#
# Scope: the CLAUDE.md files only (root and packages/web). Wider prose (ADRs,
# website docs) legitimately narrates closed issues and is out of scope.
# Sentence splitting is a heuristic on ". " boundaries — it can merge two
# sentences, which only makes the check stricter inside one bullet.
#
# Tracker reads go through scripts/lib/gitlab-issues.sh (batched, 429 retry).
# An unresolvable lookup fails closed; CLAUDE_MD_STALE_ALLOW_UNRESOLVED=1 is the
# explicit opt-out (do not set it in CI). Without CI_PROJECT_ID the tracker
# check is skipped with a WARN, as lint:todo-grep does.
#
# Usage:
#   bash scripts/check-claude-md-stale-issues.sh              # scan CLAUDE.md files
#   bash scripts/check-claude-md-stale-issues.sh FILE...      # scan given files
#   bash scripts/check-claude-md-stale-issues.sh --self-test

set -euo pipefail

# Prints "<lineno>\t<sentence>" for each sentence that has an issue ref and a
# live-defect trigger phrase and no opt-out marker.
candidate_sentences() {
  awk '
    {
      line = $0
      gsub(/\. /, ".\n", line)
      n = split(line, parts, "\n")
      for (i = 1; i <= n; i++) {
        s = parts[i]
        if (s !~ /#[0-9]+/) continue
        if (tolower(s) !~ /(^|[^a-z])(open|today|currently|still (unbound|open|broken|missing|wrong|fails?|unfixed|unresolved)|not yet|yet to|no fix|unfixed|checks nothing|wrongly [a-z]+s)([^a-z]|$)/) continue
        if (s ~ /stale-ok/) continue
        printf "%d\t%s\n", NR, s
      }
    }' "$1"
}

if [ "${1:-}" = "--self-test" ]; then
  export GITLAB_ISSUES_SLEEP_OVERRIDE=0
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/bin"
  # Fake curl: issues 1, 3649, 3652 closed, everything else open; MOCK_MODE=fail answers 401.
  cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
url="${*: -1}"
if [ "${CMD_MOCK_MODE:-}" = "fail" ]; then
  printf '{"message":"401 Unauthorized"}\n401 '
  exit 0
fi
printf '%s' "$url" | grep -oE 'iids\[\]=[0-9]+' | cut -d= -f2 |
  jq -R 'tonumber | {iid: ., state: (if (. == 1 or . == 3649 or . == 3652) then "closed" else "opened" end), title: "fixture issue"}' |
  jq -sc .
printf '200 \n'
CURLMOCK
  chmod +x "$tmp/bin/curl"
  run() { PATH="$tmp/bin:$PATH" CI_PROJECT_ID=999999 bash "$0" "$@"; }

  # The shape #4404 reported: a closed issue described as a live hole.
  printf '%s\n' '- The guard checks nothing on the 46 operations whose body is free-form (#1), which is open today.' >"$tmp/stale.md"
  # The corrected text: past tense, no trigger word.
  printf '%s\n' '- #1 bound the 46 operations that were previously free-form; the guard now checks them.' >"$tmp/fixed.md"
  # Open issue + trigger word is a legitimate live claim.
  printf '%s\n' '- The remaining 3 operations are tracked in #2 and currently unbound.' >"$tmp/live.md"
  # Deliberate historical sentence opts out.
  printf '%s\n' '- It was open for a week (#1) before the fix (stale-ok).' >"$tmp/optout.md"

  # The two ORIGINAL #4404 sentences, verbatim from commit 659093484, neither of
  # which contains open/today/currently. Both cite issues closed in the mock.
  printf '%s\n' 'Before "fixing" a failure, decide which artifact is wrong: 5 of the endpoints the guard flags return a bare array while the *schema* wrongly declares pagination (#3649), so correcting the mock there would make it wrong.' >"$tmp/orig1.md"
  printf '%s\n' 'Operations still unbound live in `e2e/fixtures/schema-guard-waivers.ts`; **the guard checks nothing on the 46 operations whose 2xx body is declared free-form `{type: object}` (#3652)** — that is a hole in the schema, not coverage.' >"$tmp/orig2.md"
  # The corrected current wording (past tense for closed issues).
  printf '%s\n' 'Before "fixing" a failure, decide which artifact is wrong: the schema can be the defective side. The five bare-array endpoints whose schema wrongly declared pagination were fixed in #3649, but the same shape can recur.' 'The guard checks nothing on an operation whose 2xx body is declared free-form `{type: object}`. #3652 bound 43 of the original 46; the remaining 3 are tracked in #3706 and #3855.' >"$tmp/orig_fixed.md"
  for o in orig1 orig2; do
    if run "$tmp/$o.md" >/dev/null 2>&1; then
      echo "SELF-TEST FAILED: original #4404 sentence $o accepted." >&2
      exit 1
    fi
  done
  echo "SELF-TEST OK: both original #4404 sentences (no open/today/currently) rejected."
  run "$tmp/orig_fixed.md" >/dev/null 2>&1 || { echo "SELF-TEST FAILED: rejected the corrected #4404 wording." >&2; exit 1; }
  echo "SELF-TEST OK: corrected #4404 wording accepted."

  if run "$tmp/stale.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: accepted a closed issue described as open today." >&2
    exit 1
  fi
  echo "SELF-TEST OK: closed issue described as open/today correctly rejected."
  run "$tmp/fixed.md" >/dev/null 2>&1 || { echo "SELF-TEST FAILED: rejected the corrected past-tense text." >&2; exit 1; }
  echo "SELF-TEST OK: corrected text accepted."
  run "$tmp/live.md" >/dev/null 2>&1 || { echo "SELF-TEST FAILED: rejected a live claim about an open issue." >&2; exit 1; }
  echo "SELF-TEST OK: open issue with a present-tense claim accepted."
  run "$tmp/optout.md" >/dev/null 2>&1 || { echo "SELF-TEST FAILED: stale-ok marker not honored." >&2; exit 1; }
  echo "SELF-TEST OK: stale-ok marker honored."
  if CMD_MOCK_MODE=fail run "$tmp/stale.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: unresolvable lookup did not fail closed." >&2
    exit 1
  fi
  echo "SELF-TEST OK: unresolvable lookup fails closed."
  if ! CMD_MOCK_MODE=fail CLAUDE_MD_STALE_ALLOW_UNRESOLVED=1 run "$tmp/stale.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: CLAUDE_MD_STALE_ALLOW_UNRESOLVED=1 did not opt out." >&2
    exit 1
  fi
  echo "SELF-TEST OK: CLAUDE_MD_STALE_ALLOW_UNRESOLVED=1 opts out."
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=("$ROOT/CLAUDE.md" "$ROOT/packages/web/CLAUDE.md")
fi

hits=""
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  while IFS=$'\t' read -r lineno sentence; do
    [ -n "$lineno" ] || continue
    for iid in $(printf '%s' "$sentence" | grep -oE '#[0-9]+' | tr -d '#' | sort -un); do
      hits+="${f}:${lineno}"$'\t'"${iid}"$'\t'"${sentence}"$'\n'
    done
  done < <(candidate_sentences "$f")
done

if [ -z "$hits" ]; then
  echo "OK: no CLAUDE.md sentence pairs an issue reference with a live-defect phrase."
  exit 0
fi

PROJECT="${CI_PROJECT_ID:-}"
if [ -z "$PROJECT" ]; then
  echo "WARN: CI_PROJECT_ID not set — skipping the closed-issue check (CI-only)." >&2
  exit 0
fi
API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
# shellcheck source-path=SCRIPTDIR source=lib/gitlab-issues.sh
. "$(dirname "$0")/lib/gitlab-issues.sh"
TOKEN="${CLAUDE_MD_STALE_TOKEN:-${ISSUES_API_TOKEN:-}}"
iids=$(printf '%s' "$hits" | cut -f2 | sort -un)
# shellcheck disable=SC2086  # one iid per word is the intent
if ! states=$(gitlab_issue_states "$API" "$PROJECT" "$TOKEN" $iids); then
  if [ "${CLAUDE_MD_STALE_ALLOW_UNRESOLVED:-0}" = "1" ]; then
    echo "WARN: could not read the tracker — skipping (CLAUDE_MD_STALE_ALLOW_UNRESOLVED=1)." >&2
    exit 0
  fi
  echo "ERROR: could not read issue states from the GitLab API. A gate that cannot reach its oracle must go red." >&2
  exit 1
fi

bad=0
while IFS=$'\t' read -r loc iid sentence; do
  [ -n "$loc" ] || continue
  state=$(printf '%s\n' "$states" | awk -F'\t' -v i="$iid" '$1 == i { print $2; exit }')
  if [ "$state" = "closed" ]; then
    echo "ERROR: ${loc}: cites CLOSED #${iid} next to a live-defect phrase (open/today/currently/not yet/...):" >&2
    echo "         ${sentence}" >&2
    bad=$((bad + 1))
  fi
done <<<"$hits"

if [ "$bad" -gt 0 ]; then
  {
    echo ""
    echo "Rewrite the sentence in the past tense (say what #NNN delivered), or add"
    echo "'stale-ok' to a deliberately historical sentence. CLAUDE.md is read on every turn."
  } >&2
  exit 1
fi
echo "OK: no CLAUDE.md sentence describes a closed issue as open."
