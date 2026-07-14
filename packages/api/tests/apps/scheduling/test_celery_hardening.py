"""Tests for Celery task hardening (issue #62, ADR-0017).

Covers:
  - FailedTask model CRUD
  - Dead-letter recording on task failure
  - Task lifecycle signals emission
  - Admin failed-tasks API (list, detail; write actions in test_failed_task_actions.py)
  - Retry policy configuration on task decorators
  - Re-queue loop cap in recalculate_schedule
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

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
# Project attribution on FailedTask (#1917)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestFailedTaskProjectAttribution:
    def _project(self) -> Any:
        from trueppm_api.apps.projects.models import Project

        return Project.objects.create(name="P1", start_date="2026-01-01")

    def test_project_is_nullable(self) -> None:
        """Existing/unattributed rows (e.g. non-project-scoped purge tasks) have no project."""
        ft = FailedTask.objects.create(
            task_name="scheduling.purge_old_schedule_requests",
            task_id="no-project-1",
            args=[],
            kwargs={},
            exception_type="RuntimeError",
            exception_message="boom",
            traceback="Traceback ...",
        )
        assert ft.project_id is None

    def test_record_failed_task_persists_project_id(self) -> None:
        project = self._project()
        record_failed_task(
            task_name="scheduling.recalculate_schedule",
            task_id="proj-attr-1",
            args=[str(project.pk)],
            kwargs={},
            exception=RuntimeError("boom"),
            project_id=str(project.pk),
        )
        ft = FailedTask.objects.get(task_id="proj-attr-1")
        assert ft.project_id == project.pk

    def test_record_failed_task_without_project_id_leaves_it_null(self) -> None:
        record_failed_task(
            task_name="t",
            task_id="no-project-2",
            args=[],
            kwargs={},
            exception=RuntimeError("boom"),
        )
        ft = FailedTask.objects.get(task_id="no-project-2")
        assert ft.project_id is None

    def test_repeat_failure_without_project_id_does_not_clobber_known_project(self) -> None:
        """A first failure records project_id; a later re-failure that doesn't pass
        project_id (e.g. a caller that lost the arg) must not erase it — the row's
        attribution should only ever be set or refreshed, never blanked."""
        project = self._project()
        record_failed_task(
            "t", "dup-proj", [], {}, RuntimeError("first"), project_id=str(project.pk)
        )
        record_failed_task("t", "dup-proj", [], {}, RuntimeError("second"))
        ft = FailedTask.objects.get(task_id="dup-proj")
        assert ft.project_id == project.pk
        assert ft.failure_count == 2

    def test_project_deletion_sets_null_not_cascade(self) -> None:
        """Deleting the project must not delete its dead-letter audit trail."""
        project = self._project()
        record_failed_task(
            "t", "cascade-check", [], {}, RuntimeError("boom"), project_id=str(project.pk)
        )
        project.delete()
        ft = FailedTask.objects.get(task_id="cascade-check")
        assert ft.project_id is None


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
    def _project(self) -> Any:
        # A real Project row is required from #1917 onward: project_id now
        # persists into FailedTask.project, a real FK with an FK constraint —
        # a free-form placeholder string (the old "proj-9") would either fail
        # UUID validation or, if UUID-shaped, violate the FK on save.
        from trueppm_api.apps.projects.models import Project

        return Project.objects.create(name="P1", start_date="2026-01-01")

    def test_fires_once_on_new_dead_letter_with_project_id(
        self, captured_alerts: list[dict[str, object]]
    ) -> None:
        project = self._project()
        project_id = str(project.pk)
        exc = RuntimeError("boom")
        record_failed_task(
            task_name="scheduling.recalculate_schedule",
            task_id="sig-001",
            args=[project_id],
            kwargs={},
            exception=exc,
            project_id=project_id,
        )
        assert len(captured_alerts) == 1
        payload = captured_alerts[0]
        assert payload["task_name"] == "scheduling.recalculate_schedule"
        assert payload["task_id"] == "sig-001"
        assert payload["project_id"] == project_id
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
        project = self._project()
        project_id = str(project.pk)
        logger_name = "trueppm_api.apps.scheduling.receivers"
        with caplog.at_level(logging.WARNING, logger=logger_name):
            record_failed_task(
                task_name="scheduling.recalculate_schedule",
                task_id="sig-log",
                args=[],
                kwargs={},
                exception=RuntimeError("boom"),
                project_id=project_id,
            )
        records = [r for r in caplog.records if r.name == logger_name]
        assert any("dead-letter alert" in r.message for r in records)
        rec = next(r for r in records if "dead-letter alert" in r.message)
        assert rec.task_name == "scheduling.recalculate_schedule"  # type: ignore[attr-defined]
        assert rec.exception_type == "RuntimeError"  # type: ignore[attr-defined]
        assert rec.project_id == project_id  # type: ignore[attr-defined]


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
# Celery-framework → Django signal bridge + observability (#1917)
#
# These fire the *real* celery.signals.task_prerun/task_postrun/task_retry —
# the same signals a Celery worker sends around every task execution — rather
# than calling record_failed_task() directly, so they exercise (and pin) the
# SchedulingConfig.ready() bridge itself: the weak=False + dispatch_uid fix
# that made celery_task_started/succeeded/retried actually fire (previously
# the closures were garbage-collected immediately after ready() returned, so
# the bridge was silent dead code — see the docstring on SchedulingConfig.ready).
# ---------------------------------------------------------------------------


class _FakeCeleryTask:
    """Minimal stand-in for the Celery Task instance task_prerun/postrun pass."""

    def __init__(self, name: str) -> None:
        self.name = name


@pytest.fixture
def _signal_capture() -> Iterator[dict[str, list[dict[str, object]]]]:
    """Connect temporary receivers to all four bridged Django signals."""
    from trueppm_api.apps.scheduling.signals import (
        celery_task_retried,
        celery_task_started,
        celery_task_succeeded,
    )

    captured: dict[str, list[dict[str, object]]] = {
        "started": [],
        "succeeded": [],
        "retried": [],
    }

    def _capture(bucket: str) -> Any:
        def _receiver(sender: object, **kwargs: object) -> None:
            captured[bucket].append(kwargs)

        return _receiver

    started_recv = _capture("started")
    succeeded_recv = _capture("succeeded")
    retried_recv = _capture("retried")
    celery_task_started.connect(started_recv, weak=False)
    celery_task_succeeded.connect(succeeded_recv, weak=False)
    celery_task_retried.connect(retried_recv, weak=False)
    try:
        yield captured
    finally:
        celery_task_started.disconnect(started_recv)
        celery_task_succeeded.disconnect(succeeded_recv)
        celery_task_retried.disconnect(retried_recv)


@pytest.mark.django_db
class TestCelerySignalBridgeFiresRealSignals:
    """Proves the task_prerun/postrun/retry → Django signal bridge is live."""

    def test_prerun_and_postrun_fire_started_and_succeeded(
        self, _signal_capture: dict[str, list[dict[str, object]]]
    ) -> None:
        from celery.signals import task_postrun, task_prerun

        task = _FakeCeleryTask("demo.observability_task")
        task_prerun.send(sender=task, task_id="bridge-1", task=task)
        task_postrun.send(sender=task, task_id="bridge-1", task=task, retval=None, state="SUCCESS")

        assert len(_signal_capture["started"]) == 1
        assert _signal_capture["started"][0]["task_name"] == "demo.observability_task"
        assert _signal_capture["started"][0]["task_id"] == "bridge-1"

        assert len(_signal_capture["succeeded"]) == 1
        succeeded = _signal_capture["succeeded"][0]
        assert succeeded["task_name"] == "demo.observability_task"
        assert isinstance(succeeded["runtime_seconds"], float)
        assert succeeded["runtime_seconds"] >= 0.0

    def test_postrun_with_failure_state_does_not_emit_succeeded(
        self, _signal_capture: dict[str, list[dict[str, object]]]
    ) -> None:
        from celery.signals import task_postrun, task_prerun

        task = _FakeCeleryTask("demo.observability_task")
        task_prerun.send(sender=task, task_id="bridge-2", task=task)
        task_postrun.send(sender=task, task_id="bridge-2", task=task, retval=None, state="FAILURE")
        assert _signal_capture["succeeded"] == []

    def test_retry_signal_fires_retried(
        self, _signal_capture: dict[str, list[dict[str, object]]]
    ) -> None:
        from celery.signals import task_retry

        task = _FakeCeleryTask("demo.observability_task")

        class _Request:
            id = "bridge-3"
            retries = 1

        task_retry.send(sender=task, request=_Request(), reason=RuntimeError("transient"))
        assert len(_signal_capture["retried"]) == 1
        retried = _signal_capture["retried"][0]
        assert retried["task_id"] == "bridge-3"
        assert retried["attempt"] == 1

    def test_repeated_ready_does_not_duplicate_signal_delivery(
        self, _signal_capture: dict[str, list[dict[str, object]]]
    ) -> None:
        """A second AppConfig.ready() (test runner / autoreloader) must not double-fire."""
        from celery.signals import task_prerun
        from django.apps import apps as django_apps

        django_apps.get_app_config("scheduling").ready()
        django_apps.get_app_config("scheduling").ready()

        task = _FakeCeleryTask("demo.observability_task")
        task_prerun.send(sender=task, task_id="bridge-4", task=task)
        assert len(_signal_capture["started"]) == 1


class _InMemoryTaskDurationReader:
    """Sets up a real MeterProvider + InMemoryMetricReader for #1917's histogram.

    A context manager rather than a fixture so tests can control exactly when
    the (real, process-global) task_prerun/task_postrun signals fire relative
    to metrics being installed — install_metrics() is idempotent per-guard, so
    each test resets it first to register fresh against its own reader,
    mirroring TestNoOpWhenDisabled/TestOutboxGauges in test_otel_metrics.py.
    """

    def __enter__(self) -> Any:
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import InMemoryMetricReader

        from trueppm_api.apps.observability import otel
        from trueppm_api.apps.observability.otel import metrics
        from trueppm_api.apps.observability.otel.provider import OTelBootstrapContext

        metrics.reset_for_testing()
        self.reader = InMemoryMetricReader()
        provider = MeterProvider(metric_readers=[self.reader])
        ctx = OTelBootstrapContext(
            schema_version=1,
            enabled=True,
            edition="community",
            resource=None,
            tracer_provider=None,
            meter_provider=provider,
        )
        otel.install_metrics(ctx, meter_provider=provider)
        return self.reader

    def __exit__(self, *exc: object) -> None:
        from trueppm_api.apps.observability.otel import metrics

        metrics.reset_for_testing()


def _duration_points(reader: Any) -> list[Any]:
    from trueppm_api.apps.observability.otel import metrics

    data = reader.get_metrics_data()
    points: list[Any] = []
    if data is None:
        return points
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                if metric.name == metrics.TASK_DURATION_SECONDS:
                    points.extend(metric.data.data_points)
    return points


@pytest.mark.django_db
class TestTaskDurationMetric:
    """The trueppm.task.duration_seconds histogram (#1917), end to end.

    These fire the real task_prerun/task_postrun Celery signals (exercising the
    SchedulingConfig bridge, same as TestCelerySignalBridgeFiresRealSignals) with
    metrics installed against an in-memory reader, so they prove the histogram
    is actually populated by a real task execution — not just that the recording
    function works in isolation.
    """

    def test_success_is_recorded_with_task_name_and_outcome(self) -> None:
        from celery.signals import task_postrun, task_prerun

        with _InMemoryTaskDurationReader() as reader:
            task = _FakeCeleryTask("demo.duration_task")
            task_prerun.send(sender=task, task_id="dur-1", task=task)
            task_postrun.send(sender=task, task_id="dur-1", task=task, retval=None, state="SUCCESS")
            points = _duration_points(reader)

        assert len(points) == 1
        assert points[0].sum >= 0.0
        attrs = dict(points[0].attributes)
        assert attrs["trueppm.celery.task_name"] == "demo.duration_task"
        assert attrs["trueppm.celery.outcome"] == "success"

    def test_failure_and_retry_outcomes_are_recorded_too(self) -> None:
        """Duration is a per-attempt signal — recorded for every outcome, not just success."""
        from celery.signals import task_postrun, task_prerun

        with _InMemoryTaskDurationReader() as reader:
            task = _FakeCeleryTask("demo.duration_task")
            for task_id, state in (("dur-fail", "FAILURE"), ("dur-retry", "RETRY")):
                task_prerun.send(sender=task, task_id=task_id, task=task)
                task_postrun.send(sender=task, task_id=task_id, task=task, retval=None, state=state)
            points = _duration_points(reader)

        outcomes = sorted(dict(p.attributes)["trueppm.celery.outcome"] for p in points)
        assert outcomes == ["failure", "retry"]

    def test_record_task_duration_unit(self) -> None:
        """The recording function in isolation, mirroring test_otel_metrics.py's style."""
        from trueppm_api.apps.observability.otel import metrics

        with _InMemoryTaskDurationReader() as reader:
            metrics.record_task_duration(
                task_name="demo.duration_task", duration_seconds=1.5, outcome="success"
            )
            points = _duration_points(reader)

        assert len(points) == 1
        assert points[0].sum == 1.5

    def test_record_task_duration_is_noop_when_metrics_disabled(self) -> None:
        """No histogram registered (metrics off/disabled) → never raises."""
        from trueppm_api.apps.observability.otel import metrics

        metrics.reset_for_testing()
        assert metrics._task_duration_histogram is None
        metrics.record_task_duration(task_name="x", duration_seconds=0.1, outcome="success")


@pytest.mark.django_db
class TestStructuredLifecycleLogging:
    """Structured start/success/retry log lines (#1917), extra={} fields."""

    def test_started_log_has_structured_extra(self, caplog: pytest.LogCaptureFixture) -> None:
        from trueppm_api.apps.scheduling.signals import celery_task_started

        logger_name = "trueppm_api.apps.scheduling.receivers"
        with caplog.at_level(logging.INFO, logger=logger_name):
            celery_task_started.send(
                sender="X", task_id="log-1", task_name="demo.log_task", args=(), kwargs={}
            )
        records = [r for r in caplog.records if r.name == logger_name]
        assert any("task started" in r.message for r in records)
        rec = next(r for r in records if "task started" in r.message)
        assert rec.task_name == "demo.log_task"  # type: ignore[attr-defined]
        assert rec.task_id == "log-1"  # type: ignore[attr-defined]
        assert rec.outcome == "started"  # type: ignore[attr-defined]

    def test_succeeded_log_has_structured_extra(self, caplog: pytest.LogCaptureFixture) -> None:
        from trueppm_api.apps.scheduling.signals import celery_task_succeeded

        logger_name = "trueppm_api.apps.scheduling.receivers"
        with caplog.at_level(logging.INFO, logger=logger_name):
            celery_task_succeeded.send(
                sender="X", task_id="log-2", task_name="demo.log_task", runtime_seconds=0.42
            )
        records = [r for r in caplog.records if r.name == logger_name]
        rec = next(r for r in records if "task succeeded" in r.message)
        assert rec.task_name == "demo.log_task"  # type: ignore[attr-defined]
        assert rec.outcome == "succeeded"  # type: ignore[attr-defined]
        assert rec.runtime_seconds == 0.42  # type: ignore[attr-defined]

    def test_retried_log_has_structured_extra(self, caplog: pytest.LogCaptureFixture) -> None:
        from trueppm_api.apps.scheduling.signals import celery_task_retried

        logger_name = "trueppm_api.apps.scheduling.receivers"
        with caplog.at_level(logging.WARNING, logger=logger_name):
            celery_task_retried.send(
                sender="X",
                task_id="log-3",
                task_name="demo.log_task",
                attempt=2,
                exception=RuntimeError("transient"),
            )
        records = [r for r in caplog.records if r.name == logger_name]
        rec = next(r for r in records if "task retry" in r.message)
        assert rec.task_name == "demo.log_task"  # type: ignore[attr-defined]
        assert rec.outcome == "retried"  # type: ignore[attr-defined]
        assert rec.attempt == 2  # type: ignore[attr-defined]
        assert rec.exception_type == "RuntimeError"  # type: ignore[attr-defined]


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

    # The write actions (formerly retry/dismiss, now requeue/drop with backoff,
    # audit note, and bulk variants) moved to test_failed_task_actions.py when
    # #695/ADR-0210 rerouted requeue through the durable workflow backend. This
    # class keeps only the list/detail read coverage.
