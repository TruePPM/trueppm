"""Tests for the persisted program-scoped CPM dispatch pass (#1117 / ADR-0120 D3).

When a program holds ≥1 accepted cross-project edge, a member project's CPM
recompute escalates to ``recalculate_program_schedule``, which merges every member
project's tasks + accepted cross edges, runs CPM once, and writes program-true dates
back to *every* member project. Coverage: the escalation predicate, the self-delegation
guard in ``_run_schedule`` (no stale single-project write), program-true write-back,
outbox coalescing, ``recalculated_at`` stamping, and per-member broadcast fan-out.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Dependency, Program, Project, Task
from trueppm_api.apps.projects.program_schedule import program_has_accepted_cross_edges
from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
from trueppm_api.apps.scheduling.tasks import _run_program_schedule, _run_schedule

START = date(2026, 3, 2)  # a Monday


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def _program(calendar: Calendar, *, accepted: bool) -> tuple[Program, Project, Project, Task, Task]:
    """One program, projects A→B, a cross-project FS edge A1(5d)→B1(2d)."""
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
        pending_acceptance=not accepted,
        accepted_at=timezone.now() if accepted else None,
    )
    return program, proj_a, proj_b, a1, b1


@pytest.mark.django_db
def test_escalation_predicate_accepted_vs_pending(calendar: Calendar) -> None:
    program, _a, _proj_b, _a1, _b1 = _program(calendar, accepted=True)
    assert program_has_accepted_cross_edges(program.pk) is True

    pending_program, _pa, _pb, _pa1, _pb1 = _program(calendar, accepted=False)
    assert program_has_accepted_cross_edges(pending_program.pk) is False


@pytest.mark.django_db
def test_run_schedule_self_delegates_without_writing(calendar: Calendar) -> None:
    """A single-project recompute on an escalating program dispatches the program
    pass and writes *no* single-project dates — closing the torn-write window."""
    program, _a, proj_b, _a1, b1 = _program(calendar, accepted=True)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_program_schedule") as prog_task:
        _run_schedule(str(proj_b.pk))

    prog_task.delay.assert_called_once_with(str(program.pk))
    b1.refresh_from_db()
    # No program-FALSE single-project dates were persisted.
    assert b1.early_start is None
    assert b1.early_finish is None


@pytest.mark.django_db
def test_program_pass_writes_program_true_dates(calendar: Calendar) -> None:
    """The program pass pushes the downstream successor past the upstream finish and
    marks the cross-project chain critical in *both* projects' stored rows."""
    program, _a, _b, a1, b1 = _program(calendar, accepted=True)

    _run_program_schedule(str(program.pk))

    a1.refresh_from_db()
    b1.refresh_from_db()
    # B1 can't start until A1 finishes — program-true across the boundary.
    assert b1.early_start is not None and a1.early_finish is not None
    assert b1.early_start > a1.early_finish
    assert a1.is_critical is True
    assert b1.is_critical is True


@pytest.mark.django_db
def test_program_pass_coalesces_member_outbox_rows(calendar: Calendar) -> None:
    """Every member project's DISPATCHED outbox row is marked DONE by the one run."""
    program, proj_a, proj_b, _a1, _b1 = _program(calendar, accepted=True)
    row_a = ScheduleRequest.objects.create(project=proj_a, status=ScheduleRequestStatus.DISPATCHED)
    row_b = ScheduleRequest.objects.create(project=proj_b, status=ScheduleRequestStatus.DISPATCHED)

    _run_program_schedule(str(program.pk))

    row_a.refresh_from_db()
    row_b.refresh_from_db()
    assert row_a.status == ScheduleRequestStatus.DONE
    assert row_b.status == ScheduleRequestStatus.DONE


@pytest.mark.django_db
def test_program_pass_does_not_swallow_rows_dispatched_after_claim(calendar: Calendar) -> None:
    """A row created PENDING (after the claim snapshot) survives the pass — only the
    rows claimed up front are marked done, so a concurrent edit is never lost."""
    program, proj_a, _b, _a1, _b1 = _program(calendar, accepted=True)
    # A fresh PENDING row is not in the claimed (DISPATCHED) set.
    pending = ScheduleRequest.objects.create(project=proj_a, status=ScheduleRequestStatus.PENDING)

    _run_program_schedule(str(program.pk))

    pending.refresh_from_db()
    assert pending.status == ScheduleRequestStatus.PENDING


@pytest.mark.django_db
def test_program_pass_stamps_recalculated_at_on_every_member(calendar: Calendar) -> None:
    program, proj_a, proj_b, _a1, _b1 = _program(calendar, accepted=True)
    assert proj_a.recalculated_at is None and proj_b.recalculated_at is None

    _run_program_schedule(str(program.pk))

    proj_a.refresh_from_db()
    proj_b.refresh_from_db()
    assert proj_a.recalculated_at is not None
    assert proj_b.recalculated_at is not None


@pytest.mark.django_db
def test_program_pass_empty_program_still_coalesces_and_stamps(calendar: Calendar) -> None:
    """A program whose member projects have no schedulable tasks takes the empty
    path without crashing — it still marks the claimed outbox row done and stamps
    recalculated_at."""
    program = Program.objects.create(name="Shell only")
    proj = Project.objects.create(
        name="Shell", start_date=START, calendar=calendar, program=program
    )
    row = ScheduleRequest.objects.create(project=proj, status=ScheduleRequestStatus.DISPATCHED)

    _run_program_schedule(str(program.pk))

    row.refresh_from_db()
    proj.refresh_from_db()
    assert row.status == ScheduleRequestStatus.DONE
    assert proj.recalculated_at is not None


@pytest.mark.django_db
def test_program_pass_broadcasts_cpm_complete_per_member(
    calendar: Calendar, django_capture_on_commit_callbacks: object
) -> None:
    program, proj_a, proj_b, _a1, _b1 = _program(calendar, accepted=True)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        _run_program_schedule(str(program.pk))

    broadcast_projects = {
        call.kwargs.get("project_id") or call.args[0]
        for call in bcast.call_args_list
        if (call.kwargs.get("event_type") or (call.args[1] if len(call.args) > 1 else None))
        == "cpm_complete"
    }
    assert str(proj_a.pk) in broadcast_projects
    assert str(proj_b.pk) in broadcast_projects


@pytest.mark.django_db
def test_program_pass_excludes_backlog_and_soft_deleted(calendar: Calendar) -> None:
    """The program-scoped CPM feed must apply the same committed-task filter as the
    single-project pass: BACKLOG cards and soft-deleted tombstones in a member
    project are never admitted to the merged network, so the program pass cannot
    stamp early/late dates on them (#1772)."""
    from trueppm_api.apps.projects.models import TaskStatus

    program, _a, proj_b, a1, _b1 = _program(calendar, accepted=True)
    backlog = Task.objects.create(
        project=proj_b, name="Backlog idea", duration=3, status=TaskStatus.BACKLOG
    )
    deleted = Task.objects.create(project=proj_b, name="Deleted", duration=3)
    deleted.soft_delete()

    _run_program_schedule(str(program.pk))

    a1.refresh_from_db()
    backlog.refresh_from_db()
    deleted.refresh_from_db()
    # Committed cross-project task is scheduled; excluded rows get no dates.
    assert a1.early_start is not None
    assert backlog.early_start is None and backlog.early_finish is None
    assert deleted.early_start is None and deleted.early_finish is None
