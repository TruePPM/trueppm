#!/usr/bin/env bash
# Fail when a scheduler-input builder reads dependency edges through the
# unfiltered `Dependency.objects` manager.
#
# Why this exists (#3532). `DependencyViewSet.perform_destroy` soft-deletes the
# edge and enqueues a recalculation in the same method. Three of the four
# scheduler-input builders queried `Dependency.objects` with no `is_deleted`
# filter, so that recalculation fed the engine the edge the user had just
# deleted. Every persisted `early_start` / `early_finish` / `late_*` /
# `total_float` / `is_critical` on the project stayed bound to it, and so did
# the Monte Carlo forecast, the what-if forecast, and — worst — the schedule
# derivation endpoint, which is the surface a user opens to ask *why* a date is
# what it is and which then named a link that no longer existed. Measured at
# seven calendar days of phantom delay on a two-task chain.
#
# Only the merged program pass was correct, so a program view and a project view
# of the same plan disagreed structurally. That is the tell this gate encodes:
# the invariant was honored at one site out of four, by convention, with nothing
# asserting the other three.
#
# ## The rule
#
# Inside the scheduler-input modules below, a dependency READ must go through
# `Dependency.live` (the manager that excludes soft-deleted edges). WRITES are
# unaffected — `bulk_update` / `bulk_create` address rows the caller already
# holds, and a write manager filter would be meaningless.
#
# The rule is deliberately manager-shaped rather than "does an `is_deleted=False`
# kwarg appear nearby". A kwarg check is defeated by any refactor that moves the
# filter to a second `.filter()` call or a `Q` object, and — the trap the issue
# calls out — `is_deleted` is a column on the table, so it appears in the SELECT
# list of EVERY dependency query. A substring probe on compiled SQL, or on the
# source line, reports a false pass against a completely unfiltered query.
#
# ## What this cannot do
#
# It polices the modules listed in SCOPE. A scheduler-input builder written in a
# NEW module is invisible to it, exactly as a new gate script is invisible to
# check-prepush-parity.sh until it appears in CI. Add the module here when you
# add the builder; the fix and this gate landed together for that reason.
#
# Usage:
#   check-dependency-soft-delete.sh [ROOT]   # ROOT defaults to packages/api/src
#   check-dependency-soft-delete.sh --self-test
#
# Exit codes:
#   0  every scheduler-input dependency read goes through Dependency.live
#   1  at least one reads through Dependency.objects
#   2  invocation error (including: none of the scoped modules were found)

set -euo pipefail

# Modules that build a scheduling network. Paths are relative to ROOT.
SCOPE="
trueppm_api/apps/scheduling/tasks.py
trueppm_api/apps/scheduling/views.py
trueppm_api/apps/projects/program_schedule.py
"

# Manager methods that READ rows. Anything else on `Dependency.objects` (the
# bulk_update write-back of is_driving, bulk_create on import) is allowed.
READ_METHODS='filter|all|exclude|get|first|last|values|values_list|annotate|aggregate|count|exists|in_bulk|iterator|only|defer|select_related|prefetch_related'

if [ "${1:-}" = "--self-test" ]; then
  # Prove this gate can still fail, in the job that runs it (#3195). Every case
  # runs the REAL script against a fixture root, so there is no second copy of
  # the detection pattern to drift.
  #
  # Exit code is asserted EXACTLY, not "non-zero means caught": a fixture whose
  # scoped modules are all missing exits 2, which a non-zero probe would score
  # as a successful detection while the detector never ran.
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0
  st_probe() { # <name> <accept|reject|error> <dir>
    case "$2" in
      accept) want=0 ;;
      reject) want=1 ;;
      error)  want=2 ;;
      *) echo "SELF-TEST: bad expectation '$2'" >&2; st_rc=1; return ;;
    esac
    got=0
    bash "$0" "$3" >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then
      echo "SELF-TEST OK: $1 — $2 (exit $got)."
    else
      echo "SELF-TEST FAILED: $1 — expected $2 (exit $want), got exit $got." >&2
      st_rc=1
    fi
  }
  st_scaffold() { # <dir> <body-for-scheduling/views.py>
    mkdir -p "$1/trueppm_api/apps/scheduling" "$1/trueppm_api/apps/projects"
    printf 'def run():\n    pass\n' > "$1/trueppm_api/apps/scheduling/tasks.py"
    printf 'def gather():\n    pass\n' > "$1/trueppm_api/apps/projects/program_schedule.py"
    printf '%b' "$2" > "$1/trueppm_api/apps/scheduling/views.py"
  }

  d="$st_tmp/live"
  st_scaffold "$d" 'def build():\n    return list(Dependency.live.filter(predecessor__project_id=pk))\n'
  st_probe "Dependency.live read" accept "$d"

  # The violation this gate exists to catch — the shipped #3532 line, verbatim.
  d="$st_tmp/objects_read"
  st_scaffold "$d" 'def build():\n    return list(Dependency.objects.filter(predecessor__project_id=pk))\n'
  st_probe "Dependency.objects read" reject "$d"

  # The false pass the issue warns about: the source line mentions is_deleted
  # (here as an ordering key) while the query is completely unfiltered. A
  # keyword-proximity check would accept this.
  d="$st_tmp/is_deleted_decoy"
  st_scaffold "$d" 'def build():\n    return list(Dependency.objects.filter(predecessor__project_id=pk).order_by("is_deleted"))\n'
  st_probe "unfiltered read whose line mentions is_deleted" reject "$d"

  # A read reached through a continuation line, which a same-line-only grep for
  # `Dependency.objects.filter(` would still catch, but `.all()` on its own line
  # would not — so assert the method set, not just `.filter`.
  d="$st_tmp/objects_all"
  st_scaffold "$d" 'def build():\n    return list(Dependency.objects.all())\n'
  st_probe "Dependency.objects.all() read" reject "$d"

  # Writes stay allowed: bulk_update addresses rows the caller already holds,
  # and rejecting it would push authors to disable the gate instead.
  d="$st_tmp/write"
  st_scaffold "$d" 'def build():\n    Dependency.objects.bulk_update(deps, ["is_driving"])\n'
  st_probe "Dependency.objects.bulk_update() write" accept "$d"

  # A root missing every scoped module must be an invocation error, never a
  # quiet OK. This is the guard that keeps the reject cases above honest.
  d="$st_tmp/empty"; mkdir -p "$d"
  st_probe "root with none of the scoped modules" error "$d"

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

ROOT="${1:-packages/api/src}"

if [ ! -d "$ROOT" ]; then
  echo "ERROR: '$ROOT' is not a directory. Run from the repository root." >&2
  exit 2
fi

scanned=0
violations=0

for rel in $SCOPE; do
  file="$ROOT/$rel"
  [ -f "$file" ] || continue
  scanned=$((scanned + 1))
  # `|| true`: grep exits 1 on no match and 2 on a rejected option, and under
  # `set -euo pipefail` either kills the script here — silently, which is the
  # #3172 shape. Swallow the status and let the explicit checks answer.
  hits=$(grep -nE "Dependency\.objects\.(${READ_METHODS})\(" "$file" 2>/dev/null || true)
  [ -n "$hits" ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    echo "VIOLATION: $rel:${hit%%:*} — scheduler input read through Dependency.objects"
    violations=$((violations + 1))
  done <<< "$hits"
done

if [ "$scanned" -eq 0 ]; then
  echo "ERROR: none of the scoped modules exist under $ROOT — have they moved?" >&2
  echo "       A silent empty scan would pass this gate forever." >&2
  printf '       expected:%s\n' "$SCOPE" >&2
  exit 2
fi

if [ "$violations" -gt 0 ]; then
  cat <<'MSG'

A scheduler-input builder reads dependency edges through Dependency.objects,
which is unfiltered — it returns soft-deleted edges. `perform_destroy` soft-
deletes the edge and enqueues a recalculation in the same method, so the query
above feeds the engine a constraint the user just removed. The persisted CPM
dates, the Monte Carlo and what-if forecasts, and the derivation ("why")
endpoint all stay bound to it (#3532).

Fix: read through the filtered manager.

  Dependency.live.filter(...)          # excludes is_deleted=True

Dependency.objects stays unfiltered on purpose — the sync delta pull needs to
SEE soft-deleted rows to emit their tombstones, the nightly tombstone reap
selects on them, the unique-edge probes distinguish a live duplicate from a
tombstoned one, and the restore paths resurrect them. Writes through
Dependency.objects (bulk_update / bulk_create) are unaffected and allowed.
MSG
  exit 1
fi

echo "OK: all ${scanned} scheduler-input module(s) read dependencies through Dependency.live."
