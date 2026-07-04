"""Replay a v2 seed event timeline with backdated history (ADR-0114).

The v1 importer materializes final state: one ORM write per row, every
``django-simple-history`` row dated ``now()`` by the importer. A v2 seed instead
authors the program's *life* — an ordered ``events`` timeline — and this module
replays it so the demo reads like a program that has run for months:

- Tasks are created at their base column and walked forward through real status
  transitions; each transition writes a history row dated to the event, attributed
  to a named persona, so a COMPLETE task's History tab shows dated moves by people.
- A deterministic synthesizer fills the unauthored "boring middle": any task whose
  final state implies it passed through earlier columns gets synthetic transitions
  (it always traverses IN_PROGRESS, never NOT_STARTED→COMPLETE, so burndowns are
  not hollow — VoC/Alex). Authored events always win over synthesis.
- A day-by-day sim clock writes one ``SprintBurnSnapshot`` per active-sprint day,
  so burndown curves and multi-sprint velocity are real history, not a single
  fabricated number.

Replay runs inside the importer's existing ``transaction.atomic()`` and under the
``seed_replay`` context flag, so the live side effects a real edit would trigger —
today-dated burndown, board broadcasts, notifications, webhooks — are suppressed.
A single CPM recalc per project is enqueued by the importer after commit.
"""

from __future__ import annotations

import logging
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    EstimateStatus,
    RetroActionItem,
    Risk,
    ScopeChangeStatus,
    Sprint,
    SprintRetro,
    SprintScopeChange,
    SprintState,
    Task,
    TaskComment,
    TaskStatus,
)
from trueppm_api.apps.projects.seed.reldates import WorkingCalendar, resolve_timestamp
from trueppm_api.apps.projects.seed.replay_ctx import seed_replay
from trueppm_api.apps.projects.services import upsert_burndown_for_sprint

logger = logging.getLogger(__name__)

# Forward progression of the board. The synthesizer walks a task from its base
# column up to its authored final column through this sequence, so every
# in-flight/done task passes through IN_PROGRESS (a hollow burndown is the bug
# Alex called out in VoC). BACKLOG/ON_HOLD are off the progression spine.
_PROGRESSION = [
    TaskStatus.NOT_STARTED,
    TaskStatus.IN_PROGRESS,
    TaskStatus.REVIEW,
    TaskStatus.COMPLETE,
]
_PROGRESSION_INDEX: dict[str, int] = {str(s): i for i, s in enumerate(_PROGRESSION)}

# Upper bound on the day-by-day snapshot window (~10 years). The schema already
# caps a single date offset at 4 digits; this bounds the *span* between the
# earliest and latest beat so no crafted timeline drives an oversized loop.
MAX_REPLAY_SPAN_DAYS = 3660


@dataclass
class ReplayContext:
    """Symbol tables + resolved settings the importer hands to the replay pass."""

    anchor: date
    program_code: str
    default_actor: Any  # the importing owner; fallback when an event names no actor
    users: dict[str, Any]  # account slug -> User (or None on the generic path)
    tasks: dict[tuple[str, str], Task]  # (project_slug, wbs_path) -> Task
    sprints: dict[tuple[str, str], Sprint]  # (project_slug, sprint_slug) -> Sprint
    projects: dict[str, Any]  # project_slug -> Project
    project_calendars: dict[str, WorkingCalendar]  # project_slug -> calendar facts
    risks: dict[str, Risk]  # risk slug -> Risk
    final_status: dict[tuple[str, str], str]  # desired end column per task
    final_sprint: dict[tuple[str, str], dict[str, Any]]  # desired end state per sprint
    tz: Any = None  # program timezone for synthesized timestamps (defaults to UTC)
    # Scope-change rows opened during replay, so a later resolve can close them.
    open_scope: dict[Any, SprintScopeChange] = field(default_factory=dict)


@dataclass(order=True)
class _Beat:
    """One resolved timeline beat, sortable by (when, order)."""

    when: datetime
    order: int
    action: str = field(compare=False)
    target: str = field(compare=False)
    actor: Any = field(compare=False, default=None)
    data: dict[str, Any] = field(compare=False, default_factory=dict)
    synthetic: bool = field(compare=False, default=False)


def replay_timeline(payload: dict[str, Any], ctx: ReplayContext) -> None:
    """Replay the document's events (+ synthesized fill) against ``ctx``.

    Idempotent within an import: the caller wipes-and-recreates the program, so
    the timeline is always replayed from a clean base. Determinism comes from a
    seed derived from ``program_code`` + the task wbs path.
    """
    with seed_replay():
        beats = _resolve_authored(payload, ctx)
        beats.extend(_synthesize(ctx, beats))
        beats.sort()
        _run_sim_clock(beats, ctx)


# --- resolution --------------------------------------------------------------


def _resolve_authored(payload: dict[str, Any], ctx: ReplayContext) -> list[_Beat]:
    """Turn authored event dicts into sortable beats with concrete datetimes."""
    out: list[_Beat] = []
    for i, ev in enumerate(payload.get("events", [])):
        when = resolve_timestamp(ev["at"], anchor=ctx.anchor)
        actor = ctx.users.get(ev["actor"]) if ev.get("actor") else None
        out.append(
            _Beat(
                when=when,
                order=i,
                action=ev["action"],
                target=ev.get("target", ""),
                actor=actor or ctx.default_actor,
                data=ev,
            )
        )
    return out


def _resolve_task(ctx: ReplayContext, target: str) -> Task | None:
    """Resolve a ``task:<project>:<wbs>`` target to a Task in the symbol table."""
    _, _, ref = target.partition(":")
    project_slug, _, wbs = ref.partition(":")
    return ctx.tasks.get((project_slug, wbs))


def _resolve_sprint(ctx: ReplayContext, target: str) -> Sprint | None:
    _, _, ref = target.partition(":")
    project_slug, _, sprint_slug = ref.partition(":")
    return ctx.sprints.get((project_slug, sprint_slug))


def _task_window(ctx: ReplayContext, key: tuple[str, str], task: Task) -> tuple[date, date]:
    """The [start, end] working window a synthesized task progresses across.

    Agile tasks ride their sprint window; scheduled tasks ride
    planned_start..+duration; everything else rides the project start..anchor.
    The end is clamped to the anchor — a demo never has work completing in the
    future relative to "today".
    """
    project_slug = key[0]
    project = ctx.projects[project_slug]
    sprint = task.sprint
    if sprint is not None:
        start, end = sprint.start_date, sprint.finish_date
    elif task.planned_start is not None:
        start = task.planned_start
        end = start + timedelta(days=max(task.duration, 1))
    else:
        start = project.start_date
        end = ctx.anchor
    # Clamp both ends to the anchor: a completed task whose nominal window sits
    # in the future (relative to import day) still gets past-dated history, never
    # future-dated — the demo's "today" is the anchor.
    start = min(start, ctx.anchor)
    end = min(end, ctx.anchor)
    if end < start:
        end = start
    return start, end


def _synthesize(ctx: ReplayContext, authored: list[_Beat]) -> list[_Beat]:
    """Fill the unauthored timeline: sprint ceremonies + task progressions."""
    return _synthesize_sprints(ctx, authored) + _synthesize_tasks(ctx, authored)


def _synthesize_sprints(ctx: ReplayContext, authored: list[_Beat]) -> list[_Beat]:
    """Synthesize activate/close beats for sprints the timeline left implicit.

    A sample that merely declares a sprint's end state + points (the v1 shape)
    still gets a real run: activate at start, close at finish, so the sim clock
    writes a burndown curve and a velocity number that is actual history.
    """
    authored_targets = {b.target for b in authored if b.action.startswith("sprint.")}
    out: list[_Beat] = []
    for key, sprint in ctx.sprints.items():
        target = f"sprint:{key[0]}:{key[1]}"
        if target in authored_targets:
            continue
        final_state = ctx.final_sprint.get(key, {}).get("state", SprintState.PLANNED)
        if final_state not in (SprintState.ACTIVE, SprintState.COMPLETED):
            continue
        out.append(
            _Beat(
                when=_aware_dt(ctx, sprint.start_date, 9, 0),
                order=0,
                action="sprint.activate",
                target=target,
                actor=ctx.default_actor,
                data={},
                synthetic=True,
            )
        )
        if final_state == SprintState.COMPLETED:
            out.append(
                _Beat(
                    when=_aware_dt(ctx, sprint.finish_date, 17, 0),
                    order=2_000_000,  # close sorts after that day's task moves
                    action="sprint.close",
                    target=target,
                    actor=ctx.default_actor,
                    data={"goal_outcome": ctx.final_sprint.get(key, {}).get("goal_outcome")},
                    synthetic=True,
                )
            )
    return out


def _synthesize_tasks(ctx: ReplayContext, authored: list[_Beat]) -> list[_Beat]:
    """Generate status transitions for tasks the authored timeline left implicit.

    For each task whose final column is past NOT_STARTED and which has no authored
    ``task.status`` beat, walk it forward through every intermediate column on
    evenly-spaced, seeded dates within its window. Deterministic: a fixed seed per
    (program, wbs) means re-import and round-trip reproduce the same history.
    """
    authored_status_targets = {b.target for b in authored if b.action == "task.status"}
    out: list[_Beat] = []
    for key, task in ctx.tasks.items():
        project_slug, wbs = key
        target = f"task:{project_slug}:{wbs}"
        if target in authored_status_targets:
            continue  # author owns this task's progression
        final = ctx.final_status.get(key, TaskStatus.NOT_STARTED)
        final_idx = _PROGRESSION_INDEX.get(final)
        if final_idx is None or final_idx == 0:
            continue  # BACKLOG / ON_HOLD / still NOT_STARTED — nothing to walk
        start, end = _task_window(ctx, key, task)
        steps = _PROGRESSION[1 : final_idx + 1]  # columns to move into, in order
        rng = random.Random(f"{ctx.program_code}:{wbs}")
        actor = task.assignee or ctx.default_actor
        span = (end - start).days or 1
        # Place each transition at a stable fraction of the window, jittered.
        for n, status in enumerate(steps, start=1):
            frac = n / (len(steps) + 1)
            jitter = rng.uniform(-0.5, 0.5) / (len(steps) + 1)
            day_offset = round(min(max(frac + jitter, 0.02), 0.98) * span)
            when = _aware_dt(
                ctx, start + timedelta(days=day_offset), rng.randint(9, 16), rng.randint(0, 59)
            )
            out.append(
                _Beat(
                    when=when,
                    order=1_000_000 + n,  # synthetic beats sort after same-instant authored
                    action="task.status",
                    target=target,
                    actor=actor,
                    data={"to": status},
                    synthetic=True,
                )
            )
    return out


# --- sim clock ---------------------------------------------------------------


def _run_sim_clock(beats: list[_Beat], ctx: ReplayContext) -> None:
    """Apply beats in time order; snapshot active-sprint burndown each day.

    Iterating every calendar day (not only event days) means an active sprint
    gets a snapshot on quiet days too, so the burndown curve has no gaps.
    """
    if not beats:
        # No timeline (e.g. a v2 doc with only relative dates) — still finalize
        # sprint states so the seed's intended end state holds.
        _finalize_sprints(ctx, ctx.anchor)
        return

    by_day: dict[date, list[_Beat]] = {}
    for b in beats:
        by_day.setdefault(b.when.date(), []).append(b)

    first = min(by_day)
    last = max(by_day)
    # Bound the per-day snapshot loop. The schema caps any single offset at ~27
    # years, but a seed could still author a multi-decade span; clamp the
    # snapshotted window so a crafted timeline can't drive an oversized loop.
    # Beats before the window are still applied (so task states entering the
    # window are correct) — only their day-by-day snapshots are skipped.
    window_start = first
    if (last - first).days > MAX_REPLAY_SPAN_DAYS:
        window_start = last - timedelta(days=MAX_REPLAY_SPAN_DAYS)
        logger.warning(
            "seed replay: span %sd exceeds %sd cap; snapshotting recent window only",
            (last - first).days,
            MAX_REPLAY_SPAN_DAYS,
        )
        for d in sorted(by_day):
            if d >= window_start:
                break
            for beat in by_day[d]:
                _apply(beat, ctx)

    day = window_start
    while day <= last:
        for beat in by_day.get(day, []):
            _apply(beat, ctx)
        _snapshot_active_sprints(ctx, day)
        day += timedelta(days=1)

    _finalize_sprints(ctx, last)


def _snapshot_active_sprints(ctx: ReplayContext, day: date) -> None:
    for sprint in ctx.sprints.values():
        if sprint.state == SprintState.ACTIVE and sprint.start_date <= day <= sprint.finish_date:
            try:
                upsert_burndown_for_sprint(sprint, snapshot_date=day)
            except Exception:  # burndown is a secondary observation; never fail the import
                logger.exception(
                    "seed replay: burndown snapshot failed sprint=%s day=%s", sprint.pk, day
                )


def _finalize_sprints(ctx: ReplayContext, day: date) -> None:
    """Force every sprint to the seed's authored end state after replay.

    Authored/synthesized activate+close beats normally drive this; this is the
    backstop for sprints the timeline never touched, so the seed's declared
    state still holds.
    """
    for key, sprint in ctx.sprints.items():
        desired = ctx.final_sprint.get(key, {}).get("state")
        if desired and sprint.state != desired:
            sprint.state = desired
            _save(sprint, _aware(ctx, day), ctx.default_actor, ["state"])


# --- event handlers ----------------------------------------------------------


def _apply(beat: _Beat, ctx: ReplayContext) -> None:
    handler = _HANDLERS.get(beat.action)
    if handler is None:  # pragma: no cover - validator restricts the action set
        logger.warning("seed replay: no handler for action %r", beat.action)
        return
    handler(beat, ctx)


def _apply_task_status(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    if task is None:
        return
    new_status = beat.data.get("to")
    if not new_status or new_status == task.status:
        return
    task.status = new_status
    fields = ["status"]
    # Actual dates make baseline-vs-actual slip visible (VoC/Sarah): first move
    # into IN_PROGRESS stamps actual_start; reaching COMPLETE stamps finish.
    if new_status == TaskStatus.IN_PROGRESS and task.actual_start is None:
        task.actual_start = beat.when.date()
        fields.append("actual_start")
    if new_status == TaskStatus.COMPLETE:
        task.actual_finish = beat.when.date()
        task.remaining_points = 0
        fields += ["actual_finish", "remaining_points"]
    _save(task, beat.when, beat.actor, fields)
    # Task.save force-stamps status_changed_at=now(); correct it to the beat time
    # so cycle-time and "in column since" read as history, not import time.
    Task.objects.filter(pk=task.pk).update(status_changed_at=beat.when)
    task.status_changed_at = beat.when


def _apply_task_assign(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    if task is None:
        return
    assignee = ctx.users.get(beat.data["assignee"]) if beat.data.get("assignee") else None
    task.assignee = assignee
    _save(task, beat.when, beat.actor, ["assignee"])


def _apply_task_estimate(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    est = beat.data.get("estimate")
    if task is None or not est:
        return
    task.optimistic_duration = est["optimistic"]
    task.most_likely_duration = est["most_likely"]
    task.pessimistic_duration = est["pessimistic"]
    task.estimate_status = EstimateStatus.ACCEPTED
    _save(
        task,
        beat.when,
        beat.actor,
        ["optimistic_duration", "most_likely_duration", "pessimistic_duration", "estimate_status"],
    )


def _apply_task_points(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    if task is None:
        return
    fields = []
    if "points" in beat.data:
        task.story_points = beat.data["points"]
        fields.append("story_points")
    if "remaining_points" in beat.data:
        task.remaining_points = beat.data["remaining_points"]
        fields.append("remaining_points")
    if fields:
        _save(task, beat.when, beat.actor, fields)


def _apply_task_ac_met(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    if task is None:
        return
    task.dor = "ready"
    _save(task, beat.when, beat.actor, ["dor"])


def _apply_task_comment(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    body = beat.data.get("body")
    if task is None or not body:
        return
    comment = TaskComment.objects.create(task=task, author=beat.actor, body=body)
    # created_at is auto_now_add (stamped now() on insert); backdate it.
    TaskComment.objects.filter(pk=comment.pk).update(created_at=beat.when)


def _apply_sprint_activate(beat: _Beat, ctx: ReplayContext) -> None:
    sprint = _resolve_sprint(ctx, beat.target)
    if sprint is None:
        return
    sprint.state = SprintState.ACTIVE
    sprint.activated_at = beat.when
    # Snapshot the commitment at activation from the seed's authored end state.
    key = _sprint_key(ctx, sprint)
    committed = ctx.final_sprint.get(key, {}).get("committed_points")
    if committed is not None:
        sprint.committed_points = committed
    _save(sprint, beat.when, beat.actor, ["state", "activated_at", "committed_points"])


def _apply_sprint_close(beat: _Beat, ctx: ReplayContext) -> None:
    sprint = _resolve_sprint(ctx, beat.target)
    if sprint is None:
        return
    sprint.state = SprintState.COMPLETED
    sprint.closed_at = beat.when
    if beat.data.get("goal_outcome"):
        sprint.goal_outcome = beat.data["goal_outcome"]
    key = _sprint_key(ctx, sprint)
    completed = ctx.final_sprint.get(key, {}).get("completed_points")
    if completed is not None:
        sprint.completed_points = completed
    _save(
        sprint,
        beat.when,
        beat.actor,
        ["state", "closed_at", "goal_outcome", "completed_points"],
    )


def _apply_scope_inject(beat: _Beat, ctx: ReplayContext) -> None:
    """Record a mid-sprint scope injection as the real audit row (VoC/Alex).

    Creates the SprintScopeChange the drawer chip + Enterprise audit read, and
    flags the task pending — the same row the live ``record_sprint_scope_change``
    path writes — without firing the notify signal (suppressed during replay).
    """
    task = _resolve_task(ctx, beat.target)
    if task is None or task.sprint is None:
        return
    scope = SprintScopeChange.objects.create(
        task=task,
        sprint=task.sprint,
        subtask_name=task.name,
        added_by=beat.actor,
        goal_impact=bool(beat.data.get("goal_impact", False)),
        status=ScopeChangeStatus.PENDING,
    )
    # added_at is auto_now_add (stamped now() on insert); backdate it to the beat
    # so the scope-injection audit reads chronologically and — for a still-PENDING
    # injection — the exporter can reconstruct a deterministic scope_inject event
    # from this row (the round-trip fixpoint depends on a stable timestamp).
    SprintScopeChange.objects.filter(pk=scope.pk).update(added_at=beat.when)
    ctx.open_scope[task.pk] = scope
    task.sprint_pending = True
    _save(task, beat.when, beat.actor, ["sprint_pending"])


def _apply_scope_resolve(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    if task is None:
        return
    scope = ctx.open_scope.pop(task.pk, None)
    accepted = (beat.data.get("to") or "ACCEPTED").upper() != "REJECTED"
    if scope is not None:
        scope.status = ScopeChangeStatus.ACCEPTED if accepted else ScopeChangeStatus.REJECTED
        scope.save(update_fields=["status"])
    task.sprint_pending = False
    fields = ["sprint_pending"]
    if not accepted:
        task.sprint = None
        fields.append("sprint")
    _save(task, beat.when, beat.actor, fields)


def _apply_risk_status(beat: _Beat, ctx: ReplayContext) -> None:
    _, _, slug = beat.target.partition(":")
    risk = ctx.risks.get(slug)
    if risk is None:
        return
    new_status = beat.data.get("to")
    if not new_status or new_status == risk.status:
        return
    risk.status = new_status
    _save(risk, beat.when, beat.actor, ["status"])


def _apply_baseline_capture(beat: _Beat, ctx: ReplayContext) -> None:
    """Capture a baseline of the project's current task dates at the beat time."""
    _, _, project_slug = beat.target.partition(":")
    project = ctx.projects.get(project_slug)
    if project is None:
        return
    baseline = Baseline.objects.create(
        project=project,
        name=beat.data.get("body") or f"Baseline {beat.when.date().isoformat()}",
        is_active=False,
    )
    Baseline.objects.filter(pk=baseline.pk).update(created_at=beat.when)
    rows = [
        BaselineTask(
            baseline=baseline,
            task_id=task.pk,
            task_name=task.name,
            start=task.planned_start,
            finish=task.planned_start + timedelta(days=task.duration)
            if task.planned_start
            else None,
            duration=task.duration,
            story_points=task.story_points,
        )
        for (slug, _), task in ctx.tasks.items()
        if slug == project_slug
    ]
    BaselineTask.objects.bulk_create(rows)


def _apply_retro_action(beat: _Beat, ctx: ReplayContext) -> None:
    """Create a RetroActionItem on the target sprint's retro (ADR-0114 §7).

    The parent ``SprintRetro`` is created lazily the first time an action item
    attaches to the sprint (mirroring the live ``_get_or_create_retro`` path),
    so a seed authors retro outcomes without a separate "open retro" event.
    """
    sprint = _resolve_sprint(ctx, beat.target)
    body = beat.data.get("body")
    if sprint is None or not body:
        return
    retro, created = SprintRetro.objects.get_or_create(
        sprint=sprint, defaults={"created_by": beat.actor}
    )
    if created:
        # created_at is auto_now_add; backdate the retro to its first action so
        # the demo's retro is dated to the ceremony, not import time.
        SprintRetro.objects.filter(pk=retro.pk).update(created_at=beat.when)
    assignee = ctx.users.get(beat.data["assignee"]) if beat.data.get("assignee") else None
    item = RetroActionItem.objects.create(
        retro=retro,
        text=body,
        assignee=assignee,
        story_points=beat.data.get("points"),
    )
    RetroActionItem.objects.filter(pk=item.pk).update(created_at=beat.when)


def _apply_retro_promote(beat: _Beat, ctx: ReplayContext) -> None:
    """Promote a retro action item (matched by ``body``) to a backlog task.

    Mirrors ``promote_retro_action_item`` but writes directly (no on_commit
    broadcast / recalc enqueue) because replay is side-effect-suppressed — the
    importer enqueues a single per-project recalc after commit. The resulting
    Task is a project-backlog item (``status=BACKLOG``, ``sprint=None``) exactly
    as the live promote path produces, so the demo shows the retro→task loop
    closed with a real ``T-XXX`` link.
    """
    sprint = _resolve_sprint(ctx, beat.target)
    body = beat.data.get("body")
    if sprint is None or not body:
        return
    retro = SprintRetro.objects.filter(sprint=sprint).first()
    if retro is None:
        return
    item = (
        RetroActionItem.objects.filter(retro=retro, text=body, promoted_task_id__isnull=True)
        .order_by("created_at")
        .first()
    )
    if item is None:
        return  # nothing (left) to promote for this text
    short_id = sprint.short_id or str(sprint.pk)[:8]
    task = Task(
        project=sprint.project,
        name=body[:255],
        duration=1,
        status=TaskStatus.BACKLOG,
        sprint=None,
        assignee=item.assignee,
        story_points=item.story_points,
        notes=f'source: "retrospective" (from Sprint {short_id} retro)',
    )
    _save_new_backdated(task, beat.when, beat.actor)
    item.promoted_task_id = task.pk
    item.save(update_fields=["promoted_task_id"])


# --- helpers -----------------------------------------------------------------


def _save_new_backdated(instance: Any, when: datetime, user: Any) -> None:
    """Insert a brand-new instance, dating its creation history row to ``when``.

    Unlike ``_save`` (which uses ``update_fields`` for a narrow update), this is
    for a first insert: simple-history honors ``_history_date`` / ``_history_user``
    on the create so the row is attributed and backdated in one write.
    """
    instance._history_date = when
    instance._history_user = user
    instance.save()


def _save(instance: Any, when: datetime, user: Any, fields: list[str]) -> None:
    """Save ``instance`` writing a history row dated ``when`` by ``user``.

    django-simple-history honors ``_history_date``/``_history_user`` set on the
    instance before save (ADR-0114 — the first backdated-history writer in the
    codebase). update_fields keeps the write narrow.
    """
    instance._history_date = when
    instance._history_user = user
    instance.save(update_fields=fields)


def _aware(ctx: ReplayContext, day: date) -> datetime:
    return _aware_dt(ctx, day, 12, 0)


def _aware_dt(ctx: ReplayContext, day: date, hour: int, minute: int) -> datetime:
    """Build an aware datetime in the program timezone (default UTC)."""
    tz = ctx.tz or ZoneInfo("UTC")
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz)


def _sprint_key(ctx: ReplayContext, sprint: Sprint) -> tuple[str, str]:
    for key, candidate in ctx.sprints.items():
        if candidate.pk == sprint.pk:
            return key
    return ("", "")


_HANDLERS = {
    "task.status": _apply_task_status,
    "task.assign": _apply_task_assign,
    "task.estimate": _apply_task_estimate,
    "task.points": _apply_task_points,
    "task.ac_met": _apply_task_ac_met,
    "task.comment": _apply_task_comment,
    "sprint.activate": _apply_sprint_activate,
    "sprint.close": _apply_sprint_close,
    "sprint.scope_inject": _apply_scope_inject,
    "sprint.scope_resolve": _apply_scope_resolve,
    "risk.status": _apply_risk_status,
    "baseline.capture": _apply_baseline_capture,
    "retro.action": _apply_retro_action,
    "retro.promote": _apply_retro_promote,
}
