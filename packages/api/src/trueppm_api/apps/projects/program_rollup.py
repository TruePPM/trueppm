"""Program rollup-KPI consumer (ADR-0088, #713).

Reads the per-program rollup config shipped by #527 (``rollup_enabled_kpis`` +
``rollup_aggregation_policy`` on :class:`Program`) and computes the actual
rolled-up KPI values across the program's *own* projects. Intra-program only —
cross-program aggregation is Enterprise (ADR-0070).

Design (ADR-0088):

- **7 KPIs are computable today.** ``cost_variance`` / ``budget_utilization`` are
  deferred to the cost/EVM model (#754) and ``p80_completion`` to a persistent
  Monte Carlo store (#753); those return ``{"available": False, "reason": ...}``
  so the UI can explain *why* a toggled KPI shows nothing rather than fabricating
  a zero.
- **The aggregation policy applies where it is meaningful.** ``worst`` / ``average``
  / ``task_weighted`` govern the health bands (``schedule_health``,
  ``milestone_health``), the day-variances (``baseline_variance``,
  ``schedule_variance``), and the headline program health dot. Counts
  (``critical_tasks``, ``at_risk_tasks``) and risk exposure (``risk_score``) roll
  up as program **totals** regardless of policy — the sum is the only PM-useful
  number for an additive metric.
- ``weighted_by_budget`` has no weight to use until #754, so it falls back to
  ``average`` and the response flags ``policy_available: False``; the rollup is
  never blanked just because the chosen policy cannot be honored.

Implemented with a fixed, small number of grouped (``values().annotate()``)
queries across the program's projects — never a per-project ``ProjectOverviewView``
call — to hold the ≤200 ms p95 budget (ADR-0030/0088). Pure read; no writes, no
async side effects (ADR-0088 Durable Execution: all N/A).
"""

from __future__ import annotations

import datetime
from typing import Any

from django.db.models import Count, F, Max, Q, Sum
from django.utils import timezone

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
_DEFERRED_REASONS = {
    RollupKpi.COST_VARIANCE.value: "no_cost_data",
    RollupKpi.BUDGET_UTILIZATION.value: "no_cost_data",
    RollupKpi.P80_COMPLETION.value: "no_montecarlo_store",
}

# Active task statuses (exclude COMPLETE) — "open work" for count KPIs. Mirrors
# the at-risk/critical definitions in ProjectViewSet.status_summary so the
# program rollup and the per-project StatusBar agree.
_ACTIVE_EXCLUDE = {TaskStatus.COMPLETE}

# Health band → ordinal for reducing (higher = healthier). ``unknown`` has no
# ordinal: it is excluded from the reduce rather than dragging the result down,
# which would punish projects that simply have no baseline yet.
_HEALTH_ORDINAL = {"critical": 0, "at_risk": 1, "on_track": 2}
_ORDINAL_TO_HEALTH = {0: "critical", 1: "at_risk", 2: "on_track"}


def compute_program_rollup(program: Program) -> dict[str, Any]:
    """Compute the rolled-up KPI block for a program's overview (ADR-0088).

    Returns a dict with the program health dot, the active aggregation policy
    (and whether it could be honored), the contributing project count, and a
    ``kpis`` map keyed by the program's enabled :class:`RollupKpi` values. Each
    entry is either ``{"available": True, "value": ..., ["unit": ...]}`` (value
    may be ``None`` when a built KPI has no data yet, e.g. no active baseline) or
    ``{"available": False, "reason": ...}`` for a KPI whose per-project source is
    not built yet (#753/#754).

    Pure read: deterministic for a given DB state, no writes, safe to call on
    every GET.
    """
    today = timezone.localdate()
    policy = program.rollup_aggregation_policy or AggregationPolicy.WORST.value
    enabled = list(program.rollup_enabled_kpis or [])

    project_ids = list(
        Project.objects.filter(program=program, is_deleted=False).values_list("id", flat=True)
    )

    # weighted_by_budget cannot be honored until the cost model (#754) lands, so
    # it degrades to AVERAGE and the caller flags policy_available=False.
    effective_policy = policy
    policy_available = True
    if policy == AggregationPolicy.WEIGHTED_BY_BUDGET.value:
        effective_policy = AggregationPolicy.AVERAGE.value
        policy_available = False

    # Per-project committed task counts — the weight for task_weighted. Computed
    # once and shared by every policy-governed KPI. Excludes BACKLOG (uncommitted)
    # so a large grooming backlog does not skew the weight.
    task_weights = _committed_task_counts(project_ids)

    # schedule_health per project is always needed: it is both a KPI and the
    # source of the headline program health dot (drives Program.health=AUTO).
    schedule_health_by_project = _schedule_health_by_project(project_ids, today)
    program_health = _reduce_health(
        list(schedule_health_by_project.values()), effective_policy, task_weights, project_ids
    )

    kpis: dict[str, dict[str, Any]] = {}
    for kpi in enabled:
        if kpi in _DEFERRED_REASONS:
            kpis[kpi] = {"available": False, "reason": _DEFERRED_REASONS[kpi]}
        elif kpi == RollupKpi.SCHEDULE_HEALTH.value:
            kpis[kpi] = {
                "available": True,
                "value": _reduce_health(
                    list(schedule_health_by_project.values()),
                    effective_policy,
                    task_weights,
                    project_ids,
                ),
            }
        elif kpi == RollupKpi.MILESTONE_HEALTH.value:
            bands = list(_milestone_health_by_project(project_ids, today).values())
            kpis[kpi] = {
                "available": True,
                "value": _reduce_health(bands, effective_policy, task_weights, project_ids),
            }
        elif kpi == RollupKpi.CRITICAL_TASKS.value:
            kpis[kpi] = {"available": True, "value": _critical_task_total(project_ids)}
        elif kpi == RollupKpi.AT_RISK_TASKS.value:
            kpis[kpi] = {"available": True, "value": _at_risk_task_total(project_ids)}
        elif kpi == RollupKpi.RISK_SCORE.value:
            kpis[kpi] = {"available": True, "value": _risk_score_total(project_ids)}
        elif kpi == RollupKpi.BASELINE_VARIANCE.value:
            kpis[kpi] = {
                "available": True,
                "unit": "calendar_days",
                "value": _reduce_variance(
                    _baseline_variance_by_project(project_ids),
                    effective_policy,
                    task_weights,
                ),
            }
        elif kpi == RollupKpi.SCHEDULE_VARIANCE.value:
            kpis[kpi] = {
                "available": True,
                "unit": "calendar_days",
                "value": _reduce_variance(
                    _schedule_variance_by_project(project_ids),
                    effective_policy,
                    task_weights,
                ),
            }

    return {
        "aggregation_policy": policy,
        "policy_available": policy_available,
        "project_count": len(project_ids),
        "program_health": program_health,
        "kpis": kpis,
    }


# ---------------------------------------------------------------------------
# Per-project metric maps (grouped queries — no per-project loop)
# ---------------------------------------------------------------------------


def _committed_task_counts(project_ids: list[Any]) -> dict[Any, int]:
    """project_id → committed (non-BACKLOG, non-deleted) task count, for weighting."""
    if not project_ids:
        return {}
    rows = (
        Task.objects.filter(project_id__in=project_ids, is_deleted=False)
        .exclude(status=TaskStatus.BACKLOG)
        .values("project_id")
        .annotate(c=Count("id"))
    )
    return {r["project_id"]: r["c"] for r in rows}


def _schedule_health_by_project(project_ids: list[Any], today: datetime.date) -> dict[Any, str]:
    """project_id → SPI-proxy health band, matching ProjectOverviewView semantics.

    SPI = (tasks complete by today) / (tasks that should be done by today). The
    "should be done" denominator prefers the active baseline's snapshot finishes
    and falls back to CPM ``early_finish`` for projects with no baseline. A
    project with no due-by-today work is ``unknown`` and is excluded from the
    program reduce.
    """
    if not project_ids:
        return {}

    # Active baseline per project (at most one — is_active is a per-project flag).
    active_baseline = dict(
        Baseline.objects.filter(
            project_id__in=project_ids, is_active=True, is_deleted=False
        ).values_list("project_id", "id")
    )

    # Planned-by-today via baseline snapshots (grouped by baseline → project).
    planned_by_project: dict[Any, int] = {}
    if active_baseline:
        baseline_to_project = {bid: pid for pid, bid in active_baseline.items()}
        for br in (
            BaselineTask.objects.filter(
                baseline_id__in=list(active_baseline.values()), finish__lte=today
            )
            .values("baseline_id")
            .annotate(c=Count("id"))
        ):
            planned_by_project[baseline_to_project[br["baseline_id"]]] = br["c"]

    # Planned-by-today fallback (CPM early_finish) for projects without a baseline.
    no_baseline = [pid for pid in project_ids if pid not in active_baseline]
    if no_baseline:
        for fr in (
            Task.objects.filter(
                project_id__in=no_baseline, is_deleted=False, early_finish__lte=today
            )
            .values("project_id")
            .annotate(c=Count("id"))
        ):
            planned_by_project[fr["project_id"]] = fr["c"]

    # Completed-by-today numerator (null actual_finish on a COMPLETE task counts).
    completed_by_project = {
        cr["project_id"]: cr["c"]
        for cr in (
            Task.objects.filter(
                project_id__in=project_ids, is_deleted=False, status=TaskStatus.COMPLETE
            )
            .filter(Q(actual_finish__lte=today) | Q(actual_finish__isnull=True))
            .values("project_id")
            .annotate(c=Count("id"))
        )
    }

    out: dict[Any, str] = {}
    for pid in project_ids:
        planned = planned_by_project.get(pid, 0)
        if planned <= 0:
            out[pid] = "unknown"
            continue
        spi = completed_by_project.get(pid, 0) / planned
        out[pid] = "on_track" if spi >= 0.95 else "at_risk" if spi >= 0.85 else "critical"
    return out


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

    soon = today + datetime.timedelta(days=7)
    out: dict[Any, str] = {}
    for pid, milestones in grouped.items():
        if not milestones:
            out[pid] = "unknown"
            continue
        band = "on_track"
        for m in milestones:
            done = m["status"] == TaskStatus.COMPLETE or (m["percent_complete"] or 0) >= 100
            ef = m["early_finish"]
            if done or ef is None:
                continue
            if ef < today:
                band = "critical"
                break
            if ef <= soon:
                band = "at_risk"
        out[pid] = band
    return out


def _baseline_variance_by_project(project_ids: list[Any]) -> dict[Any, float]:
    """project_id → projected-end drift in calendar days vs the active baseline.

    ``max(Task.early_finish)`` (current projected end) minus
    ``max(BaselineTask.finish)`` (baseline end). Positive = the project is
    trending later than baseline. Projects without an active baseline are absent
    from the map (no comparison basis).
    """
    if not project_ids:
        return {}
    active_baseline = dict(
        Baseline.objects.filter(
            project_id__in=project_ids, is_active=True, is_deleted=False
        ).values_list("project_id", "id")
    )
    if not active_baseline:
        return {}

    current_end = {
        r["project_id"]: r["end"]
        for r in Task.objects.filter(project_id__in=list(active_baseline.keys()), is_deleted=False)
        .values("project_id")
        .annotate(end=Max("early_finish"))
    }
    baseline_to_project = {bid: pid for pid, bid in active_baseline.items()}
    baseline_end = {
        baseline_to_project[r["baseline_id"]]: r["end"]
        for r in BaselineTask.objects.filter(baseline_id__in=list(active_baseline.values()))
        .values("baseline_id")
        .annotate(end=Max("finish"))
    }

    out: dict[Any, float] = {}
    for pid in active_baseline:
        cur = current_end.get(pid)
        base = baseline_end.get(pid)
        if cur is not None and base is not None:
            out[pid] = float((cur - base).days)
    return out


def _schedule_variance_by_project(project_ids: list[Any]) -> dict[Any, float]:
    """project_id → mean lateness of completed work, in calendar days.

    Per-task ``actual_finish − baseline_finish`` (the per-task definition in
    serializers ``get_schedule_variance_days``) averaged over the project's
    completed tasks that exist in the active baseline. Distinct from
    ``baseline_variance``: SV measures *how late finished work landed*, not where
    the project end is heading. Absent for projects without an active baseline or
    with no matched completed work.
    """
    if not project_ids:
        return {}
    active_baseline = dict(
        Baseline.objects.filter(
            project_id__in=project_ids, is_active=True, is_deleted=False
        ).values_list("project_id", "id")
    )
    if not active_baseline:
        return {}

    # Baseline finish per (project, task_id).
    baseline_to_project = {bid: pid for pid, bid in active_baseline.items()}
    baseline_finish: dict[tuple[Any, Any], datetime.date | None] = {}
    for bt in BaselineTask.objects.filter(
        baseline_id__in=list(active_baseline.values()), finish__isnull=False
    ).values("baseline_id", "task_id", "finish"):
        baseline_finish[(baseline_to_project[bt["baseline_id"]], bt["task_id"])] = bt["finish"]

    # Completed tasks with an actual finish.
    deltas: dict[Any, list[int]] = {}
    for t in Task.objects.filter(
        project_id__in=list(active_baseline.keys()),
        is_deleted=False,
        status=TaskStatus.COMPLETE,
        actual_finish__isnull=False,
    ).values("id", "project_id", "actual_finish"):
        base = baseline_finish.get((t["project_id"], t["id"]))
        actual = t["actual_finish"]
        if base is not None and actual is not None:
            deltas.setdefault(t["project_id"], []).append((actual - base).days)

    return {pid: sum(ds) / len(ds) for pid, ds in deltas.items() if ds}


# ---------------------------------------------------------------------------
# Program-total KPIs (policy-independent)
# ---------------------------------------------------------------------------


def _critical_task_total(project_ids: list[Any]) -> int:
    """Total open critical-path tasks across the program."""
    if not project_ids:
        return 0
    return (
        Task.objects.filter(project_id__in=project_ids, is_deleted=False, is_critical=True)
        .exclude(status__in=_ACTIVE_EXCLUDE)
        .count()
    )


def _at_risk_task_total(project_ids: list[Any]) -> int:
    """Total open tasks with ≤ 5 working days of float across the program."""
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
        .count()
    )


def _risk_score_total(project_ids: list[Any]) -> int:
    """Total open-risk exposure (Σ probability × impact) across the program."""
    if not project_ids:
        return 0
    agg = Risk.objects.filter(
        project_id__in=project_ids,
        status__in=[RiskStatus.OPEN, RiskStatus.MITIGATING],
    ).aggregate(score=Sum(F("probability") * F("impact")))
    return int(agg["score"] or 0)


# ---------------------------------------------------------------------------
# Reducers
# ---------------------------------------------------------------------------


def _reduce_health(
    bands: list[str], policy: str, task_weights: dict[Any, int], project_ids: list[Any]
) -> str:
    """Combine per-project health bands into one band under the policy.

    ``unknown`` bands are dropped before reducing (a project with no data must
    not make the program look worse). Returns ``unknown`` when every project is
    unknown or there are no projects.

    Note: task-weighting health requires aligning weights to bands positionally,
    so the caller passes bands in ``project_ids`` order for ``task_weighted``.
    """
    ordinals = [_HEALTH_ORDINAL[b] for b in bands if b in _HEALTH_ORDINAL]
    if not ordinals:
        return "unknown"

    if policy == AggregationPolicy.WORST.value:
        return _ORDINAL_TO_HEALTH[min(ordinals)]
    if policy == AggregationPolicy.TASK_WEIGHTED.value:
        # Weight each project's band by its committed task count. bands is in
        # project_ids order; pair them and skip unknowns.
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
    # AVERAGE (and the weighted_by_budget fallback).
    return _ORDINAL_TO_HEALTH[round(sum(ordinals) / len(ordinals))]


def _reduce_variance(
    by_project: dict[Any, float], policy: str, task_weights: dict[Any, int]
) -> float | None:
    """Combine per-project day-variances under the policy.

    ``worst`` = the largest slip (the project dragging the program). ``average``
    = arithmetic mean. ``task_weighted`` = mean weighted by committed task count.
    Returns ``None`` when no project has a value (e.g. no active baselines), which
    the serializer renders as "—".
    """
    if not by_project:
        return None
    values = list(by_project.values())

    if policy == AggregationPolicy.WORST.value:
        return round(max(values), 1)
    if policy == AggregationPolicy.TASK_WEIGHTED.value:
        weighted_sum = 0.0
        weight_total = 0.0
        for pid, val in by_project.items():
            w = task_weights.get(pid, 0) or 1
            weighted_sum += val * w
            weight_total += w
        if weight_total == 0:
            return round(sum(values) / len(values), 1)
        return round(weighted_sum / weight_total, 1)
    # AVERAGE (and the weighted_by_budget fallback).
    return round(sum(values) / len(values), 1)
