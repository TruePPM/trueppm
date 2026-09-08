#!/usr/bin/env bash
# Fail when a CPM write-back assigns a summary's `duration` a raw day count.
#
# Why this exists (#3530). `_apply_cpm_results()` used to overwrite every
# summary/phase row's `duration` with the CALENDAR-day span of its children:
#
#   db_task.duration = max(1, (db_task.early_finish - db_task.early_start).days)
#
# `Task.duration` is documented and consumed everywhere as WORKING days
# (`help_text="Duration in working days"`; the MSPDI exporter multiplies it by
# HOURS_PER_WORKING_DAY, `project_span_days` sums it, and `build_sched_tasks`
# feeds it back to the engine as `timedelta(days=…)`). So this wrote one unit
# into a field every reader interprets as another — a ~1.4x inflation, on every
# recompute, on both the single-project and program write-back paths. 49 of 50
# summary rows in the dev database carried it.
#
# The comment defending it said the CPM engine never reads a summary's duration.
# That was true of the leaf pass and became false the moment Monte Carlo fed
# summary rows into the engine as schedulable work (#3527) — a locally-true
# comment that a second consumer made globally false. The field-contract
# violation never depended on who read it next, which is why this is a gate and
# not a test of one caller.
#
# ## The rule
#
# Inside the write-back modules below, an assignment to `.duration` must not
# derive from a `.days` day count. A summary's duration is produced by
# `summary_working_day_durations()`, which walks the project calendar; a
# timedelta subtraction cannot express working days no matter how it is
# wrapped.
#
# The rule is ASSIGNMENT-shaped, not `.days`-shaped, on purpose. `.days` is
# legitimate all over these modules — `total_float`, `free_float`, `drift_days`
# and the finish-delta all read it correctly. A bare `.days` probe would flag
# every one of them, and a gate that cries wolf gets deleted or opted out.
#
# ## What this cannot do
#
# It reads one line at a time, so a violation split across two lines (assign a
# span to a local, then assign that local to `.duration`) is invisible to it.
# It also cannot tell a docstring from code, so prose that spells out a full
# `.duration = … .days` assignment would trip it — worth knowing before you
# quote the old line in a comment. And it polices the modules in SCOPE: a new
# write-back in a NEW module is invisible until added here, exactly as a new
# gate is invisible to check-prepush-parity.sh until it appears in CI.
#
# Usage:
#   check-summary-duration-units.sh [ROOT]   # ROOT defaults to packages/api/src
#   check-summary-duration-units.sh --self-test
#
# Exit codes:
#   0  no write-back assigns a duration from a raw day count
#   1  at least one does
#   2  invocation error (including: none of the scoped modules were found)

set -euo pipefail

# Modules that write CPM results back onto Task rows. Paths relative to ROOT.
SCOPE="
trueppm_api/apps/scheduling/tasks.py
trueppm_api/apps/projects/program_schedule.py
"

# An assignment to `.duration` (not `==`) whose right-hand side reaches a
# timedelta day count.
VIOLATION_RE='\.duration[[:space:]]*=[^=].*\.days'

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
  st_scaffold() { # <dir> <body-for-scheduling/tasks.py>
    mkdir -p "$1/trueppm_api/apps/scheduling" "$1/trueppm_api/apps/projects"
    printf 'def gather():\n    pass\n' > "$1/trueppm_api/apps/projects/program_schedule.py"
    printf '%b' "$2" > "$1/trueppm_api/apps/scheduling/tasks.py"
  }

  # The shipped fix: the duration comes from the calendar-walking helper.
  d="$st_tmp/helper"
  st_scaffold "$d" 'def apply():\n    db_task.duration = new_duration\n'
  st_probe "duration from the working-day helper" accept "$d"

  # The violation this gate exists to catch — the shipped #3530 line, verbatim.
  d="$st_tmp/span"
  st_scaffold "$d" 'def apply():\n    db_task.duration = max(1, (db_task.early_finish - db_task.early_start).days)\n'
  st_probe "duration from a calendar-day span" reject "$d"

  # The same defect without the max() wrapper, in case someone simplifies it.
  d="$st_tmp/bare_span"
  st_scaffold "$d" 'def apply():\n    task.duration = (finish - start).days\n'
  st_probe "duration from a bare timedelta .days" reject "$d"

  # `.days` is correct for float and drift columns. Flagging these is how a gate
  # earns an opt-out, so assert the rule is assignment-shaped, not keyword-shaped.
  d="$st_tmp/float_days"
  st_scaffold "$d" 'def apply():\n    db_task.total_float = sched.total_float.days\n    db_task.free_float = sched.free_float.days\n'
  st_probe "total_float / free_float from .days" accept "$d"

  # An equality comparison is not an assignment.
  d="$st_tmp/compare"
  st_scaffold "$d" 'def apply():\n    if db_task.duration == (finish - start).days:\n        pass\n'
  st_probe "duration compared against .days" accept "$d"

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
  hits=$(grep -nE "$VIOLATION_RE" "$file" 2>/dev/null || true)
  [ -n "$hits" ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    echo "VIOLATION: $rel:${hit%%:*} — duration assigned from a raw day count"
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

A CPM write-back assigns a summary's `duration` from a timedelta day count.
That is a CALENDAR-day span being written into a field the model documents and
every consumer reads as WORKING days (#3530) — the MSPDI exporter, the Gantt
duration column, `project_span_days`, and `build_sched_tasks` all inherit a
~1.4x inflation, on every recompute.

Fix: take the value from the calendar-walking helper.

  summary_durations = summary_working_day_durations(...)   # batched per calendar
  db_task.duration = summary_durations.get(task_key)

A timedelta subtraction cannot express working days no matter how it is
wrapped: it counts weekends and calendar exceptions the project does not work.
If you need the calendar span for presentation, derive it at read time (the
`percent_complete_rollup` precedent) rather than overwriting a scheduling input.
MSG
  exit 1
fi

echo "OK: no summary duration write-back derives from a raw day count (${scanned} module(s) scanned)."
