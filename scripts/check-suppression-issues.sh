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
# ## Which rule blocks where (#4925)
#
# The "issue closed" half is not a diff event, so as a whole-tree check on every
# MR and main push it turned main red on the day someone closed an issue. Split
# by cause:
#
#   MR-caused (TRACKER_GATE_MODE=diff, default — MR, main push, make pre-push;
#     blocks): a marker on a line the diff ADDS (vs the merge base) that names
#     a closed or missing issue, or any marker naming an issue THIS change
#     closes (tracker_gate_closing_ids — GitLab's closes_issues on an MR).
#   tracker-caused (TRACKER_GATE_MODE=drift — scripts/tracker-drift-report.sh,
#     nightly tracking issue): a pre-existing marker whose issue was closed
#     outside this change — the #2603 case.
#
# Exit codes:
#   0  every marker names an open issue (or there are none)
#   1  at least one marker names a closed or missing issue
#   2  invocation / API error (tracker or diff base unreadable — fail closed)

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

  # The fixture marker is assembled at RUNTIME from `st_tag` rather than written
  # out as one literal. The docstring above already says why this file keeps its
  # examples digit-free — but the self-test needs real digits for the regex to
  # have anything to match, so the literal is split instead. Written whole, these
  # two lines are a live marker in a file the gate scans, and the gate would flag
  # its own test fixture on the day that issue closed. That is not hypothetical:
  # the previous fixture cited #2618, and closing it would have reddened main
  # from here and from CONTRIBUTING.md (#2618). Keep them assembled.
  st_tag="SUPPRESSED-UNTIL"
  mkdir -p "$st_tmp/marked"
  printf '// %s(#4242424) verified still failing\n' "$st_tag" > "$st_tmp/marked/a.ts"
  case "$(bash "$0" --list "$st_tmp/marked" 2>/dev/null || true)" in
    *"$st_tag(#4242424)"*)
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

  # ---- diff vs drift (#4925). A fake curl serves #4242424 closed and every
  # other issue open; $st_tmp/repo's first commit is the merge base.
  mkdir -p "$st_tmp/bin" "$st_tmp/repo"
  cat >"$st_tmp/bin/curl" <<'CURLMOCK'
#!/usr/bin/env bash
url="${*: -1}"
if [ "${ST_MOCK_FAIL:-0}" = 1 ]; then printf '\n000 \n'; exit 0; fi
printf '%s' "$url" | grep -oE 'iids\[\]=[0-9]+' | cut -d= -f2 |
  jq -R 'tonumber | {iid: ., state: (if . == 4242424 then "closed" else "opened" end), title: "t"}' | jq -sc .
printf '\n200 \n'
CURLMOCK
  chmod +x "$st_tmp/bin/curl"
  printf '// %s(#4242424) old\n// %s(#5151515) open\n' "$st_tag" "$st_tag" > "$st_tmp/repo/a.ts"
  git -C "$st_tmp/repo" init -q && git -C "$st_tmp/repo" add -A &&
    git -C "$st_tmp/repo" -c user.email=t@t -c user.name=t commit -qm base
  st_base=$(git -C "$st_tmp/repo" rev-parse HEAD)
  st_self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  st_run() { # st_run <mode> <closes> [fail]
    (cd "$st_tmp/repo" && PATH="$st_tmp/bin:$PATH" CI_PROJECT_ID=1 GITLAB_ISSUES_SLEEP_OVERRIDE=0 \
      GITLAB_ISSUES_MAX_ATTEMPTS=1 ST_MOCK_FAIL="${3:-0}" TRACKER_GATE_MODE="$1" TRACKER_GATE_BASE="$st_base" \
      TRACKER_GATE_CLOSES="$2" bash "$st_self" "$st_tmp/repo") >/dev/null 2>&1
  }
  st_case() { # st_case <want-rc> <description> <st_run args...>
    local want="$1" d="$2" rc=0
    shift 2
    st_run "$@" || rc=$?
    if [ "$rc" = "$want" ]; then echo "SELF-TEST OK: $d"; else echo "SELF-TEST FAILED: $d (exit $rc, want $want)" >&2; st_rc=1; fi
  }
  st_case 0 "[diff] a pre-existing marker whose issue closed elsewhere fails no MR (no tracker call)" diff "" 1
  st_case 1 "[drift] the nightly report sees the same stale marker" drift ""
  st_case 1 "[diff] a change that closes a marker's issue while the marker stays fails before merge" diff "5151515"
  printf '// %s(#4242424) added by this change\n' "$st_tag" > "$st_tmp/repo/b.ts"
  git -C "$st_tmp/repo" add -A && git -C "$st_tmp/repo" -c user.email=t@t -c user.name=t commit -qm head
  st_case 1 "[diff] a marker the change adds naming a closed issue fails" diff ""
  st_case 2 "[diff] an unreadable tracker on an added marker fails closed" diff "" 1

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

# shellcheck source-path=SCRIPTDIR source=lib/gitlab-issues.sh
. "$(dirname "$0")/lib/gitlab-issues.sh"
# No JOB-TOKEN fallback: the single-issue reads this gate used to make 401 on
# any JOB-TOKEN header (#3043); the shared reader goes anonymous instead.
TOKEN="${BOUNDARY_CHECK_TOKEN:-${ISSUES_API_TOKEN:-}}"

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

# Unique issue numbers across all markers, resolved in one batched call with
# 429 retry rather than one request each (#4452).
issues=$(echo "$markers" | grep -oE 'SUPPRESSED-UNTIL\(#[0-9]+\)' \
  | grep -oE '[0-9]+' | sort -un)

stale=0
checked=0

MODE=$(tracker_gate_mode) || exit 2
if [ "$MODE" = diff ]; then
  # Only what this change causes (#4925); see the header.
  if ! base=$(tracker_gate_base) || ! closing=$(tracker_gate_closing_ids "$API" "$PROJECT" "$TOKEN" "$base"); then
    echo "ERROR: could not resolve the diff base or this change's closing set — failing closed." >&2
    exit 2
  fi
  for iid in $issues; do
    if tracker_gate_has "$iid" "$closing"; then
      echo ""
      echo "STALE SUPPRESSION: #${iid} is closed by this change — remove the suppression in this change."
      echo "$markers" | grep -E "SUPPRESSED-UNTIL\(#${iid}\)" | sed 's/^/  /'
      stale=$((stale + 1))
    fi
  done
  added=$(git -C "$ROOT" diff --no-color -U0 "$base" -- . 2>/dev/null | grep -E '^[+]' | grep -vE '^[+]{3} ' |
    grep -oE 'SUPPRESSED-UNTIL\(#[0-9]+\)' | grep -oE '[0-9]+' | sort -un || true)
  issues=$(for iid in $(tracker_gate_minus "$added" "$closing"); do
    tracker_gate_has "$iid" "$issues" && printf '%s\n' "$iid"
  done || true)
  echo "INFO: diff mode (#4925) — $(printf '%s\n' $issues | grep -c . || true) marker issue(s) added by this change checked; markers whose issue closed elsewhere are reported by tracker:drift-report."
fi

states=""
# shellcheck disable=SC2086  # one iid per word is the intent
if [ -n "$issues" ] && ! states=$(gitlab_issue_states "$API" "$PROJECT" "$TOKEN" $issues); then
  echo "ERROR: could not read suppression issues from the GitLab API." >&2
  exit 2
fi

for iid in $issues; do
  row=$(printf '%s\n' "$states" | awk -F'\t' -v i="$iid" '$1 == i && !f { print; f = 1 }' || true)
  if [ -z "$row" ]; then
    echo ""
    echo "STALE SUPPRESSION: #${iid} could not be read (missing, moved, or no access)."
    echo "$markers" | grep -E "SUPPRESSED-UNTIL\(#${iid}\)" | sed 's/^/  /'
    stale=$((stale + 1))
    continue
  fi
  state=$(printf '%s' "$row" | cut -f2)
  checked=$((checked + 1))
  if [ "$state" != "opened" ]; then
    title=$(printf '%s' "$row" | cut -f3-)
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
