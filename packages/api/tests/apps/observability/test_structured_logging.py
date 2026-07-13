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
