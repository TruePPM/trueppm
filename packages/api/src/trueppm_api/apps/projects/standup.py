"""Daily standup walk-the-board aggregator (ADR-0166, #1278).

A read-only, project-scoped aggregator that assembles the *per-person walk* a Scrum
Master drives the Daily Scrum from: for each teammate on the active sprint, the cards
they finished since the last working day, the cards they have in flight today, and
their current blockers. No new model, no migration, no write path — every fact already
has a durable home:

* current task state (status, assignee, blocker flag) — ``Task`` rows in the active
  sprint;
* "done since the last working day" — ``HistoricalTask`` (django-simple-history)
  status-to-COMPLETE transitions inside a **calendar-aware** window (a Monday standup
  includes Friday's completions), with already-complete carried cards excluded;
* aging — ``status_changed_at`` dwell measured against the per-column
  ``age_threshold_days`` (ADR-0164), falling back to the #992 3-day stalled policy.

This is the *current-state, person-by-person* lens. It deliberately does **not**
duplicate the team-wide *what-changed* delta feed (``sprint_daily_delta`` / ADR-0121);
the two are complementary standup surfaces sharing the same history/blocker primitives.

Privacy (ADR-0104 / ADR-0124): the walk groups by **assignee**, which is already
visible on every board card, so it exposes no new change-actor attribution. The
private ``blocked_reason`` free text is **never** serialized — only the routable
``blocker_type`` and the blocked age travel, so the shared standup screen never leaks
a contributor's reason.
"""

from __future__ import annotations

import datetime as _dt
from typing import TYPE_CHECKING, Any

from django.utils import timezone

from trueppm_api.apps.projects.utilization import (
    _DEFAULT_WORKING_DAYS,
    _exception_ranges,
    _is_working_day,
)

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project, Sprint

# Bound the backward scan for the last working day so a degenerate calendar (no
# working day in its bitmask, or exceptions blanketing the window) can't spin to the
# date floor. Mirrors ``utilization._MAX_FLOOR_SCAN_DAYS``.
_MAX_BACK_SCAN_DAYS = 366

# Fallback dwell threshold (full days) when a column has no configured
# ``age_threshold_days`` — the server-owned #992 stalled policy, kept consistent with
# ``TaskSerializer.get_is_stalled`` so the walk's aging flag matches the board card.
_DEFAULT_AGE_THRESHOLD_DAYS = 3

# Statuses that count as "in progress today" (issue #1278). Done is derived from the
# completion window; blockers from the blocked flag — both independent of this set.
_IN_PROGRESS_STATUSES = frozenset({"IN_PROGRESS", "REVIEW"})


def standup_walk(project: Project) -> dict[str, Any]:
    """Assemble the active sprint's standup walk for a project (ADR-0166).

    Args:
        project: the board's project.

    Returns:
        When the project runs a sprint cadence with an ACTIVE sprint::

            {
              "active": True,
              "sprint": {"id", "name", "goal", "start_date", "finish_date"},
              "generated_at": <iso8601>,
              "window_since": <iso8601>,   # calendar-aware "done since" boundary
              "walk": [
                {
                  "assignee": {"id", "name"} | None,   # None == the Unassigned bucket (last)
                  "done":        [<card>],   # became COMPLETE within the window (not carried)
                  "in_progress": [<card>],   # current IN_PROGRESS / REVIEW, not blocked
                  "blockers":    [<card>],   # current blocked flag (blocked_reason non-empty)
                }
              ]
            }

        Otherwise an honest empty payload (HTTP 200, not 404) so the client renders an
        empty state rather than an error::

            {"active": False, "reason": "continuous_cadence" | "no_active_sprint",
             "sprint": None, "generated_at": <iso8601>, "window_since": None, "walk": []}

        Each ``<card>`` is ``{id, name, status, story_points, dwell_days, aging,
        blocker_type | None, blocked_since | None}`` — ``blocked_reason`` is never
        included.
    """
    from trueppm_api.apps.projects.models import (
        BoardCadence,
        Sprint,
        SprintState,
        Task,
        TaskStatus,
    )

    now = timezone.now()

    # The standup walks a sprint commitment; a continuous-flow board has no sprint to
    # walk (ADR-0164). Honest-empty rather than 404 so the UI shows a calm empty state.
    if project.board_cadence != BoardCadence.SPRINT:
        return _empty(now, "continuous_cadence")

    sprint = (
        Sprint.objects.filter(project_id=project.pk, state=SprintState.ACTIVE, is_deleted=False)
        .order_by("-activated_at")
        .first()
    )
    if sprint is None:
        return _empty(now, "no_active_sprint")

    window_since = _last_working_day_start(project, sprint, now)

    tasks = list(
        Task.objects.filter(sprint_id=sprint.pk, is_deleted=False).select_related("assignee")
    )
    thresholds = _column_age_thresholds(project)
    done_ids = _completed_in_window(project, [t.pk for t in tasks], window_since, now)

    # Group assignees in first-seen order, then sort by name with the Unassigned
    # bucket forced last (a stable walk order the SM can rely on round to round).
    buckets: dict[Any, dict[str, Any]] = {}
    for task in tasks:
        key = task.assignee_id
        entry = buckets.get(key)
        if entry is None:
            entry = buckets[key] = {
                "assignee": (
                    {"id": str(task.assignee_id), "name": _user_label(task.assignee)}
                    if task.assignee_id is not None
                    else None
                ),
                "done": [],
                "in_progress": [],
                "blockers": [],
            }
        card = _card(task, now, thresholds)
        # Mutually exclusive buckets, highest-signal first: a finished card is "done"
        # even if its blocked flag lingered; an unfinished blocked card is a blocker
        # (not also "in progress") so the room hears the impediment once.
        if task.pk in done_ids and task.status == TaskStatus.COMPLETE:
            entry["done"].append(card)
        elif _is_blocked(task):
            entry["blockers"].append(card)
        elif task.status in _IN_PROGRESS_STATUSES:
            entry["in_progress"].append(card)
        # else: assigned but not-started/backlog and not done/blocked — the teammate
        # still appears in the walk (their turn) with empty buckets.

    walk = sorted(
        buckets.values(),
        key=lambda e: (e["assignee"] is None, (e["assignee"] or {}).get("name", "").lower()),
    )

    return {
        "active": True,
        "sprint": {
            "id": str(sprint.pk),
            "name": sprint.name,
            "goal": sprint.goal,
            "start_date": sprint.start_date.isoformat(),
            "finish_date": sprint.finish_date.isoformat(),
        },
        "generated_at": now.isoformat(),
        "window_since": window_since.isoformat(),
        "walk": walk,
    }


def _empty(now: _dt.datetime, reason: str) -> dict[str, Any]:
    return {
        "active": False,
        "reason": reason,
        "sprint": None,
        "generated_at": now.isoformat(),
        "window_since": None,
        "walk": [],
    }


def _is_blocked(task: Any) -> bool:
    """The blocked flag of record (ADR-0124): a non-empty ``blocked_reason``.

    ``blocked_reason`` is read here ONLY as a boolean gate — its text never reaches the
    response (``_card`` exposes ``blocker_type`` + ``blocked_since`` only). Do not switch
    this detection to ``blocker_type`` (a blocker may be raised with reason but no type),
    and never add the reason text to the serialized card: that free text is private to
    the assignee + @-mentioned, and the standup is a shared screen (ADR-0104 / ADR-0124).
    """
    return bool((task.blocked_reason or "").strip())


def _last_working_day_start(project: Project, sprint: Sprint, now: _dt.datetime) -> _dt.datetime:
    """Start-of-day of the last working day before today, floored at sprint activation.

    Calendar-aware (ADR-0166 / Alex's constraint): "done since yesterday" must reach
    back to the previous *working* day, not a flat 24h, or a Monday standup silently
    drops Friday's completions. Reverse-scans from yesterday with the project calendar's
    weekday bitmask + exception ranges (falling back to Mon–Fri when no calendar is
    configured), then clamps to ``sprint.activated_at`` so completions from before the
    sprint started are never counted.
    """
    cal = getattr(project, "calendar", None)
    mask = cal.working_days if cal is not None else _DEFAULT_WORKING_DAYS
    ranges = _exception_ranges(cal.exceptions) if cal is not None else []

    today = timezone.localdate(now)
    day = today - _dt.timedelta(days=1)
    for _ in range(_MAX_BACK_SCAN_DAYS):
        if _is_working_day(mask, ranges, day):
            break
        day -= _dt.timedelta(days=1)

    start = timezone.make_aware(
        _dt.datetime.combine(day, _dt.time.min), timezone.get_current_timezone()
    )
    activated = getattr(sprint, "activated_at", None)
    if activated is not None and activated > start:
        return activated
    return start


def _completed_in_window(
    project: Project, task_ids: list[Any], window_since: _dt.datetime, now: _dt.datetime
) -> set[Any]:
    """Ids of the given tasks whose status *became* COMPLETE inside the window.

    Two bounded queries, no N+1: the set of candidate tasks with a COMPLETE history
    row in ``[window_since, now]``, minus those already COMPLETE *before* the window
    (carried-over cards finished in a prior standup). ``project_id`` is included so the
    scan rides the ``(project_id, history_date)`` composite index (ADR-0160 Amdt B).
    """
    if not task_ids:
        return set()
    from trueppm_api.apps.projects.models import Task, TaskStatus

    HistoricalTask = Task.history.model

    completed_in = set(
        HistoricalTask.objects.filter(
            project_id=project.pk,
            id__in=task_ids,
            status=TaskStatus.COMPLETE,
            history_date__gte=window_since,
            history_date__lte=now,
        ).values_list("id", flat=True)
    )
    if not completed_in:
        return set()
    completed_before = set(
        HistoricalTask.objects.filter(
            project_id=project.pk,
            id__in=completed_in,
            status=TaskStatus.COMPLETE,
            history_date__lt=window_since,
        ).values_list("id", flat=True)
    )
    return completed_in - completed_before


def _column_age_thresholds(project: Project) -> dict[str, Any]:
    """Map status → configured ``age_threshold_days`` (ADR-0164), if a config exists."""
    cfg = getattr(project, "board_column_config", None)
    if cfg is None:
        return {}
    return {
        col.get("status"): col.get("age_threshold_days")
        for col in cfg.columns
        if isinstance(col, dict) and col.get("status")
    }


def _card(task: Any, now: _dt.datetime, thresholds: dict[str, Any]) -> dict[str, Any]:
    """Serialize one card for the walk — never includes the private ``blocked_reason``."""
    dwell = (now - task.status_changed_at).days if task.status_changed_at is not None else None
    threshold = thresholds.get(task.status)
    effective = threshold if threshold is not None else _DEFAULT_AGE_THRESHOLD_DAYS
    # Matches the board card's stalled verdict (#992): a complete card is never aging.
    aging = dwell is not None and task.percent_complete < 100 and dwell > effective
    return {
        "id": str(task.pk),
        "name": task.name,
        "status": task.status,
        "story_points": task.story_points,
        "dwell_days": dwell,
        "aging": aging,
        "blocker_type": task.blocker_type or None,
        "blocked_since": task.blocked_since.isoformat() if task.blocked_since else None,
    }


def _user_label(user: Any) -> str:
    """Human label for an assignee — full name when set, else username."""
    if user is None:
        return ""
    full = (user.get_full_name() or "").strip() if hasattr(user, "get_full_name") else ""
    return full or getattr(user, "username", "") or ""
