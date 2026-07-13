"""Structured JSON logging with OpenTelemetry trace correlation (#1899).

Django's out-of-the-box logging emits unstructured plain text, which a log
aggregator (Loki, Elasticsearch, CloudWatch) cannot parse into fields and — more
importantly — cannot correlate with the distributed traces we export over OTLP
(ADR-0223). An operator staring at a slow request in Grafana Tempo has a
``trace_id`` but no way to jump to the log lines emitted while that trace was
active, and vice versa.

This module closes that gap with two pieces:

* :class:`TraceContextFilter` stamps the *active* OTel ``trace_id`` / ``span_id``
  (W3C hex, lower-case, unpadded of any ``0x`` prefix) and a per-request id onto
  every :class:`logging.LogRecord`. When no span is recording — the strict no-op
  OTel default, a Celery beat tick, a management command — the ids are set to
  ``None`` so the output stays well-formed and the absence is explicit rather than
  a ``KeyError`` at format time.
* :class:`RequestIDMiddleware` mints (or adopts, from a trusted ``X-Request-ID``
  header) a stable id per HTTP request, stores it in a contextvar for the filter
  to read, and echoes it back on the response so a user can quote it in a bug
  report and an operator can pivot straight to that request's logs.

:func:`build_logging_config` assembles the Django ``LOGGING`` ``dictConfig``. It is
called from ``settings`` — human-readable console output in dev, single-line JSON
in prod — with the level driven by ``DJANGO_LOG_LEVEL``.

Scope note (per #1899): this is structured *stdout* only. OTLP **log export** —
shipping these records to the collector as OTel LogRecords — is deferred to #711;
we deliberately do not install an OTel ``LoggingHandler`` here.
"""

from __future__ import annotations

import logging
import re
import uuid
from contextvars import ContextVar, Token
from typing import TYPE_CHECKING, Any

from opentelemetry import trace

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.http import HttpRequest, HttpResponse

# The active request's correlation id. A contextvar (not thread-local) so it
# survives the sync/async hops of the Channels/ASGI stack the same way OTel's own
# context does — a value set in the request path is visible to any log record
# emitted while handling that request, on whichever worker thread runs it.
_request_id_var: ContextVar[str | None] = ContextVar("trueppm_request_id", default=None)

# Bound the id length and restrict it to an opaque-token charset. The value flows
# into a response header and into log lines, so stripping everything outside
# ``[A-Za-z0-9._-]`` forecloses header-injection (CR/LF) and log-forging from a
# spoofed inbound ``X-Request-ID`` before it is ever trusted.
_REQUEST_ID_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")
_REQUEST_ID_MAX_LEN = 200


def get_request_id() -> str | None:
    """Return the current request's correlation id, or ``None`` outside a request."""

    return _request_id_var.get()


def set_request_id(value: str | None) -> Token[str | None]:
    """Bind ``value`` as the current request id; return a token for :func:`reset_request_id`."""

    return _request_id_var.set(value)


def reset_request_id(token: Token[str | None]) -> None:
    """Restore the request id to its value before the matching :func:`set_request_id`."""

    _request_id_var.reset(token)


class TraceContextFilter(logging.Filter):
    """Inject OTel ``trace_id`` / ``span_id`` and the request id into every record.

    A :class:`logging.Filter` (rather than a formatter subclass) is used because a
    filter mutates the record in place and can be attached to *every* handler, so
    both the prod JSON handler and the dev console handler surface identical
    correlation fields without duplicating the extraction logic. Returning ``True``
    always — the filter never suppresses a record, it only annotates it.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        span_context = trace.get_current_span().get_span_context()
        if span_context.is_valid:
            # format_trace_id / format_span_id give the zero-padded lower-case hex
            # (32 / 16 chars) that matches the trace_id in the exported spans, so a
            # log-to-trace pivot is a literal string match.
            record.trace_id = trace.format_trace_id(span_context.trace_id)
            record.span_id = trace.format_span_id(span_context.span_id)
        else:
            record.trace_id = None
            record.span_id = None
        record.request_id = _request_id_var.get()
        return True


class RequestIDMiddleware:
    """Assign a correlation id to each request for logging and client bug reports.

    The id is adopted from an inbound ``X-Request-ID`` header when present (so a
    request can be followed across an ingress/proxy that already stamps one) and
    otherwise generated. It is bound to the request-scoped contextvar so
    :class:`TraceContextFilter` can stamp it onto every record emitted while the
    request is handled, mirrored onto ``request.request_id`` for view code, and
    echoed back on the response header so the value shown in a browser's network
    tab is the same one that appears in the server logs.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        request_id = self._resolve_request_id(request)
        token = set_request_id(request_id)
        request.request_id = request_id  # type: ignore[attr-defined]
        try:
            response = self.get_response(request)
        finally:
            # Reset even on error so a raised view cannot leak this request's id
            # into the next one handled on the same worker thread.
            reset_request_id(token)
        response["X-Request-ID"] = request_id
        return response

    @staticmethod
    def _resolve_request_id(request: HttpRequest) -> str:
        incoming = request.headers.get("X-Request-ID", "")
        sanitized = _REQUEST_ID_UNSAFE.sub("", incoming)[:_REQUEST_ID_MAX_LEN]
        return sanitized or uuid.uuid4().hex


def build_logging_config(*, level: str, json_output: bool) -> dict[str, Any]:
    """Build the Django ``LOGGING`` dictConfig.

    Args:
        level: Root/logger level, e.g. from ``DJANGO_LOG_LEVEL`` (default ``INFO``).
        json_output: When ``True`` emit single-line JSON (prod, machine-ingestible);
            when ``False`` emit a human-readable console line (dev) that still shows
            the correlation ids inline so a developer sees the same trace context.

    Returns:
        A ``logging.config.dictConfig``-compatible mapping. The formatter/filter
        are referenced by import path (the ``()`` factory form) so this function
        stays import-light enough to call at settings-load time without dragging in
        the OTel API before the app registry is ready.
    """

    handler = "json" if json_output else "console"
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "filters": {
            "trace_context": {
                "()": "trueppm_api.apps.observability.logging.TraceContextFilter",
            },
        },
        "formatters": {
            "json": {
                "()": "pythonjsonlogger.jsonlogger.JsonFormatter",
                # Named fields become top-level JSON keys; the filter guarantees the
                # trace_* / request_id attributes exist, so they serialize as null
                # (never a missing key) when no span/request is active.
                "format": (
                    "%(asctime)s %(levelname)s %(name)s %(message)s "
                    "%(trace_id)s %(span_id)s %(request_id)s"
                ),
                "rename_fields": {"asctime": "timestamp", "levelname": "level"},
            },
            "console": {
                "format": (
                    "%(asctime)s %(levelname)-8s %(name)s "
                    "[trace=%(trace_id)s span=%(span_id)s req=%(request_id)s] "
                    "%(message)s"
                ),
            },
        },
        "handlers": {
            "json": {
                "class": "logging.StreamHandler",
                "formatter": "json",
                "filters": ["trace_context"],
            },
            "console": {
                "class": "logging.StreamHandler",
                "formatter": "console",
                "filters": ["trace_context"],
            },
        },
        "root": {"handlers": [handler], "level": level},
        "loggers": {
            # Keep Django's own records on the same structured handler; propagate is
            # False so a record is not emitted twice (once here, once at root).
            "django": {"handlers": [handler], "level": level, "propagate": False},
            "trueppm": {"handlers": [handler], "level": level, "propagate": False},
        },
    }
