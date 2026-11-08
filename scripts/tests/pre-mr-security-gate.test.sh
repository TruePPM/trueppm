#!/usr/bin/env bash
# scripts/tests/pre-mr-security-gate.test.sh — the pre-MR security gate hook
# fires on the event it actually claims to cover now: a `glab mr create`
# Bash call, not the literal string "/mr" in a user prompt (issue #4867).
#
# The hook is not itself a CI gate — it is a Claude Code PreToolUse hook, so
# it has no job of its own in .gitlab-ci.yml. This is the bucket
# scripts/tests/wt-args.test.sh models: hermetic, no gate job to piggyback
# on, run from the tooling self-tests job in .gitlab-ci.yml.
#
# Each case feeds a fabricated PreToolUse event (the shape
# `{"tool_name":"Bash","tool_input":{"command":"..."}}`) to the hook's stdin
# from inside a throwaway git repo, and asserts on its JSON output:
# `permissionDecision: "deny"` (blocked, with a reason) or no output at all
# (the hook exits 0 silently — the common case, and the one that must stay
# free for every non-MR Bash call).

# Fixtures are literal command text fed to the hook; single quotes are deliberate.
# shellcheck disable=SC2016
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.claude/hooks/pre-mr-security-gate.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rc=0
pass() { echo "SELF-TEST OK: $1"; }
fail() { echo "SELF-TEST FAILED: $1" >&2; rc=1; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# Builds a throwaway repo at $TMP/<name> with `origin/main` at an empty root
# commit and `feat/x` checked out with the given files added on top.
# <name> <file:content pairs...>
make_repo() {
  local name="$1"
  shift
  local d="$TMP/$name"
  mkdir -p "$d"
  (
    cd "$d" || exit 1
    git init -q -b main
    git config user.email test@example.com
    git config user.name test
    git commit -q --allow-empty -m init
    git update-ref refs/remotes/origin/main HEAD
    git checkout -q -b feat/x
    while [ "$#" -ge 2 ]; do
      local path="$1" content="$2"
      mkdir -p "$(dirname "$path")"
      printf '%s\n' "$content" >"$path"
      shift 2
    done
    git add -A
    git commit -q -m "feat: change"
  )
}

# Runs the hook inside <repo-dir> with a Bash tool_input.command of <command>,
# and prints its permission decision: "deny", "allow" (no output / exit 0),
# or "error" (non-JSON output, non-zero exit with output).
run_hook() { # <repo-dir> <command>
  local repo="$1" command="$2" out status
  out="$(
    cd "$repo" || exit 1
    python3 -c '
import json, sys
print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))
' "$command" | "$HOOK"
  )"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "error"
    return
  fi
  if [ -z "$out" ]; then
    echo "allow"
    return
  fi
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("hookSpecificOutput", {}).get("permissionDecision", "allow"))
except Exception:
    print("error")
' <<<"$out"
}

check() { # <label> <repo-dir> <command> <want: deny|allow>
  local label="$1" repo="$2" command="$3" want="$4" got
  got="$(run_hook "$repo" "$command")"
  if [ "$got" = "$want" ]; then
    pass "$label"
  else
    fail "$label — wanted '$want', got '$got'"
  fi
}

# ── Fixture repos ────────────────────────────────────────────────────────

make_repo sensitive packages/api/src/trueppm_api/app/views.py "def view(): pass"
make_repo docs_only README.md "some docs"
make_repo nonsensitive packages/api/src/trueppm_api/app/models.py "x = 1"

MR_CREATE='glab mr create --title "x" --target-branch main --description "desc"'

# ── Case 1: a real `glab mr create` on a branch with sensitive source
# changes fires the gate. ────────────────────────────────────────────────
check "glab mr create + sensitive diff → denied" \
  "$TMP/sensitive" "$MR_CREATE" deny

# ── Case 1b: the deny reason states the stop rule on the shared severity scale
# (shared severity scale), not the retired Critical/High wording no gate emits. ─────────────
REASON="$(
  cd "$TMP/sensitive" || exit 1
  python3 -c '
import json, sys
print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))
' "$MR_CREATE" | "$HOOK" | python3 -c '
import json, sys
print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecisionReason"])
'
)"
if [[ "$REASON" == *'Any 🔴 finding (including `unconfirmed:`) → do not retry this command.'* &&
      "$REASON" == *'🟡/🟢 findings → summarize inline, then proceed.'* &&
      "$REASON" != *'Critical or High'* && "$REASON" != *'Medium / Low'* ]]; then
  pass "deny reason states the 🔴/🟡/🟢 stop rule"
else
  fail "deny reason does not state the 🔴/🟡/🟢 stop rule (or keeps the retired Critical/High wording)"
fi

# ── Case 2: a non-MR Bash command never fires it, even on the same
# sensitive branch. ─────────────────────────────────────────────────────
check "non-MR command on the same branch → allowed" \
  "$TMP/sensitive" 'git push -u origin feat/x' allow

# ── Case 3: the old env opt-out no longer bypasses anything. ────────────
check "SKIP_SECURITY_GATE=1 prefix (retired) → still denied" \
  "$TMP/sensitive" "SKIP_SECURITY_GATE=1 $MR_CREATE" deny

# ── Case 4: prose in a quoted/heredoc --description never matters. ──────
# Deliberately single-quoted: this builds the literal `$(cat <<'EOF'` text
# fed to the hook as fixture data, not an expression meant to expand here.
# shellcheck disable=SC2016
DESC_WITH_PHRASE='glab mr create \
  --title "x" \
  --target-branch main \
  --description "$(cat <<'"'"'EOF'"'"'
Use SKIP_SECURITY_GATE=1 glab mr create to bypass this hook.
EOF
)"'
check "opt-out phrase only in description body → still denied" \
  "$TMP/sensitive" "$DESC_WITH_PHRASE" deny

# ── Case 5: source changed but nothing sensitive still requires the gate
# (rbac-check is required on every source-touching branch). ─────────────
check "glab mr create + broadcast-only (models.py) diff → denied" \
  "$TMP/nonsensitive" "$MR_CREATE" deny

# ── Case 6: a docs-only branch never fires the gate at all. ─────────────
check "glab mr create + docs-only diff → allowed" \
  "$TMP/docs_only" "$MR_CREATE" allow

# ── bypass forms the old regex never detected. ───────────────
# Each must be DENIED on the sensitive repo. Fixtures are literal text.
# shellcheck disable=SC2016
check "quoted multi-line --description with the old flag → denied" \
  "$TMP/sensitive" 'glab mr create --title x --description "line one
SKIP_SECURITY_GATE=1 glab mr create
line three"' deny
check "global flag: glab -R g/p mr create → denied" \
  "$TMP/sensitive" 'glab -R g/p mr create --title x' deny
check "wrapper: env glab mr create → denied" \
  "$TMP/sensitive" 'env FOO=1 glab mr create --title x' deny
check "subshell: (glab mr create) → denied" \
  "$TMP/sensitive" '(glab mr create --title x)' deny
check "command substitution: echo \$(glab mr create) → denied" \
  "$TMP/sensitive" 'echo $(glab mr create --title x)' deny
check "bash -c \"glab mr create\" → denied" \
  "$TMP/sensitive" 'bash -c "glab mr create --title x"' deny
check "nested sh -lc inside env → denied" \
  "$TMP/sensitive" "env X=1 sh -lc 'glab mr create --title x'" deny
check "after a separator: true && glab mr create → denied" \
  "$TMP/sensitive" 'true && glab mr create --title x' deny
check "git push -o merge_request.create → denied" \
  "$TMP/sensitive" 'git push -o merge_request.create origin feat/x' deny
check "git push --push-option=merge_request.create → denied" \
  "$TMP/sensitive" 'git -C . push --push-option=merge_request.create origin feat/x' deny
check "glab api -X POST .../merge_requests → denied" \
  "$TMP/sensitive" 'glab api -X POST projects/g%2Fp/merge_requests -f title=x' deny
check "unparseable quoting that mentions glab mr → denied (fail closed)" \
  "$TMP/sensitive" 'glab mr create --title "unterminated' deny

# Benign neighbors must stay free.
check "echo mentioning glab mr create in quotes → allowed" \
  "$TMP/sensitive" 'echo "glab mr create is how you open one"' allow
check "glab mr list → allowed" \
  "$TMP/sensitive" 'glab -R g/p mr list' allow
check "glab api GET merge_requests → allowed" \
  "$TMP/sensitive" 'glab api projects/g%2Fp/merge_requests' allow
check "git push without push options → allowed" \
  "$TMP/sensitive" 'git push -u origin feat/x' allow

# More bypass shapes found in review.
check "command substitution inside double quotes → denied" \
  "$TMP/sensitive" 'echo "$(glab mr create --title x)"' deny
# shellcheck disable=SC2016
check "backtick substitution → denied" \
  "$TMP/sensitive" 'echo `glab mr create --title x`' deny
check "sudo -n glab mr create (no-value flag) → denied" \
  "$TMP/sensitive" 'sudo -n glab mr create --title x' deny
check "here-string does not hide a later MR command → denied" \
  "$TMP/sensitive" 'cat <<< word
glab mr create --title x' deny
check "heredoc fed to bash is scanned → denied" \
  "$TMP/sensitive" 'bash <<EOF
glab mr create --title x
EOF' deny
check "&> redirect before the command → denied" \
  "$TMP/sensitive" 'glab mr create --title x &>/dev/null' deny
check "glab api --field= implicit POST → denied" \
  "$TMP/sensitive" 'glab api projects/g%2Fp/merge_requests --field=title=x' deny

# ── marker file keyed to HEAD. ───────────────────────────────
make_repo marked packages/api/src/trueppm_api/app/views.py "def view(): pass"
check "no marker → denied" "$TMP/marked" "$MR_CREATE" deny
(cd "$TMP/marked" && "$HOOK" record ran >/dev/null)
check "marker 'ran' for current HEAD → allowed" "$TMP/marked" "$MR_CREATE" allow
check "marker also covers the bypass forms (same HEAD)" \
  "$TMP/marked" 'env glab -R g/p mr create' allow
echo "# edit after the gates ran" >>"$TMP/marked/packages/api/src/trueppm_api/app/views.py"
check "uncommitted edit after 'record ran' → marker invalidated → denied" \
  "$TMP/marked" "$MR_CREATE" deny
(cd "$TMP/marked" && git checkout -q -- packages/api/src/trueppm_api/app/views.py)
check "edit reverted → marker valid again → allowed" "$TMP/marked" "$MR_CREATE" allow
(cd "$TMP/marked" && git commit -q --allow-empty -m "move head")
check "HEAD moved → marker invalidated → denied" "$TMP/marked" "$MR_CREATE" deny
(cd "$TMP/marked" && "$HOOK" record skipped >/dev/null 2>&1)
check "marker 'skipped' for current HEAD → allowed" "$TMP/marked" "$MR_CREATE" allow
if grep -q ' skipped ' "$TMP/marked/.claude/state/pre-mr-gate"; then
  pass "skipped is recorded distinctly in the marker"
else
  fail "skipped is recorded distinctly in the marker"
fi
if (cd "$TMP/marked" && "$HOOK" record bogus >/dev/null 2>&1); then
  fail "record rejects an unknown status"
else
  pass "record rejects an unknown status"
fi

# ── the deny message no longer teaches the env opt-out. ──────
msg="$(cd "$TMP/sensitive" && python3 -c '
import json, sys
print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))
' "$MR_CREATE" | "$HOOK")"
if grep -q 'SKIP_SECURITY_GATE' <<<"$msg"; then
  fail "deny message must not mention SKIP_SECURITY_GATE"
elif grep -q 'record ran' <<<"$msg"; then
  pass "deny message points at the record command, not the env flag"
else
  fail "deny message should mention 'record ran'"
fi

# ── fail CLOSED when jq or python3 is missing. ───────────────
# A PATH holding only the tools the hook needs, with one of jq/python3
# deliberately absent.
make_path() { # <dir> <tool...>
  local d="$1" t src
  shift
  mkdir -p "$d"
  for t in "$@"; do
    src="$(command -v "$t")" && ln -sf "$src" "$d/$t"
  done
}
EVENT='{"tool_name":"Bash","tool_input":{"command":"glab mr create --title x"}}'
BENIGN='{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'
make_path "$TMP/nojq" cat grep git python3 sort sed date
make_path "$TMP/nopy" cat grep git jq sort sed date
for missing in jq python3; do
  case "$missing" in jq) pdir="$TMP/nojq" ;; *) pdir="$TMP/nopy" ;; esac
  err="$(cd "$TMP/sensitive" && PATH="$pdir" "$BASH" "$HOOK" <<<"$EVENT" 2>&1 >/dev/null)"
  status=$?
  if [ "$status" -eq 2 ] && grep -q "$missing" <<<"$err"; then
    pass "missing $missing + MR command → blocked (rc 2) with message on stderr"
  else
    fail "missing $missing + MR command — wanted rc 2 naming $missing, got rc $status: $err"
  fi
  (cd "$TMP/sensitive" && PATH="$pdir" "$BASH" "$HOOK" <<<"$BENIGN" >/dev/null 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    pass "missing $missing + unrelated command → allowed"
  else
    fail "missing $missing + unrelated command — wanted rc 0, got $status"
  fi
done

# A python3 that exists on PATH but cannot run (e.g. a shim) must not read as
# "not an MR command".
make_path "$TMP/brokenpy" cat grep git jq sort sed date
printf '#!/bin/sh\nexit 1\n' >"$TMP/brokenpy/python3"
chmod +x "$TMP/brokenpy/python3"
(cd "$TMP/sensitive" && PATH="$TMP/brokenpy" "$BASH" "$HOOK" <<<"$EVENT" >/dev/null 2>&1)
status=$?
if [ "$status" -eq 2 ]; then
  pass "python3 present but broken → blocked (rc 2)"
else
  fail "python3 present but broken — wanted rc 2, got $status"
fi

# ── #4867: the gate diffs the branch being opened, not the hook's own
# directory. An orchestrator may open a worker's MR from the main checkout,
# whose diff is empty, so the gate silently stopped firing. ─────────────────────────
ORCH="$TMP/orch"
mkdir -p "$ORCH"
(
  cd "$ORCH" || exit 1
  git init -q -b main
  git config user.email test@example.com
  git config user.name test
  git commit -q --allow-empty -m init
  git update-ref refs/remotes/origin/main HEAD
  git worktree add -q -b feat/w "$TMP/orch-wt" main
  cd "$TMP/orch-wt" || exit 1
  mkdir -p packages/api/src/trueppm_api/app
  printf 'def view(): pass\n' >packages/api/src/trueppm_api/app/views.py
  git add -A
  git commit -q -m "feat: change"
)

# run_hook with the event's cwd set: <process-dir> <event-cwd> <command>
run_hook_cwd() {
  local repo="$1" cwd="$2" command="$3" out status
  out="$(
    cd "$repo" || exit 1
    python3 -c '
import json, sys
print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}, "cwd": sys.argv[2]}))
' "$command" "$cwd" | "$HOOK"
  )"
  status=$?
  if [ "$status" -ne 0 ]; then echo "error"; return; fi
  if [ -z "$out" ]; then echo "allow"; return; fi
  python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("hookSpecificOutput", {}).get("permissionDecision", "allow"))
except Exception:
    print("error")
' <<<"$out"
}
check_cwd() { # <label> <process-dir> <event-cwd> <command> <want>
  local got
  got="$(run_hook_cwd "$2" "$3" "$4")"
  if [ "$got" = "$5" ]; then pass "$1"; else fail "$1 — wanted '$5', got '$got'"; fi
}

check_cwd "main checkout on main, glab mr create without --source-branch → denied (pass --source-branch)" \
  "$ORCH" "$ORCH" "$MR_CREATE" deny
check_cwd "hook process in the clean main checkout, event cwd = a worktree with source changes → denied" \
  "$ORCH" "$TMP/orch-wt" "$MR_CREATE" deny
check_cwd "cd <worktree> && glab mr create, sent from the clean main checkout → denied" \
  "$ORCH" "$ORCH" "cd $TMP/orch-wt && $MR_CREATE" deny
check_cwd "glab mr create --source-branch feat/w from the main checkout → diffs feat/w → denied" \
  "$ORCH" "$ORCH" "$MR_CREATE --source-branch feat/w" deny
check_cwd "-s feat/w (short form) → denied" \
  "$ORCH" "$ORCH" "glab mr create -s feat/w --title x" deny
check_cwd "cd to a run-time path before glab mr create → denied (fail closed)" \
  "$ORCH" "$ORCH" "cd \"\$WT\" && $MR_CREATE" deny
check_cwd "--source-branch that does not exist → denied" \
  "$ORCH" "$ORCH" "$MR_CREATE --source-branch feat/nope" deny
(cd "$TMP/orch-wt" && "$HOOK" record ran >/dev/null 2>&1)
check_cwd "marker recorded in the branch's worktree → --source-branch from the main checkout allowed" \
  "$ORCH" "$ORCH" "$MR_CREATE --source-branch feat/w" allow
check_cwd "the same marker → event cwd = the worktree allowed" \
  "$ORCH" "$TMP/orch-wt" "$MR_CREATE" allow
printf 'x = 1\n' >"$TMP/orch-wt/packages/api/src/trueppm_api/app/extra.py"
check_cwd "an untracked file in the branch's worktree after the marker → denied again" \
  "$ORCH" "$ORCH" "$MR_CREATE --source-branch feat/w" deny
rm -f "$TMP/orch-wt/packages/api/src/trueppm_api/app/extra.py"

# ── Worktree targeting: the target is parsed in every spelling, an MR that cannot be placed
# is denied. ────────────────
ORCH2="$TMP/orch2"
mkdir -p "$ORCH2"
(
  cd "$ORCH2" || exit 1
  git init -q -b main
  git config user.email test@example.com
  git config user.name test
  git commit -q --allow-empty -m init
  git update-ref refs/remotes/origin/main HEAD
  git worktree add -q -b feat/v "$TMP/orch2-wt" main
  cd "$TMP/orch2-wt" || exit 1
  mkdir -p packages/api/src/trueppm_api/app
  printf 'def view(): pass\n' >packages/api/src/trueppm_api/app/views.py
  git add -A
  git commit -q -m "feat: change"
)
for spelling in '-sfeat/v' '-s=feat/v' '-fs feat/v' '--source-branch=feat/v'; do
  check_cwd "glab mr create $spelling (no marker yet) → parsed → denied" \
    "$ORCH2" "$ORCH2" "glab mr create --title x $spelling" deny
done
check_cwd "GITLAB_HOST=x glab mr create -s feat/v → denied" "$ORCH2" "$ORCH2" "GITLAB_HOST=x glab mr create -s feat/v" deny
check_cwd "env glab mr create -s feat/v → denied" "$ORCH2" "$ORCH2" "env glab mr create -s feat/v" deny
check_cwd "command glab mr create --source-branch feat/v → denied" "$ORCH2" "$ORCH2" "command glab mr create --source-branch feat/v" deny
(cd "$TMP/orch2-wt" && "$HOOK" record ran >/dev/null 2>&1)
for spelling in '-sfeat/v' '-s=feat/v' '-fs feat/v' '--source-branch=feat/v'; do
  check_cwd "glab mr create $spelling with the marker → allowed (the branch was parsed)" \
    "$ORCH2" "$ORCH2" "glab mr create --title x $spelling" allow
done
check_cwd "env glab mr create -s feat/v with the marker → allowed" "$ORCH2" "$ORCH2" "env glab mr create -s feat/v" allow
check_cwd "cd /a; glab mr create -s feat/v (a cd that may not apply) → denied" \
  "$ORCH2" "$ORCH2" "cd /a; glab mr create -s feat/v" deny
check_cwd "cd X; bash -c 'glab mr create' (cannot be placed) → denied" \
  "$ORCH2" "$ORCH2" "cd $TMP/orch2-wt; bash -c 'glab mr create --fill'" deny

# ── Worktree targeting, unreadable prefixes ──────────────────────────────────
# orch2-wt (feat/v) carries a recorded marker from the cases above, so a command that resolved to it
# would be allowed: each case below must be denied for the right reason.
check_cwd "-s nope -s feat/v takes the LAST value (glab does) → allowed with feat/v's marker" \
  "$ORCH2" "$ORCH2" "glab mr create --title x -s nope -s feat/v" allow
check_cwd "env -u X glab mr create (unreadable prefix) from the worktree → denied, never the cwd tree" \
  "$ORCH2" "$TMP/orch2-wt" "env -u X glab mr create --fill" deny
check_cwd "env -C /a glab mr create → denied" \
  "$ORCH2" "$TMP/orch2-wt" "env -C /a glab mr create --fill" deny
check_cwd "{ cd /a; glab mr create; } → denied" \
  "$ORCH2" "$TMP/orch2-wt" "{ cd /a; glab mr create --fill; }" deny
git -C "$ORCH2" branch feat/nowt main
check_cwd "--source-branch naming a branch with NO worktree → denied (marker unreadable)" \
  "$ORCH2" "$ORCH2" "glab mr create --title x --source-branch feat/nowt" deny

# ── trueppm path classes: broadcast-check always, security-review only for sensitive paths. ──
reason_of() { # <repo-dir> -> deny reason text
  (cd "$1" && python3 -c '
import json, sys
print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))
' "$MR_CREATE" | "$HOOK" | python3 -c '
import json, sys
print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecisionReason"])
')
}
A='packages/api/src/trueppm_api/app'
make_repo api_serializer $A/serializers.py "x = 1"
make_repo api_consumer $A/consumers.py "x = 1"
make_repo api_routing $A/routing.py "x = 1"
make_repo web_only packages/web/src/lib/format.ts "export const x = 1"
make_repo sched_only packages/scheduler/src/trueppm_scheduler/cpm.py "x = 1"
make_repo mcp_only packages/mcp/src/server.py "x = 1"
make_repo api_test_only packages/api/tests/test_views.py "x = 1"
make_repo api_migration_only $A/migrations/0001_x.py "x = 1"
for r in web_only sched_only mcp_only api_test_only api_migration_only docs_only; do
  check "$r: glab mr create → allowed (no gate applies)" "$TMP/$r" "$MR_CREATE" allow
done
rr="$(reason_of "$TMP/nonsensitive")"
if [[ "$rr" == *broadcast-check* && "$rr" != *rbac-check* && "$rr" != *security-review* && "$rr" == *"record na"* ]]; then
  pass "models.py: names broadcast-check only, with the n/a hint"
else
  fail "models.py: wrong gate list in deny reason"
fi
for r in sensitive api_serializer api_consumer; do
  rr="$(reason_of "$TMP/$r")"
  if [[ "$rr" == *rbac-check* && "$rr" == *broadcast-check* && "$rr" == *security-review* ]]; then
    pass "$r: names rbac-check + security-review + broadcast-check"
  else
    fail "$r: wrong gate list in deny reason"
  fi
done
rr="$(reason_of "$TMP/api_routing")"
if [[ "$rr" == *rbac-check* && "$rr" == *security-review* && "$rr" != *broadcast-check* ]]; then
  pass "routing.py: rbac-check + security-review, no broadcast-check"
else
  fail "routing.py: wrong gate list in deny reason"
fi
# Non-canonical names (substring, not prefix, of the basename).
make_repo n_share_views packages/api/src/trueppm_api/apps/projects/share_views.py "x = 1"
make_repo n_authn packages/api/src/trueppm_api/core/authentication.py "x = 1"
make_repo n_share_services packages/api/src/trueppm_api/apps/projects/share_services.py "x = 1"
make_repo n_throttle packages/api/src/trueppm_api/core/throttling.py "x = 1"
make_repo n_importer packages/api/src/trueppm_api/apps/msproject/importer.py "x = 1"
make_repo n_utils packages/api/src/trueppm_api/apps/projects/utils.py "x = 1"
gates_of() { # <repo> -> space-joined gate names present in the deny reason
  local rr; rr="$(reason_of "$1")"
  local out=""
  [[ "$rr" == *rbac-check* ]] && out+="rbac "
  [[ "$rr" == *security-review* ]] && out+="sec "
  [[ "$rr" == *broadcast-check* ]] && out+="bc "
  echo "$out"
}
expect_gates() { # <label> <repo> <want>
  local got; got="$(gates_of "$2")"
  if [ "$got" = "$3" ]; then pass "$1 → $3"; else fail "$1 — wanted '$3', got '$got'"; fi
}
expect_gates "share_views.py" "$TMP/n_share_views" "rbac sec bc "
expect_gates "core/authentication.py" "$TMP/n_authn" "rbac sec "
expect_gates "share_services.py (share is a sensitive stem, services a write path)" "$TMP/n_share_services" "rbac sec bc "
make_repo n_plain_services packages/api/src/trueppm_api/apps/projects/task_services.py "x = 1"
expect_gates "task_services.py" "$TMP/n_plain_services" "bc "
expect_gates "core/throttling.py" "$TMP/n_throttle" "rbac sec "
expect_gates "msproject/importer.py" "$TMP/n_importer" "rbac sec "
check "projects/utils.py only → allowed" "$TMP/n_utils" "$MR_CREATE" allow

# Not synthetic: every real *_views.py / *_serializers.py / authentication.py in the tree must be
# gated, so a rename that slips past the classifier fails here.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REAL="$TMP/real"
mkdir -p "$REAL"
(cd "$REAL" && git init -q -b main && git config user.email t@e.com && git config user.name t \
  && git commit -q --allow-empty -m init && git update-ref refs/remotes/origin/main HEAD)
real_n=0 real_bad=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  real_n=$((real_n + 1))
  (cd "$REAL" && git checkout -q -B feat/r main && mkdir -p "$(dirname "$f")" && printf 'x = 1\n' >"$f" \
    && git add -A && git commit -q -m c)
  want="rbac sec "
  case "$f" in *_views.py | *_serializers.py) want="rbac sec bc " ;; esac
  got="$(gates_of "$REAL")"
  if [ "$got" != "$want" ]; then real_bad=$((real_bad + 1)); fail "real file $f — wanted '$want', got '$got'"; fi
done < <(cd "$REPO_ROOT" && find packages/api/src -name '*.py' -not -path '*/migrations/*' \
  \( -name '*_views.py' -o -name '*_serializers.py' -o -name 'authentication.py' \) | sort)
if [ "$real_n" -gt 0 ] && [ "$real_bad" -eq 0 ]; then
  pass "all $real_n real *_views/*_serializers/authentication files are gated"
elif [ "$real_n" -eq 0 ]; then
  fail "real-file enumeration found no files"
fi

# record na: allowed, with a distinct n/a ledger reminder.
(cd "$TMP/api_serializer" && "$HOOK" record na >/dev/null 2>&1)
check "marker 'na' for current HEAD → allowed" "$TMP/api_serializer" "$MR_CREATE" allow
if grep -q ' na ' "$TMP/api_serializer/.claude/state/pre-mr-gate"; then pass "na is recorded distinctly in the marker"; else fail "na is recorded distinctly in the marker"; fi

# The old UserPromptSubmit wiring must be gone, the Bash matcher present.
SETTINGS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.claude/settings.json"
if jq -e '[.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[].command | select(test("pre-mr-security-gate"))] | length == 1' "$SETTINGS" >/dev/null 2>&1 \
  && ! jq -e '.hooks.UserPromptSubmit // empty | tostring | test("pre-mr-security-gate")' "$SETTINGS" >/dev/null 2>&1; then
  pass "settings.json wires the hook under PreToolUse/Bash, not UserPromptSubmit"
else
  fail "settings.json wiring: expected PreToolUse/Bash only"
fi

[ "$rc" -eq 0 ] && echo "pre-mr-security-gate: self-test passed."
exit "$rc"
