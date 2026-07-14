"""Structured JSON logging + OTel trace correlation (#1899).

Covers the three guarantees the issue asks for: the JSON formatter emits valid
JSON carrying trace_id/span_id/request_id when a span is active, it degrades
gracefully (null ids, still valid JSON) when none is, and DJANGO_LOG_LEVEL flows
through into the built config. The RequestIDMiddleware id lifecycle (mint, adopt,
sanitize, echo, reset) is exercised too, since it is the request_id source.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from trueppm_api.apps.observability.logging import (
    RequestIDMiddleware,
    TraceContextFilter,
    build_logging_config,
    get_request_id,
    reset_request_id,
    set_request_id,
)


@pytest.fixture
def json_formatter() -> logging.Formatter:
    """The prod JSON formatter, resolved through the built dictConfig spec."""

    from pythonjsonlogger.jsonlogger import JsonFormatter

    spec = build_logging_config(level="INFO", json_output=True)["formatters"]["json"]
    return JsonFormatter(spec["format"], rename_fields=spec["rename_fields"])


def _make_record(msg: str = "hello") -> logging.LogRecord:
    return logging.LogRecord(
        name="trueppm.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=(),
        exc_info=None,
    )


@pytest.fixture
def sdk_tracer() -> trace.Tracer:
    """A real SDK tracer so started spans have a *valid* (recordable) context.

    The default OTel API provider is a strict no-op whose spans have an invalid
    context — exactly the "no active span" branch we test separately — so a real
    ``TracerProvider`` is needed to exercise the id-injection path. ``start_as_
    current_span`` attaches the span to the OTel context directly, so
    ``trace.get_current_span()`` sees it without touching the global provider.
    """

    provider = TracerProvider()
    return provider.get_tracer("test")


class TestTraceContextFilter:
    def test_injects_hex_ids_when_span_active(self, sdk_tracer: trace.Tracer) -> None:
        filt = TraceContextFilter()
        record = _make_record()
        with sdk_tracer.start_as_current_span("unit"):
            span_context = trace.get_current_span().get_span_context()
            assert filt.filter(record) is True
            # 32-hex trace id, 16-hex span id, matching the exported span exactly.
            assert record.trace_id == trace.format_trace_id(span_context.trace_id)
            assert record.span_id == trace.format_span_id(span_context.span_id)
            assert len(record.trace_id) == 32
            assert len(record.span_id) == 16
            int(record.trace_id, 16)  # valid hex
            int(record.span_id, 16)

    def test_null_ids_when_no_span(self) -> None:
        filt = TraceContextFilter()
        record = _make_record()
        # No active recording span → graceful degradation, not a KeyError.
        assert filt.filter(record) is True
        assert record.trace_id is None
        assert record.span_id is None

    def test_reads_request_id_from_contextvar(self) -> None:
        filt = TraceContextFilter()
        record = _make_record()
        token = set_request_id("req-abc")
        try:
            filt.filter(record)
            assert record.request_id == "req-abc"
        finally:
            reset_request_id(token)


class TestJsonFormatter:
    def test_emits_valid_json_with_ids_when_span_active(
        self, json_formatter: logging.Formatter, sdk_tracer: trace.Tracer
    ) -> None:
        filt = TraceContextFilter()
        record = _make_record("boom")
        with sdk_tracer.start_as_current_span("unit"):
            filt.filter(record)
            payload = json.loads(json_formatter.format(record))  # must parse
        assert payload["message"] == "boom"
        assert payload["level"] == "INFO"  # renamed from levelname
        assert "timestamp" in payload  # renamed from asctime
        assert len(payload["trace_id"]) == 32
        assert len(payload["span_id"]) == 16

    def test_emits_valid_json_with_null_ids_when_no_span(
        self, json_formatter: logging.Formatter
    ) -> None:
        filt = TraceContextFilter()
        record = _make_record()
        filt.filter(record)
        payload = json.loads(json_formatter.format(record))
        # Keys present but null — a query can filter on them unconditionally.
        assert payload["trace_id"] is None
        assert payload["span_id"] is None
        assert payload["request_id"] is None


class TestBuildLoggingConfig:
    def test_honors_level(self) -> None:
        config = build_logging_config(level="DEBUG", json_output=True)
        assert config["root"]["level"] == "DEBUG"
        assert config["loggers"]["django"]["level"] == "DEBUG"
        assert config["loggers"]["trueppm"]["level"] == "DEBUG"

    def test_json_output_selects_json_handler(self) -> None:
        config = build_logging_config(level="INFO", json_output=True)
        assert config["root"]["handlers"] == ["json"]
        assert config["formatters"]["json"]["()"].endswith("JsonFormatter")

    def test_console_output_selects_console_handler(self) -> None:
        config = build_logging_config(level="INFO", json_output=False)
        assert config["root"]["handlers"] == ["console"]

    def test_referenced_factories_resolve(self) -> None:
        # The dictConfig ``()`` factory strings must import — catches a bad path or
        # a renamed class before it fails at settings-load time. Resolved directly
        # (not via a global dictConfig apply) so the test does not reconfigure the
        # process-wide logging state and leak handlers into other tests.
        import logging.config

        config = build_logging_config(level="INFO", json_output=True)
        resolver = logging.config.BaseConfigurator({})
        filter_factory = resolver.resolve(config["filters"]["trace_context"]["()"])
        assert filter_factory is TraceContextFilter
        formatter_factory = resolver.resolve(config["formatters"]["json"]["()"])
        assert formatter_factory.__name__ == "JsonFormatter"


class TestUtcTimestamps:
    """Log timestamps must render in UTC regardless of container-local TZ (#1952).

    settings pin TIME_ZONE="UTC"/USE_TZ=True, so the ORM and timezone.now() are
    UTC; build_logging_config forces logging.Formatter.converter to time.gmtime so
    log timestamps do not drift by the host offset on a non-UTC node.
    """

    # A fixed instant so the expected UTC render is deterministic: the epoch below
    # is 2023-11-14 22:13:20 UTC.
    _EPOCH = 1_700_000_000.0

    @pytest.fixture
    def non_utc_tz(self) -> Iterator[None]:
        """Pin the process TZ to a non-UTC zone for the body of the test.

        time.tzset() (POSIX-only; CI and local dev are both Unix) makes the C
        library honor the changed TZ, so time.localtime reflects the offset — the
        exact host condition (a non-UTC clock) that surfaced the bug. Restored
        afterward so the change does not leak into other tests.
        """

        import os

        original = os.environ.get("TZ")
        os.environ["TZ"] = "America/New_York"  # UTC-5/-4, never a zero offset
        time.tzset()
        try:
            yield
        finally:
            if original is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = original
            time.tzset()

    def _record_at_epoch(self) -> logging.LogRecord:
        record = _make_record()
        record.created = self._EPOCH
        record.msecs = 0.0
        TraceContextFilter().filter(record)
        return record

    def test_json_timestamp_is_utc(self, non_utc_tz: None) -> None:
        from pythonjsonlogger.jsonlogger import JsonFormatter

        spec = build_logging_config(level="INFO", json_output=True)["formatters"]["json"]
        formatter = JsonFormatter(spec["format"], rename_fields=spec["rename_fields"])
        payload = json.loads(formatter.format(self._record_at_epoch()))

        expected_utc = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(self._EPOCH))
        local_render = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self._EPOCH))
        assert payload["timestamp"].startswith(expected_utc)
        # Self-check: the pinned zone must actually differ from UTC, otherwise the
        # assertion above would pass even with the default (local) converter.
        assert local_render != expected_utc

    def test_console_timestamp_is_utc(self, non_utc_tz: None) -> None:
        spec = build_logging_config(level="INFO", json_output=False)["formatters"]["console"]
        formatter = logging.Formatter(spec["format"])
        line = formatter.format(self._record_at_epoch())

        expected_utc = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(self._EPOCH))
        local_render = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self._EPOCH))
        assert expected_utc in line
        assert local_render != expected_utc


class TestRequestIDMiddleware:
    def _run(self, header: str | None = None):
        seen: dict[str, str | None] = {}

        def get_response(request):
            from django.http import HttpResponse

            # Capture what the filter would see mid-request.
            seen["contextvar"] = get_request_id()
            seen["request_attr"] = getattr(request, "request_id", None)
            return HttpResponse("ok")

        middleware = RequestIDMiddleware(get_response)
        from django.test import RequestFactory

        rf = RequestFactory()
        kwargs = {}
        if header is not None:
            kwargs["HTTP_X_REQUEST_ID"] = header
        response = middleware(rf.get("/", **kwargs))
        return response, seen

    def test_generates_id_when_absent(self) -> None:
        response, seen = self._run()
        rid = response["X-Request-ID"]
        assert rid
        assert seen["contextvar"] == rid
        assert seen["request_attr"] == rid

    def test_adopts_inbound_header(self) -> None:
        response, seen = self._run(header="edge-supplied-123")
        assert response["X-Request-ID"] == "edge-supplied-123"
        assert seen["contextvar"] == "edge-supplied-123"

    def test_sanitizes_injection_chars(self) -> None:
        # CR/LF and other unsafe chars are stripped before the value reaches a
        # response header or a log line (header/log injection guard).
        response, _ = self._run(header="abc\r\nSet-Cookie: x=1 def")
        rid = response["X-Request-ID"]
        assert "\r" not in rid and "\n" not in rid and " " not in rid
        # Only [A-Za-z0-9._-] survives; ':', '=' and whitespace are dropped.
        assert rid == "abcSet-Cookiex1def"

    def test_resets_contextvar_after_request(self) -> None:
        assert get_request_id() is None
        self._run()
        # The contextvar must not leak this request's id into the next.
        assert get_request_id() is None
