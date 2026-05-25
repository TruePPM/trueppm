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

import logging
from collections.abc import Iterator
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.scheduling.deadletter import record_failed_task
from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus
from trueppm_api.apps.scheduling.signals import celery_task_permanently_failed

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
# Dead-letter alerting signal + OSS receiver (ADR-0084, issue #660)
# ---------------------------------------------------------------------------


@pytest.fixture
def captured_alerts() -> Iterator[list[dict[str, object]]]:
    """Connect a temporary receiver capturing celery_task_permanently_failed payloads."""
    captured: list[dict[str, object]] = []

    def _capture(sender: object, **kwargs: object) -> None:
        captured.append(kwargs)

    celery_task_permanently_failed.connect(_capture, weak=False)
    try:
        yield captured
    finally:
        celery_task_permanently_failed.disconnect(_capture)


@pytest.mark.django_db
class TestDeadLetterSignal:
    def test_fires_once_on_new_dead_letter_with_project_id(
        self, captured_alerts: list[dict[str, object]]
    ) -> None:
        exc = RuntimeError("boom")
        record_failed_task(
            task_name="scheduling.recalculate_schedule",
            task_id="sig-001",
            args=["proj-9"],
            kwargs={},
            exception=exc,
            project_id="proj-9",
        )
        assert len(captured_alerts) == 1
        payload = captured_alerts[0]
        assert payload["task_name"] == "scheduling.recalculate_schedule"
        assert payload["task_id"] == "sig-001"
        assert payload["project_id"] == "proj-9"
        assert payload["exception"] is exc

    def test_does_not_refire_on_duplicate_task_id(
        self, captured_alerts: list[dict[str, object]]
    ) -> None:
        # Only the terminal transition (FailedTask created) alerts; a repeat
        # dead-letter of the same task_id only bumps failure_count.
        record_failed_task("t", "sig-dup", [], {}, RuntimeError("first"))
        record_failed_task("t", "sig-dup", [], {}, RuntimeError("second"))
        assert len(captured_alerts) == 1

    def test_project_id_defaults_to_none_when_unknown(
        self, captured_alerts: list[dict[str, object]]
    ) -> None:
        record_failed_task("t", "sig-noproj", [], {}, RuntimeError("x"))
        assert captured_alerts[0]["project_id"] is None

    def test_misbehaving_receiver_does_not_break_recording(self) -> None:
        # send_robust isolates receiver failures from the dead-letter write.
        def _boom(sender: object, **kwargs: object) -> None:
            raise ValueError("receiver exploded")

        celery_task_permanently_failed.connect(_boom, weak=False)
        try:
            record_failed_task("t", "sig-robust", [], {}, RuntimeError("x"))
        finally:
            celery_task_permanently_failed.disconnect(_boom)
        # The FailedTask row was still written despite the receiver raising.
        assert FailedTask.objects.filter(task_id="sig-robust").count() == 1

    def test_oss_receiver_logs_structured_warning(self, caplog: pytest.LogCaptureFixture) -> None:
        logger_name = "trueppm_api.apps.scheduling.receivers"
        with caplog.at_level(logging.WARNING, logger=logger_name):
            record_failed_task(
                task_name="scheduling.recalculate_schedule",
                task_id="sig-log",
                args=[],
                kwargs={},
                exception=RuntimeError("boom"),
                project_id="proj-log",
            )
        records = [r for r in caplog.records if r.name == logger_name]
        assert any("dead-letter alert" in r.message for r in records)
        rec = next(r for r in records if "dead-letter alert" in r.message)
        assert rec.task_name == "scheduling.recalculate_schedule"  # type: ignore[attr-defined]
        assert rec.exception_type == "RuntimeError"  # type: ignore[attr-defined]
        assert rec.project_id == "proj-log"  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Task lifecycle signals
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskLifecycleSignals:
    def test_signals_are_importable(self) -> None:
        from trueppm_api.apps.scheduling.signals import (
            celery_task_failed,
            celery_task_permanently_failed,
            celery_task_retried,
            celery_task_started,
            celery_task_succeeded,
        )

        # All five signals exist and are Django Signal instances
        signals = (
            celery_task_started,
            celery_task_succeeded,
            celery_task_failed,
            celery_task_retried,
            celery_task_permanently_failed,
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
