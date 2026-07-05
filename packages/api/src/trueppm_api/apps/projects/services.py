"""Service layer for project-scoped async operations.

Sprint close uses the transactional outbox pattern: ``enqueue_sprint_close``
writes a ``SprintCloseRequest`` row inside the same DB transaction as the
sprint state transition and attempts immediate Celery dispatch on commit. If
the broker is unavailable the row stays PENDING and the
``drain_sprint_close_requests`` Beat task picks it up within 30 seconds.

See ADR-0037 for the full design.
"""

from __future__ import annotations

import calendar
import logging
import uuid
from collections.abc import Iterable, Sequence
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils import timezone

if TYPE_CHECKING:
    from django.db.models import QuerySet

    from trueppm_api.apps.projects.models import Sprint

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Project-start auto-shift (#867)
# ---------------------------------------------------------------------------


def shift_project_start_if_needed(project: Any, candidate_start: date | None) -> date | None:
    """Pull a project's start date back to ``candidate_start`` when a task lands
    before it (#867 auto-shift).

    The CPM forward pass treats ``project.start_date`` as a hard floor
    (``early_start = max(project_start, planned_start, …)``), so a
    ``planned_start`` earlier than the project start would be a silent ghost
    value the engine immediately clamps. Rather than reject the placement (the
    prior #868 behavior) or clamp the task, the project boundary is elastic in
    the *earlier* direction: the user's intent to put the task on a date is
    honored and the project start follows. The engine invariant is untouched —
    no task starts before the project start because the project start moved.

    Only the earlier direction is automatic. Moving a project start *later* past
    existing tasks stays a deliberate, separately-validated Project edit.

    Mutates and saves ``project`` in the caller's transaction (bumping
    ``server_version`` via ``VersionedModel.save`` so sync clients observe the
    change, and recording a history row for audit) and returns the prior
    ``start_date`` so the caller can broadcast the change / offer an undo.
    Returns ``None`` when no shift was needed.
    """
    if candidate_start is None or candidate_start >= project.start_date:
        return None
    old_start: date = project.start_date
    project.start_date = candidate_start
    project.save(update_fields=["start_date"])
    return old_start


# ---------------------------------------------------------------------------
# Program rollup config — methodology-aware defaults (ADR-0169, #527)
# ---------------------------------------------------------------------------


def rollup_config_defaults(methodology: str) -> tuple[list[str], str]:
    """Return ``(enabled_kpis, aggregation_policy)`` for a program methodology.

    Single source of truth for new-program seeding and the data migration that
    backfills existing programs. The waterfall and agile sets were chosen from
    the VoC panel — 6 of 8 personas asked for methodology-aware defaults so a
    new program would not need manual configuration on day one.

    Why a tuple rather than a dict: the two call sites (post_save signal,
    data migration) both destructure once and write to two columns.
    """
    from trueppm_api.apps.projects.models import (
        AggregationPolicy,
        Methodology,
        RollupKpi,
    )

    waterfall = [
        RollupKpi.SCHEDULE_HEALTH.value,
        RollupKpi.BASELINE_VARIANCE.value,
        RollupKpi.CRITICAL_TASKS.value,
        RollupKpi.MILESTONE_HEALTH.value,
        RollupKpi.BUDGET_UTILIZATION.value,
        RollupKpi.COST_VARIANCE.value,
    ]
    agile = [
        RollupKpi.MILESTONE_HEALTH.value,
        RollupKpi.P80_COMPLETION.value,
        RollupKpi.AT_RISK_TASKS.value,
        RollupKpi.RISK_SCORE.value,
    ]

    if methodology == Methodology.WATERFALL:
        return (waterfall, AggregationPolicy.WORST.value)
    if methodology == Methodology.AGILE:
        return (agile, AggregationPolicy.WORST.value)
    # HYBRID (and any unexpected value) → union, de-duplicated, order preserved.
    seen: set[str] = set()
    union: list[str] = []
    for kpi in waterfall + agile:
        if kpi not in seen:
            seen.add(kpi)
            union.append(kpi)
    return (union, AggregationPolicy.WORST.value)


# ---------------------------------------------------------------------------
# Sprint close — outbox enqueue
# ---------------------------------------------------------------------------


def enqueue_sprint_close(
    sprint_id: str | uuid.UUID,
    *,
    carry_over_to: str = "backlog",
    pending_disposition: str = "carry",
    requested_by: Any | None = None,
) -> Any:
    """Insert a SprintCloseRequest outbox row and best-effort dispatch.

    Safe to call from inside an HTTP request transaction — Celery dispatch is
    deferred via ``transaction.on_commit`` so a rolled-back request never
    fires the worker. If immediate dispatch fails (broker down) the row
    remains PENDING and the drain Beat task processes it within 30 seconds.

    Args:
        sprint_id: UUID of the sprint to close.
        carry_over_to: Either ``"backlog"`` (default), ``"none"``, or a
            sprint UUID string. The drain task interprets this when
            reassigning incomplete tasks.
        pending_disposition: ADR-0102 §7 — ``"carry"`` (default) or ``"reject"``;
            how to dispose of tasks still pending acceptance at close.
        requested_by: User instance who initiated the close (nullable).

    Returns:
        The created ``SprintCloseRequest`` instance.
    """
    from trueppm_api.apps.projects.models import SprintCloseRequest

    req = SprintCloseRequest.objects.create(
        sprint_id=sprint_id,
        carry_over_to=carry_over_to,
        pending_disposition=pending_disposition,
        requested_by=requested_by,
    )

    def _dispatch() -> None:
        from trueppm_api.apps.projects.tasks import close_sprint

        try:
            close_sprint.delay(str(req.id))
        except Exception:
            logger.warning(
                "enqueue_sprint_close: could not immediately dispatch sprint=%s "
                "— drain task will pick it up within 30 s",
                sprint_id,
            )

    transaction.on_commit(_dispatch)
    return req


def enqueue_project_cascade_soft_delete(project_id: str | uuid.UUID) -> None:
    """Defer a soft-deleted project's child-tombstone cascade to Celery (#1112).

    The project row itself is tombstoned synchronously by the caller
    (``perform_destroy``); this only offloads the potentially huge child cascade
    (tasks, dependency edges, sprints, risks, baselines) so a 1000-task project
    does not run ~24k round-trips inside the request transaction.

    Dispatch is deferred with ``transaction.on_commit`` — a rolled-back delete
    (e.g. a later exception in the same ATOMIC_REQUESTS request) must never leave
    a worker cascading children of a project that was never actually deleted. If
    the broker is down at commit time the dispatch is swallowed; the cascade task
    is idempotent, so a manual re-dispatch or retry is always safe.
    """

    def _dispatch() -> None:
        from trueppm_api.apps.projects.tasks import cascade_project_soft_delete

        try:
            cascade_project_soft_delete.delay(str(project_id))
        except Exception:
            logger.warning(
                "enqueue_project_cascade_soft_delete: could not dispatch cascade for "
                "project=%s — children stay live until a re-dispatch (task is idempotent)",
                project_id,
            )

    transaction.on_commit(_dispatch)


# ---------------------------------------------------------------------------
# Capacity check — non-blocking warnings on activate
# ---------------------------------------------------------------------------


def _working_days(start: date, finish: date, working_days_mask: int = 31) -> int:
    """Count working days in [start, finish] inclusive using a weekday bitmask.

    Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64. Default 31 = Mon–Fri.
    """
    total = 0
    cur = start
    while cur <= finish:
        # Python: Monday=0 → bit 1; map weekday() to bitmask.
        bit = 1 << cur.weekday()
        if working_days_mask & bit:
            total += 1
        # Guard the final increment: stepping past date.max raises OverflowError.
        # Reachable only via an absurd finish (the serializer caps the span first,
        # #951) but kept here so no caller can crash the count.
        if cur >= date.max:
            break
        cur += timedelta(days=1)
    return total


def working_day_duration(start: date, finish: date, calendar: Any | None) -> int:
    """Working-day count in ``[start, finish]`` inclusive under a project calendar.

    This is the inverse of the scheduler's ``_finish_from_start`` (engine.py): a
    task whose stored ``duration`` is *D* occupies *D* working days, so resolving a
    Gantt bar resize to a dropped finish date must store the *working*-day span —
    not the raw calendar span — or a bar dragged across a weekend commits an
    inflated duration (#951). The weekday mask matches how the CPM pass builds its
    scheduler ``Calendar`` (``scheduling/tasks.py`` passes ``working_days`` only),
    so the duration derived here round-trips back to the same finish date through
    a recalc. Defaults to Mon–Fri (mask 31) when the project has no calendar.
    """
    mask = calendar.working_days if calendar is not None else 31
    return _working_days(start, finish, mask)


def _initials(name: str) -> str:
    """Two-letter uppercase initials from a person's display name."""
    parts = [p for p in name.split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def capacity_summary(sprint: Any) -> dict[str, Any]:
    """Compute per-person committed/available hours and aggregate totals.

    For each resource assigned to a task in the sprint, sum the committed
    work hours (``units × working_days × hours_per_day``) and compare to the
    resource's available hours. Returns every assigned member (not only
    over-allocated ones) plus an aggregate ``totals`` block — the Sprints
    capacity preflight panel (#228) renders both shapes from the same
    payload, so we shape it once here.

    Hours-per-day comes from the project calendar (8.0 default). Working
    days honour the calendar's ``working_days`` bitmask. ``pto_days`` is a
    placeholder zero until a dedicated time-off model lands.
    """
    from trueppm_api.apps.resources.models import TaskResource

    assignment_rows = list(
        TaskResource.objects.filter(task__sprint_id=sprint.pk, task__is_deleted=False)
        .select_related("resource")
        .values_list(
            "resource_id",
            "resource__name",
            "resource__max_units",
            "units",
            "task__early_start",
            "task__early_finish",
        )
    )
    return _capacity_summary_from_rows(sprint, assignment_rows)


def capacity_summaries_for_sprints(sprints: Any) -> dict[Any, dict[str, Any]]:
    """Batched :func:`capacity_summary` — one ``TaskResource`` query for many sprints.

    ``MeActiveSprintsView`` (#230) renders a capacity ratio for every active
    sprint the caller is on; calling :func:`capacity_summary` once per sprint
    issued a ``TaskResource`` query each (the #1012 N+1). This fetches every
    sprint's assignments in a single query keyed by ``task__sprint_id`` and
    dispatches each sprint's rows through the same per-assignment math, so the
    totals are byte-identical to the per-sprint path — only the query count
    changes.

    Callers should pass sprints with ``project__calendar`` already
    ``select_related`` so the per-sprint calendar read in the shared helper does
    not re-introduce a separate N+1.

    Returns a ``{sprint_pk: summary_dict}`` map; a sprint with no assignments
    maps to the same empty-totals shape :func:`capacity_summary` returns.
    """
    from trueppm_api.apps.resources.models import TaskResource

    sprint_list = list(sprints)
    pks = [s.pk for s in sprint_list]
    rows_by_sprint: dict[Any, list[Any]] = {}
    if pks:
        for row in (
            TaskResource.objects.filter(task__sprint_id__in=pks, task__is_deleted=False)
            .select_related("resource")
            .values_list(
                "resource_id",
                "resource__name",
                "resource__max_units",
                "units",
                "task__early_start",
                "task__early_finish",
                "task__sprint_id",
            )
        ):
            *core, sprint_id = row
            rows_by_sprint.setdefault(sprint_id, []).append(tuple(core))
    return {
        sprint.pk: _capacity_summary_from_rows(sprint, rows_by_sprint.get(sprint.pk, []))
        for sprint in sprint_list
    }


def _capacity_summary_from_rows(sprint: Any, assignment_rows: Any) -> dict[str, Any]:
    """Shared capacity math for :func:`capacity_summary` and its batched twin.

    ``assignment_rows`` is an iterable of ``(resource_id, resource_name,
    max_units, units, task_early_start, task_early_finish)`` tuples for the
    sprint. Extracting it keeps the single-sprint and batched paths computing
    identical totals from one source of truth (#1012).
    """
    project = sprint.project
    cal = project.calendar
    hours_per_day = float(cal.hours_per_day) if cal else 8.0
    wd_mask = cal.working_days if cal else 31
    working_days = _working_days(sprint.start_date, sprint.finish_date, wd_mask)
    if working_days <= 0:
        return {
            "members": [],
            "totals": {
                "committed_hours": 0.0,
                "available_hours": 0.0,
                "ratio": 0.0,
                "buffer_hours": 0.0,
                "label": "on_track",
                "pto_days": 0,
            },
            "working_days": 0,
            "hours_per_day": hours_per_day,
        }

    by_resource: dict[Any, dict[str, Any]] = {}
    for resource_id, resource_name, max_units, units, task_start, task_end in assignment_rows:
        # Compute working-day overlap between the task window and the sprint.
        # Fall back to the full sprint when CPM dates are not yet available.
        t_start = task_start or sprint.start_date
        t_end = task_end or sprint.finish_date
        overlap_start = max(t_start, sprint.start_date)
        overlap_end = min(t_end, sprint.finish_date)
        task_days = (
            _working_days(overlap_start, overlap_end, wd_mask)
            if overlap_start <= overlap_end
            else 0
        )
        entry = by_resource.setdefault(
            resource_id,
            {
                "name": resource_name,
                "max_units": max_units or Decimal("1.0"),
                "committed": Decimal("0"),
            },
        )
        entry["committed"] += (units or Decimal("0")) * Decimal(str(task_days))

    members: list[dict[str, Any]] = []
    total_committed = 0.0
    total_available = 0.0
    for resource_id, data in by_resource.items():
        # data["committed"] already encodes units × task_working_days per assignment.
        committed_hours = float(data["committed"]) * hours_per_day
        available_hours = float(data["max_units"]) * working_days * hours_per_day
        ratio = committed_hours / available_hours if available_hours > 0 else 0.0
        members.append(
            {
                "member_id": str(resource_id),
                "member_name": data["name"],
                "initials": _initials(data["name"]),
                "committed_hours": round(committed_hours, 2),
                "available_hours": round(available_hours, 2),
                "ratio": round(ratio, 4),
                "is_over": committed_hours > available_hours,
            }
        )
        total_committed += committed_hours
        total_available += available_hours

    members.sort(key=lambda m: m["member_name"])
    total_ratio = total_committed / total_available if total_available > 0 else 0.0
    if total_ratio > 1.0:
        label = "over_capacity"
    elif total_ratio >= 0.9:
        label = "at_risk"
    else:
        label = "on_track"

    return {
        "members": members,
        "totals": {
            "committed_hours": round(total_committed, 2),
            "available_hours": round(total_available, 2),
            "ratio": round(total_ratio, 4),
            "buffer_hours": round(total_available - total_committed, 2),
            "label": label,
            "pto_days": 0,
        },
        "working_days": working_days,
        "hours_per_day": hours_per_day,
    }


def capacity_check(sprint: Any) -> list[dict[str, Any]]:
    """Backwards-compatible wrapper: returns only the over-capacity warnings.

    Used by the activate endpoint (ADR-0037 Q2 amendment) which only surfaces
    over-allocated members. Full per-member data is exposed via
    ``capacity_summary`` and the ``/api/v1/sprints/<pk>/capacity/`` endpoint.
    """
    summary = capacity_summary(sprint)
    sprint_total_points = sprint.committed_points or 0
    warnings: list[dict[str, Any]] = []
    for member in summary["members"]:
        if not member["is_over"]:
            continue
        committed_hours = member["committed_hours"]
        available_hours = member["available_hours"]
        ratio = available_hours / committed_hours if committed_hours else 0
        suggested = round(sprint_total_points * ratio) if sprint_total_points else 0
        warnings.append(
            {
                "type": "over_capacity",
                "member_id": member["member_id"],
                "member_name": member["member_name"],
                "committed_hours": committed_hours,
                "available_hours": available_hours,
                "suggested_commitment_points": suggested,
            }
        )
    return warnings


# ---------------------------------------------------------------------------
# Burndown — real-time UPSERT helper
# ---------------------------------------------------------------------------


def upsert_burndown_for_sprint(sprint: Any, snapshot_date: date | None = None) -> None:
    """Compute and UPSERT today's burn snapshot for a sprint.

    Called inline from the task_status_changed signal; safe under
    concurrency thanks to the unique ``(sprint, snapshot_date)`` constraint.
    Idempotent — a second call on the same day overwrites with the latest
    figures.

    Args:
        sprint: Sprint instance (must be ACTIVE for the signal path).
        snapshot_date: Date to write; defaults to today (UTC).
    """
    from django.db import IntegrityError

    from trueppm_api.apps.projects.models import (
        SprintBurnSnapshot,
        TaskStatus,
        committed_sprint_tasks,
    )

    if snapshot_date is None:
        snapshot_date = timezone.localdate()

    # ADR-0102 §2: exclude pending mid-sprint injections — a pending task
    # contributes ZERO to remaining/completed/scope-change points. The burndown
    # line moves only when a task is accepted into the commitment.
    tasks = list(
        committed_sprint_tasks(sprint.pk).values_list("status", "story_points", "remaining_points")
    )
    completed_points = sum(sp or 0 for s, sp, _rp in tasks if s == TaskStatus.COMPLETE)
    completed_count = sum(1 for s, _sp, _rp in tasks if s == TaskStatus.COMPLETE)
    # Use remaining_points when set (issue #366); fall back to story_points for
    # tasks that pre-date the field or haven't been re-estimated mid-sprint.
    remaining_points = sum(
        (rp if rp is not None else (sp or 0)) for s, sp, rp in tasks if s != TaskStatus.COMPLETE
    )
    remaining_count = sum(1 for s, _sp, _rp in tasks if s != TaskStatus.COMPLETE)

    committed = sprint.committed_points or 0
    committed_count_initial = sprint.committed_task_count or 0
    # Scope change: positive when the sprint has gained more total points than
    # it started with (mid-sprint additions), negative when work was removed.
    current_total_points = remaining_points + completed_points
    current_total_count = remaining_count + completed_count
    scope_change_points = current_total_points - committed
    scope_change_count = current_total_count - committed_count_initial

    defaults = {
        "remaining_points": remaining_points,
        "remaining_task_count": remaining_count,
        "completed_points": completed_points,
        "completed_task_count": completed_count,
        "scope_change_points": scope_change_points,
        "scope_change_task_count": scope_change_count,
    }
    try:
        SprintBurnSnapshot.objects.update_or_create(
            sprint_id=sprint.pk,
            snapshot_date=snapshot_date,
            defaults=defaults,
        )
    except IntegrityError:
        # Concurrent insert lost the race — retry the update path explicitly.
        SprintBurnSnapshot.objects.filter(sprint_id=sprint.pk, snapshot_date=snapshot_date).update(
            **defaults
        )


# ---------------------------------------------------------------------------
# Tier-3 sprint-health — read-time hygiene signals (ADR-0101 §4)
# ---------------------------------------------------------------------------


def sprint_health(project_id: str | uuid.UUID) -> dict[str, Any]:
    """Tier-3 read-time sprint-health signals for a project (ADR-0101 §4, #988).

    Returns the same orphan / active-sprint-phase-span / parent-task-in-sprint
    signals the Sprints view used to derive in the browser — but the count, the
    show/hide threshold (the verdict), the tone, AND the consequence copy are all
    server-owned now, so a headless/MCP client gets identical guidance and the web
    renders ``detail`` verbatim (web-rule 141: never re-invent WBS jargon).

    Read-only; never blocks. Only *tripped* signals are returned (orphan > 0,
    active sprint spans ≥ 3 phases, any parent task in a sprint); a healthy
    project yields an empty list, mirroring the badge row that fades away when
    there is nothing to act on. This is a team+coach surface, not a velocity
    one — no signal-privacy gate applies (ADR-0101 §4).
    """
    from django.db.models import BooleanField, IntegerField, TextField
    from django.db.models.expressions import RawSQL

    from trueppm_api.apps.projects.models import Sprint, SprintState, Task

    active_sprint_id = (
        Sprint.objects.filter(project_id=project_id, state=SprintState.ACTIVE, is_deleted=False)
        .values_list("id", flat=True)
        .first()
    )

    # ``_has_child`` mirrors TaskViewSet.get_queryset()'s ``is_summary`` annotation
    # verbatim: a task is a "parent" iff some other non-deleted task sits exactly
    # one ltree level beneath it. Kept in lockstep with that query — if the summary
    # shape changes there, change it here too.
    has_child_sql = (
        "EXISTS("
        "  SELECT 1 FROM projects_task c"
        "  WHERE c.project_id = projects_task.project_id"
        "    AND c.is_deleted = false"
        "    AND c.id != projects_task.id"
        "    AND c.wbs_path IS NOT NULL"
        "    AND projects_task.wbs_path IS NOT NULL"
        "    AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{1}')::lquery"
        ")"
    )
    # ltree depth (nlevel) and L1 root label — the "phase" a task rolls up to.
    # NULL wbs_path → depth 0 / no phase, matching the web's `!wbs` handling.
    depth_sql = (
        "CASE WHEN projects_task.wbs_path IS NULL THEN 0 ELSE nlevel(projects_task.wbs_path) END"
    )
    l1_sql = (
        "CASE WHEN projects_task.wbs_path IS NULL THEN NULL "
        "ELSE subpath(projects_task.wbs_path, 0, 1)::text END"
    )

    rows = list(
        Task.objects.filter(project_id=project_id, is_deleted=False)
        .annotate(
            # nosec B611 — static SQL literals (no user input), empty params list;
            # the ltree expressions can't be expressed in the ORM. Bandit flags any RawSQL.
            # nosemgrep: avoid-raw-sql
            _has_child=RawSQL(has_child_sql, [], output_field=BooleanField()),  # nosec B611
            # nosemgrep: avoid-raw-sql
            _depth=RawSQL(depth_sql, [], output_field=IntegerField()),  # nosec B611
            # nosemgrep: avoid-raw-sql
            _l1=RawSQL(l1_sql, [], output_field=TextField()),  # nosec B611
        )
        .values("is_milestone", "sprint_id", "_has_child", "_depth", "_l1")
    )

    # Orphan: a leaf, non-milestone task with no sprint and no phase ancestor
    # (top-level wbs, depth ≤ 1). Mirrors the web `wbs.includes('.')` exclusion.
    orphan_count = sum(
        1
        for r in rows
        if not r["_has_child"]
        and not r["is_milestone"]
        and r["sprint_id"] is None
        and r["_depth"] <= 1
    )
    # Parent (summary) task assigned to a sprint — double-counts velocity.
    summary_in_sprint = sum(1 for r in rows if r["_has_child"] and r["sprint_id"] is not None)
    # Distinct L1 phase roots the active sprint's tasks span.
    phase_span = len(
        {
            r["_l1"]
            for r in rows
            if active_sprint_id is not None
            and r["sprint_id"] == active_sprint_id
            and r["_l1"] is not None
        }
    )

    signals: list[dict[str, Any]] = []
    if orphan_count > 0:
        signals.append(
            {
                "key": "orphan",
                "count": orphan_count,
                "tone": "info",
                "detail": (
                    f"{orphan_count} task{'' if orphan_count == 1 else 's'} "
                    "in no sprint and no phase"
                ),
            }
        )
    if phase_span >= 3:
        signals.append(
            {
                "key": "phase_span",
                "count": phase_span,
                "tone": "info",
                "detail": f"Active sprint spans {phase_span} phases",
            }
        )
    if summary_in_sprint > 0:
        # ADR-0101 §2: "parent task", never "summary task" — no WBS jargon.
        signals.append(
            {
                "key": "summary_in_sprint",
                "count": summary_in_sprint,
                "tone": "warn",
                "detail": (
                    f"{summary_in_sprint} parent task"
                    f"{'' if summary_in_sprint == 1 else 's'} in a sprint"
                ),
            }
        )
    return {"signals": signals}


# ---------------------------------------------------------------------------
# Velocity — rolling stats over closed sprints
# ---------------------------------------------------------------------------


def velocity_eligible_sprints(project_id: str | uuid.UUID) -> QuerySet[Sprint]:
    """The canonical "counts toward velocity" sprint set for a project (ADR-0113).

    A single source of truth for *which* sprints feed any velocity-derived number:
    the rolling average/band, ``team_velocity_per_day``, and the future
    ``Project.velocity_samples`` population that ADR-0065/0106 will hand to the
    scheduler. Routing every consumer through this predicate guarantees the
    ``exclude_from_velocity`` flag is applied exactly once and can never be baked
    out at one call site. Ordered newest-first; callers slice their own window.
    """
    from trueppm_api.apps.projects.models import Sprint, SprintState

    return Sprint.objects.filter(
        project_id=project_id,
        state=SprintState.COMPLETED,
        is_deleted=False,
        exclude_from_velocity=False,
    ).order_by("-closed_at")


def scheduler_velocity_inputs(
    project_id: str | uuid.UUID, calendar_working_days: int
) -> tuple[list[float], int | None]:
    """Velocity samples + working-day sprint length for the Monte Carlo engine.

    The ADR-0065/0106 wiring promised in :func:`velocity_eligible_sprints`: the last
    eight eligible sprints' completed-point totals become the engine's bootstrap
    population, so a SCRUM/story-point task samples sprints-to-completion from real
    throughput variance (``_sample_velocity_durations``, #411) instead of collapsing
    to its deterministic placeholder duration. Without these inputs the engine's
    agile path can never fire and an all-agile project — every story a one-day
    placeholder — forecasts a single flat date with no uncertainty band.

    The typical sprint span is converted from *calendar* to *working* days, the unit
    the engine multiplies the sprint count by, using the project calendar's
    working-days-per-week (``working_days`` is a 7-bit weekday bitmask, so Mon–Fri →
    ``5/7``). Returns ``([], None)`` when the team has no usable velocity signal (no
    closed, non-excluded sprint with recorded completed points), so the engine falls
    back to deterministic durations and the forecast is unchanged from pre-#411.
    """
    samples = [
        float(s.completed_points)
        # Last eight closed, velocity-eligible sprints — the same window the rolling
        # velocity statistics use (ADR-0037); newest-first, so the slice is recent.
        for s in velocity_eligible_sprints(project_id)[:8]
        if s.completed_points is not None
    ]
    if not samples:
        return [], None
    # popcount of the weekday bitmask = working days per week; guard the degenerate
    # all-zero mask (no weekday set) with the standard five-day fallback.
    working_days_per_week = bin(calendar_working_days).count("1") or 5
    sprint_length_working = max(
        1, round(_typical_sprint_length_days(project_id) * working_days_per_week / 7)
    )
    return samples, sprint_length_working


def velocity_summary(project_id: str | uuid.UUID) -> dict[str, Any]:
    """Return rolling velocity stats and forecast range for a project.

    Uses the last 8 closed sprints (per ADR-0037). For each metric (points,
    tasks) returns rolling avg, stdev, and a forecast range of avg ± 1 stdev
    rounded to int. Returns null fields when there are fewer than two closed
    sprints (stdev undefined).

    Sprints flagged ``exclude_from_velocity`` (ADR-0113) stay **visible** in the
    returned ``sprints`` list — each carries an ``exclude_from_velocity`` flag so
    the UI can mark rather than silently drop them — but are omitted from every
    computed statistic. ``excluded_count`` reports how many of the displayed
    sprints were excluded so the UI can render "N excluded from this forecast".
    """
    import statistics

    from trueppm_api.apps.projects.models import Sprint, SprintState

    # Display window: the last 8 closed sprints INCLUDING excluded ones, so a
    # recently-closed Sprint 0 still appears in the chart (marked), rather than
    # vanishing. Statistics below are computed over the eligible subset only.
    closed = list(
        Sprint.objects.filter(
            project_id=project_id,
            state=SprintState.COMPLETED,
            is_deleted=False,
        ).order_by("-closed_at")[:8]
    )

    eligible = [s for s in closed if not s.exclude_from_velocity]
    excluded_count = len(closed) - len(eligible)

    points: list[int] = [s.completed_points for s in eligible if s.completed_points is not None]
    counts: list[int] = [
        s.completed_task_count for s in eligible if s.completed_task_count is not None
    ]

    def _stats(values: list[int]) -> tuple[float | None, float | None, int | None, int | None]:
        if not values:
            return None, None, None, None
        avg = sum(values) / len(values)
        if len(values) < 2:
            return round(avg, 2), None, None, None
        sd = statistics.stdev(values)
        low = max(0, round(avg - sd))
        high = round(avg + sd)
        return round(avg, 2), round(sd, 2), low, high

    avg_p, sd_p, low_p, high_p = _stats(points)
    avg_t, sd_t, _low_t, _high_t = _stats(counts)

    # ADR-0065: surface team_velocity_per_day for CPM calibration. Lives behind
    # a function call rather than duplicating the rolling-window logic here so
    # the calibration service and the velocity endpoint stay in sync.
    from trueppm_api.apps.scheduling.services import compute_team_velocity_per_day

    velocity_per_day = compute_team_velocity_per_day(project_id)

    # Chronological (oldest -> newest) so each entry can carry its delta vs the
    # immediately prior closed sprint (#984) — server-owned so MCP/mobile don't
    # diff the series themselves. None when either side has no completed total.
    # Deltas walk the *eligible* series only (ADR-0113): an excluded sprint never
    # anchors a delta, and excluded sprints themselves carry no delta — the trend
    # the team reads must match the velocity the stats above report.
    chronological = list(reversed(closed))
    sprint_entries = []
    prev_eligible: Sprint | None = None
    for s in chronological:
        prev = None if s.exclude_from_velocity else prev_eligible
        delta_points = (
            s.completed_points - prev.completed_points
            if prev is not None
            and s.completed_points is not None
            and prev.completed_points is not None
            else None
        )
        delta_tasks = (
            s.completed_task_count - prev.completed_task_count
            if prev is not None
            and s.completed_task_count is not None
            and prev.completed_task_count is not None
            else None
        )
        sprint_entries.append(
            {
                "id": str(s.pk),
                "name": s.name,
                "start_date": s.start_date.isoformat(),
                "finish_date": s.finish_date.isoformat(),
                "committed_points": s.committed_points,
                "completed_points": s.completed_points,
                "committed_task_count": s.committed_task_count,
                "completed_task_count": s.completed_task_count,
                "delta_vs_prior_points": delta_points,
                "delta_vs_prior_tasks": delta_tasks,
                # ADR-0113: marked, not dropped — the UI greys/hatches excluded
                # bars and skips them in the rolling-avg line and ± stdev band.
                "exclude_from_velocity": s.exclude_from_velocity,
            }
        )
        if not s.exclude_from_velocity:
            prev_eligible = s

    return {
        "sprints": sprint_entries,
        "rolling_avg_points": avg_p,
        "rolling_stdev_points": sd_p,
        "forecast_range_low": low_p,
        "forecast_range_high": high_p,
        "rolling_avg_tasks": avg_t,
        "rolling_stdev_tasks": sd_t,
        "team_velocity_per_day": float(velocity_per_day) if velocity_per_day else None,
        # ADR-0113: how many of the displayed sprints are excluded, so the UI can
        # render "N excluded from this forecast" without re-deriving it client-side.
        "excluded_count": excluded_count,
    }


# ---------------------------------------------------------------------------
# Project burn chart — HistoricalTask replay (issue #239 / ADR-0022)
# ---------------------------------------------------------------------------


def _date_range_inclusive(start: date, end: date) -> list[date]:
    """Return every date from start to end inclusive, ascending."""
    days: list[date] = []
    cur = start
    while cur <= end:
        days.append(cur)
        cur += timedelta(days=1)
    return days


def burn_series(
    project_id: str | uuid.UUID,
    *,
    chart_type: str,
    since: date,
    until: date,
    metric: str = "tasks",
) -> dict[str, Any]:
    """Compute a daily burn series for a project from HistoricalTask snapshots.

    Replays the HistoricalTask table to reconstruct task state on each day
    in ``[since, until]``. For each task we keep its most recent state
    (status + story_points) whose ``history_date`` is on or before that
    day. From those daily snapshots we derive ``actual`` (remaining for
    burndown, completed for burnup), ``scope`` (total committed work), and
    a linear ``ideal`` curve.

    Args:
        project_id: Project UUID.
        chart_type: ``burndown`` or ``burnup``. Drives which actual curve
            is returned (remaining vs completed).
        since: Window start (inclusive).
        until: Window end (inclusive).
        metric: ``tasks`` (default; counts) or ``points`` (sums
            ``story_points`` — null points contribute zero).

    Returns:
        Dict shaped like::

            {
              "chart_type": "burndown",
              "metric": "tasks",
              "since": "...",
              "until": "...",
              "series": [{"date", "actual", "ideal", "scope"}, ...],
              "baseline_series": [{"date", "planned"}, ...] | absent,
            }

    The ``baseline_series`` key is only present when the project has an
    active baseline; ``planned`` for each date is the count (or point sum)
    of baselined tasks whose snapshot finish date is greater than that
    date — a proper "planned remaining" curve, not a linear interpolation.
    """
    from trueppm_api.apps.projects.models import (
        Baseline,
        BaselineTask,
        Task,
        TaskStatus,
    )

    HistoricalTask = Task.history.model

    if chart_type not in ("burndown", "burnup"):
        raise ValueError(f"Invalid chart_type: {chart_type}")
    if metric not in ("tasks", "points"):
        raise ValueError(f"Invalid metric: {metric}")
    if until < since:
        raise ValueError("`until` must be on or after `since`")

    days = _date_range_inclusive(since, until)
    end_of_until = datetime.combine(
        until, datetime.max.time(), tzinfo=timezone.get_current_timezone()
    )

    # Pull every history row for tasks in the project up to end_of_until,
    # ordered so that .latest-by-task wins. Newest first lets us drop
    # duplicates per task efficiently.
    history_rows = list(
        HistoricalTask.objects.filter(
            project_id=project_id,
            history_date__lte=end_of_until,
        )
        .order_by("id", "-history_date")
        .values("id", "history_date", "status", "story_points", "history_type", "is_deleted")
    )

    # Index history by task id, sorted descending by history_date so that
    # `bisect`-style lookups can find "latest state at date D" in O(log n).
    by_task: dict[Any, list[dict[str, Any]]] = {}
    for row in history_rows:
        by_task.setdefault(row["id"], []).append(row)
    # Each list is already newest-first because of the order_by above.

    def _value(row: dict[str, Any]) -> int:
        if metric == "points":
            return int(row.get("story_points") or 0)
        return 1

    series: list[dict[str, Any]] = []
    for day in days:
        end_of_day = datetime.combine(
            day, datetime.max.time(), tzinfo=timezone.get_current_timezone()
        )
        scope = 0
        completed = 0
        for rows in by_task.values():
            # First row whose history_date <= end_of_day (rows are newest-first).
            state = next((r for r in rows if r["history_date"] <= end_of_day), None)
            if state is None:
                continue
            if state["history_type"] == "-" or state.get("is_deleted"):
                continue  # task didn't exist (or was deleted) on this day
            value = _value(state)
            scope += value
            if state["status"] == TaskStatus.COMPLETE:
                completed += value
        remaining = scope - completed
        series.append(
            {
                "date": day.isoformat(),
                "scope": scope,
                "actual": remaining if chart_type == "burndown" else completed,
            }
        )

    # Linear ideal curve. Burndown anchors to the first day's scope (the
    # commitment baseline draws down to zero); burnup anchors to the final
    # day's scope (the team plans to complete *current* scope by end).
    # This asymmetry matches how PMs read each chart.
    initial_scope = series[0]["scope"] if series else 0
    final_scope = series[-1]["scope"] if series else 0
    span_days = max(len(days) - 1, 1)
    for index, point in enumerate(series):
        progress = index / span_days
        if chart_type == "burndown":
            point["ideal"] = round(initial_scope * (1 - progress), 2)
        else:
            point["ideal"] = round(final_scope * progress, 2)

    payload: dict[str, Any] = {
        "chart_type": chart_type,
        "metric": metric,
        "since": since.isoformat(),
        "until": until.isoformat(),
        "series": series,
    }

    # Baseline overlay — present only when an active baseline exists.
    active_baseline = Baseline.objects.filter(
        project_id=project_id, is_active=True, is_deleted=False
    ).first()
    if active_baseline is not None:
        if metric == "points":
            # Join baseline task list with live tasks to obtain story_points.
            from trueppm_api.apps.projects.models import Task as _Task

            bt_rows = list(active_baseline.tasks.values("task_id", "finish"))
            live_sp: dict[str, int] = {
                str(tid): sp or 0
                for tid, sp in _Task.objects.filter(
                    id__in=[r["task_id"] for r in bt_rows], is_deleted=False
                ).values_list("id", "story_points")
            }
            baseline_tasks_pts = [(str(r["task_id"]), r["finish"]) for r in bt_rows]
            total_pts = sum(live_sp.get(tid, 0) for tid, _ in baseline_tasks_pts)
            if total_pts > 0:
                baseline_series: list[dict[str, Any]] = []
                for day in days:
                    done_pts = sum(
                        live_sp.get(tid, 0)
                        for tid, finish in baseline_tasks_pts
                        if finish is not None and finish <= day
                    )
                    if chart_type == "burndown":
                        baseline_series.append(
                            {"date": day.isoformat(), "planned": total_pts - done_pts}
                        )
                    else:
                        baseline_series.append({"date": day.isoformat(), "planned": done_pts})
                payload["baseline_series"] = baseline_series
        else:
            baseline_tasks = list(
                BaselineTask.objects.filter(baseline=active_baseline).values("finish")
            )
            if baseline_tasks:
                total = len(baseline_tasks)
                baseline_series = []
                for day in days:
                    done = sum(
                        1 for t in baseline_tasks if t["finish"] is not None and t["finish"] <= day
                    )
                    if chart_type == "burndown":
                        baseline_series.append({"date": day.isoformat(), "planned": total - done})
                    else:
                        baseline_series.append({"date": day.isoformat(), "planned": done})
                payload["baseline_series"] = baseline_series

    return payload


# ---------------------------------------------------------------------------
# Carry-over executor (used by drain task)
# ---------------------------------------------------------------------------


_CARRY_OVER_INCOMPLETE_STATUSES = ("BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW")


def apply_carry_over(sprint: Any, carry_over_to: str) -> list[str]:
    """Reassign incomplete tasks per the carry-over policy.

    Called from inside ``close_sprint`` after ``completed_*`` is snapshotted
    and the sprint state has been advanced. ``completed_*`` reflects only
    tasks that completed within the sprint window — the carry-over move is
    pure FK reassignment.

    Returns the IDs of the tasks that were moved, so the caller can broadcast a
    single ``tasks_bulk_mutated`` event — without it, connected clients keep
    showing the carried-over tasks under the just-closed sprint until a refetch.
    """
    from trueppm_api.apps.projects.models import Task, TaskStatus

    if carry_over_to == "none":
        return []

    incomplete = Task.objects.filter(
        sprint_id=sprint.pk,
        status__in=_CARRY_OVER_INCOMPLETE_STATUSES,
        is_deleted=False,
    )
    moved_ids: list[str] = []
    if carry_over_to == "backlog":
        # Iterate to call .save() so VersionedModel bumps server_version on each
        # task — queryset.update() bypasses the model and mobile sync misses it.
        for task in incomplete:
            task.sprint = None
            task.status = TaskStatus.BACKLOG
            task.save(update_fields=["sprint", "status"])
            moved_ids.append(str(task.pk))
        return moved_ids

    # Otherwise treat as a UUID string referencing another sprint in the same
    # project. Caller is expected to have validated this upstream.
    for task in incomplete:
        task.sprint_id = carry_over_to
        task.save(update_fields=["sprint"])
        moved_ids.append(str(task.pk))
    return moved_ids


def snapshot_sprint_task_outcomes(sprint: Any, *, carry_over_to: str) -> None:
    """Record per-task membership-at-close for sprint review (ADR-0176 §2, #982).

    Writes one ``SprintTaskOutcome`` row for every task linked to ``sprint`` at
    close. MUST be called inside the close transaction, AFTER
    ``snapshot_completed_metrics`` (so ``final_status`` matches the state the
    completed_* snapshot used) and BEFORE ``apply_carry_over`` (which mutates
    ``Task.sprint`` and would otherwise erase the membership set).

    Disposition is derived from ``final_status`` + the carry-over *policy* (not
    post-hoc from the moved-ID list) so it stays faithful even if #871 later
    restructures the move: COMPLETE -> ``completed``; incomplete + a sprint
    target -> ``carried`` (with ``next_sprint``); incomplete + ``backlog`` /
    ``none`` -> ``dropped``. Idempotent: ``bulk_create(ignore_conflicts=True)``
    against the ``(sprint, task)`` unique constraint, so an outbox re-drain is a
    no-op. The caller does NOT wrap this in try/except — capturing the audit is
    part of the close's definition of done, so a failure must roll the close back
    and let the drain retry.
    """
    from trueppm_api.apps.projects.models import (
        SprintTaskDisposition,
        SprintTaskOutcome,
        Task,
        TaskStatus,
    )

    # "none" leaves incomplete tasks in the closed sprint; "backlog" nulls the FK;
    # any other value is a destination sprint UUID. Only the last is a carry.
    carries_to_sprint = carry_over_to not in ("none", "backlog")
    next_sprint_id = carry_over_to if carries_to_sprint else None

    rows = []
    for task in Task.objects.filter(sprint_id=sprint.pk, is_deleted=False):
        if task.status == TaskStatus.COMPLETE:
            disposition = SprintTaskDisposition.COMPLETED
            row_next_sprint_id = None
        elif carries_to_sprint and task.status in _CARRY_OVER_INCOMPLETE_STATUSES:
            # Only tasks apply_carry_over actually moves count as carried. A status
            # outside the carry-over filter (e.g. ON_HOLD) is left in the closed
            # sprint even under a sprint-target policy, so it is "dropped" (not
            # carried forward), not "carried".
            disposition = SprintTaskDisposition.CARRIED
            row_next_sprint_id = next_sprint_id
        else:
            disposition = SprintTaskDisposition.DROPPED
            row_next_sprint_id = None
        rows.append(
            SprintTaskOutcome(
                sprint=sprint,
                task=task,
                task_short_id=f"T-{task.short_id}" if task.short_id else "",
                task_title=task.name,
                story_points=task.story_points,
                final_status=task.status,
                disposition=disposition,
                next_sprint_id=row_next_sprint_id,
                was_pending=task.sprint_pending,
            )
        )
    if rows:
        SprintTaskOutcome.objects.bulk_create(rows, ignore_conflicts=True)


def incoming_carryover(sprint: Any) -> dict[str, Any]:
    """Read-only "what rolled forward from the prior sprint" preview (#865, ADR-0094 §3).

    Re-derives, for a PLANNED ``sprint``, the prior *closed* sprint's unfinished
    tasks and whether each one was pulled into this sprint — surfacing the
    close-time ``apply_carry_over`` decision as a Planning-side hint without
    mutating anything.

    The prior sprint is the most-recently-finished COMPLETED sprint in the same
    project whose ``finish_date`` precedes this sprint's ``start_date``. Its
    unfinished set is read from the immutable ``SprintTaskOutcome`` snapshot
    (``final_status != COMPLETE``) rather than the live ``Sprint.tasks`` set:
    carry-over reassigns the task ``sprint`` FK at close, so the closed sprint no
    longer holds the carried tasks — only the snapshot does. The snapshot also
    survives a later task hard-delete (``task`` FK is SET_NULL), so the preview
    stays faithful. ``pulled_in_to_current`` is True when the live task is now
    linked to *this* PLANNED sprint.

    Returns ``{"prior_sprint": {...} | None, "tasks": [...]}`` — an empty
    ``tasks`` list (and ``prior_sprint": None``) when there is no prior closed
    sprint, which the Planning sidebar uses to suppress itself.
    """
    from trueppm_api.apps.projects.models import Sprint, SprintState, TaskStatus

    prior = (
        Sprint.objects.filter(
            project_id=sprint.project_id,
            state=SprintState.COMPLETED,
            finish_date__lt=sprint.start_date,
            is_deleted=False,
        )
        .order_by("-finish_date")
        .first()
    )
    if prior is None:
        return {"prior_sprint": None, "tasks": []}

    outcomes = (
        prior.task_outcomes.exclude(final_status=TaskStatus.COMPLETE)
        .select_related("task")
        .order_by("task_short_id")
    )
    tasks: list[dict[str, Any]] = []
    for o in outcomes:
        live = o.task if (o.task is not None and not o.task.is_deleted) else None
        tasks.append(
            {
                "id": str(o.task_id) if o.task_id else None,
                "short_id": o.task_short_id,
                "name": o.task_title,
                "story_points": o.story_points,
                "pulled_in_to_current": bool(live is not None and live.sprint_id == sprint.pk),
            }
        )
    return {
        "prior_sprint": {
            "id": str(prior.pk),
            "short_id_display": f"SP-{prior.short_id}" if prior.short_id else "",
            "name": prior.name,
            "start_date": prior.start_date.isoformat(),
            "finish_date": prior.finish_date.isoformat(),
        },
        "tasks": tasks,
    }


def compute_sprint_burn_status(sprint: Any, snapshots: list[Any]) -> dict[str, Any]:
    """Server-compute a sprint's burn pace (#984).

    Moves the burn math that lived in the web ``BurnChart`` server-side so MCP /
    mobile / any REST consumer can read the pace verdict and projected finish
    without re-deriving them. Uses the same linear-ideal + trend formula as the
    ``my-active-sprints`` feed so the two never drift.

    Returns ``{burn_status, trend_points, projected_finish_date}``:
      - ``no_data`` — no points commitment baseline, or no snapshots yet;
      - ``ahead`` — more than ~10% of committed ahead of the ideal line;
      - ``behind`` — more than ~10% behind;
      - ``on_track`` — within +/-10% of ideal.
    ``trend_points`` is signed (positive = ahead of ideal). ``snapshots`` must be
    ordered ascending by date (the caller passes the burndown series).
    """
    import math
    from datetime import timedelta

    from django.utils import timezone

    committed = sprint.committed_points or 0
    if committed <= 0 or not snapshots:
        return {"burn_status": "no_data", "trend_points": None, "projected_finish_date": None}

    today = timezone.localdate()
    window = (sprint.finish_date - sprint.start_date).days + 1
    elapsed = (today - sprint.start_date).days + 1
    day = max(1, min(elapsed, window))
    remaining = snapshots[-1].remaining_points
    ideal_now = committed * (1 - day / window) if window > 0 else 0
    trend_points = round(ideal_now - remaining)  # positive = ahead of ideal

    threshold = max(1, round(committed * 0.1))
    if trend_points > threshold:
        burn_status = "ahead"
    elif trend_points < -threshold:
        burn_status = "behind"
    else:
        burn_status = "on_track"

    # Projected finish: today + remaining / (points burned per day so far).
    burn_rate = (committed - remaining) / day if day > 0 else 0
    projected_finish_date = None
    if burn_rate > 0 and remaining > 0:
        forecast_days = math.ceil(remaining / burn_rate)
        projected_finish_date = (today + timedelta(days=forecast_days)).isoformat()

    return {
        "burn_status": burn_status,
        "trend_points": trend_points,
        "projected_finish_date": projected_finish_date,
    }


def me_work_signals(
    user: Any,
    active_sprints: Iterable[Any],
    today: date | None = None,
) -> dict[str, Any]:
    """Cross-program aggregate signals for the My Work focus cards (#1236, ADR-0221).

    Rolls up, over the requesting user's *own* member projects (the same scope as
    the ``/me/work/`` task queryset), the signals for which a real server-side
    computation already exists — and honestly omits the rest (rule 120: never
    fabricate a number). Each key below is present **only** when it has real data;
    an absent key tells the web to render that card as-is.

    Backable signals surfaced here:
      - ``schedule_health`` — worst-first reduce of the per-project SPI-proxy band
        (:func:`program_rollup._schedule_health_by_project`). Omitted when every
        member project is ``unknown`` (no baseline / CPM basis yet).
      - ``forecast`` — the latest (max) Monte-Carlo P80 finish across the member
        projects that have a persisted :class:`MonteCarloRun`. Omitted when none do.
      - ``sprint_burndown`` — the real :class:`SprintBurnSnapshot` series for the
        user's soonest-ending active sprint (the clock that matters most), plus the
        server-computed burn pace. Omitted when the user has no active sprint with a
        snapshot.

    Deliberately **no utilization / capacity key**: there is no cross-program
    per-user "load vs target" computation keyed off the user's assigned work
    (the only capacity math is sprint-scoped and driven by ``TaskResource``
    allocations, a different assignment axis than ``Task.assignee``). Surfacing one
    would be fabrication-adjacent, so the "your load" card stays an honest count.

    ``active_sprints`` is the already-materialized active-sprint queryset from the
    view, passed in to avoid re-querying; the lead sprint is chosen from it. Pure
    read — deterministic for a given DB state, safe to call on every GET.
    """
    from trueppm_api.apps.access.models import ProjectMembership
    from trueppm_api.apps.projects.models import AggregationPolicy, SprintBurnSnapshot
    from trueppm_api.apps.projects.program_rollup import (
        _reduce_health,
        _schedule_health_by_project,
    )
    from trueppm_api.apps.scheduling.models import MonteCarloRun

    if today is None:
        today = timezone.localdate()

    signals: dict[str, Any] = {}

    # The user's member projects — the aggregate scope. One query, reused below.
    # Excludes soft-deleted projects so the signal scope mirrors the /me/work/
    # task queryset exactly (a project dropped from the task list must not linger
    # in its schedule-health / forecast rollup).
    member_project_ids = list(
        ProjectMembership.objects.filter(user=user, is_deleted=False, project__is_deleted=False)
        .values_list("project_id", flat=True)
        .distinct()
    )
    if not member_project_ids:
        return signals

    # ── Schedule health / SPI (worst-first) ─────────────────────────────────
    bands_by_project = _schedule_health_by_project(member_project_ids, today)
    band = _reduce_health(
        list(bands_by_project.values()),
        AggregationPolicy.WORST.value,
        {},  # weights unused for the WORST policy
        member_project_ids,
    )
    real_bands = sum(1 for b in bands_by_project.values() if b != "unknown")
    if band != "unknown" and real_bands > 0:
        signals["schedule_health"] = {"band": band, "project_count": real_bands}

    # ── Monte-Carlo P80 ship-date forecast ──────────────────────────────────
    # Latest run per member project via DISTINCT ON (one query), then the latest
    # (max) P80 finish across them — the honest "when is everything I'm on done at
    # 80% confidence". Projects with no run contribute nothing.
    latest_runs = list(
        MonteCarloRun.objects.filter(project_id__in=member_project_ids, p80__isnull=False)
        .order_by("project_id", "-taken_at")
        .distinct("project_id")
        .select_related("project")
    )
    # p80 is non-null by the filter above; ``or date.min`` only satisfies the
    # type-checker for the max key (the fallback can never be selected).
    lead_run = max(latest_runs, key=lambda r: r.p80 or date.min, default=None)
    if lead_run is not None and lead_run.p80 is not None:
        signals["forecast"] = {
            "p80_finish": lead_run.p80.isoformat(),
            "project_id": str(lead_run.project_id),
            "project_name": lead_run.project.name,
            "as_of": lead_run.taken_at.isoformat(),
        }

    # ── Sprint burndown (soonest-ending active sprint) ──────────────────────
    sprint_list = list(active_sprints)
    lead_sprint = min(sprint_list, key=lambda s: s.finish_date, default=None)
    if lead_sprint is not None:
        snapshots = list(
            SprintBurnSnapshot.objects.filter(sprint_id=lead_sprint.pk).order_by("snapshot_date")
        )
        if snapshots:
            burn = compute_sprint_burn_status(lead_sprint, snapshots)
            signals["sprint_burndown"] = {
                "sprint_id": str(lead_sprint.pk),
                "sprint_name": lead_sprint.name,
                "committed_points": lead_sprint.committed_points or 0,
                "series": [
                    {"date": s.snapshot_date.isoformat(), "remaining_points": s.remaining_points}
                    for s in snapshots
                ],
                "burn_status": burn["burn_status"],
                "trend_points": burn["trend_points"],
                "projected_finish_date": burn["projected_finish_date"],
            }

    return signals


def _milestone_slip_for_sprint(sprint: Any) -> dict[str, Any] | None:
    """Realized schedule slip of the bound milestone vs its active baseline (#1098).

    Pairs the sprint's points miss with its days-of-slip so the closed-sprint card
    answers "what did this sprint do to my milestone date" in one read, instead of
    leaving the PM to leave for the Schedule view and eyeball it.

    This is the *realized* consequence, deliberately NOT the milestone rollup's
    planned ``variance_days`` (which compares sprint plan dates to CPM): the
    milestone's actual finish (once hit) or its current CPM forecast, measured
    against the baseline finish committed at plan time. Positive ``slip_days`` = late.

    Schedule facts are not velocity-private (mirrors the milestone-health carve-out),
    so this is never ADR-0104-gated — only the points half of the rendered line is.
    Returns None (the card hides the line) unless the sprint is bound to a live
    milestone with a computable forecast finish AND an active baseline carries a
    finish date for that milestone.
    """
    from trueppm_api.apps.projects.models import Baseline, BaselineTask

    milestone = sprint.target_milestone
    if milestone is None or milestone.is_deleted:
        return None
    # actual_finish once the milestone is hit, else the live CPM forecast spine
    # (consistent with ForecastSnapshot.cpm_finish / reforecast-on-close, #860).
    forecast_finish = milestone.actual_finish or milestone.early_finish
    if forecast_finish is None:
        return None

    active_baseline = Baseline.objects.filter(
        project_id=sprint.project_id, is_active=True, is_deleted=False
    ).first()
    if active_baseline is None:
        return None
    # .first() returns None both when there is no row and when the row's finish is
    # null — either way the slip is uncomputable and the line is hidden.
    baseline_finish = (
        BaselineTask.objects.filter(baseline=active_baseline, task_id=milestone.pk)
        .values_list("finish", flat=True)
        .first()
    )
    if baseline_finish is None:
        return None

    return {
        "milestone_id": str(milestone.pk),
        "milestone_name": milestone.name,
        "milestone_short_id": f"T-{milestone.short_id}" if milestone.short_id else "",
        "slip_days": (forecast_finish - baseline_finish).days,
        "baseline_finish": baseline_finish.isoformat(),
        "forecast_finish": forecast_finish.isoformat(),
        "basis": "actual" if milestone.actual_finish is not None else "forecast",
    }


def sprint_outcome_payload(sprint: Any, request: Any) -> dict[str, Any]:
    """Assemble the consolidated sprint-review read (#985, ADR-0176 §3).

    Composes the closing membership ("what didn't ship", #982), the goal verdict
    (#983), the velocity delta + burn status (#984), the commitment aggregates,
    a retro summary, and the realized milestone slip (#1098) into one read so the
    #567 UI and the MCP adapter bind to a single endpoint instead of stitching five
    calls or deriving review numbers client-side (the API-first contract).

    Privacy (ADR-0104) is enforced here, once: when the requester's tier is below
    the velocity audience, the whole ``velocity`` block is omitted AND the
    per-task ``story_points`` in ``didnt_ship`` are nulled (so the suppressed
    point total can't be reconstructed by summing line items) — titles, counts,
    and dispositions stay. The commitment completion ratios stay (the
    "milestone-health %" carve-out). Retro free text rides the RetroVisibility
    gate.

    Works for any state: CLOSED returns the snapshotted membership; ACTIVE/PLANNED
    return a ``provisional`` live derivation (current incomplete tasks, disposition
    not yet decided). ``outcome_recorded`` is False for sprints closed before #982
    shipped (no SprintTaskOutcome rows) so the client can say so honestly.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.projects.models import (
        SprintRetro,
        SprintState,
        SprintTaskDisposition,
        SprintTaskOutcome,
        Task,
        TaskStatus,
    )
    from trueppm_api.apps.projects.signal_privacy_services import can_read_signal

    is_closed = sprint.state == SprintState.COMPLETED
    provisional = not is_closed
    velocity_readable = can_read_signal(request, sprint.project_id, "velocity")

    # --- didn't-ship list ---------------------------------------------------
    outcome_recorded = False
    didnt_ship: list[dict[str, Any]] = []
    if is_closed:
        rows = list(SprintTaskOutcome.objects.filter(sprint=sprint).select_related("next_sprint"))
        outcome_recorded = len(rows) > 0
        for r in rows:
            if r.disposition == SprintTaskDisposition.COMPLETED:
                continue
            didnt_ship.append(
                {
                    "task_id": str(r.task_id) if r.task_id else None,
                    "task_short_id": r.task_short_id,
                    "task_title": r.task_title,
                    "story_points": r.story_points if velocity_readable else None,
                    "final_status": r.final_status,
                    "disposition": r.disposition,
                    "next_sprint_id": str(r.next_sprint_id) if r.next_sprint_id else None,
                    "next_sprint_name": r.next_sprint.name if r.next_sprint else None,
                    "was_pending": r.was_pending,
                }
            )
    else:
        # Provisional: current incomplete tasks; disposition is decided at close.
        for t in Task.objects.filter(sprint_id=sprint.pk, is_deleted=False).exclude(
            status=TaskStatus.COMPLETE
        ):
            didnt_ship.append(
                {
                    "task_id": str(t.pk),
                    "task_short_id": f"T-{t.short_id}" if t.short_id else "",
                    "task_title": t.name,
                    "story_points": t.story_points if velocity_readable else None,
                    "final_status": t.status,
                    "disposition": None,  # not decided until close
                    "next_sprint_id": None,
                    "next_sprint_name": None,
                    "was_pending": t.sprint_pending,
                }
            )

    summary = {
        "carried_count": sum(
            1 for d in didnt_ship if d["disposition"] == SprintTaskDisposition.CARRIED
        ),
        "carried_points": sum(
            d["story_points"] or 0
            for d in didnt_ship
            if d["disposition"] == SprintTaskDisposition.CARRIED
        )
        if velocity_readable
        else None,
        "dropped_count": sum(
            1 for d in didnt_ship if d["disposition"] == SprintTaskDisposition.DROPPED
        ),
        "dropped_points": sum(
            d["story_points"] or 0
            for d in didnt_ship
            if d["disposition"] == SprintTaskDisposition.DROPPED
        )
        if velocity_readable
        else None,
    }

    # --- commitment (always; completion ratios are the carve-out) -----------
    committed_p = sprint.committed_points
    completed_p = sprint.completed_points
    committed_t = sprint.committed_task_count
    completed_t = sprint.completed_task_count
    commitment = {
        "committed_points": committed_p,
        "committed_task_count": committed_t,
        "completed_points": completed_p,
        "completed_task_count": completed_t,
        "completion_ratio_points": round((completed_p or 0) / committed_p, 4)
        if committed_p
        else None,
        "completion_ratio_tasks": round((completed_t or 0) / committed_t, 4)
        if committed_t
        else None,
    }

    # --- velocity block (ADR-0104 gated) ------------------------------------
    velocity_block: dict[str, Any] | None = None
    if velocity_readable:
        snapshot_list = list(sprint.burn_snapshots.all().order_by("snapshot_date"))
        burn = compute_sprint_burn_status(sprint, snapshot_list)
        summary_v = velocity_summary(sprint.project_id)
        entry = next((e for e in summary_v["sprints"] if e["id"] == str(sprint.pk)), None)
        velocity_block = {
            "completed_points": completed_p,
            "velocity_delta_points": entry["delta_vs_prior_points"] if entry else None,
            "rolling_avg_points": summary_v["rolling_avg_points"],
            "burn_status": burn["burn_status"],
            "trend_points": burn["trend_points"],
            "projected_finish_date": burn["projected_finish_date"],
        }

    # --- retro summary (free-text gated by RetroVisibility) ------------------
    retro_summary: dict[str, Any] | None = None
    retro = SprintRetro.objects.filter(sprint=sprint).prefetch_related("action_items").first()
    if retro is not None:
        membership = None
        user = getattr(request, "user", None)
        if user is not None and getattr(user, "is_authenticated", False):
            membership = ProjectMembership.objects.filter(
                project_id=sprint.project_id, user=user
            ).first()
        caller_role = membership.role if membership else None
        # ADR-0071 §3: notes readable to PROJECT-visibility for any member, or to
        # MEMBER+ when TEAM_ONLY. Counts are always visible.
        from trueppm_api.apps.projects.models import RetroVisibility

        can_read_notes = retro.team_visibility == RetroVisibility.PROJECT or (
            caller_role is not None and caller_role >= Role.MEMBER
        )
        retro_summary = {
            "retro_id": str(retro.pk),
            "action_item_count": sum(1 for i in retro.action_items.all() if not i.is_deleted),
            "has_notes": bool(retro.notes) and can_read_notes,
        }

    return {
        "sprint_id": str(sprint.pk),
        "state": sprint.state,
        "provisional": provisional,
        "outcome_recorded": outcome_recorded,
        "name": sprint.name,
        "start_date": sprint.start_date.isoformat(),
        "finish_date": sprint.finish_date.isoformat(),
        "closed_at": sprint.closed_at.isoformat() if sprint.closed_at else None,
        "goal": sprint.goal,
        "goal_outcome": sprint.goal_outcome,
        "commitment": commitment,
        "velocity": velocity_block,
        "didnt_ship": didnt_ship,
        "didnt_ship_summary": summary,
        "retro_summary": retro_summary,
        "review": _sprint_review_block(
            sprint, is_closed=is_closed, velocity_readable=velocity_readable
        ),
        # Realized milestone slip (#1098) — only on the CLOSED card; the
        # "what did this sprint do to my date" question resolves at close.
        "milestone_slip": _milestone_slip_for_sprint(sprint) if is_closed else None,
    }


def _sprint_review_block(
    sprint: Any, *, is_closed: bool, velocity_readable: bool
) -> dict[str, Any]:
    """Accepted-vs-not breakdown + demo-ready list for the Sprint Review (ADR-0118, #924).

    Composes onto the consolidated outcome read. Acceptance is derived **live** from
    ``AcceptanceCriterion.met`` (the review *is* when the PO ticks acceptance), over
    the committed / at-close membership: ``SprintTaskOutcome`` rows for a closed
    sprint, the live committed task set for a provisional one. Three buckets —
    accepted (≥1 criterion, all met), not_accepted (≥1 criterion, not all met),
    no_criteria (zero criteria, a coverage-gap signal, never silently "accepted").
    Counts always render; ``*_points`` ride the same ADR-0104 velocity gate as the
    rest of the read. ``shipped`` is the completed subset (the demo/acceptance
    candidates) and ``demo_list`` the team-curated walkthrough (closed only — a
    provisional sprint has no outcome rows to flag yet).
    """
    from trueppm_api.apps.projects.models import (
        AcceptanceCriterion,
        SprintTaskDisposition,
        SprintTaskOutcome,
        Task,
        TaskStatus,
    )

    entries: list[dict[str, Any]] = []
    if is_closed:
        for r in SprintTaskOutcome.objects.filter(sprint=sprint):
            entries.append(
                {
                    # The SprintTaskOutcome row PK — the toggle-demo endpoint key.
                    # None for provisional (no row yet → demo curation is closed-only).
                    "outcome_id": str(r.id),
                    "task_id": r.task_id,
                    "short_id": r.task_short_id,
                    "title": r.task_title,
                    "points": r.story_points,
                    "demo_ready": r.demo_ready,
                    "demo_order": r.demo_order,
                    "presenter": r.presenter,
                    "review_note": r.review_note,
                    "flagged_to_backlog": r.flagged_to_backlog_task_id is not None,
                    "disposition": r.disposition,
                    "shipped": r.disposition == SprintTaskDisposition.COMPLETED,
                }
            )
    else:
        for t in Task.objects.filter(sprint_id=sprint.pk, is_deleted=False):
            entries.append(
                {
                    "outcome_id": None,
                    "task_id": t.pk,
                    "short_id": f"T-{t.short_id}" if t.short_id else "",
                    "title": t.name,
                    "points": t.story_points,
                    "demo_ready": False,  # no outcome row pre-close; curate at review
                    "demo_order": 0,
                    "presenter": "",
                    "review_note": "",
                    "flagged_to_backlog": False,
                    "disposition": None,
                    "shipped": t.status == TaskStatus.COMPLETE,
                }
            )

    # Per-task acceptance (current met/total) + the list of *unmet* criteria names
    # in one query — no N+1 over the set. The unmet list powers the #1131
    # click-through ("which criterion failed?") on a criteria-incomplete story;
    # ordered by AcceptanceCriterion.position so the disclosure reads in author order.
    task_ids = [e["task_id"] for e in entries if e["task_id"]]
    accept: dict[Any, dict[str, int]] = {}
    unmet: dict[Any, list[dict[str, Any]]] = {}
    if task_ids:
        for ac in AcceptanceCriterion.objects.filter(
            task_id__in=task_ids, is_deleted=False
        ).order_by("position"):
            d = accept.setdefault(ac.task_id, {"met": 0, "total": 0})
            d["total"] += 1
            if ac.met:
                d["met"] += 1
            else:
                unmet.setdefault(ac.task_id, []).append({"id": str(ac.id), "text": ac.text})

    accepted_count = not_accepted_count = no_criteria_count = 0
    accepted_points = not_accepted_points = 0
    shipped: list[dict[str, Any]] = []
    demo_entries: list[dict[str, Any]] = []
    for e in entries:
        a = accept.get(e["task_id"]) if e["task_id"] else None
        met, total = (a["met"], a["total"]) if a else (0, 0)
        pts = e["points"] or 0
        if total == 0:
            no_criteria_count += 1
        elif met == total:
            accepted_count += 1
            accepted_points += pts
        else:
            not_accepted_count += 1
            not_accepted_points += pts
        if e["shipped"]:
            shipped.append(
                {
                    "outcome_id": e["outcome_id"],  # toggle-demo key (null if provisional)
                    "task_id": str(e["task_id"]) if e["task_id"] else None,
                    "task_short_id": e["short_id"],
                    "task_title": e["title"],
                    "story_points": e["points"] if velocity_readable else None,
                    "acceptance": {"met": met, "total": total},
                    # #1131: the specific unmet criteria (names only) for the
                    # disclosure; empty when fully accepted or no criteria.
                    "unmet_criteria": unmet.get(e["task_id"], []) if e["task_id"] else [],
                    # #1131 contributor note + #1132 carry-forward flag.
                    "review_note": e["review_note"],
                    "flagged_to_backlog": e["flagged_to_backlog"],
                    "demo_ready": e["demo_ready"],
                    # #1130: per-story demo curation (order + presenter).
                    "demo_order": e["demo_order"],
                    "presenter": e["presenter"],
                }
            )
        if e["demo_ready"]:
            demo_entries.append(e)

    # #1130: order the demo walkthrough by demo_order (0 = unset sorts last but
    # stable), then short_id for a deterministic tie-break.
    demo_entries.sort(key=lambda e: (e["demo_order"] or 10**9, e["short_id"]))
    demo_list = [e["short_id"] for e in demo_entries]

    # #1129: committed-at-planning → shipped COUNT delta. Counts are ceremony-critical
    # and ALWAYS visible — the team knows what it committed, so this line is NOT behind
    # the ADR-0104 velocity/points gate (only points stay gated). For a CLOSED sprint
    # committed = snapshotted committed_task_count (the at-activation commitment);
    # shipped = completed outcome rows; carried = CARRIED-disposition outcome rows.
    # For a provisional sprint derive sensible live counts from the current task set.
    if is_closed:
        committed_count = sprint.committed_task_count
        shipped_count = sum(1 for e in entries if e["shipped"])
        carried_count = sum(1 for e in entries if e["disposition"] == SprintTaskDisposition.CARRIED)
    else:
        committed_count = sprint.committed_task_count
        shipped_count = sum(1 for e in entries if e["shipped"])
        # Disposition isn't decided until close; the live incomplete set isn't yet
        # "carried" vs "dropped", so omit carried gracefully (null) on a provisional.
        carried_count = None
    commitment_block = {
        "committed_count": committed_count,
        "shipped_count": shipped_count,
        "carried_count": carried_count,
    }

    return {
        "accepted_count": accepted_count,
        "not_accepted_count": not_accepted_count,
        "no_criteria_count": no_criteria_count,
        "accepted_points": accepted_points if velocity_readable else None,
        "not_accepted_points": not_accepted_points if velocity_readable else None,
        "shipped": shipped,
        "demo_list": demo_list,
        "commitment": commitment_block,
    }


def toggle_demo_ready(outcome: Any, *, demo_ready: bool) -> Any:
    """Set a SprintTaskOutcome's review demo flag and broadcast (ADR-0118 §2).

    Idempotent: sets the boolean to the requested value (PUT-like). Best-effort
    board broadcast deferred to commit so co-viewers' review refetches; the model
    is unsynced, so the online refetch is the sole propagation.
    """
    from django.db import transaction

    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    if outcome.demo_ready != demo_ready:
        outcome.demo_ready = demo_ready
        outcome.save(update_fields=["demo_ready"])
        pid = str(outcome.sprint.project_id)
        sid = str(outcome.sprint_id)
        oid = str(outcome.id)
        transaction.on_commit(
            lambda: broadcast_board_event(
                pid, "demo_toggled", {"id": oid, "sprint_id": sid, "demo_ready": demo_ready}
            )
        )
    return outcome


def set_demo_presenter(outcome: Any, *, presenter: str) -> Any:
    """Set the per-story demo presenter on a SprintTaskOutcome and broadcast (#1130).

    Free-text, capped at the model max (120). Idempotent (PUT-like). Best-effort
    board broadcast deferred to commit so co-viewers' review refetches; the model is
    unsynced, so the online refetch is the sole propagation.
    """
    from django.db import transaction

    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    presenter = (presenter or "")[:120]
    if outcome.presenter != presenter:
        outcome.presenter = presenter
        outcome.save(update_fields=["presenter"])
        pid = str(outcome.sprint.project_id)
        sid = str(outcome.sprint_id)
        oid = str(outcome.id)
        transaction.on_commit(
            lambda: broadcast_board_event(
                pid, "demo_presenter_set", {"id": oid, "sprint_id": sid, "presenter": presenter}
            )
        )
    return outcome


def set_review_note(outcome: Any, *, note: str) -> Any:
    """Set the optional contributor review note on a SprintTaskOutcome (#1131).

    The note is "visible to reviewers" context on a criteria-incomplete / criteria-
    not-set story — always optional (Priya's no-required-data-entry constraint), so
    an empty string clears it. Capped at the model max (200). Idempotent; best-effort
    board broadcast on commit (unsynced model → online refetch propagates).
    """
    from django.db import transaction

    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    note = (note or "")[:200]
    if outcome.review_note != note:
        outcome.review_note = note
        outcome.save(update_fields=["review_note"])
        pid = str(outcome.sprint.project_id)
        sid = str(outcome.sprint_id)
        oid = str(outcome.id)
        transaction.on_commit(
            lambda: broadcast_board_event(
                pid, "review_note_set", {"id": oid, "sprint_id": sid, "note": note}
            )
        )
    return outcome


class DemoReorderConflict(Exception):
    """Raised when the supplied demo-order list doesn't match the sprint's live
    demo-flagged set (a flag was toggled concurrently) — a 409, write nothing."""

    def __init__(self, ids: list[str]) -> None:
        super().__init__("Demo list changed — reload and retry.")
        self.ids = ids


def reorder_demo_list(sprint: Any, ordered_ids: list[str]) -> int:
    """Apply a manual drag reorder of the Sprint Review demo list (#1130, ADR-0110 shape).

    ``ordered_ids`` is the *complete* set of demo-flagged SprintTaskOutcome ids for this
    sprint, in the new walkthrough order. Writes dense ``demo_order`` 1..N. The model is
    NOT a VersionedModel (no ``server_version``), so optimistic locking is on
    set-completeness only: rows are ``select_for_update``-locked to serialise concurrent
    reorders, and if the supplied set differs from the live demo-flagged set (a flag was
    toggled concurrently) it raises :class:`DemoReorderConflict` (409) and writes nothing.
    Idempotent: re-applying the same order writes nothing. Returns the count of rows whose
    order changed. Broadcasts ``demo_reordered`` on commit (unsynced → online refetch).
    """
    from django.db import transaction

    from trueppm_api.apps.projects.models import SprintTaskOutcome
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    changed = 0
    with transaction.atomic():
        live = SprintTaskOutcome.objects.select_for_update().filter(sprint=sprint, demo_ready=True)
        by_id = {str(r.id): r for r in live}
        supplied = list(ordered_ids)

        # Completeness + membership: the client must hold exactly the current demo set.
        drift = sorted((set(supplied) - by_id.keys()) | (by_id.keys() - set(supplied)))
        if drift:
            raise DemoReorderConflict(drift)

        for new_order, oid in enumerate(supplied, start=1):
            row = by_id[oid]
            if row.demo_order != new_order:
                row.demo_order = new_order
                row.save(update_fields=["demo_order"])
                changed += 1

        if changed:
            pid = str(sprint.project_id)
            sid = str(sprint.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(pid, "demo_reordered", {"sprint_id": sid})
            )
    return changed


class QueueReorderValidation(Exception):
    """Raised when a supplied queue-reorder id is unknown to the project or is not a
    priority-reorderable task (400) — write nothing. ``ids`` lists the offenders."""

    def __init__(self, ids: list[str]) -> None:
        self.ids = ids
        super().__init__(f"Not reorderable in the queue: {', '.join(ids)}")


class QueueReorderConflict(Exception):
    """Raised when a supplied task's ``server_version`` is stale (409) — write nothing.

    The board queue reorders one status group at a time, so — unlike the product
    backlog — there is no set-completeness check: the client may hold a partial view
    (filters, "My tasks"). Correctness rides on the per-row optimistic lock alone.
    """

    def __init__(self, ids: list[str]) -> None:
        self.ids = ids
        super().__init__(f"Stale queue snapshot for tasks: {', '.join(ids)}")


def reorder_queue_priority(project: Any, ordered: list[tuple[str, int]], actor: Any) -> int:
    """Persist a promote/demote of the board queue (issue 1610, ADR-0110 shape).

    ``ordered`` is one queue group — *Next up* (NOT_STARTED) or *In flight*
    (IN_PROGRESS / REVIEW) — as ``[(task_id, server_version), ...]`` in the new
    display order. Writes dense ``priority_rank = position * 10`` on each row so the
    queue's ``comparePriority`` sort reflects the drag; the ``* 10`` gap matches the
    phase-reorder idiom and keeps single-row nudges cheap.

    Why no set-completeness check (unlike ``reorder_backlog``): the queue is an IC
    pull surface that may be filtered ("My tasks"), so the client legitimately holds a
    subset of the group. Reordering a subset is a valid, intentional action, so
    correctness rides on the per-row optimistic lock alone — a stale ``server_version``
    raises :class:`QueueReorderConflict` (409) and writes nothing.

    Only NOT_STARTED / IN_PROGRESS / REVIEW tasks are reorderable here — BACKLOG rank is
    owned by ``product_backlog_reorder`` and COMPLETE / ON_HOLD carry no pull priority;
    any id outside that scope (or outside the project) raises
    :class:`QueueReorderValidation` (400). Writes only changed rows via ``save()`` so
    each bumps ``server_version`` and writes ``HistoricalTask`` (audit). Broadcasts
    ``queue_reordered`` on commit so other board clients refetch. Returns the count of
    rows whose rank changed; re-applying the same order is a no-op (returns 0).
    """
    from django.db.models import Exists, OuterRef, Value
    from django.db.models.functions import Concat

    from trueppm_api.apps.projects.models import Task, TaskStatus
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    reorderable = (TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS, TaskStatus.REVIEW)

    # A summary (WBS parent) has a descendant whose wbs_path is prefixed by its own —
    # the same containment test the model uses to gather descendants. Summaries never
    # render as queue rows (``groupTasksForQueue`` drops them) and their priority_rank
    # doubles as the phase-column order (``PhaseReorderView``), so excluding them here
    # keeps a stray summary id from silently reshuffling phases.
    has_descendant = Task.objects.filter(
        project=project,
        is_deleted=False,
        wbs_path__startswith=Concat(OuterRef("wbs_path"), Value(".")),
    )

    changed = 0
    with transaction.atomic():
        # Lock the candidate rows first to serialise concurrent reorders.
        live = (
            Task.objects.select_for_update()
            .filter(project=project, is_deleted=False, status__in=reorderable)
            .annotate(_is_summary=Exists(has_descendant))
            .filter(_is_summary=False)
        )
        by_id = {str(t.pk): t for t in live}

        # Membership + status gate: every supplied id must be a live, reorderable task
        # of this project. An unknown or wrong-status id is a client error (400), never
        # a partial write.
        invalid = sorted(tid for tid, _ in ordered if tid not in by_id)
        if invalid:
            raise QueueReorderValidation(invalid)

        # Per-row optimistic lock — the only correctness gate (see docstring).
        stale = [tid for tid, sv in ordered if by_id[tid].server_version != sv]
        if stale:
            raise QueueReorderConflict(stale)

        for position, (tid, _) in enumerate(ordered, start=1):
            task = by_id[tid]
            new_rank = position * 10
            if task.priority_rank != new_rank:
                task.priority_rank = new_rank
                task.save(update_fields=["priority_rank", "server_version"])
                changed += 1

        if changed:
            pid = str(project.id)
            transaction.on_commit(lambda: broadcast_board_event(pid, "queue_reordered", {}))
    return changed


def flag_outcome_for_backlog(outcome: Any, *, actor: Any) -> Any:
    """Carry a not-shipped review story forward to the backlog in one tap (#1132).

    Creates a ``BACKLOG`` Task in the same project, carrying the story's title and
    points from the immutable close-snapshot. Idempotent: a second tap is a no-op —
    the created task is recorded on ``flagged_to_backlog_task`` and re-checked first,
    so two clicks never create two backlog items. Broadcasts ``task_created`` (and
    ``flagged_for_backlog`` so the review surface flips to a flagged state) on commit.
    Keeps the review otherwise read-only/retrospective: this is the only write that
    spawns new work, and it is a deliberate one-tap carry-forward signal.
    """
    from django.db import transaction

    from trueppm_api.apps.projects.models import SprintTaskOutcome, Task, TaskStatus
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    with transaction.atomic():
        # Idempotency guard under a row lock — re-read the outcome FK inside the
        # transaction so two concurrent taps cannot both pass the check and each
        # create a backlog task (TOCTOU). Mirrors reorder_demo_list's locking.
        locked = SprintTaskOutcome.objects.select_for_update().get(pk=outcome.pk)
        if locked.flagged_to_backlog_task_id is not None:
            existing = Task.objects.filter(
                pk=locked.flagged_to_backlog_task_id, is_deleted=False
            ).first()
            if existing is not None:
                return locked

        task = Task.objects.create(
            project_id=locked.sprint.project_id,
            name=locked.task_title,
            duration=1,
            status=TaskStatus.BACKLOG,
            sprint=None,
            story_points=locked.story_points,
        )
        locked.flagged_to_backlog_task = task
        locked.save(update_fields=["flagged_to_backlog_task"])

        pid = str(locked.sprint.project_id)
        sid = str(locked.sprint_id)
        oid = str(locked.id)
        cid = str(task.id)
        transaction.on_commit(lambda: broadcast_board_event(pid, "task_created", {"id": cid}))
        transaction.on_commit(
            lambda: broadcast_board_event(
                pid,
                "flagged_for_backlog",
                {"id": oid, "sprint_id": sid, "task_id": cid},
            )
        )
    return locked


def sprint_daily_delta(sprint: Any, since: Any, request: Any) -> dict[str, Any]:
    """Team standup "what changed since yesterday" read for a sprint (ADR-0121, #925).

    Computed entirely from existing data — NO model: status moves + new blockers
    from ``HistoricalTask``, scope injections from ``SprintScopeChange``, the
    burndown swing from ``SprintBurnSnapshot``, and a per-actor count rollup.
    Status-level only — never time entries, durations, or edit counts (Morgan's
    surveillance hard-NO holds by construction). Pull-only; no side effects.

    New blockers (ADR-0124, #1125): a "new blocker" is the ``blocked_reason``
    empty→non-empty transition — the intentional human flag — NOT a move into the
    deprecated ``ON_HOLD`` status (which conflated blocked / parked / deprioritized).
    Each entry is split ``impediment`` (a structured ``blocker_type`` is set) vs
    ``paused`` (flagged with no type) and carries type + age, NEVER the free-text
    reason (the standup is a shared screen — the reason stays contributor-private).
    A ``blocker_summary`` count of each is included for the panel headline.

    ``since`` is floored at ``sprint.activated_at`` so the window never reaches
    before the sprint started (and stays inside the 90-day history retention).

    Privacy (#1126, ADR-0119): the per-actor breakdown is a team-internal read.
    A **Viewer**-role member receives ``per_actor: []`` and only the
    ``actor_aggregate`` team totals — never a per-person breakdown that could be
    read as a leaderboard. Member-and-above get the full ``per_actor`` list AND the
    aggregate. Zero-activity actors are suppressed server-side so they never leave
    the server.

    Points gate (#1127, ADR-0104): ``story_points`` on injected scope and the
    ``sprint_load`` point figures are suppressed (null) for a requester who cannot
    read the velocity signal — exactly as ``sprint_outcome_payload`` does. Epic
    labels and all counts remain visible regardless of the velocity gate.
    """
    from django.utils import timezone

    from trueppm_api.apps.access.models import Role
    from trueppm_api.apps.access.permissions import _membership_role
    from trueppm_api.apps.projects.models import (
        SprintBurnSnapshot,
        SprintScopeChange,
        Task,
        TaskStatus,
    )
    from trueppm_api.apps.projects.signal_privacy_services import can_read_signal

    velocity_readable = can_read_signal(request, sprint.project_id, "velocity")

    until = timezone.now()
    floor = sprint.activated_at
    effective_since = max(since, floor) if floor is not None else since

    task_qs = Task.objects.filter(sprint_id=sprint.pk, is_deleted=False)
    task_ids = list(task_qs.values_list("pk", flat=True))

    # Per-actor count rollup, keyed by actor id (None = system/unknown).
    actors: dict[Any, dict[str, Any]] = {}

    def _bump(user: Any, field: str) -> None:
        key = user.pk if user is not None else None
        row = actors.setdefault(
            key,
            {
                "actor_id": key,
                "actor_username": getattr(user, "username", None) if user else None,
                "moved": 0,
                "completed": 0,
                "added": 0,
                "blocked": 0,
            },
        )
        row[field] += 1

    task_changes: list[dict[str, Any]] = []
    new_blockers: list[dict[str, Any]] = []

    def _is_flagged(history_row: Any) -> bool:
        """A history row is 'blocked' iff its blocked_reason is non-empty (#1125)."""
        return bool((getattr(history_row, "blocked_reason", "") or "").strip())

    if task_ids:
        # All history for the current sprint tasks, oldest-first per task, so each
        # in-window row can be diffed against its true predecessor (which may pre-
        # date the window). Bounded by sprint size; one query (ADR-0121 §1).
        rows = list(
            Task.history.filter(id__in=task_ids)
            .select_related("history_user")
            .order_by("id", "history_date")
        )
        prev_by_task: dict[Any, Any] = {}
        for r in rows:
            prev = prev_by_task.get(r.id)
            prev_by_task[r.id] = r
            if prev is None:
                continue
            if r.history_date < effective_since:
                continue
            actor = r.history_user
            actor_username = getattr(actor, "username", None) if actor else None
            short_id = f"T-{r.short_id}" if r.short_id else ""

            # Status moves ("moved cards" — the issue's core signal). Tracked
            # independently of the blocker flag so a task can both move and be
            # flagged in the same window.
            if r.status != prev.status:
                task_changes.append(
                    {
                        "task_id": str(r.id),
                        "task_short_id": short_id,
                        "task_title": r.name,
                        "kind": "status",
                        "from": prev.status,
                        "to": r.status,
                        "actor_id": actor.pk if actor else None,
                        "actor_username": actor_username,
                        "at": r.history_date.isoformat(),
                    }
                )
                _bump(actor, "moved")
                if r.status == TaskStatus.COMPLETE:
                    _bump(actor, "completed")

            # ADR-0124 (#1125): a "new blocker" is the blocked_reason empty→non-empty
            # transition — the intentional human flag — NOT a move into the deprecated
            # ON_HOLD status (which conflated blocked / deprioritized / parked). The
            # entry splits "impediment" (a structured blocker_type is set) vs "paused"
            # (flagged with no type). It carries type + age, NEVER the reason text
            # (the Morgan boundary — the standup is a shared screen).
            if _is_flagged(r) and not _is_flagged(prev):
                age_seconds: int | None = None
                if r.blocked_since is not None:
                    age_seconds = max(0, int((until - r.blocked_since).total_seconds()))
                btype = (getattr(r, "blocker_type", "") or "").strip() or None
                new_blockers.append(
                    {
                        "task_id": str(r.id),
                        "task_short_id": short_id,
                        "task_title": r.name,
                        "actor_username": actor_username,
                        "at": r.history_date.isoformat(),
                        "blocker_type": btype,
                        "blocked_age_seconds": age_seconds,
                        # The split the standup renders: impediment = a triageable
                        # type is recorded; paused = a bare flag with no type.
                        "kind": "impediment" if btype else "paused",
                    }
                )
                _bump(actor, "blocked")

    # Scope injected since the window opened (ADR-0102 SprintScopeChange). Each item
    # carries its point cost (velocity-gated) and epic grouping label (#1127) so the
    # standup can read "what landed mid-sprint and what it costs us" at a glance.
    scope_added: list[dict[str, Any]] = []
    for sc in (
        SprintScopeChange.objects.filter(sprint_id=sprint.pk, added_at__gte=effective_since)
        .select_related("task", "added_by", "task__parent_epic")
        .order_by("added_at")
    ):
        task = sc.task
        epic = task.parent_epic if task is not None else None
        scope_added.append(
            {
                "task_id": str(sc.task_id) if sc.task_id else None,
                "task_short_id": f"T-{task.short_id}" if task and task.short_id else "",
                "task_title": task.name if task else "",
                "added_by_username": getattr(sc.added_by, "username", None)
                if sc.added_by
                else None,
                "at": sc.added_at.isoformat(),
                "status": sc.status,
                # ADR-0104 points gate: a below-audience reader sees the row (and its
                # epic), but never the point cost.
                "story_points": (task.story_points if task is not None else None)
                if velocity_readable
                else None,
                "epic": ({"id": str(epic.pk), "name": epic.name} if epic is not None else None),
            }
        )
        _bump(sc.added_by, "added")

    # Burndown swing — the two most recent daily snapshots (ADR-0121 §1).
    snaps = list(
        SprintBurnSnapshot.objects.filter(sprint_id=sprint.pk).order_by("-snapshot_date")[:2]
    )
    burndown_delta: dict[str, Any] | None = None
    if len(snaps) == 2:
        current, prior = snaps[0], snaps[1]
        burndown_delta = {
            "prior_date": prior.snapshot_date.isoformat(),
            "prior_remaining": prior.remaining_points,
            "current_date": current.snapshot_date.isoformat(),
            "current_remaining": current.remaining_points,
            "remaining_delta": current.remaining_points - prior.remaining_points,
            "completed_delta": current.completed_points - prior.completed_points,
        }

    # Suppress zero-activity actors (#1126): a row with no moves/dones/adds/blocks is
    # noise on the standup and never leaves the server.
    active_actors = [
        a for a in actors.values() if (a["moved"] or a["completed"] or a["added"] or a["blocked"])
    ]

    # Team aggregate — the anti-scoreboard fallback for Viewers and the headline
    # total for Member+. Summed across the active actors (zero rows contribute zero).
    actor_aggregate = {
        "moved": sum(a["moved"] for a in active_actors),
        "completed": sum(a["completed"] for a in active_actors),
        "added": sum(a["added"] for a in active_actors),
        "blocked": sum(a["blocked"] for a in active_actors),
    }

    # Per-actor scoping (#1126, ADR-0119): a Viewer-role member gets the aggregate
    # only — no per-person breakdown that reads as a leaderboard. Member+ get both.
    role = _membership_role(request, sprint.project_id)
    viewer_only = role is not None and role < Role.MEMBER
    per_actor = (
        []
        if viewer_only
        else sorted(active_actors, key=lambda a: (a["actor_username"] or "￿").lower())
    )

    # Sprint load (#1127): committed snapshot vs current committed load. pct_loaded is
    # measured against capacity when the team set one (the meaningful "how full are we"
    # read), else against the activation commitment. Point figures are velocity-gated.
    committed_points = sprint.committed_points
    current_points = current_committed_points(sprint.pk)
    capacity_points = sprint.capacity_points
    load_basis = capacity_points if capacity_points else committed_points
    pct_loaded: float | None = None
    if load_basis:
        pct_loaded = round(current_points / load_basis, 4)
    delta_points = current_points - committed_points if committed_points is not None else None
    sprint_load: dict[str, Any] = (
        {
            "committed_points": committed_points,
            "current_points": current_points,
            "delta_points": delta_points,
            "pct_loaded": pct_loaded,
        }
        if velocity_readable
        else {
            "committed_points": None,
            "current_points": None,
            "delta_points": None,
            "pct_loaded": None,
        }
    )

    # ADR-0124 (#1125): the standup splits the blocker count into impediments
    # (a structured type is recorded — the SM can triage) vs paused (a bare flag).
    blocker_summary = {
        "impediment": sum(1 for b in new_blockers if b["kind"] == "impediment"),
        "paused": sum(1 for b in new_blockers if b["kind"] == "paused"),
    }

    return {
        "sprint_id": str(sprint.pk),
        "since": effective_since.isoformat(),
        "until": until.isoformat(),
        "task_changes": task_changes,
        "scope_added": scope_added,
        "new_blockers": new_blockers,
        "blocker_summary": blocker_summary,
        "burndown_delta": burndown_delta,
        "per_actor": per_actor,
        "actor_aggregate": actor_aggregate,
        "sprint_load": sprint_load,
    }


def snapshot_completed_metrics(sprint: Any) -> None:
    """Compute and store completed_points / completed_task_count from current task state.

    Called inside the close transaction before ``apply_carry_over``. Velocity
    is the count of tasks that completed within the sprint window; subsequent
    carry-over reassignment never inflates these values.
    """
    from trueppm_api.apps.projects.models import SprintGoalOutcome, Task, TaskStatus

    completed_qs = Task.objects.filter(
        sprint_id=sprint.pk, status=TaskStatus.COMPLETE, is_deleted=False
    )
    completed_points = sum(
        p for p in completed_qs.values_list("story_points", flat=True) if p is not None
    )
    completed_count = completed_qs.count()
    sprint.completed_points = completed_points
    sprint.completed_task_count = completed_count

    # #983: default the goal verdict from the points completion ratio. SCHEDULER+
    # can override it afterward (the team's call beats the derived default), so
    # this only sets the starting value at close. Null when there's no points
    # commitment baseline to judge against.
    committed = sprint.committed_points or 0
    if committed > 0:
        ratio = completed_points / committed
        if ratio >= 0.8:
            sprint.goal_outcome = SprintGoalOutcome.MET
        elif ratio >= 0.5:
            sprint.goal_outcome = SprintGoalOutcome.PARTIAL
        else:
            sprint.goal_outcome = SprintGoalOutcome.MISSED
    else:
        sprint.goal_outcome = None


def snapshot_committed_metrics(sprint: Any) -> None:
    """Compute and store committed_points / committed_task_count on activation.

    Called inside the activate transaction. Snapshots the current sprint
    backlog as the commitment baseline; subsequent scope changes are tracked
    via ``SprintBurnSnapshot.scope_change_*``.
    """
    from trueppm_api.apps.projects.models import committed_sprint_tasks

    # ADR-0102 §2: exclude pending injections from the activation snapshot for
    # symmetry with the recompute-on-accept path (at activation there are no
    # pending tasks, but the filter keeps the helper correct under reuse).
    committed_qs = committed_sprint_tasks(sprint.pk)
    committed_points = sum(
        p for p in committed_qs.values_list("story_points", flat=True) if p is not None
    )
    committed_count = committed_qs.count()
    sprint.committed_points = committed_points
    sprint.committed_task_count = committed_count


def all_active_sprint_ids(project_id: str | uuid.UUID) -> Iterable[Any]:
    """Yield sprint IDs currently in ACTIVE state for a project."""
    from trueppm_api.apps.projects.models import Sprint, SprintState

    return Sprint.objects.filter(
        project_id=project_id, state=SprintState.ACTIVE, is_deleted=False
    ).values_list("pk", flat=True)


# ---------------------------------------------------------------------------
# Sprint scope-injection approve-gate (ADR-0102, #881)
# ---------------------------------------------------------------------------


class ScopeAcceptForbidden(Exception):
    """Raised when an actor without the team-owned accept gate attempts a
    scope-change accept/reject (ADR-0102 §3, VoC 🔴 #1 — the Enterprise back-door).

    Carries the stable ``code`` ``scope_accept_forbidden`` so the viewset emits a
    structured 403 the frontend maps without scraping the message. Raised
    *regardless of role ordinal* when the actor is not a real ProjectMembership
    holder at role>=ADMIN on the task's project — so a high-ordinal Enterprise
    custom role (ADR-0072) that is not a project member cannot force-accept.
    """

    code = "scope_accept_forbidden"
    detail = "Sprint scope acceptance is team-owned."


def assert_scope_gate_for_project(project_id: Any, by: Any) -> None:
    """Enforce the team-owned scope accept/reject gate (ADR-0102 §3, ADR-0123 §3) for a project.

    The actor passes if they are an authenticated user who **either** holds a real,
    non-soft-deleted ``ProjectMembership`` at role>=ADMIN on the project, **or**
    holds the Scrum Master or Product Owner facet on the project's default team
    (ADR-0078). #1140 widened the gate off ADMIN-only so the Product Owner — the
    person who actually owns sprint scope — can accept injections from the board
    without being a project Admin; the Scrum Master, who facilitates the ceremony,
    likewise qualifies.

    Both axes resolve to a **real, explicitly-assigned membership row** (a
    ``ProjectMembership`` for the role ordinal, a default-team ``TeamMembership``
    with the facet flag for the facet). This preserves the ADR-0102 §3 back-door
    close: an org-level/PMO principal arrives with neither a project membership nor
    a team facet and is rejected here regardless of any role ordinal they hold
    elsewhere — no Enterprise policy resolver can synthesize either row.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.teams.services import user_facets

    if by is None or not getattr(by, "is_authenticated", False):
        raise ScopeAcceptForbidden
    role = (
        ProjectMembership.objects.filter(project_id=project_id, user=by, is_deleted=False)
        .values_list("role", flat=True)
        .first()
    )
    if role is not None and role >= Role.ADMIN:
        return
    facets = user_facets(by, project_id)
    if facets["is_scrum_master"] or facets["is_product_owner"]:
        return
    raise ScopeAcceptForbidden


def _assert_scope_gate(scope_change: Any, by: Any) -> None:
    """Enforce the team-owned accept/reject gate (ADR-0102 §3) for a scope change."""
    assert_scope_gate_for_project(scope_change.task.project_id, by)


def record_sprint_scope_change(
    task: Any,
    sprint: Any,
    by: Any,
    goal_impact: bool = False,
    *,
    item_name: str | None = None,
    flag_pending: bool = True,
) -> Any:
    """Record a mid-sprint scope injection (ADR-0101 §5 / ADR-0102 §4).

    The single write path for scope injection: a row is recorded whenever a task
    is linked to an ACTIVE sprint after activation — subtask spawn, direct
    assignment, drawer, or API.

    ``flag_pending`` controls the pending-acceptance gate (ADR-0102 §1):

    - **Direct link** (``flag_pending=True``, default): ``task`` IS the injected
      item now linked to ``sprint``. Sets ``status=PENDING`` on the audit row AND
      ``task.sprint_pending=True`` atomically (one transaction) so the two never
      disagree and the task is excluded from commitment/burndown until accepted.
    - **Subtask spawn** (``flag_pending=False``): the audit row is recorded
      against the already-committed parent ``task`` (display continuity for the
      drawer chip) but the parent is NOT flagged pending — flagging the parent
      would wrongly drop the whole parent from the burndown. ``item_name`` carries
      the spawned subtask's name.

    Fires the ``sprint_scope_changed`` notify-only signal. Pre-activation links
    never call this (they are baseline commitment). Returns the SprintScopeChange.
    """
    from trueppm_api.apps.projects.models import ScopeChangeStatus, SprintScopeChange
    from trueppm_api.apps.projects.signals import sprint_scope_changed

    with transaction.atomic():
        scope_change = SprintScopeChange.objects.create(
            task=task,
            sprint=sprint,
            subtask_name=item_name if item_name is not None else task.name,
            added_by=by if (by is not None and getattr(by, "is_authenticated", False)) else None,
            goal_impact=goal_impact,
            status=ScopeChangeStatus.PENDING,
        )
        if flag_pending:
            # Flag the task pending via .save() so VersionedModel bumps
            # server_version (mobile sync sees the new pending state) — never a
            # bulk .update().
            task.sprint_pending = True
            task.save(update_fields=["sprint_pending"])

    # send_robust: sprint_scope_changed is the OSS extension point Enterprise
    # connects against. A raising receiver must not propagate out of and break
    # this OSS scope-change write path.
    sprint_scope_changed.send_robust(
        sender=SprintScopeChange,
        scope_change=scope_change,
        task=task,
    )
    return scope_change


def maybe_record_scope_injection(task: Any, old_sprint_id: Any, by: Any) -> Any | None:
    """Record a PENDING scope injection if ``task`` was just linked to an ACTIVE sprint.

    The single shared detector for the generalized scope-injection write path
    (ADR-0102 §4), called by BOTH the REST ``TaskViewSet.perform_update`` and the
    mobile ``sync`` upload after they save through ``TaskSerializer`` — keeping the
    detection in one place so the two surfaces cannot drift (a divergence here was
    how the sync path originally bypassed the gate). A task whose sprint link
    changed to an ACTIVE sprint enters pending-acceptance; subtasks, unchanged
    links, already-pending tasks, and PLANNED/COMPLETED targets are skipped.

    Args:
        task: the just-saved Task (its ``sprint_id`` is the new value).
        old_sprint_id: the task's ``sprint_id`` before the save (str or None).
        by: the acting user (recorded as the injection's ``added_by``).

    Returns the created SprintScopeChange, or ``None`` if no injection applied.
    """
    from trueppm_api.apps.projects.models import Sprint, SprintState

    new_sprint_id = str(task.sprint_id) if task.sprint_id else None
    if (
        new_sprint_id is None
        or new_sprint_id == (str(old_sprint_id) if old_sprint_id else None)
        or task.is_subtask
        or task.sprint_pending
    ):
        return None
    target_sprint = Sprint.objects.filter(pk=new_sprint_id).first()
    if target_sprint is None or target_sprint.state != SprintState.ACTIVE:
        return None
    return record_sprint_scope_change(task=task, sprint=target_sprint, by=by)


def accept_scope_change(scope_change: Any, by: Any) -> Any:
    """Promote a pending scope injection into the sprint commitment (ADR-0102 §4).

    Team-owned gate (role>=ADMIN + project membership). Sets ``status=ACCEPTED``
    and ``task.sprint_pending=False`` in one transaction, writes
    ``history_change_reason``, and — inside ``transaction.on_commit`` — rides the
    existing scope-change recompute path (``upsert_burndown_for_sprint``) plus a
    board broadcast. Idempotent: re-accepting an already-ACCEPTED row is a no-op
    (the status field is the idempotency key; the row is locked for update).

    The ONLY writer of ACCEPTED besides the bulk variant — no auto-accept path.
    """
    from trueppm_api.apps.projects.models import (
        ScopeChangeStatus,
        Sprint,
        SprintScopeChange,
        Task,
    )
    from trueppm_api.apps.projects.views import (
        _dispatch_webhooks,
        _sprint_scope_change_webhook_payload,
    )
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    _assert_scope_gate(scope_change, by)

    with transaction.atomic():
        locked = (
            SprintScopeChange.objects.select_for_update()
            .select_related("task", "sprint")
            .get(pk=scope_change.pk)
        )
        if locked.status != ScopeChangeStatus.PENDING:
            return locked  # idempotent no-op on an already-decided row
        task = Task.objects.select_for_update().get(pk=locked.task_id)
        locked.status = ScopeChangeStatus.ACCEPTED
        locked.save(update_fields=["status"])
        task.sprint_pending = False
        task._change_reason = "scope accepted into sprint"  # type: ignore[attr-defined]
        task.save(update_fields=["sprint_pending"])

        sprint = locked.sprint
        project_id_str = str(task.project_id)
        sprint_id_str = str(sprint.pk)
        task_id_str = str(task.pk)
        # ADR-0147: build the sprint.scope_changed webhook payload while the row is
        # loaded inside the transaction, fired only here (accept), never on reject or
        # silent injection. Carries no velocity signal, so no privacy gate applies.
        scope_payload = _sprint_scope_change_webhook_payload(locked, source="api")

        # #1009: capture only plain values (the sprint pk, not the ORM instance) and
        # re-fetch the Sprint inside the closure. A Sprint instance captured across
        # the commit boundary can be stale/detached — its row may have moved on under
        # it; a pk + fresh get() reads the committed state.
        def _on_commit(
            spk: Any = sprint.pk,
            pid: str = project_id_str,
            sid: str = sprint_id_str,
            tid: str = task_id_str,
            payload: dict[str, Any] = scope_payload,
        ) -> None:
            upsert_burndown_for_sprint(Sprint.objects.get(pk=spk))
            broadcast_board_event(pid, "sprint_scope_changed", {"sprint_id": sid, "task_id": tid})
            _dispatch_webhooks(pid, "sprint.scope_changed", payload)

        transaction.on_commit(_on_commit)
    return locked


def reject_scope_change(scope_change: Any, by: Any) -> Any:
    """Reject a pending scope injection, removing the task from the sprint (ADR-0102 §4).

    Team-owned gate (role>=ADMIN + project membership). Sets ``status=REJECTED``,
    clears ``task.sprint`` (removes from sprint) and forces ``sprint_pending=False``
    in one transaction, writes ``history_change_reason`` (ADR-0098 — so the
    timeline shows "removed from sprint" not a bare "Updated" pill), and rides the
    recompute + broadcast on commit. The REJECTED row is retained for the audit
    trail (cleared on sprint close like every other row). Idempotent.
    """
    from trueppm_api.apps.projects.models import (
        ScopeChangeStatus,
        Sprint,
        SprintScopeChange,
        Task,
    )
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    _assert_scope_gate(scope_change, by)

    with transaction.atomic():
        locked = (
            SprintScopeChange.objects.select_for_update()
            .select_related("task", "sprint")
            .get(pk=scope_change.pk)
        )
        if locked.status != ScopeChangeStatus.PENDING:
            return locked  # idempotent no-op
        task = Task.objects.select_for_update().get(pk=locked.task_id)
        sprint = locked.sprint
        locked.status = ScopeChangeStatus.REJECTED
        locked.save(update_fields=["status"])
        task.sprint = None
        task.sprint_pending = False
        task._change_reason = "scope rejected — removed from sprint"  # type: ignore[attr-defined]
        task.save(update_fields=["sprint", "sprint_pending"])

        project_id_str = str(task.project_id)
        sprint_id_str = str(sprint.pk)
        task_id_str = str(task.pk)

        # #1009: capture only plain values (the sprint pk, not the ORM instance) and
        # re-fetch the Sprint inside the closure. A Sprint instance captured across
        # the commit boundary can be stale/detached — its row may have moved on under
        # it; a pk + fresh get() reads the committed state.
        def _on_commit(
            spk: Any = sprint.pk,
            pid: str = project_id_str,
            sid: str = sprint_id_str,
            tid: str = task_id_str,
        ) -> None:
            upsert_burndown_for_sprint(Sprint.objects.get(pk=spk))
            broadcast_board_event(pid, "sprint_scope_changed", {"sprint_id": sid, "task_id": tid})

        transaction.on_commit(_on_commit)
    return locked


def pending_scope_advisory(sprint: Any) -> dict[str, Any] | None:
    """Return the close-time pending-scope advisory, or None (ADR-0102 §7).

    A *non-blocking* advisory listing the items still pending acceptance at
    close. Closing is NEVER blocked by this — the team owns its own close
    (sprint sovereignty). Returns None when there is nothing pending.
    """
    from trueppm_api.apps.projects.models import ScopeChangeStatus, SprintScopeChange

    rows = list(
        SprintScopeChange.objects.filter(
            sprint_id=sprint.pk, status=ScopeChangeStatus.PENDING
        ).select_related("task")
    )
    if not rows:
        return None
    return {
        "code": "scope_pending_on_close",
        "detail": (
            f"{len(rows)} item(s) are still pending acceptance. They will be carried "
            "over to the next sprint (still pending) unless you reject them."
        ),
        "pending_count": len(rows),
        "items": [
            {"id": str(r.pk), "task": str(r.task_id), "item_name": r.item_name} for r in rows
        ],
        "default_disposition": "carry",
    }


def apply_pending_disposition(sprint: Any, disposition: str, by: Any = None) -> None:
    """Dispose of tasks still pending acceptance at sprint close (ADR-0102 §7).

    Called from inside ``close_sprint`` after carry-over. Never blocks the close.

    - ``"reject"``: reject every pending row (removes the task from the sprint,
      writes history_change_reason) via ``reject_scope_change``.
    - ``"carry"`` (default): the close carry-over already moved incomplete tasks
      to the incoming sprint; for any carried task that was still pending, re-flag
      it ``sprint_pending=True`` on its NEW sprint and record a fresh PENDING
      SprintScopeChange against that sprint, so the injection stays gated in the
      next sprint rather than being silently committed. Tasks carried to backlog
      (sprint=None) or to "none" have their pending flag cleared (no sprint to be
      pending in). The closing sprint's PENDING rows clear with all other rows on
      close.
    """
    from trueppm_api.apps.projects.models import (
        ScopeChangeStatus,
        SprintScopeChange,
        Task,
    )

    pending_rows = list(
        SprintScopeChange.objects.filter(
            sprint_id=sprint.pk, status=ScopeChangeStatus.PENDING
        ).select_related("task")
    )
    if not pending_rows:
        return

    if disposition == "reject":
        for row in pending_rows:
            # The team-owned ADMIN gate for reject-on-close is enforced
            # synchronously at the close endpoint (SprintViewSet.close) BEFORE the
            # close is enqueued — a MEMBER who can close a sprint cannot use the
            # reject disposition to bypass ADR-0102 §3. By the time this drains we
            # are system-initiated, so the per-row reject is done inline (a None
            # actor would 403 in reject_scope_change's gate).
            task = Task.objects.select_for_update().filter(pk=row.task_id).first()
            row.status = ScopeChangeStatus.REJECTED
            row.save(update_fields=["status"])
            if task is None:
                continue
            # Reject means the injection never joins the commitment — clear the
            # pending flag regardless of where carry-over already left the task
            # (e.g. carry_over_to="backlog" moved it off this sprint *before* this
            # disposition runs, so a `sprint_id == sprint.pk` guard would strand
            # the flag True). If the task is still on the closing sprint, also
            # remove it from the sprint.
            update_fields: list[str] = []
            if task.sprint_pending:
                task.sprint_pending = False
                update_fields.append("sprint_pending")
            if task.sprint_id == sprint.pk:
                task.sprint = None
                update_fields.append("sprint")
            if update_fields:
                task._change_reason = "scope rejected at sprint close"  # type: ignore[attr-defined]
                task.save(update_fields=update_fields)
        return

    # carry (default): re-flag the carried task in its NEW sprint and record a
    # fresh PENDING row there. The original closing-sprint row clears on close.
    for row in pending_rows:
        task = Task.objects.filter(pk=row.task_id, is_deleted=False).first()
        if task is None:
            continue
        new_sprint_id = task.sprint_id
        if new_sprint_id is None or new_sprint_id == sprint.pk:
            # Carried to backlog / "none" / still on the closing sprint → no sprint
            # to be pending in; clear the flag so it does not strand True.
            if task.sprint_pending:
                task.sprint_pending = False
                task.save(update_fields=["sprint_pending"])
            continue
        from trueppm_api.apps.projects.models import Sprint

        new_sprint = Sprint.objects.filter(pk=new_sprint_id).first()
        if new_sprint is None:
            continue
        # Keep the task flagged pending in the incoming sprint and record a fresh
        # PENDING audit row against it (flag_pending re-asserts True idempotently).
        record_sprint_scope_change(
            task=task,
            sprint=new_sprint,
            by=by,
            goal_impact=row.goal_impact,
            item_name=row.item_name,
            flag_pending=True,
        )


def sprint_pending_count(sprint_id: str | uuid.UUID) -> int:
    """Return the count of tasks pending acceptance in a sprint (ADR-0102 §5).

    Used by the accept/reject endpoints to return the fresh ``pending_count``.
    The list endpoint uses an annotation instead (avoids N+1); this helper is for
    the single-sprint action responses.
    """
    from trueppm_api.apps.projects.models import Task

    return Task.objects.filter(sprint_id=sprint_id, sprint_pending=True, is_deleted=False).count()


def sprint_scope_change_payload(sprint: Any) -> dict[str, Any]:
    """Audit + delta read of a sprint's mid-sprint scope changes (#543/#550).

    Surfaces the existing ``SprintScopeChange`` injection rows (no new table) as a
    team-readable audit — actor, timestamp, item, point value, accept/reject
    status — plus the aggregate the persistent "Scope changed (+N / −M pts)" chip
    and the SprintPanel "N added mid-sprint" badge render from. Aggregated point
    sums + ids only, never per-assignee (Morgan VoC guardrail, ADR-0074).

    Direction semantics (the model records only *additions*; a removal is an
    injection later rejected — ADR-0102): ``points_added`` sums ``story_points``
    over rows still in the sprint (status pending or accepted); ``points_removed``
    sums over rejected rows. ``added_mid_sprint_count`` counts the still-in rows —
    the #543 badge number. Rows are cleared on sprint close, so this is the live
    in-sprint picture, not a cross-sprint history.
    """
    from trueppm_api.apps.projects.models import ScopeChangeStatus, SprintScopeChange

    rows = (
        SprintScopeChange.objects.filter(sprint_id=sprint.pk)
        .select_related("task", "added_by")
        .order_by("-added_at")
    )

    events: list[dict[str, Any]] = []
    points_added = 0
    points_removed = 0
    added_mid_sprint_count = 0
    for r in rows:
        points = (r.task.story_points or 0) if r.task_id is not None else 0
        rejected = r.status == ScopeChangeStatus.REJECTED
        if rejected:
            points_removed += points
        else:
            points_added += points
            added_mid_sprint_count += 1
        events.append(
            {
                "id": str(r.pk),
                "item_name": r.item_name,
                "story_points": (r.task.story_points if r.task_id is not None else None),
                "added_by_name": r.added_by.get_full_name() if r.added_by else None,
                "added_at": r.added_at.isoformat(),
                "goal_impact": r.goal_impact,
                "status": r.status,
            }
        )

    return {
        "summary": {
            "points_added": points_added,
            "points_removed": points_removed,
            "added_mid_sprint_count": added_mid_sprint_count,
            "total": len(events),
        },
        "events": events,
    }


def sprint_duration_change_payload(sprint: Any) -> dict[str, Any]:
    """Duration-change events captured against a sprint, newest first (ADR-0151, issue 1254).

    Surfaces the ``TaskDurationChangeEvent`` rows whose ``sprint`` FK was captured
    at change time (only set when the task was in an *active* sprint) so a
    mid-sprint duration change is team-visible on the sprint changes-log alongside
    the scope-change audit. Read-only; the per-task read action already exists
    (``GET /tasks/{id}/duration-events/``) but the changes-log needs a per-sprint
    aggregate to avoid an N-request-per-task client fan-out (ADR-0151 §6, the
    deferred consumer slice).

    ``percent_complete_after`` is non-null only when the policy actually mutated
    ``%`` (prorate); the client renders the "% recalculated" line only then.
    ``select_related`` keeps actor/task name rendering off the N+1 path.
    """
    from trueppm_api.apps.projects.models import TaskDurationChangeEvent

    rows = (
        TaskDurationChangeEvent.objects.filter(sprint_id=sprint.pk)
        .select_related("task", "actor")
        .order_by("-created_at")
    )
    events = [
        {
            "id": str(r.pk),
            "task_id": str(r.task_id),
            "task_name": r.task.name if r.task_id is not None else None,
            "old_duration": r.old_duration,
            "new_duration": r.new_duration,
            "percent_complete_at_change": r.percent_complete_at_change,
            "percent_complete_after": r.percent_complete_after,
            "policy_applied": r.policy_applied,
            "actor_name": (r.actor.get_full_name() or r.actor.get_username()) if r.actor else None,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]
    return {"events": events}


# ---------------------------------------------------------------------------
# Sprint → milestone rollup (ADR-0074)
# ---------------------------------------------------------------------------


def compute_milestone_rollup_payload(milestone: Any) -> dict[str, Any] | None:
    """Compute the rollup payload for a milestone task from its targeting sprints.

    Returns ``None`` when the milestone has no live targeting sprints — caller
    treats this as "no rollup, manual percent_complete applies."

    Reads ``Sprint.committed_*`` / ``Sprint.completed_*`` snapshots; never
    recomputes them. ACTIVE sprints contribute live ``Task.status=COMPLETE``
    counts (because their snapshot only fires on close). PLANNED sprints
    contribute committed points to the denominator but zero to the numerator
    (no work yet). COMPLETED sprints contribute their immutable snapshots.

    Variance is the gap between the latest ACTIVE/PLANNED sprint's
    ``finish_date`` and the milestone's ``early_finish`` (positive = slip).
    COMPLETED sprints do not contribute to variance — once closed their dates
    are historic, not predictive.

    ``sprint_scope_changed`` is True when any ACTIVE sprint's current
    backlog-points sum diverges from its activation-snapshot ``committed_points``
    — surfaced so the % can be trusted even when scope has shifted mid-sprint.
    """
    from trueppm_api.apps.projects.models import Sprint

    targeting = list(
        Sprint.objects.filter(target_milestone_id=milestone.pk, is_deleted=False).only(
            "pk",
            "state",
            "finish_date",
            "committed_points",
            "committed_task_count",
            "completed_points",
            "completed_task_count",
            "binding_committed_snapshot",
        )
    )
    if not targeting:
        return None
    current_committed_by_sprint, live_completed_by_sprint = _sprint_rollup_aggregates(targeting)
    return _assemble_milestone_rollup(
        milestone, targeting, current_committed_by_sprint, live_completed_by_sprint
    )


def _sprint_rollup_aggregates(
    sprints: list[Any],
) -> tuple[dict[Any, int], dict[Any, tuple[int, int]]]:
    """Per-sprint commitment aggregates for the milestone rollup, in ONE query.

    Returns ``(current_committed_by_sprint, live_completed_by_sprint)`` keyed by
    sprint pk. ``current_committed`` is the accepted (pending-excluded) committed
    story-point sum used by the binding-drift and scope-changed checks;
    ``live_completed`` is ``(points, count)`` of COMPLETE tasks (consumed only for
    ACTIVE sprints).

    Replaces the 2–4 ``committed_sprint_tasks()`` round-trips *per sprint* that
    made the milestone rollup O(milestones × sprints) on the hot task-list fetch
    (#999), collapsing them to one grouped aggregate over every sprint at once.
    CANCELLED sprints are excluded (they contribute nothing to the rollup).
    """
    from django.db.models import Count, Q, Sum

    from trueppm_api.apps.projects.models import SprintState, Task, TaskStatus

    sprint_ids = [s.pk for s in sprints if s.state != SprintState.CANCELLED]
    if not sprint_ids:
        return {}, {}

    # Mirrors committed_sprint_tasks() (sprint_pending=False) — inlined because that
    # helper is single-sprint; the sprint_pending=False filter is the load-bearing
    # ADR-0102 commitment invariant and must stay identical here.
    rows = (
        Task.objects.filter(sprint_id__in=sprint_ids, is_deleted=False, sprint_pending=False)
        .values("sprint_id")
        .annotate(
            committed_points=Sum("story_points"),
            complete_points=Sum("story_points", filter=Q(status=TaskStatus.COMPLETE)),
            complete_count=Count("pk", filter=Q(status=TaskStatus.COMPLETE)),
        )
    )

    current_committed: dict[Any, int] = {}
    live_completed: dict[Any, tuple[int, int]] = {}
    for row in rows:
        current_committed[row["sprint_id"]] = row["committed_points"] or 0
        live_completed[row["sprint_id"]] = (
            row["complete_points"] or 0,
            row["complete_count"] or 0,
        )
    return current_committed, live_completed


def _assemble_milestone_rollup(
    milestone: Any,
    targeting: list[Any],
    current_committed_by_sprint: dict[Any, int],
    live_completed_by_sprint: dict[Any, tuple[int, int]],
) -> dict[str, Any] | None:
    """Assemble a milestone rollup payload from pre-fetched per-sprint aggregates.

    Pure-Python — issues no queries. Shared by ``compute_milestone_rollup_payload``
    (single milestone) and ``batch_compute_milestone_rollups`` (page-batched, #999)
    so the two paths cannot drift. See ``compute_milestone_rollup_payload`` for the
    state-by-state contribution rules.
    """
    from trueppm_api.apps.projects.models import SprintState

    if not targeting:
        return None

    committed_points = 0
    committed_tasks = 0
    completed_points = 0
    completed_tasks = 0
    latest_active_planned_finish: Any = None
    scope_changed = False
    # The ACTIVE sprint whose scope diverged — lets a milestone-surface chip open
    # the scope-change drawer for the right sprint (#550) without a second lookup.
    scope_change_sprint_id: Any = None
    binding_drifted = False

    for sprint in targeting:
        # CANCELLED sprints are skipped entirely — they contribute nothing
        # to the denominator OR numerator. ``sprint_count`` still includes
        # them in the count because the milestone-detail UI surfaces total
        # link count regardless of state (PMs need to see "5 sprints linked,
        # 1 cancelled" without a second query).
        if sprint.state == SprintState.CANCELLED:
            continue

        committed_points += sprint.committed_points or 0
        committed_tasks += sprint.committed_task_count or 0

        # Current accepted (pending-excluded) committed points, pre-aggregated by
        # _sprint_rollup_aggregates. Defaults to 0 for a sprint with no committed
        # tasks — matching the empty-sum semantics of the prior per-sprint query.
        # Only consulted under the binding-drift / scope-changed guards below, so a
        # default for sprints meeting neither guard is harmless.
        current_committed = current_committed_by_sprint.get(sprint.pk, 0)

        # ADR-0106 §1 — binding drift vs the baseline captured at promote time.
        # Distinct from ``scope_changed`` (which diffs against the *activation*
        # snapshot): a sprint can be promoted while PLANNED, before any
        # activation snapshot exists, so drift has its own baseline.
        if (
            sprint.binding_committed_snapshot is not None
            and current_committed != sprint.binding_committed_snapshot
        ):
            binding_drifted = True

        if sprint.state == SprintState.COMPLETED:
            # Closed: use the immutable snapshot.
            completed_points += sprint.completed_points or 0
            completed_tasks += sprint.completed_task_count or 0
        elif sprint.state == SprintState.ACTIVE:
            # Live: count current COMPLETE tasks; the snapshot only fires on close.
            # ADR-0102 §2: pending injections are already excluded by the
            # sprint_pending=False filter in _sprint_rollup_aggregates, so a pending
            # task neither inflates the numerator nor trips ``scope_changed``.
            live_points, live_count = live_completed_by_sprint.get(sprint.pk, (0, 0))
            completed_points += live_points
            completed_tasks += live_count

            # Scope-change detection: compare current ACCEPTED backlog points to
            # the activation-time snapshot. Diverges when the PM adds or removes
            # *accepted* tasks after activation.
            if sprint.committed_points is not None and current_committed != sprint.committed_points:
                scope_changed = True
                scope_change_sprint_id = sprint.pk

            if sprint.finish_date is not None and (
                latest_active_planned_finish is None
                or sprint.finish_date > latest_active_planned_finish
            ):
                latest_active_planned_finish = sprint.finish_date
        elif sprint.state == SprintState.PLANNED:
            # Denominator-only contribution — no completed work yet.
            if sprint.finish_date is not None and (
                latest_active_planned_finish is None
                or sprint.finish_date > latest_active_planned_finish
            ):
                latest_active_planned_finish = sprint.finish_date

    # Rollup basis: prefer points, fall back to task count, otherwise N/A.
    percent_complete: float | None
    rollup_basis: str
    if committed_points > 0:
        percent_complete = min(100.0, round((completed_points / committed_points) * 100, 2))
        rollup_basis = "points"
    elif committed_tasks > 0:
        percent_complete = min(100.0, round((completed_tasks / committed_tasks) * 100, 2))
        rollup_basis = "tasks"
    else:
        percent_complete = None
        rollup_basis = "none"

    variance_days: int | None
    if latest_active_planned_finish is not None and milestone.early_finish is not None:
        variance_days = (latest_active_planned_finish - milestone.early_finish).days
    else:
        variance_days = None

    return {
        "percent_complete": percent_complete,
        "rollup_basis": rollup_basis,
        "variance_days": variance_days,
        "sprint_scope_changed": scope_changed,
        "scope_change_sprint_id": (str(scope_change_sprint_id) if scope_change_sprint_id else None),
        "binding_drifted": binding_drifted,
        "sprint_count": len(targeting),
    }


def batch_compute_milestone_rollups(milestones: Any) -> dict[Any, dict[str, Any] | None]:
    """Compute rollup payloads for a page of milestones in 2 queries total.

    Returns ``{milestone_pk: payload_or_None}``. Used by ``TaskViewSet.list`` and
    ``SprintViewSet.list`` to fix the O(milestones × sprints) N+1 (#999): one query
    for every targeting sprint across the whole page, one grouped aggregate for
    every sprint's committed/complete points, then pure-Python assembly per
    milestone. Behavior-identical to calling ``compute_milestone_rollup_payload``
    once per milestone, but constant in query count regardless of page size.
    A milestone with no targeting sprints maps to ``None`` (the no-rollup case).
    """
    from collections import defaultdict

    from trueppm_api.apps.projects.models import Sprint

    milestone_list = list(milestones)
    milestone_pks = [m.pk for m in milestone_list]
    if not milestone_pks:
        return {}

    targeting = list(
        Sprint.objects.filter(target_milestone_id__in=milestone_pks, is_deleted=False).only(
            "pk",
            "state",
            "finish_date",
            "committed_points",
            "committed_task_count",
            "completed_points",
            "completed_task_count",
            "binding_committed_snapshot",
            "target_milestone_id",
        )
    )
    by_milestone: dict[Any, list[Any]] = defaultdict(list)
    for sprint in targeting:
        by_milestone[sprint.target_milestone_id].append(sprint)

    current_committed_by_sprint, live_completed_by_sprint = _sprint_rollup_aggregates(targeting)

    return {
        m.pk: _assemble_milestone_rollup(
            m,
            by_milestone.get(m.pk, []),
            current_committed_by_sprint,
            live_completed_by_sprint,
        )
        for m in milestone_list
    }


def recompute_milestone_rollup(
    milestone_id: str | uuid.UUID,
    *,
    broadcast: bool = True,
) -> dict[str, Any] | None:
    """Recompute the milestone rollup and broadcast the result.

    Idempotent — every call produces the truth from current sprint/task state.
    Safe to call concurrently; broadcast deduplication is handled by the
    on_commit registry (one broadcast per milestone per transaction).

    Returns the payload (also broadcast). Returns ``None`` when the milestone
    no longer exists or is not actually a milestone — caller handles silently.
    """
    from trueppm_api.apps.projects.models import Task
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    milestone = (
        Task.objects.filter(pk=milestone_id, is_milestone=True, is_deleted=False)
        .only("pk", "project_id", "early_finish")
        .first()
    )
    if milestone is None:
        return None

    payload = compute_milestone_rollup_payload(milestone)
    if payload is None:
        # No targeting sprints — emit a clear-state event so the UI drops the
        # rollup chrome on the milestone. Distinguished from "no broadcast" by
        # the explicit rollup_basis=none sentinel.
        payload = {
            "percent_complete": None,
            "rollup_basis": "none",
            "variance_days": None,
            "sprint_scope_changed": False,
            "scope_change_sprint_id": None,
            "binding_drifted": False,
            "sprint_count": 0,
        }

    if broadcast:
        project_id_str = str(milestone.project_id)
        milestone_id_str = str(milestone.pk)
        event_payload = {"milestone_id": milestone_id_str, **payload}

        def _broadcast() -> None:
            broadcast_board_event(project_id_str, "milestone_rollup_updated", event_payload)

        transaction.on_commit(_broadcast)

    return payload


def compute_scope_rollup(task: Any) -> dict[str, Any]:
    """Scope rollup for a task's subtree (ADR-0108 §3, #408).

    ``current_scope`` = sum of ``story_points`` over the task's **leaf descendants**
    (or the task itself when it is a leaf). ``baselined_scope`` = the same sum taken
    from the project's **active baseline** snapshot (``BaselineTask.story_points``,
    matched by ``task_id``). ``scope_delta = current − baselined`` measures scope
    growth/shrink since the baseline was cut.

    ``scope_delta`` (and ``baselined_scope``) are ``None`` — never a misleading 0 —
    when there is no active baseline, or when the baseline predates the
    ``BaselineTask.story_points`` field and captured no scope (all rows null →
    ``Sum`` returns ``None``). The UI shows "no baseline" in that case.

    Computed on read (no stored rollup state, per ADR-0024/0074); detail-scoped, so
    the per-call queries are not an N+1 on list endpoints.
    """
    from django.db.models import BooleanField, Sum
    from django.db.models.expressions import RawSQL

    from trueppm_api.apps.projects.models import Baseline, BaselineTask, Task

    # Leaf descendants (or self): rows in this task's subtree (ltree ``<@``) that
    # have no children of their own. Recurring tasks have wbs_path NULL and so are
    # excluded from the subtree match for free.
    if task.wbs_path is None:
        leaf_ids: list[Any] = [task.pk]
    else:
        leaf_ids = list(
            Task.objects.filter(project_id=task.project_id, is_deleted=False)
            .annotate(
                # Parameterized ltree subtree match (%s) — no user input is
                # string-interpolated; ltree operators aren't ORM-expressible.
                # nosemgrep: avoid-raw-sql
                _in_subtree=RawSQL(
                    "wbs_path <@ %s::ltree", [str(task.wbs_path)], output_field=BooleanField()
                ),
                # Static SQL literal, empty params list (no user input).
                # nosemgrep: avoid-raw-sql
                _has_child=RawSQL(
                    "EXISTS(SELECT 1 FROM projects_task gc"
                    " WHERE gc.project_id = projects_task.project_id"
                    " AND gc.is_deleted = false"
                    " AND gc.wbs_path ~ (projects_task.wbs_path::text || '.*{1}')::lquery)",
                    [],
                    output_field=BooleanField(),
                ),
            )
            .filter(_in_subtree=True, _has_child=False)
            .values_list("pk", flat=True)
        )

    current_scope = Task.objects.filter(pk__in=leaf_ids).aggregate(s=Sum("story_points"))["s"] or 0

    active_baseline = (
        Baseline.objects.filter(project_id=task.project_id, is_active=True, is_deleted=False)
        .only("pk")
        .first()
    )
    baselined_scope: int | None = None
    if active_baseline is not None:
        baselined_scope = BaselineTask.objects.filter(
            baseline=active_baseline, task_id__in=leaf_ids
        ).aggregate(s=Sum("story_points"))["s"]

    scope_delta = (current_scope - baselined_scope) if baselined_scope is not None else None

    return {
        "current_scope": current_scope,
        "baselined_scope": baselined_scope,
        "scope_delta": scope_delta,
        "has_baseline": active_baseline is not None,
    }


# ---------------------------------------------------------------------------
# Sprint ↔ milestone binding (ADR-0106 §1/§2 — the agile/waterfall bridge)
# ---------------------------------------------------------------------------


class MilestoneBindingError(Exception):
    """Base class for promote-to-milestone binding failures (ADR-0106 §2)."""


class SprintAlreadyBound(MilestoneBindingError):
    """The sprint is already bound to a *different* milestone.

    ADR-0106 §2: the binding never silently re-points. The promote endpoint
    translates this to ``409 {"code": "sprint_already_bound"}`` so the user
    must explicitly unbind before binding elsewhere.
    """

    def __init__(self, current_milestone_id: Any) -> None:
        self.current_milestone_id = current_milestone_id
        super().__init__("sprint_already_bound")


class MilestoneNotFound(MilestoneBindingError):
    """``milestone_id`` did not resolve to a milestone task in the project."""


def current_committed_points(sprint_pk: str | uuid.UUID) -> int:
    """Live, pending-excluded sum of committed story points for a sprint.

    This is the drift baseline (ADR-0106 §1). Unlike ``Sprint.committed_points``
    (the immutable activation snapshot, null until the sprint activates) it
    reflects the sprint's *current* accepted backlog in any state — so a sprint
    promoted while still PLANNED gets a meaningful baseline. Pending injections
    are excluded for symmetry with the rollup math (ADR-0102 §2).
    """
    from trueppm_api.apps.projects.models import committed_sprint_tasks

    return sum(
        p
        for p in committed_sprint_tasks(sprint_pk).values_list("story_points", flat=True)
        if p is not None
    )


def _create_milestone_for_sprint(
    sprint: Any,
    *,
    name: str | None = None,
    target_date: Any = None,
) -> Any:
    """Mint a ``Task(is_milestone=True)`` for a ``{}``-body promote (ADR-0106 §2).

    Defaults: named from the sprint goal (fallback ``"<sprint name> milestone"``),
    dated at the sprint ``finish_date`` (planned_start = SNET floor). Optional
    create overrides (§E1.3, #928): a blank/absent ``name`` falls back to the
    goal-derived default; an absent ``target_date`` falls back to ``finish_date``.
    Any valid ``target_date`` is accepted — ``planned_start`` is a
    start-no-earlier-than floor the existing CPM/project-start guards reconcile.

    Zero duration, appended at the WBS root. The root-count SELECT is locked to
    stop two concurrent root creates racing to the same ``wbs_path`` — mirrors
    ``TaskViewSet.perform_create``. The caller already holds the sprint row lock.
    """
    from trueppm_api.apps.projects.models import Task, TaskStatus

    default_name = (sprint.goal or "").strip() or f"{sprint.name} milestone"
    resolved_name = ((name or "").strip() or default_name)[:255]
    planned_start = target_date or sprint.finish_date
    root_count = (
        Task.objects.select_for_update()
        .filter(project_id=sprint.project_id, is_deleted=False, wbs_path__regex=r"^\d+$")
        .count()
    )
    return Task.objects.create(
        project_id=sprint.project_id,
        name=resolved_name,
        is_milestone=True,
        duration=0,
        status=TaskStatus.NOT_STARTED,
        planned_start=planned_start,
        wbs_path=str(root_count + 1),
    )


def promote_sprint_to_milestone(
    sprint: Any,
    *,
    milestone_id: str | uuid.UUID | None,
    actor: Any,
    name: str | None = None,
    target_date: Any = None,
) -> tuple[Any, bool]:
    """Bind a sprint to a schedule milestone with provenance (ADR-0106 §2).

    ``milestone_id`` set → bind an existing milestone task in the same project
    (validated ``is_milestone`` + not deleted); ``name``/``target_date`` are
    ignored on this path. ``milestone_id`` None → create a new milestone from the
    sprint goal/finish and bind it, honoring the optional ``name``/``target_date``
    create overrides (§E1.3, #928).

    Idempotent and non-re-pointing under the caller's ``select_for_update`` lock:
    re-binding the *same* milestone is a no-op; any other milestone (or a create
    request) while already bound raises ``SprintAlreadyBound``. Returns
    ``(sprint, created)`` where ``created`` is True only when a milestone was
    minted. The FK + the three provenance fields are written together so the
    binding-consistency invariant (FK ⇔ provenance) holds.

    Must be called inside a transaction with the sprint row locked — the view
    owns that lock so the idempotency check and the write are atomic.
    """
    from trueppm_api.apps.scheduling.services import enqueue_recalculate
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    # Already bound: only re-binding the identical milestone is allowed (no-op).
    # Everything else is a conflict — the binding never silently re-points.
    if sprint.target_milestone_id is not None:
        if milestone_id is not None and str(milestone_id) == str(sprint.target_milestone_id):
            return sprint, False
        raise SprintAlreadyBound(sprint.target_milestone_id)

    created = False
    if milestone_id is not None:
        from trueppm_api.apps.projects.models import Task

        milestone = Task.objects.filter(
            pk=milestone_id,
            project_id=sprint.project_id,
            is_milestone=True,
            is_deleted=False,
        ).first()
        if milestone is None:
            raise MilestoneNotFound
    else:
        milestone = _create_milestone_for_sprint(sprint, name=name, target_date=target_date)
        created = True

    sprint.target_milestone = milestone
    sprint.milestone_bound_by = actor
    sprint.milestone_bound_at = timezone.now()
    sprint.binding_committed_snapshot = current_committed_points(sprint.pk)
    # server_version is bumped by VersionedModel.save and excluded from
    # update_fields automatically — do not list it here.
    sprint.save(
        update_fields=[
            "target_milestone",
            "milestone_bound_by",
            "milestone_bound_at",
            "binding_committed_snapshot",
        ]
    )

    project_id_str = str(sprint.project_id)
    sprint_id_str = str(sprint.pk)
    transaction.on_commit(
        lambda: broadcast_board_event(project_id_str, "sprint_updated", {"id": sprint_id_str})
    )
    # A freshly minted milestone is a new node on the CPM line — recompute the
    # schedule so its early_finish materializes. Binding an existing milestone
    # needs no CPM run (the task already has its dates).
    if created:
        transaction.on_commit(lambda: enqueue_recalculate(project_id_str))
    # Reflect the new binding in the milestone rollup immediately (denominator).
    recompute_milestone_rollup(milestone.pk)
    return sprint, created


def unbind_sprint_milestone(sprint: Any) -> Any:
    """Clear the binding FK and all three provenance fields (ADR-0106 §1/§2).

    No-op-safe: an already-unbound sprint is returned unchanged. The freed
    milestone's rollup is recomputed (it clears if this was its last targeting
    sprint). Caller holds the sprint row lock.
    """
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    old_milestone_id = sprint.target_milestone_id
    if old_milestone_id is None:
        return sprint

    sprint.target_milestone = None
    sprint.milestone_bound_by = None
    sprint.milestone_bound_at = None
    sprint.binding_committed_snapshot = None
    sprint.save(
        update_fields=[
            "target_milestone",
            "milestone_bound_by",
            "milestone_bound_at",
            "binding_committed_snapshot",
        ]
    )

    project_id_str = str(sprint.project_id)
    sprint_id_str = str(sprint.pk)
    transaction.on_commit(
        lambda: broadcast_board_event(project_id_str, "sprint_updated", {"id": sprint_id_str})
    )
    recompute_milestone_rollup(old_milestone_id)
    return sprint


def _unmodeled_predecessors(milestone: Any) -> list[str]:
    """IDs of the milestone's CPM predecessors that this forecast can't see.

    ADR-0106 §4 cheap heuristic (NOT the #372 feasibility engine): a predecessor
    is "unmodeled" when it carries no sprint commitment (``sprint_id`` NULL) or
    belongs to a sprint that is **not** itself targeting this milestone — so the
    velocity-based reforecast has no completion signal for it and may read
    optimistically. A single predecessor scan over the dependency rows; no graph
    walk.

    ADR-0120 integration: an *accepted* cross-project predecessor is genuinely
    modeled — the program-scoped CPM pass (D3) schedules it with real dates — so it
    no longer counts as unmodeled even though its sprint can never target this
    project's milestone. A *pending* cross edge stays unmodeled: it is inert
    (excluded from the program gather), so the reforecast still has no signal for it.
    """
    from trueppm_api.apps.projects.models import Dependency, Sprint

    targeting_sprint_ids = set(
        Sprint.objects.filter(target_milestone_id=milestone.pk, is_deleted=False).values_list(
            "pk", flat=True
        )
    )
    milestone_project_id = milestone.project_id
    unmodeled: list[str] = []
    for dep in (
        Dependency.objects.filter(successor_id=milestone.pk, predecessor__is_deleted=False)
        .select_related("predecessor")
        .only(
            "pending_acceptance",
            "predecessor__id",
            "predecessor__sprint_id",
            "predecessor__project_id",
        )
    ):
        pred = dep.predecessor
        if pred.project_id != milestone_project_id:
            # Cross-project predecessor: modeled once accepted, unmodeled while pending.
            if dep.pending_acceptance:
                unmodeled.append(str(pred.pk))
            continue
        if pred.sprint_id is None or pred.sprint_id not in targeting_sprint_ids:
            unmodeled.append(str(pred.pk))
    return unmodeled


def _velocity_band_percentiles(
    *,
    cpm_finish: Any,
    remaining: int,
    sprint_days: int,
    velocity_low: int | None,
    avg: float | None,
) -> tuple[Any, Any, Any, bool]:
    """Coarse velocity-band percentile derivation (ADR-0106 §E1.1, band fallback).

    Shared by the dry-run preview (§E1.1) and the on-close reforecast (§3) so both
    produce an identical range from the same inputs — the true percentiles arrive
    with #411's agile-aware Monte Carlo. The 1-σ slow-pace day penalty re-paces the
    remaining committed work from the team's average to its slow-tail velocity:
    ``penalty = remaining × (sprint_days/velocity_low − sprint_days/avg)``. ``p80``
    takes 0.6 of it, ``p95`` the whole tail. Below the 2-closed-sprint floor (band
    null) or with no remaining work the spread collapses to ``cpm_finish``.

    Returns ``(p50, p80, p95, usable)`` where ``usable`` is True only when a real
    band was applied — the caller nulls ``velocity_low``/``velocity_high`` when
    False so an absent band is never surfaced as a zero-width range. Monotonic by
    construction: ``p50 ≤ p80 ≤ p95``.
    """
    p50 = p80 = p95 = cpm_finish
    if velocity_low and avg and cpm_finish is not None and remaining > 0:
        penalty_days = max(0, round(remaining * (sprint_days / velocity_low - sprint_days / avg)))
        p80 = cpm_finish + timedelta(days=round(penalty_days * 0.6))
        p95 = cpm_finish + timedelta(days=penalty_days)
        return p50, p80, p95, True
    return p50, p80, p95, False


def reforecast_preview(
    sprint: Any,
    *,
    milestone_id: str | uuid.UUID | None,
) -> dict[str, Any]:
    """Dry-run reforecast for the promote dialog (ADR-0106 §E1.1, #928).

    Computes the same dates+band shape the on-close reforecast (§3) will, **live
    and persisting nothing** — there is no ``ForecastSnapshot`` write. Until the
    agile-aware Monte Carlo (#411) lands this is **velocity-band only**, so
    ``basis`` is always ``"velocity_band"``.

    ``milestone_id`` set → preview against that existing milestone (its CPM
    ``early_finish`` is the spine; its out-of-sprint predecessors set the
    unmodeled-dependency flag). ``milestone_id`` None → create-mode preview for
    the milestone the dialog is about to mint: the spine is the sprint
    ``finish_date`` and there are no predecessors yet, so the flag is False.

    Privacy (§3): emits only the team-pace **band** + dates — never the per-sprint
    ``completed_points`` series. Raises ``MilestoneNotFound`` if ``milestone_id``
    does not resolve to a milestone task in the sprint's project (no cross-project
    read).
    """
    from trueppm_api.apps.projects.models import Task

    milestone = None
    if milestone_id is not None:
        milestone = (
            Task.objects.filter(
                pk=milestone_id,
                project_id=sprint.project_id,
                is_milestone=True,
                is_deleted=False,
            )
            .only("pk", "early_finish")
            .first()
        )
        if milestone is None:
            raise MilestoneNotFound

    # cpm_finish is the deterministic spine: an existing milestone's recomputed
    # early_finish, or — in create mode, or before the freshly minted milestone's
    # first CPM pass — the sprint finish_date the milestone will be dated at.
    cpm_finish = milestone.early_finish if milestone is not None else None
    if cpm_finish is None:
        cpm_finish = sprint.finish_date

    vel = velocity_summary(sprint.project_id)
    velocity_low = vel["forecast_range_low"]
    velocity_high = vel["forecast_range_high"]
    avg = vel["rolling_avg_points"]

    # Coarse velocity-band fallback shared with the on-close reforecast (§3); the
    # true percentiles arrive with #411 MC. Uses this sprint's pace + remaining
    # committed work as the basis.
    remaining = current_committed_points(sprint.pk)
    sprint_days = max(1, (sprint.finish_date - sprint.start_date).days)
    p50, p80, p95, usable = _velocity_band_percentiles(
        cpm_finish=cpm_finish,
        remaining=remaining,
        sprint_days=sprint_days,
        velocity_low=velocity_low,
        avg=avg,
    )
    if not usable:
        # No usable band → no defensible spread; surface the band as absent.
        velocity_low = None
        velocity_high = None

    unmodeled_ids = _unmodeled_predecessors(milestone) if milestone is not None else []

    return {
        "basis": "velocity_band",
        "cpm_finish": cpm_finish,
        "p50": p50,
        "p80": p80,
        "p95": p95,
        "velocity_low": velocity_low,
        "velocity_high": velocity_high,
        "unmodeled_dependency": bool(unmodeled_ids),
        "unmodeled_predecessor_ids": unmodeled_ids,
    }


def list_project_milestones(project_id: str | uuid.UUID, *, unbound_only: bool = False) -> Any:
    """Slim milestone list for the promote dialog's bind-existing picker (§E1.3).

    Returns the project's milestone tasks annotated with ``is_bound`` (True when
    any non-deleted sprint targets the milestone) via a single ``Exists``
    subquery — no N+1. ``unbound_only`` filters to milestones no sprint is bound
    to yet. Ordered by ``early_finish, name`` to match the picker's date sort.
    """
    from django.db.models import Exists, OuterRef

    from trueppm_api.apps.projects.models import Sprint, Task

    bound = Sprint.objects.filter(target_milestone_id=OuterRef("pk"), is_deleted=False)
    qs = (
        Task.objects.filter(project_id=project_id, is_milestone=True, is_deleted=False)
        .annotate(is_bound=Exists(bound))
        .only("pk", "name", "wbs_path", "early_finish")
        .order_by("early_finish", "name")
    )
    if unbound_only:
        qs = qs.filter(is_bound=False)
    return qs


# ---------------------------------------------------------------------------
# Reforecast-on-close + the forecast read (ADR-0106 §3/§5 — the bridge WOW, #860)
# ---------------------------------------------------------------------------


def _forecast_confidence(
    *,
    usable_band: bool,
    stdev: float | None,
    avg: float | None,
    unmodeled: bool,
    drifted: bool,
) -> str:
    """Coarse confidence band for a milestone forecast (ADR-0106 §5).

    A *band*, never the series. The rule encodes the ADR's "no false confidence"
    force: any signal the forecast cannot see (an unmodeled upstream predecessor)
    or that has silently shifted (binding drift) caps it at LOW; below the
    2-closed-sprint floor (no usable band) is also LOW. Otherwise it grades on the
    team's velocity coefficient of variation (stdev/avg): tight history → HIGH,
    moderate → MEDIUM, noisy → LOW.
    """
    from trueppm_api.apps.projects.models import ForecastConfidence

    if not usable_band or unmodeled or drifted:
        return ForecastConfidence.LOW
    cv = (stdev / avg) if (stdev and avg) else 1.0
    if cv <= 0.2:
        return ForecastConfidence.HIGH
    if cv <= 0.5:
        return ForecastConfidence.MEDIUM
    return ForecastConfidence.LOW


def _scan_targeting_sprints(milestone_pk: uuid.UUID) -> tuple[int, int, bool]:
    """One pass over a milestone's targeting sprints for the reforecast inputs.

    Returns ``(remaining_points, representative_sprint_days, binding_drifted)``:

    - ``remaining_points`` — incomplete committed (pending-excluded) story points
      across the milestone's not-yet-closed targeting sprints. Closed/cancelled
      sprints contribute nothing (their work is done or carried over). This is the
      "remaining bound backlog" the velocity band re-paces into a date range.
    - ``representative_sprint_days`` — the mean sprint length (finish − start) over
      targeting sprints with both dates, used as the pace denominator; falls back
      to 14 (a fortnight) when no dated sprint is bound.
    - ``binding_drifted`` — True when any bound sprint's current accepted points
      diverge from its promote-time ``binding_committed_snapshot`` (ADR-0106 §1).
    """
    from trueppm_api.apps.projects.models import (
        Sprint,
        SprintState,
        TaskStatus,
        committed_sprint_tasks,
    )

    remaining = 0
    day_lengths: list[int] = []
    drifted = False
    for sprint in Sprint.objects.filter(target_milestone_id=milestone_pk, is_deleted=False).exclude(
        state=SprintState.CANCELLED
    ):
        if (
            sprint.binding_committed_snapshot is not None
            and current_committed_points(sprint.pk) != sprint.binding_committed_snapshot
        ):
            drifted = True
        if sprint.start_date is not None and sprint.finish_date is not None:
            day_lengths.append(max(1, (sprint.finish_date - sprint.start_date).days))
        if sprint.state != SprintState.COMPLETED:
            remaining += sum(
                p
                for p in committed_sprint_tasks(sprint.pk)
                .exclude(status=TaskStatus.COMPLETE)
                .values_list("story_points", flat=True)
                if p is not None
            )
    sprint_days = round(sum(day_lengths) / len(day_lengths)) if day_lengths else 14
    return remaining, sprint_days, drifted


def reforecast_bound_milestone(
    milestone_id: str | uuid.UUID,
    *,
    broadcast: bool = True,
) -> Any:
    """Reforecast a bound milestone's finish as a range and persist it (ADR-0106 §3).

    Computes the milestone-anchored range — ``cpm_finish`` (the deterministic CPM
    spine = the milestone's current ``early_finish``) plus ``p50``/``p80`` from the
    velocity band re-paced over the remaining bound backlog — writes one
    ``ForecastSnapshot`` row, and (when ``broadcast``) emits
    ``milestone_forecast_updated`` to the board and fires the
    ``milestone_forecast_recomputed`` Enterprise seam signal, both deferred to
    ``transaction.on_commit()``.

    Privacy (§3): the broadcast, the signal, and the persisted row carry only the
    band + dates — **never** the per-sprint ``completed_points`` series.

    Until #411's agile-aware Monte Carlo lands, ``basis`` is always
    ``velocity_band``; the snapshot records the path so the UI labels confidence
    honestly. Returns the created ``ForecastSnapshot``, or ``None`` when the
    milestone no longer exists or has no live (non-cancelled) targeting sprint —
    there is nothing to forecast in that case.
    """
    from trueppm_api.apps.projects.models import (
        ForecastBasis,
        ForecastSnapshot,
        Sprint,
        SprintState,
        Task,
    )
    from trueppm_api.apps.projects.signals import milestone_forecast_recomputed
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    milestone = (
        Task.objects.filter(pk=milestone_id, is_milestone=True, is_deleted=False)
        .only("pk", "project_id", "early_finish")
        .first()
    )
    if milestone is None:
        return None

    has_live_binding = (
        Sprint.objects.filter(target_milestone_id=milestone.pk, is_deleted=False)
        .exclude(state=SprintState.CANCELLED)
        .exists()
    )
    if not has_live_binding:
        return None

    cpm_finish = milestone.early_finish
    vel = velocity_summary(milestone.project_id)
    velocity_low = vel["forecast_range_low"]
    velocity_high = vel["forecast_range_high"]
    avg = vel["rolling_avg_points"]
    stdev = vel["rolling_stdev_points"]

    remaining, sprint_days, binding_drifted = _scan_targeting_sprints(milestone.pk)

    p50, p80, _p95, usable = _velocity_band_percentiles(
        cpm_finish=cpm_finish,
        remaining=remaining,
        sprint_days=sprint_days,
        velocity_low=velocity_low,
        avg=avg,
    )
    if not usable:
        velocity_low = None
        velocity_high = None

    unmodeled_ids = _unmodeled_predecessors(milestone)
    unmodeled = bool(unmodeled_ids)
    confidence = _forecast_confidence(
        usable_band=usable,
        stdev=stdev,
        avg=avg,
        unmodeled=unmodeled,
        drifted=binding_drifted,
    )

    snapshot = ForecastSnapshot.objects.create(
        project_id=milestone.project_id,
        milestone=milestone,
        basis=ForecastBasis.VELOCITY_BAND,
        cpm_finish=cpm_finish,
        p50=p50,
        p80=p80,
        velocity_low=velocity_low,
        velocity_high=velocity_high,
        confidence=confidence,
        unmodeled_dependency=unmodeled,
    )

    if broadcast:
        project_id_str = str(milestone.project_id)
        milestone_id_str = str(milestone.pk)
        cpm_iso = cpm_finish.isoformat() if cpm_finish else None
        p50_iso = p50.isoformat() if p50 else None
        p80_iso = p80.isoformat() if p80 else None

        def _emit() -> None:
            # §3.4 broadcast — carries binding_drifted for the bridge banner caveat.
            broadcast_board_event(
                project_id_str,
                "milestone_forecast_updated",
                {
                    "milestone_id": milestone_id_str,
                    "cpm_finish": cpm_iso,
                    "p50": p50_iso,
                    "p80": p80_iso,
                    "confidence": confidence,
                    "unmodeled_dependency": unmodeled,
                    "binding_drifted": binding_drifted,
                },
            )
            # §6 Enterprise seam — band + dates only, NO binding_drifted, NO series.
            milestone_forecast_recomputed.send(
                sender=ForecastSnapshot,
                project_id=project_id_str,
                milestone_id=milestone_id_str,
                cpm_finish=cpm_iso,
                p50=p50_iso,
                p80=p80_iso,
                confidence=confidence,
                unmodeled_dependency=unmodeled,
            )

        transaction.on_commit(_emit)

    return snapshot


def notify_milestone_forecast_shift(
    snapshot: Any,
    sprint: Any,
    *,
    actor_id: Any = None,
) -> None:
    """Notify the project's PM cohort when a sprint-close reforecast materially
    shifts a bound milestone's finish (#861).

    The bridge reforecast (``reforecast_bound_milestone``) usually fires when the
    team closes a sprint *outside* the PM's active session, so without a push the
    "automatic" reforecast still depends on the PM remembering to log in and
    check — the exact distrust the issue is closing. This helper turns the just-
    written ``ForecastSnapshot`` into a targeted digest.

    Material change = the new snapshot differs from the immediately-prior one for
    this milestone in ``p50`` / ``p80`` / ``cpm_finish`` / ``confidence`` (or there
    is no prior — the first forecast is itself new information). A no-op recompute
    that changes none of those produces no notification (the anti-spam guard the
    issue requires).

    Privacy (ADR-0104, web-rule 166): the digest carries schedule **dates** and a
    confidence **label** only — never per-sprint velocity points — and uses
    velocity-band language ("likely finish", "est. by"), not P50/P80 percentile
    vocabulary, because the milestone reforecast basis is ``velocity_band`` (a
    deterministic band heuristic), not a Monte Carlo distribution. Recipients are
    the project's PM cohort (role >= ADMIN), minus whoever requested the close
    (they already know). Deferred to ``on_commit`` so the rows land only once the
    close transaction is durable.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications
    from trueppm_api.apps.projects.models import ForecastSnapshot

    prior = (
        ForecastSnapshot.objects.filter(milestone_id=snapshot.milestone_id)
        .exclude(pk=snapshot.pk)
        .order_by("-taken_at")
        .first()
    )
    if prior is not None and (
        prior.p50 == snapshot.p50
        and prior.p80 == snapshot.p80
        and prior.cpm_finish == snapshot.cpm_finish
        and prior.confidence == snapshot.confidence
    ):
        return  # no-op recompute — nothing material changed, so no digest

    # is_deleted=False is load-bearing for privacy: member removal is a soft
    # delete that leaves the row (with its role) intact, so without this filter a
    # revoked PM would keep receiving milestone-forecast digests for a project
    # they no longer belong to (rbac-check 🔴).
    recipient_ids = list(
        ProjectMembership.objects.filter(
            project_id=snapshot.project_id, role__gte=Role.ADMIN, is_deleted=False
        )
        .exclude(user_id=actor_id)
        .values_list("user_id", flat=True)
    )
    if not recipient_ids:
        return

    milestone = snapshot.milestone
    milestone_name = milestone.name if milestone is not None else "the bound milestone"

    def _date(value: Any) -> str:
        return value.isoformat() if value else "TBD"

    if prior is None or prior.p50 == snapshot.p50:
        finish_clause = f"likely finish {_date(snapshot.p50)}"
    else:
        finish_clause = f"likely finish {_date(prior.p50)} → {_date(snapshot.p50)}"

    subject = f"Forecast shifted for {milestone_name}"
    body = (
        f"{sprint.name} closed — {milestone_name} {finish_clause} "
        f"(est. by {_date(snapshot.p80)}, {snapshot.confidence} confidence). "
        f"Velocity-based estimate."
    )

    project_id = str(snapshot.project_id)
    milestone_id = str(snapshot.milestone_id) if snapshot.milestone_id else None
    transaction.on_commit(
        lambda: create_event_notifications(
            event_type=NotificationEventType.MILESTONE_FORECAST_SHIFTED,
            recipient_ids=recipient_ids,
            subject=subject,
            body=body,
            project_id=project_id,
            task_id=milestone_id,
        )
    )


def notify_carryover_assignees(
    closed_sprint: Any,
    carry_over_to: str,
    carried_task_ids: Sequence[str],
    *,
    actor_id: Any = None,
) -> None:
    """Notify each carried task's assignee that close-time carry-over moved their
    work across the close→plan seam (ADR-0232, #1470).

    At sprint close ``apply_carry_over`` silently reassigns every incomplete
    task's ``sprint`` FK. Without this the assignee gets no signal that their own
    committed work hopped to the next sprint (or the backlog) — the load-bearing
    🔴 for the Team Member persona (Priya) in the 2026-07-01 agile VoC audit.

    A durable in-app inbox row, NOT a push: ADR-0102 §6 withholds push for
    pending-scope board mechanics, but carryover is an actual reassignment of
    committed work (closer to ``task.assigned``), so the inbox row reaches the
    assignee off-session — which is the point, since the close usually happens
    outside their session — without interrupting. Email defaults OFF (Priya's
    un-opted-email hard-NO); the row is created only if the recipient's
    ``NotificationPreference`` allows in-app (``create_event_notifications``).

    Recipients are the moved tasks' assignees, minus the actor who requested the
    close (they already know — matches the ``task.assigned`` self-exclusion). The
    body names the origin sprint and the destination (a real sprint's name, or
    "the backlog") and never surfaces story points (ADR-0104 velocity privacy).

    Sourcing from ``carried_task_ids`` (what ``apply_carry_over`` actually moved)
    keeps this faithful to the ``SprintTaskOutcome`` CARRIED set (ADR-0176) rather
    than re-deriving the disposition. ``carry_over_to == "none"`` never reaches
    here (``apply_carry_over`` returns ``[]``).

    One inbox row per assignee, not per task: an assignee with several carried
    tasks gets a single summary row (Priya's noise hard-NO), and the whole batch
    is written with one preference lookup + one ``bulk_create`` via
    ``create_event_notifications_batch``. The single-task case names and
    deep-links that task; the multi-task case summarises the count with no single
    anchor. Non-blocking end to end: the synchronous payload build is guarded by
    the caller, and the deferred write is wrapped here so an emit-time failure is
    logged and swallowed — it can never propagate out of the ``on_commit`` hook
    and mislead the (already-committed) sprint close into a FAILED status.

    Args:
        closed_sprint: The just-closed ``Sprint`` (origin).
        carry_over_to: The close policy — ``"backlog"`` or a destination sprint
            UUID string. ``"none"`` is not expected (empty ``carried_task_ids``).
        carried_task_ids: Task UUID strings that ``apply_carry_over`` moved.
        actor_id: PK of the user who requested the close; excluded from recipients.
    """
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications_batch
    from trueppm_api.apps.projects.models import Sprint, Task

    if not carried_task_ids:
        return

    # Destination label: a real sprint's name, or the backlog. A missing sprint
    # (deleted mid-close, not expected) degrades to a generic phrase rather than
    # leaking a raw UUID into the inbox copy.
    if carry_over_to == "backlog":
        destination = "the backlog"
    else:
        dest_sprint = Sprint.objects.filter(pk=carry_over_to).only("name").first()
        destination = dest_sprint.name if dest_sprint is not None else "the next sprint"

    origin = closed_sprint.name
    project_id = str(closed_sprint.project_id)

    # Group the moved tasks by assignee synchronously (pre-commit) so the
    # on_commit callback reads no source object a later mutation could change.
    # Tasks with no assignee, or assigned to the closer, are skipped ("they
    # already know" — matches task.assigned's self-exclusion).
    by_assignee: dict[Any, list[tuple[str, str]]] = {}
    for task in Task.objects.filter(pk__in=list(carried_task_ids)).only(
        "id", "name", "assignee_id"
    ):
        if task.assignee_id is None or task.assignee_id == actor_id:
            continue
        by_assignee.setdefault(task.assignee_id, []).append((str(task.id), task.name))

    if not by_assignee:
        return

    # One row per assignee: name + deep-link the single task, or summarise a count.
    rows: list[tuple[Any, str, str, str | None]] = []
    for assignee_id, tasks in by_assignee.items():
        if len(tasks) == 1:
            task_id, name = tasks[0]
            subject = f'Your task "{name}" was carried to {destination}'
            body = f'{origin} closed — your task "{name}" was carried to {destination}.'
            rows.append((assignee_id, subject, body, task_id))
        else:
            count = len(tasks)
            subject = f"{count} of your tasks were carried to {destination}"
            body = f"{origin} closed — {count} of your tasks were carried to {destination}."
            rows.append((assignee_id, subject, body, None))

    def _emit() -> None:
        # Best-effort: a notification write must never strand the (already
        # committed) close, so a failure here is logged and swallowed rather than
        # propagated out of the on_commit hook.
        try:
            create_event_notifications_batch(
                event_type=NotificationEventType.TASK_MOVED_SPRINT,
                project_id=project_id,
                rows=rows,
            )
        except Exception:
            logger.exception(
                "notify_carryover_assignees: emit failed for sprint %s", closed_sprint.pk
            )

    transaction.on_commit(_emit)


def project_forecast(project_id: str | uuid.UUID) -> dict[str, Any]:
    """Aggregate the project forecast read (ADR-0106 §5, #487/#860).

    Returns the velocity range (avg ± 1σ, with the per-sprint series — the
    velocity privacy gate of ADR-0104 / #553, not yet merged, will suppress it for
    below-tier readers once it lands at the shared ``velocity_summary`` sink), the
    remaining committed backlog re-paced into a sprints-to-complete range, and the
    latest ``ForecastSnapshot`` per bound milestone.

    Uses ``story_points`` (NOT ``prioritization_score`` — scoring inputs are
    PO-private per the backlog ADR) for the remaining-work sum.
    """
    from django.db.models import Sum

    from trueppm_api.apps.projects.models import (
        ForecastSnapshot,
        Sprint,
        SprintState,
        Task,
        TaskStatus,
    )

    vel = velocity_summary(project_id)
    low = vel["forecast_range_low"]
    high = vel["forecast_range_high"]

    # Remaining committed backlog: incomplete, pending-excluded story points across
    # the project's not-yet-closed sprints. Re-paced by the velocity band into a
    # sprints-to-complete range (high velocity → fewer sprints, low → more).
    #
    # One aggregate over all not-closed sprints, replacing the former
    # committed_sprint_tasks() round-trip per sprint (#1012). The Task filter mirrors
    # committed_sprint_tasks() exactly (is_deleted=False, sprint_pending=False) scoped
    # to the not-CANCELLED/COMPLETED sprints; Sum ignores NULL story_points — matching
    # the former ``if p is not None`` guard — and None (no matching rows) coalesces to 0.
    active_sprints = Sprint.objects.filter(project_id=project_id, is_deleted=False).exclude(
        state__in=[SprintState.COMPLETED, SprintState.CANCELLED]
    )
    remaining_points = (
        Task.objects.filter(
            sprint__in=active_sprints,
            is_deleted=False,
            sprint_pending=False,
        )
        .exclude(status=TaskStatus.COMPLETE)
        .aggregate(total=Sum("story_points"))["total"]
        or 0
    )

    sprints_to_complete_low: float | None = None
    sprints_to_complete_high: float | None = None
    if remaining_points > 0 and low and high:
        # Fewer sprints when the team's pace is high; the slow tail (low) gives
        # the pessimistic count. Rounded up — a partial sprint is still a sprint.
        import math

        sprints_to_complete_low = math.ceil(remaining_points / high)
        sprints_to_complete_high = math.ceil(remaining_points / low)

    # Latest snapshot per bound milestone (one row each, newest taken_at). A single
    # DISTINCT ON (milestone_id) ordered by -taken_at replaces the former per-milestone
    # ``.first()`` round-trip (#1012): Postgres keeps the first row of each milestone_id
    # group, which — with taken_at descending — is the newest snapshot. A bound
    # milestone with no snapshot is naturally absent, matching the former
    # ``if latest is not None`` skip. Requires PostgreSQL DISTINCT ON (ADR tech stack).
    bound_milestone_ids = list(
        Sprint.objects.filter(project_id=project_id, is_deleted=False)
        .exclude(target_milestone_id=None)
        .values_list("target_milestone_id", flat=True)
        .distinct()
    )
    milestones: list[ForecastSnapshot] = list(
        ForecastSnapshot.objects.filter(milestone_id__in=bound_milestone_ids)
        .select_related("milestone")
        .order_by("milestone_id", "-taken_at")
        .distinct("milestone_id")
    )
    milestones.sort(key=lambda s: (s.cpm_finish or date.max, getattr(s.milestone, "name", "")))

    return {
        "velocity": vel,
        "remaining_committed_points": remaining_points,
        "sprints_to_complete_low": sprints_to_complete_low,
        "sprints_to_complete_high": sprints_to_complete_high,
        "milestones": milestones,
    }


def _typical_sprint_length_days(project_id: str | uuid.UUID, default: int = 14) -> int:
    """The team's typical sprint length in calendar days, for pacing forecasts.

    Derived from the most recent dated sprint's span; falls back to a fortnight
    when the project has no usable sprint dates yet.
    """
    from trueppm_api.apps.projects.models import Sprint

    sprint = (
        Sprint.objects.filter(project_id=project_id, is_deleted=False)
        .exclude(start_date__isnull=True)
        .exclude(finish_date__isnull=True)
        .order_by("-start_date")
        .first()
    )
    if sprint is None:
        return default
    span = (sprint.finish_date - sprint.start_date).days
    return span if span and span > 0 else default


def _sample_backlog_sprint_counts(
    remaining_points: float,
    velocity_samples: list[float],
    runs: int,
    seed: int,
) -> Any:
    """Bootstrap sprint-count-to-completion from team velocity (#487).

    Throughput Monte Carlo: for each run, bootstrap-sample completed-points-per-
    sprint observations with replacement, accumulate, and count the sprints needed
    to reach ``remaining_points``. Mirrors the scheduler's
    ``_sample_velocity_durations`` (its canonical implementation) but stays
    API-local and calendar-free — sprint_forecast is a Django-layer read, so a
    cross-package dependency on a private scheduler primitive isn't worth it.

    Returns ``None`` (no usable signal) when there are no positive velocity samples
    or ``remaining_points`` is non-positive; a single positive sample yields a
    constant (degenerate) distribution, which is honest — one observation cannot
    express variance.
    """
    import numpy as np

    positive = np.asarray([s for s in velocity_samples if s and s > 0], dtype=float)
    if remaining_points <= 0 or positive.size == 0:
        return None
    rng = np.random.default_rng(seed)
    mean = float(positive.mean())
    # Bound the per-run horizon so a pathologically slow bootstrap path can't spin
    # — and hard-cap it so a bad-data backlog (e.g. a 100k-point import against a
    # slow mean) can't drive an unbounded runs×max_sprints allocation. 2000 sprints
    # is ~77 years at a fortnightly cadence; beyond that the answer is "never", and
    # runs saturate to the cap (already handled as the not-reached branch below).
    max_sprints = min(int(np.ceil(remaining_points / mean)) * 4 + 10, 2000)
    draws = rng.choice(positive, size=(runs, max_sprints), replace=True)
    cumulative = np.cumsum(draws, axis=1)
    reached = cumulative >= remaining_points
    counts = np.where(reached.any(axis=1), reached.argmax(axis=1) + 1, max_sprints)
    return counts.astype(np.float64)


def _prefers_throughput_forecast(
    project_id: str | uuid.UUID, *, velocity_sample_count: int
) -> bool:
    """Whether a project's delivery forecast should use throughput, not velocity.

    A continuous-flow team forecasts from item throughput (ADR-0130 D3) when:

    - it has no usable velocity signal (< 2 closed eligible sprints — the old
      ``warming_up`` dead-end), OR
    - its board predominantly runs in kanban delivery mode (a deliberate
      flow-without-sprints choice), even if a few sprints happen to have closed.

    ``delivery_mode`` lives on ``Task`` (not ``Project`` — ADR-0036), so "kanban
    project" is read as: a non-deleted task delivery-mode majority of kanban among
    tasks that declare a mode. A project with no velocity is always routed to flow.
    """
    if velocity_sample_count < 2:
        return True
    from django.db.models import Count

    from trueppm_api.apps.projects.models import DeliveryMode, Task

    mode_counts = dict(
        Task.objects.filter(project_id=project_id, is_deleted=False)
        .values_list("delivery_mode")
        .annotate(n=Count("id"))
        .values_list("delivery_mode", "n")
    )
    total_moded = sum(mode_counts.values())
    if total_moded == 0:
        return False
    kanban = mode_counts.get(DeliveryMode.KANBAN, 0)
    return kanban * 2 > total_moded


def sprint_forecast(
    project_id: str | uuid.UUID,
    *,
    runs: int = 1000,
    seed: int = 0xC0FFEE,
) -> dict[str, Any]:
    """Computed-on-read unified backlog delivery forecast (#487, ADR-0130 D3 #1161).

    Answers "when is the backlog done?" without a spreadsheet, from whichever input
    basis fits the team (ADR-0130 D3):

    - **velocity** (default): reuses :func:`project_forecast`'s velocity series and
      remaining committed *points*, runs ``runs`` velocity-bootstrap simulations
      (:func:`_sample_backlog_sprint_counts`), and returns P50/P80/P95 sprint counts
      paced onto the calendar at the team's typical sprint length.
    - **throughput**: for a continuous-flow / kanban team — no closed sprints, or a
      kanban-mode board — delegates to :func:`throughput_forecast`, a count-based
      Monte Carlo over the weekly throughput series. ``forecast_basis`` discriminates
      the two so a consumer never compares them unknowingly.

    Both bases are real Monte Carlo distributions, so P50/P80/P95 percentile
    vocabulary is honest here (web-rule 166). There is **no persisted model** — the
    velocity result is cached for an hour keyed on the inputs, so a sprint close busts
    the cache naturally. A fixed seed makes the same inputs reproducible, which both
    the cache and the tests rely on.

    The signal-privacy gate (ADR-0104 / ADR-0130 D4) is applied by the *view*,
    mirroring ``/forecast/`` — every velocity/throughput-derived field is suppressed
    for a below-tier reader at the sink (the forecast dates themselves follow the
    velocity precedent: schedule confidence stays, the underlying series does not).
    """
    from datetime import timedelta

    from django.core.cache import cache
    from django.utils import timezone

    data = project_forecast(project_id)
    vel = data["velocity"]
    remaining = data["remaining_committed_points"] or 0
    samples = [
        float(s["completed_points"])
        for s in vel["sprints"]
        if not s.get("exclude_from_velocity") and s.get("completed_points")
    ]
    sprint_length = _typical_sprint_length_days(project_id)

    base: dict[str, Any] = {
        "remaining_points": remaining,
        # remaining_count is the throughput-path equivalent of remaining_points
        # (ADR-0130 D3). It is null on the velocity path — that path forecasts in
        # points, not item counts — so a consumer always reads the figure matching
        # the basis it was handed.
        "remaining_count": None,
        "sample_count": len(samples),
        "p50_sprints": None,
        "p80_sprints": None,
        "p50_date": None,
        "p80_date": None,
        "p95_date": None,
        # ``basis`` is kept as the legacy "monte_carlo" constant: existing web/MCP
        # consumers branch on that literal (VelocityForecastLine, SprintForecastWidget,
        # useSprints). ``forecast_basis`` is the new ADR-0130 D3 input discriminator
        # ("velocity" | "throughput") so a consumer never compares a throughput
        # forecast to a velocity forecast unknowingly without breaking the old field.
        "basis": "monte_carlo",
        "forecast_basis": "velocity",
        "velocity_suppressed": False,
    }
    # Route to the throughput (flow) forecast for a continuous-flow team: either a
    # board that predominantly runs in kanban delivery mode, or one with no usable
    # velocity signal (< 2 closed eligible sprints) that never closes sprints. The
    # flow path is count-based and returns its own basis/status (ADR-0130 D3),
    # replacing the old "warming_up forever" dead-end with a real forecast or an
    # honest "insufficient_flow_history".
    if _prefers_throughput_forecast(project_id, velocity_sample_count=len(samples)):
        flow = throughput_forecast(project_id, runs=runs, seed=seed)
        if flow is not None:
            return flow
        # No throughput either (no completed-task history) → genuine warm-up.
        base["status"] = "warming_up"
        return base

    # Warm-up: need a real backlog and a usable sprint length — a single observation
    # cannot express the velocity variance this forecast is built on.
    if remaining <= 0 or sprint_length <= 0:
        base["status"] = "warming_up"
        return base

    key = f"sprint_forecast:v1:{project_id}:{remaining}:{sprint_length}:{hash(tuple(samples))}"
    cached: dict[str, Any] | None = cache.get(key)
    if cached is not None:
        return cached

    counts = _sample_backlog_sprint_counts(float(remaining), samples, runs=runs, seed=seed)
    if counts is None:
        base["status"] = "warming_up"
        return base

    import numpy as np

    today = timezone.localdate()
    p50_sprints = int(np.ceil(float(np.percentile(counts, 50))))
    p80_sprints = int(np.ceil(float(np.percentile(counts, 80))))
    # Pace the continuous percentile (not the rounded sprint count) onto the
    # calendar so the P80/P95 dates land strictly after P50.
    p50_days = round(float(np.percentile(counts, 50)) * sprint_length)
    p80_days = round(float(np.percentile(counts, 80)) * sprint_length)
    p95_days = round(float(np.percentile(counts, 95)) * sprint_length)
    result = {
        **base,
        "status": "ready",
        "p50_sprints": p50_sprints,
        "p80_sprints": p80_sprints,
        "p50_date": (today + timedelta(days=p50_days)).isoformat(),
        "p80_date": (today + timedelta(days=p80_days)).isoformat(),
        "p95_date": (today + timedelta(days=p95_days)).isoformat(),
    }
    cache.set(key, result, 3600)
    return result


# ---------------------------------------------------------------------------
# Flow analytics — cycle/lead time, CFD, throughput (ADR-0130 D1, #1072)
# ---------------------------------------------------------------------------

# The five canonical board statuses, in board order. ON_HOLD is a legacy value
# folded into BACKLOG (ADR-0039) so the CFD has exactly these five buckets. Keyed
# by RAW status strings throughout — never TaskStatus.choices on a serializer
# field — so drf-spectacular never emits a TaskStatusEnum component (the known
# enum-name-collision regression class; project_drf_enum_name_collision).
FLOW_CANONICAL_STATUSES = ("BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW", "COMPLETE")

# Remaining-backlog statuses for the throughput forecast: everything not yet done.
_FLOW_REMAINING_STATUSES = ("BACKLOG", "NOT_STARTED", "IN_PROGRESS", "REVIEW")

# A flow team needs at least this many non-zero throughput weeks before a
# count-based forecast is honest — fewer cannot express the weekly variance the
# bootstrap is built on. Mirrors the velocity-path "≥2 closed sprints" warm-up
# rule (ADR-0130 D3).
MIN_THROUGHPUT_WEEKS = 4

# Hard cap on the flow-metrics window so a caller can't ask for an unbounded
# history replay (perf gate). 90 d is the default and the django-simple-history
# retention horizon anyway.
MAX_FLOW_WINDOW_DAYS = 365


def annotate_wip_breach(
    project_id: str | uuid.UUID, columns: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Annotate each board column with its live count and WIP-breach verdict (D2, #1071).

    Returns a *copy* of ``columns`` where each entry gains:

    - ``current_count``: live count of non-deleted tasks whose status maps to that
      column (ON_HOLD folds into BACKLOG, ADR-0039).
    - ``breach``: ``"ok"`` | ``"at"`` | ``"over"`` when the column has a ``wip_limit``,
      else ``None`` (no limit set).

    Counts come from **one** grouped query (``values("status").annotate(Count)``) — no
    per-column query (perf-check gate). The verdict is **passive**: it is current board
    state, not a historical performance signal, so it is visible to all project members
    and the API still does not reject breaching mutations (ADR-0039 / ADR-0130 D2).
    """
    from django.db.models import Count

    from trueppm_api.apps.projects.models import Task

    raw_counts = dict(
        Task.objects.filter(project_id=project_id, is_deleted=False)
        .values_list("status")
        .annotate(n=Count("id"))
        .values_list("status", "n")
    )
    # Fold every status into its canonical column bucket (ON_HOLD → BACKLOG) so a
    # legacy row still counts toward the right column.
    folded_counts: dict[str, int] = dict.fromkeys(FLOW_CANONICAL_STATUSES, 0)
    for raw_status, n in raw_counts.items():
        bucket = _fold_status(raw_status)
        if bucket is not None:
            folded_counts[bucket] += n

    annotated: list[dict[str, Any]] = []
    for col in columns:
        status_key = str(col.get("status") or "")
        count = folded_counts.get(status_key, 0)
        limit = col.get("wip_limit")
        if limit is None:
            breach: str | None = None
        elif count > limit:
            breach = "over"
        elif count == limit:
            breach = "at"
        else:
            breach = "ok"
        annotated.append({**col, "current_count": count, "breach": breach})
    return annotated


def _fold_status(raw: str | None) -> str | None:
    """Fold the legacy ON_HOLD status into BACKLOG; pass through canonical values.

    Returns None for an unknown/empty status so the caller can skip it rather than
    invent a sixth CFD bucket.
    """
    if raw == "ON_HOLD":
        return "BACKLOG"
    if raw in FLOW_CANONICAL_STATUSES:
        return raw
    return None


def _weekly_throughput(
    completions: list[date],
    *,
    since: date,
    until: date,
) -> list[dict[str, Any]]:
    """Bucket completion dates into ISO-week throughput counts (ADR-0130 D1).

    Every ISO-Monday-anchored week intersecting ``[since, until]`` gets a row
    (zero-filled), so the series is dense and the forecast can count non-zero weeks
    honestly. ``week_start`` is the ISO Monday (``date.isoformat``); ``completed_count``
    is the number of tasks that reached COMPLETE in that week. This is the input
    series :func:`throughput_forecast` consumes — factored out so the two never drift.
    """
    by_week: dict[date, int] = {}
    # Anchor the window start to its ISO Monday so the dense grid lines up with the
    # week each completion is bucketed into.
    first_monday = since - timedelta(days=since.weekday())
    cur = first_monday
    while cur <= until:
        by_week[cur] = 0
        cur += timedelta(days=7)
    for d in completions:
        monday = d - timedelta(days=d.weekday())
        if monday in by_week:
            by_week[monday] += 1
    return [
        {"week_start": monday.isoformat(), "completed_count": count}
        for monday, count in sorted(by_week.items())
    ]


def flow_metrics(project_id: str | uuid.UUID, *, window_days: int = 90) -> dict[str, Any]:
    """Methodology-neutral flow analytics for a project (ADR-0130 D1, #1072).

    Computed-on-read from the ``HistoricalTask`` table (the same replay
    ``burn_series`` / ``sprint_daily_delta`` use): one windowed query ordered by
    ``(id, history_date)``, then per-task diffs in Python — no per-task subqueries.

    Returns:
        A dict with:

        - ``cycle_time`` / ``lead_time``: ``{p50, p80, p95}`` day counts over tasks
          that reached COMPLETE in the window. Cycle time runs from the first
          transition *into* ``IN_PROGRESS`` to the ``COMPLETE`` transition (fallback
          ``actual_finish``); lead time from the earliest history row (board entry —
          Task has no ``created_at``) to ``COMPLETE``. Empty distributions when no
          task completed in the window.
        - ``cfd``: daily ``{date, counts:{<status>: n}}`` across the window,
          reconstructed from history (``ON_HOLD`` folded into ``BACKLOG``).
        - ``throughput``: weekly ``{week_start, completed_count}`` (ISO Monday).
        - ``data_integrity``: aggregate-only advisory counts
          (``bulk_moved_count``, ``backdated_count``, ``missing_transition_count``)
          so a consumer can caveat the numbers — **never per-person** (Priya).
        - ``window_days`` / ``since`` / ``until``: the resolved window.
        - ``flow_metrics_suppressed``: always False here; the view flips it for a
          below-audience reader via :func:`suppress_flow_metrics`.

    The historical distributions are team-private (ADR-0130 D4): the view gates them
    under the ``flow_metrics`` signal and empties the arrays for a below-tier reader.
    """
    import numpy as np

    from trueppm_api.apps.projects.models import Task

    HistoricalTask = Task.history.model

    window_days = max(1, min(int(window_days), MAX_FLOW_WINDOW_DAYS))
    until_date = timezone.localdate()
    since_date = until_date - timedelta(days=window_days - 1)
    tz = timezone.get_current_timezone()
    window_start = datetime.combine(since_date, datetime.min.time(), tzinfo=tz)
    window_end = datetime.combine(until_date, datetime.max.time(), tzinfo=tz)

    # One windowed query: every history row up to the window end, oldest-first per
    # task so each row can be diffed against its predecessor (which may pre-date the
    # window — needed to detect the IN_PROGRESS entry and board-entry time).
    # Ordered by (id, history_date) for the replay (CFD + cycle/lead), exactly like
    # burn_series. ``history_id`` (the insertion-sequence pk) rides along so the
    # data_integrity scan can detect backdated rows: within date order, a non-monotonic
    # history_id means a later-inserted row was stamped earlier than an earlier one.
    rows = list(
        HistoricalTask.objects.filter(
            project_id=project_id,
            history_date__lte=window_end,
        )
        .order_by("id", "history_date")
        .values(
            "id",
            "history_id",
            "history_date",
            "history_type",
            "status",
            "actual_finish",
            "is_deleted",
        )
    )

    by_task: dict[Any, list[dict[str, Any]]] = {}
    for row in rows:
        by_task.setdefault(row["id"], []).append(row)

    cycle_days: list[float] = []
    lead_days: list[float] = []
    bulk_moved_count = 0
    backdated_count = 0
    missing_transition_count = 0

    for task_rows in by_task.values():
        first_in_progress: datetime | None = None
        completed_at: datetime | None = None
        prev_status: str | None = None
        prev_history_id: int | None = None
        board_entry: datetime = task_rows[0]["history_date"]
        actual_finish_at_complete: date | None = None
        saw_complete_transition = False
        task_backdated = False

        for r in task_rows:
            status = r["status"]
            hist_date = r["history_date"]
            # Backdated edit: rows are date-ordered, so a later-inserted row (larger
            # history_id) appearing before an earlier-inserted one means a row was
            # stamped earlier than its true insertion time (clock skew / manual
            # backfill). Flag the task once — its replay ordering can't be trusted.
            hid = r["history_id"]
            if prev_history_id is not None and hid < prev_history_id:
                task_backdated = True
            if first_in_progress is None and status == "IN_PROGRESS":
                first_in_progress = hist_date
            # Only count the *transition* into COMPLETE that happened in-window.
            if (
                status == "COMPLETE"
                and prev_status != "COMPLETE"
                and window_start <= hist_date <= window_end
            ):
                completed_at = hist_date
                actual_finish_at_complete = r["actual_finish"]
                saw_complete_transition = True
            prev_status = status
            prev_history_id = hid

        if task_backdated:
            backdated_count += 1

        if not saw_complete_transition or completed_at is None:
            continue  # task did not reach COMPLETE in the window

        # Lead time: board entry → completion. Always available for a completed task.
        lead_days.append(max(0.0, (completed_at - board_entry).total_seconds() / 86400.0))

        # Cycle time: first IN_PROGRESS entry → completion. Fallback to actual_finish
        # when the card never recorded an IN_PROGRESS row (bulk move / direct jump):
        # treat actual_finish as the start-of-work proxy. If neither exists the task
        # is missing the transition the cycle-time math needs.
        if first_in_progress is not None and first_in_progress <= completed_at:
            cycle_days.append((completed_at - first_in_progress).total_seconds() / 86400.0)
        elif actual_finish_at_complete is not None:
            start_dt = datetime.combine(actual_finish_at_complete, datetime.min.time(), tzinfo=tz)
            cycle_days.append(max(0.0, (completed_at - start_dt).total_seconds() / 86400.0))
            bulk_moved_count += 1  # jumped to COMPLETE without an IN_PROGRESS row
        else:
            missing_transition_count += 1

    def _pcts(values: list[float]) -> dict[str, int | None]:
        if not values:
            return {"p50": None, "p80": None, "p95": None}
        arr = np.asarray(values, dtype=float)
        return {
            "p50": round(float(np.percentile(arr, 50))),
            "p80": round(float(np.percentile(arr, 80))),
            "p95": round(float(np.percentile(arr, 95))),
        }

    # CFD: for each day in the window, count tasks per canonical status using each
    # task's latest in-window-or-earlier state (mirrors burn_series' replay). Rows
    # are oldest-first, so we scan once per day keeping the last applicable row.
    cfd: list[dict[str, Any]] = []
    for day in _date_range_inclusive(since_date, until_date):
        end_of_day = datetime.combine(day, datetime.max.time(), tzinfo=tz)
        counts = dict.fromkeys(FLOW_CANONICAL_STATUSES, 0)
        for task_rows in by_task.values():
            state: dict[str, Any] | None = None
            for r in task_rows:
                if r["history_date"] <= end_of_day:
                    state = r
                else:
                    break
            if state is None:
                continue
            if state["history_type"] == "-" or state.get("is_deleted"):
                continue  # task didn't exist (or was deleted) on this day
            folded = _fold_status(state["status"])
            if folded is not None:
                counts[folded] += 1
        cfd.append({"date": day.isoformat(), "counts": counts})

    completions = [
        r["history_date"].astimezone(tz).date()
        for task_rows in by_task.values()
        for r in _completion_rows(task_rows, window_start, window_end)
    ]
    throughput = _weekly_throughput(completions, since=since_date, until=until_date)

    return {
        "window_days": window_days,
        "since": since_date.isoformat(),
        "until": until_date.isoformat(),
        "cycle_time": _pcts(cycle_days),
        "lead_time": _pcts(lead_days),
        "cfd": cfd,
        "throughput": throughput,
        "data_integrity": {
            "bulk_moved_count": bulk_moved_count,
            "backdated_count": backdated_count,
            "missing_transition_count": missing_transition_count,
        },
        "flow_metrics_suppressed": False,
    }


def _completion_rows(
    task_rows: list[dict[str, Any]],
    window_start: datetime,
    window_end: datetime,
) -> list[dict[str, Any]]:
    """Yield the history rows where a task *transitions into* COMPLETE in-window.

    A task can re-open and re-complete; each genuine transition into COMPLETE inside
    the window is one throughput event. Edits while already COMPLETE are not counted.
    """
    out: list[dict[str, Any]] = []
    prev_status: str | None = None
    for r in task_rows:
        if (
            r["status"] == "COMPLETE"
            and prev_status != "COMPLETE"
            and window_start <= r["history_date"] <= window_end
        ):
            out.append(r)
        prev_status = r["status"]
    return out


def _project_weekly_throughput(
    project_id: str | uuid.UUID, *, window_days: int
) -> tuple[list[dict[str, Any]], date]:
    """Compute the weekly throughput series for the forecast (ADR-0130 D3).

    Reuses :func:`flow_metrics`' throughput factoring without rebuilding the CFD —
    the forecast only needs the weekly completion counts and the window start. One
    windowed history query.
    """
    from trueppm_api.apps.projects.models import Task

    HistoricalTask = Task.history.model

    # Cap defensively, matching flow_metrics(): the only current caller hardcodes 90,
    # but an unbounded window would scan the full retained history.
    window_days = max(1, min(int(window_days), MAX_FLOW_WINDOW_DAYS))
    until_date = timezone.localdate()
    since_date = until_date - timedelta(days=window_days - 1)
    tz = timezone.get_current_timezone()
    window_start = datetime.combine(since_date, datetime.min.time(), tzinfo=tz)
    window_end = datetime.combine(until_date, datetime.max.time(), tzinfo=tz)

    rows = list(
        HistoricalTask.objects.filter(project_id=project_id, history_date__lte=window_end)
        .order_by("id", "history_date")
        .values("id", "history_date", "status")
    )
    by_task: dict[Any, list[dict[str, Any]]] = {}
    for row in rows:
        by_task.setdefault(row["id"], []).append(row)

    completions = [
        r["history_date"].astimezone(tz).date()
        for task_rows in by_task.values()
        for r in _completion_rows(task_rows, window_start, window_end)
    ]
    return _weekly_throughput(completions, since=since_date, until=until_date), since_date


def _sample_throughput_counts(
    weekly_throughput: list[int],
    remaining_count: float,
    n: int,
    rng: Any,
) -> Any:
    """Bootstrap weeks-to-completion from a weekly throughput series (ADR-0130 D3).

    Count-based Monte Carlo, the item-count analogue of
    :func:`_sample_backlog_sprint_counts`: for each of ``n`` runs, bootstrap-sample
    completed-items-per-week observations with replacement, accumulate, and count the
    weeks needed to clear ``remaining_count`` items. The ``rng`` is a seeded
    ``np.random.Generator`` so a given window yields a stable distribution within a
    request (idempotent reads, ADR-0130 §DE).

    Returns ``None`` when there are no positive weekly observations or
    ``remaining_count`` is non-positive; a single positive week yields a degenerate
    (constant) distribution, which is honest — one observation cannot express variance.
    """
    import numpy as np

    positive = np.asarray([w for w in weekly_throughput if w and w > 0], dtype=float)
    if remaining_count <= 0 or positive.size == 0:
        return None
    mean = float(positive.mean())
    # Bound the per-run horizon the same way the velocity sampler does: ~4× the
    # naive estimate, hard-capped so a pathological backlog/slow-mean pair can't
    # drive an unbounded allocation. 2000 weeks is ~38 years — beyond that the
    # answer is "never" and runs saturate to the cap.
    max_weeks = min(int(np.ceil(remaining_count / mean)) * 4 + 10, 2000)
    draws = rng.choice(positive, size=(n, max_weeks), replace=True)
    cumulative = np.cumsum(draws, axis=1)
    reached = cumulative >= remaining_count
    counts = np.where(reached.any(axis=1), reached.argmax(axis=1) + 1, max_weeks)
    return counts.astype(np.float64)


def throughput_forecast(
    project_id: str | uuid.UUID,
    *,
    window_days: int = 90,
    runs: int = 1000,
    seed: int = 0xF10C0DE,
) -> dict[str, Any] | None:
    """Count-based delivery forecast for a continuous-flow team (ADR-0130 D3, #1161).

    The flow-team analogue of the velocity Monte Carlo: forecasts P50/P80/P95
    completion *dates* for the remaining backlog item count from the weekly
    throughput series, requiring no sprints, story points, or Scrum cadence.

    Remaining backlog count = non-deleted tasks whose status is one of
    BACKLOG/NOT_STARTED/IN_PROGRESS/REVIEW (COMPLETE excluded). The bootstrap uses a
    deterministically-seeded ``np.random.Generator`` so identical windows yield an
    identical distribution within a request.

    Returns:
        The unified delivery-forecast dict (``basis:"monte_carlo"``,
        ``forecast_basis:"throughput"``, ``remaining_count``, ``p50/p80/p95_date``,
        ``sample_count`` = non-zero throughput weeks). ``status`` is ``"ready"`` with
        ≥ :data:`MIN_THROUGHPUT_WEEKS` non-zero weeks and a remaining backlog, else the
        honest ``"insufficient_flow_history"`` (the flow-path parallel to the velocity
        ``"warming_up"`` — no false precision). Returns ``None`` only when there is no
        completed-task history at all, so the caller can fall back to ``"warming_up"``.
    """
    import numpy as np

    from trueppm_api.apps.projects.models import Task

    series, _since = _project_weekly_throughput(project_id, window_days=window_days)
    weekly = [row["completed_count"] for row in series]
    nonzero_weeks = sum(1 for w in weekly if w > 0)

    if nonzero_weeks == 0:
        # No completed-task history — there is nothing to forecast from. Let the
        # caller decide between throughput and velocity warm-up shapes.
        return None

    remaining_count = Task.objects.filter(
        project_id=project_id,
        is_deleted=False,
        status__in=_FLOW_REMAINING_STATUSES,
    ).count()

    base: dict[str, Any] = {
        "remaining_points": None,
        "remaining_count": remaining_count,
        "sample_count": nonzero_weeks,
        "p50_sprints": None,
        "p80_sprints": None,
        "p50_date": None,
        "p80_date": None,
        "p95_date": None,
        "basis": "monte_carlo",
        "forecast_basis": "throughput",
        "velocity_suppressed": False,
    }

    # Honest insufficiency: too few non-zero weeks to express weekly variance, or no
    # remaining backlog to forecast. No false precision (ADR-0130 D3).
    if nonzero_weeks < MIN_THROUGHPUT_WEEKS or remaining_count <= 0:
        base["status"] = "insufficient_flow_history"
        return base

    rng = np.random.default_rng(seed)
    counts = _sample_throughput_counts(weekly, float(remaining_count), runs, rng)
    if counts is None:
        base["status"] = "insufficient_flow_history"
        return base

    today = timezone.localdate()
    # Pace the continuous percentile (in weeks) onto the calendar so P80/P95 land
    # strictly after P50.
    p50_days = round(float(np.percentile(counts, 50)) * 7)
    p80_days = round(float(np.percentile(counts, 80)) * 7)
    p95_days = round(float(np.percentile(counts, 95)) * 7)
    return {
        **base,
        "status": "ready",
        "p50_date": (today + timedelta(days=p50_days)).isoformat(),
        "p80_date": (today + timedelta(days=p80_days)).isoformat(),
        "p95_date": (today + timedelta(days=p95_days)).isoformat(),
    }


# ---------------------------------------------------------------------------
# Recurring-task occurrence generation (ADR-0090, #736)
# ---------------------------------------------------------------------------


def _occurrence_matches(rule: Any, anchor: date, d: date) -> bool:
    """Return whether date ``d`` is an occurrence of ``rule`` given its ``anchor``.

    The anchor (the template's planned_start, or the first generation date) is the
    alignment basis for the ``interval`` ("every N") multiplier. For ``interval == 1``
    the anchor is immaterial — every matching weekday/day-of-month qualifies.
    """
    from trueppm_api.apps.projects.models import TaskRecurrenceFrequency

    if d < anchor:
        return False
    interval: int = max(rule.interval, 1)
    freq = rule.frequency

    if freq in (TaskRecurrenceFrequency.DAILY, TaskRecurrenceFrequency.CUSTOM):
        # CUSTOM is a generic "every N days" cadence; DAILY with interval==1 is "every
        # day". Both align to the anchor via the day delta.
        return (d - anchor).days % interval == 0

    if freq == TaskRecurrenceFrequency.WEEKLY:
        if not (rule.weekdays & (1 << d.weekday())):  # Mon=bit0 … Sun=bit6
            return False
        # Align the week to the anchor's (Monday-based) week for interval > 1.
        anchor_monday = anchor - timedelta(days=anchor.weekday())
        d_monday = d - timedelta(days=d.weekday())
        return ((d_monday - anchor_monday).days // 7) % interval == 0

    if freq == TaskRecurrenceFrequency.MONTHLY:
        dom = rule.day_of_month or anchor.day
        # Clamp to the month length so day_of_month=31 still fires in February.
        target = min(dom, calendar.monthrange(d.year, d.month)[1])
        if d.day != target:
            return False
        months = (d.year - anchor.year) * 12 + (d.month - anchor.month)
        return months >= 0 and months % interval == 0

    return False


def _spawn_occurrence(rule: Any, template: Any, d: date, template_attachments: list[Any]) -> Any:
    """Create one task occurrence for date ``d``, honoring the inheritance toggles.

    Occurrences carry ``is_recurring=True`` (the load-bearing CPM-exclusion key,
    ADR-0090) and ``wbs_path=None`` — they are standalone calendar tasks, not WBS
    nodes, so they never enter summary rollups or the scheduling engine.

    ``template_attachments`` is the template's attachment rows, fetched once by the
    caller (constant across a rule's sweep) and copied per occurrence when
    ``inherit_attachments`` is set.
    """
    from trueppm_api.apps.projects.models import Task, TaskAttachment, TaskStatus

    occurrence = Task.objects.create(
        project_id=template.project_id,
        name=template.name,
        duration=template.duration,
        is_milestone=template.is_milestone,
        notes=template.notes,
        color=template.color,
        status=TaskStatus.NOT_STARTED,
        assignee=template.assignee if rule.inherit_assignee else None,
        is_recurring=True,
        recurrence_rule=rule,
        recurrence_occurrence_date=d,
    )
    # Copy attachment rows referencing the SAME stored file — no blob duplication.
    # Each occurrence owns its row, so soft-deleting one occurrence never orphans
    # another's attachment.
    for att in template_attachments:
        TaskAttachment.objects.create(
            task=occurrence,
            file=att.file,
            file_name=att.file_name,
            file_mime=att.file_mime,
            file_size=att.file_size,
            external_url=att.external_url,
            external_title=att.external_title,
            uploaded_by=att.uploaded_by,
        )
    # inherit_subtasks / inherit_morning_notification are persisted on the rule but
    # not materialized here — see ADR-0090 (subtasks need the #738 WBS-placement UX;
    # morning-notification delivery is net-new, trueppm-enterprise#112).
    return occurrence


def _generate_due_occurrences(
    rule: Any,
    *,
    horizon_days: int,
    now: datetime | None = None,
) -> list[Any]:
    """Materialize a recurrence rule's occurrences due within the look-ahead horizon.

    Lazy and idempotent: creates only occurrences between the rule's cursor and
    ``today + horizon_days`` that do not already exist, and never more than the rule's
    end condition (ON_DATE / AFTER_N) permits. Advances ``rule.generated_through`` so
    the next sweep resumes without rescanning. Returns the created tasks (may be
    empty). Safe to call repeatedly — the ``(recurrence_rule, recurrence_occurrence_date)``
    unique constraint plus an existence check prevent duplicates.
    """
    from trueppm_api.apps.projects.models import RecurrenceEndType, TaskAttachment

    template = rule.task
    if template is None or template.is_deleted or rule.is_deleted:
        return []

    # Fetch the template's attachments once — they are constant across this rule's
    # sweep, so we avoid re-querying them per generated occurrence.
    template_attachments = (
        list(TaskAttachment.objects.filter(task=template, is_deleted=False))
        if rule.inherit_attachments
        else []
    )

    today = (now or timezone.now()).date()
    horizon_end = today + timedelta(days=horizon_days)
    anchor = template.planned_start or today

    if rule.end_type == RecurrenceEndType.ON_DATE and rule.end_date:
        horizon_end = min(horizon_end, rule.end_date)

    remaining: int | None = None
    if rule.end_type == RecurrenceEndType.AFTER_N and rule.end_count is not None:
        already = rule.occurrences.filter(is_deleted=False).count()
        remaining = max(rule.end_count - already, 0)
        if remaining == 0:
            return []

    # Resume after the last generated date; never back-fill past occurrences.
    if rule.generated_through:
        cursor = max(rule.generated_through + timedelta(days=1), today)
    else:
        cursor = max(anchor, today)

    created: list[Any] = []
    d = cursor
    while d <= horizon_end:
        if _occurrence_matches(rule, anchor, d):
            if remaining is not None and len(created) >= remaining:
                break
            if not rule.occurrences.filter(recurrence_occurrence_date=d).exists():
                created.append(_spawn_occurrence(rule, template, d, template_attachments))
        d += timedelta(days=1)

    # Advance the cursor to the scanned horizon so the next sweep is incremental.
    # Written via .update() (not .save()) deliberately: generated_through is an
    # internal cursor, so advancing it must not bump server_version or write a history
    # row — otherwise every hourly sweep would spam the sync delta and audit trail.
    if rule.generated_through != horizon_end:
        from trueppm_api.apps.projects.models import TaskRecurrenceRule

        TaskRecurrenceRule.objects.filter(pk=rule.pk).update(generated_through=horizon_end)
        rule.generated_through = horizon_end
    return created


# ---------------------------------------------------------------------------
# Async project export bundle (ADR-0219, #1266)
# ---------------------------------------------------------------------------


def enqueue_project_export(*, project: Any, requested_by: Any) -> Any:
    """Create a project export job row and best-effort dispatch the Celery task.

    Mirrors ``workspace.services.enqueue_workspace_export`` (ADR-0174) at the
    project grain. Follows the transactional-outbox convention (ADR-0080): the row
    commits with the request; ``.delay()`` is attempted in ``transaction.on_commit``
    and broker errors are swallowed because ``drain_project_exports`` re-dispatches
    stuck ``pending`` rows. ``.delay()`` is only ever called from here and the drain.

    De-dupes in-flight work per project: assembling a full bundle (zip of JSON + XML +
    attachment blobs + history) is expensive, so if an export for this project is
    already ``pending``/``running`` the existing job is returned rather than queuing a
    second build (also bounds an Admin triggering repeated exports). The returned
    ``ProjectExportJob`` row is itself the audit record (``requested_by`` + timestamps).
    """
    from trueppm_api.apps.projects.models import ExportJobStatus, ProjectExportJob

    existing = ProjectExportJob.objects.filter(
        project=project,
        status__in=[ExportJobStatus.PENDING, ExportJobStatus.RUNNING],
    ).first()
    if existing is not None:
        return existing

    job = ProjectExportJob.objects.create(project=project, requested_by=requested_by)

    # Capture the plain job id (not the ORM instance) in the on_commit closure — a
    # deferred callback must not close over a live row that could be stale by the
    # time it runs (transactional-outbox hygiene).
    job_id = str(job.id)

    def _dispatch() -> None:
        from trueppm_api.apps.projects.tasks import run_project_export

        try:
            run_project_export.delay(job_id)
        except Exception:  # pragma: no cover - broker-down path, drain recovers
            logger.warning(
                "broker unavailable; drain_project_exports will pick up export %s", job_id
            )

    transaction.on_commit(_dispatch)
    return job
