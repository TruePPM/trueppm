#!/usr/bin/env bash
# Pre-push duplicate-work guard (issue #2000).
#
# WHY THIS EXISTS
# ---------------
# `scripts/wt new`/`wt claim` apply a `status::wip` label + a `🔒 checked out`
# comment and refuse an already-claimed issue — but that guard lives ONLY in the
# `wt` code path. A branch created with plain `git checkout -b feat/<issue>-…`
# (which CLAUDE.md blesses for single-focus work) never calls it, so two agents
# sharing one GitLab identity can independently implement the same issue and open
# duplicate MRs. That is exactly how #1985 produced !1352 and !1353.
#
# The fix is to enforce collision detection at the one chokepoint EVERY branch
# passes through regardless of how it was created: `git push` (pre-push). By the
# time you push, the strongest possible duplicate signal is usually already
# available — an OPEN merge request that references the same issue from a
# different branch.
#
# BEHAVIOR
#   - No issue number in the branch name  → no-op (exit 0).
#   - TRUEPPM_ALLOW_DUP_MR=1              → override; warn and pass (legitimate
#                                           stacked / multi-MR-per-issue work).
#   - glab missing / API error / offline → best-effort warn, pass (never wedge a
#                                           push on a network blip; mirrors `wt`).
#   - Open MR references this issue from a DIFFERENT branch → BLOCK (exit 1).
#   - `🔒 checked out` comment names a DIFFERENT branch, no blocking MR yet
#                                           → warn only (the label/comment can be
#                                           stale; not authoritative enough to
#                                           block).
#
# Exit codes: 0 pass (or best-effort skip), 1 duplicate MR found (block).

set -euo pipefail

warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
dim()  { printf '\033[2m%s\033[0m\n' "$*" >&2; }

WT_LOCK_LABEL="${TRUEPPM_WT_LOCK_LABEL:-status::wip}"

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
[[ -z "$branch" || "$branch" == "HEAD" ]] && exit 0

# feat/1985-foo → 1985 ; chore/some-slug → "" (no-op). Mirrors wt's
# issue_from_branch so both tools agree on which issue a branch locks.
issue=""
if [[ "$branch" =~ ^[a-z]+/([0-9]+)- ]]; then issue="${BASH_REMATCH[1]}"; fi
[[ -z "$issue" ]] && exit 0

if [[ -n "${TRUEPPM_ALLOW_DUP_MR:-}" ]]; then
  warn "TRUEPPM_ALLOW_DUP_MR set — skipping the duplicate-MR guard for #$issue (stacked/multi-MR work)."
  exit 0
fi

command -v glab >/dev/null 2>&1 || {
  warn "glab not found — cannot check #$issue for a duplicate MR before push (best-effort skip)."
  exit 0
}

# MRs that reference this issue (description / commits / comments). GitLab's
# related_merge_requests endpoint is the broadest net: it catches both a `Closes
# #NNN` MR and one that merely mentions the issue. We filter to OPEN MRs on a
# DIFFERENT source branch — an open MR on THIS branch is our own and expected.
related="$(glab api "projects/:id/issues/${issue}/related_merge_requests" 2>/dev/null || true)"
if [[ -z "$related" ]]; then
  warn "could not query MRs for #$issue (glab auth/offline?) — best-effort skip."
  exit 0
fi

dup="$(printf '%s' "$related" | python3 -c '
import json, sys
branch = sys.argv[1]
try:
    mrs = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for mr in mrs or []:
    if mr.get("state") == "opened" and mr.get("source_branch") != branch:
        print(f"!{mr.get(\"iid\")}\t{mr.get(\"source_branch\")}\t{mr.get(\"web_url\")}")
' "$branch" 2>/dev/null || true)"

if [[ -n "$dup" ]]; then
  err "issue #$issue already has an open merge request from another branch:"
  while IFS=$'\t' read -r iid src url; do
    dim "  $iid  ($src)  $url"
  done <<<"$dup"
  echo "" >&2
  err "This branch ('$branch') looks like duplicate work. Before pushing:"
  dim "  • Reconcile with the existing MR (merge into it, rebase onto it, or close one)."
  dim "  • If this is legitimate stacked / multi-MR-per-issue work, re-push with"
  dim "    TRUEPPM_ALLOW_DUP_MR=1 git push …"
  exit 1
fi

# Weaker signal: someone claimed the issue (label + check-out comment) but has
# not opened an MR yet. Warn — don't block — because the comment can be stale
# (a released worktree whose label lingered). Only meaningful if the comment
# names a branch other than ours.
locked="$(glab issue view "$issue" --output json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('locked' if '${WT_LOCK_LABEL}' in (d.get('labels') or []) else '')" \
  2>/dev/null || true)"
if [[ "$locked" == "locked" ]]; then
  note="$(glab issue view "$issue" --comments --output json 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
notes=d.get('Notes') or d.get('notes') or []
hits=[(n.get('body') or '') for n in notes if '🔒 checked out' in (n.get('body') or '')]
print(hits[-1] if hits else '')
" 2>/dev/null || true)"
  # Only warn if the recorded claim is for a different branch than ours.
  if [[ -n "$note" && "$note" != *"$branch"* ]]; then
    warn "issue #$issue carries '${WT_LOCK_LABEL}' claimed by another worktree — verify you are not duplicating work."
    dim "  $note"
    dim "  (No open MR yet, so not blocking. Re-check with: glab issue view $issue --comments)"
  fi
fi

exit 0
