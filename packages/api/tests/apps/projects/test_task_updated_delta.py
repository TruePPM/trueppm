"""ADR-0152 (#327): field-level ``task_updated`` delta broadcast.

A task PATCH must broadcast ``task_updated`` carrying the changed-field *names*,
the post-commit ``server_version``, and the acting user — but never field values
(those are role-gated, ADR-0104). The originating client uses ``actor_id`` to
suppress its own echo.
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
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.sync.broadcast import broadcast_task_updated

User = get_user_model()


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


@pytest.fixture
def membership(project: Project, user: Any) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: Any, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=5)


def _task_updated_calls(mock_bcast: Any) -> list[tuple[str, str, dict[str, Any]]]:
    return [c.args for c in mock_bcast.call_args_list if c.args[1] == "task_updated"]


@pytest.mark.django_db
def test_patch_emits_task_updated_delta(
    client: APIClient,
    task: Task,
    user: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
        assert r.status_code == 200

    calls = _task_updated_calls(mock_bcast)
    assert calls, "expected a task_updated broadcast"
    _pid, _event, payload = calls[-1]
    assert payload["id"] == str(task.pk)
    assert "status" in payload["changed_fields"]
    # Values must never be on the wire — only names (ADR-0104 gating).
    assert "IN_PROGRESS" not in payload["changed_fields"]
    assert isinstance(payload["version"], int) and payload["version"] >= 1
    assert payload["actor_id"] == str(user.pk)
    assert "ts" in payload


@pytest.mark.django_db
def test_non_schedule_field_patch_still_broadcasts_delta(
    client: APIClient,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A name-only edit doesn't move the schedule but must still notify collaborators."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {"name": "Renamed"}, format="json")
        assert r.status_code == 200

    calls = _task_updated_calls(mock_bcast)
    assert calls, "expected a task_updated broadcast on a non-schedule edit"
    _pid, _event, payload = calls[-1]
    assert payload["changed_fields"] == ["name"]


def test_broadcast_task_updated_payload_shape() -> None:
    """Helper assembles a stable, sorted, names-only payload."""
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as m:
        broadcast_task_updated(
            "p1", task_id="t1", changed_fields=["status", "assignee"], version=3, actor_id="u1"
        )
    _pid, event, payload = m.call_args.args
    assert event == "task_updated"
    assert payload["id"] == "t1"
    assert payload["changed_fields"] == ["assignee", "status"]  # sorted
    assert payload["version"] == 3
    assert payload["actor_id"] == "u1"
    assert "ts" in payload
