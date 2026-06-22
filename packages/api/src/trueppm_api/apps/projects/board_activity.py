"""Board-level activity feed aggregator (ADR-0160, #325).

A read-only aggregator that joins existing change-history sources into one
time-ordered, board-scoped feed of card mutations. No new model, no migration —
every event already has a durable home:

* ``HistoricalTask`` (django-simple-history on ``Task``) — field changes diffed
  against the same task's immediately-prior row over a curated board-relevant
  allowlist (``task_created`` / ``task_updated`` / ``task_deleted``), plus the
  ``sprint`` delta surfaced as a first-class ``entered_sprint`` / ``exited_sprint``
  / ``moved_sprint`` event (the #325 AC's mid-sprint scope events).
* ``TaskComment`` creates — ``comment_added``.

The feed is built in Python (the ``TaskHistoryView`` precedent paginates a Python
list) but **bounded**: each source is queried for events older than the ``until``
cursor, capped at ``OVERFETCH * limit`` rows, and the three lists are merge-sorted
by timestamp DESC. Pagination is keyset-on-timestamp via ``until`` (the client passes
the returned ``next_until`` back) — no offset rebuild, no cursor-on-non-unique-leading
trap. ``HistoricalTask`` diffs are computed within the fetched batch (no per-row
``prev_record`` query → no N+1); the documented edge is that a change whose prior row
fell outside the batch surfaces with an empty ``changes`` list.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import TYPE_CHECKING, Any

from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.access.models import Role

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project

# Board-relevant Task fields surfaced as field-change deltas. CPM outputs and sync
# internals are already excluded from HistoricalTask; this is a further curation to
# the fields a board reader cares about (not the full per-task drawer history).
# ``sprint`` is deliberately NOT here — a sprint move is its own first-class event.
_BOARD_DIFF_FIELDS: tuple[str, ...] = (
    "name",
    "status",
    "percent_complete",
    "story_points",
    "remaining_points",
    "assignee_id",
)

# Cost/budget delta fields hidden from below-MEMBER readers (ADR-0160 RBAC). There
# are no cost fields on Task yet (intentionally absent until the cost model #73);
# the set is empty today so the gate is a no-op, but it is the live seam the moment
# cost fields land — the AC ("Viewer doesn't see cost-field deltas") is satisfied
# structurally, not deferred.
_COST_FIELDS: frozenset[str] = frozenset()

_TASK_EVENT_TYPES: frozenset[str] = frozenset({"task_created", "task_updated", "task_deleted"})
_SPRINT_EVENT_TYPES: frozenset[str] = frozenset({"entered_sprint", "exited_sprint", "moved_sprint"})
_COMMENT_EVENT_TYPES: frozenset[str] = frozenset({"comment_added"})
EVENT_TYPES: frozenset[str] = _TASK_EVENT_TYPES | _SPRINT_EVENT_TYPES | _COMMENT_EVENT_TYPES

_OVERFETCH = 4  # rows fetched per source = OVERFETCH * limit (bounded scan)
DEFAULT_LIMIT = 50
MAX_LIMIT = 100


def _scalar(value: Any) -> str | None:
    return str(value) if value is not None else None


def build_board_activity(
    project: Project,
    *,
    until: datetime | None = None,
    since: datetime | None = None,
    actor_id: Any = None,
    event_types: set[str] | None = None,
    limit: int = DEFAULT_LIMIT,
    role: int | None = None,
) -> dict[str, Any]:
    """Build one page of the board activity feed (ADR-0160).

    Args:
        project: the board's project.
        until: keyset cursor — return events strictly older than this (default now).
        since: optional lower time bound (inclusive).
        actor_id: optional filter to one actor (user id).
        event_types: optional set of ``EVENT_TYPES`` to include (default all).
        limit: page size (clamped to ``[1, MAX_LIMIT]``).
        role: the requester's project ``Role`` ordinal — drives cost-field gating.

    Returns:
        ``{"results": [event, ...], "next_until": <iso str | None>}`` where each event
        is ``{id, event_type, actor, actor_id, timestamp, task_id, task_name,
        changes: [{field, old, new}], sprint_id, scope_change_status}``
        (``scope_change_status`` is the SprintScopeChange accept-gate status on
        ``entered_sprint`` events, else null). ``next_until`` is the oldest
        returned timestamp (pass it back as ``until`` for the next page), or ``None``
        when the window is exhausted.
    """
    limit = max(1, min(int(limit), MAX_LIMIT))
    if until is None:
        until = timezone.now()
    wanted = event_types if event_types else EVENT_TYPES
    cap = _OVERFETCH * limit

    events: list[dict[str, Any]] = []
    if wanted & (_TASK_EVENT_TYPES | _SPRINT_EVENT_TYPES):
        events.extend(_history_events(project, until, since, wanted, cap, role))
    if wanted & _COMMENT_EVENT_TYPES:
        events.extend(_comment_events(project, until, since, cap))

    # Actor filtering is applied AFTER the per-source fetch, not pushed into the
    # HistoricalTask query: filtering the source rows by actor would drop the
    # immediately-prior row a diff needs (a status change by A diffs against B's
    # prior save), leaving the actor's change with no computable delta.
    if actor_id is not None:
        wanted_actor = str(actor_id)
        events = [e for e in events if e["actor_id"] == wanted_actor]

    # Merge-sort DESC by timestamp; the stable id breaks exact-timestamp ties so the
    # ordering is deterministic across requests.
    events.sort(key=lambda e: (e["timestamp"], e["id"]), reverse=True)

    page = events[:limit]
    next_until: str | None = None
    if len(events) > limit and page:
        # More rows beyond this page existed in the fetched window — hand the client
        # the oldest returned timestamp to resume from (keyset).
        next_until = page[-1]["timestamp"].isoformat()

    return {
        "results": [_serialize_event(e) for e in page],
        "next_until": next_until,
    }


def _history_events(
    project: Project,
    until: datetime,
    since: datetime | None,
    wanted: set[str] | frozenset[str],
    cap: int,
    role: int | None,
) -> list[dict[str, Any]]:
    """Field-change + sprint-transition events from HistoricalTask (bounded batch)."""
    from trueppm_api.apps.projects.models import Task

    HistoricalTask = Task.history.model

    qs = HistoricalTask.objects.filter(project_id=project.pk, history_date__lt=until)
    if since is not None:
        qs = qs.filter(history_date__gte=since)
    rows = list(qs.order_by("-history_date")[:cap])

    # Group newest-first per task so each row can diff against the next-older row in
    # the batch without a per-row prev_record query (no N+1).
    by_task: dict[Any, list[Any]] = defaultdict(list)
    for row in rows:
        by_task[row.id].append(row)

    # Resolve the user + sprint references that appear, in two bulk queries.
    user_ids = {r.history_user_id for r in rows if r.history_user_id is not None}
    user_ids |= {r.assignee_id for r in rows if r.assignee_id is not None}
    sprint_ids = {r.sprint_id for r in rows if r.sprint_id is not None}
    user_names = _user_name_map(user_ids)
    sprint_names = _sprint_name_map(sprint_ids)

    hide_cost = role is not None and role < Role.MEMBER
    events: list[dict[str, Any]] = []
    for group in by_task.values():
        for i, rec in enumerate(group):
            older = group[i + 1] if i + 1 < len(group) else None
            events.extend(
                _events_from_record(rec, older, wanted, user_names, sprint_names, hide_cost)
            )
    _attach_scope_change_status(events)
    return events


def _attach_scope_change_status(events: list[dict[str, Any]]) -> None:
    """Enrich ``entered_sprint`` events with the ``SprintScopeChange`` accept-gate status.

    A *post-activation* mid-sprint injection records a ``SprintScopeChange`` (ADR-0102)
    whose ``status`` (``pending``/``accepted``/``rejected``) is the accept-gate outcome for
    the *same* "task entered sprint X" fact the ``HistoricalTask`` sprint delta already
    yields — which is why ADR-0160 sources the event from history (not also
    ``SprintScopeChange``) to avoid double-counting, and deferred surfacing the *status* to
    this enrichment (ADR-0160 Amendment B3, #1264).

    Stamps ``scope_change_status`` onto each ``entered_sprint`` event via **one batched**
    query keyed by ``(task_id, sprint_id)`` — index-covered by ``scope_change_task_sprint_idx``
    — leaving it ``None`` for a pre-activation entry (no scope-change row). The status is not
    cost-gated, so it is Viewer-readable like the rest of the feed. Mutates ``events`` in
    place; a no-op when the batch holds no ``entered_sprint`` event.
    """
    keys = {
        (e["task_id"], e["sprint_id"])
        for e in events
        if e["event_type"] == "entered_sprint" and e.get("sprint_id")
    }
    if not keys:
        return

    from trueppm_api.apps.projects.models import SprintScopeChange

    status_map: dict[tuple[str, str], str] = {}
    # Ordered ascending so the latest row wins on the rare re-injection of one task into the
    # same sprint (multiple rows per (task, sprint)); the cross-product filter overfetches
    # at most distinct-tasks × distinct-sprints rows, but only exact pairs are read back.
    rows = (
        SprintScopeChange.objects.filter(
            task_id__in={k[0] for k in keys},
            sprint_id__in={k[1] for k in keys},
        )
        .order_by("added_at")
        .values("task_id", "sprint_id", "status")
    )
    for row in rows:
        status_map[(str(row["task_id"]), str(row["sprint_id"]))] = row["status"]

    for e in events:
        if e["event_type"] == "entered_sprint":
            # entered_sprint always carries a non-null sprint_id (see _sprint_event).
            e["scope_change_status"] = status_map.get((e["task_id"], e["sprint_id"]))


def _events_from_record(
    rec: Any,
    older: Any,
    wanted: set[str] | frozenset[str],
    user_names: dict[Any, str],
    sprint_names: dict[Any, str],
    hide_cost: bool,
) -> list[dict[str, Any]]:
    """Derive the 0..2 board events a single HistoricalTask row contributes."""
    out: list[dict[str, Any]] = []
    actor_id = rec.history_user_id
    base = {
        "actor": user_names.get(actor_id),
        "actor_id": str(actor_id) if actor_id is not None else None,
        "timestamp": rec.history_date,
        "task_id": str(rec.id),
        "task_name": rec.name,
    }

    # django-simple-history history_type: "+" created, "~" changed, "-" deleted.
    if rec.history_type == "+":
        if "task_created" in wanted:
            out.append(
                {
                    **base,
                    "id": f"hist:{rec.history_id}",
                    "event_type": "task_created",
                    "changes": [],
                }
            )
        return out
    if rec.history_type == "-":
        if "task_deleted" in wanted:
            out.append(
                {
                    **base,
                    "id": f"hist:{rec.history_id}",
                    "event_type": "task_deleted",
                    "changes": [],
                }
            )
        return out

    # A "~" (changed) row. With no prior-in-batch we cannot diff, so it is dropped
    # (the documented deep-page edge — a board reader sees no change without a delta).
    if older is None:
        return out

    # Sprint transition is its own first-class event (held out of the field diff).
    if wanted & _SPRINT_EVENT_TYPES:
        sprint_event = _sprint_event(rec, older, base, sprint_names)
        if sprint_event is not None:
            out.append(sprint_event)

    if "task_updated" in wanted:
        changes = _field_changes(rec, older, user_names, hide_cost)
        if changes:
            out.append(
                {
                    **base,
                    "id": f"hist:{rec.history_id}",
                    "event_type": "task_updated",
                    "changes": changes,
                }
            )
    return out


def _field_changes(
    rec: Any, older: Any, user_names: dict[Any, str], hide_cost: bool
) -> list[dict[str, Any]]:
    """Board-allowlist field deltas between two HistoricalTask rows."""
    changes: list[dict[str, Any]] = []
    for field in _BOARD_DIFF_FIELDS:
        if hide_cost and field in _COST_FIELDS:
            continue
        new_val = getattr(rec, field, None)
        old_val = getattr(older, field, None)
        if new_val == old_val:
            continue
        if field == "assignee_id":
            changes.append(
                {
                    "field": "assignee",
                    "old": user_names.get(old_val) if old_val is not None else None,
                    "new": user_names.get(new_val) if new_val is not None else None,
                }
            )
        else:
            changes.append({"field": field, "old": _scalar(old_val), "new": _scalar(new_val)})
    return changes


def _sprint_event(
    rec: Any, older: Any, base: dict[str, Any], sprint_names: dict[Any, str]
) -> dict[str, Any] | None:
    """An entered/exited/moved-sprint event from a sprint_id delta, or None."""
    new_sprint = rec.sprint_id
    old_sprint = older.sprint_id
    if new_sprint == old_sprint:
        return None
    if old_sprint is None:
        event_type = "entered_sprint"
    elif new_sprint is None:
        event_type = "exited_sprint"
    else:
        event_type = "moved_sprint"
    return {
        **base,
        "id": f"hist:{rec.history_id}:sprint",
        "event_type": event_type,
        "sprint_id": str(new_sprint) if new_sprint is not None else None,
        "changes": [
            {
                "field": "sprint",
                "old": sprint_names.get(old_sprint) if old_sprint is not None else None,
                "new": sprint_names.get(new_sprint) if new_sprint is not None else None,
            }
        ],
    }


def _comment_events(
    project: Project,
    until: datetime,
    since: datetime | None,
    cap: int,
) -> list[dict[str, Any]]:
    """``comment_added`` events from TaskComment creates (bounded batch)."""
    from trueppm_api.apps.projects.models import TaskComment

    qs = TaskComment.objects.filter(
        task__project_id=project.pk, is_deleted=False, created_at__lt=until
    )
    if since is not None:
        qs = qs.filter(created_at__gte=since)
    rows = list(qs.select_related("author", "task").order_by("-created_at")[:cap])
    return [
        {
            "id": f"comment:{comment.pk}",
            "event_type": "comment_added",
            "actor": comment.author.username if comment.author else None,
            "actor_id": str(comment.author_id) if comment.author_id else None,
            "timestamp": comment.created_at,
            "task_id": str(comment.task_id),
            "task_name": comment.task.name,
            "changes": [],
        }
        for comment in rows
    ]


def _user_name_map(user_ids: set[Any]) -> dict[Any, str]:
    if not user_ids:
        return {}
    user_model = get_user_model()
    return dict(user_model.objects.filter(pk__in=user_ids).values_list("pk", "username"))


def _sprint_name_map(sprint_ids: set[Any]) -> dict[Any, str]:
    if not sprint_ids:
        return {}
    from trueppm_api.apps.projects.models import Sprint

    return dict(Sprint.objects.filter(pk__in=sprint_ids).values_list("pk", "name"))


def _serialize_event(event: dict[str, Any]) -> dict[str, Any]:
    """Stamp the timestamp as an ISO string for the response (kept native for sort)."""
    out = dict(event)
    ts = out["timestamp"]
    out["timestamp"] = ts.isoformat() if isinstance(ts, datetime) else ts
    out.setdefault("sprint_id", None)
    # Present on every row (null off ``entered_sprint``) so the response shape is uniform —
    # same contract as ``sprint_id`` (ADR-0160 Amendment B3, #1264).
    out.setdefault("scope_change_status", None)
    return out
