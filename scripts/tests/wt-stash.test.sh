#!/usr/bin/env bash
# scripts/tests/wt-stash.test.sh
#
# Unit test for `wt stash` — the worktree-private stash (#3110).
#
# `git stash` writes refs/stash, which lives in the git COMMON dir and is therefore
# shared by every worktree of a repo. Worktree A pushes, worktree B pushes, and A's
# `pop` applies B's work into A's tree — then DROPS it, because a clean apply is
# what `pop` drops on. Nothing in either session's output names what happened, and
# there is no pre-stash hook to intercept it, so the only fix is a replacement that
# does not touch refs/stash at all.
#
# Case 1 is therefore the load-bearing one: it reproduces the two-worktree
# interleaving against REAL git and asserts each worktree gets its OWN work back.
# Run it against `git stash` instead of `wt stash` and it fails — that is the
# regression this file exists to prevent.
#
# Same sandbox approach as wt-reserve.test.sh: stage throwaway repos and run the
# REAL script against them, so nothing here depends on this checkout's state.
#
# scripts/wt must stay bash-3.2 clean (macOS default bash); CI runs bash 5 and
# cannot catch a 3.2 regression functionally, so Case 5 guards it statically.
#
# Run: bash scripts/tests/wt-stash.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WT="$REPO_ROOT/scripts/wt"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# mk_repo <dir> — a git repo with one tracked file and an initial commit.
mk_repo() {
  local d="$1"
  mkdir -p "$d"
  ( cd "$d"
    git init -q
    git config user.email t@t.co
    git config user.name  t
    printf 'base\n' > tracked.txt
    git add -A
    git commit -qm init
  )
}

# --- Case 1: two worktrees do not see each other's stashes -----------------
# The #3110 interleaving, verbatim. A stashes, B stashes, then A pops: A must get
# A's line back, not B's, and B's entry must still be there afterwards.
echo "Case 1: stashes are private to their worktree"
D1="$TMP/case1"; mk_repo "$D1"
export TRUEPPM_WT_BASE="$TMP/case1-wts"
( cd "$D1" && git branch feat/a && git branch feat/b
  git worktree add -q "$TRUEPPM_WT_BASE/a" feat/a
  git worktree add -q "$TRUEPPM_WT_BASE/b" feat/b )

printf 'A-work\n' >> "$TRUEPPM_WT_BASE/a/tracked.txt"
( cd "$TRUEPPM_WT_BASE/a" && bash "$WT" stash push "A's work" >/dev/null 2>&1 )

printf 'B-work\n' >> "$TRUEPPM_WT_BASE/b/tracked.txt"
( cd "$TRUEPPM_WT_BASE/b" && bash "$WT" stash push "B's work" >/dev/null 2>&1 )

check "A's tree was reset by the stash" \
  "$(! grep -q 'A-work' "$TRUEPPM_WT_BASE/a/tracked.txt"; echo $?)"
check "B's tree was reset by the stash" \
  "$(! grep -q 'B-work' "$TRUEPPM_WT_BASE/b/tracked.txt"; echo $?)"

# The assertion the shared stack fails: A pops AFTER B pushed.
( cd "$TRUEPPM_WT_BASE/a" && bash "$WT" stash pop >/dev/null 2>&1 )
check "A gets A's work back, not B's" \
  "$(grep -q 'A-work' "$TRUEPPM_WT_BASE/a/tracked.txt"; echo $?)"
check "A did NOT receive B's work" \
  "$(! grep -q 'B-work' "$TRUEPPM_WT_BASE/a/tracked.txt"; echo $?)"

# And B's entry survived A's pop entirely.
b_list="$( cd "$TRUEPPM_WT_BASE/b" && bash "$WT" stash list 2>/dev/null )"
check "B's entry still exists after A popped" \
  "$(printf '%s' "$b_list" | grep -q "B's work"; echo $?)"
( cd "$TRUEPPM_WT_BASE/b" && bash "$WT" stash pop >/dev/null 2>&1 )
check "B gets B's work back" \
  "$(grep -q 'B-work' "$TRUEPPM_WT_BASE/b/tracked.txt"; echo $?)"

# --- Case 2: refs/stash is never touched -----------------------------------
# The guarantee that makes Case 1 hold for a session using plain `git stash` too:
# `wt stash` must be invisible to it, in both directions.
echo "Case 2: refs/stash is left alone"
shared="$( cd "$D1" && git stash list 2>/dev/null | wc -l | tr -d ' ' )"
check "refs/stash is still empty after four wt-stash operations" \
  "$([[ "$shared" == "0" ]]; echo $?)"
# Asserted on a fresh repo rather than $D1, whose two entries were both popped
# above — a namespace check has to run while an entry actually exists.
D2="$TMP/case2"; mk_repo "$D2"
( cd "$D2" && printf 'ns\n' >> tracked.txt && bash "$WT" stash push "ns" >/dev/null 2>&1 )
check "entries live under refs/wt-stash/" \
  "$(cd "$D2" && git for-each-ref --format='%(refname)' refs/wt-stash | grep -q .; echo $?)"
check "and refs/stash stays empty in that repo too" \
  "$(cd "$D2" && [[ "$(git stash list | wc -l | tr -d ' ')" == "0" ]]; echo $?)"

# --- Case 3: pop is not destructive when apply fails -----------------------
# `git stash pop` drops the entry on a clean apply. If a conflicting local change
# makes the apply fail, the entry MUST survive — losing it would be exactly the
# data loss #3110 is about, reintroduced from the other direction.
echo "Case 3: a failed apply keeps the entry"
D3="$TMP/case3"; mk_repo "$D3"
( cd "$D3" && printf 'stashed change\n' > tracked.txt && bash "$WT" stash push "c3" >/dev/null 2>&1 )
( cd "$D3" && printf 'conflicting local change\n' > tracked.txt )
( cd "$D3" && bash "$WT" stash pop >/dev/null 2>&1 ) || true
c3_list="$( cd "$D3" && bash "$WT" stash list 2>/dev/null )"
check "the entry survives a failed apply" \
  "$(printf '%s' "$c3_list" | grep -q 'c3'; echo $?)"

# --- Case 4: stack semantics and the clean-tree case -----------------------
echo "Case 4: stack semantics"
D4="$TMP/case4"; mk_repo "$D4"
( cd "$D4" && printf 'first\n' >> tracked.txt && bash "$WT" stash push "one" >/dev/null 2>&1 )
( cd "$D4" && printf 'second\n' >> tracked.txt && bash "$WT" stash push "two" >/dev/null 2>&1 )
d4_list="$( cd "$D4" && bash "$WT" stash list 2>/dev/null )"
check "both entries are listed"  "$(printf '%s' "$d4_list" | grep -q 'one' && printf '%s' "$d4_list" | grep -q 'two'; echo $?)"
( cd "$D4" && bash "$WT" stash pop >/dev/null 2>&1 )
check "pop restores the NEWEST entry" \
  "$(grep -q 'second' "$D4/tracked.txt"; echo $?)"
after="$( cd "$D4" && bash "$WT" stash list 2>/dev/null )"
check "the older entry remains after the pop" \
  "$(printf '%s' "$after" | grep -q 'one'; echo $?)"

# A clean tree is not an error, and must not report a save that did not happen.
D4b="$TMP/case4b"; mk_repo "$D4b"
clean_out="$( cd "$D4b" && bash "$WT" stash push 2>&1 )"
check "a clean worktree says nothing to stash, exit 0" \
  "$(printf '%s' "$clean_out" | grep -q 'nothing to stash'; echo $?)"
check "and creates no ref" \
  "$(cd "$D4b" && [[ -z "$(git for-each-ref --format='%(refname)' refs/wt-stash)" ]]; echo $?)"

# --- Case 5: bash 3.2 compatibility (static) -------------------------------
# scripts/wt runs on the macOS default bash (3.2). CI runs bash 5, so a 3.2-only
# regression passes functionally here — guard the constructs statically instead.
echo "Case 5: bash 3.2 compatibility"
check "no associative arrays (declare -A)" \
  "$(! grep -qE '^\s*(declare|local|typeset)\s+-A\b' "$WT"; echo $?)"
check "no \${var,,} / \${var^^} case conversion" \
  "$(! grep -qE '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?[,^]{1,2}\}' "$WT"; echo $?)"
check "no mapfile/readarray" \
  "$(! grep -qE '\b(mapfile|readarray)\b' "$WT"; echo $?)"
check "wt parses under bash -n" \
  "$(bash -n "$WT" 2>/dev/null; echo $?)"

echo ""
echo "wt-stash: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
