"""Sprint-close carryover notifications (#1470, ADR-0232).

Verifies that close-time carry-over fires a ``task.moved_sprint`` in-app
notification to each carried task's assignee — the "my work hopped sprints and
nobody told me" gap — while excluding the closer, honoring the carry-eligible
status set, and never firing on a task that stayed put.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.notifications.models import (
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintCloseRequest,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.tasks import close_sprint

User = get_user_model()


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> object:
    """Bypass the Redis SET NX lock so the idempotent_task wrapper runs inline."""
    mock_client = MagicMock()
    mock_client.set.return_value = True
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.redis_lib") as redis_module:
        redis_module.from_url.return_value = mock_client
        yield mock_client


@pytest.fixture
def closer(db: object) -> Any:
    return User.objects.create_user(username="closer", password="pw")


@pytest.fixture
def priya(db: object) -> Any:
    return User.objects.create_user(username="priya", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 7",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )


def _planned_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 8",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
@pytest.mark.django_db
def test_carry_to_next_sprint_notifies_assignee_naming_origin_and_destination(
    _broadcast: object,
    closer: Any,
    priya: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    s = _active_sprint(project)
    target = _planned_sprint(project)
    task = Task.objects.create(
        project=project,
        name="Wire the login form",
        duration=1,
        sprint=s,
        assignee=priya,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(
        sprint=s, requested_by=closer, carry_over_to=str(target.pk)
    )

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    note = Notification.objects.filter(
        recipient=priya, event_type=NotificationEventType.TASK_MOVED_SPRINT
    ).first()
    assert note is not None
    # Names the origin and the destination sprint.
    assert "Sprint 7" in note.body
    assert "Sprint 8" in note.body
    assert "Wire the login form" in note.subject
    # Deep-links the inbox row to the moved task, scoped to the project.
    assert str(note.task_id) == str(task.id)
    assert str(note.project_id) == str(project.id)


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
@pytest.mark.django_db
def test_multiple_carried_tasks_collapse_to_one_summary_row(
    _broadcast: object,
    closer: Any,
    priya: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    # Priya owns two carried tasks — she gets ONE summary inbox row (noise
    # hard-NO), not one per task, with a count and no single deep-link.
    s = _active_sprint(project)
    target = _planned_sprint(project)
    for name in ("Task A", "Task B"):
        Task.objects.create(
            project=project,
            name=name,
            duration=1,
            sprint=s,
            assignee=priya,
            status=TaskStatus.IN_PROGRESS,
        )
    req = SprintCloseRequest.objects.create(
        sprint=s, requested_by=closer, carry_over_to=str(target.pk)
    )

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    notes = Notification.objects.filter(
        recipient=priya, event_type=NotificationEventType.TASK_MOVED_SPRINT
    )
    assert notes.count() == 1
    note = notes.first()
    assert note is not None
    assert "2 of your tasks" in note.body
    assert "Sprint 8" in note.body
    # A multi-task summary has no single task anchor.
    assert note.task_id is None


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
@pytest.mark.django_db
def test_actor_is_not_notified_about_their_own_carried_task(
    _broadcast: object,
    closer: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    s = _active_sprint(project)
    target = _planned_sprint(project)
    # The closer owns the carried task — they already know it moved.
    Task.objects.create(
        project=project,
        name="Closer's own task",
        duration=1,
        sprint=s,
        assignee=closer,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(
        sprint=s, requested_by=closer, carry_over_to=str(target.pk)
    )

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    assert not Notification.objects.filter(
        recipient=closer, event_type=NotificationEventType.TASK_MOVED_SPRINT
    ).exists()


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
@pytest.mark.django_db
def test_carry_to_backlog_names_the_backlog(
    _broadcast: object,
    closer: Any,
    priya: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    s = _active_sprint(project)
    Task.objects.create(
        project=project,
        name="Rolls to backlog",
        duration=1,
        sprint=s,
        assignee=priya,
        status=TaskStatus.REVIEW,
    )
    req = SprintCloseRequest.objects.create(sprint=s, requested_by=closer, carry_over_to="backlog")

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    note = Notification.objects.filter(
        recipient=priya, event_type=NotificationEventType.TASK_MOVED_SPRINT
    ).first()
    assert note is not None
    assert "the backlog" in note.body


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
@pytest.mark.django_db
def test_completed_task_that_stays_does_not_notify(
    _broadcast: object,
    closer: Any,
    priya: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    s = _active_sprint(project)
    target = _planned_sprint(project)
    # A COMPLETE task is not carried (apply_carry_over leaves it) — no signal.
    Task.objects.create(
        project=project,
        name="Shipped",
        duration=1,
        sprint=s,
        assignee=priya,
        status=TaskStatus.COMPLETE,
    )
    req = SprintCloseRequest.objects.create(
        sprint=s, requested_by=closer, carry_over_to=str(target.pk)
    )

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    assert not Notification.objects.filter(
        recipient=priya, event_type=NotificationEventType.TASK_MOVED_SPRINT
    ).exists()


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
@pytest.mark.django_db
def test_unassigned_carried_task_notifies_nobody(
    _broadcast: object,
    closer: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    s = _active_sprint(project)
    target = _planned_sprint(project)
    Task.objects.create(
        project=project,
        name="Nobody's task",
        duration=1,
        sprint=s,
        assignee=None,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(
        sprint=s, requested_by=closer, carry_over_to=str(target.pk)
    )

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    assert not Notification.objects.filter(
        event_type=NotificationEventType.TASK_MOVED_SPRINT
    ).exists()


@patch("trueppm_api.apps.sync.broadcast.broadcast_board_event")
@pytest.mark.django_db
def test_assignee_who_disabled_in_app_gets_no_row(
    _broadcast: object,
    closer: Any,
    priya: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    # Priya opted out of in-app for this event — the durable row is suppressed
    # (create_event_notifications only writes when in_app is enabled).
    NotificationPreference.objects.create(
        user=priya,
        event_type=NotificationEventType.TASK_MOVED_SPRINT,
        channel=NotificationChannel.IN_APP,
        enabled=False,
    )
    s = _active_sprint(project)
    target = _planned_sprint(project)
    Task.objects.create(
        project=project,
        name="Opted out",
        duration=1,
        sprint=s,
        assignee=priya,
        status=TaskStatus.IN_PROGRESS,
    )
    req = SprintCloseRequest.objects.create(
        sprint=s, requested_by=closer, carry_over_to=str(target.pk)
    )

    with django_capture_on_commit_callbacks(execute=True):
        close_sprint.run(str(req.id))

    assert not Notification.objects.filter(
        recipient=priya, event_type=NotificationEventType.TASK_MOVED_SPRINT
    ).exists()
