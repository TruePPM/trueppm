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

Aggregation safety (#4186)
---------------------------
A second, independent check: no chart expression may wrap a **cluster-wide**
gauge — one ``otel/metrics.py`` documents and lists in its
``CLUSTER_WIDE_GAUGES`` constant — in a PromQL ``sum()``. Every process that runs
``ready()`` (web, Celery worker, Celery beat) registers these gauges against the
*same* shared PostgreSQL/Valkey state, so each re-emits the whole-cluster figure as
its own series; summing across instances multiplies the true value by the process
count instead of reporting it. This shipped as ``TruePPMOutboxDepthRising`` firing
at roughly 10x real outbox depth and the dashboard's outbox/DB-connections panels
overcounting the same way. The fix is ``max by (...)`` (or ``last_over_time`` piped
through ``max``), never ``sum``. The cluster-wide set is read from
``CLUSTER_WIDE_GAUGES`` via the same AST scan used for emitted names, so a gauge
added to that constant is covered here automatically without a second,
hand-maintained list drifting out of sync with it.

The ``sum(...)`` detector recognizes the bare form (``sum(metric)``), the
``by (...)`` grouping modifier, and PromQL's ``without (...)`` grouping modifier
(``sum without (pod) (metric)``) — both are prefix modifiers on ``sum`` with
identical syntax, so a name wrapped in either one is caught the same way.

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

# A `sum(...)`, `sum by (labels) (...)`, or `sum without (labels) (...)` PromQL
# aggregation directly wrapping a single trueppm_* series (with an optional
# `{label="..."}` matcher). `by` and `without` are PromQL's two grouping modifiers
# and share identical syntax, so both must be recognized — missing `without` would
# let a chart expression escape this gate on a syntax alone, not a real difference
# in what it aggregates. The chart's expressions never nest a sum() inside another
# aggregation's argument, so this does not need balanced-paren parsing.
_SUM_AGG_PATTERN = re.compile(
    r"\bsum\s*(?:(?:by|without)\s*\([^)]*\)\s*)?\(\s*(trueppm_[a-z0-9_]+)(?:\{[^}]*\})?\s*\)"
)


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


def find_summed_metric_names(text: str) -> set[str]:
    """Return every ``trueppm_*`` metric name directly wrapped in a PromQL ``sum()``.

    Args:
        text: Raw contents of a PrometheusRule template or dashboard JSON file.

    Returns:
        The set of metric names appearing as the sole argument (optionally with a
        ``{label="..."}`` matcher) of a ``sum(...)`` or ``sum by (...) (...)`` call.
    """
    return set(_SUM_AGG_PATTERN.findall(text))


def _assign_targets(node: ast.Assign | ast.AnnAssign) -> list[ast.expr]:
    """Return the target(s) of a module-level ``Assign`` or ``AnnAssign`` node."""
    return node.targets if isinstance(node, ast.Assign) else [node.target]


def _module_string_constants(tree: ast.Module) -> dict[str, str]:
    """Map every module-level ``NAME = "trueppm..."`` constant to its value."""
    name_to_value: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign | ast.AnnAssign):
            continue
        value = node.value
        if not (
            isinstance(value, ast.Constant)
            and isinstance(value.value, str)
            and _TRUEPPM_CONSTANT.match(value.value)
        ):
            continue
        for target in _assign_targets(node):
            if isinstance(target, ast.Name):
                name_to_value[target.id] = value.value
    return name_to_value


def _find_cluster_wide_gauges_set(tree: ast.Module) -> ast.Set | None:
    """Return the ``ast.Set`` node backing a module's ``CLUSTER_WIDE_GAUGES`` constant.

    Accepts ``frozenset({...})``, a bare ``{...}`` set literal, or ``None`` when the
    module defines no such constant or its shape isn't one of those two.
    """
    for node in tree.body:
        if not isinstance(node, ast.Assign | ast.AnnAssign):
            continue
        if not any(
            isinstance(t, ast.Name) and t.id == "CLUSTER_WIDE_GAUGES"
            for t in _assign_targets(node)
        ):
            continue
        value = node.value
        if (
            isinstance(value, ast.Call)
            and getattr(value.func, "id", None) == "frozenset"
        ):
            container = value.args[0] if value.args else None
        else:
            container = value
        return container if isinstance(container, ast.Set) else None
    return None


def _extract_cluster_wide_gauge_constant(source: str) -> set[str]:
    """Resolve a module's ``CLUSTER_WIDE_GAUGES`` frozenset to its string values.

    Walks the AST rather than importing the module, matching this script's
    existing approach for emitted names: the scan must not require a configured
    Django environment. Resolves each element of the set — whether a ``Name``
    reference to another module-level constant or an inline string literal —
    against a map of every ``NAME = "trueppm..."`` constant in the module.

    Args:
        source: Contents of one Python module.

    Returns:
        The dotted OTLP-form names in that module's ``CLUSTER_WIDE_GAUGES``
        constant, or an empty set if the module defines none.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()

    gauges_set = _find_cluster_wide_gauges_set(tree)
    if gauges_set is None:
        return set()

    name_to_value = _module_string_constants(tree)
    resolved: set[str] = set()
    for elt in gauges_set.elts:
        if isinstance(elt, ast.Name) and elt.id in name_to_value:
            resolved.add(name_to_value[elt.id])
        elif isinstance(elt, ast.Constant) and isinstance(elt.value, str):
            resolved.add(elt.value)
    return resolved


def collect_cluster_wide_gauge_names(app_root: Path) -> set[str]:
    """Collect the Prometheus-form names of every gauge classified cluster-wide.

    Args:
        app_root: Path to ``packages/api/src/trueppm_api``.

    Returns:
        Prometheus-form names (translated via :func:`to_prometheus_name`) of every
        gauge listed in some module's ``CLUSTER_WIDE_GAUGES`` constant — today just
        ``otel/metrics.py``, but the scan is not hardcoded to that one file.
    """
    otlp_names: set[str] = set()
    for path in sorted(app_root.rglob("*.py")):
        otlp_names |= _extract_cluster_wide_gauge_constant(
            path.read_text(encoding="utf-8")
        )
    return {to_prometheus_name(name) for name in otlp_names}


def find_summed_cluster_wide_gauges(repo_root: Path) -> dict[str, list[str]]:
    """Return chart sites that ``sum()`` a gauge classified cluster-wide.

    Args:
        repo_root: Repository root.

    Returns:
        ``{metric name: [chart file, ...]}`` for every cluster-wide gauge found
        inside a ``sum(...)``/``sum by (...) (...)`` expression; empty when the
        chart aggregates every such gauge with ``max``/``last`` instead.

    Raises:
        FileNotFoundError: If a file listed in ``CHART_PROMQL_FILES`` is missing.
    """
    cluster_wide = collect_cluster_wide_gauge_names(repo_root / APP_SOURCE_ROOT)
    violations: dict[str, list[str]] = {}
    for rel in CHART_PROMQL_FILES:
        path = repo_root / rel
        if not path.is_file():
            raise FileNotFoundError(
                f"{rel} not found — update CHART_PROMQL_FILES if the chart moved"
            )
        summed = find_summed_metric_names(path.read_text(encoding="utf-8"))
        for name in sorted(summed & cluster_wide):
            violations.setdefault(name, []).append(rel)
    return violations


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
    assert find_summed_metric_names(
        "sum by (trueppm_outbox_name) (trueppm_outbox_depth)"
    ) == {"trueppm_outbox_depth"}
    assert find_summed_metric_names("sum without (pod) (trueppm_outbox_depth)") == {
        "trueppm_outbox_depth"
    }
    assert (
        find_summed_metric_names("max by (trueppm_outbox_name) (trueppm_outbox_depth)")
        == set()
    )
    bogus_cluster_wide = _extract_cluster_wide_gauge_constant(
        'OUTBOX_DEPTH = "trueppm.outbox.depth"\n'
        'DB_CONNECTIONS = "trueppm.db.connections"\n'
        "CLUSTER_WIDE_GAUGES = frozenset({OUTBOX_DEPTH, DB_CONNECTIONS})\n"
    )
    assert bogus_cluster_wide == {"trueppm.outbox.depth", "trueppm.db.connections"}
    print("self-test: OK")
    return 0


def main(argv: list[str]) -> int:
    """Entry point. Returns 0 when the chart and the application agree."""
    if "--self-test" in argv:
        return _self_test()

    repo_root = Path(argv[1]).resolve() if len(argv) > 1 else Path.cwd()
    unknown = find_unknown_names(repo_root)
    summed_cluster_wide = find_summed_cluster_wide_gauges(repo_root)
    if not unknown and not summed_cluster_wide:
        return 0

    if unknown:
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

    if summed_cluster_wide:
        print(
            "\nFAIL: the Helm chart sum()s a cluster-wide gauge (otel/metrics.py's\n"
            "CLUSTER_WIDE_GAUGES). Every process emits the same whole-cluster figure as\n"
            "its own series, so sum() multiplies the true value by the process count —\n"
            "use max by (...) or last instead.\n",
            file=sys.stderr,
        )
        for name, files in summed_cluster_wide.items():
            print(
                f"  sum(...{name}...)\n    referenced by: {', '.join(files)}",
                file=sys.stderr,
            )

    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
