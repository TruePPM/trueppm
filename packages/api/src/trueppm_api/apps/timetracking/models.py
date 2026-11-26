"""Time-tracking domain models — logged effort and the running timer (ADR-0185 §2).

``TimeEntry`` is the durable, sync-eligible fact; ``ActiveTimer`` is transient live
state. The split is deliberate (ADR-0185 §2): a ticking timer is derived state, not a
logged fact, so it is *not* a ``VersionedModel`` and a stopped timer is hard-deleted,
not soft-deleted. Nothing here broadcasts — a time entry mutates no shared board state
(ADR-0185 §5).
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models, transaction
from django.db.models import F, Q
from django.utils import timezone
from rest_framework.exceptions import APIException

from trueppm_api.apps.projects.models import VersionedModel


class TimeEntrySource(models.TextChoices):
    """Provenance of a logged entry — drives the UI/undo affordance."""

    MANUAL = "manual", "Manual"
    TIMER = "timer", "Timer"


class TimeEntryCategory(models.TextChoices):
    """What kind of time an entry is (ADR-1495 §4).

    ``task`` is project work and is the only category costed to a project. ``pto``,
    ``admin`` and ``training`` are recorded against a task for now (``TimeEntry.task``
    stays required in 0.5) but are excluded from project actual cost — PTO is never
    cost, and admin/training time is not project work.
    """

    TASK = "task", "Task work"
    PTO = "pto", "Paid time off"
    ADMIN = "admin", "Admin"
    TRAINING = "training", "Training"


#: Categories that count toward a project's actual cost. Everything else is recorded
#: time that is not project work (ADR-1495 §4).
COSTED_CATEGORIES: frozenset[str] = frozenset({TimeEntryCategory.TASK})


class TimesheetStatus(models.TextChoices):
    """The review states of a timesheet week (ADR-1495 §2)."""

    DRAFT = "draft", "Draft"
    SUBMITTED = "submitted", "Submitted"
    APPROVED = "approved", "Approved"
    RETURNED = "returned", "Returned"


class TimesheetWeekLocked(APIException):
    """A write into a week whose timesheet has been approved (ADR-1495 §3).

    Raised from :meth:`TimeEntry.save`, so every ORM write path that goes through
    ``save()`` (REST create/edit/delete, timer stop, the serializer) refuses it with
    one shared guard. ``bulk_create`` and ``QuerySet.update`` bypass ``save()``; the
    write-path enumeration test pins the callers that may use them.
    """

    status_code = 409
    default_detail = "This week's timesheet is approved and is read-only."
    default_code = "timesheet_week_approved"

    def __init__(self, detail: str | None = None, code: str | None = None) -> None:
        # ``code`` in the body, not only on the ErrorDetail: DRF's handler sends just
        # ``detail`` for a string, and the code is the documented value (errors.md).
        code = code or self.default_code
        super().__init__({"detail": detail or self.default_detail, "code": code}, code)


def week_monday(d: date) -> date:
    """The Monday of ``d``'s ISO week — the timesheet submission key (ADR-0224)."""
    # engine-boundary-ok: calendar bookkeeping, not schedule math
    return d - timedelta(days=d.weekday())


def week_is_approved(user_id: Any, d: date, *, lock: bool = False) -> bool:
    """True when ``user_id``'s timesheet for the week containing ``d`` is approved.

    ``lock=True`` takes ``FOR UPDATE`` on the week's submission row (caller must be in
    a transaction). The entry-write guard locks so it serializes against approve,
    which holds the same row lock while it re-hashes the entry set: whichever commits
    first wins, and the other sees it (an edit is refused, or approve answers 409).
    """
    qs = TimesheetSubmission.objects.filter(user_id=user_id, week_start=week_monday(d))
    if lock:
        qs = qs.select_for_update()
    status = qs.values_list("status", flat=True).first()
    return status == TimesheetStatus.APPROVED


class TimeEntry(VersionedModel):
    """A contributor's logged effort against a task (ADR-0185 §2).

    The durable, sync-eligible record of *where a user's hours went*. The row is owned
    by the logger: ``user`` is server-set to ``request.user`` and is never client-
    supplied, so the entry is IDOR-safe by construction. Duration is canonical integer
    ``minutes`` (1..1440) to avoid the decimal-hours rounding drift the constraint
    exists to prevent — the client formats ``h:mm``.

    There is **no** uniqueness constraint on ``(user, task, entry_date)``: a contributor
    may legitimately log multiple entries against the same task on the same day (two
    sessions). The weekly grid aggregates them.
    """

    task = models.ForeignKey(
        "projects.Task",
        on_delete=models.CASCADE,
        related_name="time_entries",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="time_entries",
    )
    minutes = models.PositiveIntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(1440)],
    )
    entry_date = models.DateField(default=timezone.localdate)
    note = models.CharField(max_length=500, blank=True)
    source = models.CharField(
        max_length=10,
        choices=TimeEntrySource.choices,
        default=TimeEntrySource.MANUAL,
    )
    # ADR-1495 §4. Existing rows are project work, so the column's default is the
    # backfill: every pre-0.5 entry reads as ``task``.
    category = models.CharField(
        max_length=10,
        choices=TimeEntryCategory.choices,
        default=TimeEntryCategory.TASK,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    # Soft-delete accountability (issue #1888). The base ``VersionedModel.soft_delete()``
    # only flips ``is_deleted``, so a removed entry left no trace of *when* or *by whom*
    # — and the task activity stream, which filtered ``is_deleted=False``, silently
    # dropped its ``time_logged`` event too. That is an EVM/billing integrity gap: logged
    # hours could be revised or removed with no record. These fields let the stream
    # synthesize a ``time_deleted`` event, mirroring the ``TaskComment``/``TaskAttachment``
    # soft-delete precedent. ``deleted_by`` is the acting user (always the owner — entries
    # are self-scoped) and SET_NULLs on account deletion, so the event actor goes null.
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="deleted_time_entries",
    )

    class Meta:
        db_table = "timetracking_time_entry"
        indexes = [
            # Header today/week rollup + weekly grid read.
            models.Index(fields=["user", "entry_date"]),
            # Grid cell (task, date) upsert/aggregate.
            models.Index(fields=["user", "task", "entry_date"]),
            # Per-project sync delta pull (task → server_version).
            models.Index(fields=["task", "server_version"]),
            models.Index(fields=["task", "sync_seq", "id"]),
        ]

    def __str__(self) -> str:
        return f"TimeEntry({self.user_id}, {self.minutes}m, {self.entry_date})"

    def save(self, *args: Any, **kwargs: Any) -> None:
        """Refuse any write that lands in, or moves an entry out of, an approved week.

        The approved-week lock lives here rather than in a view (ADR-1495 §3) because
        entries are written by several paths — the REST create and edit, soft delete,
        and timer stop — and a lock that one of them skips is no lock. Moving an entry
        *out* of an approved week is checked too (against the stored ``entry_date``),
        or an edit could empty an approved week one row at a time.
        """
        with transaction.atomic():
            weeks = {self.entry_date}
            if not self._state.adding and self.pk is not None:
                stored = (
                    TimeEntry.objects.filter(pk=self.pk)
                    .values_list("entry_date", flat=True)
                    .first()
                )
                if stored is not None:
                    weeks.add(stored)
            for d in weeks:
                if isinstance(d, date) and week_is_approved(self.user_id, d, lock=True):
                    raise TimesheetWeekLocked()
            super().save(*args, **kwargs)

    def soft_delete(self, *, actor: Any | None = None) -> None:
        """Stamp ``deleted_at``/``deleted_by`` before delegating to the base soft-delete.

        Mirrors ``Dependency.soft_delete()``'s stamping (issue #1888): the base
        ``VersionedModel.soft_delete()`` persists the whole row, so setting these two
        fields first writes them in the same UPDATE that flips ``is_deleted``. Without
        the timestamp the activity stream could not order or surface the ``time_deleted``
        event, so a removed entry vanished from the ``time_logged`` feed with no trace.
        """
        self.deleted_at = timezone.now()
        self.deleted_by = actor
        super().soft_delete()


class ActiveTimer(models.Model):
    """The running stopwatch — transient live state, deliberately NOT versioned (ADR-0185 §2).

    Elapsed time is derived (``now - started_at``); the row carries no logged fact, so
    syncing it as versioned WatermelonDB rows would churn for a value the client
    recomputes locally. The ``OneToOneField(user)`` is the singleton guarantee — a user
    has at most one running timer at the DB level (cleaner than a partial unique on a
    status flag). ``stop`` finalizes it into a ``TimeEntry`` and *deletes* this row
    (no tombstone to sync); it is recovered after a reload via ``GET /me/timer/``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="active_timer",
    )
    task = models.ForeignKey(
        "projects.Task",
        on_delete=models.CASCADE,
        related_name="+",
    )
    started_at = models.DateTimeField()
    note = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "timetracking_active_timer"

    def __str__(self) -> str:
        return f"ActiveTimer({self.user_id} -> {self.task_id})"


class TimesheetSubmission(models.Model):
    """A contributor's "I marked this week done" signal — a per-user-per-week marker (ADR-0224).

    Deliberately **not** a :class:`VersionedModel` (mirrors :class:`ActiveTimer`): submitting a
    week is an inherently *online* action on a web-first surface, and the row carries no field a
    client edits offline, so WatermelonDB version/tombstone machinery would churn sync for a
    boolean-shaped signal. It is the whole submission state machine 0.4 ships — no approver, no
    lock, no return; the 0.5 approval epic (#100) reads or extends this row's existence +
    ``submitted_at`` as its "Submitted" signal without migrating :class:`TimeEntry`.

    ``week_start`` is canonicalized to the ISO Monday by the view before write, so the
    ``(user, week_start)`` uniqueness cannot fragment into off-by-a-day rows. Un-submit hard-
    deletes the row (no tombstone — not sync-eligible).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="timesheet_submissions",
    )
    week_start = models.DateField()
    submitted_at = models.DateTimeField()
    # Review state (ADR-1495 §2). A missing row and ``draft`` both mean "not
    # submitted"; ``draft`` is what a withdrawn week becomes, so the transition log
    # (which hangs off this row) survives a withdraw. Existing 0.4 rows are markers
    # of a submitted week, so the column default is their backfill.
    status = models.CharField(
        max_length=10,
        choices=TimesheetStatus.choices,
        default=TimesheetStatus.SUBMITTED,
    )
    # Set server-side to ``request.user`` on approve/return — never client-supplied.
    reviewer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reviewed_timesheets",
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    # Confidential personal text: serialized only to the submitter and the reviewer.
    return_reason = models.TextField(blank=True, default="")
    # sha256 of the week's live entry set at submit time. Approve recomputes it and
    # answers 409 on a mismatch, so a reviewer can only approve what was submitted.
    entries_digest = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        db_table = "timetracking_timesheet_submission"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "week_start"],
                name="uniq_timesheet_submission_user_week",
            ),
            models.CheckConstraint(
                condition=~Q(status=TimesheetStatus.RETURNED) | ~Q(return_reason=""),
                name="timesheet_returned_has_reason",
            ),
        ]

    def __str__(self) -> str:
        return f"TimesheetSubmission({self.user_id}, week of {self.week_start})"


class TimesheetTransition(models.Model):
    """One append-only step in a week's review history (ADR-1495 §2).

    Never updated or deleted by application code: the "last state" columns on
    :class:`TimesheetSubmission` are a cache of the newest row here. ``actor`` is the
    authenticated caller; it SET_NULLs on account deletion so history outlives users.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    submission = models.ForeignKey(
        TimesheetSubmission, on_delete=models.CASCADE, related_name="transitions"
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="+",
    )
    from_status = models.CharField(max_length=10, choices=TimesheetStatus.choices)
    to_status = models.CharField(max_length=10, choices=TimesheetStatus.choices)
    reason = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "timetracking_timesheet_transition"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["submission", "created_at"])]

    def __str__(self) -> str:
        return f"TimesheetTransition({self.from_status} -> {self.to_status})"


class ReportingLine(models.Model):
    """A person's single direct manager, who reviews their timesheet (ADR-1495 §1).

    Deliberately its own row rather than a field on ``UserProfile`` (written by the
    owner through ``PATCH /auth/me/profile/``, the self-grantable shape) or on
    ``Resource`` (project staffing rows: a person may have none or several). Written
    only by a workspace admin. ``manager != user`` is a DB constraint; longer cycles
    are refused by the service, so no chain of reports can lead back to self-approval.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="reporting_line"
    )
    manager = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="direct_reports",
    )
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )

    class Meta:
        db_table = "timetracking_reporting_line"
        constraints = [
            models.CheckConstraint(condition=~Q(manager=F("user")), name="reporting_line_not_self"),
        ]

    def __str__(self) -> str:
        return f"ReportingLine({self.user_id} -> {self.manager_id})"


class ReportingLineChange(models.Model):
    """Append-only audit of reporting-line edits (ADR-1495 §1).

    Setting a manager grants approval authority over a person's time, so every
    change records who made it and what it replaced.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    previous_manager = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    new_manager = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "timetracking_reporting_line_change"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["user", "created_at"])]

    def __str__(self) -> str:
        return f"ReportingLineChange({self.user_id}: -> {self.new_manager_id})"
