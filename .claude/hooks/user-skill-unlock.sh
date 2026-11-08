#!/usr/bin/env bash
# UserPromptExpansion hook — when a user-typed /mass_merge or /release expands into a prompt,
# record a session-scoped marker that lets pre-bash-deny.sh allow the few normally denied
# commands that skill needs (#4868):
#   mass_merge: `glab mr merge`, `git push --no-verify [--force-with-lease]`
#   release:    `git reset --hard origin/main`
#
# Why UserPromptExpansion and not UserPromptSubmit. The hooks reference says UserPromptSubmit
# "hooks don't fire only on prompts you type": Claude Code also runs them on a session-scoped
# scheduled task including a /loop iteration, on a background subagent reporting back, and on a
# message another session sends to the main conversation, and its input carries no field that
# says who started the turn. A prompt beginning /mass_merge from any of those would have forged
# the marker. UserPromptExpansion is documented as "Runs when a user-typed command expands into
# a prompt before reaching Claude", and "typing `/skillname` directly bypasses `PreToolUse`.
# `UserPromptExpansion` fires on that direct path."
# <!-- cc-claim: https://code.claude.com/docs/en/hooks checked: 2026-11-07 -->
#
# What the docs do NOT settle (unverified; do not read this marker as proof of a human):
#   - whether a scheduled `/loop /mass_merge` iteration, a cross-session message or a
#     subagent turn that starts with a slash command also fires UserPromptExpansion;
#   - the possible values of `command_source` (the docs' only example value is "plugin"), so
#     this hook cannot require a "user" value and does not look at it.
# The marker is therefore a guard against agent mistakes, not a security boundary. The sandbox
# is the boundary. It is also main-session only: pre_bash_deny.py ignores it when the Bash
# event carries agent_id or agent_type.
#
# Prose that mentions the skill, /fix-mr and /mass_merge-foo do not match: the hook compares
# the event's command_name for equality. pre-bash-deny.sh denies Bash writes to .claude/state/
# and pre-tool-safety.sh denies Edit/Write/NotebookEdit to it (known bypass routes are listed in
# docs/harness/pre-bash-deny.md). TTL (4 h) and session match are enforced by the reader.

set -uo pipefail

input="$(cat 2>/dev/null || true)"
event="$(jq -r '.hook_event_name // empty' <<<"$input" 2>/dev/null || true)"
etype="$(jq -r '.expansion_type // empty' <<<"$input" 2>/dev/null || true)"
cname="$(jq -r '.command_name // empty' <<<"$input" 2>/dev/null || true)"
sid="$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null || true)"
[[ -n "$sid" ]] || exit 0

[[ "$event" == "UserPromptExpansion" && "$etype" == "slash_command" ]] || exit 0
case "$cname" in
  mass_merge|release) skill="$cname" ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)}"
[[ "$root" == /* ]] || exit 0
dir="$root/.claude/state"
mkdir -p "$dir" 2>/dev/null || exit 0
tmp="$(mktemp "$dir/.skill-unlock.XXXXXX")" || exit 0
jq -n --arg skill "$skill" --arg sid "$sid" --argjson ts "$(date +%s)" \
  '{skill: $skill, session_id: $sid, ts: $ts}' >"$tmp" && mv -f "$tmp" "$dir/skill-unlock.json"
exit 0
