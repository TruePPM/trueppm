"""Tests for actual_start / actual_finish auto-set and schedule variance (#80)."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
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
    return Task.objects.create(project=project, name="T1", duration=5)


def _patch(client: APIClient, task: Task, data: dict) -> object:  # type: ignore[type-arg]
    """PATCH a task with broadcast and scheduling mocked out."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        return client.patch(f"/api/v1/tasks/{task.pk}/", data, format="json")


# ---------------------------------------------------------------------------
# Auto-set on status transition
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_actual_start_set_on_in_progress(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"status": "IN_PROGRESS"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start == timezone.localdate()
    assert task.actual_finish is None


@pytest.mark.django_db
def test_actual_finish_set_on_complete(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"status": "COMPLETE"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start == timezone.localdate()
    assert task.actual_finish == timezone.localdate()


@pytest.mark.django_db
def test_actual_start_not_overwritten_on_complete(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """If actual_start was set when task went IN_PROGRESS, COMPLETE should not change it."""
    _patch(client, task, {"status": "IN_PROGRESS"})
    task.refresh_from_db()
    original_start = task.actual_start

    _patch(client, task, {"status": "COMPLETE"})
    task.refresh_from_db()
    assert task.actual_start == original_start
    assert task.actual_finish == timezone.localdate()


@pytest.mark.django_db
def test_actual_finish_cleared_on_reopen(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    _patch(client, task, {"status": "COMPLETE"})
    task.refresh_from_db()
    assert task.actual_finish is not None

    _patch(client, task, {"status": "IN_PROGRESS"})
    task.refresh_from_db()
    assert task.actual_finish is None
    assert task.actual_start is not None  # actual_start preserved


@pytest.mark.django_db
def test_on_hold_does_not_set_actual_dates(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"status": "ON_HOLD"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start is None
    assert task.actual_finish is None


# ---------------------------------------------------------------------------
# Manual override
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_explicit_actual_start_takes_precedence(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    override = "2026-03-15"
    r = _patch(client, task, {"status": "IN_PROGRESS", "actual_start": override})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start == date(2026, 3, 15)


@pytest.mark.django_db
def test_explicit_actual_finish_takes_precedence(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    override = "2026-04-20"
    r = _patch(client, task, {"status": "COMPLETE", "actual_finish": override})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_finish == date(2026, 4, 20)


@pytest.mark.django_db
def test_explicit_actual_finish_on_reopen_is_preserved(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    """If PM explicitly sets actual_finish while reopening, don't clear it."""
    _patch(client, task, {"status": "COMPLETE"})

    keep_date = "2026-04-10"
    r = _patch(client, task, {"status": "IN_PROGRESS", "actual_finish": keep_date})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_finish == date(2026, 4, 10)


# ---------------------------------------------------------------------------
# No status change — actual dates not auto-set
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_non_status_patch_does_not_auto_set(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"name": "Renamed"})
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.actual_start is None
    assert task.actual_finish is None


# ---------------------------------------------------------------------------
# Schedule variance
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_schedule_variance_computed(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    # Set up: early_finish via direct DB write (simulating CPM), actual_finish via API
    Task.objects.filter(pk=task.pk).update(early_finish=date(2026, 4, 10))
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-13"})

    r = _patch(client, task, {"name": "T1"})  # re-fetch via PATCH response
    assert r.status_code == 200
    assert r.data["schedule_variance_days"] == 3  # 3 days late


@pytest.mark.django_db
def test_schedule_variance_null_when_incomplete(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    r = _patch(client, task, {"name": "T1"})
    assert r.status_code == 200
    assert r.data["schedule_variance_days"] is None


@pytest.mark.django_db
def test_schedule_variance_negative_when_early(
    client: APIClient, task: Task, membership: ProjectMembership
) -> None:
    Task.objects.filter(pk=task.pk).update(early_finish=date(2026, 4, 15))
    _patch(client, task, {"status": "COMPLETE", "actual_finish": "2026-04-12"})

    r = _patch(client, task, {"name": "T1"})
    assert r.status_code == 200
    assert r.data["schedule_variance_days"] == -3  # 3 days early


# ---------------------------------------------------------------------------
# API response includes actual date fields
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_includes_actual_date_fields(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(t for t in results if t["id"] == str(task.pk))
    assert "actual_start" in first
    assert "actual_finish" in first
    assert "schedule_variance_days" in first
    assert first["actual_start"] is None
    assert first["actual_finish"] is None
