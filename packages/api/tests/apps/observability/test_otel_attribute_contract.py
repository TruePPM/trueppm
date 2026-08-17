"""The ``trueppm.*`` span-attribute contract is asserted by EMISSION (#2880).

``attributes.py`` publishes its keys as an additive-only, cross-repo contract the
enterprise edition depends on. Seven of the eight original span keys had **zero**
emit sites, and the test that made the gap look covered iterated all nine and
asserted only ``key.startswith("trueppm.")`` — coverage of the constant, not of the
behavior. A collector-side processor keyed on ``trueppm.task.id`` silently never
fired, and nothing in the suite could tell.

So this module asserts two things a string check cannot:

1. **The published surface is partitioned.** ``EMITTED_SPAN_ATTRIBUTES`` and
   ``RESERVED_SPAN_ATTRIBUTES`` must exactly cover ``SPAN_ATTRIBUTES`` and not
   overlap — a constant added without being classified fails here rather than
   joining the promise unnoticed.
2. **Every emitted key reaches a real span.** Each one is produced by RUNNING its
   consumer against an in-memory exporter, and the reserved keys are asserted absent
   from those same spans. Rename an attribute or delete an emit site and this goes
   red; the old test would not have moved.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from django.test import RequestFactory
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.access.permissions import RBAC_ROLE_CACHE_ATTR
from trueppm_api.apps.observability.otel import attributes, request_attributes
from trueppm_api.apps.scheduling import telemetry


@pytest.fixture
def exporter() -> Iterator[InMemorySpanExporter]:
    exp = InMemorySpanExporter()
    yield exp
    exp.clear()


@pytest.fixture
def tracer(exporter: InMemorySpanExporter) -> Any:
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer("test")


def _emitted_keys(exporter: InMemorySpanExporter) -> set[str]:
    """Every ``trueppm.*`` attribute key present across all finished spans."""
    keys: set[str] = set()
    for span in exporter.get_finished_spans():
        keys.update(k for k in (span.attributes or {}) if k.startswith("trueppm."))
    return keys


class TestPartition:
    """The published key set is split, exhaustively and without overlap."""

    def test_emitted_and_reserved_cover_every_span_attribute(self) -> None:
        assert set(attributes.SPAN_ATTRIBUTES) == (
            attributes.EMITTED_SPAN_ATTRIBUTES | attributes.RESERVED_SPAN_ATTRIBUTES
        )

    def test_emitted_and_reserved_are_disjoint(self) -> None:
        assert not (attributes.EMITTED_SPAN_ATTRIBUTES & attributes.RESERVED_SPAN_ATTRIBUTES)

    def test_reserved_set_is_exactly_the_three_documented_keys(self) -> None:
        """Pinned deliberately: growing this set is a shrinking promise.

        Each of the three has a stated, structural reason in its constant's
        docstring — no ``Project.key`` field, no board entity, and a duplicate of the
        ``trueppm.edition`` resource attribute. A fourth arriving quietly would mean
        a key was published and then abandoned, which is the exact failure #2880
        exists to stop.
        """
        assert {
            attributes.PROJECT_KEY,
            attributes.BOARD_ID,
            attributes.REQUEST_EDITION,
        } == attributes.RESERVED_SPAN_ATTRIBUTES

    def test_every_key_is_under_the_namespace(self) -> None:
        for key in attributes.SPAN_ATTRIBUTES:
            assert key.startswith("trueppm.")


class TestEmissionCoversTheEmittedSet:
    """Each emitted key is produced by running its consumer, not asserted as a string."""

    def test_engine_spans_emit_their_declared_keys(
        self,
        exporter: InMemorySpanExporter,
        tracer: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(telemetry.otel, "get_tracer", lambda _name: tracer)

        with telemetry.cpm_span("proj-1", dependency_count=4) as span:
            span.set_attribute(attributes.SCHEDULE_TASK_COUNT, 9)
            span.set_attribute(attributes.SCHEDULE_CRITICAL_COUNT, 2)
        with telemetry.monte_carlo_span("proj-1", simulation_count=1000):
            pass

        emitted = _emitted_keys(exporter)
        assert {
            attributes.PROJECT_ID,
            attributes.SCHEDULE_RECOMPUTE_REASON,
            attributes.SCHEDULE_DEPENDENCY_COUNT,
            attributes.SCHEDULE_TASK_COUNT,
            attributes.SCHEDULE_CRITICAL_COUNT,
            attributes.SCHEDULE_SIMULATION_COUNT,
        } <= emitted

    def test_agent_span_attributes_are_written_by_the_permission_layer(
        self, exporter: InMemorySpanExporter, tracer: Any
    ) -> None:
        from opentelemetry import trace as trace_api

        from trueppm_api.apps.access import permissions

        token = type("Tok", (), {"token_prefix": "abcd1234"})()
        with trace_api.use_span(tracer.start_span("mcp.read"), end_on_exit=True):
            permissions._set_agent_span_attributes(token, "allowed")

        emitted = _emitted_keys(exporter)
        assert {
            attributes.AGENT_TOKEN_PREFIX,
            attributes.AGENT_CAPABILITY,
            attributes.AGENT_ACTOR_KIND,
            attributes.AGENT_VERDICT,
        } <= emitted

    def test_request_span_emits_the_identity_keys(
        self, exporter: InMemorySpanExporter, tracer: Any
    ) -> None:
        project_id, task_id, program_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

        for route, kwargs in (
            ("api/v1/^projects/(?P<pk>[^/.]+)/$", {"pk": str(project_id)}),
            ("api/v1/^tasks/(?P<pk>[^/.]+)/$", {"pk": str(task_id)}),
            ("api/v1/^programs/(?P<pk>[^/.]+)/$", {"pk": str(program_id)}),
        ):
            request = _request(route=route, kwargs=kwargs, user_pk=uuid.uuid4())
            setattr(request, RBAC_ROLE_CACHE_ATTR, {str(project_id): int(Role.ADMIN)})
            span = tracer.start_span("GET /api/v1/")
            request_attributes.annotate_request_span(span, request, None)
            span.end()

        emitted = _emitted_keys(exporter)
        assert {
            attributes.PROJECT_ID,
            attributes.TASK_ID,
            attributes.PROGRAM_ID,
            attributes.USER_ID,
            attributes.USER_ROLE,
        } <= emitted

    def test_no_reserved_key_is_ever_written(
        self,
        exporter: InMemorySpanExporter,
        tracer: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The other half of the promise: a reserved key must stay unwritten.

        Emitting one would make it look supported without any of the meaning its
        name implies — worse than the silence, because a processor keyed on it would
        start firing on a value nobody defined.
        """
        monkeypatch.setattr(telemetry.otel, "get_tracer", lambda _name: tracer)
        with telemetry.cpm_span("proj-1"):
            pass
        request = _request(
            route="api/v1/^projects/(?P<pk>[^/.]+)/$",
            kwargs={"pk": str(uuid.uuid4())},
            user_pk=uuid.uuid4(),
        )
        span = tracer.start_span("GET /api/v1/projects/{id}/")
        request_attributes.annotate_request_span(span, request, None)
        span.end()

        assert not (_emitted_keys(exporter) & attributes.RESERVED_SPAN_ATTRIBUTES)


def _request(*, route: str, kwargs: dict[str, Any], user_pk: Any | None = None) -> Any:
    """A Django request with a resolver match and (optionally) a resolved user."""
    request = RequestFactory().get("/api/v1/")
    request.resolver_match = type("Match", (), {"route": route, "kwargs": kwargs})()
    if user_pk is not None:
        request.user = type("U", (), {"pk": user_pk, "is_authenticated": True})()
    return request
