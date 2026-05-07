"""Core project scheduling domain models."""

from __future__ import annotations

import uuid
from typing import Any

from django.conf import settings
from django.db import models
from django.db.models import F, Q
from django.utils import timezone
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


class Methodology(models.TextChoices):
    """Project planning methodology preset (ADR-0041).

    Controls default tab visibility in the project workspace. The API
    surface is unchanged — any view remains reachable via direct URL
    regardless of methodology. Per-user overrides (issue #220) layer on
    top of the methodology defaults.
    """

    WATERFALL = "WATERFALL", "Waterfall"
    AGILE = "AGILE", "Agile"
    HYBRID = "HYBRID", "Hybrid"


class EstimationMode(models.TextChoices):
    """Controls who may write three-point estimates on tasks within a project.

    OPEN (default): any Contributor or above may edit estimate fields directly.
    SUGGEST_APPROVE: Contributors submit suggestions (estimate_status=pending);
        a Scheduler-role user must approve before estimates feed Monte Carlo.
    PM_ONLY: only Scheduler-role users may write estimate fields; Contributors
        see read-only values.

    Program/portfolio-level policy defaults for this setting are an Enterprise
    concern; the project-level field is the authoritative OSS control.
    """

    OPEN = "open", "Open"
    SUGGEST_APPROVE = "suggest_approve", "Suggest & Approve"
    PM_ONLY = "pm_only", "PM Only"


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
    # Governance mode for three-point estimates — see EstimationMode docstring.
    estimation_mode = models.CharField(
        max_length=16,
        choices=EstimationMode.choices,
        default=EstimationMode.OPEN,
    )
    # Sprint UI gate (ADR-0037 amendment).  When False, the frontend hides
    # sprint-related affordances (Sprints route, board sprint filter,
    # story_points columns).  API endpoints remain active regardless — this is
    # a UI/UX preference, not an access-control gate.  Auto-set to True for
    # projects created from the Software Delivery template.
    agile_features = models.BooleanField(default=False)
    # Project planning methodology preset (ADR-0041). Drives default tab
    # visibility; does not gate API access. HYBRID shows all tabs (preserves
    # existing behavior for projects created before this field landed).
    methodology = models.CharField(
        max_length=16,
        choices=Methodology.choices,
        default=Methodology.HYBRID,
    )

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


class EstimateStatus(models.TextChoices):
    """Approval state for three-point estimates on a task.

    Only meaningful when the project's estimation_mode is SUGGEST_APPROVE.
    PENDING: a Contributor has submitted values; awaiting Scheduler approval.
    ACCEPTED: estimates are approved and eligible for Monte Carlo sampling.

    In OPEN mode this field is always null (not tracked).
    In PM_ONLY mode writes come from Scheduler+ directly and are always ACCEPTED.
    """

    PENDING = "pending", "Pending Approval"
    ACCEPTED = "accepted", "Accepted"


class TaskStatus(models.TextChoices):
    """Workflow state for a task on the Kanban board.

    5-column model (issue #178): BACKLOG → NOT_STARTED → IN_PROGRESS → REVIEW → COMPLETE.
    ON_HOLD is retained for backwards compatibility; existing ON_HOLD rows are migrated
    to BACKLOG in migration 0020. New tasks should never be set to ON_HOLD.

    status and percent_complete are independent fields — a task can be In Review
    at 60% complete, or marked Complete while percent_complete is still 0.8 if
    the PM chooses to track progress separately. The CPM engine ignores status;
    it drives the schedule from duration and dependencies only.
    """

    BACKLOG = "BACKLOG", "Backlog"
    NOT_STARTED = "NOT_STARTED", "Not started"
    IN_PROGRESS = "IN_PROGRESS", "In progress"
    REVIEW = "REVIEW", "Review"
    ON_HOLD = "ON_HOLD", "On hold"  # legacy — maps to Backlog in board config
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
    notes = models.TextField(blank=True, default="")

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

    # Three-point PERT estimates (optional; used by Monte Carlo if present).
    # All three must be set for the scheduler to use them (all-or-none rule).
    # estimate_status governs approval when project.estimation_mode=SUGGEST_APPROVE.
    optimistic_duration = models.IntegerField(null=True, blank=True)
    most_likely_duration = models.IntegerField(null=True, blank=True)
    pessimistic_duration = models.IntegerField(null=True, blank=True)
    estimate_status = models.CharField(  # noqa: DJ001 — null distinguishes "unset" from ""
        max_length=12,
        choices=EstimateStatus.choices,
        null=True,
        blank=True,
        db_index=True,
        help_text="Approval state for three-point estimates (suggest_approve mode only).",
    )

    # Timestamp of the most recent status column transition.  Auto-set by save()
    # whenever the status field changes (including on initial creation).  Used by
    # board cards to render entry stamps ("Entered at 72% · 3d ago") and stall
    # detection logic (issue #105).
    status_changed_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When this task last entered its current status column.",
    )

    # User-assigned priority rank within the project.  Lower = higher priority.
    # Drives the default board sort order when sort=priority (issue #105).
    # Nullable — tasks without an explicit rank sort last (9999 sentinel in the client).
    priority_rank = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="Priority rank within the project; lower is higher priority.",
    )

    # Sprint membership (ADR-0037 Q1).  A task may belong to at most one sprint
    # at a time; carry-over moves the FK on close.  Sprint-less tasks are the
    # project backlog.  Historical sprint membership is reconstructable from
    # HistoricalTask within the 90-day retention window.
    sprint = models.ForeignKey(
        "Sprint",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tasks",
        db_index=True,
    )
    # Agile estimate (ADR-0037 Q1).  Nullable — story_points is fully optional
    # so non-agile projects do not see a "0 pts" badge on every card.
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)

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
        # Stamp status_changed_at whenever the status column changes (or on creation).
        # For partial saves with update_fields, append status_changed_at automatically
        # so the timestamp persists without callers needing to know about it.
        _status_changed = _track and _old_status != self.status
        if _status_changed:
            self.status_changed_at = timezone.now()
            if _update_fields is not None and "status_changed_at" not in _update_fields:
                kwargs = {**kwargs, "update_fields": (*_update_fields, "status_changed_at")}
        super().save(*args, **kwargs)
        if _status_changed:
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


class RiskCategory(models.TextChoices):
    """PMBOK risk source categories (PMI risk framework, ADR-0043)."""

    TECHNICAL = "TECHNICAL", "Technical"
    EXTERNAL = "EXTERNAL", "External"
    ORGANIZATIONAL = "ORGANIZATIONAL", "Organizational"
    PROJECT_MANAGEMENT = "PROJECT_MANAGEMENT", "Project Management"


class RiskResponse(models.TextChoices):
    """PMBOK risk response strategies (PMI risk framework, ADR-0043).

    The bare verb forms (ACCEPT, not ACCEPTED) are deliberate to avoid the
    visual collision with RiskStatus.ACCEPTED in serializers, audit logs, and
    UI labels — a risk's status describes its lifecycle, while its response
    describes the chosen handling strategy.
    """

    AVOID = "AVOID", "Avoid"
    MITIGATE = "MITIGATE", "Mitigate"
    TRANSFER = "TRANSFER", "Transfer"
    ACCEPT = "ACCEPT", "Accept"


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
    category = models.CharField(  # noqa: DJ001 — null distinguishes "unset" from ""
        max_length=20,
        choices=RiskCategory.choices,
        null=True,
        blank=True,
    )
    response = models.CharField(  # noqa: DJ001 — null distinguishes "unset" from ""
        max_length=10,
        choices=RiskResponse.choices,
        null=True,
        blank=True,
    )
    mitigation_due_date = models.DateField(null=True, blank=True)
    trigger = models.TextField(blank=True, default="")
    contingency = models.TextField(blank=True, default="")
    notes = models.TextField(blank=True, default="")
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


class RiskComment(models.Model):
    """Append-only discussion note on a Risk.

    Plain models.Model (not VersionedModel): comments are not synced to mobile
    and immutability makes server_version unnecessary. No HistoricalRecords —
    nothing to diff in an append-only log.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    risk = models.ForeignKey(Risk, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="risk_comments",
    )
    message = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "projects_riskcomment"
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"RiskComment({self.risk_id}, by={self.author_id})"


# ---------------------------------------------------------------------------
# Board column configuration
# ---------------------------------------------------------------------------


class BoardColumnConfig(models.Model):
    """Per-project Kanban board column configuration.

    Stores an ordered list of column definitions so PMs can rename, reorder,
    or hide the five canonical task status columns (BACKLOG | NOT_STARTED |
    IN_PROGRESS | REVIEW | COMPLETE). The API returns hardcoded defaults when
    no config row exists, so the model is created lazily.

    columns JSON schema (list of objects):
        status:  TaskStatus canonical value (see _CANONICAL_STATUSES in serializers.py)
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


# ---------------------------------------------------------------------------
# Board saved views (#191)
# ---------------------------------------------------------------------------

_VALID_SORT_KEYS = frozenset({"priority", "start_date", "percent_complete"})
_VALID_EVM_MODES = frozenset({"off", "spi", "cpi", "both"})


class BoardSavedView(models.Model):
    """Per-project named board view configuration.

    Stores the filter/sort/display state that a PM has saved so they can
    quickly restore it. Views are project-scoped and visible to all members.
    Only the creator or a Scheduler-role member may rename or delete a view.

    config JSON schema:
        sort:            "priority" | "start_date" | "percent_complete"
        show_wip:        bool
        show_col_tints:  bool
        evm_mode:        "off" | "spi" | "cpi" | "both"
        show_cost:       bool
        risk_linked_only: bool
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="board_saved_views",
    )
    name = models.CharField(max_length=64)
    config = models.JSONField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="+",
    )
    server_version = models.BigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "name"],
                name="unique_board_saved_view_name",
            )
        ]
        verbose_name = "board saved view"
        verbose_name_plural = "board saved views"

    def __str__(self) -> str:
        return f"BoardSavedView({self.project_id}, {self.name!r})"


# ---------------------------------------------------------------------------
# Sprint (ADR-0037)
# ---------------------------------------------------------------------------


class SprintState(models.TextChoices):
    """Lifecycle state of a sprint.

    PLANNED   — sprint exists with goal/dates; no commitment snapshot yet.
    ACTIVE    — sprint is in progress; committed_* are snapshotted on entry.
    COMPLETED — sprint has closed; completed_* and velocity are frozen.
    CANCELLED — sprint was abandoned (PLANNED → only) or hard-closed (admin).
    """

    PLANNED = "PLANNED", "Planned"
    ACTIVE = "ACTIVE", "Active"
    COMPLETED = "COMPLETED", "Completed"
    CANCELLED = "CANCELLED", "Cancelled"


class Sprint(VersionedModel):
    """A time-boxed iteration container for tasks (ADR-0037).

    Project-scoped; a task can be in at most one sprint at a time. Velocity is
    snapshotted on close into ``completed_points`` / ``completed_task_count``;
    these survive the 90-day HistoricalTask retention so sprints older than
    that still report velocity. Burndown points are written to
    ``SprintBurnSnapshot``.
    """

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="sprints")
    short_id = models.CharField(max_length=8, editable=False, blank=True)
    name = models.CharField(max_length=255)
    goal = models.TextField(blank=True, default="")
    notes = models.TextField(blank=True, default="")
    start_date = models.DateField()
    finish_date = models.DateField()
    state = models.CharField(
        max_length=12,
        choices=SprintState.choices,
        default=SprintState.PLANNED,
        db_index=True,
    )
    target_milestone = models.ForeignKey(
        Task,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="targeting_sprints",
        help_text="Optional milestone task this sprint progresses toward.",
    )
    # Snapshotted on activation; never recomputed.  Stored values survive
    # HistoricalTask retention pruning (90-day cap).
    committed_points = models.PositiveIntegerField(null=True, blank=True)
    committed_task_count = models.PositiveIntegerField(null=True, blank=True)
    # Snapshotted on close; reflects tasks that completed within the sprint
    # window — carry-over does NOT inflate completed_*.
    completed_points = models.PositiveIntegerField(null=True, blank=True)
    completed_task_count = models.PositiveIntegerField(null=True, blank=True)
    activated_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="created_sprints",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    class Meta:
        db_table = "projects_sprint"
        ordering = ["start_date", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "short_id"],
                name="unique_sprint_short_id_per_project",
            ),
            models.CheckConstraint(
                condition=Q(finish_date__gt=F("start_date")),
                name="sprint_finish_after_start",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "state"], name="sprint_project_state_idx"),
            models.Index(fields=["project", "start_date"], name="sprint_project_start_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.project_id}/SP-{self.short_id}: {self.name}"

    def save(self, *args: Any, **kwargs: Any) -> None:
        # Assign short_id on INSERT, sharing the per-project sequence with
        # Task and Risk so a single short_id never refers to two entities.
        is_new = not type(self).objects.filter(pk=self.pk).exists() if self.pk else True
        if is_new and not self.short_id:
            self.short_id = _next_short_id(self.project_id)
        super().save(*args, **kwargs)


class SprintBurnSnapshot(models.Model):
    """Daily burndown row for a sprint (ADR-0037 Q4).

    One row per (sprint, snapshot_date). The unique constraint makes
    real-time UPSERTs from the task_status_changed signal naturally idempotent
    — concurrent writes converge on a single row per day. Ideal-line is
    computed client-side from sprint.committed_points and the date range, so
    the server returns only actual values.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sprint = models.ForeignKey(Sprint, on_delete=models.CASCADE, related_name="burn_snapshots")
    snapshot_date = models.DateField()
    remaining_points = models.PositiveIntegerField()
    remaining_task_count = models.PositiveIntegerField()
    completed_points = models.PositiveIntegerField()
    completed_task_count = models.PositiveIntegerField()
    # Signed: positive = scope added during sprint, negative = scope removed.
    # Mid-sprint scope churn is signal, not noise — the chart shows it.
    scope_change_points = models.IntegerField(default=0)
    scope_change_task_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "projects_sprintburnsnapshot"
        ordering = ["sprint_id", "snapshot_date"]
        constraints = [
            models.UniqueConstraint(
                fields=["sprint", "snapshot_date"],
                name="unique_sprint_snapshot_per_day",
            ),
        ]
        indexes = [
            models.Index(fields=["sprint", "snapshot_date"], name="sprint_burn_lookup_idx"),
        ]

    def __str__(self) -> str:
        return f"BurnSnapshot({self.sprint_id} @ {self.snapshot_date})"


class SprintCloseRequestStatus(models.TextChoices):
    """Lifecycle of a transactional outbox row for sprint close (ADR-0037)."""

    PENDING = "pending", "Pending"
    IN_FLIGHT = "in_flight", "In Flight"
    COMPLETED = "completed", "Completed"
    FAILED = "failed", "Failed"


class SprintCloseRequest(models.Model):
    """Transactional outbox record for sprint close operations (ADR-0037).

    Sprint close is async: the API endpoint inserts one of these rows in the
    same DB transaction as the state transition to ``ACTIVE→`` and returns
    202 Accepted.  A Celery Beat drain (``drain_sprint_close_requests``) picks
    up PENDING rows every 30 seconds, applies the close transition with
    ``select_for_update``, and on success enqueues a ScheduleRequest with
    ``reason=SPRINT_CLOSED`` for downstream CPM recompute.

    Idempotency: the row PK is the lock key. If a concurrent dispatch is in
    flight the drain skips the row; if the sprint is already COMPLETED at
    drain time the row is short-circuited to COMPLETED without touching the
    sprint state.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sprint = models.ForeignKey(Sprint, on_delete=models.CASCADE, related_name="close_requests")
    # Verbatim copy of the API request payload — replayable from this row alone.
    carry_over_to = models.CharField(
        max_length=64,
        default="backlog",
        help_text="Either 'backlog', 'none', or a sprint UUID string.",
    )
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="sprint_close_requests",
    )
    status = models.CharField(
        max_length=12,
        choices=SprintCloseRequestStatus.choices,
        default=SprintCloseRequestStatus.PENDING,
        db_index=True,
    )
    requested_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(blank=True, default="")
    attempt_count = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "projects_sprintcloserequest"
        ordering = ["requested_at"]
        indexes = [
            models.Index(
                fields=["status", "requested_at"],
                name="sprint_close_status_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"SprintCloseRequest({self.sprint_id}, {self.status})"


# ---------------------------------------------------------------------------
# Sprint retrospective (issue #231)
# ---------------------------------------------------------------------------


class SprintRetro(models.Model):
    """Retrospective notes attached to a sprint (one-to-one).

    Created by the team during or after sprint close. The free-text
    ``notes`` field captures the meeting summary; structured action items
    live on the related ``RetroActionItem`` rows. The Sprints view renders
    the retro panel beneath the timeline strip when the sprint is in
    ``COMPLETED`` state, and inline during the active close window.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sprint = models.OneToOneField(
        Sprint,
        on_delete=models.CASCADE,
        related_name="retro",
    )
    notes = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_sprint_retros",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_sprintretro"

    def __str__(self) -> str:
        return f"Retro({self.sprint_id})"


class RetroActionItem(models.Model):
    """A single action item from a sprint retrospective.

    Items can be promoted to actual tasks in a future sprint via the
    ``promoted_task_id`` field — set to the new task's UUID once the
    retro endpoint creates it. Until promoted the item is a free-floating
    note; after promotion the UI renders a `T-XXX` link back to the task
    so the team can see the action item closed the loop.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    retro = models.ForeignKey(
        SprintRetro,
        on_delete=models.CASCADE,
        related_name="action_items",
    )
    text = models.TextField()
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="retro_action_items",
    )
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)
    # FK as plain UUID — the task may live in a different sprint and the
    # snapshot survives task soft-delete. Nullable until promotion happens.
    promoted_task_id = models.UUIDField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "projects_retroactionitem"
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"RetroActionItem({self.id}, retro={self.retro_id})"
