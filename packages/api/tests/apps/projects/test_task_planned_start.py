"""Tests for Task.planned_start field and API exposure (ADR-0014 MR !B)."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=3)


# ---------------------------------------------------------------------------
# Model defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_planned_start_defaults_to_null(project: Project) -> None:
    t = Task.objects.create(project=project, name="T", duration=1)
    assert t.planned_start is None


# ---------------------------------------------------------------------------
# API — read and write
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_includes_planned_start_field(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(t for t in results if t["id"] == str(task.pk))
    assert "planned_start" in first
    assert first["planned_start"] is None


@pytest.mark.django_db
def test_patch_planned_start_sets_value(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": "2026-05-01"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.planned_start == date(2026, 5, 1)


@pytest.mark.django_db
def test_patch_planned_start_to_null_clears_value(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    task.planned_start = date(2026, 5, 1)
    task.save(update_fields=["planned_start"])

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"planned_start": None},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.planned_start is None


@pytest.mark.django_db
def test_patch_invalid_date_rejected(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    r = client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"planned_start": "not-a-date"},
        format="json",
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Sync serializer includes planned_start
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_task_serializer_includes_planned_start(project: Project, task: Task) -> None:
    from trueppm_api.apps.sync.serializers import SyncTaskSerializer

    task.planned_start = date(2026, 5, 15)
    task.save(update_fields=["planned_start"])

    data = SyncTaskSerializer(task).data
    assert "planned_start" in data
    assert str(data["planned_start"]) == "2026-05-15"


@pytest.mark.django_db
def test_sync_task_serializer_planned_start_null_when_unset(
    project: Project, task: Task
) -> None:
    from trueppm_api.apps.sync.serializers import SyncTaskSerializer

    data = SyncTaskSerializer(task).data
    assert data["planned_start"] is None
