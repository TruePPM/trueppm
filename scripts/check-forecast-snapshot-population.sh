#!/usr/bin/env bash
# scripts/check-forecast-snapshot-population.sh — report projects carrying stale
# CPM output on rows the engine does not schedule.
#
# ## What it compares, and why the two numbers should already agree
#
# Every `SchedProject` construction site feeds CPM `Task.committed` — not BACKLOG,
# not EPIC grouping nodes, not recurring occurrences, not soft-deleted rows. So for
# any project, the schedule shape derived from `Task.committed` and the schedule
# shape derived from every non-deleted task should be the SAME shape: a row outside
# the committed set was never scheduled and should therefore carry no scheduling
# output to contribute.
#
# It is not the same, on real data. `_apply_cpm_results` (`apps/scheduling/tasks.py`)
# only `bulk_update`s the rows it just scheduled, so a task groomed back to BACKLOG
# keeps whatever `early_finish` / `total_float` / `is_critical` it carried when it was
# last in the plan, indefinitely. Nothing clears it and nothing reports it.
#
# ## What that residue costs
#
# `capture_forecast_snapshot` used to aggregate over every non-deleted task, so the
# residue landed straight in `ProjectForecastSnapshot.cpm_finish` — and from there in
# `notify_project_end_date_shift`, which emails the PM/Owner cohort. Measured on the
# dev database when #3539 was filed: one project reporting a finish date six days
# later than its committed work, and one with no float at all reporting thirty days
# of it, sourced from seven groomed-out stories. That aggregate is fixed (#3539); the
# residue that fed it is not, and the same fields are still readable through the task
# serializer. This script is how the residue is seen rather than assumed.
#
# ## What it CANNOT tell you
#
# A divergence here is evidence of stale scheduling output, not proof of it, and a
# clean run is a much weaker statement than it looks. Three limits, all real:
#
#   * FALSE POSITIVE. A project mid-import or mid-first-recompute, where the
#     committed set has not been scheduled yet — the committed aggregate is NULL and
#     the wider one is not. Nothing is stale; nothing has run.
#   * FALSE NEGATIVE. A row whose stale value happens to be dominated by committed
#     work (an earlier `early_finish`, a tighter `total_float`) contributes nothing
#     to the aggregate and is invisible here. So a clean run does NOT mean no stale
#     rows exist; it means none of them currently WIN. `--verbose` lists the rows.
#   * NARROWER THAN THE CLASS. It compares only the two aggregates the forecast
#     snapshot derives. The same residue is read by roughly eight other
#     project-level aggregates over `Task.objects` — the program rollup's
#     trending-later KPI, its critical and at-risk task totals, the project-overview
#     critical/late counts. Nothing guards those, and a clean run here says nothing
#     about them. They are enumerated in #3578, whose write-side fix would close all
#     of them at once.
#
# Saying that plainly is the point: this reports a symptom that a real defect makes
# reachable, and a gate that does not state its blind spot is how "it passed" comes
# to mean more than it can.
#
# ## Why this is not a CI job or a pre-push gate
#
# Its input is a populated database, not the repository, so no commit can fix a
# failure and no fixture can represent a violation — the shape
# `scripts/check-gate-selftest-parity.sh` records as EXTERNAL. It is an operational
# check: run it against a dev/staging database, or against a restored production
# snapshot, when you want to know whether the residue is present. Wiring it into
# `.gitlab-ci.yml` / `make pre-push` is deliberately left to #3578, which decides
# whether `_apply_cpm_results` should clear the fields at all — until that is
# settled there is nothing a red run could ask a developer to do.
#
# Usage:
#   scripts/check-forecast-snapshot-population.sh [--verbose] [--quiet]
#
# Env:
#   PYTHON_BIN   interpreter to run the Django probe with (default:
#                packages/api/.venv/bin/python). The script pipes a script to it;
#                it does not invoke manage.py.
#   Standard Django DB env applies — this reads whatever database the settings
#   module resolves to. It opens no transaction and writes nothing.
#
# Exit:
#   0  every project's committed-set schedule shape matches the wider one
#   1  at least one project diverges (stale CPM output on an unscheduled row)
#   2  could not run (no python, no Django, no database)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERBOSE=0
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) VERBOSE=1; shift ;;
    --quiet)   QUIET=1; shift ;;
    # Derived from the file, not a hardcoded line range: a fixed '2,64p' silently
    # dropped the Exit-code section the moment the header grew, which is the one
    # part an operator wiring this into a runbook needs.
    -h|--help) awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "check-forecast-snapshot-population: unknown argument: $1" >&2; exit 2 ;;
  esac
done

PYTHON_BIN="${PYTHON_BIN:-${REPO_ROOT}/packages/api/.venv/bin/python}"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON_BIN" ]]; then
  echo "check-forecast-snapshot-population: no python interpreter found" >&2
  exit 2
fi

cd "${REPO_ROOT}/packages/api"
export PYTHONPATH="${REPO_ROOT}/packages/api/src${PYTHONPATH:+:${PYTHONPATH}}"

VERBOSE="$VERBOSE" QUIET="$QUIET" "$PYTHON_BIN" - <<'PY'
import os
import sys

try:
    import django
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "trueppm_api.settings.dev")
    os.environ.setdefault("TRUEPPM_ALLOW_DEV_SETTINGS", "1")
    django.setup()
except Exception as exc:  # pragma: no cover - environment, not logic
    print(f"check-forecast-snapshot-population: cannot load Django: {exc}", file=sys.stderr)
    sys.exit(2)

from django.db.models import Count, Max, Min, Q  # noqa: E402
from django.db.utils import Error as DjangoDbError  # noqa: E402

from trueppm_api.apps.projects.models import Project, Task, TaskStatus, TaskType  # noqa: E402

VERBOSE = os.environ.get("VERBOSE") == "1"
QUIET = os.environ.get("QUIET") == "1"

# The committed predicate, restated as a filter expression rather than a second
# queryset, so both populations are aggregated in ONE pass per project instead of
# two. It must stay identical to CommittedTaskManager.get_queryset()
# (apps/projects/models.py) minus its is_deleted clause, which the outer filter
# already applies — an equality-checked assertion below refuses to run if the
# manager has grown a clause this expression does not mirror.
COMMITTED = ~Q(status=TaskStatus.BACKLOG) & ~Q(type=TaskType.EPIC) & Q(is_recurring=False)

AGG = dict(
    cpm_finish=Max("early_finish"),
    total_float_days=Min("total_float"),
    task_count=Count("id"),
    completed=Count("id", filter=Q(status=TaskStatus.COMPLETE)),
    committed_cpm_finish=Max("early_finish", filter=COMMITTED),
    committed_total_float_days=Min("total_float", filter=COMMITTED),
    committed_task_count=Count("id", filter=COMMITTED),
    committed_completed=Count("id", filter=COMMITTED & Q(status=TaskStatus.COMPLETE)),
)

# cpm_finish and total_float_days are the two fields ProjectForecastSnapshot
# actually derives from the schedule; the counts differ between the populations by
# construction (a BACKLOG card IS a task) and are reported, never failed on.
FORECAST_FIELDS = ("cpm_finish", "total_float_days")

try:
    project_ids = list(
        Project.objects.filter(is_deleted=False).values_list("id", "name").order_by("name")
    )
except DjangoDbError as exc:
    print(f"check-forecast-snapshot-population: database unreachable: {exc}", file=sys.stderr)
    sys.exit(2)

# Non-vacuity floor: prove COMMITTED still selects exactly what Task.committed does
# before trusting a single row of output. A drifted predicate would make every
# project agree with itself and this script would report a clean tree forever.
# Both directions, evaluated DB-side, so this stays two EXISTS queries rather than
# two full pk sets in Python.
_inlined = Task.objects.filter(is_deleted=False).filter(COMMITTED)
_manager = Task.committed.all()
if (
    _inlined.exclude(pk__in=_manager.values("pk")).exists()
    or _manager.exclude(pk__in=_inlined.values("pk")).exists()
):
    print(
        "check-forecast-snapshot-population: the inlined committed predicate no longer "
        "matches CommittedTaskManager — refusing to report. Re-derive COMMITTED from "
        "apps/projects/models.py::CommittedTaskManager.get_queryset().",
        file=sys.stderr,
    )
    sys.exit(2)

diverged = []
for pid, name in project_ids:
    agg = Task.objects.filter(project_id=pid, is_deleted=False).aggregate(**AGG)
    wide = {k: agg[k] for k in ("cpm_finish", "total_float_days", "task_count", "completed")}
    committed = {
        "cpm_finish": agg["committed_cpm_finish"],
        "total_float_days": agg["committed_total_float_days"],
        "task_count": agg["committed_task_count"],
        "completed": agg["committed_completed"],
    }
    deltas = {f: (wide[f], committed[f]) for f in FORECAST_FIELDS if wide[f] != committed[f]}
    if deltas:
        diverged.append((pid, name, deltas, wide, committed))

total = len(project_ids)
if not total:
    print(
        "check-forecast-snapshot-population: 0 projects in this database — "
        "nothing was compared, so this run is not evidence of anything",
        file=sys.stderr,
    )
    sys.exit(2)

if not diverged:
    if not QUIET:
        print(
            f"✓ forecast snapshot population: {total} projects, committed-set schedule "
            f"shape matches the all-tasks shape on every one"
        )
        print(
            "  (a stale row dominated by committed work is invisible to this "
            "comparison — see the header)"
        )
    sys.exit(0)

print(
    f"✖ {len(diverged)} of {total} projects carry scheduling output on rows CPM "
    f"does not schedule:",
    file=sys.stderr,
)
for pid, name, deltas, wide, committed in diverged:
    print(f"\n  {name}  ({pid})", file=sys.stderr)
    for field, (all_tasks, only_committed) in deltas.items():
        print(
            f"    {field}: all non-deleted tasks = {all_tasks!r}  ·  "
            f"Task.committed = {only_committed!r}",
            file=sys.stderr,
        )
    print(
        f"    tasks: {wide['task_count']} non-deleted, {committed['task_count']} committed "
        f"({wide['task_count'] - committed['task_count']} outside the schedulable set)",
        file=sys.stderr,
    )
    if VERBOSE:
        stale = (
            Task.objects.filter(project_id=pid, is_deleted=False)
            .exclude(pk__in=Task.committed.filter(project_id=pid).values("pk"))
            .exclude(early_finish__isnull=True, total_float__isnull=True)
            .values("id", "name", "status", "type", "is_recurring", "early_finish", "total_float")
            .order_by("-early_finish")[:20]
        )
        for row in stale:
            print(
                f"      · {row['name']!r} [{row['status']}/{row['type']}"
                f"{'/recurring' if row['is_recurring'] else ''}] "
                f"early_finish={row['early_finish']} total_float={row['total_float']}",
                file=sys.stderr,
            )

print(
    "\nThese rows left the schedulable set and kept their last CPM result: "
    "_apply_cpm_results only writes the tasks it scheduled. The forecast snapshot "
    "no longer reads them (#3539), but the task serializer still does (#3578).",
    file=sys.stderr,
)
sys.exit(1)
PY
