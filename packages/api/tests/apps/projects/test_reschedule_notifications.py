"""Targeted in-app notifications when a schedule-canvas reschedule lands (#497).

A Confirmed reschedule (ADR-0067) PATCHes ``planned_start``. When that lands on a
task someone else is committed to, the assignee gets a dedicated
``task.due_date_changed`` notification (old + new dates, deep-linked to the task),
and — when the task is in an ACTIVE sprint — the rest of the sprint team gets a
``sprint.task_rescheduled`` notification. Nobody is double-notified and the actor
is never notified of their own edit.

Notifications are created inside ``transaction.on_commit``, so the tests run the
callbacks via ``django_capture_on_commit_callbacks`` and assert against the real
Notification rows (the gating falls through DEFAULT_PREFERENCES → in_app ON).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Notification
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
)

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="RsProject", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def admin(db: object) -> Any:
    return User.objects.create_user(username="rs_admin", password="pw")


@pytest.fixture
def bob(db: object) -> Any:
    return User.objects.create_user(username="rs_bob", password="pw")


@pytest.fixture
def carol(db: object) -> Any:
    return User.objects.create_user(username="rs_carol", password="pw")


@pytest.fixture
def memberships(project: Project, admin: Any, bob: Any, carol: Any) -> None:
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=bob, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=carol, role=Role.MEMBER)


@pytest.fixture
def client(admin: Any, memberships: None) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


def _task_url(task: Task) -> str:
    return f"/api/v1/tasks/{task.pk}/"


def _notes(user: Any, event_type: str) -> list[Notification]:
    return list(Notification.objects.filter(recipient=user, event_type=event_type))


@pytest.mark.django_db
def test_planned_start_change_notifies_assignee_with_old_new_and_deeplink(
    client: APIClient,
    project: Project,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(
        project=project, name="Login API", duration=1, assignee=bob, planned_start=date(2026, 6, 10)
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(_task_url(task), {"planned_start": "2026-06-17"}, format="json")
    assert resp.status_code == 200, resp.data

    notes = _notes(bob, "task.due_date_changed")
    assert len(notes) == 1
    note = notes[0]
    # Old and new dates both present; deep-link FK points at the task (#497).
    assert "2026-06-10" in note.body
    assert "2026-06-17" in note.body
    assert str(note.task_id) == str(task.pk)


@pytest.mark.django_db
def test_no_self_notification_when_assignee_is_actor(
    client: APIClient,
    project: Project,
    admin: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    # The PM edits their own committed task — no notification (assignee == actor).
    task = Task.objects.create(project=project, name="My own task", duration=1, assignee=admin)
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(_task_url(task), {"planned_start": "2026-06-17"}, format="json")
    assert resp.status_code == 200, resp.data
    assert _notes(admin, "task.due_date_changed") == []


@pytest.mark.django_db
def test_active_sprint_notifies_team_excluding_assignee_and_actor(
    client: APIClient,
    project: Project,
    bob: Any,
    carol: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="Sprint 4",
        start_date=date(2026, 6, 1),
        finish_date=date(2026, 6, 14),
        state=SprintState.ACTIVE,
    )
    moved = Task.objects.create(
        project=project, name="Login API", duration=1, assignee=bob, sprint=sprint
    )
    # carol owns another task in the same sprint — she is "the team".
    Task.objects.create(
        project=project, name="Carol task", duration=1, assignee=carol, sprint=sprint
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(_task_url(moved), {"planned_start": "2026-06-17"}, format="json")
    assert resp.status_code == 200, resp.data

    # Assignee gets exactly one targeted notice; never the team event too.
    assert len(_notes(bob, "task.due_date_changed")) == 1
    assert _notes(bob, "sprint.task_rescheduled") == []
    # The rest of the team gets the sprint event, deep-linked to the moved task.
    carol_team = _notes(carol, "sprint.task_rescheduled")
    assert len(carol_team) == 1
    assert str(carol_team[0].task_id) == str(moved.pk)
    assert "Sprint 4" in carol_team[0].subject
    # The actor (admin) is never notified of their own edit.
    assert Notification.objects.filter(recipient_id=None).count() == 0


@pytest.mark.django_db
def test_planned_sprint_does_not_fan_out_to_team(
    client: APIClient,
    project: Project,
    bob: Any,
    carol: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="Sprint 5",
        start_date=date(2026, 7, 1),
        finish_date=date(2026, 7, 14),
        state=SprintState.PLANNED,
    )
    moved = Task.objects.create(
        project=project, name="Login API", duration=1, assignee=bob, sprint=sprint
    )
    Task.objects.create(
        project=project, name="Carol task", duration=1, assignee=carol, sprint=sprint
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(_task_url(moved), {"planned_start": "2026-07-08"}, format="json")
    assert resp.status_code == 200, resp.data
    assert len(_notes(bob, "task.due_date_changed")) == 1  # assignee still notified
    assert _notes(carol, "sprint.task_rescheduled") == []  # PLANNED → no fan-out


@pytest.mark.django_db
def test_non_date_change_fires_no_reschedule_notification(
    client: APIClient,
    project: Project,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Login API", duration=1, assignee=bob)
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(_task_url(task), {"progress": 25}, format="json")
    assert resp.status_code == 200, resp.data
    assert _notes(bob, "task.due_date_changed") == []
