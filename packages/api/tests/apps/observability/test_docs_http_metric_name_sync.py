"""The docs' HTTP request-latency metric name/unit must match what OTel emits (#4187).

``packages/website/src/content/docs/administration/observability.md`` documented
the request-latency histogram as
``http.server.request.duration`` — the *stable* HTTP semconv name, in seconds.
TruePPM runs ``opentelemetry-instrumentation-django`` 0.64b0 without setting
``OTEL_SEMCONV_STABILITY_OPT_IN``, so ``DjangoInstrumentor`` resolves the *old*
stability mode and emits ``http.server.duration`` in **milliseconds** instead —
never the documented name. Behind a Prometheus exporter that is
``http_server_duration_milliseconds_{bucket,count,sum}``, not
``http_server_request_duration_seconds*``: an alert built on the documented name
would evaluate to an empty vector and silently never fire — the same failure class
``test_helm_metric_name_sync.py`` guards against for ``trueppm_*`` metrics. This is
the sibling gate for the one HTTP metric a third-party library names rather than our
own code.

The fix taken is **docs, not code** (see ``changelog.d/4187.fixed.md``): renaming
the emitted metric mid-0.4-beta would break every operator alert or dashboard
already built against the name TruePPM has actually shipped since #710.

This test resolves the *real* semconv stability mode from the installed
``opentelemetry-instrumentation`` package the same way ``DjangoInstrumentor`` does,
rather than hardcoding a string, so it also catches: (a) the docs table drifting
from the code again, and (b) TruePPM someday setting
``OTEL_SEMCONV_STABILITY_OPT_IN`` (or a dependency bump changing the default)
without updating the docs to match.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[5]
DOCS_PATH = (
    REPO_ROOT
    / "packages"
    / "website"
    / "src"
    / "content"
    / "docs"
    / "administration"
    / "observability.md"
)

# Matches a `| \`http.server.<name>\` | <rest of row> |` line in the metrics table.
_ROW_RE = re.compile(
    r"^\|\s*`(?P<name>http\.server\.\S+?)`\s*\|\s*(?P<rest>.+?)\s*\|", re.MULTILINE
)


def _http_duration_row(text: str) -> tuple[str, str]:
    """Return (metric_name, rest_of_row) for the HTTP request-latency histogram row.

    Discriminates from the neighboring ``http.server.active_requests`` up/down
    counter row by requiring "histogram" in the rest of the row.
    """
    for match in _ROW_RE.finditer(text):
        if "histogram" in match.group("rest"):
            return match.group("name"), match.group("rest")
    pytest.fail("No HTTP latency histogram row found in observability.md's metrics table")


def _emitted_http_duration_name_and_unit() -> tuple[str, str]:
    """The metric name + unit ``opentelemetry-instrumentation-django`` emits today.

    Reproduces the library's own resolution: ``DjangoInstrumentor.instrument()``
    resolves a stability mode via
    ``_OpenTelemetrySemanticConventionStability._get_opentelemetry_stability_opt_in_mode``,
    which reads ``OTEL_SEMCONV_STABILITY_OPT_IN`` from the environment, and then
    picks the old-vs-new histogram (and its unit) with ``_report_old``/
    ``_report_new``. Calling the same resolver here — instead of hardcoding
    "http.server.duration" — means this test tracks the library's actual behavior,
    not a guess about it.
    """
    from opentelemetry.instrumentation._semconv import (
        _OpenTelemetrySemanticConventionStability,
        _OpenTelemetryStabilitySignalType,
        _report_new,
        _report_old,
    )
    from opentelemetry.semconv.metrics import MetricInstruments

    mode = _OpenTelemetrySemanticConventionStability._get_opentelemetry_stability_opt_in_mode(
        _OpenTelemetryStabilitySignalType.HTTP
    )
    assert _report_old(mode) is True, (
        "The old HTTP semconv histogram is no longer reported under the default "
        "(OTEL_SEMCONV_STABILITY_OPT_IN unset) mode. opentelemetry-instrumentation-"
        "django's default must have changed — update observability.md and this test "
        "to the stable name/unit (http.server.request.duration, seconds) together."
    )
    assert _report_new(mode) is False, (
        "The stable HTTP semconv histogram is ALSO now reported under the default "
        "mode, or OTEL_SEMCONV_STABILITY_OPT_IN is set somewhere for TruePPM. "
        "Update observability.md's row (and its unit) to match before this test can "
        "go green on the new state."
    )
    return MetricInstruments.HTTP_SERVER_DURATION, "ms"


class TestDocsHttpMetricNameSync:
    def test_environment_does_not_override_the_default_semconv_mode(self) -> None:
        """Guard the test's own premise: nothing in this environment sets the opt-in var.

        Grepped clean across packages/api, packages/helm, docker-compose.yml, and
        .env.example — the only two hits in the whole repo are the two docs files
        this issue touches (observability.md and ADR-0223), which *describe* the
        variable rather than set it.
        """
        assert not os.environ.get("OTEL_SEMCONV_STABILITY_OPT_IN")

    def test_docs_metric_name_and_unit_match_what_is_emitted(self) -> None:
        text = DOCS_PATH.read_text(encoding="utf-8")
        doc_name, rest = _http_duration_row(text)
        emitted_name, unit = _emitted_http_duration_name_and_unit()

        assert doc_name == emitted_name, (
            f"observability.md documents `{doc_name}` but TruePPM emits "
            f"`{emitted_name}` under the current (default) semconv stability mode."
        )
        assert "millisecond" in rest.lower(), (
            f"observability.md's row for `{doc_name}` does not state its unit "
            f"({unit}) — an operator building a Prometheus alert needs this to avoid "
            "off-by-1000 thresholds."
        )

    def test_gate_rejects_the_original_wrong_doc_text(self) -> None:
        """Mutation test: this gate must fail on the exact drift #4187 reported.

        A gate that always agrees with the docs regardless of their content is
        indistinguishable from no gate at all.
        """
        wrong_row = (
            "| `http.server.request.duration` | histogram | API request latency | "
            "`http.*` semantic conventions |"
        )
        doc_name, _rest = _http_duration_row(wrong_row)
        emitted_name, _unit = _emitted_http_duration_name_and_unit()

        assert doc_name != emitted_name
        with pytest.raises(AssertionError):
            assert doc_name == emitted_name
