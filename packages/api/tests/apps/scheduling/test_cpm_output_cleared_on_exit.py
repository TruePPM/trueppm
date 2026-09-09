"""A task leaving ``Task.committed`` must not keep its last CPM dates (#3578).

``_apply_cpm_results`` writes back only the rows the engine returned, and the
scheduled population is ``Task.committed``. So a task that LEFT that set — groomed
to BACKLOG, retyped to EPIC, flagged recurring, soft-deleted — was never loaded
again and kept its last schedule forever. That residue is read as current by the
task serializer and by roughly nine project-level aggregates over ``Task.objects``;
on the dev database it made ``ProjectOverviewView`` report eight phantom late tasks,
because its ``active_statuses`` list explicitly includes BACKLOG.

ADR-1152 makes the contract total: **each CPM output column is non-null if and only
if the row is in ``Task.committed``**. These tests pin both directions of that iff
on both write paths (single-project and program-scoped) and on the fully-groomed
early return, which is the case with the most residue and the one a write-back-only
fix misses entirely.

The invariant is asserted here rather than by wiring
``scripts/check-forecast-snapshot-population.sh`` into CI: that script reads a
populated database, so in CI it is vacuously green over zero projects and on a
developer's machine it reds from rows they did not create. A synthetic fixture has a
denominator; a dev-DB scan does not.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Program,
    Project,
    Task,
    TaskStatus,
    TaskType,
)
from trueppm_api.apps.projects.services import (
    CPM_OUTPUT_FIELDS,
    clear_all_uncommitted_cpm_output,
    clear_uncommitted_cpm_output,
)
from trueppm_api.apps.scheduling.tasks import _run_program_schedule, _run_schedule

START = date(2026, 1, 5)  # Monday


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="StdClearOnExit")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="ClearOnExit", start_date=START, calendar=calendar)


def _recompute(project: Project) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))


def _cpm_values(task: Task) -> dict[str, object]:
    task.refresh_from_db()
    return {f: getattr(task, f) for f in CPM_OUTPUT_FIELDS}


def _assert_all_cleared(task: Task) -> None:
    values = _cpm_values(task)
    assert all(v is None for v in values.values()), f"stale CPM output survived: {values}"


def _assert_scheduled(task: Task) -> None:
    task.refresh_from_db()
    assert task.early_start is not None
    assert task.early_finish is not None


# ---------------------------------------------------------------------------
# Each of the four ways a task leaves the committed set
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("status", TaskStatus.BACKLOG),
        ("type", TaskType.EPIC),
        ("is_recurring", True),
        ("is_deleted", True),
    ],
    ids=["groomed-to-backlog", "retyped-to-epic", "flagged-recurring", "soft-deleted"],
)
def test_leaving_the_committed_set_clears_every_cpm_field(
    project: Project, field: str, value: object
) -> None:
    """All four exclusion axes of ``CommittedTaskManager``, not just BACKLOG.

    Parametrized rather than written once for status: the clearing predicate is the
    plain complement of the manager, and a fix that only handled the axis named in
    the issue would pass a BACKLOG-only test while leaving three holes.
    """
    anchor = Task.objects.create(project=project, name="Anchor", duration=3)
    leaver = Task.objects.create(project=project, name="Leaver", duration=2)
    Dependency.objects.create(predecessor=anchor, successor=leaver, dep_type="FS")

    _recompute(project)
    _assert_scheduled(leaver)

    # Leave the committed set WITHOUT going through the serializer, so the test
    # pins the recompute's own behavior rather than a view's side effects.
    Task.objects.filter(pk=leaver.pk).update(**{field: value})
    _recompute(project)

    _assert_all_cleared(leaver)
    # Negative control: the row still in the plan keeps its schedule. Without this
    # the test would also pass if the clear nulled the whole project.
    _assert_scheduled(anchor)


@pytest.mark.django_db
def test_a_previously_critical_task_stops_claiming_the_critical_path(project: Project) -> None:
    """The MCP-visible form of the defect (`ai-review` finding).

    ``trueppm_mcp.tools._task_why`` documents "Returns {} for an unscheduled task"
    but derives its answer from ``is_critical``/``total_float`` alone — so a groomed
    -out task carrying a stale ``is_critical=True`` made the MCP server assert
    "This task is on the critical path" about a task that is not scheduled at all.
    The docstring and the behavior disagreed, and the residue was why.
    """
    a = Task.objects.create(project=project, name="A", duration=3)
    b = Task.objects.create(project=project, name="B", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")

    _recompute(project)
    b.refresh_from_db()
    assert b.is_critical is True, "premise: B must be on the critical path first"

    Task.objects.filter(pk=b.pk).update(status=TaskStatus.BACKLOG)
    _recompute(project)

    b.refresh_from_db()
    assert b.is_critical is None, "a groomed-out task must not claim the critical path"
    assert b.total_float is None


@pytest.mark.django_db
def test_re_entering_the_committed_set_repopulates_the_dates(project: Project) -> None:
    """The other direction of the iff — clearing must not be terminal.

    The cost option 1 accepts is that the round trip loses the card's previous
    position until the next recompute. This pins that it is *only* until then.
    """
    anchor = Task.objects.create(project=project, name="Anchor", duration=3)
    rider = Task.objects.create(project=project, name="Rider", duration=2)
    Dependency.objects.create(predecessor=anchor, successor=rider, dep_type="FS")

    _recompute(project)
    Task.objects.filter(pk=rider.pk).update(status=TaskStatus.BACKLOG)
    _recompute(project)
    _assert_all_cleared(rider)

    Task.objects.filter(pk=rider.pk).update(status=TaskStatus.NOT_STARTED)
    _recompute(project)

    _assert_scheduled(rider)
    assert rider.total_float is not None


@pytest.mark.django_db
def test_duration_is_never_cleared(project: Project) -> None:
    """``duration`` is user-owned and non-nullable — clearing it would invent a value.

    The write-back overwrites it for summary rows only (#3530) and retains no prior
    value, so a "revert" could only write ``default=1``. Pinned because the next
    reader's instinct is to complete the clear by adding it to the field list.
    """
    anchor = Task.objects.create(project=project, name="Anchor", duration=3)
    leaver = Task.objects.create(project=project, name="Leaver", duration=7)
    Dependency.objects.create(predecessor=anchor, successor=leaver, dep_type="FS")

    _recompute(project)
    Task.objects.filter(pk=leaver.pk).update(status=TaskStatus.BACKLOG)
    _recompute(project)

    leaver.refresh_from_db()
    assert leaver.duration == 7
    assert "duration" not in CPM_OUTPUT_FIELDS


@pytest.mark.django_db
def test_a_summary_row_leaving_the_set_is_cleared(project: Project) -> None:
    """Summary rows get their dates from a different write path.

    Leaf dates come from ``_apply_cpm_results``; a summary's come from
    ``apply_summary_rollups`` plus ``summary_working_day_durations`` (#3530). The
    clearing predicate does not distinguish them — it keys on status/type/recurring/
    deleted — but a test that only ever ejects leaves would not show that, so this
    pins the rolled-up write shape too.
    """
    parent = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
    child = Task.objects.create(project=project, name="Leaf", duration=4, wbs_path="1.1")

    _recompute(project)
    parent.refresh_from_db()
    child.refresh_from_db()
    # `is_summary` is a query-time annotation, not a column — the real premise is
    # that the rollup ran, i.e. the parent's window is its child's rather than its
    # own duration=1.
    assert parent.early_finish is not None, "premise: the summary must roll up first"
    assert parent.early_finish == child.early_finish, "premise: parent rolled up from its leaf"

    # An epic is the plausible way a phase leaves the plan (ADR-0105).
    Task.objects.filter(pk=parent.pk).update(type=TaskType.EPIC)
    _recompute(project)

    _assert_all_cleared(parent)
    _assert_scheduled(child)


@pytest.mark.django_db
def test_a_milestone_leaving_the_set_is_cleared(project: Project) -> None:
    """Milestones carry a normalized single-point window, so clear both ends.

    ``_apply_cpm_results`` forces ``early_finish = early_start`` (and the late pair)
    on a milestone so a client never renders a range. That normalization runs only
    for rows the engine returned, so it is worth pinning that the ejected form is
    fully null rather than half-written.
    """
    anchor = Task.objects.create(project=project, name="Work", duration=5)
    gate = Task.objects.create(
        project=project, name="Gate", duration=0, is_milestone=True, delivery_mode="milestone"
    )
    Dependency.objects.create(predecessor=anchor, successor=gate, dep_type="FS")

    _recompute(project)
    gate.refresh_from_db()
    assert gate.early_start is not None
    assert gate.early_finish == gate.early_start, "premise: milestone is a single point"

    Task.objects.filter(pk=gate.pk).update(status=TaskStatus.BACKLOG)
    _recompute(project)

    _assert_all_cleared(gate)
    _assert_scheduled(anchor)


# ---------------------------------------------------------------------------
# The fully-groomed project — the early return before any write-back
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_grooming_the_entire_committed_set_away_still_clears(project: Project) -> None:
    """``_run_schedule`` returns at ``if not db_tasks`` BEFORE the write-back block.

    This is the worst case — every row in the project is stale — and it is exactly
    the path a write-back-block-only fix never reaches. The clear therefore fires on
    this return too.
    """
    a = Task.objects.create(project=project, name="A", duration=3)
    b = Task.objects.create(project=project, name="B", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")

    _recompute(project)
    _assert_scheduled(a)
    _assert_scheduled(b)

    Task.objects.filter(project=project).update(status=TaskStatus.BACKLOG)
    _recompute(project)

    _assert_all_cleared(a)
    _assert_all_cleared(b)


# ---------------------------------------------------------------------------
# The program-scoped write path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_program_pass_clears_across_every_member_project(calendar: Calendar) -> None:
    """The program pass shares ``_apply_cpm_results`` and so shared the defect.

    Scoped to every member project rather than the schedulable subset: a member
    whose whole committed set was groomed away contributes no rows to the write-back
    yet holds the most residue.
    """
    program = Program.objects.create(name="GA Launch")
    proj_a = Project.objects.create(
        name="Security", start_date=START, calendar=calendar, program=program
    )
    proj_b = Project.objects.create(
        name="Marketing", start_date=START, calendar=calendar, program=program
    )
    a1 = Task.objects.create(project=proj_a, name="Sign-off", duration=5)
    b1 = Task.objects.create(project=proj_b, name="Go-live", duration=2)
    Dependency.objects.create(
        predecessor=a1,
        successor=b1,
        dep_type="FS",
        lag=0,
        pending_acceptance=False,
        accepted_at=timezone.now(),
    )
    b2 = Task.objects.create(project=proj_b, name="Comms", duration=3)

    _run_program_schedule(str(program.pk))
    _assert_scheduled(b2)

    Task.objects.filter(pk=b2.pk).update(status=TaskStatus.BACKLOG)
    _run_program_schedule(str(program.pk))

    _assert_all_cleared(b2)
    _assert_scheduled(a1)
    _assert_scheduled(b1)


# ---------------------------------------------------------------------------
# The helper itself
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_clear_is_a_zero_row_noop_in_the_steady_state(project: Project) -> None:
    """The ``.exclude(<all eight already null>)`` guard.

    Without it the recompute rewrites every BACKLOG card in the project on every
    pass. The steady state must be a zero-row statement, so this asserts the return
    count rather than the resulting values — the values would look identical either
    way, which is exactly what makes the guard easy to drop unnoticed.
    """
    Task.objects.create(project=project, name="Scheduled", duration=3)
    Task.objects.create(
        project=project, name="Never scheduled", duration=3, status=TaskStatus.BACKLOG
    )
    _recompute(project)

    assert clear_uncommitted_cpm_output(Task, project_ids=[str(project.pk)]) == 0
    assert clear_uncommitted_cpm_output(Task) == 0


@pytest.mark.django_db
def test_clear_reports_the_rows_it_cleared_and_spans_projects_when_unscoped(
    calendar: Calendar,
) -> None:
    """Unscoped is what the data migration calls — it must reach every project.

    A backfill scoped to one project would leave exactly the dormant projects the
    migration exists for, since those are the ones that never recompute.
    """
    p1 = Project.objects.create(name="P1", start_date=START, calendar=calendar)
    p2 = Project.objects.create(name="P2", start_date=START, calendar=calendar)
    stale_1 = Task.objects.create(
        project=p1,
        name="Groomed out",
        duration=3,
        status=TaskStatus.BACKLOG,
        early_start=date(2026, 2, 2),
        early_finish=date(2026, 2, 4),
        total_float=30,
        is_critical=True,
    )
    stale_2 = Task.objects.create(
        project=p2,
        name="Epic with dates",
        duration=3,
        type=TaskType.EPIC,
        early_finish=date(2026, 3, 3),
    )
    kept = Task.objects.create(
        project=p1, name="Committed", duration=3, early_finish=date(2026, 2, 10)
    )

    assert clear_uncommitted_cpm_output(Task) == 2

    _assert_all_cleared(stale_1)
    _assert_all_cleared(stale_2)
    kept.refresh_from_db()
    assert kept.early_finish == date(2026, 2, 10)


@pytest.mark.django_db
def test_chunked_backfill_reaches_every_project_across_chunk_boundaries(
    calendar: Calendar,
) -> None:
    """What ``projects/0150`` actually calls.

    The backfill is project-chunked rather than one unscoped statement: unscoped, no
    index covers the compound OR predicate, so Postgres sequentially scans the whole
    task table — and migrations run on container start. ``chunk_size=1`` here forces
    several chunks over a handful of projects, so an off-by-one in the slicing (the
    real risk in hand-rolled chunking) drops a project and fails this test.
    """
    projects = [
        Project.objects.create(name=f"Chunked {i}", start_date=START, calendar=calendar)
        for i in range(5)
    ]
    stale = [
        Task.objects.create(
            project=p,
            name="Groomed out",
            duration=3,
            status=TaskStatus.BACKLOG,
            early_finish=date(2026, 4, 1),
            total_float=12,
            is_critical=True,
        )
        for p in projects
    ]

    assert clear_all_uncommitted_cpm_output(Task, Project, chunk_size=1) == 5
    for task in stale:
        _assert_all_cleared(task)

    # Idempotent: a re-run (an interrupted migration retried from the start) matches
    # nothing, so it is safe to repeat rather than needing resume logic.
    assert clear_all_uncommitted_cpm_output(Task, Project, chunk_size=1) == 0


@pytest.mark.django_db
def test_chunked_backfill_is_a_noop_with_no_projects(db: object) -> None:
    """`range(0, 0, chunk)` is empty — the backfill must not fault on a fresh install."""
    assert clear_all_uncommitted_cpm_output(Task, Project) == 0
