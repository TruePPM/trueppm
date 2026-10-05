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

from trueppm_api.apps.timetracking.models import ActiveTimer, TimeEntry, TimeEntrySource

if TYPE_CHECKING:
    from django.contrib.auth.models import User as _User

    from trueppm_api.apps.projects.models import Task


def _timer_max_minutes() -> int:
    """The stale-timer ceiling (settings ``TIMETRACKING_TIMER_MAX_MINUTES``, default 600)."""
    return int(getattr(settings, "TIMETRACKING_TIMER_MAX_MINUTES", 600))


def _member_can_still_log_time(user: _User, project_id: Any) -> bool:
    """Role >= Member on ``project_id`` right now, with no ``request`` in hand (#4318).

    Mirrors ``can_user_log_time`` (``access/permissions.py``), which is the
    authoritative predicate everywhere a request is available — but this service
    layer only ever has a ``user``, so it re-derives the role directly from a live
    (non-soft-deleted) ``ProjectMembership`` row rather than through the
    request-cached helper. A boolean, not a raise: both ``start_timer``'s
    second-start and ``stop_timer`` *decide* what to do with a timer whose access
    has lapsed (discard it) rather than refuse the request outright — see each
    function's docstring for why discard, not a 403, is the answer both places.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role

    role = (
        ProjectMembership.objects.filter(project_id=project_id, user=user, is_deleted=False)
        .values_list("role", flat=True)
        .first()
    )
    return role is not None and role >= Role.MEMBER


def _project_is_archived_now(project_id: Any) -> bool:
    """Direct, request-less archived check (#4318).

    Mirrors ``_is_project_archived`` (``access/permissions.py``), which is
    request-cached and unavailable here for the same reason
    :func:`_member_can_still_log_time` re-derives role directly instead of calling
    the request-cached ``_membership_role``.
    """
    from trueppm_api.apps.projects.models import Project

    return Project.objects.filter(pk=project_id, is_archived=True).exists()


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

    **The existing timer is re-checked before it is finalized (#4318).** A member who
    starts a timer on project A, loses write access there (archived, removed, or
    demoted below Member), and then legitimately starts a *new* timer on project B
    must not have project A's stale timer silently logged as a ``TimeEntry`` — that
    would create a write on a project they can no longer write to, through a path
    (starting work elsewhere) that has nothing to do with project A. So this applies
    the same **discard** semantics the ``ProjectMembership`` revocation hook uses
    (``access/signals.py``): if project A is archived, or the caller can no longer
    log time there, the existing ``ActiveTimer`` row is simply deleted, with no
    ``TimeEntry`` created. The common case (membership still live) is unaffected —
    the prior timer is finalized exactly as before. This deliberately never *raises*:
    a stale timer on an unrelated, inaccessible project must not block a legitimate
    new start on a project the caller can still write to.
    """
    finalized: TimeEntry | None = None
    existing = (
        ActiveTimer.objects.select_for_update().select_related("task").filter(user=user).first()
    )
    if existing is not None:
        existing_project_id = existing.task.project_id
        if _project_is_archived_now(existing_project_id) or not _member_can_still_log_time(
            user, existing_project_id
        ):
            existing.delete()
        else:
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

    Returns ``None`` when no timer is running (or when the timer is discarded —
    see below) so the caller can respond ``409`` — a duplicate stop is a no-op,
    never a double-log or a 500. ``select_for_update`` makes concurrent stops
    serialize: the loser finds no row and gets ``None``.

    **Re-checks the archived-project gate and live Member+ role before finalizing
    (#4318).** This is defence-in-depth, not the primary control: a ``ProjectMembership``
    revocation (removal, or demotion below Member) deletes the user's ``ActiveTimer`` rows
    outright via the ``pre_save`` eviction hook in ``access/signals.py`` — the discard
    decision made for #4318 — so in the common revoked-member case there is no row left
    here to stop, and the caller already gets the existing ``409``. What this still catches:
    an **archived** project, which does not touch membership and so never fires that hook,
    and any ``ActiveTimer`` that predates it.

    **Discard, never raise, on either check — round 2 of #4318.** The first pass raised
    ``PermissionDenied`` (403) here, which was itself a bug: raising left the
    ``ActiveTimer`` row in place, so a timer on a now-archived project could **never**
    be stopped — every retry re-hit the same 403, and the web client
    (``useActiveTimer.ts``) restores the optimistically-cleared timer into its cache on
    any non-409 error, so the chip reappeared and the user was stuck retrying forever.
    Deleting the row and returning ``None`` instead routes through the exact same,
    already-handled path as "no timer is running": the view answers the ordinary
    ``409``, which the client already clears silently, no restore and no error toast.
    This is the same resolution ``start_timer``'s second-start discard and the
    ``ProjectMembership`` revocation hook both already use — one semantics (discard a
    timer whose access has lapsed) applied everywhere it can arise, rather than two
    different outcomes for the same underlying situation. Deliberately does **not**
    raise after the delete, even just to signal the refusal for observability: this
    function runs inside ``@transaction.atomic`` under ``ATOMIC_REQUESTS``, and DRF's
    exception handler calls ``set_rollback()`` for any raised ``APIException`` — which
    would roll back the very delete meant to free the caller from this state.
    """
    timer = ActiveTimer.objects.select_for_update().select_related("task").filter(user=user).first()
    if timer is None:
        return None
    project_id = timer.task.project_id
    if _project_is_archived_now(project_id) or not _member_can_still_log_time(user, project_id):
        timer.delete()
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
