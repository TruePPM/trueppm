#!/usr/bin/env bash
# scripts/tests/wt-reserve.test.sh
#
# Unit test for the number-reservation feature of scripts/wt — the atomic ADR /
# migration number claim that stops parallel worktree agents from all grabbing the
# same number (the recurring three-way ADR / double-migration collisions the CI
# gate had to bounce). The reservation logic has no other harness, and a break here
# silently reintroduces the collision class, so guard it directly.
#
# Also covers `wt remove`'s status::wip check-out label gating (#2693): 24 closed
# 0.4 issues were found still carrying the label because nothing cleared it after
# their worktree was torn down. Case 6 stubs `glab` (no network, no real GitLab
# project) to prove `wt remove` clears the label when the issue is closed and
# leaves it alone when the issue is still open — this is the only harness for
# scripts/wt, so the gating logic is guarded here rather than left unverified.
#
# scripts/wt derives REPO_ROOT / the git common dir from the repo it is run in, so
# each case stages a throwaway git repo and runs the REAL script against it. The
# ledger lives in that sandbox's .git, so cases are fully isolated.
#
# scripts/wt must stay bash-3.2 clean (it runs on the macOS default bash); CI runs
# bash 5 and cannot catch a 3.2 regression functionally, so Case 5 guards it
# statically — the same approach as assemble-changelog.test.sh.
#
# Run: bash scripts/tests/wt-reserve.test.sh

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

# mk_repo <dir> — a self-contained git repo with an ADR dir and a Django app
# migrations dir seeded with one existing number each, plus an initial commit
# (ls-tree of the branch tip needs a commit to resolve).
mk_repo() {
  local d="$1"
  mkdir -p "$d/docs/adr" \
           "$d/packages/api/src/trueppm_api/apps/notifications/migrations" \
           "$d/packages/api/src/trueppm_api/apps/scheduling/migrations"
  : > "$d/docs/adr/0216-existing-decision.md"
  : > "$d/packages/api/src/trueppm_api/apps/notifications/migrations/0006_seed.py"
  : > "$d/packages/api/src/trueppm_api/apps/scheduling/migrations/0002_seed.py"
  # A web rule list for the #3284 rule-number sequence. Deliberately NOT
  # zero-padded and of mixed width — that is how the real file writes them, and a
  # matcher borrowed from the 4-digit ADR helper would score every one as zero.
  mkdir -p "$d/packages/web"
  printf '%s\n' '9. **An early rule.** Body.' '## Heading' '367. **The current highest.** Body.' \
    > "$d/packages/web/CLAUDE.md"
  ( cd "$d"
    git init -q
    git config user.email t@t.co
    git config user.name  t
    git add -A
    git commit -qm init
  )
}

# --- Case 1: sequential ADR reservation is ledger-aware --------------------
# On-disk max is 0216 and never changes, but each reservation must still advance
# because the ledger remembers the outstanding claims.
echo "Case 1: sequential ADR reservation"
D1="$TMP/case1"; mk_repo "$D1"
a1="$(cd "$D1" && bash "$WT" reserve adr 2>/dev/null)"
a2="$(cd "$D1" && bash "$WT" reserve adr 2>/dev/null)"
a3="$(cd "$D1" && bash "$WT" reserve adr 2>/dev/null)"
check "first reservation is 0217 (max on disk + 1)" "$([[ "$a1" == "0217" ]]; echo $?)"
check "second advances to 0218 (ledger-aware)"      "$([[ "$a2" == "0218" ]]; echo $?)"
check "third advances to 0219"                      "$([[ "$a3" == "0219" ]]; echo $?)"
check "numbers are zero-padded to 4 digits"         "$([[ "$a1" =~ ^[0-9]{4}$ ]]; echo $?)"
check ".wt-reservation records the ADR claim"       "$(grep -qx 'adr=0217' "$D1/.wt-reservation"; echo $?)"
check "ledger file created in .git"                 "$([[ -f "$D1/.git/trueppm-wt-reservations.tsv" ]]; echo $?)"

# --- Case 2: migration numbers are per-app, independent --------------------
echo "Case 2: per-app migration reservation"
D2="$TMP/case2"; mk_repo "$D2"
m1="$(cd "$D2" && bash "$WT" reserve migration notifications 2>/dev/null)"
m2="$(cd "$D2" && bash "$WT" reserve migration notifications 2>/dev/null)"
s1="$(cd "$D2" && bash "$WT" reserve migration scheduling 2>/dev/null)"
check "notifications starts at 0007 (0006 on disk + 1)" "$([[ "$m1" == "0007" ]]; echo $?)"
check "notifications advances to 0008"                  "$([[ "$m2" == "0008" ]]; echo $?)"
check "scheduling is independent, starts at 0003"       "$([[ "$s1" == "0003" ]]; echo $?)"
check "unknown app is rejected" \
  "$(cd "$D2" && bash "$WT" reserve migration nope >/dev/null 2>&1; [[ $? -ne 0 ]]; echo $?)"

# --- Case 3: concurrency — parallel reservations never collide -------------
# The whole point of the lock. Fire many reservations at once; every number must
# be distinct and the range contiguous.
echo "Case 3: concurrent reservations are collision-free"
D3="$TMP/case3"; mk_repo "$D3"
OUT="$D3/out"; : > "$OUT"
N=12
for _ in $(seq 1 "$N"); do
  ( cd "$D3" && bash "$WT" reserve adr 2>/dev/null >> "$OUT" ) &
done
wait
total="$(wc -l < "$OUT" | tr -d ' ')"
distinct="$(sort -u "$OUT" | wc -l | tr -d ' ')"
check "all $N reservations succeeded"                "$([[ "$total" == "$N" ]]; echo $?)"
check "every reserved number is distinct (no race)"  "$([[ "$total" == "$distinct" ]]; echo $?)"
check "range is contiguous 0217..0228"               "$([[ "$(sort "$OUT" | head -1)" == "0217" && "$(sort "$OUT" | tail -1)" == "0228" ]]; echo $?)"
check "lock dir released after run"                  "$([[ ! -d "$D3/.git/trueppm-wt-reservations.lock" ]]; echo $?)"

# --- Case 4: remove releases a branch's reservations -----------------------
# End-to-end wiring: reserve inside a worktree, then `wt remove` it and confirm the
# reservation rows for that branch are gone (freeing the number for reuse). A
# no-issue-number branch is used so `wt remove` never reaches for glab.
echo "Case 4: remove frees the branch's reservations"
D4="$TMP/case4"; mk_repo "$D4"
WTDIR="$TMP/case4-wts"
export TRUEPPM_WT_BASE="$WTDIR"
( cd "$D4" && git branch chore/reltest && git worktree add -q "$WTDIR/reltest" chore/reltest )
rnum="$(cd "$WTDIR/reltest" && bash "$WT" reserve adr 2>/dev/null)"
check "reservation made inside the worktree"      "$([[ "$rnum" == "0217" ]]; echo $?)"
check "ledger has the chore/reltest row"          "$(grep -q 'chore/reltest' "$D4/.git/trueppm-wt-reservations.tsv"; echo $?)"
( cd "$D4" && bash "$WT" remove reltest >/dev/null 2>&1 )
check "ledger no longer has chore/reltest rows" \
  "$(! grep -q 'chore/reltest' "$D4/.git/trueppm-wt-reservations.tsv"; echo $?)"
# After release, the freed number is reused on the next reservation.
rnum2="$(cd "$D4" && bash "$WT" reserve adr 2>/dev/null)"
check "freed number 0217 is reused after release" "$([[ "$rnum2" == "0217" ]]; echo $?)"
unset TRUEPPM_WT_BASE

# --- Case 6: remove gates the status::wip label on GitLab issue state ------
# #2693: `wt remove` used to release the check-out unconditionally, so a
# closed issue's label only cleared if someone remembered to run `wt release`
# separately — and 24 closed 0.4 issues were found still carrying it. The fix
# checks the issue's live state: clear the label when GitLab shows it closed,
# leave it alone when the worktree is torn down without merging (issue still
# open, so the label is the only signal a parallel agent has left that it's
# spoken for). `glab` is stubbed here — it returns a fixed `state` per issue
# number and logs every invocation, so the label-clearing call itself (not
# just its precondition) is directly assertable.
echo "Case 6: remove clears status::wip only when the issue is closed"
D6="$TMP/case6"; mk_repo "$D6"
GSTUB="$TMP/glab-bin"; mkdir -p "$GSTUB"
GLOG="$TMP/glab-calls.log"
cat > "$GSTUB/glab" <<'STUBEOF'
#!/usr/bin/env bash
{ echo "ARGV: $*"; } >> "$GLAB_STUB_LOG"
if [[ "$1 $2" == "issue view" ]]; then
  case "$3" in
    9001) printf '{"state":"closed"}' ;;
    9002) printf '{"state":"opened"}' ;;
    *)    printf '{}' ;;
  esac
fi
exit 0
STUBEOF
chmod +x "$GSTUB/glab"
export GLAB_STUB_LOG="$GLOG"

WTDIR6="$TMP/case6-wts"
export TRUEPPM_WT_BASE="$WTDIR6"
( cd "$D6" && git branch fix/9001-closed-thing && git worktree add -q "$WTDIR6/9001-closed-thing" fix/9001-closed-thing )
( cd "$D6" && git branch fix/9002-open-thing   && git worktree add -q "$WTDIR6/9002-open-thing"   fix/9002-open-thing )

: > "$GLOG"
( cd "$D6" && PATH="$GSTUB:$PATH" bash "$WT" remove 9001 >/dev/null 2>&1 )
check "closed issue: state was checked"       "$(grep -q 'issue view 9001 --output json' "$GLOG"; echo $?)"
check "closed issue: label-clear call made"   "$(grep -q 'issue update 9001 --unlabel status::wip' "$GLOG"; echo $?)"

: > "$GLOG"
( cd "$D6" && PATH="$GSTUB:$PATH" bash "$WT" remove 9002 >/dev/null 2>&1 )
check "open issue: state was checked"         "$(grep -q 'issue view 9002 --output json' "$GLOG"; echo $?)"
check "open issue: label-clear call NOT made" "$(! grep -q 'issue update 9002 --unlabel status::wip' "$GLOG"; echo $?)"

unset TRUEPPM_WT_BASE GLAB_STUB_LOG

# --- Case 5: wiring + bash 3.2 portability guards --------------------------
echo "Case 5: wiring + bash 3.2 portability"
check "cmd_new auto-reserves ADRs for feat branches" "$(grep -q 'reserve_adr' "$WT"; echo $?)"
check "cmd_new honors --adr/--no-adr"                "$(grep -qE '\-\-no-adr' "$WT"; echo $?)"
check "remove releases reservations"                 "$(grep -q 'ledger_release_branch "\$rm_branch"' "$WT"; echo $?)"
check "prune releases reservations"                  "$(grep -q 'ledger_release_branch "\$branch"' "$WT"; echo $?)"
check "remove gates label-clear on issue state"      "$(grep -q 'issue_is_closed "\$rm_issue"' "$WT"; echo $?)"
check ".wt-reservation is allowlisted in dirty check" "$(grep -q '\\.wt-reservation' "$WT"; echo $?)"
CODE="$(grep -vE '^[[:space:]]*#' "$WT")"
if printf '%s\n' "$CODE" | grep -qE 'declare -A|mapfile|readarray|local -n'; then r=1; else r=0; fi
check "no bash 4+ constructs (declare -A/mapfile/readarray/local -n)" "$r"
if printf '%s\n' "$CODE" | grep -qE '\$\{[A-Za-z_][A-Za-z0-9_]*\^'; then r=1; else r=0; fi
check "no \${var^} case-conversion expansion" "$r"

# --- Case 9: web rule numbers are a reservable sequence (#3284) ------------
# The collision this prevents exists ONLY on the merged tree: #3134 and #3263 both
# minted 368 while each was correct alone, and the rebase merged two distinct
# adjacent lines with no conflict.
echo "Case 9: web rule reservation"
D9="$TMP/case9"; mk_repo "$D9"
r1="$(cd "$D9" && bash "$WT" reserve rule 2>/dev/null)"
r2="$(cd "$D9" && bash "$WT" reserve rule 2>/dev/null)"
check "first rule is 368 (highest in the file + 1)" "$([[ "$r1" == "368" ]]; echo $?)"
check "second advances to 369 (ledger-aware)"       "$([[ "$r2" == "369" ]]; echo $?)"
# The bug a 4-digit matcher would cause: nothing matches, max stays 0, every
# caller gets 1. Pinning the value rules that out; pinning "not 1" would not.
check "…and NOT 1 (the 4-digit-matcher failure)"    "$([[ "$r1" != "1" ]]; echo $?)"
check ".wt-reservation records the rule claim"      "$(grep -qx 'rule=368' "$D9/.wt-reservation"; echo $?)"

# A heading like `## 9999 things` must not outrank the list: the matcher is
# anchored to a line-leading `<n>.` for exactly this reason.
printf '%s\n' '## 9999 things' >> "$D9/packages/web/CLAUDE.md"
r3="$(cd "$D9" && bash "$WT" reserve rule 2>/dev/null)"
check "a bare number in a heading does not outrank it" "$([[ "$r3" == "370" ]]; echo $?)"

# --- Case 10: a reservation can be handed back ----------------------------
echo "Case 10: releasing your own reservation"
D10="$TMP/case10"; mk_repo "$D10"
( cd "$D10" && bash "$WT" reserve rule ) >/dev/null 2>&1
own="$( git -C "$D10" rev-parse --abbrev-ref HEAD )"
set +e
( cd "$D10" && bash "$WT" release-reservation "$own" ) >/dev/null 2>&1
rc=$?
set -e
check "own branch's reservation is releasable"      "$([[ "$rc" -eq 0 ]]; echo $?)"
# …and the number is genuinely free again, not merely unlisted.
r4="$(cd "$D10" && bash "$WT" reserve rule 2>/dev/null)"
check "the released number is handed out again"     "$([[ "$r4" == "368" ]]; echo $?)"

echo ""
echo "wt-reserve: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
