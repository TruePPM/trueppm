"""Notification category derivation (ADR-0216 §3).

A notification's *category* is derived from its ``event_type`` (and, for
mention-sourced rows, from the presence of a ``mention`` FK) — there is no
stored column, so there is nothing to backfill or keep in sync. This module is
the single source of truth for the mapping, consumed by BOTH the serializer's
read-only ``category`` field and the queryset ``?category=`` filter so the two
can never drift. A test iterates every ``NotificationEventType`` and asserts each
maps to a category, so a newly added event can't silently fall through.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .models import NotificationEventType

if TYPE_CHECKING:
    from .models import Notification

# ---------------------------------------------------------------------------
# Category keys — stable API values surfaced by the serializer and accepted by
# the ?category= filter.
# ---------------------------------------------------------------------------

CATEGORY_MENTIONS = "mentions"
CATEGORY_TASKS = "tasks"
CATEGORY_SIGNALS = "signals"
CATEGORY_PROJECT = "project"

CATEGORIES: tuple[str, ...] = (
    CATEGORY_MENTIONS,
    CATEGORY_TASKS,
    CATEGORY_SIGNALS,
    CATEGORY_PROJECT,
)

# event_type → category. Exhaustive over NotificationEventType (enforced by
# test_categories). Grouping per ADR-0216 §3:
#   mentions — a person addressing you
#   tasks    — events about a task you own / are on
#   signals  — schedule-health signals and team-visibility proposals
#   project  — project-lifecycle events
_EVENT_TYPE_CATEGORY: dict[str, str] = {
    NotificationEventType.MENTION_INDIVIDUAL.value: CATEGORY_MENTIONS,
    NotificationEventType.MENTION_GROUP.value: CATEGORY_MENTIONS,
    NotificationEventType.TASK_ASSIGNED.value: CATEGORY_TASKS,
    NotificationEventType.TASK_DUE_DATE_CHANGED.value: CATEGORY_TASKS,
    NotificationEventType.COMMENT_ON_MY_TASK.value: CATEGORY_TASKS,
    NotificationEventType.TASK_BLOCKED.value: CATEGORY_TASKS,
    NotificationEventType.TASK_STALE.value: CATEGORY_TASKS,
    NotificationEventType.SPRINT_TASK_RESCHEDULED.value: CATEGORY_TASKS,
    NotificationEventType.MILESTONE_FORECAST_SHIFTED.value: CATEGORY_SIGNALS,
    NotificationEventType.SIGNAL_CEILING_PROPOSAL_OPENED.value: CATEGORY_SIGNALS,
    NotificationEventType.SIGNAL_CEILING_PROPOSAL_RESOLVED.value: CATEGORY_SIGNALS,
    NotificationEventType.PROJECT_DELETED.value: CATEGORY_PROJECT,
}


def category_for(notification_or_event_type: Notification | str) -> str:
    """Return the category for a ``Notification`` or a raw ``event_type`` string.

    Mention-sourced rows (a ``mention`` FK set with a blank ``event_type``) are
    ``mentions``; every event-sourced row derives from its ``event_type``. An
    unrecognized event_type falls back to ``mentions`` (the inbox's original
    surface) so the derivation never raises inside a serializer render path.
    """
    if isinstance(notification_or_event_type, str):
        event_type = notification_or_event_type
        has_mention = False
    else:
        event_type = notification_or_event_type.event_type or ""
        has_mention = notification_or_event_type.mention_id is not None
    if not event_type and has_mention:
        return CATEGORY_MENTIONS
    return _EVENT_TYPE_CATEGORY.get(event_type, CATEGORY_MENTIONS)


def event_types_for_category(category: str) -> frozenset[str]:
    """Return the ``event_type`` values that map to ``category``.

    Used by the queryset ``?category=`` filter to translate a category back into
    the set of event types it covers. Note the ``mentions`` category ALSO matches
    mention-sourced rows (blank event_type, ``mention`` FK set); that orthogonal
    condition is applied by the viewset, not here. An unknown category returns an
    empty set, so the filter matches nothing rather than everything.
    """
    return frozenset(
        event_type for event_type, cat in _EVENT_TYPE_CATEGORY.items() if cat == category
    )
