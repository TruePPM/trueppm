"""Program rollup-KPI consumer (ADR-0088, #713).

Reads the per-program rollup config shipped by #527 (``rollup_enabled_kpis`` +
``rollup_aggregation_policy`` on :class:`Program`) and computes the actual
rolled-up KPI values across the program's *own* projects. Intra-program only —
cross-program aggregation is Enterprise (ADR-0070).

Design (ADR-0088, amended by ADR-1314 for #4779):

- **Every figure has one definition and an as_of (ADR-1314).** The payload carries
  ``as_of`` (when it was computed) and a ``definitions`` map with one sentence per
  figure it carries, from :data:`~.metric_provenance.METRIC_DEFINITIONS`. A figure
  that is configured but cannot be computed keeps its ``value`` (null, or
  ``unknown`` for a band) and gains a machine ``reason`` — never omitted (rule 119).
- **``program_health`` is the SPI ``schedule_health`` rollup (ADR-0088).** Each
  contributing project's schedule performance band (the SPI proxy) combined under
  the aggregation policy. It is deliberately NOT a rollup of the project health
  band (``views.compute_health_band``): that band reads critical whenever any open
  leaf sits on the critical path, which on real CPM data is nearly every project
  with open work, so rolling it up would read Critical for nearly every program.
  ``Program.health`` (the manager's filed report) does not feed this payload, as
  before #4779.
- **``p80_completion``** is the latest P80 among the contributing projects' own
  forecasts, read from the same latest result ``monte-carlo/latest/`` serves (the
  cache entry, else the newest persisted run). Policy-independent: a program
  finishes when its last project does, and a mean of finish dates is no date. It
  counts the projects it leaves out (no forecast) and the forecasts it read that are
  stale against their plan, and carries the P50 and P95 beside it by the same
  reducer (ADR-0088 amendment 2026-11-27, #2408). None is a joint probability.
- **Cost KPIs (ADR-1324, #754).** ``cost_variance`` / ``budget_utilization`` come from
  :func:`~trueppm_api.apps.projects.cost.project_cost_facts` as program totals (Σ CV,
  ΣAC / ΣBAC). They are unavailable with an actionable reason (``no_budget`` /
  ``missing_rates``) when any contributing project cannot price its cost, and
  ``cost_restricted`` for a caller below program Admin — a Member or Viewer never
  receives a cost value. A project whose leaf work plans no days has no earned value
  (ADR-1447): ``cost_variance`` leaves it out of the sum and counts it in
  ``projects_without_planned_duration``, and is unavailable with
  ``no_planned_duration`` only when every project is in that state.
- **The aggregation policy applies where it is meaningful.** ``worst`` / ``average``
  / ``task_weighted`` govern the health bands (``schedule_health``,
  ``milestone_health``), the day-variances (``baseline_variance``,
  ``schedule_variance``), and the headline program health dot. Counts
  (``critical_tasks``, ``at_risk_tasks``) and risk exposure (``risk_score``) roll
  up as program **totals** regardless of policy — the sum is the only PM-useful
  number for an additive metric.
- ``weighted_by_budget`` weights each project by ``Project.budget`` (ADR-1324). When
  any contributing project has no budget it falls back to ``average`` and the response
  flags ``policy_available: False`` with ``policy_unavailable_reason: "no_budget"``;
  the rollup is never blanked just because the chosen policy cannot be honored. A
  caller who may not see every project's budget gets the average with
  ``"cost_restricted"`` instead — the weighting itself would leak budget ratios.

Implemented with a fixed, small number of grouped (``values().annotate()``)
queries across the program's projects — never a per-project ``ProjectOverviewView``
call — to hold the ≤200 ms p95 budget (ADR-0030/0088). Pure read; no writes, no
async side effects (ADR-0088 Durable Execution: all N/A).
"""

from __future__ import annotations

import datetime
from collections.abc import Callable, Collection
from decimal import Decimal
from typing import Any

from django.db.models import BooleanField, Count, F, FloatField, Max, Q, Sum
from django.db.models.expressions import RawSQL
from django.utils import timezone

from trueppm_api.apps.projects.metric_provenance import METRIC_DEFINITIONS
from trueppm_api.apps.projects.models import (
    AggregationPolicy,
    Baseline,
    BaselineTask,
    Program,
    Project,
    Risk,
    RiskStatus,
    RollupKpi,
    Task,
    TaskStatus,
)

# KPIs without a per-project source yet (ADR-0088). The reason string is stable
# so the web layer and #673's preview can branch on it.
#
# This map is the single source of truth for "can this KPI ever produce a value
# today?" and is published on the rollup-config endpoint as ``unavailable_kpis``
# (#2404). It has to be a *server* fact rather than a hard-coded client list:
# the settings picker offered all ten toggles as if they were live, so enabling
# one of these saved a config that could never render — a control that lies.
# The two cost KPIs left this map with the cost model (#754, ADR-1324; #3426):
# they now compute, or name the per-project data that is missing. ``p80_completion``
# left it with #4779: the persisted ``MonteCarloRun`` (ADR-0175) plus the cache entry
# are the store it waited on. Kept (empty) because the config endpoint publishes it
# and a future KPI without a source belongs here, not in a client list.
DEFERRED_KPI_REASONS: dict[str, str] = {}

# Why a configured figure has no value (rule 119, ADR-1314). Stable strings: the web
# layer and MCP clients branch on them.
REASON_NO_PROJECTS = "no_projects"  # the program has no contributing project
REASON_NO_PLANNED_WORK = "no_planned_work"  # no project has work planned by today
REASON_NO_MILESTONES = "no_milestones"  # no project has a milestone task
REASON_NO_BASELINE = "no_baseline"  # no project has an active baseline with dates
REASON_NO_COMPLETED_WORK = "no_completed_work"  # baselines exist, nothing baselined is done
REASON_NO_FORECAST = "no_forecast"  # no project has a Monte Carlo forecast with a P80

#: The ``forecast_staleness`` values that mean "this forecast no longer describes its
#: plan" (#3140). ``unknown`` (a run that cannot be placed) and ``current`` are not.
_STALE_FORECAST_STATES = frozenset({"aged", "project_changed", "engine_superseded"})

#: Each rollup KPI's key in METRIC_DEFINITIONS. Namespaced because two of the KPI
#: names (``schedule_health``) are also project-level figures with their own sentence.
ROLLUP_DEFINITION_KEY: dict[str, str] = {kpi.value: f"rollup.{kpi.value}" for kpi in RollupKpi}

_COST_KPIS = frozenset({RollupKpi.COST_VARIANCE.value, RollupKpi.BUDGET_UTILIZATION.value})

# Active task statuses (exclude COMPLETE) — "open work" for count KPIs. Mirrors
# the at-risk/critical definitions in ProjectViewSet.status_summary so the
# program rollup and the per-project StatusBar agree.
_ACTIVE_EXCLUDE = {TaskStatus.COMPLETE}

# Health band → ordinal for reducing (higher = healthier). ``unknown`` has no
# ordinal: it is excluded from the reduce rather than dragging the result down,
# which would punish projects that simply have no baseline yet.
_HEALTH_ORDINAL = {"critical": 0, "at_risk": 1, "on_track": 2}
_ORDINAL_TO_HEALTH = {0: "critical", 1: "at_risk", 2: "on_track"}


def compute_program_rollup(
    program: Program,
    *,
    exclude_project_ids: Collection[Any] | None = None,
    cost_viewer: Any = None,
    schedule_bands_out: dict[Any, str] | None = None,
) -> dict[str, Any]:
    """Compute the rolled-up KPI block for a program's overview (ADR-0088).

    Returns a dict with the program health dot, the active aggregation policy
    (and whether it could be honored), the contributing project count, and a
    ``kpis`` map keyed by the program's enabled :class:`RollupKpi` values. Each
    entry is either ``{"available": True, "value": ..., ["unit": ...]}`` (value
    may be ``None`` when a built KPI has no data yet, e.g. no active baseline) or
    ``{"available": False, "reason": ...}`` for a KPI hidden from the caller or
    missing per-project data (the cost KPIs). A configured figure with no value keeps
    its null (``unknown`` for a band) and carries a rule-119 ``reason``. The payload
    also carries ``as_of`` and a ``definitions`` map (ADR-1314, #4779).

    ``cost_viewer`` is the user the cost KPIs are computed for, passed only once the
    caller has established they are program Admin+ (ADR-1324 §4). A value is returned
    only if that user is ALSO project Admin+ on every contributing project: program
    roles do not cascade to projects, and a program total over projects the caller
    cannot see the budget of leaks it (one project: BAC = CV / (pc − util)). It
    defaults to ``None`` — fail closed — so a caller that forgets to decide gets
    ``cost_restricted`` entries, never a cost value. The same verdict gates
    ``weighted_by_budget``: a budget-weighted mean reveals the ratio of budgets, so a
    caller below it gets the average with ``policy_unavailable_reason:
    "cost_restricted"`` (see :func:`_policy_weights`). The weekly digest passes no
    ``cost_viewer``, so its health dot for a budget-weighted program is the average.

    ``schedule_bands_out``, when given, is filled with the per-project SPI bands this
    call already computed, so a caller that also renders per-project rows
    (:func:`program_project_rows`) does not pay for a second SPI query. The digest
    passes nothing and behaves as before.

    Pure read: deterministic for a given DB state (and Monte Carlo cache), no
    writes, safe to call on every GET.
    """
    as_of = timezone.now()
    today = timezone.localdate()
    policy = program.rollup_aggregation_policy or AggregationPolicy.WORST.value
    enabled = list(program.rollup_enabled_kpis or [])

    # Drafts are excluded (#2962): a plan nobody has committed to must not move a
    # number a PMO puts in front of a CEO. `visible_projects` is the single
    # definition of that exclusion — see lifecycle.py for why it is one helper
    # and not a filter repeated per surface.
    from trueppm_api.apps.projects.lifecycle import visible_projects

    project_qs = visible_projects(Project.objects.filter(program=program, is_deleted=False))
    if exclude_project_ids is not None:
        # ADR-0678 (#2482): a project that opted out of agent reads does not feed the
        # rolled-up KPIs an agent sees. ``contributing_project_count`` derives from this
        # set, so the response stays internally consistent — the agent is told how many
        # projects contributed, never that any were withheld.
        project_qs = project_qs.exclude(pk__in=exclude_project_ids)
    project_ids = list(project_qs.values_list("id", flat=True))

    # One verdict for both budget-derived outputs (ADR-1324 §4/§7): the cost KPIs AND
    # the budget weighting. Only checked when one of them is in play.
    sees_cost = (
        bool(_COST_KPIS.intersection(enabled))
        or policy == AggregationPolicy.WEIGHTED_BY_BUDGET.value
    ) and _sees_cost_of_every_project(cost_viewer, project_ids)
    effective_policy, policy_available, policy_unavailable_reason, task_weights = _policy_weights(
        policy, project_ids, sees_cost=sees_cost
    )
    cost_kpis = _cost_kpis(enabled, project_ids, sees_cost=sees_cost)

    # schedule_health per project is always needed: it is both a KPI and the
    # source of the headline program health dot (ADR-0088). Also drives the weekly
    # program-health digest.
    schedule_health_by_project = _schedule_health_by_project(project_ids, today)
    if schedule_bands_out is not None:
        schedule_bands_out.update(schedule_health_by_project)
    program_health = _reduce_health(
        list(schedule_health_by_project.values()), effective_policy, task_weights, project_ids
    )

    kpis = _kpi_entries(
        enabled,
        project_ids,
        today=today,
        policy=effective_policy,
        weights=task_weights,
        cost_kpis=cost_kpis,
        schedule_bands=schedule_health_by_project,
    )

    definitions = {"program_health": METRIC_DEFINITIONS["program_health"]}
    for kpi in kpis:
        key = ROLLUP_DEFINITION_KEY.get(kpi)
        if key is not None:
            definitions[kpi] = METRIC_DEFINITIONS[key]

    return {
        "aggregation_policy": policy,
        "policy_available": policy_available,
        "policy_unavailable_reason": policy_unavailable_reason,
        "project_count": len(project_ids),
        "program_health": program_health,
        # An unknown band says why (rule 119): no projects, or none has work planned.
        "program_health_reason": (
            None
            if program_health != "unknown"
            else (REASON_NO_PROJECTS if not project_ids else REASON_NO_PLANNED_WORK)
        ),
        "kpis": kpis,
        "as_of": as_of.isoformat(),
        "definitions": definitions,
    }


def _kpi_entries(
    enabled: list[str],
    project_ids: list[Any],
    *,
    today: datetime.date,
    policy: str,
    weights: dict[Any, float],
    cost_kpis: dict[str, dict[str, Any]],
    schedule_bands: dict[Any, str],
) -> dict[str, dict[str, Any]]:
    """One entry per enabled KPI, in config order; only the enabled ones are computed.

    A figure that is configured but has no value keeps its ``value`` (null, or
    ``unknown`` for a band) and carries a ``reason`` (rule 119, ADR-1314).
    """

    def band_entry(bands: dict[Any, str], reason_if_unknown: str) -> dict[str, Any]:
        value = _reduce_health([bands[pid] for pid in project_ids], policy, weights, project_ids)
        entry: dict[str, Any] = {"available": True, "value": value}
        if value == "unknown":
            entry["reason"] = REASON_NO_PROJECTS if not project_ids else reason_if_unknown
        return entry

    builders: dict[str, Callable[[], dict[str, Any]]] = {
        # The same per-project bands the headline program_health reduced: one SPI
        # pass serves both.
        RollupKpi.SCHEDULE_HEALTH.value: lambda: band_entry(schedule_bands, REASON_NO_PLANNED_WORK),
        RollupKpi.MILESTONE_HEALTH.value: lambda: band_entry(
            _milestone_health_by_project(project_ids, today), REASON_NO_MILESTONES
        ),
        RollupKpi.CRITICAL_TASKS.value: lambda: {
            "available": True,
            "value": _critical_task_total(project_ids),
        },
        RollupKpi.AT_RISK_TASKS.value: lambda: {
            "available": True,
            "value": _at_risk_task_total(project_ids),
        },
        RollupKpi.RISK_SCORE.value: lambda: {
            "available": True,
            "value": _risk_score_total(project_ids),
        },
        RollupKpi.BASELINE_VARIANCE.value: lambda: _variance_entry(
            _reduce_variance(_baseline_variance_by_project(project_ids), policy, weights),
            project_ids,
            completed_work_matters=False,
        ),
        RollupKpi.SCHEDULE_VARIANCE.value: lambda: _variance_entry(
            _reduce_variance(_schedule_variance_by_project(project_ids), policy, weights),
            project_ids,
            completed_work_matters=True,
        ),
        RollupKpi.P80_COMPLETION.value: lambda: p80_completion_entry(project_ids),
    }

    kpis: dict[str, dict[str, Any]] = {}
    for kpi in enabled:
        if kpi in DEFERRED_KPI_REASONS:
            kpis[kpi] = {"available": False, "reason": DEFERRED_KPI_REASONS[kpi]}
        elif kpi in cost_kpis:
            kpis[kpi] = cost_kpis[kpi]
        elif kpi in builders:
            kpis[kpi] = builders[kpi]()

    # Rule 119 backstop: a configured figure with no value on an empty program says
    # so (the cost totals return a null value with no reason for that case).
    if not project_ids:
        for entry in kpis.values():
            if entry.get("available") and entry.get("value") is None and "reason" not in entry:
                entry["reason"] = REASON_NO_PROJECTS
    return kpis


def _variance_entry(
    value: float | None, project_ids: list[Any], *, completed_work_matters: bool
) -> dict[str, Any]:
    """A day-variance KPI entry, with the rule-119 reason when it has no value.

    The reason costs one indexed query, run only on the null path: whether any
    contributing project has an active baseline with dates. Without one the
    comparison has no basis (``no_baseline``); with one, a null schedule variance
    means no baselined task is complete yet (``no_completed_work``).
    """
    entry: dict[str, Any] = {"available": True, "unit": "calendar_days", "value": value}
    if value is not None:
        return entry
    if not project_ids:
        entry["reason"] = REASON_NO_PROJECTS
        return entry
    has_baseline = Baseline.objects.filter(
        project_id__in=project_ids, is_active=True, is_deleted=False, has_cpm_dates=True
    ).exists()
    entry["reason"] = (
        REASON_NO_COMPLETED_WORK if has_baseline and completed_work_matters else REASON_NO_BASELINE
    )
    return entry


def p80_completion_entry(project_ids: list[Any]) -> dict[str, Any]:
    """The ``p80_completion`` KPI: the latest project P80 across the program.

    Each project's P80 is the latest result ``GET /projects/{id}/monte-carlo/latest/``
    serves — the cache entry first, the newest persisted ``MonteCarloRun`` after its
    TTL — so the program figure cannot disagree with the project forecast it names
    (ADR-1314). A Member-triggered run refreshes only the cache (#1502), which is why
    the cache is read at all.

    The latest of the per-project P80s, not a joint simulation: the program finishes
    no earlier than its latest project, so a joint P80 would be this date or later.
    The policy does not apply — a mean of finish dates is not a completion date.

    ``as_of`` is the OLDEST ``last_run_at`` among the forecasts read: the figure is
    only as current as its stalest input. ``projects_without_forecast`` counts the
    contributing projects with no forecast (or none with a P80); they are left out
    rather than blanking the figure, and the count is what lets a client say so.
    Null with ``reason: no_forecast`` when no project has one (rule 119).

    ``projects_with_stale_forecast`` counts (and ``..._ids`` names) the forecasts the
    figure read that no longer describe their project's plan: the run predates a plan
    change or a recalc, is older than ``risk_premium.STALE_AFTER_DAYS``, or came from a
    superseded engine. The classification is the one every project forecast surface
    ships (:func:`~trueppm_api.apps.scheduling.forecast_staleness.forecast_staleness_facts`,
    #3140), so the program cannot call a forecast stale that the project page calls
    current, or the reverse. A stale forecast stays IN the figure: dropping it would
    silently move the date, and the PM's remedy (rerun it) is the same either way. A run
    that cannot be placed against its plan (``unknown``) is not counted — that is not
    evidence it is stale.

    ``percentiles`` carries the program P50, P80 and P95 (#2408): the latest of each
    percentile over the same runs, each with its own driver and its own left-out
    projects (:func:`_percentile_entry`). ``percentiles.p80`` repeats the top-level
    figure so a client can render the range from one shape. No extra query: the reader
    already returns all three.

    The per-project read is :func:`metric_provenance.latest_forecast_by_project`,
    the batched reader My Work's ship date also uses, so the rollup cannot read the
    owner's order differently from it. Fixed cost: one ``get_many`` cache read, at
    most one ``DISTINCT ON`` query, and one project-row read for the staleness inputs.
    """
    from trueppm_api.apps.projects.metric_provenance import latest_forecast_by_project
    from trueppm_api.apps.scheduling.forecast_staleness import forecast_staleness_for_payload

    entry: dict[str, Any] = {
        "available": True,
        "unit": "date",
        "value": None,
        "as_of": None,
        "driver_project_id": None,
        "projects_without_forecast": len(project_ids),
        "projects_without_forecast_ids": sorted(str(pid) for pid in project_ids),
        "projects_with_stale_forecast": 0,
        "projects_with_stale_forecast_ids": [],
        "percentiles": {q: _percentile_entry(q, {}, project_ids) for q in _PERCENTILES},
    }
    if not project_ids:
        entry["reason"] = REASON_NO_PROJECTS
        return entry

    latest = latest_forecast_by_project(project_ids)
    # Every entry the helper returns has a P80 and a last_run_at: the only cache
    # writer, ``scheduling.views.run_monte_carlo``, always sets it, and a persisted
    # run has ``taken_at``. Parsed, because the cache and the row serialize the
    # timestamp differently and the oldest must be found by time, not by string.
    dated = [
        (row["p80"], datetime.datetime.fromisoformat(row["last_run_at"]), pid)
        for pid, row in latest.items()
    ]
    if latest:
        plans = {
            str(pk): (version, recalculated_at)
            for pk, version, recalculated_at in Project.objects.filter(
                pk__in=list(latest)
            ).values_list("pk", "last_sync_version", "recalculated_at")
        }
        today = timezone.localdate()
        stale_ids = []
        for pid, row in latest.items():
            version_now, recalculated_at = plans.get(pid, (None, None))
            # The payload form, as ``monte-carlo/latest/`` uses: it ``_parse_int``s the
            # run's plan_version / engine_epoch, so a malformed cache value reads as
            # ``unknown`` on both pages instead of being compared here (a bool is an
            # int to Python, and ``True != 7`` would call the forecast stale).
            state = forecast_staleness_for_payload(
                row,
                plan_version_current=version_now,
                recalculated_at=recalculated_at,
                today=today,
            )["forecast_staleness"]
            if state in _STALE_FORECAST_STATES:
                stale_ids.append(pid)
        entry["projects_with_stale_forecast"] = len(stale_ids)
        entry["projects_with_stale_forecast_ids"] = sorted(stale_ids)
    entry["projects_without_forecast"] = len(project_ids) - len(dated)
    # #4799: the ids, not just the count, so the partial-rollup line can name the
    # project the program P80 leaves out. Sorted for a stable payload.
    entry["projects_without_forecast_ids"] = sorted(
        str(pid) for pid in project_ids if str(pid) not in latest
    )
    if not dated:
        entry["reason"] = REASON_NO_FORECAST
        return entry
    # Latest P80 first; a tie names the project deterministically (by id).
    p80, _, driver = max(dated, key=lambda d: (d[0], d[2]))
    entry["value"] = p80.isoformat()
    entry["driver_project_id"] = driver
    entry["as_of"] = min(run_at for _, run_at, _ in dated).isoformat()
    entry["percentiles"] = {q: _percentile_entry(q, latest, project_ids) for q in _PERCENTILES}
    return entry


#: The percentiles the program forecast range carries, low to high (#2408).
_PERCENTILES = ("p50", "p80", "p95")


def _percentile_entry(
    quantile: str, latest: dict[str, dict[str, Any]], project_ids: list[Any]
) -> dict[str, Any]:
    """One program percentile: the latest of that percentile across the projects' runs.

    The same reducer as the P80, over the same runs (each project's newest result), and
    policy-independent for the same reason. Each percentile carries its own driver and
    its own coverage because they can differ: the project with the latest P50 need not
    be the one with the latest P95, and a persisted run whose P95 column is null counts
    toward the P80 but not the P95. ``projects_without_ids`` is every contributing
    project this percentile leaves out, so a reader can see when the three figures rest
    on different project sets instead of reading them as one distribution.

    None of the three is a joint probability: each is the latest of per-project
    marginals, a lower bound on the program's own percentile (ADR-0088 amendment
    2026-11-27). Visibility matches ``projects_without_forecast_ids``: every program
    member sees every contributing project's id.
    """
    dated = [(row[quantile], pid) for pid, row in latest.items() if row.get(quantile) is not None]
    without = sorted(str(pid) for pid in project_ids if str(pid) not in {p for _, p in dated})
    value, driver = max(dated) if dated else (None, None)
    return {
        "value": value.isoformat() if value is not None else None,
        "driver_project_id": driver,
        "projects_without": len(without),
        "projects_without_ids": without,
    }


def program_summary(project_ids: list[Any], schedule_bands: dict[Any, str]) -> dict[str, int]:
    """The overview's supporting-tile counts for one program's projects (#4799).

    Server facts rather than client tallies (ADR-0599): the page lays them out and
    counts nothing itself. ``project_ids`` is the projects the CALLER can access (the
    rows with ``accessible: True``), not every project in the program: program roles do
    not grant a project's figures (ADR-1324 §4), and a count over a project whose row
    is redacted would let a caller recover its band or risk count by subtraction. The
    ``projects_in_scope_count`` it returns is the matching denominator. Intra-program
    only (ADR-0070): a dependency counts only when both endpoints are in ``project_ids``.
    """
    from trueppm_api.apps.projects.models import Dependency

    bands = {str(k): v for k, v in schedule_bands.items()}
    on_track = sum(1 for pid in project_ids if bands.get(str(pid)) == "on_track")
    risks = Risk.objects.filter(
        project_id__in=project_ids,
        is_deleted=False,
        status__in=[RiskStatus.OPEN, RiskStatus.MITIGATING],
    ).count()
    links = (
        Dependency.objects.filter(
            is_deleted=False,
            pending_acceptance=False,
            predecessor__project_id__in=project_ids,
            successor__project_id__in=project_ids,
        )
        .exclude(predecessor__project_id=F("successor__project_id"))
        .count()
        if project_ids
        else 0
    )
    return {
        "projects_in_scope_count": len(project_ids),
        "projects_on_track": on_track,
        "open_risk_count": risks,
        "cross_project_link_count": links,
    }


def program_project_rows(
    program: Program,
    *,
    accessible_project_ids: Collection[Any],
    exclude_project_ids: Collection[Any] | None = None,
    schedule_bands: dict[Any, str] | None = None,
) -> list[dict[str, Any]]:
    """One row per contributing project for the program overview (#4799).

    The same project set :func:`compute_program_rollup` reduces (``visible_projects``
    minus ``exclude_project_ids``), so the rows and the program figures speak about
    the same projects. Every figure is read from its owner (ADR-1314): the forecast
    through :func:`metric_provenance.latest_forecast_by_project` (the reader
    ``p80_completion`` uses, so a row cannot disagree with the program P80 it feeds),
    the commitment and its delta through :func:`forecast_commitment_facts`, the
    schedule band through :func:`_schedule_health_by_project`, and the PM's call from
    the latest posted :class:`StatusUpdate`.

    ``accessible_project_ids`` is the set of projects the caller holds a live
    membership on. Program roles do not cascade to projects (ADR-1324 §4), so a
    project the caller is not a member of keeps only its id and name (``accessible: False``): the
    status update narrative in particular is readable only by project members.

    Sorted by slip: the largest ``p80_delta_vs_commitment_days`` first, then the rows
    with no delta, then by name. Cost: one forecast cache round trip and at most one
    DISTINCT ON run query, one SPI query, one DISTINCT ON status-update query, plus
    the commitment read per accessible project (its active baseline, and its calendar
    only when a delta is measured).
    """
    from trueppm_api.apps.projects.lifecycle import visible_projects
    from trueppm_api.apps.projects.metric_provenance import (
        forecast_commitment_facts,
        latest_forecast_by_project,
    )
    from trueppm_api.apps.projects.models import StatusUpdate
    from trueppm_api.apps.projects.status_update_services import _calendar_for
    from trueppm_api.apps.workspace.serializers import display_name_for

    qs = visible_projects(Project.objects.filter(program=program, is_deleted=False))
    if exclude_project_ids is not None:
        qs = qs.exclude(pk__in=exclude_project_ids)
    projects = list(qs.select_related("program", "lead").order_by("name", "id"))
    readable_ids = [p.id for p in projects if p.id in accessible_project_ids]
    readable_set = set(readable_ids)

    forecasts = latest_forecast_by_project(readable_ids)
    # Reuse the rollup's own bands when the caller has them (same project set).
    bands = (
        schedule_bands
        if schedule_bands is not None and readable_set <= schedule_bands.keys()
        else _schedule_health_by_project(readable_ids, timezone.localdate())
    )
    latest_updates = {
        u.project_id: u
        for u in StatusUpdate.objects.filter(project_id__in=readable_ids)
        .select_related("author")
        .order_by("project_id", "-seq")
        .distinct("project_id")
    }

    rows: list[dict[str, Any]] = []
    for project in projects:
        row: dict[str, Any] = {
            "id": str(project.id),
            "name": project.name,
            "accessible": False,
            "schedule_health": None,
            "p50": None,
            "p80": None,
            "forecast_as_of": None,
            "commitment_date": None,
            "p80_delta_vs_commitment_days": None,
            "p80_delta_vs_commitment_reason": None,
            "lead_name": None,
            "latest_update": None,
        }
        if project.id in readable_set:
            forecast = forecasts.get(str(project.id))
            p80 = forecast["p80"] if forecast else None
            facts = forecast_commitment_facts(
                project,
                p80=p80,
                p80_at_day_start=forecast["p80_at_day_start"] if forecast else None,
                calendar_for=_calendar_for(project),
            )
            lead = project.lead
            update = latest_updates.get(project.id)
            row.update(
                {
                    "accessible": True,
                    "schedule_health": bands.get(project.id, "unknown"),
                    "p50": forecast["p50"].isoformat() if forecast and forecast["p50"] else None,
                    "p80": p80.isoformat() if p80 else None,
                    "forecast_as_of": forecast["last_run_at"] if forecast else None,
                    "commitment_date": facts["commitment_date"],
                    "p80_delta_vs_commitment_days": facts["p80_delta_vs_commitment_days"],
                    "p80_delta_vs_commitment_reason": facts["p80_delta_vs_commitment_reason"],
                    "lead_name": (
                        display_name_for(lead.first_name, lead.last_name, lead.username)
                        if lead is not None
                        else None
                    ),
                    "latest_update": (
                        {
                            "id": str(update.id),
                            "seq": update.seq,
                            "rag": update.rag,
                            "computed_health": update.computed_health,
                            "first_line": update.narrative.split("\n", 1)[0].strip(),
                            "author_name": (
                                display_name_for(
                                    update.author.first_name,
                                    update.author.last_name,
                                    update.author.username,
                                )
                                if update.author is not None
                                else None
                            ),
                            "posted_at": update.posted_at.isoformat(),
                        }
                        if update is not None
                        else None
                    ),
                }
            )
        rows.append(row)

    def slip_key(row: dict[str, Any]) -> tuple[int, int, str]:
        delta = row["p80_delta_vs_commitment_days"]
        return (0 if delta is not None else 1, -(delta or 0), row["name"].lower())

    rows.sort(key=slip_key)
    return rows


def _policy_weights(
    policy: str, project_ids: list[Any], *, sees_cost: bool
) -> tuple[str, bool, str | None, dict[Any, float]]:
    """Resolve ``(effective_policy, policy_available, reason, weights)`` for the reduce.

    ``weighted_by_budget`` weights by ``Project.budget`` (ADR-1324). Every contributing
    project needs one — weighting the budgeted subset would silently drop the rest
    from the program health dot — so a single missing budget degrades to AVERAGE with
    ``no_budget``. An empty program has nothing to weight, so the policy is trivially
    honored. Every other policy weights by committed (non-BACKLOG) task counts, which
    only ``task_weighted`` reads; a large grooming backlog does not skew it.

    A caller who may not see every contributing project's budget (``sees_cost``
    False) gets AVERAGE with ``cost_restricted`` — checked BEFORE the budgets are
    read, so the reason is the same whether or not any budget is set. A budget-
    weighted mean leaks the ratio of budgets (b1/b2 = (v − v2)/(v1 − v)), so with one
    budget known (a PM of one project) it yields the other; and ``no_budget`` would
    tell any member whether every project has a budget.
    """
    if policy == AggregationPolicy.WEIGHTED_BY_BUDGET.value:
        if not sees_cost:
            from trueppm_api.apps.projects.cost import REASON_COST_RESTRICTED

            return AggregationPolicy.AVERAGE.value, False, REASON_COST_RESTRICTED, {}
        budgets = dict(Project.objects.filter(id__in=project_ids).values_list("id", "budget"))
        if all((budgets.get(pid) or 0) > 0 for pid in project_ids):
            return policy, True, None, {pid: float(budgets[pid] or 0) for pid in project_ids}
        return AggregationPolicy.AVERAGE.value, False, "no_budget", {}
    counts = _committed_task_counts(project_ids)
    return policy, True, None, {pid: float(c) for pid, c in counts.items()}


def _sees_cost_of_every_project(user: Any, project_ids: list[Any]) -> bool:
    """``user`` holds live project ADMIN+ on every id in ``project_ids`` (ADR-1324 §4).

    The project half of the rollup's cost gate. The non-request twin of
    ``ProjectSerializer._caller_sees_cost``: live, non-revoked membership on a
    non-trashed project (the ``live_member_project_ids`` floor), at ADMIN or above.
    One query. An empty program is vacuously visible — its totals are null.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role

    if user is None or not getattr(user, "is_authenticated", False):
        return False
    if not project_ids:
        return True
    admin_of = set(
        ProjectMembership.live()
        .filter(
            user=user,
            project_id__in=project_ids,
            project__is_deleted=False,
            role__gte=Role.ADMIN,
        )
        .values_list("project_id", flat=True)
    )
    return admin_of >= set(project_ids)


def _cost_kpis(
    enabled: list[str], project_ids: list[Any], *, sees_cost: bool
) -> dict[str, dict[str, Any]]:
    """The two cost KPI entries, computed only when one is enabled (ADR-1324 §3–§4)."""
    if not _COST_KPIS.intersection(enabled):
        return {}
    from trueppm_api.apps.projects.cost import (
        REASON_COST_RESTRICTED,
        program_cost_kpis,
        project_cost_facts,
    )

    if not sees_cost:
        return {k: {"available": False, "reason": REASON_COST_RESTRICTED} for k in _COST_KPIS}
    from trueppm_api.apps.workspace.models import Workspace

    return program_cost_kpis(project_cost_facts(project_ids).values(), Workspace.load().currency)


#: Why a program's cost health has no band. ``cost_restricted``, ``no_budget`` and
#: ``missing_rates`` are the cost KPIs' own reasons (ADR-1324 §3); this one is the
#: program policy: neither cost KPI is in ``rollup_enabled_kpis``.
REASON_COST_NOT_CONFIGURED = "not_configured"


def cost_health_band(kpis: dict[str, dict[str, Any]]) -> str:
    """Classify a program's cost into a health band from its two cost KPI entries.

    Pure comparison over the values the rollup already returns, so a caller holding
    the rollup can reproduce it (ADR-1324 digest addendum): ``critical`` when budget utilization is
    above 1 (actual cost exceeds the budget), ``at_risk`` when cost variance is
    negative (spend is ahead of earned value), otherwise ``on_track``. No tunable
    threshold: each band is an inequality the overview's own figures already state.
    ``unknown`` when either entry is unavailable or the program has no contributing
    project (a null value).
    """
    cv = kpis.get(RollupKpi.COST_VARIANCE.value) or {}
    util = kpis.get(RollupKpi.BUDGET_UTILIZATION.value) or {}
    if not (cv.get("available") and util.get("available")):
        return "unknown"
    if cv.get("value") is None or util.get("value") is None:
        return "unknown"
    if float(util["value"]) > 1.0:
        return "critical"
    if Decimal(str(cv["value"])) < 0:
        return "at_risk"
    return "on_track"


def program_cost_health(program: Program, *, cost_viewer: Any = None) -> dict[str, Any]:
    """Return ``{"band": str | None, "reason": str | None}`` for *program*'s cost.

    The digest's cost line (ADR-1324 digest addendum, #4850). Same contract as
    :func:`compute_program_rollup`'s ``cost_viewer``: pass the user only once they are
    established program Admin+, and they must also be project Admin+ on every
    contributing project. The checks run in an order that discloses nothing to a
    recipient who fails one: the program policy first (any program member can read
    ``rollup_enabled_kpis``), then the cost floor, both before any budget is read.
    Only a recipient who passes both learns ``no_budget`` / ``missing_rates`` or a band.
    """
    enabled = list(program.rollup_enabled_kpis or [])
    if not _COST_KPIS.intersection(enabled):
        return {"band": None, "reason": REASON_COST_NOT_CONFIGURED}
    from trueppm_api.apps.projects.cost import REASON_COST_RESTRICTED
    from trueppm_api.apps.projects.lifecycle import visible_projects

    if cost_viewer is None:
        return {"band": None, "reason": REASON_COST_RESTRICTED}
    project_ids = list(
        visible_projects(Project.objects.filter(program=program, is_deleted=False)).values_list(
            "id", flat=True
        )
    )
    if not _sees_cost_of_every_project(cost_viewer, project_ids):
        return {"band": None, "reason": REASON_COST_RESTRICTED}
    # Both entries are computed regardless of which one is enabled: the band needs
    # both, and the recipient is entitled to both (one gate covers the pair, §4).
    kpis = _cost_kpis(list(_COST_KPIS), project_ids, sees_cost=True)
    for entry in kpis.values():
        if not entry.get("available"):
            return {"band": None, "reason": entry.get("reason")}
    band = cost_health_band(kpis)
    return {"band": band, "reason": REASON_NO_PROJECTS if band == "unknown" else None}


def top_contributing_project(program: Program) -> dict[str, Any] | None:
    """Return the project dragging ``program``'s health down, or ``None``.

    "Top contributing" = worst :func:`_schedule_health_by_project` band, tie-broken
    by the larger count of open critical-path tasks, then by name for stability.
    Lives here rather than in the digest builder (ADR-0663) so it reuses the *same*
    per-project bands the Program Overview renders — a digest that named a different
    project than the screen it deep-links to would be worse than no digest at all.

    Returns ``{"id", "name", "health"}`` for the worst project, or ``None`` when the
    program has no projects or every project's band is ``unknown`` (no data to
    attribute the program's state to).
    """
    today = timezone.localdate()
    # Drafts are excluded (#2962/#3128) for the same reason as compute_program_rollup
    # above, and one more: this function names ONE project in the weekly program-health
    # email. Attributing a program's health to a plan nobody has committed to would
    # deep-link a PMO into a half-built schedule and call it the cause.
    from trueppm_api.apps.projects.lifecycle import visible_projects

    project_ids = list(
        visible_projects(Project.objects.filter(program=program, is_deleted=False)).values_list(
            "id", flat=True
        )
    )
    if not project_ids:
        return None

    bands = _schedule_health_by_project(project_ids, today)
    ranked = [(pid, band) for pid, band in bands.items() if band in _HEALTH_ORDINAL]
    if not ranked:
        return None

    # Leaf rows only (#4276): a phase's `is_critical` is a rollup of its children
    # (ADR-0024/ADR-0293, `_rollup_one_summary`), not a fact about the phase row
    # itself, so counting the phase on top of the leaf whose value it rolled up
    # double-counts that leaf and can tip the worst-project tie-break. See
    # task_is_phase_expr's docstring.
    critical_counts = {
        r["project_id"]: r["c"]
        for r in (
            Task.objects.filter(project_id__in=project_ids, is_deleted=False, is_critical=True)
            .exclude(status__in=_ACTIVE_EXCLUDE)
            .annotate(_is_phase=task_is_phase_expr())
            .filter(_is_phase=False)
            .values("project_id")
            .annotate(c=Count("id"))
        )
    }
    names = dict(Project.objects.filter(id__in=project_ids).values_list("id", "name"))

    # Sort by (health ordinal asc = worst first, critical count desc, name asc).
    ranked.sort(
        key=lambda pair: (
            _HEALTH_ORDINAL[pair[1]],
            -critical_counts.get(pair[0], 0),
            names.get(pair[0], ""),
        )
    )
    worst_id, worst_band = ranked[0]
    return {"id": worst_id, "name": names.get(worst_id, ""), "health": worst_band}


# ---------------------------------------------------------------------------
# Per-project metric maps (grouped queries — no per-project loop)
# ---------------------------------------------------------------------------


def _committed_task_counts(project_ids: list[Any]) -> dict[Any, int]:
    """project_id → committed-work (``Task.committed``) task count, for weighting."""
    if not project_ids:
        return {}
    rows = (
        Task.committed.filter(project_id__in=project_ids, is_deleted=False)
        .values("project_id")
        .annotate(c=Count("id"))
    )
    return {r["project_id"]: r["c"] for r in rows}


def task_is_phase_expr() -> RawSQL:
    """Boolean expression: this task row is a phase (has a structural child).

    A phase's status, percent, and dates are a rollup of its children and are
    never set directly (ADR-0293), so the *stored* ``status`` on a phase row is
    not a fact about the work — a seeded or imported phase sits at
    ``NOT_STARTED`` while every child is done. Any count that reads ``status``
    must therefore count leaf work only, or a phase whose children are all
    complete reads as late (#4238). Same ltree shape as the ``is_phase``
    annotation on the task list; subtask children do not make a phase.
    """
    # nosemgrep: avoid-raw-sql — static SQL literal, no params interpolated.
    return RawSQL(
        "EXISTS("
        "  SELECT 1 FROM projects_task c"
        "  WHERE c.project_id = projects_task.project_id"
        "    AND c.is_deleted = false"
        "    AND c.is_subtask = false"
        "    AND c.id != projects_task.id"
        "    AND c.wbs_path IS NOT NULL"
        "    AND projects_task.wbs_path IS NOT NULL"
        "    AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{1}')::lquery"
        ")",
        [],
        output_field=BooleanField(),
    )


def task_has_committed_child_expr() -> RawSQL:
    """Boolean expression: this task row has a structural child in ``Task.committed``.

    The earned-value phase probe (ADR-1447). :func:`task_is_phase_expr` counts any
    live structural child, so a committed task whose only children are BACKLOG or EPIC
    rows reads as a phase there — and earned value, which drops phases as rollups of
    their children, would then drop that task's own work, while the children it was
    "rolled up from" are themselves outside the committed set. Here a child counts only
    if it is committed delivery: the same four exclusions as ``CommittedTaskManager``
    (not deleted, not BACKLOG, not EPIC, not recurring).
    """
    from trueppm_api.apps.projects.models import TaskStatus, TaskType

    # nosemgrep: avoid-raw-sql — static SQL literal; the two params are enum values.
    return RawSQL(
        "EXISTS("
        "  SELECT 1 FROM projects_task c"
        "  WHERE c.project_id = projects_task.project_id"
        "    AND c.is_deleted = false"
        "    AND c.is_subtask = false"
        "    AND c.is_recurring = false"
        "    AND c.status != %s"
        "    AND c.type != %s"
        "    AND c.id != projects_task.id"
        "    AND c.wbs_path IS NOT NULL"
        "    AND projects_task.wbs_path IS NOT NULL"
        "    AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{1}')::lquery"
        ")",
        [TaskStatus.BACKLOG.value, TaskType.EPIC.value],
        output_field=BooleanField(),
    )


# The leaf-descendant, delivery-mode-aware weighted percent the task API serves as a
# summary row's ``percent_complete`` (ADR-0108 §1; see the annotation in
# ``views.TaskViewSet``). ``{scope}`` narrows which descendants count and ``{depth}``
# how far below the row they may sit (an lquery quantifier).
_PERCENT_ROLLUP_SQL = (
    "("
    "  SELECT CASE WHEN SUM(w.weight) > 0"
    "              THEN SUM(w.weight * w.pct) / SUM(w.weight)"
    "              ELSE NULL END"
    "  FROM ("
    "    SELECT"
    "      CASE c.delivery_mode"
    "        WHEN 'scrum' THEN COALESCE(c.story_points, c.duration)"
    "        WHEN 'kanban' THEN 1"
    "        WHEN 'milestone' THEN 0"
    "        ELSE c.duration"
    "      END AS weight,"
    "      CASE c.delivery_mode"
    "        WHEN 'scrum' THEN"
    "          CASE WHEN c.status = 'COMPLETE' THEN 100.0"
    "               WHEN COALESCE(c.story_points, 0) > 0"
    "                 THEN (1.0 - COALESCE(c.remaining_points, c.story_points)::float"
    "                              / c.story_points) * 100.0"
    "               ELSE c.percent_complete END"
    "        WHEN 'kanban' THEN"
    "          CASE WHEN c.status = 'COMPLETE' THEN 100.0 ELSE 0.0 END"
    "        WHEN 'milestone' THEN"
    "          CASE WHEN c.status = 'COMPLETE' THEN 100.0 ELSE 0.0 END"
    "        ELSE c.percent_complete"
    "      END AS pct"
    "    FROM projects_task c"
    "    WHERE c.project_id = projects_task.project_id"
    "      AND c.is_deleted = false"
    "{scope}"
    "      AND projects_task.wbs_path IS NOT NULL"
    "      AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{depth}')::lquery"
    "      AND NOT EXISTS ("
    "        SELECT 1 FROM projects_task gc"
    "        WHERE gc.project_id = projects_task.project_id"
    "          AND gc.is_deleted = false"
    "          AND gc.wbs_path ~ (c.wbs_path::text || '.*{{1}}')::lquery"
    "      )"
    "  ) w"
    ")"
)


def task_percent_complete_rollup_expr(*, subtasks_only: bool = False) -> RawSQL:
    """Float expression: the weighted percent of this row's leaf descendants, or NULL.

    The one definition of the rollup the task API serves in place of a summary row's
    stored ``percent_complete`` (``TaskSerializer.to_representation``). Nothing writes
    it back to the row, so any aggregate that reads a parent's progress must read
    this, not the stored column, or it reads a value no screen shows.

    ``subtasks_only`` restricts the descendants to the row's own subtasks: earned value
    (ADR-1447) takes a non-phase leaf's progress from its subtasks the way the task API
    does, without letting an uncommitted structural child (a BACKLOG or EPIC row under
    the leaf) move it. That needs the *direct* children only, not just
    ``is_subtask``: a subtask is always created as a direct child of its parent and
    cannot have subtasks of its own (ADR-0060 depth-1), so a subtask two levels down
    belongs to an intermediate row — and when that row is a BACKLOG child, counting
    its subtask would let uncommitted work move the grandparent's EV. NULL when there
    is no such descendant, or their weights sum to 0 — the caller then falls back to
    the stored percent, as the serializer does.

    The default (``subtasks_only=False``) renders the exact SQL the task API serves.
    """
    if subtasks_only:
        scope, depth = "      AND c.is_subtask = true", "{1}"
    else:
        scope, depth = "", "{1,}"
    # `scope`/`depth` are picked from two fixed literals above, never user input.
    # nosemgrep: avoid-raw-sql — static SQL literal, no params interpolated.
    return RawSQL(
        _PERCENT_ROLLUP_SQL.format(scope=scope, depth=depth),  # nosec B611
        [],
        output_field=FloatField(),
    )


def drift_counts_by_project(
    project_ids: Collection[Any], today: datetime.date
) -> dict[Any, tuple[int, int]]:
    """project_id → ``(overdue_count, at_risk_count)`` for the program's project roster.

    Same semantics as ``ProgramViewSet.projects`` (#560): incomplete tasks only
    (``status`` != COMPLETE), leaf rows only. A phase's ``total_float`` and
    ``early_finish`` are rollups of its children
    (``scheduling.services._rollup_one_summary``) — not facts about the phase row
    itself (ADR-0024/ADR-0293) — so counting the phase on top of the leaf whose
    value it rolled up double-counts that leaf (#4276). See :func:`task_is_phase_expr`.

    Built as a grouped query over ``Task`` rather than a reverse-FK
    ``Count("tasks", filter=...)`` annotation — or a per-row correlated
    ``Subquery`` — on a ``Project`` queryset, for the same reason as
    :func:`risk_counts_by_project`: :func:`task_is_phase_expr`'s ``RawSQL`` names
    its own FROM table (``projects_task``) literally, and that bare name is not
    guaranteed once more than one reference to ``Task`` shares the same compiled
    statement. A *joined* reverse-FK Count aliases the join; a *second*
    correlated ``Subquery`` over ``Task`` in the same ``.annotate()`` call hits
    the identical problem the other way (Django assigns ``U0``/``U1`` to
    disambiguate the two subqueries' own FROM clauses) — confirmed by a failing
    ``invalid reference to FROM-clause entry for table "projects_task"`` when
    ``overdue_count`` and ``at_risk_count`` were each tried as their own
    Subquery here. Keeping ``Task`` as the base model of one standalone query,
    same shape as :func:`spi_counts_by_project`/:func:`risk_counts_by_project`,
    side-steps both failure modes.

    Projects with no qualifying leaf work are absent from the dict — callers
    read with ``.get(pid, (0, 0))``.
    """
    if not project_ids:
        return {}
    incomplete = ~Q(status=TaskStatus.COMPLETE)
    # Task.committed, not Task.objects: backlog cards, epics and recurring templates
    # carry no schedule (ADR-1152), so they can be neither overdue nor at risk. This is
    # the same population as the project overview's late count (#3676).
    rows = (
        Task.committed.filter(project_id__in=list(project_ids), is_deleted=False)
        .filter(incomplete)
        # Narrow before the correlated is_phase EXISTS runs (same reasoning as
        # risk_counts_by_project's round-2 fix, #4250): a row that cannot
        # contribute to either Count below no matter what _is_phase turns out
        # to be is excluded first, so the per-row ltree EXISTS only runs for
        # rows whose answer can matter.
        .filter(Q(early_finish__lt=today) | (Q(total_float__isnull=False) & Q(total_float__lte=5)))
        .annotate(_is_phase=task_is_phase_expr())
        .filter(_is_phase=False)
        .values("project_id")
        .annotate(
            overdue=Count("id", filter=Q(early_finish__lt=today)),
            at_risk=Count("id", filter=Q(total_float__isnull=False) & Q(total_float__lte=5)),
        )
    )
    return {r["project_id"]: (r["overdue"], r["at_risk"]) for r in rows}


def spi_counts_by_project(
    project_ids: Collection[Any], today: datetime.date
) -> dict[Any, tuple[int, int]]:
    """project_id → ``(planned, planned_complete)`` for the SPI proxy.

    The single source for both the project overview card
    (``_project_spi_and_health``) and the program rollup, so the two can never
    disagree about the same project.

    **Baseline path — EVM semantics (#398), ``has_cpm_dates=True`` only (#4242).**
    ``planned`` is the active baseline's rows with ``finish <= today``;
    ``planned_complete`` is *every* task complete by today. The numerator is
    deliberately wider than the denominator: work finished ahead of its baselined
    date is earned value, so SPI can exceed 1.0. This path requires the active
    baseline to carry real dates: a baseline captured with ``has_cpm_dates=False``
    (snapshot taken before the CPM engine first ran, see :class:`Baseline`) has
    mostly-or-entirely null ``BaselineTask.finish`` rows, which collapses
    ``planned`` toward zero while ``planned_complete`` still counts every real
    completion project-wide — an on-track-looking ratio over a near-empty
    denominator next to a project that also reports late tasks (the hosted demo's
    "GTM Readiness"/"Platform Core" symptom). A ``has_cpm_dates=False`` baseline is
    therefore excluded from this path entirely (see the ``active_baseline`` query
    below) and such a project falls through to the no-baseline path instead, per
    the maintainer decision recorded on #4242: there is no fixed plan to be ahead
    of until a baseline has real CPM dates.

    **No-baseline path — one task set (#4238).** Both counts come from the *same*
    rows: live leaf tasks (phase rows excluded, see :func:`task_is_phase_expr`)
    whose CPM ``early_finish <= today``, and of those, the ones complete by today.
    Without a (usable) baseline there is no fixed plan to be ahead of — the
    reference is the live CPM forecast, and a COMPLETE task is pinned to its
    actuals on the next run. A complete task *outside* that window therefore has a
    null or stale ``early_finish``, not an ahead-of-plan finish, and counting it in
    the numerator let it cancel out genuinely late rows: the overview read
    ``on_track`` / ``spi=1.0`` in a project that also reported late tasks. Scoped
    this way the ratio cannot exceed 1.0 and drops for exactly the rows
    ``tasks_late_count`` counts (the same ``early_finish`` reference). A project
    whose active baseline has ``has_cpm_dates=False`` is routed here too (#4242),
    so the same cap applies to it.

    A null ``actual_finish`` on a COMPLETE task still counts as complete by today —
    keying on ``actual_finish`` stops a late completion masquerading as on-time,
    but a missing stamp is not evidence of lateness.

    Projects with no planned-by-today work are absent from the result.
    """
    if not project_ids:
        return {}
    complete_by_today = Q(status=TaskStatus.COMPLETE) & (
        Q(actual_finish__lte=today) | Q(actual_finish__isnull=True)
    )

    # Active baseline per project (at most one — is_active is a per-project flag).
    # has_cpm_dates=True only (#4242): a baseline snapshotted before CPM first ran
    # has mostly-or-entirely null BaselineTask.finish, so it is not a usable EVM
    # plan — see the docstring above. A has_cpm_dates=False active baseline is
    # therefore treated as if the project had no active baseline at all, which
    # routes it into the no_baseline path below.
    active_baseline = dict(
        Baseline.objects.filter(
            project_id__in=list(project_ids),
            is_active=True,
            is_deleted=False,
            has_cpm_dates=True,
        ).values_list("project_id", "id")
    )

    out: dict[Any, tuple[int, int]] = {}

    if active_baseline:
        baseline_to_project = {bid: pid for pid, bid in active_baseline.items()}
        planned_by_project: dict[Any, int] = {}
        # Phase rows sit in neither count (#3531): the materialized phase status now
        # reaches COMPLETE, and a container is not planned work — its leaves already
        # carry it. Without the exclusion a finished phase would add 1 to both sides
        # and WBS granularity would still move SPI.
        # A materialized id list, not a subquery: the correlated RawSQL phase probe
        # cannot be re-aliased inside an exclude() subquery. Phases are few.
        phase_ids = list(
            Task.objects.filter(project_id__in=list(active_baseline), is_deleted=False)
            .annotate(_is_phase=task_is_phase_expr())
            .filter(_is_phase=True)
            .values_list("id", flat=True)
        )
        for br in (
            BaselineTask.objects.filter(
                baseline_id__in=list(active_baseline.values()), finish__lte=today
            )
            .exclude(task_id__in=phase_ids)
            .values("baseline_id")
            .annotate(c=Count("id"))
        ):
            planned_by_project[baseline_to_project[br["baseline_id"]]] = br["c"]
        if planned_by_project:
            completed_by_project = {
                cr["project_id"]: cr["c"]
                for cr in (
                    Task.objects.filter(project_id__in=list(planned_by_project), is_deleted=False)
                    .annotate(_is_phase=task_is_phase_expr())
                    .filter(_is_phase=False)
                    .filter(complete_by_today)
                    .values("project_id")
                    .annotate(c=Count("id"))
                )
            }
            for pid, planned in planned_by_project.items():
                out[pid] = (planned, completed_by_project.get(pid, 0))

    no_baseline = [pid for pid in project_ids if pid not in active_baseline]
    if no_baseline:
        for fr in (
            Task.objects.filter(
                project_id__in=no_baseline, is_deleted=False, early_finish__lte=today
            )
            .annotate(_is_phase=task_is_phase_expr())
            .filter(_is_phase=False)
            .values("project_id")
            .annotate(planned=Count("id"), complete=Count("id", filter=complete_by_today))
        ):
            out[fr["project_id"]] = (fr["planned"], fr["complete"])

    return out


def risk_counts_by_project(project_ids: Collection[Any]) -> dict[Any, tuple[int, int]]:
    """project_id → ``(at_risk_count, critical_count)`` for the status/health triage counts.

    Same semantics as ``ProjectViewSet.status_summary``: incomplete tasks only
    (``status`` != COMPLETE), leaf rows only. A phase's ``total_float`` and
    ``is_critical`` are rollups of its children
    (``scheduling.services._rollup_one_summary``: both taken over the incomplete
    children only, ``total_float = min(floats)``, ``is_critical = any(critical)``,
    #5183) — not facts about the phase row itself
    (ADR-0024/ADR-0293) — so counting the phase on top of the leaf whose value it
    rolled up double-counts that leaf (#4250). See :func:`task_is_phase_expr`.

    Built as a grouped query over ``Task`` rather than a reverse-FK
    ``Count("tasks", filter=...)`` annotation on a ``Project`` queryset, because
    :func:`task_is_phase_expr`'s ``RawSQL`` names its own FROM table
    (``projects_task``) literally. On a ``Project`` queryset the join Django adds
    for ``tasks`` is not guaranteed to resolve to that bare table name — it can be
    aliased, particularly once a second filtered aggregate over the same relation
    is added — so the exclusion could silently match against the wrong joined row
    instead of raising. Keeping ``Task`` as the base model side-steps that
    entirely; same shape as :func:`spi_counts_by_project`.

    Projects with no incomplete leaf work are absent from the dict — callers read
    with ``.get(pid, (0, 0))``.
    """
    if not project_ids:
        return {}
    incomplete = ~Q(status=TaskStatus.COMPLETE)
    rows = (
        Task.objects.filter(project_id__in=list(project_ids), is_deleted=False)
        # Narrow before the correlated is_phase EXISTS runs: a row that is
        # complete, or incomplete but neither critical nor low-float, cannot
        # contribute to either Count below no matter what _is_phase turns out
        # to be, so excluding it here is semantics-preserving (NULL total_float
        # and NULL is_critical already fail both conditions in SQL) and avoids
        # evaluating the per-row ltree EXISTS for rows whose answer can't matter.
        .filter(incomplete)
        .filter(Q(is_critical=True) | Q(total_float__lte=5))
        .annotate(_is_phase=task_is_phase_expr())
        .filter(_is_phase=False)
        .values("project_id")
        .annotate(
            at_risk=Count(
                "id",
                filter=Q(total_float__isnull=False) & Q(total_float__lte=5),
            ),
            critical=Count("id", filter=Q(is_critical=True)),
        )
    )
    return {r["project_id"]: (r["at_risk"], r["critical"]) for r in rows}


def spi_health_band(spi: float) -> str:
    """Map an SPI proxy onto the three health bands (shared with the overview card)."""
    if spi >= 0.95:
        return "on_track"
    if spi >= 0.85:
        return "at_risk"
    return "critical"


def _schedule_health_by_project(project_ids: list[Any], today: datetime.date) -> dict[Any, str]:
    """project_id → SPI-proxy health band, matching ProjectOverviewView semantics.

    Counts come from :func:`spi_counts_by_project`, the same function the project
    overview uses. A project with no due-by-today work is ``unknown`` and is
    excluded from the program reduce.
    """
    counts = spi_counts_by_project(project_ids, today)
    out: dict[Any, str] = {}
    for pid in project_ids:
        planned, complete = counts.get(pid, (0, 0))
        out[pid] = "unknown" if planned <= 0 else spi_health_band(complete / planned)
    return out


def _milestone_band(milestones: list[Any], today: datetime.date, soon: datetime.date) -> str:
    """Worst health band across one project's milestones.

    ``critical`` dominates ``at_risk``, so an overdue milestone short-circuits the
    scan — no later milestone can improve the band. A milestone that is complete
    or has no finish date contributes nothing either way.
    """
    if not milestones:
        return "unknown"
    band = "on_track"
    for m in milestones:
        done = m["status"] == TaskStatus.COMPLETE or (m["percent_complete"] or 0) >= 100
        ef = m["early_finish"]
        if done or ef is None:
            continue
        if ef < today:
            return "critical"
        if ef <= soon:
            band = "at_risk"
    return band


def _milestone_health_by_project(project_ids: list[Any], today: datetime.date) -> dict[Any, str]:
    """project_id → milestone health band from milestone task dates.

    critical if any milestone is overdue and not complete; at_risk if any
    milestone is due within 7 days and not yet complete; on_track if the project
    has milestones and none are late/at-risk; unknown if it has no milestones
    (excluded from the reduce).
    """
    if not project_ids:
        return {}
    grouped: dict[Any, list[Any]] = {pid: [] for pid in project_ids}
    for r in Task.objects.filter(
        project_id__in=project_ids, is_deleted=False, is_milestone=True
    ).values("project_id", "early_finish", "status", "percent_complete"):
        grouped[r["project_id"]].append(r)

    # engine-boundary-ok: calendar bookkeeping, not schedule math
    soon = today + datetime.timedelta(days=7)
    return {pid: _milestone_band(ms, today, soon) for pid, ms in grouped.items()}


def _baseline_variance_by_project(project_ids: list[Any]) -> dict[Any, float]:
    """project_id → projected-end drift in calendar days vs the active baseline.

    The current projected end (the latest ``Task.early_finish``) minus the baseline
    end (the latest ``BaselineTask.finish``). Positive = the project is trending
    later than baseline. Projects without an active baseline are absent from the
    map (no comparison basis).

    Measured in working time (#4197): each end is read with the edge of its day it
    sits on (:func:`~trueppm_api.apps.scheduling.finish_reading.latest_finish`), so
    a plan whose finishing milestone moves from the end of a Friday to the start of
    the next Monday reports 0, not +3. Only the rows *on* each end day are read for
    that — the max itself stays a grouped aggregate.

    ``has_cpm_dates=True`` only (#4242): a baseline snapshotted before CPM first
    ran has mostly-or-entirely null ``BaselineTask.finish``, so ``Max("finish")``
    is either ``None`` (already excluded below) or a date computed from an
    incomplete subset of rows — not the baseline's real projected end. Same
    exclusion as :func:`spi_counts_by_project`: such a project is treated as
    having no active baseline, and is absent from the returned map.
    """
    from trueppm_api.apps.scheduling.calendars import project_sched_calendars
    from trueppm_api.apps.scheduling.finish_reading import (
        FINISH_READING_FIELDS,
        finish_shift_days,
        latest_finish,
        task_finish_at_day_start,
    )

    if not project_ids:
        return {}
    active_baseline = dict(
        Baseline.objects.filter(
            project_id__in=project_ids,
            is_active=True,
            is_deleted=False,
            has_cpm_dates=True,
        ).values_list("project_id", "id")
    )
    if not active_baseline:
        return {}

    current_end = {
        r["project_id"]: r["end"]
        for r in Task.objects.filter(project_id__in=list(active_baseline.keys()), is_deleted=False)
        .values("project_id")
        .annotate(end=Max("early_finish"))
        if r["end"] is not None
    }
    baseline_to_project = {bid: pid for pid, bid in active_baseline.items()}
    baseline_end = {
        baseline_to_project[r["baseline_id"]]: r["end"]
        for r in BaselineTask.objects.filter(baseline_id__in=list(active_baseline.values()))
        .values("baseline_id")
        .annotate(end=Max("finish"))
        if r["end"] is not None
    }
    compared = [pid for pid in active_baseline if pid in current_end and pid in baseline_end]
    if not compared:
        return {}

    # The rows ON each end day, with their reading (#4197). ``__in`` over the end
    # days can over-select another project's day; the equality check drops those.
    current_rows: dict[Any, list[tuple[Any, bool, Any]]] = {}
    for t in Task.objects.filter(
        project_id__in=compared,
        is_deleted=False,
        early_finish__in={current_end[pid] for pid in compared},
    ).only("project_id", "early_finish", "wbs_path", *FINISH_READING_FIELDS):
        if t.early_finish == current_end[t.project_id]:
            current_rows.setdefault(t.project_id, []).append(
                (t.early_finish, task_finish_at_day_start(t), t.wbs_path)
            )
    base_rows_raw = [
        r
        for r in BaselineTask.objects.filter(
            baseline_id__in=[active_baseline[pid] for pid in compared],
            finish__in={baseline_end[pid] for pid in compared},
        ).values("baseline_id", "task_id", "finish", "finish_at_day_start")
        if r["finish"] == baseline_end[baseline_to_project[r["baseline_id"]]]
    ]
    # A baseline row carries no WBS path; the task's (live or soft-deleted) path is
    # what lets latest_finish drop a summary row sharing its leaf's end day.
    wbs_by_task = dict(
        Task.objects.filter(id__in={r["task_id"] for r in base_rows_raw}).values_list(
            "id", "wbs_path"
        )
    )
    base_rows: dict[Any, list[tuple[Any, bool, Any]]] = {}
    base_unknown: set[Any] = set()
    for r in base_rows_raw:
        pid = baseline_to_project[r["baseline_id"]]
        if r["finish_at_day_start"] is None:
            base_unknown.add(pid)
        base_rows.setdefault(pid, []).append(
            (r["finish"], bool(r["finish_at_day_start"]), wbs_by_task.get(r["task_id"]))
        )

    readings: dict[Any, tuple[Any, Any]] = {}
    for pid in compared:
        cur = latest_finish(current_rows.get(pid, [])) or (current_end[pid], False)
        base = latest_finish(base_rows.get(pid, [])) or (baseline_end[pid], None)
        if pid in base_unknown:
            # A baseline captured before the reading was recorded (#4197): unknown.
            base = (base[0], None)
        readings[pid] = (base, cur)
    calendars = project_sched_calendars(
        pid for pid, (base, cur) in readings.items() if base[1] or cur[1]
    )
    return {
        pid: float(finish_shift_days(base, cur, calendars.get(str(pid))))
        for pid, (base, cur) in readings.items()
    }


def _schedule_variance_by_project(project_ids: list[Any]) -> dict[Any, float]:
    """project_id → mean lateness of completed work, in calendar days.

    Per-task ``actual_finish − baseline_finish`` (the quantity serializers
    ``get_schedule_variance_days`` reports per task) averaged over the project's
    completed tasks that exist in the active baseline. Distinct from
    ``baseline_variance``: SV measures *how late finished work landed*, not where
    the project end is heading. Absent for projects without an active baseline or
    with no matched completed work.

    Each delta is measured in working time (#4197): an actual finish is a recorded
    day, read as its end, and a baselined start-of-day milestone finish is read as
    the end of the working day before it — so a milestone baselined at the start
    of a Monday and hit on the Friday before landed on time, not three days early.

    ``has_cpm_dates=True`` only (#4242): same exclusion as
    :func:`spi_counts_by_project` and :func:`_baseline_variance_by_project` — a
    baseline snapshotted before CPM first ran has mostly-or-entirely null
    ``BaselineTask.finish`` and is not a usable plan to measure lateness against.
    """
    from trueppm_api.apps.scheduling.calendars import project_sched_calendars
    from trueppm_api.apps.scheduling.finish_reading import (
        Finish,
        actual_finish_reading,
        finish_shift_days,
        milestones_without_work_predecessor,
    )

    if not project_ids:
        return {}
    active_baseline = dict(
        Baseline.objects.filter(
            project_id__in=project_ids,
            is_active=True,
            is_deleted=False,
            has_cpm_dates=True,
        ).values_list("project_id", "id")
    )
    if not active_baseline:
        return {}

    # Baseline finish, with its edge of the day, per (project, task_id).
    baseline_to_project = {bid: pid for pid, bid in active_baseline.items()}
    baseline_finish: dict[tuple[Any, Any], tuple[datetime.date, bool | None]] = {}
    for bt in BaselineTask.objects.filter(
        baseline_id__in=list(active_baseline.values()), finish__isnull=False
    ).values("baseline_id", "task_id", "finish", "finish_at_day_start"):
        if bt["finish"] is None:  # narrows for mypy; excluded by the filter
            continue
        baseline_finish[(baseline_to_project[bt["baseline_id"]], bt["task_id"])] = (
            bt["finish"],
            bt["finish_at_day_start"],
        )

    # Completed tasks with an actual finish.
    completed = [
        t
        for t in Task.objects.filter(
            project_id__in=list(active_baseline.keys()),
            is_deleted=False,
            status=TaskStatus.COMPLETE,
            actual_finish__isnull=False,
        ).values("id", "project_id", "actual_finish", "is_milestone")
        if (t["project_id"], t["id"]) in baseline_finish
    ]
    standalone = milestones_without_work_predecessor(
        t["id"] for t in completed if t["is_milestone"]
    )
    pairs: dict[Any, list[tuple[Finish, Finish]]] = {}
    for t in completed:
        actual = t["actual_finish"]
        if actual is None:
            continue
        pairs.setdefault(t["project_id"], []).append(
            (
                baseline_finish[(t["project_id"], t["id"])],
                actual_finish_reading(
                    actual,
                    is_milestone=t["is_milestone"],
                    has_work_predecessor=t["id"] not in standalone,
                ),
            )
        )

    # A calendar only for the projects with a start-of-day finish on either side; an
    # end-of-day pair diffs identically without one.
    calendars = project_sched_calendars(
        pid for pid, ps in pairs.items() if any(base[1] or actual[1] for base, actual in ps)
    )
    deltas = {
        pid: [finish_shift_days(base, actual, calendars.get(str(pid))) for base, actual in ps]
        for pid, ps in pairs.items()
    }
    return {pid: sum(ds) / len(ds) for pid, ds in deltas.items() if ds}


# ---------------------------------------------------------------------------
# Program-total KPIs (policy-independent)
# ---------------------------------------------------------------------------


def _critical_task_total(project_ids: list[Any]) -> int:
    """Total open critical-path tasks across the program.

    Leaf rows only (#4276): a phase's `is_critical` is a rollup of its children
    (ADR-0024/ADR-0293, `_rollup_one_summary`: `is_critical = any(child.is_critical)`),
    not a fact about the phase row itself, so counting the phase on top of the
    leaf whose value it rolled up double-counts that leaf and inflates this
    program-total KPI. See :func:`task_is_phase_expr`.
    """
    if not project_ids:
        return 0
    return (
        Task.objects.filter(project_id__in=project_ids, is_deleted=False, is_critical=True)
        .exclude(status__in=_ACTIVE_EXCLUDE)
        .annotate(_is_phase=task_is_phase_expr())
        .filter(_is_phase=False)
        .count()
    )


def _at_risk_task_total(project_ids: list[Any]) -> int:
    """Total open tasks with ≤ 5 working days of float across the program.

    Leaf rows only (#4276), same rollup reasoning as :func:`_critical_task_total`:
    a phase's `total_float` is the min over its incomplete children (ADR-0024/ADR-0293), not a fact
    about the phase row itself.
    """
    if not project_ids:
        return 0
    return (
        Task.objects.filter(
            project_id__in=project_ids,
            is_deleted=False,
            total_float__isnull=False,
            total_float__lte=5,
        )
        .exclude(status__in=_ACTIVE_EXCLUDE)
        .annotate(_is_phase=task_is_phase_expr())
        .filter(_is_phase=False)
        .count()
    )


def _risk_score_total(project_ids: list[Any]) -> int:
    """Total open-risk exposure (Σ probability × impact) across the program."""
    if not project_ids:
        return 0
    agg = Risk.objects.filter(
        project_id__in=project_ids,
        is_deleted=False,
        status__in=[RiskStatus.OPEN, RiskStatus.MITIGATING],
    ).aggregate(score=Sum(F("probability") * F("impact")))
    return int(agg["score"] or 0)


# ---------------------------------------------------------------------------
# Reducers
# ---------------------------------------------------------------------------


_WEIGHTED_POLICIES = frozenset(
    {AggregationPolicy.TASK_WEIGHTED.value, AggregationPolicy.WEIGHTED_BY_BUDGET.value}
)


def _reduce_health(
    bands: list[str], policy: str, task_weights: dict[Any, float], project_ids: list[Any]
) -> str:
    """Combine per-project health bands into one band under the policy.

    ``unknown`` bands are dropped before reducing (a project with no data must
    not make the program look worse). Returns ``unknown`` when every project is
    unknown or there are no projects.

    Note: weighting health requires aligning weights to bands positionally, so the
    caller passes bands in ``project_ids`` order. ``task_weights`` carries whichever
    weight the policy uses: committed task counts for ``task_weighted``, budgets for
    ``weighted_by_budget`` (ADR-1324).
    """
    ordinals = [_HEALTH_ORDINAL[b] for b in bands if b in _HEALTH_ORDINAL]
    if not ordinals:
        return "unknown"

    if policy == AggregationPolicy.WORST.value:
        return _ORDINAL_TO_HEALTH[min(ordinals)]
    if policy in _WEIGHTED_POLICIES:
        # Weight each project's band by its weight. bands is in project_ids order;
        # pair them and skip unknowns.
        weighted_sum = 0.0
        weight_total = 0.0
        for pid, band in zip(project_ids, bands, strict=False):
            if band not in _HEALTH_ORDINAL:
                continue
            w = task_weights.get(pid, 0) or 1  # a zero-task project still counts once
            weighted_sum += _HEALTH_ORDINAL[band] * w
            weight_total += w
        if weight_total == 0:
            return _ORDINAL_TO_HEALTH[round(sum(ordinals) / len(ordinals))]
        return _ORDINAL_TO_HEALTH[round(weighted_sum / weight_total)]
    # AVERAGE (and the weighted_by_budget no-budget fallback).
    return _ORDINAL_TO_HEALTH[round(sum(ordinals) / len(ordinals))]


def _reduce_variance(
    by_project: dict[Any, float], policy: str, task_weights: dict[Any, float]
) -> float | None:
    """Combine per-project day-variances under the policy.

    ``worst`` = the largest slip (the project dragging the program). ``average``
    = arithmetic mean. ``task_weighted`` = mean weighted by committed task count;
    ``weighted_by_budget`` = mean weighted by ``Project.budget``.
    Returns ``None`` when no project has a value (e.g. no active baselines), which
    the serializer renders as "—".
    """
    if not by_project:
        return None
    values = list(by_project.values())

    if policy == AggregationPolicy.WORST.value:
        return round(max(values), 1)
    if policy in _WEIGHTED_POLICIES:
        weighted_sum = 0.0
        weight_total = 0.0
        for pid, val in by_project.items():
            w = task_weights.get(pid, 0) or 1
            weighted_sum += val * w
            weight_total += w
        if weight_total == 0:
            return round(sum(values) / len(values), 1)
        return round(weighted_sum / weight_total, 1)
    # AVERAGE (and the weighted_by_budget no-budget fallback).
    return round(sum(values) / len(values), 1)
