"""Tests for OTel Phase 2 native metric emission (ADR-0223, #710).

The observable gauges are exercised against a real SDK ``MeterProvider`` wired to
an ``InMemoryMetricReader`` — ``reader.get_metrics_data()`` triggers collection,
which invokes the gauge callbacks synchronously on the test thread, so the seeded
outbox / DB state is visible inside the pytest-django transaction. The strict-no-op
invariant (disabled or metrics-off → nothing registered) is asserted directly.

Backend-only observability: there is no API endpoint and no UI, so only the pytest
layer applies (the four families are also exercised end-to-end by CI's collector
integration).
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import timedelta
from typing import Any

import pytest
from django.utils import timezone
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from trueppm_api.apps.observability import otel
from trueppm_api.apps.observability.otel import metrics
from trueppm_api.apps.observability.otel.provider import OTelBootstrapContext


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    """Reset the metrics registration guard around each test."""
    metrics.reset_for_testing()
    yield
    metrics.reset_for_testing()


def _reader_and_provider() -> tuple[InMemoryMetricReader, MeterProvider]:
    reader = InMemoryMetricReader()
    return reader, MeterProvider(metric_readers=[reader])


def _ctx(*, enabled: bool, meter_provider: Any) -> OTelBootstrapContext:
    return OTelBootstrapContext(
        schema_version=1,
        enabled=enabled,
        edition="community",
        resource=None,
        tracer_provider=None,
        meter_provider=meter_provider,
    )


def _collect(reader: InMemoryMetricReader) -> dict[str, list[tuple[dict[str, Any], float]]]:
    """Flatten collected metrics into {name: [(attributes, value), ...]}."""
    data = reader.get_metrics_data()
    out: dict[str, list[tuple[dict[str, Any], float]]] = {}
    if data is None:
        return out
    for resource_metric in data.resource_metrics:
        for scope_metric in resource_metric.scope_metrics:
            for metric in scope_metric.metrics:
                points = out.setdefault(metric.name, [])
                for point in metric.data.data_points:
                    points.append((dict(point.attributes), point.value))
    return out


class TestNoOpWhenDisabled:
    def test_disabled_context_registers_nothing(self) -> None:
        reader, provider = _reader_and_provider()
        otel.install_metrics(_ctx(enabled=False, meter_provider=provider), meter_provider=provider)
        assert metrics._installed is False
        assert _collect(reader) == {}

    def test_metrics_off_registers_nothing(self) -> None:
        """enabled but meter_provider None (TRUEPPM_OTEL_METRICS_ENABLED=false) → no-op."""
        reader, provider = _reader_and_provider()
        # context.meter_provider is None even though a provider is passed for the meter.
        otel.install_metrics(_ctx(enabled=True, meter_provider=None), meter_provider=provider)
        assert metrics._installed is False
        assert _collect(reader) == {}

    def test_idempotent_second_call(self) -> None:
        reader, provider = _reader_and_provider()
        ctx = _ctx(enabled=True, meter_provider=provider)
        otel.install_metrics(ctx, meter_provider=provider)
        otel.install_metrics(ctx, meter_provider=provider)  # no double-registration
        assert metrics._installed is True
        names = _collect(reader).keys()
        # Each instrument appears once, not twice.
        assert list(names).count(metrics.OUTBOX_DEPTH) <= 1


@pytest.mark.django_db
class TestOutboxGauges:
    def _seed(self) -> None:
        from trueppm_api.apps.projects.models import Project
        from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestStatus
        from trueppm_api.apps.workflow_engine.models import (
            WorkflowInstance,
            WorkflowOutboxRow,
            WorkflowOutboxStatus,
            WorkflowStatus,
        )

        # schedule outbox → 2 pending, 1 dispatched, 1 done (done is terminal → excluded).
        # A partial unique constraint allows only one pending (and one dispatched) row
        # per project, so the two pending rows live on two different projects.
        p1 = Project.objects.create(name="P1", start_date="2026-01-01")
        p2 = Project.objects.create(name="P2", start_date="2026-01-01")
        old = ScheduleRequest.objects.create(project=p1, status=ScheduleRequestStatus.PENDING)
        ScheduleRequest.objects.create(project=p2, status=ScheduleRequestStatus.PENDING)
        ScheduleRequest.objects.create(project=p1, status=ScheduleRequestStatus.DISPATCHED)
        ScheduleRequest.objects.create(project=p1, status=ScheduleRequestStatus.DONE)
        # Age the oldest pending row 5 minutes back (bypass auto_now_add via update).
        ScheduleRequest.objects.filter(pk=old.pk).update(
            requested_at=timezone.now() - timedelta(minutes=5)
        )

        instance = WorkflowInstance.objects.create(
            name="w", input={}, idempotency_key="k", status=WorkflowStatus.RUNNING
        )
        WorkflowOutboxRow.objects.create(
            workflow=instance, step_name="s", step_input={}, status=WorkflowOutboxStatus.PENDING
        )

    def test_depth_counts_non_terminal_rows_by_state(self) -> None:
        self._seed()
        reader, provider = _reader_and_provider()
        otel.install_metrics(_ctx(enabled=True, meter_provider=provider), meter_provider=provider)
        points = {
            (attrs["trueppm.outbox.name"], attrs["trueppm.outbox.state"]): value
            for attrs, value in _collect(reader)[metrics.OUTBOX_DEPTH]
        }
        assert points[("schedule", "pending")] == 2
        assert points[("schedule", "dispatched")] == 1
        assert points[("workflow", "pending")] == 1
        assert points[("workflow", "dispatched")] == 0

    def test_oldest_age_reflects_oldest_non_terminal_row(self) -> None:
        self._seed()
        reader, provider = _reader_and_provider()
        otel.install_metrics(_ctx(enabled=True, meter_provider=provider), meter_provider=provider)
        ages = {
            attrs["trueppm.outbox.name"]: value
            for attrs, value in _collect(reader)[metrics.OUTBOX_OLDEST_AGE]
        }
        # schedule's oldest pending row was aged 5 minutes back.
        assert ages["schedule"] >= 290  # ~300s, allow collection jitter
        # workflow's only row is fresh → small but non-negative.
        assert ages["workflow"] >= 0

    def test_oldest_age_is_zero_for_empty_outbox(self) -> None:
        """No rows at all → age 0, not a gap and not negative."""
        reader, provider = _reader_and_provider()
        otel.install_metrics(_ctx(enabled=True, meter_provider=provider), meter_provider=provider)
        ages = {
            attrs["trueppm.outbox.name"]: value
            for attrs, value in _collect(reader)[metrics.OUTBOX_OLDEST_AGE]
        }
        assert ages == {"schedule": 0.0, "workflow": 0.0}


@pytest.mark.django_db
class TestDbConnectionsGauge:
    def test_reports_backends_by_bucketed_state(self) -> None:
        reader, provider = _reader_and_provider()
        otel.install_metrics(_ctx(enabled=True, meter_provider=provider), meter_provider=provider)
        points = _collect(reader)[metrics.DB_CONNECTIONS]
        allowed = {"active", "idle", "idle_in_transaction", "other"}
        assert points  # at least this test's own backend is counted
        assert all(attrs["trueppm.db.state"] in allowed for attrs, _ in points)
        # The connection running the probe is itself a backend → total ≥ 1.
        assert sum(value for _, value in points) >= 1

    def test_bucket_mapping(self) -> None:
        assert metrics._bucket_pg_state("active") == "active"
        assert metrics._bucket_pg_state("idle") == "idle"
        assert metrics._bucket_pg_state("idle in transaction") == "idle_in_transaction"
        assert metrics._bucket_pg_state("idle in transaction (aborted)") == "idle_in_transaction"
        assert metrics._bucket_pg_state(None) == "other"
        assert metrics._bucket_pg_state("fastpath function call") == "other"


class TestCallbacksSwallowDatabaseError:
    """A DB hiccup on the exporter thread yields no observation, never an exception."""

    def test_outbox_depth_callback_swallows_db_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from django.db import DatabaseError

        def _boom() -> list[Any]:
            raise DatabaseError("connection lost")

        monkeypatch.setattr(metrics, "_outbox_depth_rows", _boom)
        assert list(metrics._observe_outbox_depth(None)) == []  # type: ignore[arg-type]

    def test_db_connections_callback_swallows_db_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from django.db import DatabaseError

        def _boom() -> list[Any]:
            raise DatabaseError("statement timeout")

        monkeypatch.setattr(metrics, "_db_connection_rows", _boom)
        assert list(metrics._observe_db_connections(None)) == []  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Broker queue-depth gauge (#1900) — LLEN of the Celery broker (Valkey/Redis).
# ---------------------------------------------------------------------------


class _FakeRedis:
    """Records LLEN calls and returns seeded depths instead of touching Valkey."""

    def __init__(self, depths: dict[str, int]) -> None:
        self.depths = depths
        self.llen_calls: list[str] = []
        self.closed = False
        self.from_url_kwargs: dict[str, Any] = {}

    def llen(self, name: str) -> int:
        self.llen_calls.append(name)
        return self.depths.get(name, 0)

    def close(self) -> None:
        self.closed = True


class TestBrokerQueueDepthGauge:
    def test_rows_read_llen_per_queue_and_close_client(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """_broker_queue_depth_rows LLENs each queue and always closes the client."""
        fake = _FakeRedis({"celery": 7})

        def _from_url(url: str, **kwargs: Any) -> _FakeRedis:
            fake.from_url_kwargs = kwargs
            return fake

        monkeypatch.setattr("redis.from_url", _from_url)
        rows = metrics._broker_queue_depth_rows()
        assert rows == [("celery", 7)]
        assert fake.llen_calls == ["celery"]
        assert fake.closed is True
        # The probe is bounded by a socket timeout so an unreachable broker can't stall.
        assert fake.from_url_kwargs["socket_timeout"] == metrics._BROKER_PROBE_TIMEOUT_S
        assert fake.from_url_kwargs["socket_connect_timeout"] == metrics._BROKER_PROBE_TIMEOUT_S

    def test_callback_returns_measurement(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(metrics, "_broker_queue_depth_rows", lambda: [("celery", 4)])
        obs = list(metrics._observe_broker_queue_depth(None))  # type: ignore[arg-type]
        assert len(obs) == 1
        assert obs[0].value == 4
        assert obs[0].attributes == {"messaging.destination.name": "celery"}

    def test_callback_swallows_broker_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A broker connection error yields no observation, never propagates."""
        import redis

        def _boom() -> list[Any]:
            raise redis.ConnectionError("broker unreachable")

        monkeypatch.setattr(metrics, "_broker_queue_depth_rows", _boom)
        assert list(metrics._observe_broker_queue_depth(None)) == []  # type: ignore[arg-type]

    def test_collected_through_reader(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = _FakeRedis({"celery": 12})
        monkeypatch.setattr("redis.from_url", lambda url, **kw: fake)
        reader, provider = _reader_and_provider()
        otel.install_metrics(_ctx(enabled=True, meter_provider=provider), meter_provider=provider)
        points = _collect(reader)[metrics.BROKER_QUEUE_DEPTH]
        assert points == [({"messaging.destination.name": "celery"}, 12)]


# ---------------------------------------------------------------------------
# Synchronous WS instruments (#1900) — connection gauge + broadcast counter.
# ---------------------------------------------------------------------------


class TestWsInstruments:
    def test_connection_gauge_increments_and_decrements(self) -> None:
        reader, provider = _reader_and_provider()
        otel.install_metrics(_ctx(enabled=True, meter_provider=provider), meter_provider=provider)
        metrics.record_ws_connection_opened()
        metrics.record_ws_connection_opened()
        metrics.record_ws_connection_closed()
        points = _collect(reader)[metrics.WS_CONNECTIONS_ACTIVE]
        assert [value for _attrs, value in points] == [1]  # +1 +1 -1

    def test_broadcast_counter_increments_once_per_call(self) -> None:
        reader, provider = _reader_and_provider()
        otel.install_metrics(_ctx(enabled=True, meter_provider=provider), meter_provider=provider)
        metrics.record_ws_broadcast()
        metrics.record_ws_broadcast()
        metrics.record_ws_broadcast()
        points = _collect(reader)[metrics.WS_BROADCAST_COUNT]
        assert [value for _attrs, value in points] == [3]

    def test_record_functions_are_noop_when_not_installed(self) -> None:
        """Before install_metrics (or when telemetry is off) the handles are None,
        so recording is a safe no-op rather than an AttributeError."""
        assert metrics._ws_connections is None
        assert metrics._ws_broadcasts is None
        # Must not raise.
        metrics.record_ws_connection_opened()
        metrics.record_ws_connection_closed()
        metrics.record_ws_broadcast()
