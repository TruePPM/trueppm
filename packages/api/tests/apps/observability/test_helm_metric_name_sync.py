"""The Helm chart's PromQL must name only series the application emits (#2805).

The shipped ``TruePPMDeadLetterPresent`` alert and the bundled Grafana panel both
queried ``trueppm_deadletter_parked`` while the app emitted
``trueppm_task_dead_letter_parked``. Prometheus treats a name with no series as an
empty vector rather than an error, so the alert could never fire and the panel was
permanently blank — with every gate in the repo green.

These tests drive ``scripts/check-helm-metric-names.py``. Two things are asserted:
the real chart agrees with the real application source, and the checker actually
fails on injected drift (a gate nobody has watched fail is indistinguishable from a
gate with a typo in its pattern).

Limitations, restated from the script's own docstring so a reader here is not
misled about the strength of the guarantee:

* Emitted names are collected from module-level ``NAME = "trueppm…"`` string
  constants; a name assembled at runtime would be invisible.
* The OTLP→Prometheus translation modeled is dot/dash→underscore plus an optional
  ``_total`` counter suffix. A collector configured to append unit suffixes could
  publish a longer name than this check predicts, so the check is strict about the
  stem and permissive about suffixes it cannot know.
* Name agreement is not scrape coverage: ``trueppm_task_dead_letter_parked`` is
  text exposition on ``/api/v1/health/dead-letter/`` and needs its own scrape job.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[5]
CHECKER_PATH = REPO_ROOT / "scripts" / "check-helm-metric-names.py"


def _load_checker() -> ModuleType:
    """Import the checker script by path (it is a script, not an installed module)."""
    spec = importlib.util.spec_from_file_location("check_helm_metric_names", CHECKER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def checker() -> ModuleType:
    if not CHECKER_PATH.is_file():
        pytest.fail(f"{CHECKER_PATH} is missing — the chart name-sync gate has no checker")
    return _load_checker()


def test_chart_promql_names_are_all_emitted(checker: ModuleType) -> None:
    """Every trueppm_* identifier in the chart resolves to an emitted name."""
    unknown = checker.find_unknown_names(REPO_ROOT)
    assert not unknown, (
        "Helm chart PromQL references series the application never emits: "
        + "; ".join(f"{name} ({', '.join(files)})" for name, files in unknown.items())
    )


def test_dead_letter_alert_uses_the_endpoint_constant(checker: ModuleType) -> None:
    """The alert and panel use the exact name the text-exposition view publishes.

    Pinned separately from the generic sweep because this is the specific pair that
    drifted, and because the gauge is not an OTLP metric — no collector name
    translation stands between the constant and the PromQL, so they must match
    character for character.
    """
    from trueppm_api.apps.observability.views import _DEAD_LETTER_METRIC

    for rel in checker.CHART_PROMQL_FILES:
        text = (REPO_ROOT / rel).read_text(encoding="utf-8")
        if "dead" not in text.lower():
            continue
        names = {n for n in checker.extract_chart_names(text) if "dead" in n}
        assert names == {_DEAD_LETTER_METRIC}, f"{rel} references {names}"


def test_checker_rejects_a_name_the_app_does_not_emit(checker: ModuleType) -> None:
    """Mutation test: the gate must fail on the exact drift that shipped."""
    emitted = checker.collect_emitted_names(REPO_ROOT / checker.APP_SOURCE_ROOT)
    assert "trueppm_deadletter_parked" not in emitted
    assert "trueppm_task_dead_letter_parked" in emitted


def test_otlp_instrument_names_translate_to_the_chart_form(checker: ModuleType) -> None:
    """The dotted OTLP instrument names normalize to what the dashboard queries."""
    from trueppm_api.apps.observability.otel import metrics

    assert checker.to_prometheus_name(metrics.OUTBOX_DEPTH) == "trueppm_outbox_depth"
    assert (
        checker.to_prometheus_name(metrics.OUTBOX_OLDEST_AGE) == "trueppm_outbox_oldest_age_seconds"
    )
    assert checker.to_prometheus_name(metrics.DB_CONNECTIONS) == "trueppm_db_connections"


def test_checker_self_test_passes(checker: ModuleType) -> None:
    """The script's own --self-test path stays green."""
    assert checker._self_test() == 0


def test_cluster_wide_gauge_set_matches_metrics_module(checker: ModuleType) -> None:
    """The checker's AST-derived cluster-wide gauge names match otel/metrics.py.

    Guards the checker's own extraction against silently drifting from the
    constant it is supposed to mirror (a real import here, not the AST scan the
    checker itself must use to stay Django-free).
    """
    from trueppm_api.apps.observability.otel import metrics

    expected = {checker.to_prometheus_name(name) for name in metrics.CLUSTER_WIDE_GAUGES}
    assert expected == {
        "trueppm_outbox_depth",
        "trueppm_outbox_oldest_age_seconds",
        "trueppm_db_connections",
        "trueppm_broker_queue_depth",
    }
    actual = checker.collect_cluster_wide_gauge_names(REPO_ROOT / checker.APP_SOURCE_ROOT)
    assert actual == expected


def test_no_chart_expression_sums_a_cluster_wide_gauge(checker: ModuleType) -> None:
    """No PrometheusRule alert or dashboard panel `sum()`s a cluster-wide gauge.

    Every process running ``ready()`` (web, Celery worker, Celery beat) emits the
    same whole-cluster figure for these gauges as its own series (see the
    "Cluster-wide" section of ``otel/metrics.py``'s module docstring) — `sum()`
    multiplies the true value by the process count instead of reporting it. This
    is the #4186 bug: ``TruePPMOutboxDepthRising`` fired at ~10x real outbox
    depth, and the dashboard's outbox-depth and DB-connections panels overcounted
    the same way. This pins the *aggregation*, not just the metric name — the
    older ``test_chart_promql_names_are_all_emitted`` above would stay green on
    this bug forever, since `sum(trueppm_outbox_depth)` names a real series.
    """
    violations = checker.find_summed_cluster_wide_gauges(REPO_ROOT)
    assert not violations, (
        "Helm chart sum()s a cluster-wide gauge — use max by (...) instead: "
        + "; ".join(f"{name} ({', '.join(files)})" for name, files in violations.items())
    )


def test_checker_rejects_a_sum_over_a_cluster_wide_gauge(checker: ModuleType) -> None:
    """Mutation test: the gate must fail on the exact aggregation bug that shipped."""
    assert checker.find_summed_metric_names(
        "sum by (trueppm_outbox_name, trueppm_outbox_state) (trueppm_outbox_depth)"
    ) == {"trueppm_outbox_depth"}
    # `without` is PromQL's other grouping modifier, syntactically identical to
    # `by` — a detector that only recognized `by` would silently pass a chart
    # expression written with `without` (#4186 completeness-check gap).
    assert checker.find_summed_metric_names("sum without (pod) (trueppm_outbox_depth)") == {
        "trueppm_outbox_depth"
    }
    assert (
        checker.find_summed_metric_names("max by (trueppm_outbox_name) (trueppm_outbox_depth)")
        == set()
    )
    # find_summed_cluster_wide_gauges must actually flag the intersection, not
    # merely a set of names each half correctly computes on its own.
    assert "trueppm_outbox_depth" in checker.collect_cluster_wide_gauge_names(
        REPO_ROOT / checker.APP_SOURCE_ROOT
    )
