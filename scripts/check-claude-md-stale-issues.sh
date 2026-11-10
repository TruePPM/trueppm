#!/usr/bin/env bash
# CLAUDE.md stale-issue-claim gate (#4404).
#
# CLAUDE.md is loaded on every agent turn, so a sentence that describes a CLOSED
# issue as a live hole ("... is open", "... today", "... currently") is believed
# on every turn and can make an agent refuse a correct fix. #4404: the e2e
# schema-guard rule kept calling #3649 and #3652 open holes after both closed.
#
# Rule: in each CLAUDE.md, split the text into sentences; a sentence that cites
# `#NNN` where #NNN is CLOSED, AND contains the word open / today / currently
# (whole word, case-insensitive), fails. Fix the sentence (past tense, or say
# what the issue delivered) or, for a deliberate historical sentence, add the
# marker `stale-ok` anywhere in that sentence.
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
# present-tense trigger word and no opt-out marker.
candidate_sentences() {
  awk '
    {
      line = $0
      gsub(/\. /, ".\n", line)
      n = split(line, parts, "\n")
      for (i = 1; i <= n; i++) {
        s = parts[i]
        if (s !~ /#[0-9]+/) continue
        if (tolower(s) !~ /(^|[^a-z])(open|today|currently)([^a-z]|$)/) continue
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
  # Fake curl: issue 1 closed, everything else open; MOCK_MODE=fail answers 401.
  cat >"$tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
url="${*: -1}"
if [ "${CMD_MOCK_MODE:-}" = "fail" ]; then
  printf '{"message":"401 Unauthorized"}\n401 '
  exit 0
fi
printf '%s' "$url" | grep -oE 'iids\[\]=[0-9]+' | cut -d= -f2 |
  jq -R 'tonumber | {iid: ., state: (if . == 1 then "closed" else "opened" end), title: "fixture issue"}' |
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
  echo "OK: no CLAUDE.md sentence pairs an issue reference with open/today/currently."
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
    echo "ERROR: ${loc}: cites CLOSED #${iid} next to open/today/currently:" >&2
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
