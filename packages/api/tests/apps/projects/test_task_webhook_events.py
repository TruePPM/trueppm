"""Tests for the four new task webhook events (#638, ADR-0083).

task.assigned / task.assignee_changed / task.due_date_changed fire from
TaskViewSet.perform_update (and task.assigned also from accept_suggestion);
task.mentioned fires from the comment viewset. Each fires only when the relevant
field actually changed. The events are dispatched inside transaction.on_commit,
so the tests use django_capture_on_commit_callbacks to execute the callbacks and
assert against a patched _dispatch_webhooks trampoline.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import views
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="EvProject", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def admin(db: object) -> Any:
    return User.objects.create_user(username="ev_admin", password="pw")


@pytest.fixture
def bob(db: object) -> Any:
    return User.objects.create_user(username="bob", password="pw")


@pytest.fixture
def carol(db: object) -> Any:
    return User.objects.create_user(username="carol", password="pw")


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


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation pour", duration=1)


def _task_url(project: Project, task: Task) -> str:
    # TaskViewSet is registered at the top level (/api/v1/tasks/), not nested
    # under projects — comments are the nested route, tasks are not.
    return f"/api/v1/tasks/{task.pk}/"


def _fired_events(mock: Any) -> list[str]:
    """Event-type strings passed to _dispatch_webhooks (positional arg 1)."""
    return [call.args[1] for call in mock.call_args_list]


# ---------------------------------------------------------------------------
# task.assigned / task.assignee_changed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_assigning_unassigned_task_fires_task_assigned(
    client: APIClient,
    project: Project,
    task: Task,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_task_url(project, task), {"assignee": bob.pk}, format="json")
    assert resp.status_code == 200, resp.data
    events = _fired_events(mock_dispatch)
    assert "task.assigned" in events
    assert "task.assignee_changed" not in events


@pytest.mark.django_db
def test_reassigning_task_fires_assignee_changed(
    client: APIClient,
    project: Project,
    bob: Any,
    carol: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Pre-assigned", duration=1, assignee=bob)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_task_url(project, task), {"assignee": carol.pk}, format="json")
    assert resp.status_code == 200, resp.data
    events = _fired_events(mock_dispatch)
    assert "task.assignee_changed" in events
    assert "task.assigned" not in events


@pytest.mark.django_db
def test_clearing_assignee_fires_neither(
    client: APIClient,
    project: Project,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Pre-assigned", duration=1, assignee=bob)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_task_url(project, task), {"assignee": None}, format="json")
    assert resp.status_code == 200, resp.data
    events = _fired_events(mock_dispatch)
    assert "task.assigned" not in events
    assert "task.assignee_changed" not in events


@pytest.mark.django_db
def test_assigned_payload_carries_previous_assignee(
    client: APIClient,
    project: Project,
    bob: Any,
    carol: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Pre-assigned", duration=1, assignee=bob)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        client.patch(_task_url(project, task), {"assignee": carol.pk}, format="json")
    changed = next(c for c in mock_dispatch.call_args_list if c.args[1] == "task.assignee_changed")
    payload = changed.args[2]
    assert payload["previous_assignee"] == str(bob.pk)
    assert payload["assignee"] == str(carol.pk)


# ---------------------------------------------------------------------------
# task.due_date_changed — bound to ``deadline`` since #690 (was ``planned_start``)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_deadline_change_fires_due_date_changed(
    client: APIClient,
    project: Project,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_task_url(project, task), {"deadline": "2026-09-30"}, format="json")
    assert resp.status_code == 200, resp.data
    assert resp.data["deadline"] == "2026-09-30"
    changed = [c for c in mock_dispatch.call_args_list if c.args[1] == "task.due_date_changed"]
    assert len(changed) == 1
    payload = changed[0].args[2]
    assert payload["previous_deadline"] is None
    assert payload["deadline"] == "2026-09-30"
    # The pre-#690 key is gone: the event no longer describes planned_start.
    assert "previous_planned_start" not in payload


@pytest.mark.django_db
def test_clearing_deadline_fires_due_date_changed_with_previous(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Pour", duration=1, deadline=date(2026, 9, 30))
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_task_url(project, task), {"deadline": None}, format="json")
    assert resp.status_code == 200, resp.data
    changed = next(c for c in mock_dispatch.call_args_list if c.args[1] == "task.due_date_changed")
    assert changed.args[2]["previous_deadline"] == "2026-09-30"
    assert changed.args[2]["deadline"] is None


@pytest.mark.django_db
def test_planned_start_only_change_does_not_fire_due_date_changed(
    client: APIClient,
    project: Project,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The #690 rebind: a planned_start edit is no longer a due-date change."""
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(
            _task_url(project, task), {"planned_start": "2026-09-01"}, format="json"
        )
    assert resp.status_code == 200, resp.data
    events = _fired_events(mock_dispatch)
    assert "task.due_date_changed" not in events
    assert "task.updated" in events


@pytest.mark.django_db
def test_unchanged_deadline_does_not_fire_due_date_changed(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Pour", duration=1, deadline=date(2026, 9, 30))
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_task_url(project, task), {"deadline": "2026-09-30"}, format="json")
    assert resp.status_code == 200, resp.data
    assert "task.due_date_changed" not in _fired_events(mock_dispatch)


@pytest.mark.django_db
def test_deadline_round_trips_and_defaults_to_null(client: APIClient, project: Project) -> None:
    created = client.post(
        "/api/v1/tasks/", {"project": str(project.pk), "name": "New", "duration": 2}, format="json"
    )
    assert created.status_code == 201, created.data
    assert created.data["deadline"] is None
    url = f"/api/v1/tasks/{created.data['id']}/"
    assert client.patch(url, {"deadline": "2026-10-02"}, format="json").status_code == 200
    assert client.get(url).data["deadline"] == "2026-10-02"
    assert Task.objects.get(pk=created.data["id"]).deadline == date(2026, 10, 2)


@pytest.mark.django_db
def test_deadline_only_change_does_not_enqueue_recalc(
    client: APIClient,
    project: Project,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Annotation only (ADR-1049 §2): the engines never read ``deadline``."""
    with (
        patch.object(views, "_enqueue_recalculate") as mock_recalc,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_task_url(project, task), {"deadline": "2026-09-30"}, format="json")
    assert resp.status_code == 200, resp.data
    mock_recalc.assert_not_called()


@pytest.mark.django_db
def test_viewer_cannot_set_deadline(project: Project, task: Task) -> None:
    viewer = User.objects.create_user(username="ev_viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    resp = c.patch(_task_url(project, task), {"deadline": "2026-09-30"}, format="json")
    assert resp.status_code in (403, 404)
    task.refresh_from_db()
    assert task.deadline is None


@pytest.mark.django_db
def test_non_date_update_does_not_fire_due_date_changed(
    client: APIClient,
    project: Project,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_task_url(project, task), {"name": "Renamed"}, format="json")
    assert resp.status_code == 200, resp.data
    events = _fired_events(mock_dispatch)
    assert "task.due_date_changed" not in events
    assert "task.assigned" not in events
    # task.updated still fires for every update.
    assert "task.updated" in events


# ---------------------------------------------------------------------------
# task.mentioned
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_comment_mention_fires_task_mentioned(
    client: APIClient,
    project: Project,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    url = f"/api/v1/projects/{project.pk}/tasks/{task.pk}/comments/"
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.post(url, {"body": "@bob please review"}, format="json")
    assert resp.status_code == 201, resp.data
    events = _fired_events(mock_dispatch)
    assert "task.mentioned" in events
    mentioned = next(c for c in mock_dispatch.call_args_list if c.args[1] == "task.mentioned")
    assert mentioned.args[2]["comment_id"]
    assert mentioned.args[2]["mention_count"] >= 1


@pytest.mark.django_db
def test_comment_without_mention_does_not_fire(
    client: APIClient,
    project: Project,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    url = f"/api/v1/projects/{project.pk}/tasks/{task.pk}/comments/"
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.post(url, {"body": "no mentions here"}, format="json")
    assert resp.status_code == 201, resp.data
    assert "task.mentioned" not in _fired_events(mock_dispatch)
