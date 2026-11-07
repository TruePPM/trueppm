#!/bin/bash
# PostToolUse(Bash): after `glab mr create`, post the "## Cost of this MR" comment unless the
# cost-ledger setting is off. All logic is in scripts/post-mr-cost.py. The payload is buffered and
# python only starts when it names `glab mr create`, since this hook fires on every Bash call.
# Always exits 0: a hook must never break the tool call it follows.
payload="$(cat)"
case "$payload" in
  *"glab mr create"*|*"glab"*"mr"*"create"*) ;;
  *) exit 0 ;;
esac
printf '%s' "$payload" | python3 "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/scripts/post-mr-cost.py"
exit 0
