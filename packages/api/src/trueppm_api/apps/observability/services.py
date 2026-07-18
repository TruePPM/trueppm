"""Service layer for the retention policy editor + purge runs (ADR-0173).

Read/write helpers behind the ``/health/retention/*`` endpoints, plus the
durable dispatch of a manual/dry-run purge. Dispatch follows the house pattern:
create the ``PurgeRun`` row, then fire the coordinator in ``transaction.on_commit``
so the worker only adopts a row that has committed (ADR-0173 §Durable Execution).
"""

from __future__ import annotations

import logging
import socket
import time
from typing import Any
from urllib.parse import urlsplit

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.observability.models import (
    PurgeRun,
    RetentionPolicy,
    RetentionSchedule,
)
from trueppm_api.apps.observability.purge_registry import (
    estimate_table_stats,
    get_purge_specs,
    spec_purge_for,
)
from trueppm_api.apps.observability.retention import (
    RETENTION_SPECS,
    spec_for,
)

logger = logging.getLogger(__name__)


def _resolve_for_display(key: str, policies: dict[str, RetentionPolicy]) -> tuple[int, bool]:
    """Return ``(value, enabled)`` to show in the editor for ``key``.

    An override row wins. Otherwise the ADR-0081 setting: a numeric value is
    shown enabled; a ``None`` (disabled) setting shows the spec default as the
    value with ``enabled=False`` so the input always has a sensible number to edit.
    Non-disablable windows (sync batches) are always enabled.
    """
    spec = spec_for(key)
    row = policies.get(key)
    if row is not None:
        value, enabled = row.value, row.enabled
    else:
        setting_value = getattr(settings, key, spec["default"])
        if setting_value is None:
            value, enabled = spec["default"], False
        else:
            value, enabled = setting_value, True
    if not spec["disablable"]:
        enabled = True
    return value, enabled


def get_retention_state() -> dict[str, Any]:
    """Build the full editor payload: policies, schedule, and the recent run log."""
    policies = {row.key: row for row in RetentionPolicy.objects.all()}
    db_tables_by_key = {spec.key: spec.db_tables for spec in get_purge_specs()}

    policy_rows: list[dict[str, Any]] = []
    for spec in RETENTION_SPECS:
        key = spec["key"]
        value, enabled = _resolve_for_display(key, policies)
        est_rows, est_bytes = estimate_table_stats(db_tables_by_key.get(key, ()))
        policy_rows.append(
            {
                "key": key,
                "label": spec["label"],
                "note": spec["note"],
                "unit": spec["unit"],
                "value": value,
                "enabled": enabled,
                "row_count": est_rows,
                "bytes": est_bytes,
            }
        )

    schedule, _ = RetentionSchedule.objects.get_or_create(singleton_key=1)
    runs = list(PurgeRun.objects.order_by("-started_at")[:7])

    return {"policies": policy_rows, "schedule": schedule, "runs": runs}


@transaction.atomic
def apply_retention_update(data: dict[str, Any]) -> None:
    """Persist policy overrides and/or schedule changes from the save-bar PATCH.

    Sync batches can't be disabled, so ``enabled`` is forced True for that key
    regardless of what the client sends (defensive — the UI already hides the toggle).
    """
    for item in data.get("policies", []):
        key = item["key"]
        enabled = True if not spec_for(key)["disablable"] else item["enabled"]
        RetentionPolicy.objects.update_or_create(
            key=key,
            defaults={"value": item["value"], "enabled": enabled},
        )

    schedule_data = data.get("schedule")
    if schedule_data:
        RetentionSchedule.objects.update_or_create(singleton_key=1, defaults=schedule_data)


def compute_impact(key: str, value: int) -> tuple[int, int | None]:
    """Rows (and best-effort bytes) that *would* become purge-eligible at ``value``.

    Backs the dirty-state "lowering this is irreversible" warning. A pure count —
    no rows are deleted (``dry_run=True`` with the proposed window as override).
    """
    from trueppm_api.apps.observability.purge_registry import estimate_freed_bytes

    spec = spec_purge_for(key)
    rows = spec.purge(dry_run=True, override_value=value)
    return rows, estimate_freed_bytes(spec.db_tables, rows)


def start_purge_run(*, dry_run: bool, trigger: str = PurgeRun.Trigger.MANUAL) -> PurgeRun:
    """Create a PurgeRun and dispatch the coordinator on commit (best-effort).

    Returns immediately with the ``running`` row so the API can hand back a
    ``run_id``; the worker fills in the result. If the broker is unreachable when
    the on-commit dispatch fires, the run is marked ``failed`` so the UI's polling
    log reflects it rather than hanging on ``running`` forever.
    """
    run = PurgeRun.objects.create(
        trigger=PurgeRun.Trigger.DRY_RUN if dry_run else trigger,
        state=PurgeRun.State.RUNNING,
    )

    def _dispatch() -> None:
        from trueppm_api.apps.observability.tasks import run_retention_purge

        try:
            run_retention_purge.delay(run_id=str(run.id), dry_run=dry_run)
        except Exception:
            logger.exception("start_purge_run: dispatch failed for PurgeRun %s", run.id)
            PurgeRun.objects.filter(id=run.id, state=PurgeRun.State.RUNNING).update(
                state=PurgeRun.State.FAILED,
                finished_at=timezone.now(),
                error="dispatch failed: task broker unavailable",
            )

    transaction.on_commit(_dispatch)
    return run


# ---------------------------------------------------------------------------
# Telemetry test-export probe (#2110, ADR-0223 follow-up)
#
# The System Health "Telemetry" card lets an admin verify the OTLP export path
# from inside the app. Two modes, three terminal outcomes:
#   - export enabled  -> emit one synthetic canary span through a one-off exporter
#                        built from the SAME settings, report the collector's ACK.
#   - endpoint set but TRUEPPM_OTEL_ENABLED=false -> bounded TCP reachability probe
#                        only (export was deliberately disabled; do not force a span).
#
# SECURITY (load-bearing): every failure `detail` is a CANNED, author-controlled
# sentence keyed on the exception *type* — never str(exc) — so a gRPC/transport
# error that embeds the collector target can never leak OTEL_EXPORTER_OTLP_HEADERS
# (the bearer token). SSRF is closed by construction: the target is read only from
# settings — the same host the app already exports to on every request — so the
# caller chooses nothing and no new egress surface is opened.
# ---------------------------------------------------------------------------

_CANARY_SPAN_NAME = "trueppm.telemetry.canary"


def run_telemetry_test_export() -> dict[str, Any]:
    """Probe the configured OTLP export path once and return an honest outcome.

    When export is enabled (endpoint set AND master switch on), emit a single
    synthetic canary span through a one-off exporter and report whether the
    collector accepted it. When an endpoint is set but export is switched off, do a
    bounded TCP reachability probe instead of forcing a span. Always returns a dict
    (the view always responds 200); the outcome lives in the body.
    """
    from trueppm_api.apps.observability.otel import provider

    endpoint = str(settings.OTEL_EXPORTER_OTLP_ENDPOINT or "").strip()
    protocol = str(settings.OTEL_EXPORTER_OTLP_PROTOCOL)
    checked_at = timezone.now()

    if provider.is_enabled():
        return _canary_export(endpoint, protocol, checked_at)
    return _tcp_probe(endpoint, protocol, checked_at)


def _telemetry_result(
    mode: str,
    outcome: str,
    endpoint: str,
    protocol: str,
    duration_ms: int,
    detail: str,
    checked_at: Any,
) -> dict[str, Any]:
    """Assemble the test-export result dict (no token/headers ever included)."""
    return {
        "mode": mode,
        "outcome": outcome,
        "endpoint": endpoint,
        "protocol": protocol,
        "duration_ms": duration_ms,
        "detail": detail,
        "checked_at": checked_at,
    }


def _elapsed_ms(start: float) -> int:
    """Milliseconds elapsed since a ``time.monotonic()`` reading."""
    return int((time.monotonic() - start) * 1000)


def _canary_export(endpoint: str, protocol: str, checked_at: Any) -> dict[str, Any]:
    """Export one canary span synchronously and map the SDK result to an outcome.

    Builds a one-off exporter + a throwaway ``TracerProvider`` (bypassing the
    fire-and-forget batch pipeline so the SUCCESS/FAILURE result is observable),
    and always tears both down in ``finally`` so no gRPC channel/thread lingers.
    The canary is named ``trueppm.telemetry.canary`` with ``trueppm.telemetry.test``
    so operators can filter it out of real traces.
    """
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SpanExportResult
    from opentelemetry.sdk.trace.sampling import ALWAYS_ON

    from trueppm_api.apps.observability.otel import provider

    timeout = float(settings.TELEMETRY_TEST_EXPORT_TIMEOUT_SECONDS)
    exporter = None
    tracer_provider = None
    start = time.monotonic()
    try:
        exporter = provider.build_span_exporter(timeout=timeout)
        tracer_provider = TracerProvider(resource=provider.build_resource(), sampler=ALWAYS_ON)
        tracer = tracer_provider.get_tracer("trueppm.telemetry.test")
        span = tracer.start_span(_CANARY_SPAN_NAME, attributes={"trueppm.telemetry.test": True})
        span.end()
        result = exporter.export([span])
        duration_ms = _elapsed_ms(start)
        if result == SpanExportResult.SUCCESS:
            return _telemetry_result(
                "export",
                "success",
                endpoint,
                protocol,
                duration_ms,
                "Canary span accepted by the collector — the export path is working end to end.",
                checked_at,
            )
        return _telemetry_result(
            "export",
            "failure",
            endpoint,
            protocol,
            duration_ms,
            "The collector did not accept the canary span. Check that the collector is "
            "running and the endpoint host and port are correct.",
            checked_at,
        )
    except Exception:
        # Never surface str(exc): a transport error can embed the target/headers.
        logger.warning("Telemetry test export failed", exc_info=True)
        return _telemetry_result(
            "export",
            "failure",
            endpoint,
            protocol,
            _elapsed_ms(start),
            "Export failed before the span could be sent. Verify OTEL_EXPORTER_OTLP_ENDPOINT "
            "and OTEL_EXPORTER_OTLP_PROTOCOL.",
            checked_at,
        )
    finally:
        if exporter is not None:
            try:
                exporter.shutdown()
            except Exception:
                logger.debug("canary exporter shutdown failed", exc_info=True)
        if tracer_provider is not None:
            try:
                tracer_provider.shutdown()
            except Exception:
                logger.debug("canary tracer provider shutdown failed", exc_info=True)


def _tcp_probe(endpoint: str, protocol: str, checked_at: Any) -> dict[str, Any]:
    """TCP-connect to the collector host:port and map the socket result to an outcome."""
    if not endpoint:
        return _telemetry_result(
            "probe",
            "failure",
            "",
            protocol,
            0,
            "No collector endpoint is configured. Set OTEL_EXPORTER_OTLP_ENDPOINT "
            "to enable export.",
            checked_at,
        )
    host, port = _parse_host_port(endpoint, protocol)
    timeout = float(settings.TELEMETRY_TEST_EXPORT_TIMEOUT_SECONDS)
    start = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
        return _telemetry_result(
            "probe",
            "reachable",
            endpoint,
            protocol,
            _elapsed_ms(start),
            "Collector endpoint is reachable. Export is currently switched off "
            "(TRUEPPM_OTEL_ENABLED=false); set it to true to start sending.",
            checked_at,
        )
    except TimeoutError:
        return _telemetry_result(
            "probe",
            "failure",
            endpoint,
            protocol,
            _elapsed_ms(start),
            "Connection timed out — the collector did not respond. Check the host, port, "
            "and any NetworkPolicy that could block egress.",
            checked_at,
        )
    except socket.gaierror:
        return _telemetry_result(
            "probe",
            "failure",
            endpoint,
            protocol,
            _elapsed_ms(start),
            "The endpoint host could not be resolved. Check OTEL_EXPORTER_OTLP_ENDPOINT.",
            checked_at,
        )
    except ConnectionRefusedError:
        return _telemetry_result(
            "probe",
            "failure",
            endpoint,
            protocol,
            _elapsed_ms(start),
            "Connection refused — nothing is listening on that host and port.",
            checked_at,
        )
    except OSError:
        return _telemetry_result(
            "probe",
            "failure",
            endpoint,
            protocol,
            _elapsed_ms(start),
            "Could not reach the collector endpoint. Check the host, port, and network path.",
            checked_at,
        )


def _parse_host_port(endpoint: str, protocol: str) -> tuple[str, int]:
    """Split an OTLP endpoint into (host, port), defensively.

    Handles a URL form (``http://host:4318``) and the scheme-less gRPC form
    (``host:4317`` or bare ``host``). The default port follows the protocol:
    4318 for HTTP/protobuf, 4317 for gRPC. A malformed endpoint (an out-of-range
    port like ``:99999``) must never raise here — it runs before ``_tcp_probe``'s
    try-block, so an exception would surface as a 500 instead of the clean canned
    "failure" card. Any parse problem falls back to the protocol default port so
    the probe simply reports the endpoint as unreachable.
    """
    ep = endpoint.strip()
    default_port = 4318 if str(protocol).lower().startswith("http") else 4317
    try:
        if "://" in ep:
            parsed = urlsplit(ep)
            host = parsed.hostname or ""
            port = parsed.port or default_port
        elif ep.count(":") == 1:
            host, _, raw_port = ep.partition(":")
            port = int(raw_port) if raw_port.isdigit() else default_port
        else:
            host, port = ep, default_port
    except ValueError:
        # urlsplit(...).port raises on an out-of-range port; give up on parsing
        # the port and let the connect attempt fail cleanly.
        return ep, default_port
    if not 0 <= port <= 65535:
        port = default_port
    return host, port
