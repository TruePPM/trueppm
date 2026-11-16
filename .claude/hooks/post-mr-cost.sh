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
# scripts/post-mr-cost.py needs Python 3.11+ (possessive quantifiers); macOS /usr/bin/python3 is 3.9 and
# fails to import it, which would otherwise be a silent no-comment. Say so instead.
if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
  py_path="$(command -v python3 2>/dev/null || echo 'not found')"
  py_ver="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || echo unknown)"
  msg="The MR cost hook needs Python 3.11+, but python3 on PATH is ${py_ver} (${py_path}). No cost comment was posted; put a 3.11+ python3 first on PATH, then run: python3 scripts/post-mr-cost.py --retry --mr <iid> --session <session-id> (docs/harness/cost-ledger.md)."
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$msg" "$msg"
  exit 0
fi
printf '%s' "$payload" | python3 "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/scripts/post-mr-cost.py"
exit 0
