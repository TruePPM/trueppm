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
from collections.abc import Collection
from typing import Any

from django.db.models import BooleanField, Count, F, Max, Q, Sum
from django.db.models.expressions import RawSQL
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
#
# This map is the single source of truth for "can this KPI ever produce a value
# today?" and is published on the rollup-config endpoint as ``unavailable_kpis``
# (#2404). It has to be a *server* fact rather than a hard-coded client list:
# the settings picker offered all ten toggles as if they were live, so enabling
# one of these three saved a config that could never render — a control that
# lies. When #753 (Monte Carlo store) and #754 (cost/EVM model) land, deleting
# the corresponding entry here is the only change needed to light the toggle up.
DEFERRED_KPI_REASONS = {
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


def compute_program_rollup(
    program: Program,
    *,
    exclude_project_ids: Collection[Any] | None = None,
) -> dict[str, Any]:
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
        if kpi in DEFERRED_KPI_REASONS:
            kpis[kpi] = {"available": False, "reason": DEFERRED_KPI_REASONS[kpi]}
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

    critical_counts = {
        r["project_id"]: r["c"]
        for r in (
            Task.objects.filter(project_id__in=project_ids, is_deleted=False, is_critical=True)
            .exclude(status__in=_ACTIVE_EXCLUDE)
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
        for br in (
            BaselineTask.objects.filter(
                baseline_id__in=list(active_baseline.values()), finish__lte=today
            )
            .values("baseline_id")
            .annotate(c=Count("id"))
        ):
            planned_by_project[baseline_to_project[br["baseline_id"]]] = br["c"]
        if planned_by_project:
            completed_by_project = {
                cr["project_id"]: cr["c"]
                for cr in (
                    Task.objects.filter(project_id__in=list(planned_by_project), is_deleted=False)
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
    (``scheduling.services._rollup_one_summary``: ``total_float = min(child floats)``,
    ``is_critical = any(child.is_critical)``) — not facts about the phase row itself
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
    from trueppm_api.apps.scheduling.finish_reading import finish_shift_days

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
    pairs: dict[Any, list[tuple[tuple[datetime.date, bool | None], datetime.date]]] = {}
    for t in Task.objects.filter(
        project_id__in=list(active_baseline.keys()),
        is_deleted=False,
        status=TaskStatus.COMPLETE,
        actual_finish__isnull=False,
    ).values("id", "project_id", "actual_finish"):
        base = baseline_finish.get((t["project_id"], t["id"]))
        actual = t["actual_finish"]
        if base is not None and actual is not None:
            pairs.setdefault(t["project_id"], []).append((base, actual))

    # A calendar only for the projects with a start-of-day baseline finish; an
    # end-of-day pair diffs identically without one.
    calendars = project_sched_calendars(
        pid for pid, ps in pairs.items() if any(base[1] for base, _ in ps)
    )
    deltas = {
        pid: [
            finish_shift_days(base, (actual, False), calendars.get(str(pid))) for base, actual in ps
        ]
        for pid, ps in pairs.items()
    }
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
