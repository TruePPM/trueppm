"""A program pass the scheduler refuses ends cleanly and tells the member projects."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.utils import timezone
from trueppm_scheduler import InvalidScheduleInput

from trueppm_api.apps.projects.models import Calendar, Dependency, Program, Project, Task
from trueppm_api.apps.scheduling.models import (
    FailedTask,
    ScheduleRequest,
    ScheduleRequestStatus,
)
from trueppm_api.apps.scheduling.tasks import (
    _do_drain,
    _run_program_schedule,
    recalculate_program_schedule,
)
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus


def _program(bad: str = "summary") -> tuple[Program, Project, Project]:
    """Two projects joined by an accepted cross edge, one holding stored bad data.

    ``bad`` is ``"summary"`` (an SS link from a summary), ``"cycle"`` (a dependency
    cycle) or ``"none"`` (a schedulable program).
    """
    cal = Calendar.objects.create(name="Standard")
    program = Program.objects.create(name="Launch")
    a = Project.objects.create(name="A", start_date=date(2026, 3, 2), calendar=cal, program=program)
    b = Project.objects.create(name="B", start_date=date(2026, 3, 2), calendar=cal, program=program)
    summary = Task.objects.create(project=a, name="Phase", duration=0, wbs_path="1")
    leaf = Task.objects.create(project=a, name="Leaf", duration=2, wbs_path="1.1")
    other = Task.objects.create(project=a, name="Other", duration=1, wbs_path="2")
    target = Task.objects.create(project=b, name="Go-live", duration=1, wbs_path="1")
    if bad == "summary":
        Dependency.objects.create(predecessor=summary, successor=other, dep_type="SS")
    elif bad == "cycle":
        Dependency.objects.create(predecessor=other, successor=leaf, dep_type="FS")
        Dependency.objects.create(predecessor=leaf, successor=other, dep_type="FS")
    Dependency.objects.create(
        predecessor=leaf,
        successor=target,
        dep_type="FS",
        pending_acceptance=False,
        accepted_at=timezone.now(),
    )
    return program, a, b


@pytest.fixture
def program_with_bad_edge(db: object) -> tuple[Program, Project, Project]:
    return _program("summary")


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
    # The project owning the offending summary is told what to fix; the other member
    # only learns that another project blocked the program.
    assert "link to a specific leaf task instead" in TaskRun.objects.get(project=a).error_detail
    assert "another project" in TaskRun.objects.get(project=b).error_detail
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
    """A row that reaches DISPATCHED while the pass gathers belongs to the next pass."""
    program, a, b = program_with_bad_edge
    claimed = _dispatched(a)
    late: list[ScheduleRequest] = []

    def gather_then_refuse(*_args: Any, **_kwargs: Any) -> None:
        late.append(_dispatched(b))  # b had no DISPATCHED row when the pass claimed
        raise InvalidScheduleInput("refused")

    with patch(
        "trueppm_api.apps.projects.program_schedule.gather_program_schedule",
        side_effect=gather_then_refuse,
    ):
        recalculate_program_schedule.apply(args=[str(program.pk)])

    claimed.refresh_from_db()
    late[0].refresh_from_db()
    assert claimed.status == ScheduleRequestStatus.DONE
    assert late[0].status == ScheduleRequestStatus.DISPATCHED


@pytest.mark.django_db
def test_the_failed_task_replays_with_the_program_id(
    program_with_bad_edge: tuple[Program, Project, Project],
) -> None:
    """A requeue re-runs the task with ``failed.args``; they must name the program."""
    program, _a, _b = program_with_bad_edge
    recalculate_program_schedule.apply(args=[str(program.pk)])
    failed = FailedTask.objects.get()
    assert failed.args == [str(program.pk)]
    runs_before = TaskRun.objects.count()

    recalculate_program_schedule.apply(args=failed.args)

    assert TaskRun.objects.count() > runs_before


@pytest.mark.django_db
def test_a_stored_cycle_ends_the_program_pass_cleanly() -> None:
    program, a, b = _program("cycle")
    claimed = [_dispatched(a), _dispatched(b)]

    result = recalculate_program_schedule.apply(args=[str(program.pk)])

    assert result.successful()
    assert TaskRun.objects.filter(status=TaskRunStatus.FAILED).count() == 2
    for row in claimed:
        row.refresh_from_db()
        assert row.status == ScheduleRequestStatus.DONE


@pytest.mark.django_db
def test_a_member_deleted_during_the_pass_does_not_strand_the_claimed_rows(
    program_with_bad_edge: tuple[Program, Project, Project],
) -> None:
    program, a, b = program_with_bad_edge
    claimed = _dispatched(a)
    _dispatched(b)

    def gone_then_refuse(*_args: Any, **_kwargs: Any) -> None:
        Project.objects.filter(pk=b.pk).delete()
        raise InvalidScheduleInput("refused")

    with patch(
        "trueppm_api.apps.projects.program_schedule.gather_program_schedule",
        side_effect=gone_then_refuse,
    ):
        result = recalculate_program_schedule.apply(args=[str(program.pk)])

    assert result.successful()
    claimed.refresh_from_db()
    assert claimed.status == ScheduleRequestStatus.DONE
    assert TaskRun.objects.get(project=a).status == TaskRunStatus.FAILED


@pytest.mark.django_db
def test_a_direct_call_without_a_task_still_raises_the_refusal(
    program_with_bad_edge: tuple[Program, Project, Project],
) -> None:
    """The demo overlay calls the pass with no Celery task and relies on the exception."""
    program, a, _b = program_with_bad_edge
    row = _dispatched(a)

    with pytest.raises(InvalidScheduleInput):
        _run_program_schedule(str(program.pk))

    row.refresh_from_db()
    assert row.status == ScheduleRequestStatus.DISPATCHED


@pytest.mark.django_db
def test_escalating_to_a_program_pass_does_not_stamp_recalculated_at(
    program_with_bad_edge: tuple[Program, Project, Project],
) -> None:
    """The member's own task hands off and writes nothing, so nothing is "recalculated"."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    _program_obj, a, _b = program_with_bad_edge

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_program_schedule.delay") as delay:
        recalculate_schedule.apply(args=[str(a.pk)])

    delay.assert_called_once_with(str(a.program_id))
    a.refresh_from_db()
    assert a.recalculated_at is None


@pytest.mark.django_db
def test_a_successful_program_pass_stamps_every_member() -> None:
    program, a, b = _program("none")

    _run_program_schedule(str(program.pk))

    for project in (a, b):
        project.refresh_from_db()
        assert project.recalculated_at is not None


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


@pytest.mark.django_db
def test_repairing_the_edge_lets_the_program_pass_succeed_and_stamp() -> None:
    program, a, _b = _program("summary")
    first = _dispatched(a)
    recalculate_program_schedule.apply(args=[str(program.pk)])
    first.refresh_from_db()
    assert first.status == ScheduleRequestStatus.DONE
    a.refresh_from_db()
    assert a.recalculated_at is None

    Dependency.objects.filter(dep_type="SS").update(is_deleted=True)
    second = _dispatched(a)
    recalculate_program_schedule.apply(args=[str(program.pk)])

    second.refresh_from_db()
    a.refresh_from_db()
    assert second.status == ScheduleRequestStatus.DONE
    assert a.recalculated_at is not None


@pytest.mark.django_db
@pytest.mark.parametrize("bad", ["summary", "none"])
def test_a_draft_member_schedules_itself_instead_of_escalating(bad: str) -> None:
    """The program pass leaves drafts out, so a draft that escalated would loop forever."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    program, a, _b = _program(bad)
    draft = Project.objects.create(
        name="Draft",
        start_date=date(2026, 3, 2),
        calendar=a.calendar,
        program=program,
        lifecycle="draft",
    )
    Task.objects.create(project=draft, name="D1", duration=1, wbs_path="1")
    row = _dispatched(draft)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_program_schedule.delay") as pd:
        recalculate_schedule.apply(args=[str(draft.pk)])
    pd.assert_not_called()
    recalculate_program_schedule.apply(args=[str(program.pk)])
    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay") as delay:
        _do_drain()
        _do_drain()

    row.refresh_from_db()
    draft.refresh_from_db()
    assert row.status == ScheduleRequestStatus.DONE
    assert draft.recalculated_at is not None
    delay.assert_not_called()
    assert not FailedTask.objects.filter(project_id=draft.pk).exists()


@pytest.mark.django_db
def test_a_refusal_in_one_project_is_not_disclosed_to_another_projects_members(
    django_capture_on_commit_callbacks: Any,
) -> None:
    """ADR-0120 D5: B's members must not read A's task id or estimate values."""
    from django.contrib.auth import get_user_model
    from rest_framework.test import APIClient

    from trueppm_api.apps.access.models import ProjectMembership, Role

    program, a, b = _program("none")
    offender = Task.objects.get(project=a, name="Other")
    Task.objects.filter(pk=offender.pk).update(duration=40000)
    user_model = get_user_model()
    viewer_b = user_model.objects.create_user("viewer_b", password="x")
    owner_a = user_model.objects.create_user("owner_a", password="x")
    ProjectMembership.objects.create(project=b, user=viewer_b, role=Role.VIEWER)
    ProjectMembership.objects.create(project=a, user=owner_a, role=Role.OWNER)

    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event") as bc,
        django_capture_on_commit_callbacks(execute=True),
    ):
        recalculate_program_schedule.apply(args=[str(program.pk)])

    secrets = (str(offender.pk), "40000")
    client = APIClient()
    client.force_authenticate(user=viewer_b)
    for url in (
        f"/api/v1/projects/{b.pk}/scheduler-runs/",
        f"/api/v1/projects/{b.pk}/task-runs/",
    ):
        response = client.get(url)
        assert response.status_code == 200
        body = response.content.decode()
        assert "FAILED" in body.upper()
        assert not any(secret in body for secret in secrets)
    b_events = [c.kwargs for c in bc.call_args_list if c.kwargs["project_id"] == str(b.pk)]
    assert b_events
    assert not any(secret in str(event) for event in b_events for secret in secrets)

    a_run = TaskRun.objects.get(project=a)
    assert str(offender.pk) in a_run.error_detail
    client.force_authenticate(user=owner_a)
    assert str(offender.pk) in client.get(f"/api/v1/projects/{a.pk}/task-runs/").content.decode()
    assert str(offender.pk) in FailedTask.objects.get().exception_message
