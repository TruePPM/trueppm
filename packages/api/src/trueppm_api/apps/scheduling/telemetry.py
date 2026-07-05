"""OpenTelemetry manual spans for the scheduling engine (ADR-0223 Phase 1, #709).

These context managers wrap the CPM and Monte Carlo engine calls from the **API
layer** so the standalone ``trueppm_scheduler`` package stays OpenTelemetry-free
(it ships to PyPI under Apache-2.0 with no Django/OTel dependency — boundary rule
#3). Both Monte Carlo call sites (``run_monte_carlo`` and ``MonteCarloWhatIfView``)
go through :func:`monte_carlo_span`, so their span name and attributes can never
drift apart.

All spans use the single ``trueppm.scheduling`` tracer. When telemetry is
disabled the OTel API returns a non-recording span and every ``set_attribute`` is
a cheap no-op, so callers wrap the engine call unconditionally — there is no
enabled-check at the call site.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from opentelemetry.trace import Span

from trueppm_api.apps.observability import otel
from trueppm_api.apps.observability.otel import attributes

# One tracer for every scheduling-engine span (low-cardinality instrumentation
# scope). Span names stay dotted and low-cardinality: "schedule.cpm",
# "schedule.monte_carlo".
_TRACER_NAME = "trueppm.scheduling"

# Every dispatch of recalculate_schedule is a full CPM recompute (the engine-level
# incremental recompute is #235, 0.5), so the recompute reason is a constant — no
# per-dispatch reason is plumbed through the call chain in Phase 1.
_FULL_RECOMPUTE = "full_recompute"


@contextmanager
def cpm_span(project_id: str, *, dependency_count: int | None = None) -> Iterator[Span]:
    """Span around a full CPM ``schedule()`` call.

    The caller sets the result-derived counts (task / critical) on the yielded
    span after the engine returns, since they are unknown until then.

    Args:
        project_id: The project being scheduled (``trueppm.project.id``).
        dependency_count: Edge count of the CPM graph, known before the call.

    Yields:
        The active :class:`~opentelemetry.trace.Span` so the caller can attach
        result-derived attributes (task/critical counts).
    """
    tracer = otel.get_tracer(_TRACER_NAME)
    with tracer.start_as_current_span("schedule.cpm") as span:
        span.set_attribute(attributes.PROJECT_ID, str(project_id))
        span.set_attribute(attributes.SCHEDULE_RECOMPUTE_REASON, _FULL_RECOMPUTE)
        if dependency_count is not None:
            span.set_attribute(attributes.SCHEDULE_DEPENDENCY_COUNT, dependency_count)
        yield span


@contextmanager
def monte_carlo_span(project_id: str, *, simulation_count: int | None = None) -> Iterator[Span]:
    """Span around a ``monte_carlo()`` simulation.

    Shared by both Monte Carlo entry points so their span name and attributes stay
    identical.

    Args:
        project_id: The project being simulated (``trueppm.project.id``).
        simulation_count: Requested number of simulation runs.

    Yields:
        The active :class:`~opentelemetry.trace.Span`.
    """
    tracer = otel.get_tracer(_TRACER_NAME)
    with tracer.start_as_current_span("schedule.monte_carlo") as span:
        span.set_attribute(attributes.PROJECT_ID, str(project_id))
        if simulation_count is not None:
            span.set_attribute(attributes.SCHEDULE_SIMULATION_COUNT, simulation_count)
        yield span
