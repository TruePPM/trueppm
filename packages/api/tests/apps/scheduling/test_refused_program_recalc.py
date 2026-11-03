"""A program pass the scheduler refuses ends cleanly and tells the member projects."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Dependency, Program, Project, Task
from trueppm_api.apps.scheduling.models import (
    FailedTask,
    ScheduleRequest,
    ScheduleRequestStatus,
)
from trueppm_api.apps.scheduling.tasks import _do_drain, recalculate_program_schedule
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus


@pytest.fixture
def program_with_bad_edge(db: object) -> tuple[Program, Project, Project]:
    """Two projects joined by an accepted cross edge; one holds an SS-from-summary link."""
    cal = Calendar.objects.create(name="Standard")
    program = Program.objects.create(name="Launch")
    a = Project.objects.create(name="A", start_date=date(2026, 3, 2), calendar=cal, program=program)
    b = Project.objects.create(name="B", start_date=date(2026, 3, 2), calendar=cal, program=program)
    summary = Task.objects.create(project=a, name="Phase", duration=0, wbs_path="1")
    leaf = Task.objects.create(project=a, name="Leaf", duration=2, wbs_path="1.1")
    other = Task.objects.create(project=a, name="Other", duration=1, wbs_path="2")
    target = Task.objects.create(project=b, name="Go-live", duration=1, wbs_path="1")
    Dependency.objects.create(predecessor=summary, successor=other, dep_type="SS")
    Dependency.objects.create(
        predecessor=leaf,
        successor=target,
        dep_type="FS",
        pending_acceptance=False,
        accepted_at=timezone.now(),
    )
    return program, a, b


def _dispatched(project: Project) -> ScheduleRequest:
    return ScheduleRequest.objects.create(
        project=project,
        status=ScheduleRequestStatus.DISPATCHED,
        dispatched_at=datetime.now(UTC) - timedelta(minutes=30),
    )


@pytest.mark.django_db
def test_refused_program_pass_ends_cleanly_and_signals_every_member(
    program_with_bad_edge: tuple[Program, Project, Project],
    django_capture_on_commit_callbacks: Any,
) -> None:
    program, a, b = program_with_bad_edge
    claimed = [_dispatched(a), _dispatched(b)]

    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event") as bc,
        django_capture_on_commit_callbacks(execute=True),
    ):
        result = recalculate_program_schedule.apply(args=[str(program.pk)])

    assert result.successful()
    for project in (a, b):
        run = TaskRun.objects.get(project=project, task_name="scheduling.recalculate")
        assert run.status == TaskRunStatus.FAILED
        assert "link to a specific leaf task instead" in run.error_detail
    failed_for = {
        c.kwargs["project_id"]
        for c in bc.call_args_list
        if c.kwargs["event_type"] == "task_run_failed"
    }
    assert failed_for == {str(a.pk), str(b.pk)}
    for row in claimed:
        row.refresh_from_db()
        assert row.status == ScheduleRequestStatus.DONE
    assert FailedTask.objects.count() == 1


@pytest.mark.django_db
def test_refused_program_pass_retires_only_the_rows_it_claimed(
    program_with_bad_edge: tuple[Program, Project, Project],
) -> None:
    program, a, _b = program_with_bad_edge
    claimed = _dispatched(a)
    fresh = ScheduleRequest.objects.create(project=a)  # an edit that landed meanwhile

    recalculate_program_schedule.apply(args=[str(program.pk)])

    claimed.refresh_from_db()
    fresh.refresh_from_db()
    assert claimed.status == ScheduleRequestStatus.DONE
    assert fresh.status == ScheduleRequestStatus.PENDING


@pytest.mark.django_db
def test_drain_does_not_redispatch_a_refused_program_pass(
    program_with_bad_edge: tuple[Program, Project, Project],
) -> None:
    program, a, b = program_with_bad_edge
    _dispatched(a)
    _dispatched(b)
    recalculate_program_schedule.apply(args=[str(program.pk)])
    assert FailedTask.objects.count() == 1

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay") as delay:
        _do_drain()
        _do_drain()

    delay.assert_not_called()
    assert FailedTask.objects.count() == 1


@pytest.mark.django_db
def test_a_refused_program_pass_leaves_the_system_health_outbox_card_clean(
    program_with_bad_edge: tuple[Program, Project, Project],
) -> None:
    from trueppm_api.apps.observability.selectors import STATUS_OK, _outbox_card

    program, a, _b = program_with_bad_edge
    _dispatched(a)
    recalculate_program_schedule.apply(args=[str(program.pk)])

    assert _outbox_card()["status"] == STATUS_OK
