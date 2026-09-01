#!/usr/bin/env bash
# scripts/tests/wt-args.test.sh
#
# Unit test for scripts/wt's ARGUMENT handling (#3283).
#
# The bug: `wt new --help` did not print help. Every subcommand's parser ends in
# a `*)` catch-all that takes an unrecognised token as the branch name / issue /
# needle, and the top-level dispatcher only handles `--help` as the FIRST
# argument. So `wt new --help` created a branch called `feat/help`, a worktree,
# and an ADR reservation — silently, and reporting success.
#
# What that means for this test: asserting the exit code is not enough. A `wt`
# that printed usage AND created a worktree would pass an exit-code-only check,
# so every help case here also asserts that **nothing was created** — that is the
# half of the bug that actually cost something.
#
# The generalised rule matters more than the reported instance: any leading-dash
# token a subcommand does not declare is rejected. A mistyped `--forse` becoming
# a branch name is the same defect with a worse name, and help-only special
# casing would not have caught it.
#
# Same sandbox approach as wt-reserve.test.sh: scripts/wt derives REPO_ROOT and
# the git common dir from the repo it runs in, so each case stages a throwaway
# repo and runs the REAL script against it.
#
# scripts/wt must stay bash-3.2 clean (macOS default bash); CI runs bash 5.
#
# Run: bash scripts/tests/wt-args.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WT="$REPO_ROOT/scripts/wt"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
# Run a command that is EXPECTED to fail and capture both halves. `set -e` would
# otherwise abort the suite at the first rejected flag — which is most of the
# point of this file.
# `run <dir> <cmd...>` — a subshell `cd` rather than `env -C`, which is not
# portable to every env(1) this repo's macOS release machine might have.
RUN_OUT=""
RUN_RC=0
run() {
  local d="$1"; shift
  set +e
  RUN_OUT="$( cd "$d" && "$@" 2>&1 )"
  RUN_RC=$?
  set -e
}
check() {
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# A sandbox repo WITH an origin holding `main`.
#
# The origin is not decoration. `cmd_new` fetches origin and branches off
# origin/main, so without one it dies before creating anything — which would make
# the "created nothing" assertions in Cases 1 and 3 pass no matter what the code
# does. They are the assertions that capture what this bug actually cost, so the
# sandbox has to be able to fail them. Case 0 proves it can.
mk_repo() {
  local d="$1"
  mkdir -p "$d/docs/adr"
  : > "$d/docs/adr/0216-existing-decision.md"
  ( cd "$d"
    git init -q -b main
    git config user.email t@t.co
    git config user.name  t
    git add -A
    git commit -qm init
    git init -q --bare "$d.origin.git"
    git remote add origin "$d.origin.git"
    git push -q origin main
    git fetch -q origin
  )
}

# Count everything `wt new` would create, so a case can prove it created none.
side_effects() { # side_effects <repo>
  local d="$1" wts brs led
  wts="$( (cd "$d" && git worktree list 2>/dev/null | wc -l) | tr -d ' ' )"
  brs="$( (cd "$d" && git branch --list 2>/dev/null | wc -l) | tr -d ' ' )"
  led="$( [[ -f "$d/.git/trueppm-wt-reservations.tsv" ]] \
            && wc -l < "$d/.git/trueppm-wt-reservations.tsv" | tr -d ' ' || echo 0 )"
  printf '%s/%s/%s' "$wts" "$brs" "$led"
}

# --- Case 0: the harness can SEE a worktree being created ------------------
# Without this, Cases 1 and 3's "created nothing" assertions are unfalsifiable:
# a sandbox where `wt new` can never succeed passes them trivially. This is the
# control that makes the rest of the file mean something.
echo "Case 0: the sandbox can observe a real creation"
D0="$TMP/case0"; mk_repo "$D0"
before0="$(side_effects "$D0")"
run "$D0" bash "$WT" new chore/a-real-branch --no-adr
after0="$(side_effects "$D0")"
check "a valid 'wt new' does change the counters" "$([[ "$before0" != "$after0" ]]; echo $?)"
check "…and creates the branch"                   "$(git -C "$D0" show-ref --verify --quiet refs/heads/chore/a-real-branch; echo $?)"

# --- Case 1: `--help` on a subcommand prints usage and creates nothing -----
echo "Case 1: subcommand --help is help, not a branch name"
D1="$TMP/case1"; mk_repo "$D1"
before="$(side_effects "$D1")"
run "$D1" bash "$WT" new --help; out="$RUN_OUT"; rc="$RUN_RC"
after="$(side_effects "$D1")"
check "wt new --help exits 0"                    "$([[ "$rc" -eq 0 ]]; echo $?)"
check "…prints the subcommand's usage"           "$(printf '%s' "$out" | grep -q 'usage: wt new'; echo $?)"
# The half an exit-code check misses. Before #3283 this line failed while the
# assertions above would both have passed.
check "…and creates NO branch, worktree or reservation" \
      "$([[ "$before" == "$after" ]]; echo $?)"

# --- Case 2: -h works too, on more than one subcommand --------------------
echo "Case 2: -h across subcommands"
D2="$TMP/case2"; mk_repo "$D2"
for sub in new remove claim release prune doctor list; do
  run "$D2" bash "$WT" "$sub" -h; o="$RUN_OUT"; r="$RUN_RC"
  check "wt $sub -h exits 0"                     "$([[ "$r" -eq 0 ]]; echo $?)"
  check "wt $sub -h prints a usage line"         "$(printf '%s' "$o" | grep -q '^usage: wt '; echo $?)"
done

# --- Case 3: an undeclared flag is rejected, not adopted as input ----------
echo "Case 3: a mistyped flag is rejected"
D3="$TMP/case3"; mk_repo "$D3"
before="$(side_effects "$D3")"
run "$D3" bash "$WT" new --forse; out="$RUN_OUT"; rc="$RUN_RC"
after="$(side_effects "$D3")"
check "a typo'd flag exits 2 (rejected, not consumed)" "$([[ "$rc" -eq 2 ]]; echo $?)"
check "…names the offending option"                    "$(printf '%s' "$out" | grep -q 'unknown option: --forse'; echo $?)"
check "…creates nothing"                               "$([[ "$before" == "$after" ]]; echo $?)"

# --- Case 4: declared flags still reach the subcommand's own parser --------
# The guard must not become a wall. `wt new --force` with no issue has to fall
# through to cmd_new's own empty-input check (exit 1 via die), NOT be rejected by
# the guard (exit 2). Distinguishing the two codes is the whole assertion.
echo "Case 4: declared flags pass through"
D4="$TMP/case4"; mk_repo "$D4"
run "$D4" bash "$WT" new --force; rc="$RUN_RC"
check "wt new --force reaches cmd_new (exit 1, not 2)" "$([[ "$rc" -eq 1 ]]; echo $?)"

# `subcmd_flags` is a SECOND copy of what each parser accepts, so it can drift
# from the parser it mirrors — and drift here is not cosmetic, it is a working
# flag the guard now refuses before the subcommand runs. It drifted on the first
# draft of #3283 in both directions: `prune-dbs` was declared --force when it
# gates on --yes, and `remove` was declared nothing at all though it reads
# --force as its second positional. Neither `wt new --force` nor an exit-code
# check on one subcommand can see that. Every real flag gets a line here.
while IFS= read -r argv; do
  [[ -n "$argv" ]] || continue
  # shellcheck disable=SC2086  # argv is a test-authored literal, split on purpose
  run "$D4" bash "$WT" $argv; r="$RUN_RC"; o="$RUN_OUT"
  check "wt $argv reaches its own parser, not the guard" \
        "$( [[ "$r" -ne 2 ]] && ! printf '%s' "$o" | grep -q 'unknown option'; echo $? )"
done <<'ARGS'
new --adr
new --no-adr
claim --force
remove no-such-worktree --force
prune --force
prune-dbs --yes
ARGS

# --- Case 5: a stash message may begin with a dash ------------------------
# Only `stash`'s sub-subcommand is guarded; the message is data. A guard applied
# to every token would make this message unusable.
echo "Case 5: stash messages are not parsed as flags"
D5="$TMP/case5"; mk_repo "$D5"
echo change >> "$D5/docs/adr/0216-existing-decision.md"
run "$D5" bash "$WT" stash push "-- notes from the rebase"; rc="$RUN_RC"
check "a leading-dash stash message is accepted"  "$([[ "$rc" -eq 0 ]]; echo $?)"

# --- Case 6: doctor finds a reservation whose branch is gone --------------
# `wt remove`/`wt prune` release reservations themselves; this covers what a path
# that BYPASSED wt stranded (a raw `git worktree remove`, a hand-deleted branch).
echo "Case 6: orphaned reservation detection"
D6="$TMP/case6"; mk_repo "$D6"
run "$D6" bash "$WT" reserve adr
led="$D6/.git/trueppm-wt-reservations.tsv"
printf 'adr\t-\t0999\tfeat/branch-that-never-existed\t2026-01-01T00:00:00Z\n' >> "$led"
run "$D6" bash "$WT" doctor; out="$RUN_OUT"
check "doctor reports the orphaned reservation"   "$(printf '%s' "$out" | grep -q 'branch feat/branch-that-never-existed'; echo $?)"
# The live one must NOT be reported: a branch that merely has no worktree yet is
# the normal case, and flagging it would train people to ignore this warning.
live_branch="$(git -C "$D6" rev-parse --abbrev-ref HEAD)"
check "…and does NOT report the live branch's row" \
      "$(printf '%s' "$out" | grep -q "branch ${live_branch}\$" && echo 1 || echo 0)"

# --- Case 7: release-reservation is the way out, and refuses a live branch -
echo "Case 7: release-reservation"
D7="$TMP/case7"; mk_repo "$D7"
run "$D7" bash "$WT" reserve adr
led7="$D7/.git/trueppm-wt-reservations.tsv"
printf 'adr\t-\t0999\tfeat/gone\t2026-01-01T00:00:00Z\n' >> "$led7"
run "$D7" bash "$WT" release-reservation feat/gone; rc="$RUN_RC"
check "releases an orphaned branch's rows"        "$([[ "$rc" -eq 0 ]]; echo $?)"
check "…and the row is gone"                      "$(grep -q 'feat/gone' "$led7" && echo 1 || echo 0)"
live7="$(git -C "$D7" rev-parse --abbrev-ref HEAD)"
run "$D7" bash "$WT" release-reservation "$live7"; rc="$RUN_RC"
check "refuses a branch that still exists"        "$([[ "$rc" -ne 0 ]]; echo $?)"
check "…leaving its reservation intact"           "$(grep -q "	${live7}	" "$led7"; echo $?)"

# --- Case 8: bash 3.2 cleanliness (static) --------------------------------
# CI runs bash 5 and cannot catch a 3.2 regression functionally; the release
# machine is macOS. Same static approach as assemble-changelog.test.sh.
echo "Case 8: bash 3.2 cleanliness of the new code"
check "no associative arrays (declare -A)"        "$(grep -q 'declare -A' "$WT" && echo 1 || echo 0)"
check "no \${var,,} / \${var^^} case conversion"    "$(grep -qE '\$\{[A-Za-z_]+(\^\^|,,)' "$WT" && echo 1 || echo 0)"
check "script parses under bash -n"               "$(bash -n "$WT"; echo $?)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "wt-args.test.sh: all $pass checks passed."
else
  echo "wt-args.test.sh: $fail of $((pass + fail)) checks FAILED." >&2
  exit 1
fi
