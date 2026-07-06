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
) -> None:
    """Install the library auto-instrumentors against the bootstrap context.

    Called from ``ObservabilityConfig.ready()`` immediately after
    :func:`~.provider.bootstrap`. A strict no-op when telemetry is disabled or
    traces are turned off, and idempotent across repeated ``ready()`` calls.

    Args:
        context: The :class:`~.provider.OTelBootstrapContext` returned by
            ``bootstrap()``. When ``context.enabled`` is ``False`` this returns
            immediately, before importing any instrumentor.
        tracer_provider: The provider to bind instrumentors to. Defaults to
            ``context.tracer_provider``; a test overrides it to assert spans
            against an in-memory provider.
    """
    global _instrumented

    if _instrumented:
        return
    # Guard BEFORE importing instrumentors: a disabled deployment pays no import
    # cost and patches nothing. Traces-disabled (metrics-only) is also a no-op
    # here — this module only wires trace instrumentation (Phase 1).
    if not context.enabled or context.tracer_provider is None:
        return

    provider = tracer_provider or context.tracer_provider

    # Imported lazily, after the enabled-gate, so the no-op path never loads them.
    from opentelemetry.instrumentation.celery import CeleryInstrumentor
    from opentelemetry.instrumentation.django import DjangoInstrumentor
    from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor

    try:
        # Django: server span per HTTP request through Django's request handler.
        django = DjangoInstrumentor()
        django.instrument(tracer_provider=provider)
        _installed.append(django)

        # Celery: task span + automatic trace-context propagation via task headers
        # (before_task_publish / task_prerun signals). Both the producer (API/web)
        # and the worker run ObservabilityConfig.ready(), so both ends are patched
        # and a task enqueued under a request span becomes its child.
        # CeleryInstrumentor lacks a py.typed marker upstream, so its constructor
        # is untyped to mypy --strict; the wiring is otherwise identical to the others.
        celery = CeleryInstrumentor()  # type: ignore[no-untyped-call]
        celery.instrument(tracer_provider=provider)
        _installed.append(celery)

        # psycopg (v3): DB-query span per statement. enable_commenter=False is the
        # default but set explicitly — SQL comment injection mutates statements and
        # can interfere with statement caching / pgbouncer, so we never mutate the
        # query. DB spans are the dominant span volume; BatchSpanProcessor absorbs it.
        psycopg = PsycopgInstrumentor()
        psycopg.instrument(tracer_provider=provider, enable_commenter=False)
        _installed.append(psycopg)
    except Exception:
        # A patch failure must never crash startup — telemetry is best-effort.
        logger.exception("OpenTelemetry auto-instrumentation failed; continuing")

    _instrumented = True
    logger.info("OpenTelemetry auto-instrumentation installed (%d libraries)", len(_installed))


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

    Args:
        app: The ASGI application (typically the WebSocket ``URLRouter``).

    Returns:
        The wrapped app when telemetry is enabled, else ``app`` unchanged.
    """
    if not is_enabled() or not bool(getattr(settings, "TRUEPPM_OTEL_TRACES_ENABLED", True)):
        return app
    try:
        from opentelemetry.instrumentation.asgi import OpenTelemetryMiddleware

        return OpenTelemetryMiddleware(app)
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
