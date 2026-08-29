#!/usr/bin/env bash
# Fail when a suppression is waiting on an issue that has already been closed.
#
# The 0.4 pre-release audit (#2603) found six axe rule exclusions in
# packages/web/e2e/a11y.spec.ts citing #2204 — closed. One of them read "remove
# this last exclusion when #2204 lands". It had landed. The a11y gate was green
# partly by hiding failures that no open issue tracked, and nothing could have
# noticed: a suppression's justification decays silently, on the day someone
# closes an unrelated issue, with no diff to review.
#
# ## The marker
#
# A suppression that is waiting on tracked work carries, in a comment on or near
# it, the marker `SUPPRESSED-UNTIL` followed by a parenthesized issue reference —
# written here with a placeholder digit-free number, because this file is itself
# in scan range and a real one would make the gate flag its own documentation:
#
#     SUPPRESSED-UNTIL(#NNNN)
#
# and this gate fails once that issue closes. It deliberately does NOT scan for bare
# `#NNNN` near a suppression: the tree carries ~32 such references and nearly all
# are explanatory history ("#2265 landed, so its exclusions were dropped"), which
# a bare-reference gate would flag on the day they became *most* accurate. A gate
# whose findings are mostly noise gets deleted, taking the real signal with it —
# so the marker is opt-in and means exactly one thing: this suppression should
# not outlive that issue.
#
# Not every suppression needs one. A permanent, reasoned exclusion (a verified
# false positive, a library quirk) is not waiting on anything — explain it in
# prose and leave it unmarked. The marker is for debt with an owner.
#
# ## Triggers
#
# Runs on merge requests (validates a newly added marker names a real, open
# issue) and on main + schedule (catches the marker that went stale because its
# issue closed — which is not a diff event at all, and is the case that produced
# #2603).
#
# Exit codes:
#   0  every marker names an open issue (or there are none)
#   1  at least one marker names a closed or missing issue
#   2  invocation / API error

set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=lib/git-ignored.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/git-ignored.sh"

if [ "${1:-}" = "--self-test" ]; then
  # The comment on --list below says a marker the regex stops matching "fails
  # open and silently, which is the exact failure mode this gate was written to
  # end". That is precisely what happened: the CI image's BusyBox grep rejects
  # --exclude-dir, the `|| true` swallowed it, and this gate reported "no
  # SUPPRESSED-UNTIL markers found" on a tree carrying five of them in two
  # tracked files (#3172). --list made the discovery half testable offline;
  # nothing was testing it. This does.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0

  mkdir -p "$st_tmp/marked"
  printf '// SUPPRESSED-UNTIL(#2618) verified still failing\n' > "$st_tmp/marked/a.ts"
  case "$(bash "$0" --list "$st_tmp/marked" 2>/dev/null || true)" in
    *'SUPPRESSED-UNTIL(#2618)'*)
      echo "SELF-TEST OK: a marker in the tree is discovered." ;;
    *)
      echo "SELF-TEST FAILED: discovery found nothing in a tree that carries a marker." >&2
      echo "                  The gate is BLIND -- it would report OK on any tree." >&2
      st_rc=1 ;;
  esac

  mkdir -p "$st_tmp/clean"
  printf 'nothing to see here\n' > "$st_tmp/clean/b.ts"
  case "$(bash "$0" --list "$st_tmp/clean" 2>/dev/null || true)" in
    *'no SUPPRESSED-UNTIL markers found'*)
      echo "SELF-TEST OK: a clean tree reports none." ;;
    *)
      echo "SELF-TEST FAILED: a clean tree did not report clean." >&2; st_rc=1 ;;
  esac

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

ROOT="${1:-.}"
LIST_ONLY=""
if [ "${2:-}" = "--list" ] || [ "${1:-}" = "--list" ]; then
  LIST_ONLY="1"
  [ "${1:-}" = "--list" ] && ROOT="${2:-.}"
fi

API="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
PROJECT="${CI_PROJECT_ID:-}"

# --list prints the markers it discovers and exits, without contacting GitLab.
# It exists so the discovery half — the regex, and which directories are in
# scope — is unit-testable offline. That is the half that actually drifts: the
# API half either answers or errors loudly, while a marker the regex stops
# matching fails open and silently, which is the exact failure mode this gate
# was written to end.
if [ -z "$PROJECT" ] && [ -z "$LIST_ONLY" ]; then
  echo "ERROR: CI_PROJECT_ID is not set. This script is intended to run in CI." >&2
  echo "       (Locally: CI_PROJECT_ID=trueppm%2Ftrueppm bash $0)" >&2
  exit 2
fi

if [ -n "${BOUNDARY_CHECK_TOKEN:-}" ]; then
  AUTH_HEADER="PRIVATE-TOKEN: ${BOUNDARY_CHECK_TOKEN}"
else
  AUTH_HEADER="JOB-TOKEN: ${CI_JOB_TOKEN:-}"
fi

# Collect `path:line:` per marker. --exclude-dir keeps the scan off vendored
# trees; `|| true` because grep exits 1 on no matches, which is a clean pass.
markers=$(grep -rnE 'SUPPRESSED-UNTIL\(#[0-9]+\)' "$ROOT" \
  --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.git \
  --exclude-dir=dist --exclude-dir=target --exclude-dir=coverage \
  2>/dev/null || true)
markers="$(printf '%s\n' "$markers" | drop_ignored_lines)"

if [ -z "$markers" ]; then
  echo "OK: no SUPPRESSED-UNTIL markers found."
  exit 0
fi

if [ -n "$LIST_ONLY" ]; then
  echo "$markers"
  exit 0
fi

# Unique issue numbers across all markers — one API call each, not one per site.
issues=$(echo "$markers" | grep -oE 'SUPPRESSED-UNTIL\(#[0-9]+\)' \
  | grep -oE '[0-9]+' | sort -un)

stale=0
checked=0

for iid in $issues; do
  url="${API}/projects/${PROJECT}/issues/${iid}"
  if ! result=$(curl -sf --header "$AUTH_HEADER" "$url" 2>/dev/null); then
    echo ""
    echo "STALE SUPPRESSION: #${iid} could not be read (missing, moved, or no access)."
    echo "$markers" | grep -E "SUPPRESSED-UNTIL\(#${iid}\)" | sed 's/^/  /'
    stale=$((stale + 1))
    continue
  fi
  state=$(echo "$result" | jq -r '.state')
  checked=$((checked + 1))
  if [ "$state" != "opened" ]; then
    title=$(echo "$result" | jq -r '.title')
    echo ""
    echo "STALE SUPPRESSION: #${iid} is ${state} — \"${title}\""
    echo "$markers" | grep -E "SUPPRESSED-UNTIL\(#${iid}\)" | sed 's/^/  /'
    stale=$((stale + 1))
  fi
done

if [ "$stale" -gt 0 ]; then
  cat <<'MSG'

A suppression outlived the work it was waiting on. Each site above is either
hiding a failure that is now fixed, or hiding one that nothing tracks anymore.

Remediation per site:
  - If the underlying defect is fixed: delete the suppression. The gate it
    disables should now pass.
  - If it is NOT fixed: the issue was closed prematurely. Reopen it, or file a
    fresh one and repoint the marker — do not simply renumber to something
    convenient.
  - If the suppression is permanent and reasoned (verified false positive,
    library quirk): drop the SUPPRESSED-UNTIL marker and explain why in prose.
    The marker means "this is temporary"; unmarked means "this is a decision".

See scripts/check-suppression-issues.sh for the convention.
MSG
  exit 1
fi

echo "OK: all ${checked} SUPPRESSED-UNTIL marker issue(s) are open."
