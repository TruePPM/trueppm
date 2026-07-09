"""Tests for OTel Phase 1 auto-instrumentation wiring (ADR-0223, #709).

These are hermetic: rather than let ``instrument()`` patch the live Django /
psycopg / Celery libraries in-process (which would leak global state across the
suite), the three ``Instrumentor`` classes are replaced with fakes that record
how they were called. That isolates the module's own logic — the enabled-gate,
the explicit provider binding, idempotency, and reversal — from the third-party
libraries, which are exercised end-to-end by CI's real collector integration.

The strict-no-op invariant (disabled → nothing imported, nothing patched) and the
ASGI websocket-wrap decision (#709 🔴 #1) are asserted directly.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, ClassVar

import pytest
from django.test import override_settings

from trueppm_api.apps.observability import otel
from trueppm_api.apps.observability.otel import instrumentation
from trueppm_api.apps.observability.otel.provider import OTelBootstrapContext

_ENDPOINT = "http://otel-collector.test:4317"


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    """Reset the instrumentation guard + installed list around each test."""
    instrumentation.reset_for_testing()
    yield
    instrumentation.reset_for_testing()


def _ctx(
    *, enabled: bool, tracer_provider: Any = None, meter_provider: Any = None
) -> OTelBootstrapContext:
    return OTelBootstrapContext(
        schema_version=1,
        enabled=enabled,
        edition="community",
        resource=None,
        tracer_provider=tracer_provider,
        meter_provider=meter_provider,
    )


class _FakeInstrumentor:
    """Records instrument/uninstrument calls without touching any real library."""

    calls: ClassVar[list[tuple[str, str, dict[str, Any]]]] = []

    def instrument(self, **kwargs: Any) -> None:
        _FakeInstrumentor.calls.append(("instrument", type(self).__name__, kwargs))

    def uninstrument(self, **kwargs: Any) -> None:
        _FakeInstrumentor.calls.append(("uninstrument", type(self).__name__, kwargs))


class _FakeDjango(_FakeInstrumentor):
    pass


class _FakeCelery(_FakeInstrumentor):
    pass


class _FakePsycopg(_FakeInstrumentor):
    pass


@pytest.fixture
def fake_instrumentors(monkeypatch: pytest.MonkeyPatch) -> type[_FakeInstrumentor]:
    """Swap the three real Instrumentor classes for recording fakes.

    ``instrument()`` imports them lazily by their source module, so patching the
    class attribute on each source module is what the in-function import resolves.
    """
    _FakeInstrumentor.calls = []
    monkeypatch.setattr(
        "opentelemetry.instrumentation.django.DjangoInstrumentor", _FakeDjango, raising=True
    )
    monkeypatch.setattr(
        "opentelemetry.instrumentation.celery.CeleryInstrumentor", _FakeCelery, raising=True
    )
    monkeypatch.setattr(
        "opentelemetry.instrumentation.psycopg.PsycopgInstrumentor", _FakePsycopg, raising=True
    )
    return _FakeInstrumentor


class TestNoOpWhenDisabled:
    def test_disabled_context_installs_nothing(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        otel.instrument(_ctx(enabled=False))
        assert instrumentation._installed == []
        assert instrumentation._instrumented is False
        assert fake_instrumentors.calls == []

    def test_enabled_but_both_signals_off_installs_nothing(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        """Enabled but both providers None (traces AND metrics off) → strict no-op."""
        otel.instrument(_ctx(enabled=True, tracer_provider=None, meter_provider=None))
        assert instrumentation._installed == []
        assert fake_instrumentors.calls == []


class TestInstallsWhenEnabled:
    def test_installs_all_three_bound_to_provider(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        sentinel = object()
        otel.instrument(_ctx(enabled=True, tracer_provider=sentinel))

        assert instrumentation._instrumented is True
        assert len(instrumentation._installed) == 3
        installed = {name for verb, name, _kw in fake_instrumentors.calls if verb == "instrument"}
        assert installed == {"_FakeDjango", "_FakeCelery", "_FakePsycopg"}
        # Every instrumentor is bound to the installed provider explicitly.
        for _verb, _name, kwargs in fake_instrumentors.calls:
            assert kwargs["tracer_provider"] is sentinel

    def test_psycopg_disables_sql_commenter(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        """SQL comment injection mutates statements — Phase 1 keeps it off."""
        otel.instrument(_ctx(enabled=True, tracer_provider=object()))
        psycopg_call = next(
            kwargs for _, name, kwargs in fake_instrumentors.calls if name == "_FakePsycopg"
        )
        assert psycopg_call["enable_commenter"] is False

    def test_idempotent_second_call_is_noop(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        ctx = _ctx(enabled=True, tracer_provider=object())
        otel.instrument(ctx)
        first = len(fake_instrumentors.calls)
        otel.instrument(ctx)
        assert len(fake_instrumentors.calls) == first  # no new instrument calls

    def test_reset_uninstruments_in_reverse(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        otel.instrument(_ctx(enabled=True, tracer_provider=object()))
        instrumentation.reset_for_testing()
        uninstrumented = [
            name for verb, name, _ in fake_instrumentors.calls if verb == "uninstrument"
        ]
        # reversed install order: psycopg, celery, django
        assert uninstrumented == ["_FakePsycopg", "_FakeCelery", "_FakeDjango"]
        assert instrumentation._installed == []
        assert instrumentation._instrumented is False

    def test_instrument_swallows_instrumentor_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A patch failure must never crash startup."""

        class _Boom(_FakeInstrumentor):
            def instrument(self, **kwargs: Any) -> None:
                raise RuntimeError("boom")

        monkeypatch.setattr(
            "opentelemetry.instrumentation.django.DjangoInstrumentor", _Boom, raising=True
        )
        monkeypatch.setattr(
            "opentelemetry.instrumentation.celery.CeleryInstrumentor", _FakeCelery, raising=True
        )
        monkeypatch.setattr(
            "opentelemetry.instrumentation.psycopg.PsycopgInstrumentor", _FakePsycopg, raising=True
        )
        # Does not raise; marks instrumented so ready() never retries a broken wire.
        otel.instrument(_ctx(enabled=True, tracer_provider=object()))
        assert instrumentation._instrumented is True


class TestMetricThreading:
    """Phase 2 (#710): metrics are wired via the same instrumentors, on their own gate."""

    def test_metrics_only_installs_django_celery_not_psycopg(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        """Traces off, metrics on → Django + Celery (they emit metrics), not psycopg."""
        meter = object()
        otel.instrument(_ctx(enabled=True, tracer_provider=None, meter_provider=meter))
        installed = {name for verb, name, _kw in fake_instrumentors.calls if verb == "instrument"}
        assert installed == {"_FakeDjango", "_FakeCelery"}
        assert len(instrumentation._installed) == 2

    def test_meter_provider_threaded_to_django_and_celery(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        meter = object()
        otel.instrument(_ctx(enabled=True, tracer_provider=None, meter_provider=meter))
        for _verb, _name, kwargs in fake_instrumentors.calls:
            assert kwargs["meter_provider"] is meter

    def test_both_signals_on_installs_all_three_with_both_providers(
        self, fake_instrumentors: type[_FakeInstrumentor]
    ) -> None:
        tracer, meter = object(), object()
        otel.instrument(_ctx(enabled=True, tracer_provider=tracer, meter_provider=meter))
        assert len(instrumentation._installed) == 3
        django_call = next(
            kwargs for _, name, kwargs in fake_instrumentors.calls if name == "_FakeDjango"
        )
        assert django_call["tracer_provider"] is tracer
        assert django_call["meter_provider"] is meter


class TestAsgiWrap:
    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="")
    def test_returns_app_unchanged_when_disabled(self) -> None:
        app = object()
        assert otel.wrap_asgi_app(app) is app

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT)
    def test_wraps_when_enabled(self) -> None:
        from opentelemetry.instrumentation.asgi import OpenTelemetryMiddleware

        async def app(scope: Any, receive: Any, send: Any) -> None:  # pragma: no cover
            return None

        wrapped = otel.wrap_asgi_app(app)
        assert wrapped is not app
        assert isinstance(wrapped, OpenTelemetryMiddleware)

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT, TRUEPPM_OTEL_TRACES_ENABLED=False)
    def test_returns_app_unchanged_when_traces_disabled(self) -> None:
        app = object()
        assert otel.wrap_asgi_app(app) is app

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT)
    def test_wrap_installs_ws_credential_redaction_hook(self) -> None:
        """The WS middleware is wired with the credential-redaction request hook (#1723)."""

        async def app(scope: Any, receive: Any, send: Any) -> None:  # pragma: no cover
            return None

        wrapped = otel.wrap_asgi_app(app)
        # failsafe() wraps the hook, so compare against the identity it closes over.
        assert wrapped.server_request_hook is not None
        wrapped.server_request_hook(_FakeSpan(), {"query_string": b"probe"})  # smoke: callable


class _FakeSpan:
    """Minimal recording span double for the redaction hook.

    Mirrors the SDK ``_Span`` surface the hook touches: a readable ``attributes``
    mapping, ``is_recording()``, and ``set_attribute`` overwriting in place.
    """

    def __init__(self, attributes: dict[str, Any] | None = None, *, recording: bool = True) -> None:
        self.attributes: dict[str, Any] = dict(attributes or {})
        self._recording = recording

    def is_recording(self) -> bool:
        return self._recording

    def set_attribute(self, key: str, value: Any) -> None:
        self.attributes[key] = value


class TestWsCredentialRedaction:
    """`_redact_ws_credential_span` must scrub the handshake credential (#1723)."""

    _CREDS = "ticket=tk-secret&token=header.payload.sig"

    def test_redacts_query_and_truncates_url_attributes(self) -> None:
        span = _FakeSpan(
            {
                "url.query": self._CREDS,
                "http.target": f"/ws/project/abc/?{self._CREDS}",
                "http.url": f"ws://api.test/ws/project/abc/?{self._CREDS}",
                "url.full": f"ws://api.test/ws/project/abc/?{self._CREDS}",
                "url.path": "/ws/project/abc/",
                "http.method": "GET",
            }
        )
        instrumentation._redact_ws_credential_span(span, {"query_string": self._CREDS.encode()})

        assert span.attributes["url.query"] == instrumentation._WS_REDACTED_QUERY
        assert span.attributes["http.target"] == "/ws/project/abc/"
        assert span.attributes["http.url"] == "ws://api.test/ws/project/abc/"
        assert span.attributes["url.full"] == "ws://api.test/ws/project/abc/"
        # Query-free attributes are left untouched.
        assert span.attributes["url.path"] == "/ws/project/abc/"
        assert span.attributes["http.method"] == "GET"
        # No attribute anywhere still carries the credential.
        assert not any(
            "tk-secret" in v or "header.payload.sig" in v
            for v in span.attributes.values()
            if isinstance(v, str)
        )

    def test_noop_when_no_query_string(self) -> None:
        span = _FakeSpan({"http.target": "/ws/project/abc/"})
        instrumentation._redact_ws_credential_span(span, {"query_string": b""})
        assert span.attributes["http.target"] == "/ws/project/abc/"

    def test_noop_when_span_not_recording(self) -> None:
        span = _FakeSpan({"url.query": self._CREDS}, recording=False)
        instrumentation._redact_ws_credential_span(span, {"query_string": self._CREDS.encode()})
        # Not recording → left as-is (span will not be exported anyway).
        assert span.attributes["url.query"] == self._CREDS

    def test_handles_none_span(self) -> None:
        # The middleware can invoke the hook with no active span; must not raise.
        instrumentation._redact_ws_credential_span(None, {"query_string": b"ticket=tk"})
