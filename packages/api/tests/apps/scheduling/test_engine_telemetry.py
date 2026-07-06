"""Tests for the scheduling-engine manual OTel spans (ADR-0223 Phase 1, #709).

The CPM and Monte Carlo spans are the primary Phase-1 deliverable, so they are
asserted end-to-end: the span helper's tracer is pointed at an in-memory exporter
(hermetically, via monkeypatch — no global provider mutation, no DB), the helper
is driven, and the finished span's name and ``trueppm.*`` attributes are checked.

This also pins the boundary rule that the standalone ``trueppm_scheduler`` package
must stay OpenTelemetry-free: all spans are produced from the API layer here.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from trueppm_api.apps.observability.otel import attributes
from trueppm_api.apps.scheduling import telemetry


@pytest.fixture
def exporter(monkeypatch: pytest.MonkeyPatch) -> Iterator[InMemorySpanExporter]:
    """Point the scheduling tracer at an in-memory exporter, hermetically.

    ``telemetry`` calls ``otel.get_tracer(...)`` which resolves the global
    provider; patching that accessor to hand back a tracer from a local recording
    provider keeps the test off the process-global OTel provider entirely.
    """
    exp = InMemorySpanExporter()
    tp = TracerProvider()
    tp.add_span_processor(SimpleSpanProcessor(exp))
    tracer = tp.get_tracer("test")
    monkeypatch.setattr(telemetry.otel, "get_tracer", lambda _name: tracer)
    yield exp
    exp.clear()


def test_scheduler_package_is_otel_free() -> None:
    """The Apache-2.0 standalone engine must not import opentelemetry (rule #3)."""
    import inspect

    import trueppm_scheduler.engine as engine

    source = inspect.getsource(engine)
    assert "opentelemetry" not in source


class TestCpmSpan:
    def test_records_name_and_attributes(self, exporter: InMemorySpanExporter) -> None:
        with telemetry.cpm_span("proj-123", dependency_count=5) as span:
            span.set_attribute(attributes.SCHEDULE_TASK_COUNT, 10)
            span.set_attribute(attributes.SCHEDULE_CRITICAL_COUNT, 3)

        spans = exporter.get_finished_spans()
        assert len(spans) == 1
        span_data = spans[0]
        assert span_data.name == "schedule.cpm"
        attrs = dict(span_data.attributes or {})
        assert attrs[attributes.PROJECT_ID] == "proj-123"
        assert attrs[attributes.SCHEDULE_RECOMPUTE_REASON] == "full_recompute"
        assert attrs[attributes.SCHEDULE_DEPENDENCY_COUNT] == 5
        assert attrs[attributes.SCHEDULE_TASK_COUNT] == 10
        assert attrs[attributes.SCHEDULE_CRITICAL_COUNT] == 3

    def test_omits_dependency_count_when_none(self, exporter: InMemorySpanExporter) -> None:
        with telemetry.cpm_span("p"):
            pass
        attrs = dict(exporter.get_finished_spans()[0].attributes or {})
        assert attributes.SCHEDULE_DEPENDENCY_COUNT not in attrs

    def test_span_captures_engine_exception(self, exporter: InMemorySpanExporter) -> None:
        """A failing CPM call records the error on the span but re-raises."""
        with pytest.raises(ValueError), telemetry.cpm_span("p"):
            raise ValueError("cycle")
        span_data = exporter.get_finished_spans()[0]
        assert span_data.status.status_code.name == "ERROR"


class TestMonteCarloSpan:
    def test_records_name_and_attributes(self, exporter: InMemorySpanExporter) -> None:
        with telemetry.monte_carlo_span("proj-9", simulation_count=1000):
            pass
        span_data = exporter.get_finished_spans()[0]
        assert span_data.name == "schedule.monte_carlo"
        attrs = dict(span_data.attributes or {})
        assert attrs[attributes.PROJECT_ID] == "proj-9"
        assert attrs[attributes.SCHEDULE_SIMULATION_COUNT] == 1000

    def test_omits_simulation_count_when_none(self, exporter: InMemorySpanExporter) -> None:
        with telemetry.monte_carlo_span("p"):
            pass
        attrs = dict(exporter.get_finished_spans()[0].attributes or {})
        assert attributes.SCHEDULE_SIMULATION_COUNT not in attrs


def test_spans_are_non_recording_under_the_default_noop_provider() -> None:
    """With no exporter patched in (default API no-op provider), spans cost nothing.

    Asserts the unconditional-wrap-at-call-site design is safe: when telemetry is
    off the span is non-recording, so ``set_attribute`` is a cheap no-op.
    """
    with telemetry.cpm_span("p") as span:
        assert span.is_recording() is False
