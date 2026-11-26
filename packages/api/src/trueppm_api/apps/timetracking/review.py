"""Timesheet review: the reporting line and the week's review transitions (ADR-1495).

One reviewer per person — their direct manager, set by a workspace admin — may
approve a submitted week or return it with a reason. That is the whole OSS surface:
no chains, delegation, escalation or bulk rules (those are Enterprise, ADR-1495 §6).

Authority is evaluated **at action time** from the current reporting line, never
stored at submit: if a person's manager changes while a week is submitted, the new
manager reviews it and the old one loses access the moment the line changes.

Every transition runs in a transaction holding ``FOR UPDATE`` on the submission row,
writes one append-only :class:`TimesheetTransition`, and fires the
``timesheet_review_changed`` extension signal. Refusals raise before any write.
"""

from __future__ import annotations

import hashlib
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any

from django.db import connection, transaction
from django.http import Http404
from django.utils import timezone
from rest_framework.exceptions import APIException, ValidationError

from trueppm_api.apps.timetracking.models import (
    ReportingLine,
    ReportingLineChange,
    TimeEntry,
    TimesheetStatus,
    TimesheetSubmission,
    TimesheetTransition,
)
from trueppm_api.apps.timetracking.signals import timesheet_review_changed
from trueppm_api.core.extension_signals import dispatch_extension_signal

if TYPE_CHECKING:
    from django.contrib.auth.models import User as _User

#: Longest reporting chain walked when refusing a cycle. Far above any real org depth;
#: it only bounds the walk if the table is already corrupt.
_MAX_CHAIN = 200

#: Transaction-scoped advisory lock key for reporting-line writes, so two concurrent
#: edits (A -> B and B -> A) cannot each pass the cycle check and commit a loop.
_REPORTING_LINE_LOCK = 4811_0001


class TimesheetStateConflict(APIException):
    """The week is not in a state that allows the requested transition.

    The body is ``{"detail": ..., "code": ...}``: the code is the documented, stable
    value a client branches on (``docs/api/errors.md``). DRF's handler sends only
    ``detail`` for a string detail, so the code is put in the body here.
    """

    status_code = 409
    default_detail = "This timesheet week cannot make that transition."
    default_code = "timesheet_state_conflict"

    def __init__(self, detail: str | None = None, code: str | None = None) -> None:
        code = code or self.default_code
        super().__init__({"detail": detail or self.default_detail, "code": code}, code)


#: ``Notification.subject`` is a 255-character column; a display name is user-set.
_SUBJECT_MAX = 255


def week_digest(user_id: Any, week_start: date) -> str:
    """sha256 of the user's live entries in the week — what a reviewer is approving."""
    rows = (
        TimeEntry.objects.filter(
            user_id=user_id,
            is_deleted=False,
            # engine-boundary-ok: calendar bookkeeping, not schedule math
            entry_date__range=(week_start, week_start + timedelta(days=6)),
        )
        .order_by("id")
        .values_list("id", "task_id", "entry_date", "minutes", "category")
    )
    h = hashlib.sha256()
    for r in rows:
        h.update("|".join(str(v) for v in r).encode())
        h.update(b"\n")
    return h.hexdigest()


# --- reporting line ---------------------------------------------------------------


def manager_id_for(user_id: Any) -> int | None:
    """The user's current direct manager's id, or ``None``."""
    return (
        ReportingLine.objects.filter(user_id=user_id).values_list("manager_id", flat=True).first()
    )


def is_direct_report(manager: _User, user_id: Any) -> bool:
    """True when ``manager`` is ``user_id``'s current manager and not the same person."""
    if str(manager.pk) == str(user_id):
        return False
    return manager_id_for(user_id) == manager.pk


@transaction.atomic
def set_manager(*, actor: _User, user: _User, manager: _User | None) -> ReportingLine | None:
    """Set (or clear, with ``manager=None``) ``user``'s manager. Admin-only at the view.

    Refuses ``manager == user`` and any assignment that would close a cycle anywhere
    up the chain (``manager`` already reports, directly or not, to ``user``): a cycle
    is how two people end up approving each other's time. Every effective change is
    written to :class:`ReportingLineChange`. This is also the write seam an Enterprise
    directory sync uses, so synced lines get the same checks and audit.
    """
    with connection.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", [_REPORTING_LINE_LOCK])
    current = ReportingLine.objects.filter(user=user).select_for_update().first()
    previous_id = current.manager_id if current is not None else None
    if manager is not None:
        if manager.pk == user.pk:
            raise ValidationError({"manager": "A person cannot be their own manager."})
        if not manager.is_active:
            raise ValidationError({"manager": "The manager must be an active user."})
        cursor_id: Any = manager.pk
        for _ in range(_MAX_CHAIN):
            cursor_id = manager_id_for(cursor_id)
            if cursor_id is None:
                break
            if cursor_id == user.pk:
                raise ValidationError(
                    {"manager": "That manager already reports to this person; cycles are refused."}
                )
    new_id = manager.pk if manager is not None else None
    if previous_id == new_id:
        return current
    ReportingLineChange.objects.create(
        user=user, previous_manager_id=previous_id, new_manager_id=new_id, actor=actor
    )
    if manager is None:
        if current is not None:
            current.delete()
        return None
    if current is None:
        return ReportingLine.objects.create(user=user, manager=manager, updated_by=actor)
    current.manager = manager
    current.updated_by = actor
    current.save(update_fields=["manager", "updated_by", "updated_at"])
    return current


# --- transitions ------------------------------------------------------------------


def _record(sub: TimesheetSubmission, *, actor: _User, from_status: str, reason: str = "") -> None:
    TimesheetTransition.objects.create(
        submission=sub, actor=actor, from_status=from_status, to_status=sub.status, reason=reason
    )
    dispatch_extension_signal(
        timesheet_review_changed,
        sender=TimesheetSubmission,
        submission_id=str(sub.pk),
        user_id=sub.user_id,
        week_start=sub.week_start.isoformat(),
        from_status=from_status,
        to_status=sub.status,
        actor_id=actor.pk,
    )


def _notify(*, recipient_id: Any, event_type: str, subject: str, body: str) -> None:
    """Write an in-app Inbox row, if the recipient's preference allows it.

    No email: the body may carry the return reason. The recipient's in-app toggle for
    the event type is honored the same way every other event is (it defaults on), and
    the subject is cut to the column width because it embeds a user-set display name.
    """
    from trueppm_api.apps.notifications.models import Notification
    from trueppm_api.apps.notifications.services import event_in_app_enabled

    if recipient_id is None or not event_in_app_enabled(recipient_id, event_type):
        return
    if len(subject) > _SUBJECT_MAX:
        subject = subject[: _SUBJECT_MAX - 1] + "\u2026"
    Notification.objects.create(
        recipient_id=recipient_id, event_type=event_type, subject=subject, body=body
    )


def _display(user: Any) -> str:
    full = (user.get_full_name() or "").strip()
    return full or user.get_username()


@transaction.atomic
def submit_week(*, user: _User, week_start: date) -> TimesheetSubmission:
    """Submit (or resubmit) the caller's own week. Refused (409) once approved."""
    from trueppm_api.apps.notifications.models import NotificationEventType

    sub = (
        TimesheetSubmission.objects.select_for_update()
        .filter(user=user, week_start=week_start)
        .first()
    )
    if sub is not None and sub.status == TimesheetStatus.APPROVED:
        raise TimesheetStateConflict("This week is approved; it can no longer be resubmitted.")
    now = timezone.now()
    digest = week_digest(user.pk, week_start)
    if sub is None:
        sub = TimesheetSubmission.objects.create(
            user=user,
            week_start=week_start,
            submitted_at=now,
            status=TimesheetStatus.SUBMITTED,
            entries_digest=digest,
        )
        _record(sub, actor=user, from_status=TimesheetStatus.DRAFT)
        return sub
    from_status = sub.status
    # A returned week the person withdrew to draft before fixing it is still a
    # resubmission of a returned week: withdraw keeps ``reviewer`` (only a review sets
    # it, and a resubmit clears it), so a draft carrying one was returned last. The
    # notice goes to the *current* manager: authority is evaluated now, so a reviewer
    # who has since lost the line is not told about a week they can no longer open.
    was_returned = from_status == TimesheetStatus.RETURNED or (
        from_status == TimesheetStatus.DRAFT and sub.reviewer_id is not None
    )
    sub.status = TimesheetStatus.SUBMITTED
    sub.submitted_at = now
    sub.entries_digest = digest
    sub.return_reason = ""
    sub.reviewer = None
    sub.reviewed_at = None
    sub.save()
    if from_status != TimesheetStatus.SUBMITTED:
        _record(sub, actor=user, from_status=from_status)
    if was_returned:
        _notify(
            recipient_id=manager_id_for(user.pk),
            event_type=NotificationEventType.TIMESHEET_RESUBMITTED,
            subject=f"{_display(user)} resubmitted the week of {week_start.isoformat()}",
            body="",
        )
    return sub


@transaction.atomic
def withdraw_week(*, user: _User, week_start: date) -> None:
    """Withdraw the caller's own submitted or returned week back to draft.

    Idempotent for a week that was never submitted. Refused (409) once approved:
    there is no reopen in 0.5 (ADR-1495 §3).
    """
    sub = (
        TimesheetSubmission.objects.select_for_update()
        .filter(user=user, week_start=week_start)
        .first()
    )
    if sub is None or sub.status == TimesheetStatus.DRAFT:
        return
    if sub.status == TimesheetStatus.APPROVED:
        raise TimesheetStateConflict("This week is approved; it cannot be withdrawn.")
    from_status = sub.status
    sub.status = TimesheetStatus.DRAFT
    # ``reviewer`` is kept on purpose: it marks a withdrawn *returned* week, so the
    # resubmit still notifies the manager (see :func:`submit_week`).
    sub.return_reason = ""
    sub.save()
    _record(sub, actor=user, from_status=from_status)


def _reviewable(reviewer: _User, user_id: Any, week_start: date) -> TimesheetSubmission:
    """Lock and return a direct report's submission, or 404 for anyone else's.

    A non-report and a missing id answer the same 404 (no existence oracle), and a
    reviewer can never resolve their own week here, whatever the reporting line says.
    """
    if not is_direct_report(reviewer, user_id):
        raise Http404
    sub = (
        TimesheetSubmission.objects.select_for_update()
        .filter(user_id=user_id, week_start=week_start)
        .first()
    )
    if sub is None or sub.status != TimesheetStatus.SUBMITTED:
        raise TimesheetStateConflict("Only a submitted week can be reviewed.")
    return sub


@transaction.atomic
def approve_week(*, reviewer: _User, user_id: Any, week_start: date) -> TimesheetSubmission:
    """Approve a direct report's submitted week, if its entries are what was submitted."""
    sub = _reviewable(reviewer, user_id, week_start)
    if week_digest(user_id, week_start) != sub.entries_digest:
        raise TimesheetStateConflict(
            "The week's entries changed after it was submitted; ask for a resubmit.",
            code="timesheet_changed_since_submit",
        )
    sub.status = TimesheetStatus.APPROVED
    sub.reviewer = reviewer
    sub.reviewed_at = timezone.now()
    sub.save()
    _record(sub, actor=reviewer, from_status=TimesheetStatus.SUBMITTED)
    return sub


@transaction.atomic
def return_week(
    *, reviewer: _User, user_id: Any, week_start: date, reason: str
) -> TimesheetSubmission:
    """Return a direct report's submitted week with a required reason."""
    from trueppm_api.apps.notifications.models import NotificationEventType

    reason = (reason or "").strip()
    if not reason:
        raise ValidationError({"reason": "A reason is required to return a week."})
    sub = _reviewable(reviewer, user_id, week_start)
    sub.status = TimesheetStatus.RETURNED
    sub.reviewer = reviewer
    sub.reviewed_at = timezone.now()
    sub.return_reason = reason
    sub.save()
    _record(sub, actor=reviewer, from_status=TimesheetStatus.SUBMITTED, reason=reason)
    _notify(
        recipient_id=sub.user_id,
        event_type=NotificationEventType.TIMESHEET_RETURNED,
        subject=f"{_display(reviewer)} returned your week of {week_start.isoformat()}",
        body=reason,
    )
    return sub
