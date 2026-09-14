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

import functools
import logging
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from django.db.models import F, Q
from django.utils import timezone

from trueppm_api.apps.projects.actual_date_rules import check_actual_dates
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    Baseline,
    BaselineTask,
    CommentAcknowledgement,
    CommentReaction,
    EstimateStatus,
    RetroActionItem,
    Risk,
    RiskComment,
    ScopeChangeStatus,
    Sprint,
    SprintRetro,
    SprintScopeChange,
    SprintState,
    Task,
    TaskComment,
    TaskNote,
    TaskStatus,
)
from trueppm_api.apps.projects.seed.reldates import WorkingCalendar, resolve_timestamp
from trueppm_api.apps.projects.seed.replay_ctx import seed_replay
from trueppm_api.apps.projects.services import upsert_burndown_for_sprint
from trueppm_api.apps.timetracking.models import TimeEntry

if TYPE_CHECKING:
    from trueppm_api.apps.notifications.services import ParsedMention

logger = logging.getLogger(__name__)

# Seed-script beat action key for board-column moves.
_TASK_STATUS_ACTION = "task.status"

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
    # Authored in-flight progress per task, restored after the timeline runs
    # (#3486). Only carries the keys the document actually wrote, so a dated
    # ``task.points`` beat is never overwritten by a value nobody authored.
    final_progress: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    tz: Any = None  # program timezone for synthesized timestamps (defaults to UTC)
    # Scope-change rows opened during replay, so a later resolve can close them.
    open_scope: dict[Any, SprintScopeChange] = field(default_factory=dict)
    # v2.1 (#3603): acceptance criteria per task in position order, so a
    # ``task.ac_met`` beat can tick one by index; and comments by the slug their
    # ``task.comment`` beat declared, so a reply/reaction/ack can find them.
    criteria: dict[tuple[str, str], list[AcceptanceCriterion]] = field(default_factory=dict)
    comments: dict[str, TaskComment] = field(default_factory=dict)


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

    Also seeds every persona's notification preferences, then — beside the
    per-beat notifications individual handlers below emit — synthesizes the two
    event types with no single triggering beat: a ``task.stale`` sweep and the
    sponsor persona's ``program.health_digest`` (#3489).
    """
    with seed_replay():
        _seed_notification_preferences(payload, ctx)
        beats = _resolve_authored(payload, ctx)
        beats.extend(_synthesize(ctx, beats))
        beats.sort()
        _run_sim_clock(beats, ctx)
        _synthesize_stale_notifications(ctx)
        _synthesize_program_digest(payload, ctx)
        _apply_notification_realism(ctx)


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
    authored_status_targets = {b.target for b in authored if b.action == _TASK_STATUS_ACTION}
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
                    action=_TASK_STATUS_ACTION,
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
        # sprint states and in-flight progress so the seed's intended end state
        # holds.
        _finalize(ctx, ctx.anchor)
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

    _finalize(ctx, last)


def _snapshot_active_sprints(ctx: ReplayContext, day: date) -> None:
    for sprint in ctx.sprints.values():
        if sprint.state == SprintState.ACTIVE and sprint.start_date <= day <= sprint.finish_date:
            try:
                upsert_burndown_for_sprint(sprint, snapshot_date=day)
            except Exception:  # burndown is a secondary observation; never fail the import
                logger.exception(
                    "seed replay: burndown snapshot failed sprint=%s day=%s", sprint.pk, day
                )


def _finalize(ctx: ReplayContext, day: date) -> None:
    """Restore the end states the replay had to walk up to, once it has.

    Two passes, both backstops for the same structural fact: replay births an
    entity at the *base* of its progression so the timeline has somewhere to walk
    from, and the walk does not always land on every authored field.
    """
    _finalize_sprints(ctx, day)
    _finalize_tasks(ctx, day)


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


def _finalize_tasks(ctx: ReplayContext, day: date) -> None:
    """Restore the authored progress of every task that ends in flight or in review.

    A task whose end column is IN_PROGRESS or REVIEW is born at 0% with its full
    points remaining so the timeline has room to walk it forward, and nothing
    ever puts the authored numbers back on its own: ``_apply_task_status``
    writes only the column and the actual dates. For IN_PROGRESS neither field
    is rescued elsewhere (#3486). For REVIEW, ``Task._coerce_signoff_percent``
    fixes ``percent_complete`` to 100 by design ("work done, awaiting
    sign-off") but has no opinion on ``remaining_points`` — a story in review
    with points still open is a real, authorable state (#3518). Without this
    pass every in-flight or in-review task in every v2 seed loads holding its
    full ``story_points``.

    That is not cosmetic. ``percent_complete`` sets the *remaining* duration CPM
    schedules (ADR-0132/0136), so a 0% in-flight task is billed at its full
    duration and both the utilization heat map and the burndown's "remaining"
    read high. The pass therefore runs before the importer's post-commit
    ``enqueue_recalculate``, so the recompute sees the corrected values.

    Only fields the document actually authored are written, which is what keeps
    a dated ``task.points`` beat authoritative: a task that declares no
    ``remaining_points`` of its own is left holding whatever the timeline gave
    it. The importer never hands back ``percent_complete`` for a REVIEW task
    (see its ``final_progress`` construction), so the coerced 100 is never
    fought here even though this loop treats both statuses uniformly.
    """
    for key, task in ctx.tasks.items():
        if ctx.final_status.get(key) not in (TaskStatus.IN_PROGRESS, TaskStatus.REVIEW):
            continue
        authored = ctx.final_progress.get(key)
        if not authored:
            continue
        fields = [
            name
            for name in ("percent_complete", "remaining_points")
            if name in authored and getattr(task, name) != authored[name]
        ]
        for name in fields:
            setattr(task, name, authored[name])
        if fields:
            _save(task, _aware(ctx, day), ctx.default_actor, fields)


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
    # Defense-in-depth (ADR-1153, #3709): beats are deterministic,
    # developer-authored data and should never trip these rules, but this is a
    # direct model write like the MS Project importer's, so it runs through the
    # same shared check rather than trusting that by construction. A violation
    # here means the beat script itself is wrong — log it and drop the
    # offending field rather than persisting a pair the engine would reject at
    # the project's next recompute.
    violation = check_actual_dates(
        actual_start=task.actual_start,
        actual_finish=task.actual_finish,
        status=task.status,
        project=task.project,
    )
    if violation is not None:
        logger.warning(
            "seed replay: beat %r on task %s would violate ADR-1153 (%s); dropping %s",
            beat.action,
            task.pk,
            violation.message,
            violation.field,
        )
        setattr(task, violation.field, None)
        if violation.field not in fields:
            fields.append(violation.field)
    _save(task, beat.when, beat.actor, fields)
    # Task.save force-stamps status_changed_at=now(); correct it to the beat time
    # so cycle-time and "in column since" read as history, not import time.
    Task.objects.filter(pk=task.pk).update(status_changed_at=beat.when)
    task.status_changed_at = beat.when


def _apply_task_assign(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    if task is None:
        return
    previous_assignee_id = task.assignee_id
    assignee = ctx.users.get(beat.data["assignee"]) if beat.data.get("assignee") else None
    task.assignee = assignee
    _save(task, beat.when, beat.actor, ["assignee"])
    _notify_task_assigned(task, previous_assignee_id, assignee, beat)


def _notify_task_assigned(
    task: Task, previous_assignee_id: Any, assignee: Any, beat: _Beat
) -> None:
    """``task.assigned`` to the new assignee (#638/#639), mirroring
    ``views._emit_assignee_change_events``'s notification half.

    Fires on any change that lands a real assignee — a fresh None→user
    assignment or a user→user reassignment alike — except a clear (assignee
    set to None) and never to the actor who made the assignment.
    """
    if assignee is None or assignee.pk == previous_assignee_id:
        return
    if assignee.pk == getattr(beat.actor, "pk", None):
        return
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications

    subject = f"You were assigned to {task.name}"
    body = f'You were assigned to the task "{task.name}" in TruePPM.'
    _dispatch_and_backdate(
        beat.when,
        event_type=NotificationEventType.TASK_ASSIGNED.value,
        project_id=task.project_id,
        recipient_ids=[assignee.pk],
        dispatch=lambda: create_event_notifications(
            event_type=NotificationEventType.TASK_ASSIGNED.value,
            recipient_ids=[assignee.pk],
            subject=subject,
            body=body,
            project_id=task.project_id,
            task_id=task.pk,
        ),
    )


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
    """Tick one acceptance criterion (v2.1 ``criterion``), else mark the story ready.

    With ``criterion`` the beat records the review trail on that row —
    ``met_by``/``met_at`` dated to the beat — and leaves Definition of Ready alone:
    ticking a criterion during sprint review is not a readiness decision. Without
    it the beat keeps its v2.0 meaning.
    """
    task = _resolve_task(ctx, beat.target)
    if task is None:
        return
    index = beat.data.get("criterion")
    if index is not None:
        _, _, ref = beat.target.partition(":")
        project_slug, _, wbs = ref.partition(":")
        rows = ctx.criteria.get((project_slug, wbs), [])
        if index < len(rows):
            row = rows[index]
            row.met = True
            row.met_by = beat.actor
            row.met_at = beat.when
            row.save(update_fields=["met", "met_by", "met_at"])
        return
    task.dor = "ready"
    _save(task, beat.when, beat.actor, ["dor"])


def _apply_task_block(beat: _Beat, ctx: ReplayContext) -> None:
    """Raise the explicit blocker flag, dated to the beat (#3094).

    ``blocked_reason`` is the flag-of-record. ``Task.save()`` stamps
    ``blocked_since`` with ``timezone.now()`` on the empty -> non-empty
    transition, which on a backdated timeline would render every blocker as
    "0d blocked" — and age is the entire triage signal. So the stamp is
    overwritten with the beat time through a queryset update, the same way
    ``_apply_scope_inject`` corrects its ``auto_now_add`` column.
    """
    task = _resolve_task(ctx, beat.target)
    reason = beat.data.get("body")
    if task is None or not reason:
        return
    task.blocked_reason = reason
    task.blocker_type = beat.data.get("blocker_type", "")
    task.blocked_by = beat.actor
    fields = ["blocked_reason", "blocker_type", "blocked_by"]
    blocking_ref = beat.data.get("blocking_task")
    if blocking_ref:
        blocking = _resolve_task(ctx, f"task:{blocking_ref}")
        if blocking is not None and blocking.pk != task.pk:
            task.blocking_task = blocking
            fields.append("blocking_task")
    _save(task, beat.when, beat.actor, fields)
    Task.objects.filter(pk=task.pk).update(blocked_since=beat.when)
    task.blocked_since = beat.when
    _notify_task_blocked(task, beat)


def _notify_task_blocked(task: Task, beat: _Beat) -> None:
    """``task.blocked`` to the assignee + project leads (#855/#476/ADR-0124),
    reusing the real recipient resolver and renderer so the content matches the
    live path exactly (``views._emit_blocked_notification``).

    The rendered body's age line reads "just now" for a freshly-flagged task —
    it always does here too, since this fires in the same beat that sets
    ``blocked_since``.
    """
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications
    from trueppm_api.apps.projects.blocker_services import (
        render_blocker_notification,
        resolve_impediment_recipients,
    )

    recipients = resolve_impediment_recipients(task)
    recipients.discard(getattr(beat.actor, "pk", None))
    if not recipients:
        return
    subject, body = render_blocker_notification(task)
    recipient_ids = list(recipients)
    _dispatch_and_backdate(
        beat.when,
        event_type=NotificationEventType.TASK_BLOCKED.value,
        project_id=task.project_id,
        recipient_ids=recipient_ids,
        dispatch=lambda: create_event_notifications(
            event_type=NotificationEventType.TASK_BLOCKED.value,
            recipient_ids=recipient_ids,
            subject=subject,
            body=body,
            project_id=task.project_id,
            task_id=task.pk,
        ),
    )


def _apply_task_unblock(beat: _Beat, ctx: ReplayContext) -> None:
    """Clear the blocker. ``Task.save()`` owns the cascade — emptying
    ``blocked_reason`` also nulls ``blocked_since``, ``blocker_type``,
    ``blocking_task`` and ``blocked_by`` — so this only empties the flag and
    lets the model do the rest, keeping one definition of "unblocked"."""
    task = _resolve_task(ctx, beat.target)
    if task is None or not (task.blocked_reason or "").strip():
        return
    task.blocked_reason = ""
    _save(task, beat.when, beat.actor, ["blocked_reason"])


def _apply_risk_note(beat: _Beat, ctx: ReplayContext) -> None:
    """Append a RiskComment, so a risk.status flip carries its reason (#3094).

    Without this a risk walks OPEN -> MITIGATING -> RESOLVED with no artifact of
    the work: the register records *that* it was mitigated and never *how*.
    ``created_at`` is ``auto_now_add``, so it is backdated after insert.
    """
    _, _, slug = beat.target.partition(":")
    risk = ctx.risks.get(slug)
    body = beat.data.get("body")
    if risk is None or not body:
        return
    comment = RiskComment.objects.create(risk=risk, author=beat.actor, message=body)
    RiskComment.objects.filter(pk=comment.pk).update(created_at=beat.when)


def _apply_task_comment(beat: _Beat, ctx: ReplayContext) -> None:
    task = _resolve_task(ctx, beat.target)
    body = beat.data.get("body")
    if task is None or not body:
        return
    # v2.1 threading (#3493). Validation holds a reply to a top-level comment on
    # the same task; the task check is repeated because a parent on another task
    # would render the reply under a thread it is not part of.
    parent = ctx.comments.get(beat.data["reply_to"]) if beat.data.get("reply_to") else None
    if parent is not None and (parent.task_id != task.pk or parent.parent_id is not None):
        parent = None
    comment = TaskComment.objects.create(task=task, author=beat.actor, body=body, parent=parent)
    # created_at is auto_now_add (stamped now() on insert); backdate it.
    TaskComment.objects.filter(pk=comment.pk).update(created_at=beat.when)
    if beat.data.get("slug"):
        ctx.comments[beat.data["slug"]] = comment
    # A reply is still a comment on the task, and the live product's own
    # _notify_assignee_of_comment applies uniformly regardless of parent — so
    # this fires for a reply beat exactly as it does for a top-level one (#3489).
    parsed = _fan_out_mentions(comment, task, beat)
    _notify_comment_on_assignee(task, comment, beat, parsed)


def _fan_out_mentions(comment: TaskComment, task: Task, beat: _Beat) -> list[ParsedMention]:
    """Create Mention + Notification rows for an @mention in a seeded comment.

    Only the live view path parsed mentions, so a seeded ``@mei`` was plain text:
    it *read* like a mention and produced no Mention row and no notification, and
    a persona signing in landed on an empty notification list. That is the shape
    of defect this seed audit keeps finding — a surface that looks populated and
    is not.

    Resolution filters user mentions to current **project members**, which is why
    this only became possible once seeded accounts held ProjectMemberships
    (#3092). ``now=beat.when`` keeps the notification contemporaneous with the
    comment rather than stamping import day; a mention of a non-member resolves
    to ``skipped_users`` and is silently dropped, exactly as the live path
    reports it.

    Both ``Mention.created_at`` and ``Notification.created_at`` are
    ``auto_now_add`` — always real wall-clock time — so the rows this call
    writes are backdated to the beat afterward, scoped to this exact comment's
    (freshly-created, unique) pk so a concurrent import elsewhere can never be
    touched (#3489).

    Returns the parsed mentions so the caller can de-dup the sibling
    ``comment_on_my_task`` notification against an assignee who was also
    directly @mentioned.
    """
    from trueppm_api.apps.notifications.models import Mention, Notification
    from trueppm_api.apps.notifications.services import (
        create_mention_notifications,
        parse_mentions,
        resolve_parsed_mentions,
    )

    parsed = parse_mentions(comment.body)
    if not parsed:
        return []
    resolved = resolve_parsed_mentions(parsed, task.project_id)
    if not resolved.user_targets and not resolved.group_targets:
        return list(parsed)
    t0 = timezone.now()
    create_mention_notifications(
        task_comment=comment,
        mentioner=beat.actor,
        parsed_result=resolved,
        project_id=task.project_id,
        now=beat.when,
    )
    Mention.objects.filter(task_comment=comment, created_at__gte=t0).update(created_at=beat.when)
    Notification.objects.filter(mention__task_comment=comment, created_at__gte=t0).update(
        created_at=beat.when
    )
    return parsed


def _notify_comment_on_assignee(
    task: Task, comment: TaskComment, beat: _Beat, parsed: list[ParsedMention]
) -> None:
    """``comment_on_my_task`` to the task's assignee (#639), mirroring
    ``views.TaskCommentViewSet._notify_assignee_of_comment``.

    Skipped when there is no assignee, the assignee wrote the comment, or the
    assignee was already @mentioned in it — the mention path already notified
    them, and this de-dups so one comment never pings the same person twice.
    """
    assignee = task.assignee
    if assignee is None or assignee.pk == getattr(beat.actor, "pk", None):
        return
    mentioned_usernames = {p.value for p in parsed if p.kind == "user"}
    if assignee.username in mentioned_usernames:
        return

    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications

    actor = beat.actor
    full_name = getattr(actor, "get_full_name", lambda: "")()
    author_name = full_name or getattr(actor, "username", "") or "Someone"
    subject = f"New comment on {task.name}"
    body = f'{author_name} commented on your task "{task.name}" in TruePPM.'
    _dispatch_and_backdate(
        beat.when,
        event_type=NotificationEventType.COMMENT_ON_MY_TASK.value,
        project_id=task.project_id,
        recipient_ids=[assignee.pk],
        dispatch=lambda: create_event_notifications(
            event_type=NotificationEventType.COMMENT_ON_MY_TASK.value,
            recipient_ids=[assignee.pk],
            subject=subject,
            body=body,
            project_id=task.project_id,
            task_id=task.pk,
        ),
    )


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
    """Route the close through the real close contract (ADR-0176, #3488).

    The prior version set four columns directly and stopped, so every closed
    sample sprint carried zero ``SprintTaskOutcome`` rows and produced no
    ``VelocitySuggestion`` — the sprint-review "what didn't finish" panel, the
    carry-over history, and the velocity-calibration prompt all read from
    exactly those rows, so a fresh load of every sample reviewed as empty.
    This now calls the same snapshot/outcome/velocity functions the live
    ``close_sprint`` drain task calls, in the same order, so a replayed close
    produces the audit trail a real one would.

    Narrowed from the live path on purpose, following ``is_seed_replay_active()``'s
    own contract (the burndown receiver in ``receivers.py`` is the established
    precedent): the board broadcast, the ``sprint.closed`` webhook, the
    carry-over assignee notification, and the milestone reforecast digest are
    all "the live side effect a real edit would trigger" and are skipped
    outright — none of them write a row the review panel, carry-over history,
    or velocity flow reads, and firing them here would spam a workspace
    nobody is watching during import. ``apply_pending_disposition`` is
    likewise skipped: its "carry" branch calls ``record_sprint_scope_change``,
    which fires the un-suppressed ``sprint_scope_changed`` notify signal — the
    same reason ``_apply_scope_inject`` above writes its ``SprintScopeChange``
    row directly instead of going through that path. ``was_pending`` on the
    outcome row is unaffected: it is read by ``snapshot_sprint_task_outcomes``
    below, before any disposition would run, exactly as the live close orders
    it.

    Every write here — the sprint's own state/closed_at/goal_outcome/
    completed_*, and any task the carry-over moves — goes through this
    module's ``_save()`` rather than a bare ``instance.save()``, so its history
    row is backdated to the beat like every other write in this file. Calling
    ``services.apply_carry_over`` directly instead of ``_replay_carry_over``
    below was the first attempt: it produced the right FK moves but dated the
    *moved task's own* history row to import time, which
    ``test_authored_percent_restore_is_backdated_not_import_time`` catches
    immediately — the fixture's own sprint closes with in-flight tasks still
    on it. ``_replay_carry_over`` re-applies the identical two classification
    tuples the real service uses (imported, not copied by value, so a future
    change to which statuses carry stays in sync) through ``_save()`` instead.
    """
    sprint = _resolve_sprint(ctx, beat.target)
    if sprint is None:
        return

    from trueppm_api.apps.projects.services import (
        snapshot_completed_metrics,
        snapshot_sprint_task_outcomes,
    )
    from trueppm_api.apps.scheduling.services import compute_velocity_suggestions

    # ADR-0176 §2 / #3488: derive completed_*/the default goal_outcome from
    # current task state before anything else moves, exactly like the live
    # close. A synthesized close (no authored `sprint.close` beat) has no
    # `ctx.final_sprint` goal_outcome — the importer never populates one for a
    # synthesized beat (see `_synthesize_sprints`) — so without this every
    # such sprint closed with `goal_outcome=None`; this derives a real
    # MET/PARTIAL/MISSED verdict from committed vs. completed points instead.
    snapshot_completed_metrics(sprint)
    if beat.data.get("goal_outcome"):
        # An authored value is the seed author's editorial call (e.g. "hit the
        # points but missed the actual goal") and overrides the points-ratio
        # default — mirroring the SCHEDULER+ override the live product allows
        # after close.
        sprint.goal_outcome = beat.data["goal_outcome"]
    sprint.state = SprintState.COMPLETED
    sprint.closed_at = beat.when
    _save(
        sprint,
        beat.when,
        beat.actor,
        ["state", "closed_at", "goal_outcome", "completed_points", "completed_task_count"],
    )

    # ADR-0176 §2: snapshot task membership-at-close BEFORE the carry-over
    # mutates Task.sprint — same order as the live close — otherwise the
    # "what didn't ship" set would already be gone by the time this reads it.
    carry_over_to = _implied_carry_over_target(ctx, sprint)
    snapshot_sprint_task_outcomes(sprint, carry_over_to=carry_over_to)
    carried_task_ids = _replay_carry_over(sprint, carry_over_to, beat.when, beat.actor)
    _notify_carry_over(sprint, carry_over_to, carried_task_ids, beat)

    compute_velocity_suggestions(sprint.pk)


def _replay_carry_over(sprint: Sprint, carry_over_to: str, when: datetime, actor: Any) -> list[str]:
    """Mirror ``services.apply_carry_over`` (ADR-0176) with a backdated write.

    The real close's ``task.save()`` has no beat to backdate to — correct
    there, timestamped wrong here (#3488): a replayed carry-over must date the
    moved task's history row to the beat, not to import time, like every
    other write in this file. The move rules are the same two classification
    tuples the real service reads (imported, not copied by value, so this
    stays in sync if the close contract's carry-over policy changes) — only
    *how* the result is saved differs.

    Returns the moved tasks' ids so the caller can fan out the
    ``task.moved_sprint`` notification (#3489) against exactly the set this
    call actually carried.
    """
    from trueppm_api.apps.projects.services import (
        _CARRY_OVER_INCOMPLETE_STATUSES,
        _DECOMMITTED_ON_CARRY_OVER_TO_BACKLOG,
    )

    if carry_over_to == "none":
        return []

    incomplete = Task.objects.filter(
        sprint_id=sprint.pk, status__in=_CARRY_OVER_INCOMPLETE_STATUSES, is_deleted=False
    )
    carried_ids: list[str] = []
    for task in incomplete:
        fields = ["sprint"]
        if carry_over_to == "backlog":
            task.sprint = None
            if task.status in _DECOMMITTED_ON_CARRY_OVER_TO_BACKLOG:
                task.status = TaskStatus.BACKLOG
                fields.append("status")
        else:
            task.sprint_id = carry_over_to
        _save(task, when, actor, fields)
        carried_ids.append(str(task.pk))
    return carried_ids


def _notify_carry_over(
    sprint: Sprint, carry_over_to: str, carried_task_ids: list[str], beat: _Beat
) -> None:
    """``task.moved_sprint`` to each carried task's assignee (#1470/ADR-0232),
    reusing the real grouping/copy helpers (``services._carried_tasks_by_assignee``
    / ``_carryover_row``) so a demo persona with several carried tasks gets the
    same one-row-per-assignee summary the live close produces.
    """
    if not carried_task_ids:
        return

    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications_batch
    from trueppm_api.apps.projects.services import (
        _carried_tasks_by_assignee,
        _carry_over_destination_label,
        _carryover_row,
    )

    actor_pk = getattr(beat.actor, "pk", None)
    by_assignee = _carried_tasks_by_assignee(carried_task_ids, actor_pk)
    if not by_assignee:
        return
    destination = _carry_over_destination_label(carry_over_to)
    rows = [
        _carryover_row(assignee_id, tasks, origin=sprint.name, destination=destination)
        for assignee_id, tasks in by_assignee.items()
    ]
    recipient_ids = list(by_assignee.keys())
    _dispatch_and_backdate(
        beat.when,
        event_type=NotificationEventType.TASK_MOVED_SPRINT.value,
        project_id=sprint.project_id,
        recipient_ids=recipient_ids,
        dispatch=lambda: create_event_notifications_batch(
            event_type=NotificationEventType.TASK_MOVED_SPRINT.value,
            project_id=sprint.project_id,
            rows=rows,
        ),
    )


def _apply_scope_inject(beat: _Beat, ctx: ReplayContext) -> None:
    """Record a mid-sprint scope injection as the real audit row (VoC/Alex).

    Creates the SprintScopeChange the drawer chip + Enterprise audit read, and
    flags the task pending — the same row the live ``record_sprint_scope_change``
    path writes — without firing the notify signal (suppressed during replay).

    The injected sprint is ``task.sprint`` whenever the task still holds one;
    see :func:`_injected_sprint` for the case a re-imported export creates,
    where it no longer does.
    """
    task = _resolve_task(ctx, beat.target)
    if task is None:
        return
    sprint = _injected_sprint(task, beat, ctx)
    if sprint is None:
        return
    scope = SprintScopeChange.objects.create(
        task=task,
        sprint=sprint,
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
    _notify_scope_inject(task, sprint, beat)


def _notify_scope_inject(task: Task, sprint: Sprint, beat: _Beat) -> None:
    """``sprint.membership_changed`` to the project lead cohort (#1946/ADR-0412),
    reusing the real recipient/copy helpers (``services._sprint_lead_recipient_ids``
    / ``_sprint_change_body``).

    Fires only when the injected sprint is currently ACTIVE, mirroring the live
    trigger's "a live-commitment change" gate — a scope change into a
    PLANNED/COMPLETED/CANCELLED sprint carries no accountability signal.
    """
    if sprint.state != SprintState.ACTIVE:
        return

    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications_batch
    from trueppm_api.apps.projects.services import _sprint_change_body, _sprint_lead_recipient_ids

    actor_pk = getattr(beat.actor, "pk", None)
    recipient_ids = _sprint_lead_recipient_ids(task.project_id, actor_pk)
    if not recipient_ids:
        return
    actor_name = getattr(beat.actor, "username", "") or "Someone"
    body = _sprint_change_body(
        actor_name,
        task.name,
        None,
        {"name": sprint.name},
        entered_active=True,
        left_active=False,
    )
    rows = [(rid, "Sprint scope changed", body, str(task.pk)) for rid in recipient_ids]
    _dispatch_and_backdate(
        beat.when,
        event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED.value,
        project_id=task.project_id,
        recipient_ids=recipient_ids,
        dispatch=lambda: create_event_notifications_batch(
            event_type=NotificationEventType.SPRINT_MEMBERSHIP_CHANGED.value,
            project_id=task.project_id,
            rows=rows,
        ),
    )


def _injected_sprint(task: Task, beat: _Beat, ctx: ReplayContext) -> Sprint | None:
    """The sprint a ``sprint.scope_inject`` beat injects ``task`` into.

    Normally read straight off ``task.sprint``: the documented contract (see
    ``validation._EVENT_TARGET_KIND``) is that the beat targets the task and its
    sprint is derived, matching ``record_sprint_scope_change(task, sprint)``,
    where every live call site links the task to the sprint first and records
    the audit row second. That derivation holds for every hand-authored seed,
    because a document declares a task's ``sprint`` statically before it can
    date an injection against it.

    It stops holding for a *re-imported export* (#3488). The exporter writes each
    task's ``sprint`` from its **current** membership, and a replayed sprint close
    now carries an unfinished task back to the backlog — so a still-PENDING
    ``SprintScopeChange``, which the exporter reconstructs as a
    ``sprint.scope_inject`` beat, can name a task that by export time holds no
    sprint at all. Born sprintless, the beat wrote no row, the re-export dropped
    the event, and the #616 byte-identical round trip failed.

    The fallback is a derivation, not a guess: an injection is by definition a
    link into the sprint that is *running at that moment* (ADR-0102 §4), so the
    beat's own instant identifies it — the one sprint in the task's project that
    replay has already activated, has not yet closed, and whose dates contain the
    beat. Ambiguity is refused rather than resolved: nothing in the schema stops a
    seed authoring two overlapping active sprints in one project, and picking one
    of them arbitrarily would file the audit row against the wrong sprint.
    """
    if task.sprint_id is not None:
        return task.sprint
    _, _, ref = beat.target.partition(":")
    project_slug, _, _ = ref.partition(":")
    day = beat.when.date()
    candidates = [
        sprint
        for key, sprint in ctx.sprints.items()
        if key[0] == project_slug
        and sprint.state == SprintState.ACTIVE
        and sprint.start_date <= day <= sprint.finish_date
    ]
    return candidates[0] if len(candidates) == 1 else None


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
    """Capture a baseline of the project's current task dates at the beat time.

    ``is_active`` (default False, #3495) collapses the real app's two-step
    capture-then-activate flow (``BaselineViewSet.perform_create`` +
    ``BaselineActivateView``) into one beat: when true, any baseline already
    active for the project is deactivated first — the same swap
    ``BaselineActivateView`` performs — so an authored rebaseline can supersede
    the one it replaces in a single timeline entry instead of leaving the
    project with two inactive baselines or an ``IntegrityError`` from
    ``unique_active_baseline_per_project``.
    """
    _, _, project_slug = beat.target.partition(":")
    project = ctx.projects.get(project_slug)
    if project is None:
        return
    is_active = bool(beat.data.get("is_active", False))
    if is_active:
        Baseline.objects.filter(project=project, is_active=True).update(is_active=False)
    baseline = Baseline.objects.create(
        project=project,
        name=beat.data.get("body") or f"Baseline {beat.when.date().isoformat()}",
        is_active=is_active,
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


# --- notifications -------------------------------------------------------------
#
# #3489: fresh samples produced notifications only from the mention fan-out
# above (`_fan_out_mentions`) — every other beat wrote through the ORM and
# never touched `notifications.services`, so a persona signing in saw an
# empty bell. The handlers above call the small `_notify_*` functions added
# alongside them; this section holds the cross-cutting backdating helper plus
# the two event types with no single triggering beat (a synthesized
# `task.stale` sweep and the sponsor's `program.health_digest`) and the final
# read/unread/archived/snoozed realism pass.


def _dispatch_and_backdate(
    when: datetime,
    *,
    event_type: str,
    project_id: Any,
    recipient_ids: Sequence[Any],
    dispatch: Callable[[], Any],
) -> None:
    """Run a ``notifications.services`` dispatch, then backdate the rows it wrote.

    Every dispatcher in that module stamps ``Notification.created_at`` via
    ``auto_now_add`` — always real wall-clock time, correct for the live
    product and wrong for a replayed beat. This captures the instant right
    before dispatch and rewrites every matching row to ``when`` afterward.

    The filter is scoped to ``(recipient, project, event_type, created_at >= t0)``.
    ``project_id`` is always a project this same import just created (or
    ``None`` for the one account-scoped digest, whose recipient is likewise a
    user this import just created), so the window can never reach a row a
    concurrent, unrelated import or request wrote in the same instant.
    """
    ids = [rid for rid in recipient_ids if rid is not None]
    if not ids:
        return

    from trueppm_api.apps.notifications.models import Notification

    t0 = timezone.now()
    dispatch()
    Notification.objects.filter(
        recipient_id__in=ids,
        project_id=project_id,
        event_type=event_type,
        created_at__gte=t0,
    ).update(created_at=when)


def _seed_notification_preferences(payload: dict[str, Any], ctx: ReplayContext) -> None:
    """Backfill every persona's default ``NotificationPreference`` rows, plus one
    ``ProjectNotificationPreference`` with a non-default quiet-hours window for
    the program's OWNER persona (#3489's "preference pages render seeded rows,
    not defaults" acceptance bar).
    """
    import datetime as _dt

    from trueppm_api.apps.notifications.models import ProjectNotificationPreference
    from trueppm_api.apps.notifications.services import get_or_create_default_preferences

    for user in ctx.users.values():
        if user is not None:
            get_or_create_default_preferences(user)

    owner_slug = next(
        (a["slug"] for a in payload.get("accounts", []) if a.get("role") == "OWNER"), None
    )
    owner = ctx.users.get(owner_slug) if owner_slug else None
    project = next(iter(ctx.projects.values()), None)
    if owner is None or project is None:
        return
    ProjectNotificationPreference.objects.update_or_create(
        project=project,
        user=owner,
        defaults={
            "quiet_hours_enabled": True,
            "quiet_hours_from": _dt.time(18, 0),
            "quiet_hours_until": _dt.time(8, 0),
        },
    )


def _synthesize_stale_notifications(ctx: ReplayContext) -> None:
    """Seed-local ``task.stale`` sweep (ADR-0200), scoped to this program's own tasks.

    Deliberately NOT ``notifications.services.create_stale_task_notifications``:
    that function scans every project in the install against the real wall
    clock, which would (a) sweep already-imported, unrelated samples and (b)
    stamp ``created_at`` at real import time rather than a date this replay
    can own. This mirrors its eligibility rule (every non-``COMPLETE`` status,
    an assignee set, untouched past the project's ``stale_task_threshold_days``)
    but dates each notification to when the task actually went stale.
    """
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import (
        DEFAULT_STALE_TASK_THRESHOLD_DAYS,
        create_event_notifications_batch,
    )

    for (project_slug, _wbs), task in ctx.tasks.items():
        if task.status == TaskStatus.COMPLETE or task.assignee_id is None:
            continue
        if task.status_changed_at is None:
            continue
        project = ctx.projects[project_slug]
        threshold = project.stale_task_threshold_days or DEFAULT_STALE_TASK_THRESHOLD_DAYS
        stale_since = task.status_changed_at.date() + timedelta(days=threshold)
        if stale_since > ctx.anchor:
            continue
        display_name = task.name if len(task.name) <= 200 else task.name[:200].rstrip() + "…"
        subject = f'"{display_name}" has gone stale'
        body = (
            f'Your task "{display_name}" has sat in the same status for more than '
            f"{threshold} days. If it is still active, move it forward; "
            f"otherwise update its status so the board reflects reality."
        )
        when = _aware_dt(ctx, stale_since, 8, 0)
        rows = [(task.assignee_id, subject, body, str(task.pk))]
        _dispatch_and_backdate(
            when,
            event_type=NotificationEventType.TASK_STALE.value,
            project_id=task.project_id,
            recipient_ids=[task.assignee_id],
            # functools.partial (not a lambda closing over the loop variables)
            # so each call is bound to THIS iteration's rows/project, not
            # whatever the loop variable holds by the time it runs.
            dispatch=functools.partial(
                create_event_notifications_batch,
                event_type=NotificationEventType.TASK_STALE.value,
                project_id=task.project_id,
                rows=rows,
            ),
        )


def _synthesize_program_digest(payload: dict[str, Any], ctx: ReplayContext) -> None:
    """One ``program.health_digest`` row for the sponsor persona — the seed's
    VIEWER account, the read-only executive role every sample carries exactly
    one of — dated to the most recent Sunday evening on/before the anchor,
    matching the real weekly send slot (ADR-0663).

    ``PROGRAM_HEALTH_DIGEST`` defaults OFF on both channels (a weekly send
    nobody asked for is exactly the noise the default guards against), so the
    sponsor is opted in explicitly here first — otherwise the dispatch below
    would silently create nothing.
    """
    accounts = payload.get("accounts", [])
    sponsor_slug = next((a["slug"] for a in accounts if a.get("role") == "VIEWER"), None)
    if sponsor_slug is None:
        return
    sponsor = ctx.users.get(sponsor_slug)
    if sponsor is None:
        return

    from trueppm_api.apps.notifications.digests import build_program_health_digest
    from trueppm_api.apps.notifications.models import (
        NotificationChannel,
        NotificationEventType,
        NotificationPreference,
    )
    from trueppm_api.apps.notifications.services import create_event_notifications

    # `_seed_notification_preferences` already backfilled the sponsor's default
    # rows earlier in `replay_timeline`; only the digest event's opt-in (below)
    # needs an explicit override.
    NotificationPreference.objects.update_or_create(
        user=sponsor,
        event_type=NotificationEventType.PROGRAM_HEALTH_DIGEST.value,
        channel=NotificationChannel.IN_APP.value,
        defaults={"enabled": True},
    )

    digest_day = ctx.anchor - timedelta(days=(ctx.anchor.weekday() + 1) % 7)
    when = _aware_dt(ctx, digest_day, 18, 0)
    subject, body = build_program_health_digest(sponsor, when)
    _dispatch_and_backdate(
        when,
        event_type=NotificationEventType.PROGRAM_HEALTH_DIGEST.value,
        project_id=None,
        recipient_ids=[sponsor.pk],
        dispatch=lambda: create_event_notifications(
            event_type=NotificationEventType.PROGRAM_HEALTH_DIGEST.value,
            recipient_ids=[sponsor.pk],
            subject=subject,
            body=body,
            project_id=None,
        ),
    )


def _apply_notification_realism(ctx: ReplayContext) -> None:
    """Age the freshly-emitted inbox into a mix of read / unread / archived /
    snoozed rows (#3489) — a batch created in one instant and left untouched
    would all read as equally fresh, which is its own tell.

    Rows backdated more than ~5 days before the anchor are marked read; a
    deterministic handful of those are archived; one still-unread row is
    snoozed into the demo's near future. Recent rows are left unread so the
    bell has something to show. Scoped to this program's own projects (plus,
    for the one account-scoped digest, this program's own users) so a
    re-import of a different sample can never be touched.
    """
    from trueppm_api.apps.notifications.models import Notification

    project_ids = [p.pk for p in ctx.projects.values()]
    user_ids = [u.pk for u in ctx.users.values() if u is not None]
    qs = Notification.objects.filter(
        Q(project_id__in=project_ids) | Q(project_id__isnull=True, recipient_id__in=user_ids)
    )

    read_cutoff = _aware(ctx, ctx.anchor - timedelta(days=5))
    qs.filter(created_at__lt=read_cutoff, is_read=False).update(
        is_read=True, read_at=F("created_at") + timedelta(hours=2)
    )

    archive_ids = list(
        qs.filter(is_read=True, is_archived=False)
        .order_by("created_at")
        .values_list("pk", flat=True)[:3]
    )
    if archive_ids:
        Notification.objects.filter(pk__in=archive_ids).update(is_archived=True)

    snooze_candidate = (
        qs.filter(is_read=False, is_archived=False, snoozed_until__isnull=True)
        .order_by("-created_at")
        .first()
    )
    if snooze_candidate is not None:
        Notification.objects.filter(pk=snooze_candidate.pk).update(
            snoozed_until=_aware_dt(ctx, ctx.anchor + timedelta(days=2), 9, 0)
        )


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


def _implied_carry_over_target(ctx: ReplayContext, sprint: Sprint) -> str:
    """Infer this close's carry-over destination from the seed's own timeline (#3488).

    The live close reads ``carry_over_to`` off the API request; a replayed
    close has none, so it is read off the seed's intent instead: the next
    sprint in the same project that the timeline actually runs (state ACTIVE
    or COMPLETED in ``ctx.final_sprint`` — i.e. it gets an authored or
    synthesized ``sprint.activate`` beat somewhere in the timeline) is where
    an incomplete task would land. No such sprint — this closing sprint is
    the project's last to actually run — falls back to ``"backlog"``, the
    same default ``POST .../close/`` uses.
    """
    project_slug, _ = _sprint_key(ctx, sprint)
    candidates = [
        (candidate.start_date, candidate.pk)
        for key, candidate in ctx.sprints.items()
        if key[0] == project_slug
        and candidate.pk != sprint.pk
        and candidate.start_date > sprint.finish_date
        and ctx.final_sprint.get(key, {}).get("state")
        in (SprintState.ACTIVE, SprintState.COMPLETED)
    ]
    if not candidates:
        return "backlog"
    candidates.sort(key=lambda c: c[0])
    return str(candidates[0][1])


def _named_actor(beat: _Beat, ctx: ReplayContext) -> Any:
    """The account a beat names, without the importing-owner fallback.

    ``_Beat.actor`` falls back to the importing owner, which is right for a
    status move or a comment but wrong for a fact whose attribution *is* the
    fact: an hour logged, a reaction, an acknowledgement. On the generic import
    path a pre-existing real account resolves to ``None`` (#1057); crediting its
    hours to the importer instead would fabricate the importer's own timesheet.
    """
    slug = beat.data.get("actor")
    return ctx.users.get(slug) if slug else None


def _comment_for(ctx: ReplayContext, target: str) -> TaskComment | None:
    _, _, slug = target.partition(":")
    return ctx.comments.get(slug)


def _apply_task_note(beat: _Beat, ctx: ReplayContext) -> None:
    """Append a dated ``TaskNote`` — the task's why/decision log (ADR-0143, #3492).

    ``decision`` is what the Decisions view reads. ``created_at`` is
    ``auto_now_add``, so it is backdated after insert like a comment.
    """
    task = _resolve_task(ctx, beat.target)
    body = beat.data.get("body")
    if task is None or not body:
        return
    note = TaskNote.objects.create(
        task=task,
        author=beat.actor,
        body=body,
        pinned=bool(beat.data.get("pinned", False)),
        decision=bool(beat.data.get("decision", False)),
    )
    TaskNote.objects.filter(pk=note.pk).update(created_at=beat.when)


def _apply_task_react(beat: _Beat, ctx: ReplayContext) -> None:
    """Add a reaction to a slugged comment (ADR-0075 §A.4). Never notifies."""
    comment = _comment_for(ctx, beat.target)
    user = _named_actor(beat, ctx)
    emoji = beat.data.get("emoji")
    if comment is None or user is None or not emoji:
        return
    reaction, created = CommentReaction.objects.get_or_create(
        comment=comment, user=user, emoji=emoji
    )
    if created:
        CommentReaction.objects.filter(pk=reaction.pk).update(created_at=beat.when)


def _apply_task_ack(beat: _Beat, ctx: ReplayContext) -> None:
    """Acknowledge a slugged comment — "I saw this / I'm on it" (ADR-0075 §A.3)."""
    comment = _comment_for(ctx, beat.target)
    user = _named_actor(beat, ctx)
    if comment is None or user is None:
        return
    ack, created = CommentAcknowledgement.objects.get_or_create(comment=comment, user=user)
    if created:
        CommentAcknowledgement.objects.filter(pk=ack.pk).update(created_at=beat.when)


def _apply_time_log(beat: _Beat, ctx: ReplayContext) -> None:
    """Write a ``TimeEntry`` dated to the beat (ADR-0185, #3490).

    Never forward-dated: a beat after the anchor is dropped, because logged time
    records work that happened and the demo's "today" is the anchor. Validation
    already rejects a relative ``A+N`` beat; this also covers an ISO literal.
    """
    task = _resolve_task(ctx, beat.target)
    user = _named_actor(beat, ctx)
    minutes = beat.data.get("minutes")
    if task is None or user is None or not minutes:
        return
    entry_date = beat.when.date()
    if entry_date > ctx.anchor:
        return
    entry = TimeEntry.objects.create(
        task=task,
        user=user,
        minutes=minutes,
        entry_date=entry_date,
        note=beat.data.get("note", ""),
        source=beat.data.get("source", "manual"),
    )
    TimeEntry.objects.filter(pk=entry.pk).update(created_at=beat.when)


_HANDLERS = {
    "task.note": _apply_task_note,
    "task.react": _apply_task_react,
    "task.ack": _apply_task_ack,
    "time.log": _apply_time_log,
    _TASK_STATUS_ACTION: _apply_task_status,
    "task.assign": _apply_task_assign,
    "task.estimate": _apply_task_estimate,
    "task.points": _apply_task_points,
    "task.ac_met": _apply_task_ac_met,
    "task.block": _apply_task_block,
    "task.unblock": _apply_task_unblock,
    "task.comment": _apply_task_comment,
    "sprint.activate": _apply_sprint_activate,
    "sprint.close": _apply_sprint_close,
    "sprint.scope_inject": _apply_scope_inject,
    "sprint.scope_resolve": _apply_scope_resolve,
    "risk.status": _apply_risk_status,
    "risk.note": _apply_risk_note,
    "baseline.capture": _apply_baseline_capture,
    "retro.action": _apply_retro_action,
    "retro.promote": _apply_retro_promote,
}
