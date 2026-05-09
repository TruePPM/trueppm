#!/usr/bin/env bash
# UserPromptSubmit hook — when the user invokes /mr, inject a directive
# requiring /rbac-check + /broadcast-check (always) and /security-review
# (only when sensitive paths are touched). Claude is responsible for running
# the skills and aborting /mr on Critical/High findings.
#
# Cheap variant: the hook itself does not spawn agents — it only inspects
# the diff and tells the main session what to run.

set -uo pipefail

input="$(cat 2>/dev/null || true)"
prompt="$(jq -r '.prompt // empty' <<<"$input" 2>/dev/null || true)"

# Match /mr as a whole token. Avoid matching /fix-mr or /mr-foo prose.
if ! [[ "$prompt" =~ (^|[[:space:]])/mr([[:space:]]|$) ]]; then
  exit 0
fi

# Honor an explicit user opt-out.
if grep -qiE 'skip[[:space:]]+(the[[:space:]]+)?security[[:space:]]+gate' <<<"$prompt"; then
  exit 0
fi

# Diff vs main + uncommitted. Bail silently if not in a git repo or no main ref.
committed="$(git diff --name-only origin/main...HEAD 2>/dev/null || true)"
uncommitted="$(git diff --name-only HEAD 2>/dev/null || true)"
all_changed="$(printf '%s\n%s\n' "$committed" "$uncommitted" | sort -u | sed '/^$/d' || true)"

if [[ -z "$all_changed" ]]; then
  exit 0
fi

# Skip docs/CI/changelog-only branches — no source touched.
if ! grep -qE '\.(py|ts|tsx|js|jsx)$' <<<"$all_changed"; then
  exit 0
fi

# Sensitive-path detection. Order matters: cheapest patterns first.
sensitive=0
if grep -qE \
  -e '(^|/)views\.py$' \
  -e '(^|/)serializers\.py$' \
  -e '(^|/)permissions\.py$' \
  -e '(^|/)consumers\.py$' \
  -e '(^|/)auth/' \
  -e '(^|/)sync/' \
  -e 'file_?handl' \
  -e '(^|/)uploads?/' \
  <<<"$all_changed"; then
  sensitive=1
fi

required=("/rbac-check" "/broadcast-check")
if [[ "$sensitive" -eq 1 ]]; then
  required+=("/security-review")
fi

reason_line="Source files changed; /rbac-check and /broadcast-check are mandatory."
if [[ "$sensitive" -eq 1 ]]; then
  reason_line+=" Sensitive paths detected (views/serializers/permissions/consumers/auth/sync/file-handling) — full /security-review also required."
fi

context=$'Pre-MR security gate (.claude/hooks/pre-mr-security-gate.sh fired):\n\n'"$reason_line"$'\n\nBefore invoking /mr, run the following skills, in order:\n\n'"$(printf -- '- %s\n' "${required[@]}")"$'\nFinding-handling rules:\n- Any Critical or High severity finding → STOP. Do NOT invoke /mr. Surface the findings to the user and ask whether to proceed.\n- Medium / Low findings → summarize inline, then proceed with /mr.\n\nTo bypass this gate intentionally, the user must include the phrase "skip security gate" in the same prompt.'

jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
