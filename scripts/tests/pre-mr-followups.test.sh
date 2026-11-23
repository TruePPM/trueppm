#!/usr/bin/env bash
# scripts/tests/pre-mr-followups.test.sh — the PreToolUse hook that runs the
# lint:mr-followups check on an MR description before glab sends it (#5108).
#
# Same bucket as pre-bash-deny.test.sh: a Claude Code hook, not a CI gate, run from
# the scripts self-test job. Each case pipes a fabricated PreToolUse event to the hook
# and asserts on the exit code (2 = blocked, 0 = allowed).
#
# Point HOOK at a no-op that drains stdin (`cat >/dev/null; exit 0`) and exactly the
# BLOCK cases and the message check fail: that is the "fails on current main" proof.

# shellcheck disable=SC2016  # test commands are literal text, never expanded here
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="${HOOK:-$ROOT/.claude/hooks/pre-mr-followups.sh}"
rc=0
pass() { echo "SELF-TEST OK: $1"; }
fail() { echo "SELF-TEST FAILED: $1" >&2; rc=1; }

command -v python3 >/dev/null 2>&1 || { echo "pre-mr-followups.test.sh: python3 is required" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

event() {
  python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","cwd":sys.argv[2],"tool_input":{"command":sys.argv[1]}}))' "$1" "$tmp"
}
run_hook() {
  HERR="$(event "$1" | CLAUDE_PROJECT_DIR="$ROOT" bash "$HOOK" 2>&1 >/dev/null)"
  HRC=$?
}
expect_block() {
  run_hook "$2"
  if [ "$HRC" -eq 2 ]; then pass "$1"; else fail "$1 (exit $HRC, expected 2)"; fi
}
expect_allow() {
  run_hook "$2"
  if [ "$HRC" -eq 0 ]; then pass "$1"; else fail "$1 (exit $HRC, expected 0): $HERR"; fi
}

BAD='- gate: completeness-check — 3 findings (sonnet; 3 GAPs, fixed in the follow-up docs commit)'
GOOD='- gate: completeness-check — 3 findings (sonnet; 3 GAPs, fixed by commit 83ebfad4 on this branch)'
printf '## Gates\n\n%s\n' "$BAD" >"$tmp/bad.md"
printf '## Gates\n\n%s\n' "$GOOD" >"$tmp/good.md"

heredoc_create() {
  printf 'glab mr create --title "feat: x" --description "$(cat <<'"'"'EOF'"'"'\n## Gates\n\n%s\n\nCloses #1\nEOF\n)"' "$1"
}

# The !3557 wording, in every way a description reaches glab.
expect_block "mr create, heredoc, 'the follow-up docs commit'" "$(heredoc_create "$BAD")"
expect_block "mr update -d \"\$(cat file)\"" "glab mr update 3557 -d \"\$(cat $tmp/bad.md)\""
expect_block "mr update, relative \$(cat file) resolved against cwd" 'glab mr update 3557 --description "$(cat bad.md)"'
expect_block "glab api PUT description=@file" "glab api -X PUT \"projects/:id/merge_requests/3557\" -F \"description=@$tmp/bad.md\""
expect_block "mr update, literal -d value" "glab mr update 3557 -d 'The mobile view is left open.'"
expect_block "glab -R first, mr create" "glab -R trueppm/trueppm mr create -d \"\$(cat $tmp/bad.md)\""

# What must pass.
expect_allow "mr create, heredoc, says what happened" "$(heredoc_create "$GOOD")"
expect_allow "follow-up naming an issue" "$(heredoc_create '- The demo copy is a follow-up: #100')"
expect_allow "followup-ok marker" "$(heredoc_create '- Broadcast is deferred to on_commit. <!-- followup-ok -->')"
expect_allow "glab api PUT with a clean file" "glab api -X PUT \"projects/:id/merge_requests/3557\" -F \"description=@$tmp/good.md\""
expect_allow "mr update without a description" 'glab mr update 3557 --label no-changelog'
expect_allow "a non-MR command" 'git log --oneline -3'
expect_allow "follow-up words outside an MR write" 'echo "a follow-up commit"'
expect_allow "unreadable file fails open" 'glab mr update 1 -d "$(cat /nonexistent/desc.md)"'

# Fails open on input it cannot read.
if printf 'not json' | CLAUDE_PROJECT_DIR="$ROOT" bash "$HOOK" >/dev/null 2>&1; then
  pass "malformed event fails open"
else
  fail "malformed event did not fail open"
fi
# The block message names the line and the fix.
run_hook "$(heredoc_create "$BAD")"
if grep -q 'UNTRACKED' <<<"$HERR" && grep -q 'fixed by commit' <<<"$HERR"; then
  pass "block message carries the flagged line and the fix"
else
  fail "block message missing the flagged line or the fix: $HERR"
fi

exit "$rc"
