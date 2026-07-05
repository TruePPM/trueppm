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
