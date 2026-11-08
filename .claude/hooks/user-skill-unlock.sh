#!/usr/bin/env bash
# UserPromptSubmit hook — when the USER's prompt starts with /mass_merge or /release as a
# whole token, record a session-scoped marker that lets pre-bash-deny.sh allow the few
# normally denied commands that skill needs (#4868):
#   mass_merge: `glab mr merge`, `git push --no-verify [--force-with-lease]`
#   release:    `git reset --hard origin/main`
# Only a user prompt reaches this hook, which is what makes the marker an authorization
# signal; pre-bash-deny.sh denies Bash writes to .claude/state/ and pre-tool-safety.sh denies
# Edit/Write to it. TTL (4 h) and session match are enforced by the reader.
# Prose that mentions the skill mid-sentence, /fix-mr and /mass_merge-foo do not match.

set -uo pipefail

input="$(cat 2>/dev/null || true)"
prompt="$(jq -r '.prompt // empty' <<<"$input" 2>/dev/null || true)"
sid="$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null || true)"
[[ -n "$sid" ]] || exit 0

skill=""
if [[ "$prompt" =~ ^[[:space:]]*/(mass_merge|release)([[:space:]]|$) ]]; then
  skill="${BASH_REMATCH[1]}"
else
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)}"
[[ "$root" == /* ]] || exit 0
dir="$root/.claude/state"
mkdir -p "$dir" 2>/dev/null || exit 0
tmp="$(mktemp "$dir/.skill-unlock.XXXXXX")" || exit 0
jq -n --arg skill "$skill" --arg sid "$sid" --argjson ts "$(date +%s)" \
  '{skill: $skill, session_id: $sid, ts: $ts}' >"$tmp" && mv -f "$tmp" "$dir/skill-unlock.json"
exit 0
