"""Metric provenance: one definition per metric, and the forecast commitment (ADR-1314).

The same project metric used to read differently on different screens because each
surface computed or formatted its own number, with nothing saying what the number
meant or when it was true (#4760). ADR-1314 names exactly one owning endpoint per
metric; this module holds the two things those endpoints share:

* :data:`METRIC_DEFINITIONS` — the one sentence that defines each metric. Every
  owning endpoint returns the sentences for the figures it carries in an additive
  ``definitions`` map, and the published metric-vocabulary page states the same
  sentences (``tests/apps/projects/test_metric_provenance.py`` keeps the two in
  step). A client renders the sentence it is handed; it never writes its own, so
  a tooltip cannot describe a number differently from the server that computed it.
* :func:`forecast_commitment_facts` — the P80-versus-commitment figure the Monte
  Carlo result owns. The commitment is a rule the client cannot reproduce (it
  needs the active baseline and the parent program), so it is a server fact.

Kept free of view imports so both ``projects`` and ``scheduling`` can read it.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import date
from typing import TYPE_CHECKING, Any

from drf_spectacular.utils import inline_serializer
from rest_framework import serializers

if TYPE_CHECKING:
    from django.db.models import QuerySet

# One sentence per metric. The key is the payload field the sentence defines. Edit a
# sentence here and in
# packages/website/src/content/docs/features/metric-vocabulary.md together — the sync
# test fails until both say the same thing.
METRIC_DEFINITIONS: dict[str, str] = {
    # ── status-summary ────────────────────────────────────────────────────
    "health_band": (
        "The project's health: the project manager's own report when one is filed, "
        "otherwise critical when any incomplete leaf task is on the critical path, at "
        "risk when any incomplete leaf task has 5 or fewer working days of total float, "
        "and on track when neither holds."
    ),
    "at_risk_count": (
        "Incomplete leaf tasks with 5 or fewer working days of total float, including "
        "tasks already late (negative float)."
    ),
    "critical_count": "Incomplete leaf tasks on the critical path.",
    "blocked_count": (
        "Live tasks flagged blocked (a blocked reason is recorded): the rule the blocked "
        "list uses, counted in full rather than capped at the list's row limit."
    ),
    # ── monte-carlo/latest ────────────────────────────────────────────────
    "p50": "The finish date half of the simulated schedules finish on or before.",
    "p80": "The finish date 80% of the simulated schedules finish on or before.",
    "p95": "The finish date 95% of the simulated schedules finish on or before.",
    "p80_delta_vs_commitment_days": (
        "The P80 finish minus the commitment date, in calendar days measured in "
        "working time; positive means the forecast is later than the commitment."
    ),
    # The commitment definition states WHICH rule supplied the date (#4760), so it is
    # keyed by source and the payload carries the one that applied.
    "commitment_date.baseline": (
        "The commitment is the active baseline's finish: the latest baselined finish "
        "date of any task."
    ),
    "commitment_date.program_target": (
        "The commitment is the parent program's target date, because the project has "
        "no active baseline with dates."
    ),
    "commitment_date.none": (
        "There is no commitment: the project has no active baseline with dates and no "
        "program target date."
    ),
    # ── projects/{id}/utilization ─────────────────────────────────────────
    "load_pct": (
        "A person's booked hours on a working day divided by their capacity that day "
        "(hours per day times their units on this project), as a percentage; "
        "non-working days and calendar time off carry no capacity and are omitted."
    ),
    # ── projects/{id}/overview ────────────────────────────────────────────
    "open_risk_count": "Risks in the register whose status is open or mitigating.",
    "team_utilization_pct": (
        "Booked hours across the project roster this week divided by the roster's "
        "working-time capacity this week, as a percentage."
    ),
    "schedule_health": (
        "The schedule performance band from the SPI proxy (completed planned work "
        "divided by work planned by today); unknown when nothing is planned yet. "
        "Not the project health band."
    ),
    # ── projects/{id}/burn ────────────────────────────────────────────────
    "burn_series": (
        "Per day, the remaining (burndown) or completed (burnup) task count or story "
        "points, replayed from task history."
    ),
    "burn_baseline_series": (
        "Per day, the same quantity as planned by the active baseline; absent when "
        "the project has no active baseline with dates."
    ),
    # ── task rows (slip) ──────────────────────────────────────────────────
    "baseline_finish_variance_days": (
        "A task's slip: its forecast finish minus its active-baseline finish, in "
        "calendar days measured in working time; positive means late."
    ),
    # ── sprints/{id}/burndown (ADR-1314 amendment, #4778) ─────────────────
    "sprint_burn_series": (
        "Per day of the sprint, the story points of its committed tasks that are not "
        "complete (a task's remaining points when set, else its story points), as "
        "recorded in that day's burn snapshot; pending mid-sprint additions count "
        "for nothing until accepted."
    ),
    "committed_points": (
        "The story points the sprint committed to, snapshotted when it was activated "
        "and never recomputed."
    ),
    "burn_status": (
        "The sprint's burn pace: ahead or behind when the latest snapshot's remaining "
        "points are more than 10% of the committed points (at least 1 point) below or "
        "above the straight ideal line from the committed points to zero, on track "
        "otherwise, and no data when nothing was committed or no snapshot exists yet."
    ),
    "trend_points": (
        "The ideal line's remaining points for today minus the latest snapshot's "
        "remaining points; positive means ahead of the ideal line."
    ),
    "projected_finish_date": (
        "Today plus the remaining points divided by the points burned per elapsed "
        "sprint day so far; null when nothing has burned yet or nothing remains."
    ),
    # ── /me/work signals.forecast (ADR-1314 amendment, #4778) ─────────────
    "my_work_p80_finish": (
        "The latest P80 finish among your member projects that are not drafts, each "
        "read from that project's latest Monte Carlo result: the same date its "
        "forecast endpoint serves."
    ),
}

#: The figures each owning endpoint defines in its ``definitions`` map (ADR-1314).
STATUS_SUMMARY_DEFINED: list[str] = [
    "health_band",
    "at_risk_count",
    "critical_count",
    "blocked_count",
]
OVERVIEW_DEFINED: list[str] = ["schedule_health", "open_risk_count", "team_utilization_pct"]
UTILIZATION_DEFINED: list[str] = ["load_pct"]
BURN_DEFINED: list[str] = ["burn_series", "burn_baseline_series"]
BURN_COMBINED_DEFINED: list[str] = ["burn_series"]
FORECAST_DEFINED: list[str] = [
    "p50",
    "p80",
    "p95",
    "p80_delta_vs_commitment_days",
    "commitment_date",
]

COMMITMENT_SOURCE_CHOICES = ["baseline", "program_target", "none"]
COMMITMENT_REASON_CHOICES = ["no_commitment", "no_forecast"]

#: Why a sprint's ``burn_status`` is ``no_data`` (rule 119, #4778). ``no_data`` alone
#: conflated "the sprint committed nothing" with "no snapshot has been written yet",
#: and a reader cannot tell which to fix.
BURN_STATUS_REASON_CHOICES = ["no_commitment", "no_snapshots"]

#: Sprint burn figures (ADR-1314 amendment, #4778), keyed by the PAYLOAD field. The
#: owner (``/sprints/{id}/burndown/``) names the series ``snapshots``; the My Work
#: echo names the same series ``series``. One sentence, two field names — the same
#: arrangement as :func:`task_slip_definitions`.
_SPRINT_BURN_FIGURES: dict[str, str] = {
    "committed_points": "committed_points",
    "burn_status": "burn_status",
    "trend_points": "trend_points",
    "projected_finish_date": "projected_finish_date",
}
SPRINT_BURNDOWN_DEFINED: dict[str, str] = {
    "snapshots": "sprint_burn_series",
    **_SPRINT_BURN_FIGURES,
}
MY_WORK_SPRINT_BURN_DEFINED: dict[str, str] = {
    "series": "sprint_burn_series",
    **_SPRINT_BURN_FIGURES,
}
MY_WORK_FORECAST_DEFINED: dict[str, str] = {"p80_finish": "my_work_p80_finish"}


def definitions_for(keys: Iterable[str]) -> dict[str, str]:
    """The ``definitions`` map for a payload carrying ``keys``."""
    return {k: METRIC_DEFINITIONS[k] for k in keys}


def definitions_by_field(fields: dict[str, str]) -> dict[str, str]:
    """The ``definitions`` map for a payload whose field names differ from the metric keys.

    ``fields`` maps the payload field to the :data:`METRIC_DEFINITIONS` key.
    """
    return {field: METRIC_DEFINITIONS[key] for field, key in fields.items()}


def definitions_field_by_field(name: str, fields: dict[str, str]) -> Any:
    """:func:`definitions_field` for a payload whose field names differ from the metric keys."""
    return inline_serializer(
        name=name,
        fields={
            field: serializers.CharField(help_text=METRIC_DEFINITIONS[key])
            for field, key in fields.items()
        },
        help_text=(
            "One sentence per figure on this payload saying what it measures (ADR-1314). "
            "Render it verbatim; never substitute a client-written definition."
        ),
    )


def latest_forecast_result(
    project_id: Any, runs: QuerySet[Any] | None = None
) -> tuple[dict[str, Any] | None, Any | None]:
    """A project's latest Monte Carlo result: ``(cache_entry, None)`` or ``(None, run)``.

    The per-project reader of "the latest forecast" (ADR-1314, #4778). The owner
    (``monte-carlo/latest/``) and its echoes (status-summary's ``monte_carlo_p80``,
    the overview's forecast fields) all call it, so none of them can read in a
    different order. The order: the cache entry first, then the newest persisted
    ``MonteCarloRun`` once the 24-hour entry has expired. A Member-triggered run
    refreshes the cache and persists no row (#1502), so a reader of the persisted
    row alone serves a different forecast than the owner for up to a day.

    ``runs`` narrows the fallback query (``.only(...)``) for a caller that needs a
    few columns; the run is the newest by ``taken_at`` whatever its P80. The run is
    ``None`` when there is a cache entry (not queried) or no run at all. Batched
    over many projects, :func:`latest_forecast_p80_by_project` applies the same order.
    """
    from django.core.cache import cache

    from trueppm_api.apps.scheduling.models import MonteCarloRun

    # Lazy: scheduling.views imports this module at load time.
    from trueppm_api.apps.scheduling.views import mc_latest_cache_key

    entry = cache.get(mc_latest_cache_key(project_id))
    if entry is not None:
        return entry, None
    qs = runs if runs is not None else MonteCarloRun.objects.all()
    return None, qs.filter(project_id=project_id).order_by("-taken_at").first()


def latest_forecast_p80_by_project(project_ids: Iterable[Any]) -> dict[str, tuple[date, str]]:
    """Each project's P80 and ``last_run_at`` from the forecast owner's latest result.

    The batched form of :func:`latest_forecast_result`, for the My Work signal
    (#4778): the same order (cache entry first, then the newest persisted run)
    over many projects in one cache round trip and one DISTINCT ON query. My Work
    used to read the persisted row alone, the disagreement #4760 fixed in
    status-summary.

    The persisted fallback takes each project's NEWEST run, whatever its P80, as the
    owner does. A newest run with no P80 means the owner has no P80 to show, so the
    project is left out; an older run's date is not substituted for it.

    Returns ``{str(project_id): (p80, last_run_at_iso)}`` for the projects that have
    a P80. One cache round trip, plus at most one query (DISTINCT ON) for the
    projects with no cache entry.
    """
    from django.core.cache import cache

    from trueppm_api.apps.scheduling.models import MonteCarloRun

    # Lazy: scheduling.views imports this module at load time.
    from trueppm_api.apps.scheduling.views import mc_latest_cache_key

    ids = [str(pid) for pid in project_ids]
    if not ids:
        return {}
    keys = {mc_latest_cache_key(pid): pid for pid in ids}
    cached = cache.get_many(list(keys))
    out: dict[str, tuple[date, str]] = {}
    uncached: list[str] = []
    for key, pid in keys.items():
        entry = cached.get(key)
        if entry is None:
            uncached.append(pid)
            continue
        p80 = entry.get("p80")
        if p80 is not None and entry.get("last_run_at"):
            out[pid] = (
                date.fromisoformat(p80) if isinstance(p80, str) else p80,
                entry["last_run_at"],
            )
    if uncached:
        newest = (
            MonteCarloRun.objects.filter(project_id__in=uncached)
            .order_by("project_id", "-taken_at")
            .distinct("project_id")
            .values_list("project_id", "p80", "taken_at")
        )
        for run_project_id, run_p80, taken_at in newest:
            if run_p80 is not None:
                out[str(run_project_id)] = (run_p80, taken_at.isoformat())
    return out


def task_slip_definitions() -> dict[str, str]:
    """The ``definitions`` map for the single-task baseline comparison (ADR-1314).

    That response names the slip ``finish_delta_days``; task rows name the same
    computation ``baseline_finish_variance_days``. One sentence, two field names —
    the sentence is keyed by the field the payload actually carries.
    """
    return {"finish_delta_days": METRIC_DEFINITIONS["baseline_finish_variance_days"]}


def definitions_field(name: str, keys: Iterable[str]) -> Any:
    """A typed ``definitions`` schema field: one string per key, documented by its sentence.

    Typed per endpoint (not a free-form ``{type: object}``) so a generated client and
    the e2e schema guard both know exactly which figures an endpoint defines.
    """
    key_list = list(keys)
    return inline_serializer(
        name=name,
        fields={
            k: serializers.CharField(
                help_text=METRIC_DEFINITIONS.get(
                    k,
                    # The commitment sentence varies with the rule that supplied the
                    # date; the payload carries the one that applied.
                    "Which commitment rule applied: the active baseline's finish, the "
                    "parent program's target date, or none.",
                )
            )
            for k in key_list
        },
        help_text=(
            "One sentence per figure on this payload saying what it measures (ADR-1314). "
            "Render it verbatim; never substitute a client-written definition."
        ),
    )


def _active_baseline_commitment(project_id: Any) -> tuple[date, bool | None] | None:
    """The active baseline's finish and the edge of the day it sits on, or None.

    ``has_cpm_dates=True`` only, for the reason ``program_rollup`` gives (#4242): a
    baseline snapshotted before CPM first ran has mostly-null finishes, so its max
    is not the plan's committed end. The reading is the start of the day only when
    every baselined row on that day finishes at its start; an unknown reading on
    any row makes the whole reading unknown, which ``finish_shift_days`` handles.
    """
    from django.db.models import Max

    from trueppm_api.apps.projects.models import Baseline, BaselineTask

    baseline_id = (
        Baseline.objects.filter(
            project_id=project_id, is_active=True, is_deleted=False, has_cpm_dates=True
        )
        .values_list("id", flat=True)
        .first()
    )
    if baseline_id is None:
        return None
    rows = BaselineTask.objects.filter(baseline_id=baseline_id, finish__isnull=False)
    end = rows.aggregate(end=Max("finish"))["end"]
    if end is None:
        return None
    readings = list(rows.filter(finish=end).values_list("finish_at_day_start", flat=True))
    at_start: bool | None = None if any(r is None for r in readings) else all(readings)
    return end, at_start


def forecast_commitment_facts(
    project: Any,
    *,
    p80: date | str | None,
    p80_at_day_start: bool | None,
    calendar_for: Callable[[], Any] | None,
) -> dict[str, Any]:
    """The commitment, the P80 delta against it, and the definitions for the forecast.

    Commitment rule (ADR-1314): the active baseline's finish; else, for a project
    in a program, ``Program.target_date``; else none. The delta is measured in
    working time like every other finish comparison (#4197) and is null with a
    machine-readable reason when it cannot be computed — never omitted (rule 119):
    ``no_commitment`` when no rule supplied a date, ``no_forecast`` when the run
    has no P80 to measure.

    Derived per response, never cached with the run: a baseline activated or a
    program date moved after the simulation changes the commitment without
    changing the forecast.
    """
    from trueppm_api.apps.scheduling.finish_reading import lazy_finish_shift_days

    commitment: tuple[date, bool | None] | None = _active_baseline_commitment(project.pk)
    source = "baseline" if commitment is not None else "none"
    if commitment is None and project.program_id is not None:
        program = getattr(project, "program", None)
        target = getattr(program, "target_date", None) if program is not None else None
        if target is not None and not getattr(program, "is_deleted", False):
            # A target date is a calendar day the program is due BY, read as its end.
            commitment, source = (target, False), "program_target"

    p80_day = date.fromisoformat(p80) if isinstance(p80, str) else p80
    delta: int | None = None
    reason: str | None = None
    if commitment is None:
        reason = "no_commitment"
    elif p80_day is None:
        reason = "no_forecast"
    else:
        delta = lazy_finish_shift_days(commitment, (p80_day, p80_at_day_start), calendar_for)

    defs = definitions_for(["p50", "p80", "p95", "p80_delta_vs_commitment_days"])
    defs["commitment_date"] = METRIC_DEFINITIONS[f"commitment_date.{source}"]
    return {
        "commitment_date": commitment[0].isoformat() if commitment is not None else None,
        "commitment_source": source,
        "p80_delta_vs_commitment_days": delta,
        "p80_delta_vs_commitment_reason": reason,
        "definitions": defs,
    }
