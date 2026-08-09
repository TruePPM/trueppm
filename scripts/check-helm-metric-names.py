#!/usr/bin/env python3
"""Fail if the Helm chart's PromQL names a ``trueppm_*`` series the app never emits.

Why this gate exists (#2805)
----------------------------
The shipped ``TruePPMDeadLetterPresent`` alert and the bundled Grafana panel both
queried ``trueppm_deadletter_parked``. Nothing emitted that series — the app's name
is ``trueppm_task_dead_letter_parked``. A PromQL expression that names a
non-existent series is not an error anywhere in the stack: Prometheus evaluates it
to an empty vector, the alert simply never fires, and the panel is simply blank. So
the chart shipped a dead alert for permanently-lost background work, and every gate
in the repo stayed green. ``helm lint`` proves the template renders; it cannot know
what the application publishes.

What is checked
---------------
Every ``trueppm_*`` identifier appearing anywhere in the chart's observability
assets (the PrometheusRule template and the Grafana dashboard JSON) must be a name
the application actually emits — as a metric name **or** as a metric-dimension
label, since both appear in PromQL (``sum by (trueppm_outbox_name) (...)``).

Sources of truth for "actually emits", both scanned from the API source so the gate
cannot drift from the code:

1. **Prometheus text exposition** — module-level string constants such as
   ``_DEAD_LETTER_METRIC = "trueppm_task_dead_letter_parked"`` in
   ``apps/observability/views.py``. Already in Prometheus form.
2. **Native OTLP instruments and attributes** — the constants in
   ``apps/observability/otel/metrics.py`` and ``otel/attributes.py``, which are in
   dotted OTLP form (``trueppm.outbox.depth``). A collector's Prometheus exporter
   normalizes those to underscores, which this script reproduces.

Known limits (deliberate, documented rather than guessed at)
------------------------------------------------------------
* The OTLP→Prometheus name translation modeled here is **dot/dash → underscore**,
  plus an optional ``_total`` suffix for monotonic counters. Real exporters may
  also append unit suffixes (``_seconds``, ``_bytes``, ``_ratio``) depending on
  their configuration. Reproducing every exporter's rules faithfully is not
  possible from this side, so the check is deliberately *permissive* about
  suffixes it cannot predict and *strict* about the stem: a chart name whose stem
  is not an emitted name fails, which is the drift class that actually bites.
* The scan collects **module-level** ``NAME = "trueppm..."`` string constants only.
  A metric name built at runtime by concatenation would be invisible here; there
  are none today, and adding one should come with an entry in ``EXTRA_EMITTED``.
* This proves the *names* line up. It does not prove the series is being scraped —
  ``trueppm_task_dead_letter_parked`` in particular is text exposition on
  ``/api/v1/health/dead-letter/`` and needs its own scrape job, which is a docs
  matter (see docs → Administration → Observability).

Usage::

    python3 scripts/check-helm-metric-names.py [repo_root]
    python3 scripts/check-helm-metric-names.py --self-test
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

# Chart files whose text is scanned for PromQL identifiers. Scoped to the two
# observability assets on purpose: the rest of the chart legitimately contains
# `trueppm_api.…` Python module paths, which are not metric names.
CHART_PROMQL_FILES = (
    "packages/helm/templates/prometheusrule.yaml",
    "packages/helm/dashboards/trueppm-o11y.json",
)

# Root of the application source scanned for emitted names.
APP_SOURCE_ROOT = "packages/api/src/trueppm_api"

# Names emitted by something this scanner cannot see (none today). Keep the reason
# inline if one is ever added — an unexplained allowlist entry is how the gate rots.
EXTRA_EMITTED: frozenset[str] = frozenset()

# A PromQL identifier in the TruePPM namespace. Matches metric names and the
# trueppm.*-derived label names alike; both must resolve to something the app emits.
_CHART_TOKEN = re.compile(r"\btrueppm_[a-z0-9_]+\b")

# Only string constants in the TruePPM namespace are candidates, in either the
# dotted OTLP form or the already-underscored Prometheus form.
_TRUEPPM_CONSTANT = re.compile(r"^trueppm[._-][a-z0-9_.\-]+$")


def to_prometheus_name(otlp_name: str) -> str:
    """Translate a dotted OTLP instrument/attribute name to Prometheus form.

    Args:
        otlp_name: An OTel name such as ``trueppm.outbox.oldest_age_seconds``.

    Returns:
        The name a collector's Prometheus exporter publishes, e.g.
        ``trueppm_outbox_oldest_age_seconds``. Already-underscored names (the text
        exposition constants) pass through unchanged.
    """
    return re.sub(r"[.\-]", "_", otlp_name)


def extract_chart_names(text: str) -> set[str]:
    """Return every ``trueppm_*`` PromQL identifier appearing in chart text.

    Args:
        text: Raw contents of a PrometheusRule template or dashboard JSON file.

    Returns:
        The set of identifiers found. Panel descriptions and alert annotations are
        scanned too, not just ``expr`` values — prose naming a stale metric is the
        same operator-facing lie as a stale query, and the dashboard's dead-letter
        description carried exactly that.
    """
    return set(_CHART_TOKEN.findall(text))


def extract_module_constants(source: str) -> set[str]:
    """Return module-level ``NAME = "trueppm…"`` string constants from Python source.

    Args:
        source: Contents of one Python module.

    Returns:
        The TruePPM-namespaced string values assigned at module level. Nested
        (class- or function-scoped) assignments are ignored: every metric and
        attribute constant in this codebase is module-level by convention, and
        restricting the scan keeps unrelated local strings out of the allowlist.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()

    found: set[str] = set()
    for node in tree.body:
        if not isinstance(node, ast.Assign | ast.AnnAssign):
            continue
        value = node.value
        if (
            isinstance(value, ast.Constant)
            and isinstance(value.value, str)
            and _TRUEPPM_CONSTANT.match(value.value)
        ):
            found.add(value.value)
    return found


def collect_emitted_names(app_root: Path) -> set[str]:
    """Collect every Prometheus-form name the application can publish.

    Args:
        app_root: Path to ``packages/api/src/trueppm_api``.

    Returns:
        Prometheus-form names, including the ``_total`` variant a collector appends
        to monotonic counters.
    """
    emitted: set[str] = set()
    for path in sorted(app_root.rglob("*.py")):
        for constant in extract_module_constants(path.read_text(encoding="utf-8")):
            name = to_prometheus_name(constant)
            emitted.add(name)
            emitted.add(f"{name}_total")
    return emitted | set(EXTRA_EMITTED)


def collect_chart_names(repo_root: Path) -> dict[str, list[str]]:
    """Map each chart PromQL identifier to the chart files that reference it.

    Args:
        repo_root: Repository root.

    Returns:
        ``{identifier: [relative file path, ...]}``.

    Raises:
        FileNotFoundError: If a file listed in ``CHART_PROMQL_FILES`` is missing —
            a moved or renamed chart asset must not silently empty this gate.
    """
    sites: dict[str, list[str]] = {}
    for rel in CHART_PROMQL_FILES:
        path = repo_root / rel
        if not path.is_file():
            raise FileNotFoundError(
                f"{rel} not found — update CHART_PROMQL_FILES if the chart moved"
            )
        for name in extract_chart_names(path.read_text(encoding="utf-8")):
            sites.setdefault(name, []).append(rel)
    return sites


def find_unknown_names(repo_root: Path) -> dict[str, list[str]]:
    """Return chart identifiers that no application source constant accounts for.

    Args:
        repo_root: Repository root.

    Returns:
        ``{identifier: [chart file, ...]}`` for every unmatched identifier; empty
        when the chart and the application agree.
    """
    emitted = collect_emitted_names(repo_root / APP_SOURCE_ROOT)
    return {
        name: files
        for name, files in sorted(collect_chart_names(repo_root).items())
        if name not in emitted
    }


def _self_test() -> int:
    """Prove the checker fails on injected drift, then pass over the real tree.

    A guard nobody has watched fail is indistinguishable from one with a typo in
    its pattern, so the mutation half runs before the real check.
    """
    bogus = extract_chart_names("expr: sum(trueppm_deadletter_parked) > 0")
    assert bogus == {"trueppm_deadletter_parked"}, bogus
    assert extract_chart_names('include "trueppm.fullname"') == set()
    assert extract_module_constants('X = "trueppm.outbox.depth"') == {
        "trueppm.outbox.depth"
    }
    assert extract_module_constants('def f():\n    x = "trueppm.local.only"\n') == set()
    assert to_prometheus_name("trueppm.outbox.oldest_age_seconds") == (
        "trueppm_outbox_oldest_age_seconds"
    )
    print("self-test: OK")
    return 0


def main(argv: list[str]) -> int:
    """Entry point. Returns 0 when the chart and the application agree."""
    if "--self-test" in argv:
        return _self_test()

    repo_root = Path(argv[1]).resolve() if len(argv) > 1 else Path.cwd()
    unknown = find_unknown_names(repo_root)
    if not unknown:
        return 0

    print(
        "FAIL: the Helm chart queries trueppm_* series the application never emits.\n"
        "A PromQL name with no matching series is not an error — the alert silently\n"
        "never fires and the panel is silently blank.\n",
        file=sys.stderr,
    )
    for name, files in unknown.items():
        print(f"  {name}\n    referenced by: {', '.join(files)}", file=sys.stderr)
    print(
        "\nEmitted names come from module-level trueppm.* / trueppm_* string constants\n"
        f"under {APP_SOURCE_ROOT} (otel/metrics.py, otel/attributes.py, and the\n"
        "text-exposition constants in apps/observability/views.py).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
