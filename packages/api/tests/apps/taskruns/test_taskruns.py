"""Tests for task run progress tracking."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="tr_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="TR Project", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def admin_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def viewer_client(project: Project) -> APIClient:
    viewer = User.objects.create_user(username="tr_viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


@pytest.fixture
def task_run(project: Project, user: object) -> TaskRun:
    return TaskRun.objects.create(
        task_name="scheduling.recalculate",
        celery_task_id="fake-celery-id",
        project=project,
        initiated_by=user,
    )


# ---------------------------------------------------------------------------
# Model tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_run_default_status(project: Project, user: object) -> None:
    run = TaskRun.objects.create(
        task_name="test.task",
        celery_task_id="abc",
        project=project,
        initiated_by=user,
    )
    assert run.status == TaskRunStatus.PENDING
    assert run.progress_pct is None
    assert run.result_summary is None


@pytest.mark.django_db
def test_task_run_str(task_run: TaskRun) -> None:
    assert "scheduling.recalculate" in str(task_run)
    assert "pending" in str(task_run)


# ---------------------------------------------------------------------------
# TaskRunTracker lifecycle tests
# ---------------------------------------------------------------------------


def _make_celery_task(name: str = "test.task") -> MagicMock:
    """Return a mock Celery task instance with a request.id."""
    mock_task = MagicMock()
    mock_task.name = name
    mock_task.request.id = "celery-task-id-123"
    return mock_task


@pytest.mark.django_db
def test_tracker_success_lifecycle(project: Project) -> None:
    """Tracker creates TaskRun, marks SUCCESS on clean exit."""
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    mock_task = _make_celery_task()

    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event"),
        TaskRunTracker(
            mock_task,
            project_id=str(project.pk),
            task_name="test.success",
        ) as tracker,
    ):
        assert tracker.task_run_id is not None
        run = TaskRun.objects.get(pk=tracker.task_run_id)
        assert run.status == TaskRunStatus.RUNNING
        assert run.started_at is not None
        tracker.set_result({"items": 5})

    run.refresh_from_db()
    assert run.status == TaskRunStatus.SUCCESS
    assert run.result_summary == {"items": 5}
    assert run.completed_at is not None
    assert run.progress_pct == 100


@pytest.mark.django_db
def test_tracker_failure_lifecycle(project: Project) -> None:
    """Tracker marks FAILED and stores error_detail on exception."""
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    mock_task = _make_celery_task()
    task_run_id: str | None = None

    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event"),
        pytest.raises(ValueError, match="something went wrong"),
        TaskRunTracker(
            mock_task,
            project_id=str(project.pk),
            task_name="test.failure",
        ) as tracker,
    ):
        task_run_id = tracker.task_run_id
        raise ValueError("something went wrong")

    assert task_run_id is not None
    run = TaskRun.objects.get(pk=task_run_id)
    assert run.status == TaskRunStatus.FAILED
    assert "something went wrong" in run.error_detail
    assert run.completed_at is not None


@pytest.mark.django_db
def test_tracker_cancellation(project: Project) -> None:
    """Tracker marks CANCELLED when TaskCancelled is raised and suppresses it."""
    from trueppm_api.apps.taskruns.tracker import TaskCancelled, TaskRunTracker

    mock_task = _make_celery_task()
    task_run_id: str | None = None

    # TaskCancelled should be suppressed (not re-raised).
    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event"),
        TaskRunTracker(
            mock_task,
            project_id=str(project.pk),
            task_name="test.cancel",
        ) as tracker,
    ):
        task_run_id = tracker.task_run_id
        raise TaskCancelled()

    assert task_run_id is not None
    run = TaskRun.objects.get(pk=task_run_id)
    assert run.status == TaskRunStatus.CANCELLED
    assert run.completed_at is not None


@pytest.mark.django_db
def test_tracker_progress_update(project: Project) -> None:
    """tracker.update() writes progress_pct and progress_msg to the DB."""
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    mock_task = _make_celery_task()
    task_run_id: str | None = None

    # Disable debounce by making Redis unavailable.
    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event"),
        patch(
            "trueppm_api.apps.taskruns.tracker.TaskRunTracker._get_redis",
            return_value=None,
        ),
        TaskRunTracker(
            mock_task,
            project_id=str(project.pk),
            task_name="test.progress",
        ) as tracker,
    ):
        task_run_id = tracker.task_run_id
        tracker.update(42, "Processing items…")

    assert task_run_id is not None
    run = TaskRun.objects.get(pk=task_run_id)
    # After success exit pct is overwritten to 100; check intermediate update occurred.
    assert run.status == TaskRunStatus.SUCCESS


# transaction=True: tracker broadcasts are now deferred with transaction.on_commit
# (#1323). Without a wrapping atomic (the Celery production path), Django runs the
# callback immediately, so the patched broadcast is captured synchronously here —
# under the default rolled-back django_db transaction the callbacks would never fire.
@pytest.mark.django_db(transaction=True)
def test_tracker_broadcasts_started_and_completed(project: Project) -> None:
    """TaskRunTracker broadcasts task_run_started and task_run_completed events."""
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    mock_task = _make_celery_task()
    broadcast_calls: list[dict] = []

    def capture(**kwargs: object) -> None:
        broadcast_calls.append(dict(kwargs))

    with (
        patch(
            "trueppm_api.apps.taskruns.tracker.broadcast_board_event",
            side_effect=capture,
        ),
        TaskRunTracker(
            mock_task,
            project_id=str(project.pk),
            task_name="test.broadcast",
        ),
    ):
        pass

    event_types = [c["event_type"] for c in broadcast_calls]
    assert "task_run_started" in event_types
    assert "task_run_completed" in event_types


@pytest.mark.django_db(transaction=True)
def test_tracker_broadcasts_failed(project: Project) -> None:
    """TaskRunTracker broadcasts task_run_failed on exception."""
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    mock_task = _make_celery_task()
    broadcast_calls: list[dict] = []

    def capture(**kwargs: object) -> None:
        broadcast_calls.append(dict(kwargs))

    with (
        patch(
            "trueppm_api.apps.taskruns.tracker.broadcast_board_event",
            side_effect=capture,
        ),
        pytest.raises(RuntimeError),
        TaskRunTracker(
            mock_task,
            project_id=str(project.pk),
            task_name="test.fail_broadcast",
        ),
    ):
        raise RuntimeError("boom")

    event_types = [c["event_type"] for c in broadcast_calls]
    assert "task_run_started" in event_types
    assert "task_run_failed" in event_types


@pytest.mark.django_db
def test_tracker_debounce_skips_rapid_updates(project: Project) -> None:
    """tracker.update() is skipped when called more than once within 1 second."""
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    mock_task = _make_celery_task()

    # Simulate Redis returning a recent timestamp (< 1s ago).
    mock_redis = MagicMock()
    mock_redis.exists.return_value = 0  # no cancel signal
    mock_redis.get.return_value = b"9999999999.0"  # far future — always debounced

    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event"),
        patch(
            "trueppm_api.apps.taskruns.tracker.TaskRunTracker._get_redis",
            return_value=mock_redis,
        ),
        TaskRunTracker(
            mock_task,
            project_id=str(project.pk),
            task_name="test.debounce",
        ) as tracker,
    ):
        tracker.update(10, "first")
        tracker.update(20, "second")  # should be skipped by debounce

    # Only one debounce check was needed; confirm Redis.get was called.
    assert mock_redis.get.called


@pytest.mark.django_db
def test_tracker_cancel_signal_raises(project: Project) -> None:
    """tracker.update() raises TaskCancelled when the Redis cancel key is set."""
    from trueppm_api.apps.taskruns.tracker import TaskRunTracker

    mock_task = _make_celery_task()

    mock_redis = MagicMock()
    # exists() returns 1 (truthy) — cancel key is set.
    mock_redis.exists.return_value = 1
    mock_redis.get.return_value = None  # no debounce timestamp

    task_run_id: str | None = None

    # TaskCancelled must propagate to __exit__ — do NOT catch it here.
    with (
        patch("trueppm_api.apps.taskruns.tracker.broadcast_board_event"),
        patch(
            "trueppm_api.apps.taskruns.tracker.TaskRunTracker._get_redis",
            return_value=mock_redis,
        ),
        TaskRunTracker(
            mock_task,
            project_id=str(project.pk),
            task_name="test.cancel_signal",
        ) as tracker,
    ):
        task_run_id = tracker.task_run_id
        tracker.update(10, "should raise")  # raises TaskCancelled → __exit__

    assert task_run_id is not None
    # The TaskCancelled was raised inside the with block; __exit__ sees it.
    run = TaskRun.objects.get(pk=task_run_id)
    assert run.status == TaskRunStatus.CANCELLED


# ---------------------------------------------------------------------------
# REST API tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_task_runs_viewer(
    viewer_client: APIClient, project: Project, task_run: TaskRun
) -> None:
    resp = viewer_client.get(f"/api/v1/projects/{project.pk}/task-runs/")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 1
    assert resp.data["results"][0]["id"] == str(task_run.pk)


@pytest.mark.django_db
def test_retrieve_task_run(admin_client: APIClient, project: Project, task_run: TaskRun) -> None:
    resp = admin_client.get(f"/api/v1/projects/{project.pk}/task-runs/{task_run.pk}/")
    assert resp.status_code == 200
    assert resp.data["task_name"] == "scheduling.recalculate"


@pytest.mark.django_db
def test_cancel_requires_admin(
    viewer_client: APIClient, project: Project, task_run: TaskRun
) -> None:
    task_run.status = TaskRunStatus.RUNNING
    task_run.save()
    resp = viewer_client.post(f"/api/v1/projects/{project.pk}/task-runs/{task_run.pk}/cancel/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_cancel_running_task_run(
    admin_client: APIClient, project: Project, task_run: TaskRun
) -> None:
    task_run.status = TaskRunStatus.RUNNING
    task_run.save()

    with patch("trueppm_api.apps.taskruns.views.redis_lib") as mock_redis_mod:
        mock_redis_inst = MagicMock()
        mock_redis_mod.from_url.return_value = mock_redis_inst

        resp = admin_client.post(f"/api/v1/projects/{project.pk}/task-runs/{task_run.pk}/cancel/")
    assert resp.status_code == 202
    mock_redis_inst.set.assert_called_once()


@pytest.mark.django_db
def test_cancel_already_done_returns_409(
    admin_client: APIClient, project: Project, task_run: TaskRun
) -> None:
    task_run.status = TaskRunStatus.SUCCESS
    task_run.save()
    resp = admin_client.post(f"/api/v1/projects/{project.pk}/task-runs/{task_run.pk}/cancel/")
    assert resp.status_code == 409


@pytest.mark.django_db
def test_global_active_endpoint(admin_client: APIClient, project: Project, user: object) -> None:
    TaskRun.objects.create(
        task_name="scheduling.recalculate",
        celery_task_id="t1",
        project=project,
        initiated_by=user,
        status=TaskRunStatus.RUNNING,
    )
    TaskRun.objects.create(
        task_name="scheduling.recalculate",
        celery_task_id="t2",
        project=project,
        initiated_by=user,
        status=TaskRunStatus.SUCCESS,
    )
    resp = admin_client.get("/api/v1/task-runs/active/")
    assert resp.status_code == 200
    # Only the running one should appear.
    assert len(resp.data) == 1
    assert resp.data[0]["status"] == "running"


# ---------------------------------------------------------------------------
# Auto-purge task test
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_purge_task_run(project: Project, user: object) -> None:
    from django.utils import timezone

    from trueppm_api.apps.taskruns.tasks import purge_old_task_runs

    old_time = timezone.now() - timezone.timedelta(days=35)
    run = TaskRun.objects.create(
        task_name="old.task",
        celery_task_id="x",
        project=project,
        initiated_by=user,
        status=TaskRunStatus.SUCCESS,
    )
    TaskRun.objects.filter(pk=run.pk).update(completed_at=old_time)

    # Recent run should NOT be purged.
    recent = TaskRun.objects.create(
        task_name="recent.task",
        celery_task_id="y",
        project=project,
        initiated_by=user,
        status=TaskRunStatus.SUCCESS,
    )
    TaskRun.objects.filter(pk=recent.pk).update(
        completed_at=timezone.now() - timezone.timedelta(days=1)
    )

    result = purge_old_task_runs()
    assert result["deleted"] == 1
    assert not TaskRun.objects.filter(pk=run.pk).exists()
    assert TaskRun.objects.filter(pk=recent.pk).exists()
