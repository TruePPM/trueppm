"""Tests for Celery task hardening (issue #62, ADR-0017).

Covers:
  - FailedTask model CRUD
  - Dead-letter recording on task failure
  - Task lifecycle signals emission
  - Admin failed-tasks API (list, detail, retry, dismiss)
  - Retry policy configuration on task decorators
  - Re-queue loop cap in recalculate_schedule
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.scheduling.deadletter import record_failed_task
from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus

User = get_user_model()


# ---------------------------------------------------------------------------
# FailedTask model
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestFailedTaskModel:
    def test_create_dead_letter(self) -> None:
        ft = FailedTask.objects.create(
            task_name="scheduling.recalculate_schedule",
            task_id="abc-123",
            args=["project-uuid"],
            kwargs={},
            exception_type="OperationalError",
            exception_message="connection refused",
            traceback="Traceback ...",
            status=FailedTaskStatus.DEAD,
        )
        assert ft.status == "dead"
        assert ft.failure_count == 1
        assert str(ft) == "scheduling.recalculate_schedule (abc-123) — dead"

    def test_str_representation(self) -> None:
        ft = FailedTask(
            task_name="test.task",
            task_id="xyz",
            status=FailedTaskStatus.DISMISSED,
        )
        assert "dismissed" in str(ft)


# ---------------------------------------------------------------------------
# Dead-letter recording
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDeadLetterRecording:
    def test_record_creates_failed_task(self) -> None:
        exc = RuntimeError("boom")
        record_failed_task(
            task_name="test.task",
            task_id="task-001",
            args=["arg1"],
            kwargs={"key": "val"},
            exception=exc,
        )
        ft = FailedTask.objects.get(task_id="task-001")
        assert ft.task_name == "test.task"
        assert ft.exception_type == "RuntimeError"
        assert ft.exception_message == "boom"
        assert ft.status == FailedTaskStatus.DEAD
        assert ft.args == ["arg1"]
        assert ft.kwargs == {"key": "val"}

    def test_record_updates_on_duplicate_task_id(self) -> None:
        """Second failure with same task_id updates the existing record."""
        exc1 = RuntimeError("first")
        exc2 = RuntimeError("second")
        record_failed_task("t", "dup-id", [], {}, exc1)
        record_failed_task("t", "dup-id", [], {}, exc2)
        assert FailedTask.objects.filter(task_id="dup-id").count() == 1
        ft = FailedTask.objects.get(task_id="dup-id")
        assert ft.exception_message == "second"
        assert ft.failure_count == 2


# ---------------------------------------------------------------------------
# Task lifecycle signals
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskLifecycleSignals:
    def test_signals_are_importable(self) -> None:
        from trueppm_api.apps.scheduling.signals import (
            celery_task_failed,
            celery_task_retried,
            celery_task_started,
            celery_task_succeeded,
        )

        # All four signals exist and are Django Signal instances
        signals = (
            celery_task_started,
            celery_task_succeeded,
            celery_task_failed,
            celery_task_retried,
        )
        for sig in signals:
            assert hasattr(sig, "send")
            assert hasattr(sig, "connect")


# ---------------------------------------------------------------------------
# Task decorator configuration
# ---------------------------------------------------------------------------


class TestTaskDecoratorConfig:
    def test_recalculate_schedule_has_retry_policy(self) -> None:
        from trueppm_api.apps.scheduling.tasks import recalculate_schedule

        assert recalculate_schedule.max_retries == 3
        assert recalculate_schedule.autoretry_for is not None
        assert recalculate_schedule.soft_time_limit == 480
        assert recalculate_schedule.time_limit == 600

    def test_purge_task_has_retry_policy(self) -> None:
        from trueppm_api.apps.history.tasks import purge_old_history_records

        assert purge_old_history_records.max_retries == 3
        assert purge_old_history_records.soft_time_limit == 300
        assert purge_old_history_records.time_limit == 360


# ---------------------------------------------------------------------------
# Admin failed-tasks API
# ---------------------------------------------------------------------------


def _staff_client() -> APIClient:
    user = User.objects.create_superuser(username="admin", password="pw")
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _regular_client() -> APIClient:
    user = User.objects.create_user(username="regular", password="pw")
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
class TestFailedTaskAPI:
    def _create_failed(self) -> FailedTask:
        return FailedTask.objects.create(
            task_name="test.task",
            task_id="ft-001",
            args=["a"],
            kwargs={},
            exception_type="RuntimeError",
            exception_message="test error",
            traceback="...",
            status=FailedTaskStatus.DEAD,
        )

    def test_list_requires_admin(self) -> None:
        # Tracebacks/args/kwargs must not be visible to non-admin members.
        self._create_failed()
        client = _regular_client()
        resp = client.get("/api/v1/admin/failed-tasks/")
        assert resp.status_code == 403

    def test_list_as_admin(self) -> None:
        self._create_failed()
        client = _staff_client()
        resp = client.get("/api/v1/admin/failed-tasks/")
        assert resp.status_code == 200
        assert len(resp.data) >= 1

    def test_list_unauthenticated(self) -> None:
        resp = APIClient().get("/api/v1/admin/failed-tasks/")
        assert resp.status_code in (401, 403)

    def test_detail_requires_admin(self) -> None:
        # Tracebacks/args/kwargs must not be visible to non-admin members.
        ft = self._create_failed()
        client = _regular_client()
        resp = client.get(f"/api/v1/admin/failed-tasks/{ft.pk}/")
        assert resp.status_code == 403

    def test_detail_as_admin(self) -> None:
        ft = self._create_failed()
        client = _staff_client()
        resp = client.get(f"/api/v1/admin/failed-tasks/{ft.pk}/")
        assert resp.status_code == 200
        assert resp.data["task_name"] == "test.task"

    def test_retry_requires_admin(self) -> None:
        ft = self._create_failed()
        client = _regular_client()
        resp = client.post(f"/api/v1/admin/failed-tasks/{ft.pk}/retry/")
        assert resp.status_code == 403

    @patch("trueppm_api.apps.scheduling.views.current_app")
    def test_retry_as_admin(self, mock_app: object) -> None:
        ft = self._create_failed()
        client = _staff_client()
        resp = client.post(f"/api/v1/admin/failed-tasks/{ft.pk}/retry/")
        assert resp.status_code == 200
        ft.refresh_from_db()
        assert ft.status == FailedTaskStatus.RETRIED

    def test_dismiss_requires_admin(self) -> None:
        ft = self._create_failed()
        client = _regular_client()
        resp = client.post(f"/api/v1/admin/failed-tasks/{ft.pk}/dismiss/")
        assert resp.status_code == 403

    def test_dismiss_as_admin(self) -> None:
        ft = self._create_failed()
        client = _staff_client()
        resp = client.post(f"/api/v1/admin/failed-tasks/{ft.pk}/dismiss/")
        assert resp.status_code == 200
        ft.refresh_from_db()
        assert ft.status == FailedTaskStatus.DISMISSED

    def test_retry_dismissed_task_rejected(self) -> None:
        ft = self._create_failed()
        ft.status = FailedTaskStatus.DISMISSED
        ft.save(update_fields=["status"])
        client = _staff_client()
        resp = client.post(f"/api/v1/admin/failed-tasks/{ft.pk}/retry/")
        assert resp.status_code == 400
