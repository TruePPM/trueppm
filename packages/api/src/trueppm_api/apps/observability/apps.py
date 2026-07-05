"""App config for observability (Beat liveness ADR-0081; OTel foundation ADR-0223)."""

from django.apps import AppConfig


class ObservabilityConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "trueppm_api.apps.observability"

    def ready(self) -> None:
        # Install the OpenTelemetry providers at startup (ADR-0223, #708). This is
        # a strict no-op unless an OTLP endpoint is configured, so a default
        # deployment pays no cost. bootstrap() is idempotent, so the double-import
        # under the test runner / autoreloader cannot build two export pipelines.
        # The enterprise edition registers its own span processors/exporters via
        # otel.register_provider_hook() from its own ready() — order-independent.
        from trueppm_api.apps.observability import otel

        otel.bootstrap()
