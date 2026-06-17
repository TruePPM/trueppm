"""Models for the scheduling app — Celery task infrastructure."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class ScheduleRequestStatus(models.TextChoices):
    """Lifecycle of a transactional outbox row for CPM recalculation."""

    PENDING = "pending", "Pending"
    DISPATCHED = "dispatched", "Dispatched"
    DONE = "done", "Done"
    DEAD = "dead", "Dead"


class ScheduleRequestReason(models.TextChoices):
    """Why a CPM recalculation was requested — used for audit trail and drain dedup."""

    TASK_CHANGE = "task_change", "Task Change"
    DEPENDENCY_CHANGE = "dependency_change", "Dependency Change"
    SPRINT_CLOSED = "sprint_closed", "Sprint Closed"
    MANUAL = "manual", "Manual"


class ScheduleRequest(models.Model):
    """Transactional outbox record for CPM recalculation requests.

    Each write operation on a project's task graph inserts one row here
    (or silently ignores a duplicate via the partial unique constraint) in
    the same DB transaction. A Celery Beat drain task dispatches pending rows
    every 30 seconds, and recalculate_schedule marks its own row done on
    completion.

    Two partial unique constraints enforce at-most-one pending and at-most-one
    dispatched row per project at any time, so duplicate suppression is cheap
    and correct under concurrent writes.

    Does NOT inherit VersionedModel — not synced to mobile clients.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="schedule_requests",
    )
    status = models.CharField(
        max_length=16,
        choices=ScheduleRequestStatus.choices,
        default=ScheduleRequestStatus.PENDING,
    )
    reason = models.CharField(
        max_length=24,
        choices=ScheduleRequestReason.choices,
        default=ScheduleRequestReason.TASK_CHANGE,
        db_index=True,
    )
    requested_at = models.DateTimeField(auto_now_add=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)
    celery_task_id = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["requested_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project"],
                condition=models.Q(status="pending"),
                name="schedule_request_one_pending_per_project",
            ),
            models.UniqueConstraint(
                fields=["project"],
                condition=models.Q(status="dispatched"),
                name="schedule_request_one_dispatched_per_project",
            ),
        ]
        indexes = [
            models.Index(
                fields=["status", "requested_at"],
                name="schedule_request_status_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"ScheduleRequest({self.project_id}, {self.status})"


class MCAttributionAudience(models.TextChoices):
    """Who may see the run-author name on Monte Carlo forecast history (ADR-0144).

    Defined here (not on Workspace) because both the per-workspace config columns
    and the ``MonteCarloHistoryView`` attribution gate reference it; placing it on
    the scheduling model keeps a single source and avoids a workspace ``→`` scheduling
    import cycle (workspace/projects import this enum, never the reverse).

    The default ``ADMIN_OWNER`` preserves the pre-0143 hardcoded Admin/Owner gate
    exactly, so the three-valued enum is backward-compatible and reversible.
    """

    ADMIN_OWNER = "admin_owner", "Admins and Owners"
    SCHEDULER_PLUS = "scheduler_plus", "Schedulers and above"
    NONE = "none", "No one"


class FailedTaskStatus(models.TextChoices):
    """Lifecycle of a dead-lettered Celery task."""

    PENDING_RETRY = "pending_retry", "Pending Retry"
    DEAD = "dead", "Dead"
    DISMISSED = "dismissed", "Dismissed"
    RETRIED = "retried", "Retried"


class FailedTask(models.Model):
    """Persistent record of a Celery task that exhausted all retries.

    Does NOT inherit VersionedModel — not synced to mobile, not part of the
    project data graph. Exists for admin visibility and manual retry/dismiss.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task_name = models.CharField(max_length=255, db_index=True)
    task_id = models.CharField(max_length=255, unique=True)
    args = models.JSONField(default=list)
    kwargs = models.JSONField(default=dict)
    exception_type = models.CharField(max_length=255)
    exception_message = models.TextField()
    traceback = models.TextField()
    failure_count = models.PositiveIntegerField(default=1)
    first_failed_at = models.DateTimeField(auto_now_add=True)
    last_failed_at = models.DateTimeField(auto_now=True)
    status = models.CharField(
        max_length=16,
        choices=FailedTaskStatus.choices,
        default=FailedTaskStatus.DEAD,
        db_index=True,
    )

    class Meta:
        ordering = ["-last_failed_at"]
        indexes = [
            models.Index(fields=["status", "last_failed_at"], name="failed_task_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.task_name} ({self.task_id}) — {self.status}"


class VelocitySuggestion(models.Model):
    """Non-destructive duration recommendation generated on sprint close (ADR-0065).

    When a sprint closes, the drain computes a rolling 6-sprint team velocity
    (``completed_points / sprint_working_days``) and, for tasks in the closing
    sprint with ``story_points`` set, records a suggested
    ``most_likely_duration = story_points / team_velocity_per_day`` here. The
    PM accepts or dismisses each suggestion from the Task Detail Drawer; the
    underlying ``Task.most_likely_duration`` is never overwritten without
    explicit consent so PM-committed baselines stay intact and the
    accept/dismiss history is auditable per (task, sprint).

    A unique constraint on (task, sprint) makes the sprint-close drain
    idempotent: a duplicate run upserts the row rather than producing
    duplicate prompts.

    Not synced to mobile clients — surfaces only in the PM-facing Task Detail
    Drawer.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(
        "projects.Task",
        on_delete=models.CASCADE,
        related_name="velocity_suggestions",
    )
    sprint = models.ForeignKey(
        "projects.Sprint",
        on_delete=models.CASCADE,
        related_name="velocity_suggestions",
    )
    # Suggested most_likely_duration in working days. Stored as integer to match
    # Task.most_likely_duration; rounding happens in the service layer.
    suggested_duration = models.PositiveIntegerField()
    team_velocity_per_day = models.DecimalField(
        max_digits=6,
        decimal_places=3,
        help_text="Rolling 6-sprint average of completed_points / sprint_working_days.",
    )
    # When estimation_mode=SUGGEST_APPROVE the suggestion is flagged so the
    # governance review surface can route the accept decision through a
    # Scheduler-role user; in OPEN and PM_ONLY modes any PM may accept directly.
    flag_for_review = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    # Exactly one of accepted_at / dismissed_at is non-null at a time; the
    # other stays null. The pair encodes the PM decision lifecycle without an
    # extra status enum (similar to the actual_start / actual_finish pattern).
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="accepted_velocity_suggestions",
    )
    dismissed_at = models.DateTimeField(null=True, blank=True)
    dismissed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="dismissed_velocity_suggestions",
    )

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["task", "sprint"],
                name="unique_velocity_suggestion_per_task_sprint",
            ),
        ]
        indexes = [
            # Pending suggestions for a task — the Task Detail Drawer query.
            models.Index(
                fields=["task", "accepted_at", "dismissed_at"],
                name="velocity_sugg_task_pending_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"VelocitySuggestion(task={self.task_id}, sprint={self.sprint_id})"

    @property
    def project_id(self) -> object:
        """Expose the task's project_id so _get_project_id_from_obj can find it.

        Required for IsProjectAdmin.has_object_permission to resolve the project
        context when DRF's get_object() runs check_object_permissions on a
        VelocitySuggestion (no direct FK to Project). Mirrors the same pattern
        used by resources.TaskResource.
        """
        return self.task.project_id

    @property
    def is_pending(self) -> bool:
        """True when neither accepted nor dismissed — pending PM decision."""
        return self.accepted_at is None and self.dismissed_at is None


class MonteCarloRun(models.Model):
    """One persisted project-level Monte Carlo simulation run (ADR-0109, #961).

    Written synchronously per ``POST /projects/<pk>/monte-carlo/`` run so the PM
    can read finish-date forecast *drift* over time ("my P80 was Aug 14 two weeks
    ago, now Aug 28"). Distinct from ``projects.ForecastSnapshot`` (ADR-0106 §5),
    which is milestone-scoped, latest-per-milestone, and carries the velocity
    -privacy band — this model is the explicit project-level CPM Monte Carlo run
    history and stores P95 (which ForecastSnapshot does not).

    A plain ``models.Model`` (not a ``VersionedModel``) — display/forecast
    metadata, consistent with ``ForecastSnapshot`` / ``VelocitySuggestion``; not
    on the mobile sync surface (Monte Carlo requires server compute, so history
    is an online read).

    Retention is the OSS cap applied to run *count*: a nightly purge keeps the
    newest ``settings.MC_HISTORY_CAP`` rows per project (Enterprise overrides to
    ``None`` = unlimited). Bounded history, never unlimited — the portfolio /
    cross-program rollup is the Enterprise upsell (ADR-0109).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="monte_carlo_runs",
    )
    taken_at = models.DateTimeField(auto_now_add=True)
    # SET_NULL + null: account deletion never cascades away forecast history, and
    # the attribution is optional metadata. Serialized ONLY to Admin/Owner so
    # forecast drift cannot become a named-individual performance signal at the
    # team level (ADR-0109 / VoC Morgan). related_name="+": no reverse accessor
    # needed (we never list a user's runs).
    triggered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    # The probabilistic finish-date percentiles as of this run. Nullable: a
    # project with no committed tasks yields no distribution to anchor on.
    p50 = models.DateField(null=True, blank=True)
    p80 = models.DateField(null=True, blank=True)
    p95 = models.DateField(null=True, blank=True)
    # The deterministic CPM spine at run time (max early_finish of committed
    # tasks), kept for context alongside the probabilistic band.
    cpm_finish = models.DateField(null=True, blank=True)
    # Inputs needed to interpret the run.
    n_simulations = models.PositiveIntegerField()
    task_count = models.PositiveIntegerField(null=True, blank=True)
    # The full per-run distribution payload — the same
    # ``{histogram_buckets, confidence_curve, sensitivity}`` shape written to the
    # ``mc_latest:<pk>`` cache (#1231, ADR-0144). Persisted so the histogram +
    # tornado survive cache expiry and a past run stays re-viewable.
    #
    # Nullable with NO backfill: pre-0143 runs have no stored distribution and the
    # frontend renders the empty-state prose for them (legacy runs are a tail that
    # ages out under the retention cap). Capped at MC_DISTRIBUTION_MAX_BYTES with
    # bucket down-sampling at persist time (the cache copy stays full) so a
    # pathological high-bucket run cannot bloat the row.
    distribution = models.JSONField(null=True, blank=True)

    class Meta:
        db_table = "scheduling_montecarlorun"
        ordering = ["-taken_at"]
        indexes = [
            # Newest-first history read + the nightly rank-based purge.
            models.Index(fields=["project", "-taken_at"], name="mcrun_project_recent_idx"),
        ]

    def __str__(self) -> str:
        return f"MonteCarloRun(project={self.project_id} @ {self.taken_at:%Y-%m-%d})"
