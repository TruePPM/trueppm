"""Tests for the auto-scheduling Celery task and trigger endpoint."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

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
    return User.objects.create_user(username="sched_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Sched", start_date=date(2026, 1, 5), calendar=calendar)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=3)


@pytest.fixture
def scheduler_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Task create triggers recalculate_schedule.delay
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_task_create_triggers_schedule(user: object, project: Project, calendar: Calendar) -> None:
    """Creating a Task via the API enqueues recalculate_schedule for its project."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock()
        resp = c.post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "Build", "duration": 2},
        )
        assert resp.status_code == 201
        mock_task.delay.assert_called_once_with(str(project.pk))


@pytest.mark.django_db(transaction=True)
def test_task_delete_triggers_schedule(user: object, project: Project, task: Task) -> None:
    """Deleting a Task via the API enqueues recalculate_schedule."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock()
        resp = c.delete(f"/api/v1/tasks/{task.pk}/")
        assert resp.status_code == 204
        mock_task.delay.assert_called_once_with(str(project.pk))


# ---------------------------------------------------------------------------
# Redis idempotency lock — collision causes re-queue
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_schedule_lock_collision_requeues(project: Project) -> None:
    """When the Redis lock is already held, the task re-queues itself."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    mock_redis = MagicMock()
    # SET NX returns None (falsy) when lock is already held.
    mock_redis.set.return_value = None

    with (
        patch("trueppm_api.apps.scheduling.tasks.redis") as mock_redis_module,
        patch.object(recalculate_schedule, "apply_async") as mock_apply,
    ):
        mock_redis_module.from_url.return_value = mock_redis

        # Call the task directly (bypass Celery worker).
        self_mock = MagicMock()
        self_mock.apply_async = mock_apply

        # Import the underlying function to call it with the mocked self.
        from trueppm_api.apps.scheduling import tasks as sched_module

        sched_module.recalculate_schedule.__wrapped__(self_mock, str(project.pk))  # type: ignore[attr-defined]

        mock_apply.assert_called_once_with(
            args=[str(project.pk)],
            countdown=sched_module._REQUEUE_COUNTDOWN,
        )


# ---------------------------------------------------------------------------
# Manual trigger endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_trigger_endpoint_requires_scheduler_role(user: object, project: Project) -> None:
    """A Member cannot trigger the schedule endpoint."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    resp = c.post(f"/api/v1/projects/{project.pk}/schedule/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_trigger_endpoint_enqueues_task(scheduler_client: APIClient, project: Project) -> None:
    """A Scheduler-role user can trigger the schedule endpoint."""
    with patch("trueppm_api.apps.scheduling.views.recalculate_schedule") as mock_task:
        mock_async = MagicMock()
        mock_async.id = "test-celery-id"
        mock_task.delay.return_value = mock_async
        resp = scheduler_client.post(f"/api/v1/projects/{project.pk}/schedule/")
    assert resp.status_code == 202
    assert "task_id" in resp.data


@pytest.mark.django_db
def test_trigger_endpoint_404_for_missing_project(scheduler_client: APIClient) -> None:
    import uuid

    fake_pk = uuid.uuid4()
    resp = scheduler_client.post(f"/api/v1/projects/{fake_pk}/schedule/")
    assert resp.status_code == 404
