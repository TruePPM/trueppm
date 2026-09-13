#!/usr/bin/env bash
# scripts/tests/wt-prune.test.sh
#
# Unit test for how `wt prune` decides a worktree's branch has merged (#3747).
#
# The bug: prune counted a branch as merged only when its local tip was an
# ancestor of origin/main. A tip rewritten after its last push — an amend, a
# local rebase, a GitLab server-side rebase — never reaches main by SHA even
# though its content did, so prune warned "local commits NOT in origin/main" and
# kept the worktree forever. Merged worktrees piled up past the WIP cap.
#
# The fix must not trade a false keep for a false prune, so each widened path
# has a near-identical negative twin that must SURVIVE: a squash merge whose MR
# head does not match the local tip, and a branch where only SOME of the patches
# reached main. Each positive case also asserts the ancestor test really fails
# for it — otherwise it would pass on the unfixed script and prove nothing.
#
# `glab` is stubbed: the sandbox has no GitLab. A real glab would fail every MR
# lookup (so the squash case could never pass) and, through clear_lock, could
# act on the real project's issues.
#
# scripts/wt must stay bash-3.2 clean (macOS default bash); CI runs bash 5.
#
# Run: bash scripts/tests/wt-prune.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WT="$REPO_ROOT/scripts/wt"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() {
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# `glab api …` prints $GLAB_STUB_JSON (default: no MRs). Every other call — the
# issue label/note writes clear_lock makes — succeeds and does nothing.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/glab" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "api" ]]; then printf '%s\n' "${GLAB_STUB_JSON:-[]}"; fi
exit 0
EOF
chmod +x "$TMP/bin/glab"
export PATH="$TMP/bin:$PATH"
# Sandbox worktrees are seconds old; without this every case is a grace-window keep.
export TRUEPPM_WT_GRACE_MIN=0

# mk_repo <dir> — a repo on main with an origin holding main.
mk_repo() {
  local d="$1"
  mkdir -p "$d"
  ( cd "$d"
    git init -q -b main
    git config user.email t@t.co
    git config user.name  t
    echo base > README.md
    git add -A
    git commit -qm init
    git init -q --bare "$d.origin.git"
    git remote add origin "$d.origin.git"
    git push -q origin main
    git fetch -q origin
  )
}

# commit_in <dir> <name> — one commit adding <name>.txt.
commit_in() {
  echo "$2" > "$1/$2.txt"
  git -C "$1" add "$2.txt"
  git -C "$1" commit -qm "$2"
}

# add_wt <repo> <branch> <commits> — a worktree on <branch> with N commits, pushed
# WITH an upstream (prune skips never-pushed branches). Prints the worktree path.
add_wt() {
  local d="$1" b="$2" n="$3" p i
  p="$d.wt.${b//\//-}"
  git -C "$d" worktree add -q -b "$b" "$p" main 2>/dev/null
  for (( i = 1; i <= n; i++ )); do commit_in "$p" "${b//\//-}-$i"; done
  git -C "$p" push -q -u origin "$b" 2>/dev/null
  printf '%s' "$p"
}

# land <repo> <branch> — publish main and delete the branch on origin, which is
# what GitLab's merge + remove_source_branch_after_merge leaves behind.
land() {
  git -C "$1" push -q origin main 2>/dev/null
  git -C "$1" push -q origin --delete "$2" 2>/dev/null
}

RUN_OUT=""
prune_in() { # prune_in <repo> [glab json]
  set +e
  RUN_OUT="$( cd "$1" && GLAB_STUB_JSON="${2:-[]}" bash "$WT" prune 2>&1 )"
  set -e
}

not_ancestor() { # 0 when the branch tip is NOT in main's history
  ! git -C "$1" merge-base --is-ancestor "$2" main
}

# --- Case 1 (control): a merge-commit merge is pruned -----------------------
echo "Case 1: merge-commit merge"
D="$TMP/c1"; mk_repo "$D"
P="$(add_wt "$D" feat/1-merge 1)"
git -C "$D" merge -q --no-ff feat/1-merge -m "Merge feat/1-merge"
land "$D" feat/1-merge
prune_in "$D"
check "a merged, remote-deleted worktree is removed"  "$([[ ! -d "$P" ]]; echo $?)"
check "…with the report mass_merge relies on"         "$(printf '%s' "$RUN_OUT" | grep -q 'removed (merged to main, remote gone)'; echo $?)"

# --- Case 2: tip rewritten after its last push (the reported bug) -----------
echo "Case 2: local tip rewritten after push"
D="$TMP/c2"; mk_repo "$D"
P="$(add_wt "$D" chore/2-amended 1)"
git -C "$D" merge -q --no-ff chore/2-amended -m "Merge chore/2-amended"
land "$D" chore/2-amended
git -C "$P" commit -q --amend -m "reworded after the push"
check "precondition: the rewritten tip is not an ancestor of main" "$(not_ancestor "$D" chore/2-amended; echo $?)"
prune_in "$D"
check "a rewritten tip whose patch is in main is removed"  "$([[ ! -d "$P" ]]; echo $?)"
check "…and says why"                                      "$(printf '%s' "$RUN_OUT" | grep -q 'every patch already in main'; echo $?)"

# --- Case 3: squash merge, merged MR head == local tip ---------------------
echo "Case 3: squash merge matched by MR head"
D="$TMP/c3"; mk_repo "$D"
P="$(add_wt "$D" feat/3-squash 2)"
git -C "$D" merge -q --squash feat/3-squash >/dev/null && git -C "$D" commit -qm "squashed"
land "$D" feat/3-squash
TIP="$(git -C "$D" rev-parse feat/3-squash)"
check "precondition: not an ancestor"               "$(not_ancestor "$D" feat/3-squash; echo $?)"
CHERRY="$(git -C "$D" cherry main feat/3-squash)"
check "precondition: git cherry cannot see it"      "$([[ "$CHERRY" == *"+ "* ]]; echo $?)"
prune_in "$D" "[{\"iid\": 1, \"sha\": \"$TIP\"}]"
check "a squash merge whose MR head is the tip is removed" "$([[ ! -d "$P" ]]; echo $?)"

# --- Case 4: squash merge, but the MR head is NOT the local tip -------------
# The local branch carries a commit the merged MR never had. Must survive.
echo "Case 4: squash merge, MR head differs"
D="$TMP/c4"; mk_repo "$D"
P="$(add_wt "$D" feat/4-squash 2)"
git -C "$D" merge -q --squash feat/4-squash >/dev/null && git -C "$D" commit -qm "squashed"
land "$D" feat/4-squash
prune_in "$D" '[{"iid": 1, "sha": "0000000000000000000000000000000000000000"}]'
check "a squash merge whose MR head differs is kept"  "$([[ -d "$P" ]]; echo $?)"
check "…with the not-in-main warning"                 "$(printf '%s' "$RUN_OUT" | grep -q 'NOT in origin/main'; echo $?)"

# --- Case 5: only some of the branch's patches reached main -----------------
echo "Case 5: partially landed branch"
D="$TMP/c5"; mk_repo "$D"
P="$(add_wt "$D" fix/5-partial 2)"
git -C "$D" cherry-pick "$(git -C "$P" rev-parse HEAD~1)" >/dev/null
land "$D" fix/5-partial
prune_in "$D"
check "a branch with an unlanded patch is kept"       "$([[ -d "$P" ]]; echo $?)"

# --- Case 6: a tracked harness file is not work; a tracked source file is ---
echo "Case 6: tracked .envrc vs tracked source change"
D="$TMP/c6"; mk_repo "$D"
echo "export A=1" > "$D/.envrc"
git -C "$D" add .envrc && git -C "$D" commit -qm "track envrc" && git -C "$D" push -q origin main 2>/dev/null
P="$(add_wt "$D" feat/6-envrc 1)"
Q="$(add_wt "$D" feat/6-readme 1)"
git -C "$D" merge -q --no-ff feat/6-envrc  -m "Merge feat/6-envrc"
git -C "$D" merge -q --no-ff feat/6-readme -m "Merge feat/6-readme"
land "$D" feat/6-envrc
git -C "$D" push -q origin --delete feat/6-readme 2>/dev/null
echo "export A=2" > "$P/.envrc"
echo "local edit" >> "$Q/README.md"
prune_in "$D"
check "a merged worktree with only a modified tracked .envrc is removed" "$([[ ! -d "$P" ]]; echo $?)"
check "a merged worktree with a modified tracked source file is kept"   "$([[ -d "$Q" ]]; echo $?)"

# --- Case 7: the new code stays bash-3.2 clean -----------------------------
echo "Case 7: bash-3.2 constructs"
body="$(awk '/^merged_mr_has_sha\(\) \{/,/^cmd_prune\(\) \{/' "$WT")"
check "helpers were found (guards the static check below)" "$([[ -n "$body" ]]; echo $?)"
check "no bash-4 constructs (mapfile, declare -A, \${x,,})" \
      "$(grep -Eq 'mapfile|readarray|declare -A|\$\{[a-z_]+,,\}' <<<"$body" && echo 1 || echo 0)"

echo ""
echo "wt-prune: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
