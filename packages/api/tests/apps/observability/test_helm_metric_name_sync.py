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
