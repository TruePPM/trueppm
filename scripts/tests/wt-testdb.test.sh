#!/usr/bin/env bash
# scripts/tests/wt-testdb.test.sh
#
# Unit test for the per-worktree Postgres test-database lifecycle in scripts/wt
# (#3270).
#
# `wt new` writes TRUEPPM_TEST_DB=test_trueppm_wt_<slug> into each worktree's
# .envrc and pytest creates that database on first run. pytest-django drops it on
# a CLEAN exit and only on a clean exit — an interrupted run (Ctrl-C, a timeout, a
# killed agent session) strands it, and nothing in `wt` ever dropped it. 78
# orphans had accumulated locally, 1959 MB, 97% of the whole cluster, none of them
# belonging to a live worktree.
#
# The failure is silent by construction: an orphaned database costs nothing but
# disk, breaks no test, and reds no pipeline, so there is no signal short of
# someone running `psql` and counting. That is exactly why the logic needs a test
# rather than a manual check — a regression here is invisible again.
#
# `docker` is stubbed: the CI image has no Postgres, and even locally a test that
# issued real DROPs against the dev cluster would be its own hazard. The stub
# keeps a file-backed catalog so a DROP is observable as an absence, not merely as
# a logged command — a drop that is issued but ineffective, and a guard that is
# skipped, would otherwise look identical.
#
# scripts/wt must stay bash-3.2 clean (macOS default bash); CI runs bash 5 and
# cannot catch a 3.2 regression functionally, so Case 6 guards the new code
# statically — same approach as wt-reserve.test.sh.
#
# Run: bash scripts/tests/wt-testdb.test.sh

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

# --- docker stub -----------------------------------------------------------
# Backed by two files so state survives across the many subshells wt runs in:
#   $DB_STUB_CATALOG — one database name per line (the pg_database catalog)
#   $DB_STUB_CONNS   — "<datname> <count>" lines (pg_stat_activity)
# Every statement is appended to $DB_STUB_LOG.
STUB_BIN="$TMP/bin"; mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/docker" <<'STUBEOF'
#!/usr/bin/env bash
{ echo "ARGV: $*"; } >> "$DB_STUB_LOG"

if [[ "$1" == "ps" ]]; then
  # db_available: print the container name only when the stack is "up".
  [[ "${DB_STUB_UP:-1}" == "1" ]] && echo "${DB_STUB_CONTAINER:-trueppm-db-1}"
  exit 0
fi

if [[ "$1" == "exec" ]]; then
  sql="${!#}"   # psql -tAc "<sql>" — the statement is the last argument
  { echo "SQL: $sql"; } >> "$DB_STUB_LOG"

  case "$sql" in
    *"DROP DATABASE IF EXISTS"*)
      name="$(printf '%s' "$sql" | sed -E 's/.*DROP DATABASE IF EXISTS "([^"]+)".*/\1/')"
      grep -vxF "$name" "$DB_STUB_CATALOG" > "$DB_STUB_CATALOG.tmp" || true
      mv "$DB_STUB_CATALOG.tmp" "$DB_STUB_CATALOG"
      ;;
    *pg_stat_activity*)
      name="$(printf '%s' "$sql" | sed -E "s/.*datname = '([^']+)'.*/\1/")"
      awk -v n="$name" '$1 == n { print $2; found=1 } END { if (!found) print 0 }' \
        "$DB_STUB_CONNS"
      ;;
    *pg_size_pretty*)
      echo "123 MB"
      ;;
    *"FROM pg_database"*)
      # Only the anchored-prefix listing is used by wt; serve the catalog.
      grep -E '^test_trueppm_wt' "$DB_STUB_CATALOG" | sort || true
      ;;
  esac
  exit 0
fi
exit 0
STUBEOF
chmod +x "$STUB_BIN/docker"

export DB_STUB_LOG="$TMP/docker.log"
export DB_STUB_CATALOG="$TMP/catalog"
export DB_STUB_CONNS="$TMP/conns"
export TRUEPPM_WT_DB_CONTAINER="trueppm-db-1"

# mk_repo <dir> — throwaway git repo with one commit (wt derives REPO_ROOT and
# the git common dir from whatever repo it runs in, so each case is isolated).
mk_repo() {
  local d="$1"
  mkdir -p "$d"
  ( cd "$d"
    git init -q
    git config user.email t@t.co
    git config user.name  t
    echo seed > seed.txt
    git add -A
    git commit -qm init
  )
}

# mk_wt <repo> <wt-base> <branch> <dirname> <test-db> — a worktree with the
# .envrc `wt new` would have written.
mk_wt() {
  local repo="$1" base="$2" branch="$3" dir="$4" db="$5"
  ( cd "$repo" && git branch "$branch" && git worktree add -q "$base/$dir" "$branch" )
  cat > "$base/$dir/.envrc" <<EOF
export COMPOSE_PROJECT_NAME=trueppm
export TRUEPPM_TEST_DB=$db
EOF
}

catalog() { printf '%s\n' "$@" > "$DB_STUB_CATALOG"; }
in_catalog() { grep -qxF "$1" "$DB_STUB_CATALOG"; }

# --- Case 1: remove drops the worktree's whole DB family --------------------
# Under pytest-xdist the test DB name is suffixed per worker, so an interrupted
# parallel run strands `<base>_gw0..gwN` as well as `<base>` — 23 of the 78
# orphans in #3270 were worker databases. Dropping only the exact name from
# .envrc would leave most of a parallel run's mess behind.
echo "Case 1: remove drops the base DB and its xdist worker DBs"
D1="$TMP/case1"; mk_repo "$D1"
B1="$TMP/case1-wts"
mk_wt "$D1" "$B1" "feat/9101-thing" "9101-thing" "test_trueppm_wt_9101_thing"
catalog \
  "test_trueppm_wt_9101_thing" \
  "test_trueppm_wt_9101_thing_gw0" \
  "test_trueppm_wt_9101_thing_gw1" \
  "test_trueppm_wt_9102_other" \
  "test_trueppm" \
  "trueppm"
: > "$DB_STUB_CONNS"; : > "$DB_STUB_LOG"
( cd "$D1" && TRUEPPM_WT_BASE="$B1" PATH="$STUB_BIN:$PATH" bash "$WT" remove 9101 >/dev/null 2>&1 ) || true
check "base DB dropped"                  "$(! in_catalog test_trueppm_wt_9101_thing; echo $?)"
check "xdist worker gw0 dropped"         "$(! in_catalog test_trueppm_wt_9101_thing_gw0; echo $?)"
check "xdist worker gw1 dropped"         "$(! in_catalog test_trueppm_wt_9101_thing_gw1; echo $?)"
check "another worktree's DB untouched"  "$(in_catalog test_trueppm_wt_9102_other; echo $?)"
check "shared test_trueppm untouched"    "$(in_catalog test_trueppm; echo $?)"
check "dev DB trueppm untouched"         "$(in_catalog trueppm; echo $?)"
check "no DROP was issued for trueppm"   "$(! grep -q 'DROP DATABASE IF EXISTS "trueppm"' "$DB_STUB_LOG"; echo $?)"
check "worktree itself was removed"      "$([[ ! -d "$B1/9101-thing" ]]; echo $?)"

# --- Case 2: a database in use is never dropped ----------------------------
# A live pytest run in another session holds connections. Dropping the DB out
# from under it converts a disk-hygiene chore into a failed test run somebody
# else has to debug — so the guard refuses, and the removal still succeeds.
echo "Case 2: an in-use database is left in place"
D2="$TMP/case2"; mk_repo "$D2"
B2="$TMP/case2-wts"
mk_wt "$D2" "$B2" "feat/9201-busy" "9201-busy" "test_trueppm_wt_9201_busy"
catalog "test_trueppm_wt_9201_busy" "test_trueppm_wt_9201_busy_gw0"
printf 'test_trueppm_wt_9201_busy 3\n' > "$DB_STUB_CONNS"
: > "$DB_STUB_LOG"
rc2=0
( cd "$D2" && TRUEPPM_WT_BASE="$B2" PATH="$STUB_BIN:$PATH" bash "$WT" remove 9201 >/dev/null 2>&1 ) || rc2=$?
check "in-use DB still present"           "$(in_catalog test_trueppm_wt_9201_busy; echo $?)"
check "no DROP issued for the in-use DB"  "$(! grep -q 'DROP DATABASE IF EXISTS "test_trueppm_wt_9201_busy"' "$DB_STUB_LOG"; echo $?)"
check "its idle worker WAS dropped"       "$(! in_catalog test_trueppm_wt_9201_busy_gw0; echo $?)"
check "wt remove still exited 0"          "$([[ "$rc2" -eq 0 ]]; echo $?)"
check "worktree still removed"            "$([[ ! -d "$B2/9201-busy" ]]; echo $?)"

# --- Case 3: no docker / stack down never fails the teardown ---------------
# The DB step runs last, after a teardown that has already succeeded. A laptop
# with the stack down must still be able to remove a worktree.
echo "Case 3: teardown survives an unreachable database"
D3="$TMP/case3"; mk_repo "$D3"
B3="$TMP/case3-wts"
mk_wt "$D3" "$B3" "feat/9301-nodocker" "9301-nodocker" "test_trueppm_wt_9301_nodocker"
catalog "test_trueppm_wt_9301_nodocker"
: > "$DB_STUB_CONNS"
rc3=0
( cd "$D3" && TRUEPPM_WT_BASE="$B3" DB_STUB_UP=0 PATH="$STUB_BIN:$PATH" bash "$WT" remove 9301 >/dev/null 2>&1 ) || rc3=$?
check "stack down: remove still exited 0" "$([[ "$rc3" -eq 0 ]]; echo $?)"
check "stack down: worktree removed"      "$([[ ! -d "$B3/9301-nodocker" ]]; echo $?)"

# docker absent from PATH entirely (not merely a stopped container).
D3b="$TMP/case3b"; mk_repo "$D3b"
B3b="$TMP/case3b-wts"
mk_wt "$D3b" "$B3b" "feat/9302-nobin" "9302-nobin" "test_trueppm_wt_9302_nobin"
# A PATH that mirrors the real one MINUS docker. Enumerating the handful of
# tools wt uses would make this test fail for the wrong reason the next time it
# reaches for one more coreutil, so mirror everything and subtract instead.
EMPTY_BIN="$TMP/nodocker-bin"; mkdir -p "$EMPTY_BIN"
( IFS=:; for dir in $PATH; do
    [[ -d "$dir" ]] || continue
    for exe in "$dir"/*; do
      [[ -x "$exe" && ! -d "$exe" ]] || continue
      base="${exe##*/}"
      case "$base" in docker|docker-compose|podman) continue ;; esac
      [[ -e "$EMPTY_BIN/$base" ]] || ln -sf "$exe" "$EMPTY_BIN/$base"
    done
  done ) 2>/dev/null || true
check "the no-docker PATH really has no docker" \
  "$(! PATH="$EMPTY_BIN" command -v docker >/dev/null 2>&1; echo $?)"
rc3b=0
( cd "$D3b" && TRUEPPM_WT_BASE="$B3b" PATH="$EMPTY_BIN" bash "$WT" remove 9302 >/dev/null 2>&1 ) || rc3b=$?
check "no docker binary: remove exited 0" "$([[ "$rc3b" -eq 0 ]]; echo $?)"
check "no docker binary: worktree gone"   "$([[ ! -d "$B3b/9302-nobin" ]]; echo $?)"

# --- Case 4: doctor reports orphans and only orphans -----------------------
# This is the half that finds what leaked before the fix, or through a route
# that never calls `wt remove` at all. A live worktree owns its base name AND
# its worker DBs; reporting those as orphans would train the reader to ignore
# the report, which is worse than not having one.
echo "Case 4: doctor separates orphans from live worktrees' databases"
D4="$TMP/case4"; mk_repo "$D4"
B4="$TMP/case4-wts"
mk_wt "$D4" "$B4" "feat/9401-live" "9401-live" "test_trueppm_wt_9401_live"
catalog \
  "test_trueppm_wt_9401_live" \
  "test_trueppm_wt_9401_live_gw0" \
  "test_trueppm_wt_9402_dead" \
  "test_trueppm_wt_9403_dead" \
  "test_trueppm"
: > "$DB_STUB_CONNS"
out4="$( cd "$D4" && TRUEPPM_WT_BASE="$B4" PATH="$STUB_BIN:$PATH" bash "$WT" doctor 2>&1 || true )"
check "reports the two orphans"        "$(grep -q '2 orphaned test database' <<<"$out4"; echo $?)"
check "names orphan 9402"              "$(grep -q 'test_trueppm_wt_9402_dead' <<<"$out4"; echo $?)"
check "names orphan 9403"              "$(grep -q 'test_trueppm_wt_9403_dead' <<<"$out4"; echo $?)"
check "live worktree's DB not listed"  "$(! grep -q 'test_trueppm_wt_9401_live$' <<<"$out4"; echo $?)"
check "live worktree's worker not listed" "$(! grep -q 'test_trueppm_wt_9401_live_gw0' <<<"$out4"; echo $?)"
check "reports a total size"           "$(grep -q '123 MB total' <<<"$out4"; echo $?)"
check "points at the drop command"     "$(grep -q 'scripts/wt prune-dbs' <<<"$out4"; echo $?)"

# doctor must not claim a clean bill of health when it cannot see the database.
out4b="$( cd "$D4" && TRUEPPM_WT_BASE="$B4" DB_STUB_UP=0 PATH="$STUB_BIN:$PATH" bash "$WT" doctor 2>&1 || true )"
check "stack down: says skipped, not clean" "$(grep -q 'skipped test-DB orphan check' <<<"$out4b"; echo $?)"
check "stack down: no false all-clear"      "$(! grep -q 'no orphaned' <<<"$out4b"; echo $?)"

# --- Case 5: prune-dbs drops orphans and spares everything else ------------
echo "Case 5: prune-dbs drops only orphaned databases"
D5="$TMP/case5"; mk_repo "$D5"
B5="$TMP/case5-wts"
mk_wt "$D5" "$B5" "feat/9501-live" "9501-live" "test_trueppm_wt_9501_live"
catalog \
  "test_trueppm_wt_9501_live" \
  "test_trueppm_wt_9501_live_gw0" \
  "test_trueppm_wt_9502_dead" \
  "test_trueppm_wt_9503_busy" \
  "test_trueppm" \
  "trueppm"
printf 'test_trueppm_wt_9503_busy 1\n' > "$DB_STUB_CONNS"
: > "$DB_STUB_LOG"
( cd "$D5" && TRUEPPM_WT_BASE="$B5" PATH="$STUB_BIN:$PATH" bash "$WT" prune-dbs --yes >/dev/null 2>&1 ) || true
rc5=0
( cd "$D5" && TRUEPPM_WT_BASE="$B5" PATH="$STUB_BIN:$PATH" bash "$WT" prune-dbs --yes >/dev/null 2>&1 ) || rc5=$?
check "prune-dbs is a real subcommand"  "$([[ "$rc5" -eq 0 ]]; echo $?)"
check "orphan dropped"                  "$(! in_catalog test_trueppm_wt_9502_dead; echo $?)"
check "live worktree's DB spared"       "$(in_catalog test_trueppm_wt_9501_live; echo $?)"
check "live worktree's worker spared"   "$(in_catalog test_trueppm_wt_9501_live_gw0; echo $?)"
check "in-use orphan spared"            "$(in_catalog test_trueppm_wt_9503_busy; echo $?)"
check "shared test_trueppm spared"      "$(in_catalog test_trueppm; echo $?)"
check "dev DB trueppm spared"           "$(in_catalog trueppm; echo $?)"

# Without --yes it must not drop anything on a declined prompt.
catalog "test_trueppm_wt_9502_dead" "trueppm"
( cd "$D5" && TRUEPPM_WT_BASE="$B5" PATH="$STUB_BIN:$PATH" bash "$WT" prune-dbs </dev/null >/dev/null 2>&1 ) || true
check "declined prompt drops nothing"   "$(in_catalog test_trueppm_wt_9502_dead; echo $?)"

# --- Case 6: wiring + bash 3.2 portability ---------------------------------
echo "Case 6: wiring + bash 3.2 portability"
check "remove reads the DB name before removal" "$(grep -q 'rm_test_db="\$(worktree_test_db "\$path")"' "$WT"; echo $?)"
check "remove drops the family"                 "$(grep -q 'drop_worktree_test_dbs "\$rm_test_db"' "$WT"; echo $?)"
check "prune drops the family"                  "$(grep -q 'drop_worktree_test_dbs "\$prune_test_db"' "$WT"; echo $?)"
check "doctor reports orphans"                  "$(grep -q 'orphan_test_dbs' "$WT"; echo $?)"
check "prune-dbs is dispatched"                 "$(grep -q 'prune-dbs) shift; cmd_prune_dbs' "$WT"; echo $?)"
check "drop is prefix-guarded"                  "$(grep -q 'is_wt_test_db "\$name" ||' "$WT"; echo $?)"
check "drop checks pg_stat_activity"            "$(grep -q 'pg_stat_activity' "$WT"; echo $?)"
# The prefix guard must require something AFTER the prefix, or the shared
# `test_trueppm_wt` name itself would be droppable.
check "prefix guard requires a suffix"          "$(grep -q '"\${WT_TEST_DB_PREFIX}"?\*' "$WT"; echo $?)"
# db_list_wt must use an anchored regex, not LIKE: these names are full of
# underscores, and LIKE would read every one of them as a wildcard.
check "catalog query uses anchored regex"       "$(grep -q "datname ~ '\^\\\${WT_TEST_DB_PREFIX}'" "$WT"; echo $?)"
check "catalog query does not use LIKE"         "$(! grep -q "FROM pg_database WHERE datname LIKE" "$WT"; echo $?)"

CODE="$(grep -vE '^[[:space:]]*#' "$WT")"
if printf '%s\n' "$CODE" | grep -qE 'declare -A|mapfile|readarray|local -n'; then r=1; else r=0; fi
check "no bash 4+ constructs (declare -A/mapfile/readarray/local -n)" "$r"
if printf '%s\n' "$CODE" | grep -qE '\$\{[A-Za-z_][A-Za-z0-9_]*\^'; then r=1; else r=0; fi
check "no \${var^} case-conversion expansion" "$r"

echo ""
echo "wt-testdb: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
