"""Tests for the OpenTelemetry foundation (ADR-0223, #708).

Backend-only infra: no API endpoint and no UI, so only the pytest layer applies.

The OTel API allows a global provider to be set only once per process, so these
tests patch ``set_tracer_provider`` / ``set_meter_provider`` to keep bootstrap
hermetic and assert on the **returned** :class:`OTelBootstrapContext` rather than
the process-global provider. The autouse fixture resets the module's registry and
one-shot bootstrap guard between tests.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator

import pytest
from django.test import override_settings

from trueppm_api.apps.observability import otel
from trueppm_api.apps.observability.otel import attributes, provider

# A syntactically valid OTLP target. gRPC connects lazily, so constructing the
# exporter against this never blocks or requires a live collector.
_ENDPOINT = "http://otel-collector.test:4317"


@pytest.fixture(autouse=True)
def _reset_otel() -> Iterator[None]:
    """Reset the module's global registry + bootstrap guard around each test."""
    provider.reset_for_testing()
    yield
    provider.reset_for_testing()


@pytest.fixture
def no_global_install(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[object]]:
    """Intercept the global provider setters so bootstrap does not mutate the
    process-wide OTel provider (which is settable only once)."""
    calls: dict[str, list[object]] = {"tracer": [], "meter": []}
    monkeypatch.setattr(
        provider.otel_trace, "set_tracer_provider", lambda p: calls["tracer"].append(p)
    )
    monkeypatch.setattr(
        provider.otel_metrics, "set_meter_provider", lambda p: calls["meter"].append(p)
    )
    return calls


class TestNoOpWhenUnconfigured:
    """With no OTLP endpoint the provider is a strict no-op."""

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="")
    def test_bootstrap_returns_disabled_context(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        ctx = otel.bootstrap()
        assert ctx.enabled is False
        assert ctx.tracer_provider is None
        assert ctx.meter_provider is None
        assert ctx.resource is None

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="")
    def test_bootstrap_installs_no_sdk_provider(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        """The strict no-op must not touch the global OTel provider at all."""
        otel.bootstrap()
        assert no_global_install["tracer"] == []
        assert no_global_install["meter"] == []

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="")
    def test_is_enabled_false(self) -> None:
        assert otel.is_enabled() is False

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="")
    def test_get_tracer_still_returns_a_tracer(self) -> None:
        """Accessors must work in the no-op state (return non-recording tracers)."""
        tracer = otel.get_tracer(__name__)
        assert tracer is not None
        # Starting a span on a no-op tracer must not raise.
        with tracer.start_as_current_span("noop-span"):
            pass


class TestEnabledWhenEndpointSet:
    """With an endpoint configured the SDK providers are built and installed."""

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT)
    def test_bootstrap_returns_enabled_context_with_providers(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        ctx = otel.bootstrap()
        assert ctx.enabled is True
        assert ctx.tracer_provider is not None
        assert ctx.meter_provider is not None
        assert ctx.resource is not None

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT)
    def test_bootstrap_installs_global_providers(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        ctx = otel.bootstrap()
        assert no_global_install["tracer"] == [ctx.tracer_provider]
        assert no_global_install["meter"] == [ctx.meter_provider]

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT,
        OTEL_SERVICE_NAME="trueppm-api",
        TRUEPPM_EDITION="community",
    )
    def test_resource_attributes(self, no_global_install: dict[str, list[object]]) -> None:
        ctx = otel.bootstrap()
        assert ctx.resource is not None
        attrs = dict(ctx.resource.attributes)
        assert attrs[attributes.RESOURCE_SERVICE_NAME] == "trueppm-api"
        assert attrs[attributes.RESOURCE_SERVICE_NAMESPACE] == attributes.NAMESPACE
        assert attrs[attributes.RESOURCE_EDITION] == "community"
        # service.version is best-effort but must always be present and non-empty.
        assert attrs[attributes.RESOURCE_SERVICE_VERSION]

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT, TRUEPPM_EDITION="enterprise")
    def test_edition_flows_into_resource_and_context(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        ctx = otel.bootstrap()
        assert ctx.edition == "enterprise"
        assert dict(ctx.resource.attributes)[attributes.RESOURCE_EDITION] == "enterprise"

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT)
    def test_is_enabled_true(self) -> None:
        assert otel.is_enabled() is True

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT,
        OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
    )
    def test_http_protocol_builds_providers(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        """The http/protobuf transport is a supported alternative to gRPC."""
        ctx = otel.bootstrap()
        assert ctx.enabled is True
        assert ctx.tracer_provider is not None


class TestSwitches:
    """Master kill switch and per-signal toggles."""

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT, TRUEPPM_OTEL_ENABLED=False)
    def test_master_switch_off_forces_noop(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        ctx = otel.bootstrap()
        assert ctx.enabled is False
        assert no_global_install["tracer"] == []

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT, TRUEPPM_OTEL_METRICS_ENABLED=False)
    def test_metrics_toggle_off_leaves_traces_on(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        ctx = otel.bootstrap()
        assert ctx.enabled is True
        assert ctx.tracer_provider is not None
        assert ctx.meter_provider is None

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT, TRUEPPM_OTEL_TRACES_ENABLED=False)
    def test_traces_toggle_off_leaves_metrics_on(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        ctx = otel.bootstrap()
        assert ctx.enabled is True
        assert ctx.tracer_provider is None
        assert ctx.meter_provider is not None


class TestIdempotency:
    """bootstrap() must be safe to call twice (test runner / autoreloader)."""

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT)
    def test_second_bootstrap_returns_same_context(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        first = otel.bootstrap()
        second = otel.bootstrap()
        assert first is second
        # The global provider was installed exactly once, not twice.
        assert len(no_global_install["tracer"]) == 1


class TestProviderHook:
    """The enterprise extension point is order-independent and failure-isolated."""

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT)
    def test_hook_registered_before_bootstrap_is_invoked_during_bootstrap(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        received: list[otel.OTelBootstrapContext] = []
        otel.register_provider_hook(received.append)
        assert received == []  # not yet fired
        ctx = otel.bootstrap()
        assert received == [ctx]

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT)
    def test_hook_registered_after_bootstrap_is_invoked_immediately(
        self, no_global_install: dict[str, list[object]]
    ) -> None:
        ctx = otel.bootstrap()
        received: list[otel.OTelBootstrapContext] = []
        otel.register_provider_hook(received.append)
        assert received == [ctx]  # fired immediately against the stored context

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="")
    def test_hook_fires_even_when_disabled(self) -> None:
        received: list[otel.OTelBootstrapContext] = []
        otel.register_provider_hook(received.append)
        otel.bootstrap()
        assert len(received) == 1
        assert received[0].enabled is False

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="")
    def test_hook_receives_versioned_frozen_context(self) -> None:
        received: list[otel.OTelBootstrapContext] = []
        otel.register_provider_hook(received.append)
        otel.bootstrap()
        ctx = received[0]
        assert ctx.schema_version >= 1
        # The context is a frozen dataclass — mutation must raise.
        with pytest.raises(dataclasses.FrozenInstanceError):
            ctx.enabled = True  # type: ignore[misc]

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT="")
    def test_raising_hook_does_not_crash_bootstrap(self) -> None:
        good: list[otel.OTelBootstrapContext] = []

        def boom(_ctx: otel.OTelBootstrapContext) -> None:
            raise RuntimeError("enterprise hook exploded")

        otel.register_provider_hook(boom)
        otel.register_provider_hook(good.append)
        # A broken hook must not propagate out of bootstrap.
        ctx = otel.bootstrap()
        assert ctx.enabled is False
        # The following good hook still ran.
        assert good == [ctx]


class TestAttributeConvention:
    """The trueppm.* naming convention is a stable, importable contract."""

    def test_namespace_and_resource_keys(self) -> None:
        assert attributes.NAMESPACE == "trueppm"
        assert attributes.RESOURCE_EDITION == "trueppm.edition"
        assert attributes.RESOURCE_SERVICE_NAME == "service.name"

    def test_span_keys_are_under_the_namespace(self) -> None:
        span_keys = [
            attributes.PROJECT_ID,
            attributes.PROJECT_KEY,
            attributes.PROGRAM_ID,
            attributes.TASK_ID,
            attributes.BOARD_ID,
            attributes.USER_ID,
            attributes.USER_ROLE,
            attributes.SCHEDULE_RECOMPUTE_REASON,
            attributes.REQUEST_EDITION,
        ]
        for key in span_keys:
            assert key.startswith("trueppm.")

    def test_all_exported_names_resolve(self) -> None:
        for name in attributes.__all__:
            assert hasattr(attributes, name)


class TestHeaderParsing:
    """OTLP header config parsing (key=value,key2=value2)."""

    def test_empty_returns_none(self) -> None:
        assert provider._parse_headers("") is None
        assert provider._parse_headers("   ") is None

    def test_single_pair(self) -> None:
        assert provider._parse_headers("authorization=Bearer abc") == {
            "authorization": "Bearer abc"
        }

    def test_multiple_pairs(self) -> None:
        assert provider._parse_headers("a=1,b=2") == {"a": "1", "b": "2"}

    def test_malformed_pairs_are_skipped(self) -> None:
        assert provider._parse_headers("a=1,garbage,b=2") == {"a": "1", "b": "2"}


class TestResolvedExporterEndpoint:
    """The endpoint each exporter actually POSTs to (#2873).

    These assert on the **constructed exporter's resolved** ``_endpoint``, not on
    the kwargs the builder assembles, and they construct the real upstream
    exporters — nothing here is mocked and no collector is needed (both transports
    connect lazily). That distinction is the whole point: the prior HTTP test
    asserted only that a provider object came back, so it passed while every
    ``http/protobuf`` export POSTed to the collector root and 404'd forever.
    """

    _HTTP_BASE = "http://otel-collector.test:4318"

    @staticmethod
    def _resolved(exporter: object) -> str:
        """Read the exporter's resolved target, always shutting the exporter down."""
        try:
            return str(exporter._endpoint)  # type: ignore[attr-defined]
        finally:
            exporter.shutdown()  # type: ignore[attr-defined]

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT=_HTTP_BASE,
        OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
    )
    def test_http_span_exporter_targets_the_traces_signal_path(self) -> None:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        exporter = provider.build_span_exporter()
        assert isinstance(exporter, OTLPSpanExporter)
        assert self._resolved(exporter) == f"{self._HTTP_BASE}/v1/traces"

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT=_HTTP_BASE,
        OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
    )
    def test_http_metric_exporter_targets_the_metrics_signal_path(self) -> None:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

        exporter = provider.build_metric_exporter()
        assert isinstance(exporter, OTLPMetricExporter)
        assert self._resolved(exporter) == f"{self._HTTP_BASE}/v1/metrics"

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT=f"{_HTTP_BASE}/v1/traces",
        OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
    )
    def test_http_span_endpoint_already_carrying_the_path_is_not_doubled(self) -> None:
        """An operator may configure the full signal URL; do not append twice."""
        assert self._resolved(provider.build_span_exporter()) == f"{self._HTTP_BASE}/v1/traces"

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT=f"{_HTTP_BASE}/v1/metrics",
        OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
    )
    def test_http_metric_endpoint_already_carrying_the_path_is_not_doubled(self) -> None:
        assert self._resolved(provider.build_metric_exporter()) == f"{self._HTTP_BASE}/v1/metrics"

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT=f"{_HTTP_BASE}/",
        OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
    )
    def test_http_trailing_slash_does_not_produce_a_double_slash(self) -> None:
        assert self._resolved(provider.build_span_exporter()) == f"{self._HTTP_BASE}/v1/traces"

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL="grpc")
    def test_grpc_span_exporter_gets_no_signal_path(self) -> None:
        """gRPC carries the signal in the RPC method — a path would break it."""
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

        exporter = provider.build_span_exporter()
        assert isinstance(exporter, OTLPSpanExporter)
        resolved = self._resolved(exporter)
        assert "/v1/" not in resolved
        assert resolved.endswith(":4317")

    @override_settings(OTEL_EXPORTER_OTLP_ENDPOINT=_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL="grpc")
    def test_grpc_metric_exporter_gets_no_signal_path(self) -> None:
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

        exporter = provider.build_metric_exporter()
        assert isinstance(exporter, OTLPMetricExporter)
        resolved = self._resolved(exporter)
        assert "/v1/" not in resolved
        assert resolved.endswith(":4317")

    @override_settings(
        OTEL_EXPORTER_OTLP_ENDPOINT=_HTTP_BASE,
        OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
    )
    def test_timeout_is_still_honored_on_the_http_path(self) -> None:
        """The canary probe's short timeout must survive the endpoint rewrite."""
        exporter = provider.build_span_exporter(timeout=3)
        assert exporter._timeout == 3
        assert self._resolved(exporter) == f"{self._HTTP_BASE}/v1/traces"


class TestSignalPathHelper:
    """Direct unit coverage of the endpoint→signal-path rewrite (#2873)."""

    @pytest.mark.parametrize(
        ("configured", "expected"),
        [
            ("http://c:4318", "http://c:4318/v1/traces"),
            ("http://c:4318/", "http://c:4318/v1/traces"),
            ("  http://c:4318  ", "http://c:4318/v1/traces"),
            ("http://c:4318/v1/traces", "http://c:4318/v1/traces"),
            ("http://c:4318/v1/traces/", "http://c:4318/v1/traces"),
            # A collector behind a path prefix keeps the prefix.
            ("https://c/otlp", "https://c/otlp/v1/traces"),
            ("https://c/otlp/v1/traces", "https://c/otlp/v1/traces"),
        ],
    )
    def test_traces_path(self, configured: str, expected: str) -> None:
        assert provider._http_signal_endpoint(configured, provider.HTTP_TRACES_PATH) == expected

    @pytest.mark.parametrize(
        ("configured", "expected"),
        [
            ("http://c:4318", "http://c:4318/v1/metrics"),
            ("http://c:4318/v1/metrics", "http://c:4318/v1/metrics"),
            # A pasted traces URL is normalized back to the base, so metrics still
            # reach a real signal path instead of /v1/traces/v1/metrics.
            ("http://c:4318/v1/traces", "http://c:4318/v1/metrics"),
            ("https://c/otlp/v1/traces", "https://c/otlp/v1/metrics"),
        ],
    )
    def test_metrics_path(self, configured: str, expected: str) -> None:
        assert provider._http_signal_endpoint(configured, provider.HTTP_METRICS_PATH) == expected


class TestSamplerSelection:
    """OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG → Sampler (#1903)."""

    def test_default_is_parent_based_always_on(self) -> None:
        """No env override must preserve the prior hard-coded behavior."""
        from opentelemetry.sdk.trace.sampling import (
            ALWAYS_ON,
            ParentBased,
        )

        # settings.base defaults OTEL_TRACES_SAMPLER to "parentbased_always_on".
        sampler = provider._build_sampler()
        assert isinstance(sampler, ParentBased)
        assert sampler._root is ALWAYS_ON

    @override_settings(OTEL_TRACES_SAMPLER="always_on")
    def test_always_on(self) -> None:
        from opentelemetry.sdk.trace.sampling import ALWAYS_ON, StaticSampler

        sampler = provider._build_sampler()
        assert isinstance(sampler, StaticSampler)
        assert sampler is ALWAYS_ON

    @override_settings(OTEL_TRACES_SAMPLER="always_off")
    def test_always_off(self) -> None:
        from opentelemetry.sdk.trace.sampling import ALWAYS_OFF, StaticSampler

        sampler = provider._build_sampler()
        assert isinstance(sampler, StaticSampler)
        assert sampler is ALWAYS_OFF

    @override_settings(OTEL_TRACES_SAMPLER="traceidratio", OTEL_TRACES_SAMPLER_ARG="0.25")
    def test_traceidratio_parses_arg(self) -> None:
        from opentelemetry.sdk.trace.sampling import TraceIdRatioBased

        sampler = provider._build_sampler()
        assert isinstance(sampler, TraceIdRatioBased)
        assert sampler.rate == pytest.approx(0.25)

    @override_settings(
        OTEL_TRACES_SAMPLER="parentbased_traceidratio",
        OTEL_TRACES_SAMPLER_ARG="0.1",
    )
    def test_parentbased_traceidratio_parses_arg(self) -> None:
        from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

        sampler = provider._build_sampler()
        assert isinstance(sampler, ParentBased)
        assert isinstance(sampler._root, TraceIdRatioBased)
        assert sampler._root.rate == pytest.approx(0.1)

    @override_settings(OTEL_TRACES_SAMPLER="parentbased_always_off")
    def test_parentbased_always_off(self) -> None:
        from opentelemetry.sdk.trace.sampling import ALWAYS_OFF, ParentBased

        sampler = provider._build_sampler()
        assert isinstance(sampler, ParentBased)
        assert sampler._root is ALWAYS_OFF

    @override_settings(OTEL_TRACES_SAMPLER="not_a_real_sampler")
    def test_unrecognized_falls_back_to_parent_based_always_on(self) -> None:
        from opentelemetry.sdk.trace.sampling import ALWAYS_ON, ParentBased

        sampler = provider._build_sampler()
        assert isinstance(sampler, ParentBased)
        assert sampler._root is ALWAYS_ON

    @override_settings(OTEL_TRACES_SAMPLER="traceidratio", OTEL_TRACES_SAMPLER_ARG="oops")
    def test_unparseable_arg_defaults_to_full_rate(self) -> None:
        from opentelemetry.sdk.trace.sampling import TraceIdRatioBased

        sampler = provider._build_sampler()
        assert isinstance(sampler, TraceIdRatioBased)
        assert sampler.rate == pytest.approx(1.0)
