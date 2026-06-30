"""Service layer for time tracking (ADR-0185 Durable Execution §4).

Every operation here is a **synchronous** DB transaction with no async side effect:
no Celery ``.delay()``, no ``broadcast_board_event()``, no CPM recompute. A time entry
never touches ``Task`` dates, so it cannot trigger a schedule recalculation. There is
nothing to dead-letter and nothing to broadcast (ADR-0185 §5) — the negative is
deliberate.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.timetracking.models import ActiveTimer, TimeEntry, TimeEntrySource

if TYPE_CHECKING:
    from django.contrib.auth.models import User as _User

    from trueppm_api.apps.projects.models import Task


def _timer_max_minutes() -> int:
    """The stale-timer ceiling (settings ``TIMETRACKING_TIMER_MAX_MINUTES``, default 600)."""
    return int(getattr(settings, "TIMETRACKING_TIMER_MAX_MINUTES", 600))


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
    """
    timer = ActiveTimer.objects.select_for_update().filter(user=user).first()
    if timer is None:
        return None
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
