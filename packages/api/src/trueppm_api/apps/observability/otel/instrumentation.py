"""OpenTelemetry auto-instrumentation wiring (ADR-0223 Phase 1, #709).

The Foundation (:mod:`.provider`, #708) builds the ``TracerProvider`` but
instruments no business logic. This module is Phase 1: it turns on the library
auto-instrumentors — Django (HTTP request/view spans), Celery (task spans with
trace-context propagation across the broker), and psycopg (DB-query spans) — and
provides the ASGI helper that adds WebSocket spans without double-counting HTTP.

Two invariants mirror the Foundation's:

1. **Strict no-op when disabled.** :func:`instrument` returns *before importing
   any instrumentor* when the bootstrap context is disabled, so a default
   deployment never even imports the ``opentelemetry.instrumentation.*`` packages,
   let alone patches Django/psycopg/Celery. This matches the lazy-import pattern in
   ``provider._build_tracer_provider``.

2. **Idempotent.** ``ObservabilityConfig.ready()`` can fire more than once under
   the test runner and the autoreloader; a module-level guard makes the second
   call a no-op so libraries are never double-patched.

Each instrumentor is bound to the *installed* provider explicitly
(``tracer_provider=...``) rather than resolving the process global, which keeps
the test seam trivial (a test drives instrumentation against an in-memory
provider) and is robust if the global is ever set by another component.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from django.conf import settings

from .provider import is_enabled

if TYPE_CHECKING:
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.trace import TracerProvider

    from .provider import OTelBootstrapContext

logger = logging.getLogger(__name__)

# Instrumentor instances installed by instrument(), retained so uninstrument()
# (test teardown) can reverse them. Empty whenever instrumentation is off.
_installed: list[Any] = []
_instrumented = False


def instrument(
    context: OTelBootstrapContext,
    *,
    tracer_provider: TracerProvider | None = None,
    meter_provider: MeterProvider | None = None,
) -> None:
    """Install the library auto-instrumentors against the bootstrap context.

    Called from ``ObservabilityConfig.ready()`` immediately after
    :func:`~.provider.bootstrap`. A strict no-op when telemetry is disabled or when
    *both* traces and metrics are off, and idempotent across repeated ``ready()``
    calls.

    Django and Celery are wired whenever **either** signal is active because both
    emit metrics as well as spans (Django ``http.server.*``, Celery
    ``flower.task.runtime.seconds``, #710); each is bound to whichever providers are
    live, and a ``None`` provider makes that instrumentor fall back to the API's
    no-op for the disabled signal. psycopg is trace-only, so it is wired **only**
    when traces are on — a metrics-only deployment must not pay a per-query
    monkeypatch that would feed a no-op tracer.

    Args:
        context: The :class:`~.provider.OTelBootstrapContext` returned by
            ``bootstrap()``. When ``context.enabled`` is ``False`` (or both signal
            providers are ``None``) this returns immediately, before importing any
            instrumentor.
        tracer_provider: Provider to bind trace instrumentation to. Defaults to
            ``context.tracer_provider``; a test overrides it to assert spans against
            an in-memory provider.
        meter_provider: Provider to bind metric instrumentation to. Defaults to
            ``context.meter_provider``; a test overrides it to assert metrics against
            an in-memory reader.
    """
    global _instrumented

    if _instrumented:
        return

    traces_on = context.tracer_provider is not None
    metrics_on = context.meter_provider is not None
    # Guard BEFORE importing instrumentors: a disabled deployment (or one with both
    # signals off) pays no import cost and patches nothing.
    if not context.enabled or not (traces_on or metrics_on):
        return

    tracer = tracer_provider if tracer_provider is not None else context.tracer_provider
    meter = meter_provider if meter_provider is not None else context.meter_provider

    # Imported lazily, after the enabled-gate, so the no-op path never loads them.
    from opentelemetry.instrumentation.celery import CeleryInstrumentor
    from opentelemetry.instrumentation.django import DjangoInstrumentor

    try:
        # Django: server span per HTTP request, plus http.server.duration /
        # http.server.active_requests metrics when a meter provider is bound.
        django = DjangoInstrumentor()
        django.instrument(tracer_provider=tracer, meter_provider=meter)
        _installed.append(django)

        # Celery: task span + trace-context propagation via task headers
        # (before_task_publish / task_prerun signals), plus flower.task.runtime.seconds
        # when a meter provider is bound. Both the producer (API/web) and the worker
        # run ObservabilityConfig.ready(), so both ends are patched and a task
        # enqueued under a request span becomes its child.
        # CeleryInstrumentor lacks a py.typed marker upstream, so its constructor
        # is untyped to mypy --strict; the wiring is otherwise identical to Django.
        celery = CeleryInstrumentor()  # type: ignore[no-untyped-call]
        celery.instrument(tracer_provider=tracer, meter_provider=meter)
        _installed.append(celery)

        # psycopg (v3): DB-query span per statement — trace-only, so it is wired only
        # when traces are enabled. enable_commenter=False is the default but set
        # explicitly — SQL comment injection mutates statements and can interfere with
        # statement caching / pgbouncer, so we never mutate the query. DB spans are the
        # dominant span volume; BatchSpanProcessor absorbs it.
        if traces_on:
            from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor

            psycopg = PsycopgInstrumentor()
            psycopg.instrument(tracer_provider=tracer, enable_commenter=False)
            _installed.append(psycopg)
    except Exception:
        # A patch failure must never crash startup — telemetry is best-effort.
        logger.exception("OpenTelemetry auto-instrumentation failed; continuing")

    _instrumented = True
    logger.info("OpenTelemetry auto-instrumentation installed (%d libraries)", len(_installed))


#: Value substituted for the credential-bearing WebSocket handshake query string.
_WS_REDACTED_QUERY = "REDACTED"


def _redact_ws_credential_span(span: Any, scope: dict[str, Any]) -> None:
    """Strip the handshake credential from a WebSocket server span (#1723).

    ``OpenTelemetryMiddleware`` records the raw request query string into the
    span's URL/target attributes (``collect_request_attributes`` in
    ``opentelemetry.instrumentation.asgi``). For a WS upgrade that query string
    *is* the credential — ``?ticket=`` and the legacy ``?token=<jwt>`` — so
    exporting those attributes ships a live, replayable credential to anyone with
    read access to the trace store, re-opening the credential-in-URL leak (#818)
    that the ADR-0141 ticket scheme closed.

    This ``server_request_hook`` fires after attribute collection but before the
    span is exported, so overwriting the offending attributes redacts them from
    every exporter. It replaces the dedicated ``url.query`` attribute outright and
    truncates the path/URL attributes (``http.target``, ``http.url``, ``url.full``
    — shaped ``<path-or-url>?<query>``) at the ``?``. Wired onto the
    websocket-branch middleware only, so HTTP request spans are untouched.
    """
    if span is None or not span.is_recording():
        return
    # Nothing to redact when the handshake carried no query string.
    if not scope.get("query_string"):
        return
    # span.attributes is the live BoundedAttributes mapping; snapshot before we
    # mutate it via set_attribute (which overwrites in place).
    for key, value in list((span.attributes or {}).items()):
        if not isinstance(value, str):
            continue
        lkey = key.lower()
        if lkey.endswith("query"):
            span.set_attribute(key, _WS_REDACTED_QUERY)
        elif lkey.endswith(("target", "url", "full")) and "?" in value:
            span.set_attribute(key, value.split("?", 1)[0])


def wrap_asgi_app(app: Any) -> Any:
    """Wrap the ASGI ``application`` for WebSocket spans, or return it unchanged.

    ``DjangoInstrumentor`` covers HTTP (Django's request handler) but not the
    Channels WebSocket path, which never reaches that handler. Wrapping the
    **websocket branch only** with the ASGI middleware adds connect/receive spans
    without the double server-span that wrapping the whole ``ProtocolTypeRouter``
    would cause for HTTP.

    A strict no-op when telemetry is disabled: the ``opentelemetry.instrumentation
    .asgi`` import happens only past the gate, and the original app is returned
    unchanged so a default deployment adds no ASGI wrapper.

    The middleware is wired with :func:`_redact_ws_credential_span` as its
    ``server_request_hook`` so the WS handshake credential never reaches an
    exporter (#1723).

    Args:
        app: The ASGI application (typically the WebSocket ``URLRouter``).

    Returns:
        The wrapped app when telemetry is enabled, else ``app`` unchanged.
    """
    if not is_enabled() or not bool(getattr(settings, "TRUEPPM_OTEL_TRACES_ENABLED", True)):
        return app
    try:
        from opentelemetry.instrumentation.asgi import OpenTelemetryMiddleware

        return OpenTelemetryMiddleware(app, server_request_hook=_redact_ws_credential_span)
    except Exception:
        logger.exception("OpenTelemetry ASGI wrap failed; continuing without WebSocket spans")
        return app


def reset_for_testing() -> None:
    """Reverse instrumentation and clear the guard so a test can re-run it.

    Test-suite only. Calls ``uninstrument()`` on each installed instrumentor
    (the ``BaseInstrumentor`` API is reversible) so a subsequent ``instrument()``
    in another test starts from a clean, un-patched state.
    """
    global _instrumented
    for instrumentor in reversed(_installed):
        try:
            instrumentor.uninstrument()
        except Exception:
            logger.exception("OpenTelemetry uninstrument failed for %r", instrumentor)
    _installed.clear()
    _instrumented = False
