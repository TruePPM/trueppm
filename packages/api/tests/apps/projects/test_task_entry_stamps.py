"""Tests for Task.status_changed_at and Task.priority_rank (issue #105, board batch 7)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus

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
    return Task.objects.create(project=project, name="T1", duration=2)


# ---------------------------------------------------------------------------
# status_changed_at — model behaviour
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_status_changed_at_set_on_create(project: Project) -> None:
    before = timezone.now()
    task = Task.objects.create(project=project, name="T", duration=1)
    assert task.status_changed_at is not None
    assert task.status_changed_at >= before


@pytest.mark.django_db
def test_status_changed_at_updates_on_status_change(task: Task) -> None:
    old_ts = task.status_changed_at
    task.status = TaskStatus.IN_PROGRESS
    task.save(update_fields=["status"])
    task.refresh_from_db()
    assert task.status_changed_at is not None
    assert task.status_changed_at > old_ts  # type: ignore[operator]


@pytest.mark.django_db
def test_status_changed_at_not_updated_on_other_field_change(task: Task) -> None:
    original_ts = task.status_changed_at
    task.name = "Renamed"
    task.save(update_fields=["name"])
    task.refresh_from_db()
    assert task.status_changed_at == original_ts


@pytest.mark.django_db
def test_status_changed_at_not_updated_on_full_save_without_status_change(task: Task) -> None:
    original_ts = task.status_changed_at
    task.notes = "Updated notes"
    task.save()
    task.refresh_from_db()
    # status did not change so timestamp stays the same
    assert task.status_changed_at == original_ts


# ---------------------------------------------------------------------------
# status_changed_at — API surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_exposes_status_changed_at(
    client: APIClient, project: Project, task: Task
) -> None:
    resp = client.get("/api/v1/tasks/", {"project": str(project.pk)})
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1
    assert "status_changed_at" in results[0]
    assert results[0]["status_changed_at"] is not None


@pytest.mark.django_db
def test_status_changed_at_is_read_only_via_api(
    client: APIClient, project: Project, task: Task
) -> None:
    """Clients must not be able to directly set status_changed_at."""
    forged_ts = "2020-01-01T00:00:00Z"
    resp = client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"status_changed_at": forged_ts},
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    # The field must not have been overwritten to the forged value.
    assert task.status_changed_at is not None
    assert task.status_changed_at.year != 2020


# ---------------------------------------------------------------------------
# priority_rank — model behaviour
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_priority_rank_defaults_to_null(project: Project) -> None:
    task = Task.objects.create(project=project, name="T", duration=1)
    assert task.priority_rank is None


# ---------------------------------------------------------------------------
# priority_rank — API surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_exposes_priority_rank(client: APIClient, project: Project, task: Task) -> None:
    resp = client.get("/api/v1/tasks/", {"project": str(project.pk)})
    assert resp.status_code == 200
    result = resp.json()["results"][0]
    assert "priority_rank" in result
    assert result["priority_rank"] is None


@pytest.mark.django_db
def test_priority_rank_writable_via_patch(client: APIClient, project: Project, task: Task) -> None:
    resp = client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"priority_rank": 3},
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.priority_rank == 3


@pytest.mark.django_db
def test_priority_rank_clearable_to_null(client: APIClient, project: Project, task: Task) -> None:
    task.priority_rank = 5
    task.save(update_fields=["priority_rank"])
    resp = client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"priority_rank": None},
        format="json",
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.priority_rank is None
