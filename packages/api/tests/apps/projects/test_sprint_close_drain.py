"""Sprint close drain — outbox semantics, idempotency, ScheduleRequest emission."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.tasks import _do_drain, close_sprint
from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

User = get_user_model()


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> object:
    """Bypass the Redis SET NX lock so idempotent_task wrappers run inline.

    The lock_extender thread is also short-circuited — its EXTEND/RELEASE
    Lua scripts hit the same mocked client and return acquired/released.
    """
    mock_client = MagicMock()
    mock_client.set.return_value = True  # SET NX succeeded — we own the lock
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.redis_lib") as redis_module:
        redis_module.from_url.return_value = mock_client
        yield mock_client


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="closer", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _make_active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=10,
        committed_task_count=3,
    )


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_completes_request(_broadcast: object, user: object, project: Project) -> None:
    s = _make_active_sprint(project)
    Task.objects.create(
        project=project,
        name="Done",
        duration=1,
        sprint=s,
        story_points=5,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=project,
        name="Open",
        duration=1,
        sprint=s,
        story_points=5,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(sprint=s, requested_by=user, carry_over_to="backlog")

    close_sprint.run(str(req.id))

    req.refresh_from_db()
    s.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.COMPLETED
    assert s.state == SprintState.COMPLETED
    assert s.completed_points == 5
    assert s.completed_task_count == 1
    assert s.closed_at is not None
    # Carry-over moved the open task back to backlog
    open_task = Task.objects.get(name="Open")
    assert open_task.sprint_id is None
    assert open_task.status == TaskStatus.BACKLOG


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_emits_schedule_request_with_sprint_closed_reason(
    _broadcast: object, project: Project
) -> None:
    s = _make_active_sprint(project)
    req = SprintCloseRequest.objects.create(sprint=s)
    close_sprint.run(str(req.id))
    sr = ScheduleRequest.objects.filter(project=project).first()
    assert sr is not None
    assert sr.reason == ScheduleRequestReason.SPRINT_CLOSED


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_idempotent_on_already_completed(_broadcast: object, project: Project) -> None:
    s = Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
        closed_at=timezone.now(),
    )
    req = SprintCloseRequest.objects.create(sprint=s)
    close_sprint.run(str(req.id))
    req.refresh_from_db()
    # Short-circuited: marked completed without changing the sprint.
    assert req.status == SprintCloseRequestStatus.COMPLETED


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_carry_over_to_other_sprint(_broadcast: object, project: Project) -> None:
    s = _make_active_sprint(project)
    target = Sprint.objects.create(
        project=project,
        name="Next",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )
    Task.objects.create(
        project=project,
        name="Open",
        duration=1,
        sprint=s,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(sprint=s, carry_over_to=str(target.pk))
    close_sprint.run(str(req.id))
    moved = Task.objects.get(name="Open")
    assert moved.sprint_id == target.pk


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
def test_close_sprint_failed_for_cancelled(_broadcast: object, project: Project) -> None:
    s = Sprint.objects.create(
        project=project,
        name="X",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.CANCELLED,
    )
    req = SprintCloseRequest.objects.create(sprint=s)
    close_sprint.run(str(req.id))
    req.refresh_from_db()
    assert req.status == SprintCloseRequestStatus.FAILED
    assert "cancelled" in req.error_message.lower()


@patch("trueppm_api.apps.projects.tasks.close_sprint.delay")
def test_drain_dispatches_pending_rows(mock_delay: object, project: Project) -> None:
    s = _make_active_sprint(project)
    req = SprintCloseRequest.objects.create(sprint=s)
    # Push requested_at backward to clear the >2 s minimum age filter.
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        requested_at=timezone.now() - timedelta(seconds=10)
    )
    _do_drain()
    assert mock_delay.called  # type: ignore[attr-defined]


@patch("trueppm_api.apps.projects.tasks.close_sprint.delay")
def test_drain_recovers_orphaned_in_flight(mock_delay: object, project: Project) -> None:
    s = _make_active_sprint(project)
    req = SprintCloseRequest.objects.create(sprint=s)
    # Mark IN_FLIGHT in the past — must be older than 5-minute orphan window.
    long_ago = timezone.now() - timedelta(minutes=10)
    SprintCloseRequest.objects.filter(pk=req.pk).update(
        status=SprintCloseRequestStatus.IN_FLIGHT,
        started_at=long_ago,
        requested_at=long_ago,
    )
    _do_drain()
    req.refresh_from_db()
    # Recovery path: row is reset to PENDING; subsequent drain dispatches it.
    assert req.status == SprintCloseRequestStatus.PENDING
