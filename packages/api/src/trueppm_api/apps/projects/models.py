"""Core project scheduling domain models."""

from __future__ import annotations

import uuid
from typing import Any

from django.conf import settings
from django.db import models
from django.db.models import F, Q
from simple_history.models import HistoricalRecords

from trueppm_api.fields import LtreeField

# CPM output fields and sync internals — excluded from history tracking.
# These are written by the scheduling engine via bulk_update (bypassing signals
# entirely), but also excluded defensively so any accidental .save() call in a
# CPM path can never produce misleading user-attributed audit rows.
# Fields excluded from django-simple-history tracking on all versioned models.
# CPM output fields only exist on Task; Project and Dependency use the base list.
_HISTORY_EXCLUDED_BASE = ["server_version", "deleted_version"]
_HISTORY_EXCLUDED_TASK = [
    *_HISTORY_EXCLUDED_BASE,
    "early_start",
    "early_finish",
    "late_start",
    "late_finish",
    "total_float",
    "free_float",
    "is_critical",
]


class ImmutableModelError(Exception):
    """Raised when code attempts to UPDATE an immutable model row.

    BaselineTask rows are written once (bulk_create at snapshot time) and must
    never be mutated — they are the historical record.  Any code path that calls
    BaselineTask.save() on an existing row has a bug; raising here surfaces it
    immediately rather than silently corrupting history.
    """


class VersionedModel(models.Model):
    """Abstract base for all models that participate in offline sync.

    server_version is a monotonically increasing integer incremented on every
    save. The mobile sync protocol uses it to detect changes since a given
    checkpoint without needing created_at/updated_at timestamps.

    is_deleted / deleted_version support soft-delete so the sync endpoint can
    return tombstones to mobile clients rather than silently dropping rows.

    Concurrency safety: server_version is updated via F() expression in an
    atomic update() call, so concurrent writes produce a strict order rather
    than a lost-update race.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    server_version = models.BigIntegerField(default=0, editable=False)
    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_version = models.BigIntegerField(null=True, blank=True, editable=False)

    class Meta:
        abstract = True

    def save(self, *args: Any, **kwargs: Any) -> None:
        # Increment server_version atomically on every save (INSERT and UPDATE).
        manager = type(self).objects  # type: ignore[attr-defined]
        if self.pk and manager.filter(pk=self.pk).exists():
            # UPDATE path: atomically increment via F() expression so concurrent
            # writes produce a strict version order rather than a lost-update race.
            manager.filter(pk=self.pk).update(server_version=models.F("server_version") + 1)
            self.server_version = manager.values_list("server_version", flat=True).get(pk=self.pk)
            # Exclude server_version from the subsequent UPDATE so super().save()
            # does not overwrite the increment applied above via F() expression.
            if kwargs.get("update_fields") is not None:
                kwargs["update_fields"] = [
                    f for f in kwargs["update_fields"] if f != "server_version"
                ]
            else:
                kwargs["update_fields"] = [
                    f.attname
                    for f in self._meta.concrete_fields
                    if not f.primary_key and f.attname != "server_version"
                ]
        else:
            # INSERT path: start at 1 so the sync endpoint can find new rows
            # with server_version__gt=0 (since=0 means "give me everything").
            self.server_version = 1
        super().save(*args, **kwargs)

    def soft_delete(self) -> None:
        """Mark the row as deleted and increment server_version.

        The row is retained in the database so that the sync endpoint can
        return its ID in the 'deleted' tombstone list to mobile clients.
        """
        self.is_deleted = True
        self.save()
        # Record the version at which deletion occurred for GC purposes.
        type(self).objects.filter(pk=self.pk).update(  # type: ignore[attr-defined]
            deleted_version=self.server_version
        )
        self.deleted_version = self.server_version


# ---------------------------------------------------------------------------
# Short ID helpers
# ---------------------------------------------------------------------------


def _next_short_id(project_id: uuid.UUID | str) -> str:
    """Atomically allocate the next short_id for a project.

    Increments Project.object_sequence via F() in a single UPDATE and reads
    the new value back.  Returns an 8-character uppercase hex string.
    """
    Project.objects.filter(pk=project_id).update(object_sequence=F("object_sequence") + 1)
    seq: int = Project.objects.values_list("object_sequence", flat=True).get(pk=project_id)
    return f"{seq:08X}"


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------


class Calendar(VersionedModel):
    """Working calendar definition.

    Defines which days of the week are working days and hours per day.
    Exception date ranges (holidays, shutdowns) live in CalendarException.
    """

    name = models.CharField(max_length=255)
    # Bitmask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64
    working_days = models.SmallIntegerField(
        default=31,  # Mon–Fri
        help_text="Bitmask of working days: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64",
    )
    hours_per_day = models.FloatField(default=8.0)
    timezone = models.CharField(max_length=64, default="UTC")

    class Meta:
        db_table = "projects_calendar"

    def __str__(self) -> str:
        return self.name


class CalendarException(models.Model):
    """A non-working date range (holiday, shutdown) within a calendar."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    calendar = models.ForeignKey(Calendar, on_delete=models.CASCADE, related_name="exceptions")
    exc_start = models.DateField()
    exc_end = models.DateField()
    description = models.CharField(max_length=255, blank=True)

    class Meta:
        db_table = "projects_calendar_exception"

    def __str__(self) -> str:
        return f"{self.calendar} exception {self.exc_start} to {self.exc_end}"


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------


class Project(VersionedModel):
    """A project — the top-level container for tasks and scheduling."""

    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    start_date = models.DateField()
    calendar = models.ForeignKey(
        Calendar,
        on_delete=models.PROTECT,
        related_name="projects",
        null=True,
        blank=True,
    )
    # Per-project sequential counter for generating short_id values on Tasks
    # and Risks.  Incremented atomically via F() on every INSERT to either model.
    # Tasks and Risks share the same counter so that short_id is unique across
    # entity types within a project (no "task #3 vs risk #3" ambiguity).
    object_sequence = models.BigIntegerField(default=0, editable=False)

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    class Meta:
        db_table = "projects_project"
        ordering = ["start_date", "name"]

    def __str__(self) -> str:
        return self.name


# ---------------------------------------------------------------------------
# Task
# ---------------------------------------------------------------------------

DEPENDENCY_TYPE_CHOICES = [
    ("FS", "Finish-to-Start"),
    ("SS", "Start-to-Start"),
    ("FF", "Finish-to-Finish"),
    ("SF", "Start-to-Finish"),
]


class TaskStatus(models.TextChoices):
    """Workflow state for a task on the Kanban board.

    status and percent_complete are independent fields — a task can be On Hold
    at 60% complete, or marked Complete while percent_complete is still 0.8 if
    the PM chooses to track progress separately. The CPM engine ignores status;
    it drives the schedule from duration and dependencies only.
    """

    NOT_STARTED = "NOT_STARTED", "Not started"
    IN_PROGRESS = "IN_PROGRESS", "In progress"
    ON_HOLD = "ON_HOLD", "On hold"
    COMPLETE = "COMPLETE", "Complete"


class Task(VersionedModel):
    """A schedulable unit of work within a project.

    CPM output fields (early_start through is_critical) are written by the
    Celery scheduling task after running the trueppm_scheduler engine. They
    are read-only from the REST API perspective.

    wbs_path is a PostgreSQL ltree value (e.g. "1.2.3") for WBS hierarchy,
    indexed with GiST for fast subtree and ancestor queries.
    """

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    # Human-readable, project-scoped identifier — e.g. "000A3F".  Assigned on
    # INSERT from Project.object_sequence; immutable after creation.
    short_id = models.CharField(max_length=8, editable=False, blank=True)
    name = models.CharField(max_length=512)
    # Assignee: the Team Member responsible for this task. Nullable — unassigned
    # tasks may only be edited by Project Manager (ADMIN, 3) or above.
    # Used by IsProjectMemberWriteOrOwn to enforce the "own tasks" restriction.
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_tasks",
    )
    wbs_path = LtreeField(
        help_text="WBS hierarchy path in ltree format, e.g. '1.2.3'",
        null=True,
        blank=True,
    )
    # Duration in working days — mirrors trueppm_scheduler.Task.duration.days
    duration = models.IntegerField(default=1, help_text="Duration in working days")
    status = models.CharField(
        max_length=12,
        choices=TaskStatus.choices,
        default=TaskStatus.NOT_STARTED,
        db_index=True,
    )
    percent_complete = models.FloatField(default=0.0)
    notes = models.TextField(blank=True)

    # SNET constraint — set by the PM (e.g. via Gantt drag-to-reschedule).
    # The CPM forward pass applies this as a floor:
    #   early_start = max(CPM-computed early_start, planned_start)
    # Absence of constraint_type implies SNET for alpha; a constraint_type
    # column may be added post-alpha without breaking changes.
    planned_start = models.DateField(
        null=True,
        blank=True,
        db_index=True,
        help_text="Start no earlier than (SNET). CPM floor applied during forward pass.",
    )

    # CPM output fields — populated by the scheduling Celery task
    early_start = models.DateField(null=True, blank=True)
    early_finish = models.DateField(null=True, blank=True)
    late_start = models.DateField(null=True, blank=True)
    late_finish = models.DateField(null=True, blank=True)
    total_float = models.IntegerField(
        null=True, blank=True, help_text="Total float in working days"
    )
    free_float = models.IntegerField(null=True, blank=True, help_text="Free float in working days")
    is_critical = models.BooleanField(null=True, blank=True)

    # Explicit milestone flag — set by the PM or preserved from MS Project / P6 import.
    # Duration=0 is a common convention for milestones but is not the canonical signal:
    # MS Project carries a separate <Milestone> flag, P6 uses task_type=TT_Mile, and a
    # PM may mark a 1-day gate meeting as a milestone without zeroing its duration.
    # The CPM engine operates on duration only and ignores this field.
    is_milestone = models.BooleanField(default=False)

    # Actual execution dates — auto-set on status transition to IN_PROGRESS /
    # COMPLETE (via TaskSerializer.update), manually overridable by PMs.
    actual_start = models.DateField(null=True, blank=True, db_index=True)
    actual_finish = models.DateField(null=True, blank=True, db_index=True)

    # Three-point PERT estimates (optional; used by Monte Carlo if present)
    optimistic_duration = models.IntegerField(null=True, blank=True)
    most_likely_duration = models.IntegerField(null=True, blank=True)
    pessimistic_duration = models.IntegerField(null=True, blank=True)

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_TASK)

    class Meta:
        db_table = "projects_task"
        ordering = ["wbs_path", "name"]
        indexes = [
            models.Index(fields=["project"]),
            # Composite index for the utilization window filter:
            # WHERE project_id = X AND early_start <= window_end AND early_finish >= window_start
            models.Index(
                fields=["project", "early_start", "early_finish"],
                name="task_utilization_window_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "short_id"],
                name="unique_task_short_id_per_project",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.project.name} / {self.name}"

    def save(self, *args: Any, **kwargs: Any) -> None:
        # Assign short_id on INSERT (first save).
        is_new = not type(self).objects.filter(pk=self.pk).exists() if self.pk else True
        if is_new and not self.short_id:
            self.short_id = _next_short_id(self.project_id)
        # Capture whether status is being written before super() expands update_fields.
        _update_fields = kwargs.get("update_fields")
        _track = _update_fields is None or "status" in _update_fields
        _old_status: str | None = None
        if _track and not is_new:
            _old_status = (
                type(self).objects.filter(pk=self.pk).values_list("status", flat=True).first()
            )
        super().save(*args, **kwargs)
        if _track and _old_status != self.status:
            from trueppm_api.apps.projects.signals import task_status_changed

            task_status_changed.send(
                sender=type(self),
                task=self,
                old_status=_old_status,
                new_status=self.status,
            )

    def soft_delete(self) -> None:
        """Soft-delete the task and cascade to all its dependency edges.

        Dependency rows that reference this task are themselves soft-deleted so
        the sync endpoint can tombstone them on connected mobile clients.
        """
        # Soft-delete all edges where this task is predecessor or successor.
        edges = Dependency.objects.filter(predecessor=self) | Dependency.objects.filter(
            successor=self
        )
        for dep in list(edges):
            if not dep.is_deleted:
                dep.soft_delete()
        super().soft_delete()


# ---------------------------------------------------------------------------
# Dependency
# ---------------------------------------------------------------------------


class Dependency(VersionedModel):
    """A scheduling dependency between two tasks.

    Extends VersionedModel so that dependency changes and deletions are
    visible to the mobile sync endpoint.
    """

    predecessor = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="successors")
    successor = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="predecessors")
    dep_type = models.CharField(max_length=2, choices=DEPENDENCY_TYPE_CHOICES, default="FS")
    lag = models.IntegerField(
        default=0,
        help_text="Lag in calendar days (positive = delay, negative = lead)",
    )

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    class Meta:
        db_table = "projects_dependency"
        constraints = [
            models.UniqueConstraint(
                fields=["predecessor", "successor", "dep_type"],
                name="unique_dependency",
            )
        ]

    def __str__(self) -> str:
        return f"{self.predecessor} {self.dep_type}+{self.lag}d {self.successor}"


# ---------------------------------------------------------------------------
# Baseline
# ---------------------------------------------------------------------------


class Baseline(VersionedModel):
    """A frozen snapshot of all task dates at a point in time.

    Baselines enable plan-vs-actual tracking: ghost bars on the Gantt canvas
    render from BaselineTask.start / BaselineTask.finish.

    Only one baseline per project may be "active" at a time; the active baseline
    is overlaid automatically on GET /api/v1/tasks/ without a ?baseline= param.
    The UniqueConstraint below enforces this at the DB level — race conditions
    between two concurrent activate calls cannot produce two active baselines.

    has_cpm_dates=False means the snapshot was taken before the CPM engine ran;
    some or all BaselineTask rows may have null start/finish.  The API includes
    this flag so the frontend can display a soft warning.
    """

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="baselines")
    name = models.CharField(max_length=255)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_baselines",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=False, db_index=True)
    # True when every snapshotted task had a non-null early_start at creation time.
    has_cpm_dates = models.BooleanField(default=False)

    class Meta:
        db_table = "projects_baseline"
        ordering = ["created_at"]
        constraints = [
            # At most one active baseline per project — enforced at the DB level.
            models.UniqueConstraint(
                fields=["project"],
                condition=Q(is_active=True),
                name="unique_active_baseline_per_project",
            )
        ]

    def __str__(self) -> str:
        return f"{self.project.name} / {self.name}"


class BaselineTask(models.Model):
    """Immutable snapshot of a single task's dates within a Baseline.

    task_id is a plain UUIDField (not FK to Task) so that the snapshot survives
    task soft-delete.  task_name is denormalized for the same reason — the name
    at the time of snapshot is historically meaningful.

    start / finish mirror early_start / early_finish at snapshot time; they may
    be null when the CPM engine had not yet run (Baseline.has_cpm_dates=False).

    Mutation after creation raises ImmutableModelError.  BaselineTask rows are
    only ever written via BaselineTask.objects.bulk_create() inside the snapshot
    transaction; no code path should call .save() on an existing row.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    baseline = models.ForeignKey(Baseline, on_delete=models.CASCADE, related_name="tasks")
    # Plain UUID — not FK — so the snapshot survives task soft-delete.
    task_id = models.UUIDField(db_index=True)
    task_name = models.CharField(max_length=512)
    start = models.DateField(null=True, blank=True)
    finish = models.DateField(null=True, blank=True)
    duration = models.IntegerField()
    actual_start = models.DateField(null=True, blank=True)
    actual_finish = models.DateField(null=True, blank=True)

    class Meta:
        db_table = "projects_baseline_task"
        indexes = [
            models.Index(fields=["baseline", "task_id"], name="baseline_task_lookup_idx"),
        ]

    def __str__(self) -> str:
        return f"BaselineTask {self.task_id} @ {self.baseline}"

    def save(self, *args: Any, **kwargs: Any) -> None:
        """Prevent mutation after creation."""
        if self.pk and BaselineTask.objects.filter(pk=self.pk).exists():
            raise ImmutableModelError(
                f"BaselineTask {self.pk} is immutable — snapshot rows cannot be updated."
            )
        super().save(*args, **kwargs)


# ---------------------------------------------------------------------------
# Risk register
# ---------------------------------------------------------------------------


class RiskStatus(models.TextChoices):
    """Lifecycle states for a project risk."""

    OPEN = "OPEN", "Open"
    MITIGATING = "MITIGATING", "Mitigating"
    RESOLVED = "RESOLVED", "Resolved"
    ACCEPTED = "ACCEPTED", "Accepted"
    CLOSED = "CLOSED", "Closed"


class Risk(VersionedModel):
    """A project risk with probability × impact severity scoring.

    Severity is computed (probability * impact) rather than stored to avoid
    write-consistency hazards. The RiskSerializer exposes it as a read-only
    field. The viewset annotates it on the queryset so OrderingFilter can sort
    by severity without a round-trip to Python.

    Tasks linked to a risk are advisory — they indicate which tasks are
    affected by or related to this risk. The link is many-to-many and
    optional.
    """

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="risks",
    )
    short_id = models.CharField(max_length=8, editable=False, blank=True)
    title = models.CharField(max_length=512)
    description = models.TextField(blank=True)
    status = models.CharField(
        max_length=12,
        choices=RiskStatus.choices,
        default=RiskStatus.OPEN,
        db_index=True,
    )
    probability = models.PositiveSmallIntegerField()
    impact = models.PositiveSmallIntegerField()
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="owned_risks",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_risks",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    tasks: models.ManyToManyField[Task, RiskTask] = models.ManyToManyField(
        Task,
        through="RiskTask",
        blank=True,
        related_name="risks",
    )
    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    class Meta:
        db_table = "projects_risk"
        ordering = ["-impact", "-probability", "title"]
        indexes = [
            models.Index(fields=["project", "status"], name="risk_project_status_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "short_id"],
                name="unique_risk_short_id_per_project",
            ),
        ]

    def __str__(self) -> str:
        return f"[{self.status}] {self.title}"

    def save(self, *args: Any, **kwargs: Any) -> None:
        # Assign short_id on INSERT (first save).
        is_new = not type(self).objects.filter(pk=self.pk).exists() if self.pk else True
        if is_new and not self.short_id:
            self.short_id = _next_short_id(self.project_id)
        # Capture update_fields before super() expands it so we can tell
        # which fields the caller intended to change.
        _update_fields = kwargs.get("update_fields")
        super().save(*args, **kwargs)
        # Suppress "saved" signal when this call is from soft_delete() — the
        # deletion signal is emitted by soft_delete() instead.
        if self.is_deleted:
            return
        _scoring_fields = frozenset(("probability", "impact", "status"))
        if _update_fields is None or not _scoring_fields.isdisjoint(_update_fields):
            from trueppm_api.apps.projects.signals import risk_changed

            risk_changed.send(sender=type(self), risk=self, action="saved")

    def soft_delete(self) -> None:
        # VersionedModel.soft_delete() calls self.save(); the save() override
        # above suppresses the "saved" signal when is_deleted is True, so we
        # emit a single "deleted" signal here after the deletion is committed.
        super().soft_delete()
        from trueppm_api.apps.projects.signals import risk_changed

        risk_changed.send(sender=type(self), risk=self, action="deleted")


class RiskTask(models.Model):
    """Explicit through table for the Risk ↔ Task many-to-many relationship.

    Using an explicit through table rather than a hidden auto-generated one
    keeps the schema legible and leaves the door open for attaching metadata
    (e.g. impact direction) to the link in a future migration.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    risk = models.ForeignKey(Risk, on_delete=models.CASCADE)
    task = models.ForeignKey(Task, on_delete=models.CASCADE)

    class Meta:
        db_table = "projects_risk_task"
        unique_together = [("risk", "task")]

    def __str__(self) -> str:
        return f"RiskTask risk={self.risk_id} task={self.task_id}"


# ---------------------------------------------------------------------------
# Board column configuration
# ---------------------------------------------------------------------------


class BoardColumnConfig(models.Model):
    """Per-project Kanban board column configuration.

    Stores an ordered list of column definitions so PMs can rename, reorder,
    or hide the four built-in task status columns. The API returns hardcoded
    defaults when no config row exists, so the model is created lazily.

    columns JSON schema (list of objects):
        status:  TaskStatus value — NOT_STARTED | IN_PROGRESS | ON_HOLD | COMPLETE
        label:   display label (max 32 chars)
        visible: boolean — hidden columns still hold tasks but don't appear on the board
    """

    project = models.OneToOneField(
        Project,
        on_delete=models.CASCADE,
        related_name="board_column_config",
    )
    columns = models.JSONField(
        default=list,
        help_text="Ordered list of {status, label, visible} objects.",
    )

    class Meta:
        verbose_name = "board column config"
        verbose_name_plural = "board column configs"

    def __str__(self) -> str:
        return f"BoardColumnConfig({self.project_id})"
