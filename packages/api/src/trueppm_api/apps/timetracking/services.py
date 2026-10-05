"""Service layer for time tracking (ADR-0185 Durable Execution §4).

Every operation here is a **synchronous** DB transaction with no async side effect:
no Celery ``.delay()``, no ``broadcast_board_event()``, no CPM recompute. A time entry
never touches ``Task`` dates, so it cannot trigger a schedule recalculation. There is
nothing to dead-letter and nothing to broadcast (ADR-0185 §5) — the negative is
deliberate.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from trueppm_api.apps.access.permissions import CanLogTime, assert_project_not_archived
from trueppm_api.apps.timetracking.models import ActiveTimer, TimeEntry, TimeEntrySource

if TYPE_CHECKING:
    from django.contrib.auth.models import User as _User

    from trueppm_api.apps.projects.models import Task


def _timer_max_minutes() -> int:
    """The stale-timer ceiling (settings ``TIMETRACKING_TIMER_MAX_MINUTES``, default 600)."""
    return int(getattr(settings, "TIMETRACKING_TIMER_MAX_MINUTES", 600))


def _assert_live_member_can_log_time(user: _User, project_id: Any) -> None:
    """Re-check role >= Member on ``project_id`` with no ``request`` in hand (#4318).

    Mirrors ``can_user_log_time`` (``access/permissions.py``), which is the
    authoritative predicate everywhere a request is available — but ``stop_timer``
    runs from a service with only a ``user``, so it re-derives the role directly
    from a live (non-soft-deleted) ``ProjectMembership`` row rather than through the
    request-cached helper. Raises the identical ``CanLogTime.message`` so the 403
    body is indistinguishable from the view-layer refusal on the sibling write
    paths — one contract, enforced from two call sites that cannot share a request.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role

    role = (
        ProjectMembership.objects.filter(project_id=project_id, user=user, is_deleted=False)
        .values_list("role", flat=True)
        .first()
    )
    if role is None or role < Role.MEMBER:
        raise PermissionDenied(CanLogTime.message)


def log_time(
    *,
    user: _User,
    task: Task,
    minutes: int,
    entry_date: date | None = None,
    note: str = "",
    source: str = TimeEntrySource.MANUAL,
) -> TimeEntry:
    """Create a logged :class:`TimeEntry`.

    ``user`` is the server-set owner (never client-supplied); the caller resolves it
    from ``request.user``. ``entry_date`` defaults to the caller's local "today"
    (``timezone.localdate()``), matching ``/me/work``'s today bucket.
    """
    return TimeEntry.objects.create(
        user=user,
        task=task,
        minutes=minutes,
        entry_date=entry_date or timezone.localdate(),
        note=note,
        source=source,
    )


@transaction.atomic
def start_timer(*, user: _User, task: Task, note: str = "") -> tuple[ActiveTimer, TimeEntry | None]:
    """Start a running timer for ``user``.

    Second-start (#1415): if a timer is already running it is atomically stopped and
    logged first, and the finalized :class:`TimeEntry` is returned alongside the new
    timer (the UI surfaces it in the undo toast). The ``OneToOneField(user)`` guarantees
    a single live timer, so this can never leave two rows. ``select_for_update`` locks
    the existing timer row so a concurrent double-start serializes rather than racing.
    """
    finalized: TimeEntry | None = None
    existing = ActiveTimer.objects.select_for_update().filter(user=user).first()
    if existing is not None:
        finalized = _finalize(existing)
    timer = ActiveTimer.objects.create(
        user=user,
        task=task,
        started_at=timezone.now(),
        note=note,
    )
    return timer, finalized


@transaction.atomic
def stop_timer(*, user: _User) -> TimeEntry | None:
    """Stop ``user``'s running timer, finalize it into a :class:`TimeEntry`, delete the row.

    Returns ``None`` when no timer is running so the caller can respond ``409`` — a
    duplicate stop is a no-op, never a double-log or a 500. ``select_for_update`` makes
    concurrent stops serialize: the loser finds no row and gets ``None``.

    **Re-checks the archived-project gate and live Member+ role before finalizing
    (#4318).** This is defence-in-depth, not the primary control: a ``ProjectMembership``
    revocation (removal, or demotion below Member) deletes the user's ``ActiveTimer`` rows
    outright via the ``pre_save`` eviction hook in ``access/signals.py`` — the discard
    decision made for #4318 — so in the common revoked-member case there is no row left
    here to stop, and the caller already gets the existing ``409``. What this still catches:
    an **archived** project, which does not touch membership and so never fires that hook,
    and any ``ActiveTimer`` that predates it. Both checks raise ``PermissionDenied`` (403)
    rather than silently discarding, so a timer this layer should not finalize is refused,
    never fabricated into a ``TimeEntry``.
    """
    timer = ActiveTimer.objects.select_for_update().select_related("task").filter(user=user).first()
    if timer is None:
        return None
    assert_project_not_archived(timer.task.project_id)
    _assert_live_member_can_log_time(user, timer.task.project_id)
    return _finalize(timer)


def _finalize(timer: ActiveTimer) -> TimeEntry:
    """Convert a running timer into a logged ``TimeEntry`` and delete the timer row.

    Elapsed seconds are rounded to the nearest minute (floored at 1 so a sub-minute
    timer still logs something) and **capped** at the stale ceiling so a timer left
    running over a weekend logs the ceiling, not thousands of minutes. The cap is also
    clamped to the model's 1440-minute maximum to preserve the row invariant even if the
    ceiling is misconfigured above 24 h. The entry dates to ``localdate(started_at)`` so
    a timer crossing midnight is attributed to the day the work started. Must be called
    inside a transaction (``start_timer`` / ``stop_timer`` provide it).
    """
    elapsed_seconds = (timezone.now() - timer.started_at).total_seconds()
    minutes = max(1, round(elapsed_seconds / 60))
    minutes = min(minutes, _timer_max_minutes(), 1440)
    entry = TimeEntry.objects.create(
        user_id=timer.user_id,
        task_id=timer.task_id,
        minutes=minutes,
        entry_date=timezone.localdate(timer.started_at),
        note=timer.note,
        source=TimeEntrySource.TIMER,
    )
    timer.delete()
    return entry
