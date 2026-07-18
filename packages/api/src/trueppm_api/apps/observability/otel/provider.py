"""OpenTelemetry provider bootstrap and enterprise extension point (ADR-0223).

This module is the OSS **foundation** for OpenTelemetry (epic #707, issue #708).
It does not instrument any business logic — that is Phase 1/2. It provides:

1. :func:`bootstrap` — called once from ``ObservabilityConfig.ready()``. It reads
   the opt-in configuration and, only when an OTLP endpoint is configured, builds
   a ``TracerProvider`` / ``MeterProvider`` with an OTLP exporter and installs them
   as the process-global providers. With no endpoint it is a **strict no-op**: it
   installs no SDK provider at all, leaving the OTel API's default no-op provider
   in place (no export threads, no per-request cost).

2. :func:`register_provider_hook` — the stable extension point the proprietary
   ``trueppm-enterprise`` edition registers against to attach its own span
   processors, exporters, or instrumentation, **without importing OSS internals**
   and without OSS importing enterprise (Apache-2.0 boundary rule #3).

3. :func:`get_tracer` / :func:`get_meter` — thin, stable accessors over the
   standard OTel API so OSS Phase 1/2 code and enterprise obtain instruments
   through one documented surface. They behave identically in the enabled and
   no-op states.

Ordering guarantee: Django fires each ``AppConfig.ready()`` in ``INSTALLED_APPS``
order, and enterprise apps are appended after OSS apps — so an enterprise hook
would otherwise register *after* this bootstrap already ran. Registration is
therefore made order-independent: :func:`bootstrap` invokes every hook already
registered and stores the resulting context, and :func:`register_provider_hook`
invokes a late-arriving hook immediately against that stored context. Either
ordering delivers the context to each hook exactly once.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from importlib import metadata
from typing import TYPE_CHECKING, Any

from django.conf import settings
from opentelemetry import metrics as otel_metrics
from opentelemetry import trace as otel_trace

from . import attributes

if TYPE_CHECKING:
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.sampling import Sampler

logger = logging.getLogger(__name__)

# The current version of the OTelBootstrapContext contract. Bumped only when a
# field is ADDED (never renamed/removed) so enterprise can feature-detect.
_CONTEXT_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class OTelBootstrapContext:
    """Immutable snapshot handed to every registered provider hook (ADR-0223 §4).

    Frozen and carrying an additive ``schema_version``, so it is a stable
    cross-repo contract: new fields are appended, existing fields are never
    renamed or removed. A hook typically does
    ``ctx.tracer_provider.add_span_processor(...)`` to attach its own exporter,
    or short-circuits when ``ctx.enabled`` is ``False``.

    Attributes:
        schema_version: Contract version; enterprise can gate on this.
        enabled: Whether telemetry export is active. When ``False`` the provider
            fields are ``None`` and no SDK provider was installed.
        edition: The value of ``settings.TRUEPPM_EDITION`` (``community`` |
            ``enterprise``), also recorded as the ``trueppm.edition`` resource
            attribute.
        resource: The OTel ``Resource`` describing this process, or ``None`` when
            disabled.
        tracer_provider: The installed ``TracerProvider``, or ``None`` when traces
            are disabled.
        meter_provider: The installed ``MeterProvider``, or ``None`` when metrics
            are disabled.
    """

    schema_version: int
    enabled: bool
    edition: str
    resource: Resource | None
    tracer_provider: TracerProvider | None
    meter_provider: MeterProvider | None


ProviderHook = Callable[[OTelBootstrapContext], None]

# Module-level registry. `_context` is set once bootstrap runs; a hook registered
# after that point is invoked immediately against it (see register_provider_hook).
_hooks: list[ProviderHook] = []
_context: OTelBootstrapContext | None = None
_bootstrapped = False


def register_provider_hook(hook: ProviderHook) -> None:
    """Register a callback invoked with the OTel bootstrap context (ADR-0223 §4).

    This is the enterprise extension point. Enterprise calls it from its own
    ``AppConfig.ready()``; the callback receives an :class:`OTelBootstrapContext`
    and may attach additional span processors / exporters or wire instrumentation.

    Order-independent: if :func:`bootstrap` has already run, ``hook`` is invoked
    immediately with the stored context; otherwise it is invoked when
    :func:`bootstrap` runs. Either way the hook fires exactly once. A hook that
    raises is logged and swallowed so it can never crash app startup.

    Args:
        hook: A callable taking the :class:`OTelBootstrapContext`.
    """
    _hooks.append(hook)
    if _context is not None:
        _invoke_hook(hook, _context)


def _invoke_hook(hook: ProviderHook, context: OTelBootstrapContext) -> None:
    """Invoke a single hook, isolating failures from app startup."""
    try:
        hook(context)
    except Exception:
        logger.exception("OpenTelemetry provider hook %r failed", hook)


def is_enabled() -> bool:
    """Return whether telemetry export is active.

    Telemetry is on only when the master switch is set AND an OTLP endpoint is
    configured — there is no default endpoint, so the out-of-the-box state is off.
    """
    endpoint = str(getattr(settings, "OTEL_EXPORTER_OTLP_ENDPOINT", "") or "").strip()
    master = bool(getattr(settings, "TRUEPPM_OTEL_ENABLED", True))
    return master and bool(endpoint)


def get_tracer(name: str) -> otel_trace.Tracer:
    """Return an OTel tracer via the standard API (works in the no-op state)."""
    return otel_trace.get_tracer(name)


def get_meter(name: str) -> otel_metrics.Meter:
    """Return an OTel meter via the standard API (works in the no-op state)."""
    return otel_metrics.get_meter(name)


def bootstrap() -> OTelBootstrapContext:
    """Initialize the OTel providers once, then invoke registered hooks.

    Idempotent: a second call returns the existing context without building a
    second export pipeline (safe under the test runner and the autoreloader).

    When telemetry is disabled this installs **no** SDK provider — the OTel API
    default no-op provider stays in place — and returns a context with
    ``enabled=False``. When enabled it builds the resource, the requested
    providers with an OTLP exporter, sets them global, and returns the context.
    In both cases every registered hook is invoked exactly once.

    Returns:
        The :class:`OTelBootstrapContext` describing the installed state.
    """
    global _context, _bootstrapped

    if _bootstrapped and _context is not None:
        return _context

    edition = str(getattr(settings, "TRUEPPM_EDITION", "community"))

    if not is_enabled():
        context = OTelBootstrapContext(
            schema_version=_CONTEXT_SCHEMA_VERSION,
            enabled=False,
            edition=edition,
            resource=None,
            tracer_provider=None,
            meter_provider=None,
        )
    else:
        context = _bootstrap_enabled(edition)

    _context = context
    _bootstrapped = True
    for hook in list(_hooks):
        _invoke_hook(hook, context)
    return context


def _bootstrap_enabled(edition: str) -> OTelBootstrapContext:
    """Build and install the SDK providers. Falls back to a disabled context on
    any construction error so a misconfiguration can never crash startup."""
    try:
        resource = _build_resource(edition)
        tracer_provider = (
            _build_tracer_provider(resource)
            if getattr(settings, "TRUEPPM_OTEL_TRACES_ENABLED", True)
            else None
        )
        meter_provider = (
            _build_meter_provider(resource)
            if getattr(settings, "TRUEPPM_OTEL_METRICS_ENABLED", True)
            else None
        )
    except Exception:
        logger.exception("OpenTelemetry bootstrap failed; continuing without telemetry export")
        return OTelBootstrapContext(
            schema_version=_CONTEXT_SCHEMA_VERSION,
            enabled=False,
            edition=edition,
            resource=None,
            tracer_provider=None,
            meter_provider=None,
        )

    if tracer_provider is not None:
        otel_trace.set_tracer_provider(tracer_provider)
    if meter_provider is not None:
        otel_metrics.set_meter_provider(meter_provider)

    logger.info(
        "OpenTelemetry enabled: endpoint=%s protocol=%s traces=%s metrics=%s",
        settings.OTEL_EXPORTER_OTLP_ENDPOINT,
        settings.OTEL_EXPORTER_OTLP_PROTOCOL,
        tracer_provider is not None,
        meter_provider is not None,
    )
    return OTelBootstrapContext(
        schema_version=_CONTEXT_SCHEMA_VERSION,
        enabled=True,
        edition=edition,
        resource=resource,
        tracer_provider=tracer_provider,
        meter_provider=meter_provider,
    )


def _service_version() -> str:
    """Best-effort ``service.version`` from the installed package metadata."""
    try:
        return metadata.version("trueppm-api")
    except metadata.PackageNotFoundError:
        return "unknown"


def service_version() -> str:
    """Public accessor for the resource ``service.version`` (#2110 selector)."""
    return _service_version()


def _build_resource(edition: str) -> Resource:
    """Build the OTel ``Resource`` (service identity + ``trueppm.edition``)."""
    from opentelemetry.sdk.resources import Resource

    return Resource.create(
        {
            attributes.RESOURCE_SERVICE_NAME: settings.OTEL_SERVICE_NAME,
            attributes.RESOURCE_SERVICE_VERSION: _service_version(),
            attributes.RESOURCE_SERVICE_NAMESPACE: attributes.NAMESPACE,
            attributes.RESOURCE_EDITION: edition,
        }
    )


def build_resource() -> Resource:
    """Public ``Resource`` builder for the current edition.

    Used by the on-demand telemetry test-export (#2110) so its canary span carries
    the same service identity (``service.name`` / ``service.version`` /
    ``trueppm.edition``) as the real export pipeline — the operator sees the canary
    attributed to this deployment, not an anonymous span.
    """
    return _build_resource(str(getattr(settings, "TRUEPPM_EDITION", "community")))


def build_span_exporter(*, timeout: float | None = None) -> Any:
    """Build a one-off OTLP span exporter from the configured OTLP settings.

    Shared by the batched tracer provider (the long-lived export pipeline) and the
    on-demand telemetry **test-export** action (#2110), so both resolve endpoint,
    protocol and headers through the exact same path — a canary probe can never
    disagree with the real exporter about where spans go, and there is one place
    the bearer-token headers are read. ``timeout`` (seconds) bounds a single export
    attempt; the test action passes a short bound so a dead collector cannot hang
    the request, while the batch pipeline leaves it unset (the exporter default).

    The caller owns the returned exporter's lifecycle and must ``shutdown()`` it.
    """
    endpoint = settings.OTEL_EXPORTER_OTLP_ENDPOINT
    headers = _parse_headers(settings.OTEL_EXPORTER_OTLP_HEADERS)
    kwargs: dict[str, Any] = {"endpoint": endpoint, "headers": headers}
    if timeout is not None:
        kwargs["timeout"] = int(timeout)
    if _is_http_protocol():
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter as HTTPSpanExporter,
        )

        return HTTPSpanExporter(**kwargs)
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
        OTLPSpanExporter as GRPCSpanExporter,
    )

    return GRPCSpanExporter(**kwargs)


def _parse_headers(raw: str) -> dict[str, str] | None:
    """Parse ``key=value,key2=value2`` OTLP header config into a dict."""
    raw = (raw or "").strip()
    if not raw:
        return None
    headers: dict[str, str] = {}
    for pair in raw.split(","):
        if "=" not in pair:
            continue
        key, _, value = pair.partition("=")
        key = key.strip()
        if key:
            headers[key] = value.strip()
    return headers or None


def _is_http_protocol() -> bool:
    """True for the HTTP/protobuf OTLP transport, False for gRPC (the default)."""
    return str(settings.OTEL_EXPORTER_OTLP_PROTOCOL).lower().startswith("http")


def _build_sampler() -> Sampler:
    """Build a trace ``Sampler`` from ``OTEL_TRACES_SAMPLER`` / ``_ARG``.

    The ``TracerProvider`` in :func:`_build_tracer_provider` is constructed by
    hand rather than through the SDK's ``opentelemetry.sdk.trace.TracerProvider``
    auto-configuration entrypoint. That auto-config path is the *only* thing that
    reads the standard ``OTEL_TRACES_SAMPLER`` / ``OTEL_TRACES_SAMPLER_ARG`` env
    vars, so building the provider manually silently drops them and pins the
    process to the SDK default (``ParentBased(ALWAYS_ON)``) — full-rate export.
    For an API whose span volume is dominated by high-cardinality psycopg DB
    spans, that leaves an operator no knob to throttle trace cost short of
    turning tracing off entirely. This helper re-implements the standard env-var
    contract so those knobs work again.

    The default (unset env) is ``parentbased_always_on``, which is exactly the
    prior hard-coded behavior — so existing deployments see no change. The ratio
    argument for the ratio-based samplers is read from ``OTEL_TRACES_SAMPLER_ARG``
    and defaults to ``1.0`` (sample everything) when unset or unparseable.
    """
    from opentelemetry.sdk.trace.sampling import (
        ALWAYS_OFF,
        ALWAYS_ON,
        ParentBased,
        TraceIdRatioBased,
    )

    name = str(settings.OTEL_TRACES_SAMPLER).strip().lower()
    raw_arg = str(settings.OTEL_TRACES_SAMPLER_ARG).strip()
    try:
        ratio = float(raw_arg) if raw_arg else 1.0
    except ValueError:
        logger.warning("Invalid OTEL_TRACES_SAMPLER_ARG %r; falling back to 1.0", raw_arg)
        ratio = 1.0

    samplers: dict[str, Sampler] = {
        "always_on": ALWAYS_ON,
        "always_off": ALWAYS_OFF,
        "traceidratio": TraceIdRatioBased(ratio),
        "parentbased_always_on": ParentBased(ALWAYS_ON),
        "parentbased_always_off": ParentBased(ALWAYS_OFF),
        "parentbased_traceidratio": ParentBased(TraceIdRatioBased(ratio)),
    }
    sampler = samplers.get(name)
    if sampler is None:
        logger.warning("Unrecognized OTEL_TRACES_SAMPLER %r; using parentbased_always_on", name)
        sampler = ParentBased(ALWAYS_ON)
    return sampler


def _build_tracer_provider(resource: Resource) -> TracerProvider:
    """Build a ``TracerProvider`` with a batched OTLP span exporter."""
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=resource, sampler=_build_sampler())
    # BatchSpanProcessor exports on its own background thread and is fire-and-forget:
    # export failures are logged and dropped by the SDK and never reach a request.
    provider.add_span_processor(BatchSpanProcessor(build_span_exporter()))
    return provider


def _build_meter_provider(resource: Resource) -> MeterProvider:
    """Build a ``MeterProvider`` with a periodic OTLP metric reader."""
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

    endpoint = settings.OTEL_EXPORTER_OTLP_ENDPOINT
    headers = _parse_headers(settings.OTEL_EXPORTER_OTLP_HEADERS)
    exporter: Any
    if _is_http_protocol():
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter as HTTPMetricExporter,
        )

        exporter = HTTPMetricExporter(endpoint=endpoint, headers=headers)
    else:
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
            OTLPMetricExporter as GRPCMetricExporter,
        )

        exporter = GRPCMetricExporter(endpoint=endpoint, headers=headers)

    reader = PeriodicExportingMetricReader(exporter)
    return MeterProvider(resource=resource, metric_readers=[reader])


def reset_for_testing() -> None:
    """Reset module state so a test can re-run :func:`bootstrap` under new settings.

    Intended for the test suite only — production bootstraps exactly once. Does
    not tear down any globally-installed OTel provider (the OTel API forbids
    replacing a set provider), so tests that need a clean global provider should
    run in a subprocess or assert on the returned context rather than the global.

    Also reverses any Phase 1 auto-instrumentation (#709) and clears the Phase 2
    metrics-registration guard (#710) so a subsequent ``instrument()`` /
    ``install_metrics()`` starts from a clean state. Both are imported lazily to
    avoid the import cycle (they depend on this module).
    """
    global _context, _bootstrapped
    _hooks.clear()
    _context = None
    _bootstrapped = False
    from . import instrumentation, metrics

    instrumentation.reset_for_testing()
    metrics.reset_for_testing()
