"""Core project scheduling domain models."""

from __future__ import annotations

import uuid
from datetime import time
from typing import Any

from django.conf import settings
from django.contrib.postgres.indexes import GinIndex
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import F, Q
from django.db.models.functions import Lower
from django.utils import timezone
from simple_history.models import HistoricalRecords

from trueppm_api.fields import LtreeField

# Engine input bounds — mirror of trueppm_scheduler.engine.MAX_DURATION_DAYS /
# MAX_LAG_DAYS (~100 years). Kept as local constants so loading models does not
# pull numpy/networkx in through the scheduler engine (the engine is imported
# lazily inside the views). test_scheduler_bound_parity asserts these stay in
# lockstep with the engine's exported values. See issue #749.
MAX_TASK_DURATION_DAYS = 36_525
MAX_DEPENDENCY_LAG_DAYS = 36_525


def validate_working_day_mask(value: int) -> None:
    """Reject a calendar bitmask with no working weekday.

    ``is_working_day`` only consults bits 0-6 (Mon-Sun), so a mask of 0 — or one
    that sets only bits >= 7 — has no working day at all. Feeding that to the CPM
    engine would drive its day-by-day calendar walk into a multi-million-iteration
    spin; reject it at the write boundary instead. See trueppm_scheduler and #749.
    """
    if value & 0b111_1111 == 0:
        raise ValidationError("working_days must set at least one weekday bit (Mon=1 … Sun=64).")


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


def _next_risk_short_id(project_id: uuid.UUID | str) -> str:
    """Atomically allocate the next risk short_id for a project (#929).

    Risks use a *dedicated* decimal counter (``Project.risk_sequence``), separate
    from the shared hex ``object_sequence`` used by Tasks and Sprints. The VoC
    panel on #929 settled the format: decimal, contiguous (gaps only from
    deletion), immutable for the life of the risk. We therefore store the raw
    sequence integer as a string (e.g. ``"7"``); the ``R-007`` / ``<CODE>-R-007``
    display forms are server-owned serializer fields so a headless/MCP client
    reads the identifier rather than re-deriving it (the bug this fixes was three
    web formatters independently mis-parsing the hex scheme as decimal).
    """
    Project.objects.filter(pk=project_id).update(risk_sequence=F("risk_sequence") + 1)
    seq: int = Project.objects.values_list("risk_sequence", flat=True).get(pk=project_id)
    return str(seq)


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
        help_text="Bitmask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64",
        validators=[validate_working_day_mask],
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


class Health(models.TextChoices):
    """User-visible health state for a Program or Project (issue #523).

    ``AUTO`` defers to a future rollup computation; the explicit values are
    PM overrides that surface immediately in lists and dashboards. Shared
    between Program (this MR) and Project (queued under #520) so the same
    chip palette + UI labels can apply to both.
    """

    AUTO = "AUTO", "Auto"
    ON_TRACK = "ON_TRACK", "On track"
    AT_RISK = "AT_RISK", "At risk"
    CRITICAL = "CRITICAL", "Critical"


class Visibility(models.TextChoices):
    """Workspace-vs-private visibility scope (issue #523).

    ``WORKSPACE`` (default) means any workspace member can list the entity
    even without an explicit membership row. ``PRIVATE`` means listing is
    restricted to explicit members. The queryset enforcement is a future
    cross-cutting change — this MR stores the field and renders it in the UI
    only; today both values resolve to "membership-required" via the
    existing get_queryset gate.
    """

    WORKSPACE = "WORKSPACE", "Workspace"
    PRIVATE = "PRIVATE", "Private"


class DefaultView(models.TextChoices):
    """Default landing view for a project (issue #520).

    Drives which workspace tab loads first when a project is opened without
    an explicit view in the URL. The API surface is unchanged — every view
    remains reachable by direct URL regardless of this preference. Per-user
    overrides may layer on top in a future issue, matching the pattern used
    for methodology defaults.
    """

    SCHEDULE = "SCHEDULE", "Schedule"
    BOARD = "BOARD", "Board"
    TABLE = "TABLE", "Table"
    OVERVIEW = "OVERVIEW", "Overview"


class RollupKpi(models.TextChoices):
    """KPIs that can be enabled on the program-overview rollup (ADR-0079, #527).

    The set is closed — the serializer rejects unknown identifiers. Three KPIs
    that touched team-boundary or aggregation-correctness concerns were
    deliberately excluded after the VoC panel (``team_velocity``,
    ``scope_change_count``, ``resource_utilization``); follow-up issues will
    decide whether they re-enter through a different scope.
    """

    SCHEDULE_VARIANCE = "schedule_variance", "Schedule variance (SV)"
    COST_VARIANCE = "cost_variance", "Cost variance (CV)"
    BUDGET_UTILIZATION = "budget_utilization", "Budget utilization"
    SCHEDULE_HEALTH = "schedule_health", "Schedule health"
    CRITICAL_TASKS = "critical_tasks", "Critical task count"
    AT_RISK_TASKS = "at_risk_tasks", "At-risk tasks"
    BASELINE_VARIANCE = "baseline_variance", "Baseline variance"
    RISK_SCORE = "risk_score", "Risk score"
    MILESTONE_HEALTH = "milestone_health", "Milestone health"
    P80_COMPLETION = "p80_completion", "P80 completion date"


class AggregationPolicy(models.TextChoices):
    """How project health combines into the program health dot (ADR-0079, #527).

    ``WORST`` is the default and the only policy that does not dilute a single
    critical project — recommended for adoption by Sarah/Marcus, see the VoC
    panel notes in the ADR. The remaining policies are exposed because some
    program managers explicitly want them for client-facing rollups (a small
    fit-out should not drag down a large shell-and-core program).
    """

    WORST = "worst", "Worst-case"
    AVERAGE = "average", "Average"
    WEIGHTED_BY_BUDGET = "weighted_by_budget", "Budget-weighted"
    TASK_WEIGHTED = "task_weighted", "Task-weighted"


class SlipPropagation(models.TextChoices):
    """What a program does when a cross-project dependency slips (#529).

    The closed set is the union of "no action / surface / enforce" — three
    rungs the PM can step through as a program matures. ``WARN`` is the
    default because it matches how the program shell already renders a slip
    indicator on the program overview; ``NONE`` and ``BLOCK`` are explicit
    opt-outs in either direction.
    """

    NONE = "none", "No action"
    WARN = "warn", "Warn only"
    BLOCK = "block", "Block & escalate"


class Program(VersionedModel):
    """Named grouping of related projects for one PM or program team (ADR-0070).

    A program is the OSS unit of coordination — one PM's set of related
    projects with a shared backlog (#501), program-level membership, and
    a future combined burndown (0.3). Portfolio (cross-program governance,
    PMO oversight, multi-tenancy) is Enterprise scope per the Two-Repo Rule.

    Projects are optional members: ``Project.program=NULL`` is a fully
    supported standalone project. No existing rows are migrated when this
    model is added — assignment is at the PM's discretion.

    The OWNER membership row is created in the same transaction as the
    Program (see ``access.services.create_program``) so a Program can never
    exist without at least one Owner who can manage it.
    """

    name = models.CharField(max_length=255)
    description = models.TextField(blank=True, default="")
    # Short identifier used in exports, breadcrumbs, and as a future task-ID prefix.
    # Optional — programs created before #523 have no code and the UI shows an empty
    # field. Not unique at the DB level; uniqueness is a workspace-policy concern.
    code = models.CharField(max_length=40, blank=True, default="")
    methodology = models.CharField(
        max_length=16,
        choices=Methodology.choices,
        default=Methodology.HYBRID,
    )
    # Optional program-level override of the iteration-container label (ADR-0116,
    # #1106). NULL = inherit the workspace default; a value overrides it for every
    # project in this program whose own override is NULL. Display-only (ADR-0038/0111).
    iteration_label = models.CharField(  # noqa: DJ001 — null distinguishes "inherit" from ""
        max_length=32, null=True, blank=True
    )
    # PM override for the program health chip. Defaults to AUTO so existing rows
    # render via the (future) rollup rather than implying a manual judgment.
    health = models.CharField(
        max_length=16,
        choices=Health.choices,
        default=Health.AUTO,
    )
    # Listing scope. WORKSPACE = listable by any workspace member; PRIVATE =
    # explicit-members-only. Queryset enforcement is a future change — see the
    # Visibility docstring above.
    visibility = models.CharField(
        max_length=16,
        choices=Visibility.choices,
        default=Visibility.WORKSPACE,
    )
    # Accent color as #RRGGBB hex, or null (#698). Drives the program-scoped
    # identity square on the list card and rollup-chart accents. Null = unset,
    # which the card renders as a health-tinted neutral — distinct from "" so
    # the General settings swatch picker can show "no color chosen". Mirrors
    # the ``Task.color`` phase-accent pattern below.
    color = models.CharField(  # noqa: DJ001 — null distinguishes "unset" from ""
        max_length=7,
        null=True,
        blank=True,
        help_text="Program accent color as #RRGGBB hex, or null when unset.",
    )
    # Rollup config (ADR-0079, #527) — controls which KPIs appear on the
    # program overview and how project health is aggregated into the program
    # health dot. Stored as two columns on Program so the existing
    # HistoricalRecords audit and ``server_version`` bump on save() cover both
    # without a side table. Values are seeded methodology-aware by the
    # ``rollup_config_defaults`` helper (data migration + post_save signal).
    rollup_enabled_kpis = models.JSONField(default=list, blank=True)
    rollup_aggregation_policy = models.CharField(
        max_length=24,
        choices=AggregationPolicy.choices,
        default=AggregationPolicy.WORST,
    )
    # Risk & deps policy (#529) — controls cross-project dependency slip
    # behaviour at the program boundary. Two columns on Program for the same
    # reason as the rollup config above: HistoricalRecords gives audit for
    # free, and ``server_version`` bumps on save() so the sync protocol fans
    # out. No methodology-aware seeding — the static defaults (``WARN`` / 3
    # days) match the issue spec for both new and existing rows.
    risk_slip_propagation = models.CharField(
        max_length=8,
        choices=SlipPropagation.choices,
        default=SlipPropagation.WARN,
    )
    risk_escalation_days = models.PositiveSmallIntegerField(
        default=3,
        validators=[MinValueValidator(1), MaxValueValidator(30)],
    )
    # The single "Program Manager" displayed in the Program header and Settings
    # General page. Distinct from ``created_by`` (immutable historical fact) and
    # from OWNER membership rows (multiple owners are allowed; lead is a UI
    # affordance pointing to one person). SET_NULL so a user account deletion
    # does not break programs they once led.
    lead = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="programs_led",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="programs_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Lifecycle (#530). A closed program is read-only at the program-shell
    # level (members, settings, ceremonies); child projects are intentionally
    # not cascaded — they often outlive the program structure (re-org, hand-off).
    # The UI dialog explicitly warns "projects remain active." See
    # ``IsProgramNotClosed`` for the write-side enforcement.
    is_closed = models.BooleanField(default=False, db_index=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="programs_closed",
    )

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    class Meta:
        db_table = "projects_program"
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class CeremonyCadenceType(models.TextChoices):
    """Recurrence pattern for a program-level ceremony template (ADR-0079).

    ``ON_MILESTONE`` ceremonies are tied to phase boundary milestones rather
    than a wall-clock schedule, so they carry no ``cadence_day``/``cadence_time``.
    """

    WEEKLY = "weekly", "Weekly"
    BIWEEKLY = "biweekly", "Bi-weekly"
    MONTHLY = "monthly", "Monthly"
    ON_MILESTONE = "on_milestone", "On milestone"


# Reserved Scrum vocabulary that must not be created as program-level
# ceremonies — Sprint Planning, Review, Retrospective, etc. live at the
# team/sprint level and routing them through Program Settings silently
# absorbs them into PMO surface (Morgan/Alex VoC blocker; ADR-0079).
# Comparison is performed on ``value.strip().casefold()``.
RESERVED_SCRUM_CEREMONY_NAMES: frozenset[str] = frozenset(
    {
        "sprint planning",
        "sprint review",
        "sprint retrospective",
        "retrospective",
        "retro",
        "daily scrum",
        "standup",
        "daily standup",
        "scrum of scrums",
    }
)


class CeremonyTemplate(VersionedModel):
    """Recurring program ceremony (ADR-0079).

    Program-scoped configuration — e.g. weekly Program Sync, monthly Steering
    Committee, on-milestone Phase Gate Review. Sprint events (Planning, Review,
    Retrospective, Daily Scrum) are explicitly disallowed at this layer; they
    are configured per-sprint at the team level.

    The row is config-only: it does NOT generate calendar invite instances or
    notifications today. Downstream calendar integration is tracked as a
    follow-up (see ADR-0079 §Out-of-scope follow-ups).
    """

    program = models.ForeignKey(
        Program,
        on_delete=models.CASCADE,
        related_name="ceremony_templates",
    )
    name = models.CharField(max_length=120)
    cadence_type = models.CharField(
        max_length=16,
        choices=CeremonyCadenceType.choices,
    )
    # Free-form day specifier interpreted by ``cadence_type``:
    #   weekly / biweekly → weekday slug ("monday", "tuesday", ...)
    #   monthly           → ordinal+weekday slug ("1st-thursday", "last-friday")
    #   on_milestone      → empty string
    # Stored as text rather than parsed columns so the schedule UI can evolve
    # without a migration; serializer-level validation keeps inputs sane.
    cadence_day = models.CharField(max_length=32, blank=True, default="")
    # NULL for on_milestone ceremonies; required for weekly/biweekly/monthly.
    cadence_time = models.TimeField(null=True, blank=True)
    duration_minutes = models.PositiveSmallIntegerField(default=60)
    # Descriptive "who chairs this" label (e.g. "Program Manager", "Risk Lead").
    # Free-form rather than the access-control Role enum — chair-of-meeting is
    # a different concept from RBAC, and orgs use custom titles (David VoC).
    owner_role = models.CharField(max_length=64, blank=True, default="")
    enabled = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ceremony_templates_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    class Meta:
        db_table = "projects_ceremony_template"
        ordering = ["name"]
        constraints = [
            # Active rows are unique by (program, name). Soft-deleted rows are
            # excluded so a name can be reused after deletion without a
            # 409 collision with the tombstone.
            models.UniqueConstraint(
                fields=["program", "name"],
                condition=Q(is_deleted=False),
                name="ceremony_template_unique_name_per_program",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.program_id})"


class PhaseGateConfig(VersionedModel):
    """Singleton phase-gate calendar template per program (ADR-0079).

    One row per Program (1:1). Created lazily on first GET via ``get_or_create``
    in the view layer so existing programs do not need a data migration.

    v1 is config-only — the ``invite_template`` is a free-text body that
    references variables like ``{{milestone.name}}``; actual invite dispatch
    when a phase-boundary milestone is saved is an out-of-scope follow-up.
    """

    program = models.OneToOneField(
        Program,
        on_delete=models.CASCADE,
        related_name="phase_gate_config",
    )
    enabled = models.BooleanField(default=False)
    invite_template = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_phase_gate_config"

    def __str__(self) -> str:
        return f"PhaseGateConfig({self.program_id})"


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


class PrioritizationModel(models.TextChoices):
    """Prioritization scoring model for a project's product backlog (ADR-0105, #922).

    Per-project setting (``Project.prioritization_model``). Drives which distinct input
    columns on ``Task`` are read and how the computed ``prioritization_score`` is derived:
    WSJF = (business_value+time_criticality+risk_reduction)/job_size,
    RICE = (reach*impact*confidence)/effort, VALUE_EFFORT = value/effort_estimate.
    The score is computed on read (never stored) so it cannot go stale; the one-shot
    auto-rank action writes the *resulting order* into the shared ``priority_rank``.
    NONE (default) hides the scoring surface — pure manual drag until a PM/PO opts in.
    """

    NONE = "none", "None"
    WSJF = "wsjf", "WSJF"
    RICE = "rice", "RICE"
    VALUE_EFFORT = "value_effort", "Value / Effort"


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
    # Short identifier used as a task-ID prefix and on exports (issue #520).
    # Uppercase alphanumeric + hyphen, max 12 chars; format validated by the
    # serializer. Optional — projects created before this field have an empty
    # code and the UI shows a blank input. Not unique at the DB level;
    # uniqueness is a workspace-policy concern, matching Program.code (#523).
    code = models.CharField(max_length=12, blank=True, default="")
    # PM override for the project health chip (issue #520). Defaults to AUTO so
    # existing rows render via the (future) rollup rather than implying a
    # manual judgment. Reuses the Health enum shared with Program (#523).
    health = models.CharField(
        max_length=16,
        choices=Health.choices,
        default=Health.AUTO,
    )
    # Listing scope (issue #520). WORKSPACE = listable by any workspace member;
    # PRIVATE = explicit-members-only. Queryset enforcement is a future change
    # — this field is stored and rendered today. Reuses the Visibility enum
    # shared with Program (#523).
    visibility = models.CharField(
        max_length=16,
        choices=Visibility.choices,
        default=Visibility.WORKSPACE,
    )
    # IANA timezone identifier used for due dates, Gantt rendering, and sprint
    # cutovers (issue #520). Empty string defers to the workspace default.
    # Stored as free text — full IANA validation is a future change.
    timezone = models.CharField(max_length=64, blank=True, default="")
    # Default landing view when the project is opened without a specific view
    # in the URL (issue #520). The API surface is unchanged; every view is
    # reachable by direct URL regardless of this preference.
    default_view = models.CharField(
        max_length=16,
        choices=DefaultView.choices,
        default=DefaultView.SCHEDULE,
    )
    # The single "Project lead" displayed on Settings → General and the (future)
    # project header (#966). A UI affordance pointing to one person — distinct
    # from ``created_by`` (immutable historical fact) and from OWNER membership
    # rows (multiple owners allowed; lead names one). Mirrors ``Program.lead``.
    # SET_NULL so a user-account deletion does not break projects they once led.
    # Member-of-scope (the lead must already hold a ProjectMembership) is
    # enforced in ``ProjectSerializer.validate_lead``, not at the DB level.
    lead = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="projects_led",
    )
    # Per-project sequential counter for generating short_id values on Tasks
    # and Risks.  Incremented atomically via F() on every INSERT to either model.
    # Tasks and Sprints share this counter so that short_id is unique across
    # those entity types within a project (no "task #3 vs sprint #3" ambiguity).
    # Risks moved off this shared hex counter to their own decimal sequence
    # (``risk_sequence``) in #929 — see ``_next_risk_short_id``.
    object_sequence = models.BigIntegerField(default=0, editable=False)
    # Dedicated per-project decimal counter for Risk short_ids (#929). Separate
    # from ``object_sequence`` so risk IDs are contiguous (R-001, R-002, …) and
    # legible in status reports/exports rather than colliding hex values.
    # Monotonic: incremented on every risk INSERT, never reused after deletion
    # (deletion leaves a gap — the VoC's audit-trail requirement).
    risk_sequence = models.BigIntegerField(default=0, editable=False)
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
    # Product-backlog prioritization model (ADR-0105, #922). Drives which distinct input
    # columns on ``Task`` are read for the computed score. Scalar column (matches
    # ``methodology`` / ``estimation_mode``) — no settings side table needed. NONE hides
    # the scoring surface (pure manual drag); auto-rank is a one-shot PO action, not a
    # persistent lock — manual drag always wins afterward.
    prioritization_model = models.CharField(
        max_length=16,
        choices=PrioritizationModel.choices,
        default=PrioritizationModel.NONE,
    )
    # Display noun for the time-boxed iteration container (ADR-0111, #862).
    # Free text (Sprint / Iteration / PI / custom) so Scrumban/SAFe-adjacent teams
    # are not forced into Scrum-Guide vocabulary. Display-ONLY: it never gates tabs,
    # routes, API semantics, or CPM — the code symbol stays ``Sprint`` (ADR-0038).
    # Stored singular; the web derives plural/possessive forms. NULL = inherit the
    # program/workspace default (ADR-0116, #1106) — the effective label is resolved
    # server-side; clients read ``effective_iteration_label``, never this raw column.
    # No ``choices=`` (and thus no drf-spectacular enum pin) — the presets are a UI
    # affordance, not a DB set.
    iteration_label = models.CharField(  # noqa: DJ001 — null distinguishes "inherit" from ""
        max_length=32,
        null=True,
        blank=True,
    )
    # Optional grouping into a Program (ADR-0070). NULL = standalone project.
    # SET_NULL on program delete so projects survive the cascade as standalone.
    # Program membership is independent of project membership: a project member
    # is not implicitly a program member, and vice versa.
    program = models.ForeignKey(
        "projects.Program",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_index=True,
        related_name="projects",
    )

    # Lifecycle (#530). An archived project is hard read-only across all
    # writes (tasks, deps, members, settings) — enforced by ``IsProjectNotArchived``
    # applied to every write action on this and nested viewsets. Reads remain
    # unrestricted. Soft-archive (UI-only hide) was rejected in the architect
    # review because it invites accidental edits to historical projects and
    # confuses sync clients. Use ``POST /unarchive/`` to restore writes.
    is_archived = models.BooleanField(default=False, db_index=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    archived_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="projects_archived",
    )

    # Marks demo/sample data created by the sample-project loader (#375). Lets
    # the UI show a "this is sample data" banner and a one-click teardown, and
    # lets operators distinguish disposable demo content from real projects.
    is_sample = models.BooleanField(default=False, db_index=True)

    # Set by the CPM recalc task on success (ADR-0114). Null until the first
    # schedule pass completes — the web Schedule view shows a "recalculating"
    # badge while it is null/older than the import so a freshly-imported demo
    # never reads as broken with uncomputed dates (#1053). Not a domain field
    # (excluded from history); updated via bulk .update() to avoid a sync bump.
    recalculated_at = models.DateTimeField(null=True, blank=True)

    history = HistoricalRecords(excluded_fields=[*_HISTORY_EXCLUDED_BASE, "recalculated_at"])

    class Meta:
        db_table = "projects_project"
        ordering = ["start_date", "name"]

    def __str__(self) -> str:
        return self.name

    def soft_delete(self) -> None:
        """Soft-delete the project and cascade-tombstone its child rows.

        ``VersionedModel.soft_delete`` alone marks only this Project row, leaving
        tasks, sprints, risks, and baselines orphaned with a stale FK pointing at
        a deleted project. Those children all filter ``is_deleted=False`` on the
        child row (not the parent), so an un-cascaded soft-delete leaks orphans
        into "My Work", capacity rollups, active-sprint velocity math, and
        portfolio counts. Cascade the soft-delete to each child so sync clients
        receive proper tombstones and no orphan survives — mirroring
        ``Task.soft_delete`` (which cascades to its dependency edges and subtasks)
        and the ``delete_program_cascade`` service.

        Each child goes through its own ``soft_delete`` rather than a bulk update
        so per-model side effects fire: ``Task.soft_delete`` tombstones dependency
        edges and subtask children, ``Risk.soft_delete`` emits ``risk_changed``.
        Project deletes are infrequent, so the per-row cost is acceptable; the
        whole thing runs inside the request's ATOMIC_REQUESTS transaction. (A
        large project's cascade is offloaded to a background task in #1112 — for
        now it runs synchronously.)

        The hard-delete path (``?force=true``) is unaffected — Django's DB-level
        CASCADE removes children directly; this cascade only governs soft-delete.
        """
        # Non-subtask tasks first: Task.soft_delete cascades each task's
        # dependency edges and its drawer-subtask children, so subtasks are
        # handled by their parent and must not be visited again here — a stale
        # in-memory row would double-bump server_version and emit a redundant
        # tombstone. The trailing sweep catches any subtask orphaned under an
        # already-deleted parent (a pre-existing anomaly) so none is left live
        # under the deleted project. No select_for_update: the project is being
        # deleted, and pessimistically locking the whole task set for the full
        # transaction is needless contention against concurrent task writes.
        for task in self.tasks.filter(is_deleted=False, is_subtask=False):
            task.soft_delete()
        for orphan_subtask in self.tasks.filter(is_deleted=False):
            orphan_subtask.soft_delete()
        for sprint in self.sprints.filter(is_deleted=False):
            sprint.soft_delete()
        for risk in self.risks.filter(is_deleted=False):
            risk.soft_delete()
        for baseline in self.baselines.filter(is_deleted=False):
            baseline.soft_delete()
        super().soft_delete()


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

    status and percent_complete are loosely coupled: a task can be In Review at
    60% complete, but a task in COMPLETE is always 100%. The save() method
    coerces percent_complete to 100 whenever status is set to COMPLETE so the
    UI display, the SPI math, and the column the card lives in stay consistent
    (#381 follow-up). The CPM engine ignores status; it drives the schedule
    from duration and dependencies only.
    """

    BACKLOG = "BACKLOG", "Backlog"
    NOT_STARTED = "NOT_STARTED", "Not started"
    IN_PROGRESS = "IN_PROGRESS", "In progress"
    REVIEW = "REVIEW", "Review"
    ON_HOLD = "ON_HOLD", "On hold"  # legacy — maps to Backlog in board config
    COMPLETE = "COMPLETE", "Complete"


class TaskType(models.TextChoices):
    """Work-item taxonomy for a task (ADR-0105, #363).

    Default is TASK so every pre-existing row keeps its current semantics — the
    field is purely additive. EPIC is special: an epic is a *grouping* node, not
    schedulable work. Epics are excluded from CPM input and every committed-delivery
    aggregate (see ``CommittedTaskManager`` and ``scheduling/tasks.py::_run_schedule``),
    exactly as ``is_recurring`` templates are. The epic→story link is the ``Task.epic``
    self-FK, deliberately parallel to (and independent of) the WBS ``wbs_path`` (#364).
    """

    EPIC = "epic", "Epic"
    STORY = "story", "Story"
    TASK = "task", "Task"
    BUG = "bug", "Bug"
    SPIKE = "spike", "Spike"


class DorState(models.TextChoices):
    """Definition-of-Ready signal for a backlog story (ADR-0105, #731).

    Named ``dor`` (not ``readiness``) on the model because ``TaskSerializer`` already
    exposes a *computed* ``readiness`` field — the board-card ReadinessChip signal
    {idea/estimated/ready/baselined} from ADR-0057 — which is a different concept (a
    derived board affordance, not settable PO intent). This is the PO's stored DoR
    intent, set via the story drawer (Mark ready / Send to refine).

    The READY transition is gated server-side — see ``Task.dor_blockers`` and the
    serializer: a story may only become READY when it is estimated (``story_points``
    set) and every acceptance criterion has ``status == "met"``. A failing or pending
    AC, or an unestimated story, blocks Ready. IDEA is the default for new stories.
    """

    IDEA = "idea", "Idea"
    REFINE = "refine", "Refine"
    READY = "ready", "Ready"


class GovernanceClass(models.TextChoices):
    """Which overlay governs a task's subtree in the hybrid model (ADR-0036, #407).

    ``FLOW`` (the default) is sprint/kanban-governed agile work; ``GATED`` is
    phase-gate-governed waterfall work; ``HYBRID`` mixes both within the subtree.
    This selects *which governance overlay* applies — distinct from
    ``delivery_mode``, which selects *how the work is executed and estimated*.
    Default FLOW keeps every pre-existing row purely additive.
    """

    GATED = "gated", "Gated"
    FLOW = "flow", "Flow"
    HYBRID = "hybrid", "Hybrid"


class DeliveryMode(models.TextChoices):
    """How a task is executed, rendered, and rolled up (ADR-0036, #407).

    Drives the rollup engine's ``percent_complete`` interpretation (#408): a
    ``SCRUM`` node rolls up from story-point burndown, a ``KANBAN`` node from item
    throughput (done/total), a ``WATERFALL`` node from explicit percent entry, and
    a ``MILESTONE`` node is a zero-duration gate. Also feeds the agile-aware Monte
    Carlo (#411): SCRUM subtrees sample from the team velocity distribution. Default
    WATERFALL preserves every existing task's current behavior.
    """

    WATERFALL = "waterfall", "Waterfall"
    SCRUM = "scrum", "Scrum"
    KANBAN = "kanban", "Kanban"
    MILESTONE = "milestone", "Milestone"


class CommittedTaskManager(models.Manager["Task"]):
    """Tasks that represent committed delivery: not BACKLOG and not soft-deleted.

    Use this for any aggregate where BACKLOG cards would distort the picture —
    capacity heat maps, Schedule/Gantt view, Monte Carlo input, client PDF
    export, Board phase progress. Default ``Task.objects`` is intentionally
    unfiltered so the Board can still render BACKLOG cards inside the
    band-above-grid layout (ADR-0057).
    """

    def get_queryset(self) -> models.QuerySet[Task]:
        # is_recurring=False excludes recurrence templates and their generated
        # occurrences from every committed-delivery aggregate (Monte Carlo input,
        # capacity heat map, Schedule/Gantt, client PDF export). Recurring tasks are
        # parallel, calendar-driven activities — admitting them to these scheduling
        # inputs would corrupt float, the critical path, and Monte Carlo P50/P80/P95.
        # The CPM feed (scheduling/tasks.py::_run_schedule) applies the same exclusion
        # at its own boundary. See ADR-0090.
        #
        # type=EPIC is excluded for the same reason (ADR-0105): an epic is a grouping
        # node, not schedulable work. Its dates/points in the rollup card are query-time
        # annotations computed from child stories — admitting an epic to CPM input,
        # capacity, or Monte Carlo would corrupt float and the P50/P80/P95 bands.
        return (
            super()
            .get_queryset()
            .exclude(status=TaskStatus.BACKLOG)
            .exclude(type=TaskType.EPIC)
            .filter(is_deleted=False, is_recurring=False)
        )


def committed_sprint_tasks(sprint_id: Any) -> models.QuerySet[Task]:
    """Return the tasks that count toward a sprint's committed scope (ADR-0102).

    The single source of truth for "which of a sprint's tasks are in the
    commitment" — non-soft-deleted tasks linked to the sprint, *excluding*
    pending mid-sprint injections (``sprint_pending=True``). Every commitment /
    burndown / rollup aggregate routes through this helper so a future query
    author cannot forget the ``sprint_pending=False`` filter and silently
    re-inflate the math with un-accepted scope (the ADR-0102 §Risk #2 mitigation).

    Pending tasks remain queryable for the board/My-Work surfaces via the plain
    ``Task.objects.filter(sprint_id=...)`` — only the *math* excludes them.
    """
    return Task.objects.filter(sprint_id=sprint_id, is_deleted=False, sprint_pending=False)


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
    duration = models.IntegerField(
        default=1,
        help_text="Duration in working days",
        validators=[MinValueValidator(0), MaxValueValidator(MAX_TASK_DURATION_DAYS)],
    )
    status = models.CharField(
        max_length=12,
        choices=TaskStatus.choices,
        default=TaskStatus.NOT_STARTED,
        db_index=True,
    )
    percent_complete = models.FloatField(default=0.0)
    notes = models.TextField(blank=True, default="")

    # Contributor "blocked" signal (#476). A team member raises this from the
    # board / My Work to flag that the work cannot proceed — it is the data source
    # for the My Work blocked badge (#484) and the ``task.blocked`` notification
    # (#855). The flag IS the reason: a non-empty ``blocked_reason`` means flagged
    # blocked, an empty string means clear. Modeling it as reason-only (rather than
    # a separate boolean) keeps it to one field AND avoids a name collision with
    # the existing computed ``is_blocked`` annotation (ADR-0035), which is a
    # *dependency-readiness* signal ("has incomplete predecessors") — a different
    # concept that the board card owns. This is the EXPLICIT human flag, never
    # derived from predecessors. Rides the existing ``PATCH /tasks/{id}/`` write
    # path, so it is gated to Member+ by task-edit permission — a Viewer cannot
    # set it. Always-present-when-blocked because a blocker with no reason is
    # low-signal ("a button that silently fails is worse than no button").
    blocked_reason = models.TextField(
        blank=True,
        default="",
        help_text="Why the task is blocked; empty means not blocked.",
    )

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
    optimistic_duration = models.IntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(MAX_TASK_DURATION_DAYS)],
    )
    most_likely_duration = models.IntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(MAX_TASK_DURATION_DAYS)],
    )
    pessimistic_duration = models.IntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(MAX_TASK_DURATION_DAYS)],
    )
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
    # Mid-sprint scope-injection pending-acceptance flag (ADR-0102). True ⇔ the
    # task is linked to its sprint but NOT yet accepted into the commitment —
    # set automatically when a task is linked to an ACTIVE sprint *after*
    # activation, cleared on accept, forced False on reject (which also nulls
    # ``sprint``). The flag is meaningless (and must stay False) whenever
    # ``sprint_id`` is null or the sprint is PLANNED — pre-activation links are
    # part of the commitment baseline by definition; only post-activation
    # injection is gated.
    #
    # This is the LOAD-BEARING math-exclusion key (ADR-0102 §2): the three
    # sprint-math paths (snapshot_committed_metrics, upsert_burndown_for_sprint,
    # compute_milestone_rollup_payload) all query Task directly and exclude
    # ``sprint_pending=True`` via the ``committed_in_sprint`` queryset helper, so
    # a pending task contributes ZERO to committed_points / burndown / rollup
    # until accepted. Indexed so the exclusion is a cheap index range scan.
    #
    # NOT client-writable (read-only on TaskSerializer): the only writers are the
    # accept_scope_change / reject_scope_change services, so a contributor cannot
    # self-accept by PATCHing the field. Rides VersionedModel sync to the mobile
    # client for free (the exclusion is offline-evaluable).
    sprint_pending = models.BooleanField(default=False, db_index=True)
    # Agile estimate (ADR-0037 Q1).  Nullable — story_points is fully optional
    # so non-agile projects do not see a "0 pts" badge on every card.
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)
    # Live burndown signal (issue #366).  Tracks remaining effort within a sprint;
    # auto-set to 0 on COMPLETE and restored from story_points on reopen.
    # Null means "not separately estimated" — burndown falls back to story_points.
    remaining_points = models.PositiveSmallIntegerField(null=True, blank=True)

    # ── Product-backlog / PO grooming (ADR-0105) ────────────────────────────────
    # Work-item taxonomy (#363). Default TASK keeps every pre-existing row's
    # semantics. EPIC is excluded from CPM/capacity (see CommittedTaskManager).
    # Field name ``type`` matches ADR-0088's committed shape.
    type = models.CharField(
        max_length=8,
        choices=TaskType.choices,
        default=TaskType.TASK,
        db_index=True,
    )
    # Epic grouping (#364): the parent epic for a story, a self-FK parallel to — and
    # independent of — the WBS ``wbs_path``. Only a ``type=EPIC`` task may be referenced
    # here (serializer-validated); epics do not nest in 0.3. SET_NULL so a story
    # survives epic deletion as ungrouped.
    parent_epic = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="epic_children",
        db_index=True,
    )
    # Definition-of-Ready signal (#731). Stored PO intent; the READY transition is gated
    # server-side but advisory (see DorState docstring). Named ``dor`` to avoid colliding
    # with the existing computed ``readiness`` serializer field (ADR-0057). Acceptance
    # criteria (the AcceptanceCriterion child model) inform Ready but never auto-flip it.
    dor = models.CharField(
        max_length=8,
        choices=DorState.choices,
        default=DorState.IDEA,
        db_index=True,
    )
    # Sprint-scoped execution order (#365). Meaningful only when ``sprint`` is non-null:
    # the team's within-sprint sequence, seeded from ``priority_rank`` at sprint commit
    # and freely reorderable (Member+) WITHOUT writing back to ``priority_rank`` — the
    # product backlog is never mutated by in-sprint sequencing (ADR-0105 §5).
    sprint_rank = models.PositiveIntegerField(null=True, blank=True)
    # ── Prioritization scoring inputs (#922) — distinct per model so switching the
    # project's active model is non-destructive and reversible (ADR-0105 §3). All
    # nullable; the computed score is derived on read (never stored). ──
    # WSJF
    business_value = models.PositiveSmallIntegerField(null=True, blank=True)
    time_criticality = models.PositiveSmallIntegerField(null=True, blank=True)
    risk_reduction = models.PositiveSmallIntegerField(null=True, blank=True)
    job_size = models.PositiveSmallIntegerField(null=True, blank=True)
    # RICE
    reach = models.PositiveIntegerField(null=True, blank=True)
    impact = models.FloatField(null=True, blank=True)
    confidence = models.FloatField(null=True, blank=True)
    effort = models.FloatField(null=True, blank=True)
    # Value / Effort
    value = models.PositiveSmallIntegerField(null=True, blank=True)
    effort_estimate = models.FloatField(null=True, blank=True)

    # ── Hybrid governance / delivery model (ADR-0036, #407) ─────────────────────
    # The three foundational fields every hybrid feature reads: the rollup engine
    # (#408), the agile-aware Monte Carlo (#411), and the governance overlays. All
    # carry defaults so every pre-existing row keeps its current waterfall/flow
    # semantics — purely additive, no behavioral change. db_index on the two choice
    # fields because the rollup + overlay queries filter subtrees by them.
    governance_class = models.CharField(
        max_length=8,
        choices=GovernanceClass.choices,
        default=GovernanceClass.FLOW,
        db_index=True,
    )
    delivery_mode = models.CharField(
        max_length=10,
        choices=DeliveryMode.choices,
        default=DeliveryMode.WATERFALL,
        db_index=True,
    )
    # When True the node inherits its parent's governance_class; when False it
    # overrides with its own. Default True so a subtree governs uniformly unless a
    # node explicitly breaks inheritance.
    parent_governance_inherited = models.BooleanField(default=True)

    # Subtask discriminator (ADR-0060 #308).  True only for tasks created via the
    # drawer subtask action.  Distinguishes drawer-created decomposition children
    # from WBS phase/milestone children created via indent/reparent.
    # Depth-1 enforcement: tasks with is_subtask=True cannot themselves have subtasks.
    is_subtask = models.BooleanField(
        default=False,
        db_index=True,
        help_text="True for tasks created via the drawer subtask action (ADR-0060).",
    )

    # Accent color as #RRGGBB hex, or null. Only meaningful on root-level (phase)
    # tasks where the Workflow settings page surfaces it; the schedule view and
    # board grouping treat null as "use the default tint" (#521).
    color = models.CharField(  # noqa: DJ001 — null distinguishes "unset" from ""
        max_length=7,
        null=True,
        blank=True,
        help_text="Phase accent color as #RRGGBB hex (root tasks only).",
    )

    # Recurrence (ADR-0090). A task is either a recurrence *template* (has a
    # TaskRecurrenceRule via the `recurrence` reverse one-to-one) or a generated
    # *occurrence* (recurrence_rule set). Both carry is_recurring=True.
    #
    # is_recurring is the LOAD-BEARING CPM-exclusion key. Recurring tasks are
    # parallel, calendar-driven activities and MUST NOT enter the scheduling-engine
    # inputs — admitting them would corrupt CPM float, the critical path, and Monte
    # Carlo P50/P80/P95. A single indexed boolean (rather than deriving exclusion from
    # the FK + reverse one-to-one at every call site) guarantees the template and its
    # occurrences are filtered together and can never be half-excluded. Enforced at
    # both engine boundaries: scheduling/tasks.py::_run_schedule (CPM) and
    # CommittedTaskManager (Monte Carlo, capacity, PDF, Schedule view).
    is_recurring = models.BooleanField(default=False, db_index=True)
    # Set on generated occurrences only; the template is reached via the rule's
    # `task` one-to-one. CASCADE: deleting a rule removes its generated occurrences.
    recurrence_rule = models.ForeignKey(
        "TaskRecurrenceRule",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="occurrences",
    )
    # The calendar date a generated occurrence represents — the idempotency key for
    # lazy generation (paired with recurrence_rule in the unique constraint below).
    recurrence_occurrence_date = models.DateField(null=True, blank=True)

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_TASK)

    # Default manager — unfiltered. Listed first so it remains _default_manager
    # (Board view depends on seeing BACKLOG cards).
    objects: models.Manager[Task] = models.Manager()
    # Aggregate manager — filters out BACKLOG and soft-deleted. Used by Schedule
    # view, capacity, Monte Carlo, PDF export. See CommittedTaskManager docstring.
    committed: CommittedTaskManager = CommittedTaskManager()

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
            # Partial covering index for the cross-project My Work endpoint
            # (ADR-0065 Gap 2). Filters on (assignee, status) with soft-deleted
            # rows excluded — the contributor surface never shows them.
            models.Index(
                fields=["assignee", "status"],
                condition=models.Q(is_deleted=False),
                name="task_assignee_status_idx",
            ),
            # Sync delta pull filters WHERE project_id = X AND server_version > since
            # (sync/views.py). Without server_version trailing the project column,
            # Postgres visits every project row on a near-high-water-mark resync
            # (#810). The composite turns it into a single index range seek.
            models.Index(fields=["project", "server_version"], name="task_proj_serverver_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "short_id"],
                name="unique_task_short_id_per_project",
            ),
            # Lazy generation idempotency (ADR-0090): an occurrence is created at most
            # once per (rule, date). NULL recurrence_rule (normal tasks) is distinct in
            # Postgres, so non-recurring tasks are unconstrained by this.
            models.UniqueConstraint(
                fields=["recurrence_rule", "recurrence_occurrence_date"],
                name="unique_recurrence_occurrence_per_date",
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
        # REVIEW and COMPLETE both coerce percent_complete to 100 — a card in
        # the Review column is "work done, awaiting sign-off" and DONE is
        # finished by definition; both states imply 100% delivered work. The
        # only difference between them is whether the PM has signed off yet.
        # Without this, the popover/ring/strip/SPI math disagree with the
        # column the card lives in. The inverse direction (progress=100 →
        # auto-flip status) lives in TaskSerializer.update() where actor role
        # can be inspected: contributor → REVIEW, PM/PMO → COMPLETE.
        if self.status in (TaskStatus.REVIEW, TaskStatus.COMPLETE) and self.percent_complete != 100:
            self.percent_complete = 100.0
            _update_fields = kwargs.get("update_fields")
            if _update_fields is not None and "percent_complete" not in _update_fields:
                kwargs = {**kwargs, "update_fields": (*_update_fields, "percent_complete")}
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
        """Soft-delete the task, its dependency edges, and any is_subtask children.

        Dependency rows that reference this task are themselves soft-deleted so
        the sync endpoint can tombstone them on connected mobile clients.

        Subtask children (is_subtask=True) are cascade-deleted when the parent
        is deleted — they have no independent existence outside the parent task.
        """
        # Soft-delete all edges where this task is predecessor or successor.
        edges = Dependency.objects.filter(predecessor=self) | Dependency.objects.filter(
            successor=self
        )
        for dep in list(edges):
            if not dep.is_deleted:
                dep.soft_delete()
        # Cascade to drawer-created subtask children (depth-1 only; WBS structure
        # children are not auto-deleted — the PM must explicitly delete them).
        if self.wbs_path:
            subtask_children = Task.objects.filter(
                is_subtask=True,
                is_deleted=False,
                wbs_path__startswith=str(self.wbs_path) + ".",
            ).select_for_update()
            for child in list(subtask_children):
                child.soft_delete()
        super().soft_delete()


class AcceptanceCriterion(VersionedModel):
    """A single tickable acceptance criterion on a story (ADR-0105 §2, #493/#731).

    First-class child rows (not a JSONField) so criteria have stable manual ordering,
    a per-item sprint-review pass/fail trail, and a queryable met-count for
    release-readiness. ``met_by``/``met_at`` are the review trail — surfaced as the
    *criterion's* team-level status with attribution only on drill-down inside the
    sprint/story context; never a per-person column and never aggregated to a PMO
    surface (the VoC privacy guard, same posture as ADR-0104).

    Decoupled from ``percent_complete`` and any CPM percent: a story may be
    schedule-complete with unmet criteria and vice versa. Criteria drive sprint-review
    pass/fail and the PO's Mark-ready gate, not the schedule.
    """

    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="acceptance_criteria")
    text = models.CharField(max_length=1000)
    # Optional structured Given/When/Then (DA-13). Blank when the team uses plain text.
    given = models.CharField(max_length=1000, blank=True, default="")
    when = models.CharField(max_length=1000, blank=True, default="")
    then = models.CharField(max_length=1000, blank=True, default="")
    met = models.BooleanField(default=False)
    # Stable manual ordering within a story (drag to reorder).
    position = models.PositiveIntegerField(default=0)
    # Review trail — who marked it met and when (privacy-guarded; see docstring).
    met_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    met_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "projects_acceptance_criterion"
        ordering = ["task", "position"]
        indexes = [models.Index(fields=["task", "position"])]

    def __str__(self) -> str:
        return f"{'✓' if self.met else '○'} {self.text[:60]}"

    @property
    def project_id(self) -> Any:
        """Expose the owning project so the RBAC object-permission helpers
        (`_get_project_id_from_obj`) resolve criteria to their project."""
        return self.task.project_id


# ---------------------------------------------------------------------------
# Task recurrence (ADR-0090)
# ---------------------------------------------------------------------------


class TaskRecurrenceFrequency(models.TextChoices):
    """How often a recurrence rule spawns a new task occurrence."""

    DAILY = "DAILY", "Daily"
    WEEKLY = "WEEKLY", "Weekly"
    MONTHLY = "MONTHLY", "Monthly"
    CUSTOM = "CUSTOM", "Custom"


class RecurrenceEndType(models.TextChoices):
    """When a recurrence series stops generating occurrences."""

    NEVER = "NEVER", "Never"
    ON_DATE = "ON_DATE", "On date"
    AFTER_N = "AFTER_N", "After N occurrences"


class TaskRecurrenceRule(VersionedModel):
    """A calendar rule that lazily spawns parallel task occurrences from a template.

    One rule per template task (OneToOne). The generator
    (``projects.tasks.generate_recurring_occurrences``) creates upcoming
    occurrences within a bounded horizon — never the full series — honoring the
    per-occurrence inheritance toggles.

    Recurrence templates and their occurrences are excluded from CPM and the
    scheduling-engine inputs via ``Task.is_recurring`` (ADR-0090): they are
    parallel, calendar-driven activities, not nodes in the project's logical
    network. Extends VersionedModel so rule changes sync to mobile clients.
    """

    task = models.OneToOneField(
        Task,
        on_delete=models.CASCADE,
        related_name="recurrence",
        help_text="The template task this rule recurs from.",
    )
    frequency = models.CharField(
        max_length=8,
        choices=TaskRecurrenceFrequency.choices,
        default=TaskRecurrenceFrequency.WEEKLY,
    )
    # "Every N" units — 1 = every period, 2 = every other, … Drives CUSTOM and any
    # >1 multiple of the base frequency.
    interval = models.PositiveSmallIntegerField(
        default=1,
        validators=[MinValueValidator(1), MaxValueValidator(365)],
    )
    # WEEKLY only: bitmask of weekdays (Mon=1, Tue=2, … Sun=64), mirroring the
    # Calendar.working_days convention. 0 for non-weekly frequencies.
    weekdays = models.SmallIntegerField(
        default=0,
        help_text="Weekly only: bitmask Mon=1 … Sun=64.",
    )
    # MONTHLY only: day-of-month 1–31, clamped to the month length at generation.
    day_of_month = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(1), MaxValueValidator(31)],
    )
    time_of_day = models.TimeField(
        default=time(9, 0),
        help_text="Local time the occurrence is due (morning-notification slot).",
    )
    timezone = models.CharField(max_length=64, default="UTC")

    end_type = models.CharField(
        max_length=8,
        choices=RecurrenceEndType.choices,
        default=RecurrenceEndType.NEVER,
    )
    end_date = models.DateField(null=True, blank=True)
    end_count = models.PositiveIntegerField(null=True, blank=True)

    # Per-occurrence inheritance toggles — which template attributes each generated
    # occurrence copies.
    inherit_assignee = models.BooleanField(default=True)
    inherit_subtasks = models.BooleanField(default=False)
    inherit_attachments = models.BooleanField(default=False)
    # Stored for #738 and a future notification feature; OSS morning-digest delivery
    # is net-new (the digest sender is trueppm-enterprise#112), so this toggle does
    # not send anything yet. See ADR-0090.
    inherit_morning_notification = models.BooleanField(default=False)

    # Generation cursor — the date through which occurrences have been materialized.
    # Lets the generator resume without rescanning the whole horizon. Null = none yet.
    generated_through = models.DateField(null=True, blank=True)

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    class Meta:
        db_table = "projects_taskrecurrencerule"
        # Deterministic default order so list pagination is stable (one rule per task).
        ordering = ["task_id"]
        indexes = [
            # Sync delta pull joins via task then filters server_version (#810).
            models.Index(fields=["task", "server_version"], name="trr_task_serverver_idx"),
        ]

    def __str__(self) -> str:
        return f"Recurrence({self.frequency}) for task {self.task_id}"

    @property
    def project_id(self) -> Any:
        """Surface the parent project's id for the RBAC helpers.

        ``_get_project_id_from_obj`` (apps/access/permissions.py) derives object-level
        project context by reading ``obj.project_id``. A recurrence rule is task-scoped
        (project lives two hops away via ``task``), so without this property every
        object-level permission check (retrieve/update/destroy) would fail closed.
        Same pattern as ``TaskAttachment.project_id``.
        """
        return self.task.project_id

    def clean(self) -> None:
        """Enforce the conditional-field invariants per frequency and end type.

        Defined on the model so the DRF serializer (which calls clean() in validate)
        and the Django admin (which calls full_clean) enforce one set of rules. Code
        paths that bypass both — bulk writes, raw sync upserts — must call full_clean
        themselves if they need the same guarantees.
        """
        errors: dict[str, str] = {}
        if self.frequency == TaskRecurrenceFrequency.WEEKLY and not (self.weekdays & 0b111_1111):
            errors["weekdays"] = "Weekly recurrence requires at least one weekday."
        if self.frequency == TaskRecurrenceFrequency.MONTHLY and self.day_of_month is None:
            errors["day_of_month"] = "Monthly recurrence requires a day of month."
        if self.end_type == RecurrenceEndType.ON_DATE and self.end_date is None:
            errors["end_date"] = "end_date is required when end_type is ON_DATE."
        if self.end_type == RecurrenceEndType.AFTER_N and not self.end_count:
            errors["end_count"] = "end_count is required when end_type is AFTER_N."
        if errors:
            raise ValidationError(errors)


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
        validators=[
            MinValueValidator(-MAX_DEPENDENCY_LAG_DAYS),
            MaxValueValidator(MAX_DEPENDENCY_LAG_DAYS),
        ],
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
        indexes = [
            # Sync delta pull filters predecessor__project then server_version (#810).
            # Dependency has no direct project FK; (predecessor, server_version) lets
            # the per-predecessor join seek the changed rows without a full scan.
            models.Index(fields=["predecessor", "server_version"], name="dep_pred_serverver_idx"),
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
    # Story-point scope at snapshot time (ADR-0108 §3, #408). Nullable: a task may
    # have no points, and baselines captured before this field existed have None —
    # in which case scope_delta is reported as null (no baseline scope), never a
    # misleading zero. Mirrors the dates: a frozen snapshot of the committed scope.
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)

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
    """Standard risk source categories (risk framework, ADR-0043)."""

    TECHNICAL = "TECHNICAL", "Technical"
    EXTERNAL = "EXTERNAL", "External"
    ORGANIZATIONAL = "ORGANIZATIONAL", "Organizational"
    PROJECT_MANAGEMENT = "PROJECT_MANAGEMENT", "Project Management"


class RiskResponse(models.TextChoices):
    """Standard risk response strategies (risk framework, ADR-0043).

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
            # Sync delta pull: WHERE project_id = X AND server_version > since (#810).
            models.Index(fields=["project", "server_version"], name="risk_proj_serverver_idx"),
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
            self.short_id = _next_risk_short_id(self.project_id)
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
        status:    TaskStatus canonical value (see _CANONICAL_STATUSES in serializers.py)
        label:     display label (max 32 chars)
        visible:   boolean — hidden columns still hold tasks but don't appear on the board
        color:     accent hue as a ``#RRGGBB`` hex string, or null for no tint (#698).
                   Normalized by ``BoardColumnConfigSerializer.validate_color``.
        wip_limit: per-column work-in-progress ceiling as a positive int, or null
                   for no limit (#232). Drives the column-header WIP badge's
                   under/at/over three-band state on the board.
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


class SprintGoalOutcome(models.TextChoices):
    """Verdict on whether a sprint met its goal (#983), set at close.

    Defaulted at close from completion_ratio_points (>=0.8 MET / >=0.5 PARTIAL /
    else MISSED) and overridable by SCHEDULER+ — it is a team judgement, not a
    pure math result, so the override stands above the derived default. Null when
    no commitment baseline exists (teams that don't size in points).
    """

    MET = "MET", "Met"
    PARTIAL = "PARTIAL", "Partially met"
    MISSED = "MISSED", "Missed"


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
    # ADR-0106 §1 — binding provenance. The FK above is the single binding
    # edge; these three record WHO promoted, WHEN, and the committed-points
    # baseline AT PROMOTE TIME. The baseline is what drift is measured against
    # (binding_drifted = snapshot != current committed points), so a later
    # scope change lights a "scope changed since this milestone was bound"
    # caveat rather than silently moving the bound forecast underneath the PM.
    # The FK + these fields are immutable except through the promote/unbind
    # endpoints — that is the structural answer to "is the binding trustworthy?"
    # All three are NULL whenever target_milestone is NULL (unbound).
    milestone_bound_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    milestone_bound_at = models.DateTimeField(null=True, blank=True)
    binding_committed_snapshot = models.PositiveIntegerField(null=True, blank=True)
    # Planning target — what the team thinks they can take on at planning
    # time, set pre-activation by SCHEDULER+ and revisable mid-sprint as
    # people join/leave or take PTO (ADR-0073). Distinct from
    # committed_points (the immutable snapshot of what the backlog actually
    # held at activation) and from services.capacity_summary (which is
    # resource-allocation-based in hours). Null = "no points-based
    # planning target set" — the correct sentinel for teams that don't
    # size in points and for sprints created before ADR-0073.
    capacity_points = models.PositiveIntegerField(null=True, blank=True)
    # Optional WIP-overload threshold for the active sprint (#546). The
    # SprintPanel header surfaces "WIP {in-progress count}/{wip_limit}"
    # and flips to an at-risk color once the in-progress count exceeds it. This
    # is the cheap per-sprint signal, NOT a flow engine — per-column WIP limits
    # (BoardColumnConfig.wip_limit) and Kanban delivery_mode (#410) are separate.
    # Null = no limit set (chip suppressed). Editable on PLANNED + ACTIVE,
    # locked on COMPLETED + CANCELLED, SCHEDULER+ writes only — same field-level
    # gate as capacity_points (ADR-0073 sovereignty rule).
    wip_limit = models.PositiveIntegerField(null=True, blank=True)
    # Goal verdict (#983) — defaulted at close from completion_ratio_points and
    # overridable by SCHEDULER+ (the team's call beats the derived default). NOT
    # locked on COMPLETED like the planning knobs above: it is the *post-close*
    # judgement and stays editable. Null = no verdict (no commitment baseline, or
    # not yet closed).
    goal_outcome = models.CharField(  # noqa: DJ001 — null distinguishes "no verdict" from ""
        max_length=12,
        choices=SprintGoalOutcome.choices,
        null=True,
        blank=True,
    )
    # Team-owned escape hatch (ADR-0113): keep a setup/ramp-up sprint (a "Sprint 0")
    # out of the velocity average/band and the ADR-0106 milestone forecast, so its low
    # throughput does not contaminate the baseline. Editable in EVERY state — including
    # COMPLETED — because teams usually realise the contamination retrospectively; it only
    # filters which sprints `velocity_eligible_sprints()` selects and never mutates the
    # committed_*/completed_* snapshots. Change provenance is captured for free by the
    # HistoricalRecords audit trail below (who/when/old→new).
    exclude_from_velocity = models.BooleanField(default=False)
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
            # Sync delta pull: WHERE project_id = X AND server_version > since (#810).
            models.Index(fields=["project", "server_version"], name="sprint_proj_serverver_idx"),
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


class SprintTaskDisposition(models.TextChoices):
    """What happened to a task that was a member of a sprint at its close (#982)."""

    COMPLETED = "completed", "Completed in sprint"
    CARRIED = "carried", "Carried to another sprint"
    DROPPED = "dropped", "Dropped (not carried forward)"


class SprintTaskOutcome(models.Model):
    """Per-task membership-at-close snapshot for sprint review (ADR-0111, #982).

    One immutable row per task that was linked to the sprint at the instant it
    closed — written inside the close transaction *before* ``apply_carry_over``
    reassigns the task ``sprint`` FK. Without it, the "what didn't ship" set is
    destroyed at close: carried-over tasks move to the next sprint, dropped tasks
    move to the backlog, and the only trace is ``HistoricalTask`` for 90 days.

    Denormalized (``task_short_id`` / ``task_title`` / ``story_points`` /
    ``final_status``) so the review survives the FK move, the 90-day history
    window, and even a later hard-delete of the task (``task`` FK is SET_NULL).
    Append-only audit — like ``SprintBurnSnapshot`` it is unsynced and carries no
    ``server_version`` (immutability makes it unnecessary; review is an online
    read via the ``/outcome/`` endpoint, not an offline-synced row).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    sprint = models.ForeignKey(Sprint, on_delete=models.CASCADE, related_name="task_outcomes")
    task = models.ForeignKey(
        Task,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sprint_outcomes",
    )
    # Denormalized task identity — retained even if the task is later deleted.
    task_short_id = models.CharField(max_length=12)
    task_title = models.CharField(max_length=512)
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)
    final_status = models.CharField(max_length=20, choices=TaskStatus.choices)
    disposition = models.CharField(max_length=12, choices=SprintTaskDisposition.choices)
    # For CARRIED rows: the sprint the task moved to. SET_NULL so deleting the
    # destination sprint doesn't cascade away this audit row.
    next_sprint = models.ForeignKey(
        Sprint,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    # ADR-0102 sprint_pending at close — distinguishes committed work that didn't
    # ship from uncommitted injected work that didn't ship.
    was_pending = models.BooleanField(default=False)
    # True when written by the optional backfill command (best-effort from
    # HistoricalTask), False for rows captured live at close (ADR-0111 §4).
    backfilled = models.BooleanField(default=False)
    # Review-time curation (ADR-0118, #924): whether the team will walk
    # stakeholders through this story in the Sprint Review demo. The close-snapshot
    # fields above are immutable; this one flag is deliberately mutable post-close
    # (curation happens *at* the review). Toggled team-owned (Member+) via the
    # toggle-demo endpoint; not synced (this model has no server_version — the
    # review is an online read, propagated by the board broadcast + refetch).
    demo_ready = models.BooleanField(default=False)
    # Review-time curation (ADR-0118 amend, #1130): the order the team will walk
    # stakeholders through the demo (dense 1..N within demo-flagged rows; 0 = unset)
    # and a free-text presenter name per story. Mutable post-close like demo_ready —
    # curation happens *at* the review; the close-snapshot fields above stay immutable.
    demo_order = models.PositiveIntegerField(default=0)
    presenter = models.CharField(max_length=120, blank=True, default="")
    # Contributor note left at review on a criteria-incomplete / criteria-not-set
    # story (#1131) — optional, "visible to reviewers", never required (Priya's
    # no-required-data-entry constraint). Mutable post-close.
    review_note = models.CharField(max_length=200, blank=True, default="")
    # One-tap carry-forward (#1132): the backlog Task created from this not-shipped
    # story, so the action is idempotent (a second tap is a no-op) and the UI can
    # show a flagged state. SET_NULL so deleting the backlog item doesn't cascade
    # away this audit row.
    flagged_to_backlog_task = models.ForeignKey(
        Task,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "projects_sprinttaskoutcome"
        ordering = ["sprint_id", "task_short_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["sprint", "task"],
                name="uniq_sprint_task_outcome",
            ),
        ]
        indexes = [
            models.Index(fields=["sprint", "disposition"], name="sprint_outcome_disp_idx"),
        ]

    def __str__(self) -> str:
        return f"SprintTaskOutcome({self.sprint_id} {self.task_short_id} {self.disposition})"

    @property
    def project_id(self) -> Any:
        """Project PK via sprint, so RBAC's ``_get_project_id_from_obj`` resolves
        object-level permission on the flat /sprint-task-outcomes/ route (ADR-0118)."""
        return self.sprint.project_id


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
    # ADR-0102 §7: how to dispose of tasks still pending acceptance at close.
    # 'carry' (default) re-flags carried-over pending tasks sprint_pending=True
    # into the incoming sprint and records a fresh PENDING SprintScopeChange
    # against it; 'reject' rejects them (removes from the sprint). Closing is
    # never blocked by pending items — pending was never in committed_points, so
    # velocity is correct either way.
    pending_disposition = models.CharField(
        max_length=8,
        default="carry",
        help_text="'carry' (default) or 'reject' — pending-scope disposition at close.",
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


class RetroVisibility(models.TextChoices):
    """Who can read raw retro notes and action item text (ADR-0071 §3).

    Aggregate counts (action_items_count, promoted_count) are always
    visible to project members regardless of visibility — only the
    free-text body is gated. The enterprise portfolio rollup consumes
    only aggregate counts, never raw text.
    """

    TEAM_ONLY = "team_only"  # role >= MEMBER on the project (default)
    PROJECT = "project"  # any project member including VIEWER
    # any member of a project in the same program (Program from ADR-0070;
    # falls back to PROJECT until programs ship)
    ORG = "org"


class SprintRetro(VersionedModel):
    """Retrospective notes attached to a sprint (one-to-one).

    Created by the team during or after sprint close. The free-text
    ``notes`` field captures the meeting summary; structured action items
    live on the related ``RetroActionItem`` rows. The Sprints view renders
    the retro panel beneath the timeline strip when the sprint is in
    ``COMPLETED`` state, and inline during the active close window.

    Extends VersionedModel (ADR-0071) so the retro participates in mobile
    delta sync and so the audit history is queryable per ADR-0010.
    """

    sprint = models.OneToOneField(
        Sprint,
        on_delete=models.CASCADE,
        related_name="retro",
    )
    notes = models.TextField(blank=True, default="")
    team_visibility = models.CharField(
        max_length=12,
        choices=RetroVisibility.choices,
        default=RetroVisibility.TEAM_ONLY,
    )
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
        indexes = [
            # Sync delta pull joins via sprint then filters server_version (#810).
            models.Index(fields=["sprint", "server_version"], name="retro_sprint_serverver_idx"),
        ]

    def __str__(self) -> str:
        return f"Retro({self.sprint_id})"


class RetroActionItem(VersionedModel):
    """A single action item from a sprint retrospective.

    Items can be promoted to actual tasks in a future sprint via the
    ``promoted_task_id`` field — set to the new task's UUID once the
    promote endpoint creates it. Until promoted the item is a free-floating
    note; after promotion the UI renders a `T-XXX` link back to the task
    so the team can see the action item closed the loop.

    Extends VersionedModel (ADR-0071) so action items participate in
    mobile delta sync alongside their parent retro.
    """

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
    # On Task soft-delete, a post_delete signal resets this column to NULL
    # so the action item can be re-promoted (ADR-0071 §2 rollback).
    promoted_task_id = models.UUIDField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "projects_retroactionitem"
        ordering = ["created_at"]
        indexes = [
            # Sync delta pull joins via retro then filters server_version (#810).
            models.Index(fields=["retro", "server_version"], name="rai_retro_serverver_idx"),
        ]

    def __str__(self) -> str:
        return f"RetroActionItem({self.id}, retro={self.retro_id})"


# ---------------------------------------------------------------------------
# Live multi-writer retro board + team-health pulse (ADR-0117, #851 / #923)
# ---------------------------------------------------------------------------


class RetroColumn(models.TextChoices):
    """The three fixed columns of the live retro board (ADR-0117 §2).

    Stored as a string key (not an FK) so a future per-team configurable
    column template (ADR-0107) is additive with no data migration of existing
    stickies. The three columns cover the dominant retro formats — Glad/Sad/Mad
    and Start/Stop/Continue both map onto went-well / to-improve / ideas.
    """

    WENT_WELL = "went_well", "What went well"
    TO_IMPROVE = "to_improve", "What to improve"
    IDEAS = "ideas", "Ideas & discussion"


class RetroBoardItem(VersionedModel):
    """A single live sticky-note on the multi-writer retro board (ADR-0117 §1).

    Distinct from ``RetroActionItem``: a board item is *discussion* content the
    whole team brainstorms concurrently during the live ceremony, whereas an
    action item is a *distilled outcome* that carries an assignee + story points
    and promotes to the backlog (#858). Conflating them was rejected (ADR-0117
    Alternative B) — the outcome fields would pollute a brainstorm sticky and the
    single-author upsert endpoint is the wrong write path for concurrent editing.

    Concurrency is per-item last-write-wins on ``server_version`` (ADR-0117 §3):
    each sticky is an independent row, the common case is different people editing
    different stickies, and the rare same-sticky collision resolves by
    last-save-wins with the loser reconciling on the next sync delta — the same
    contract the board-event channel already runs on. ``VersionedModel`` makes the
    board ride the existing WatermelonDB delta protocol offline for free.
    """

    retro = models.ForeignKey(
        SprintRetro,
        on_delete=models.CASCADE,
        related_name="board_items",
    )
    column = models.CharField(
        max_length=12,
        choices=RetroColumn.choices,
        default=RetroColumn.WENT_WELL,
    )
    text = models.TextField()
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="retro_board_items",
    )
    # Fractional index for ordering within a column: inserting between two
    # neighbours uses the midpoint of their positions, so a drag-reorder rewrites
    # one row, not the whole column (ADR-0110 reorder idiom). Float is sufficient
    # at retro scale (a few dozen short stickies, rare reorders).
    position = models.FloatField(default=0.0)
    # Optional Design-System swatch key (presentation only, e.g. "sage"); never
    # carries meaning — color is decorative on a sticky (ADR-0117 §8 a11y).
    color = models.CharField(max_length=16, blank=True, default="")
    # Set to the RetroActionItem.id once this sticky has been converted to an
    # action item (ADR-0117 §1). Makes convert-to-action idempotent: a second
    # convert is a no-op returning the existing action item (ADR-0117 §DE.7).
    converted_action_item_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_retroboarditem"
        ordering = ["column", "position", "created_at"]
        indexes = [
            # Board read groups by column then position; sync delta filters on
            # server_version after joining via retro (#810 pattern).
            models.Index(fields=["retro", "column", "position"], name="rbi_retro_col_pos_idx"),
            models.Index(fields=["retro", "server_version"], name="rbi_retro_serverver_idx"),
        ]

    def __str__(self) -> str:
        return f"RetroBoardItem({self.id}, retro={self.retro_id}, col={self.column})"

    @property
    def project_id(self) -> Any:
        """Project PK via retro→sprint, so RBAC's ``_get_project_id_from_obj`` resolves.

        Object-level permission checks read ``obj.project_id``; the board item reaches
        the project through ``retro.sprint``. Viewsets ``select_related('retro__sprint')``
        so this property never N+1s on a list.
        """
        return self.retro.sprint.project_id


class PulseResponse(VersionedModel):
    """One team member's mood/energy/confidence answer for a sprint's retro (#923).

    The team-health pulse (ADR-0117 §5) consumes ADR-0104's already-built ``pulse``
    signal gate verbatim: the per-sprint trend is read **only** by the team + Scrum
    Master/coach band, omitted *entirely* (no redacted aggregate) for the PM/PMO
    band, and denied to non-members — Morgan's hard 🔴. This model stores only the
    raw responses; the trend is computed as an aggregate (never an individual's raw
    answer is exposed, except the requester's own echoed back so they can change it).

    ``unique(retro, respondent)`` makes the answer a one-tap upsert: re-tapping
    updates rather than duplicating, satisfying "one tap" without locking the
    answer. ``confidence`` is the optional third dimension.
    """

    retro = models.ForeignKey(
        SprintRetro,
        on_delete=models.CASCADE,
        related_name="pulse_responses",
    )
    respondent = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="retro_pulse_responses",
    )
    mood = models.PositiveSmallIntegerField()  # 1..5
    energy = models.PositiveSmallIntegerField()  # 1..5
    confidence = models.PositiveSmallIntegerField(null=True, blank=True)  # 1..5, optional
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_pulseresponse"
        constraints = [
            # One response per person per sprint retro — the upsert key. Scoped to
            # live rows so a soft-deleted prior response never blocks a re-answer.
            models.UniqueConstraint(
                fields=["retro", "respondent"],
                condition=models.Q(is_deleted=False),
                name="uniq_pulse_retro_respondent_live",
            ),
        ]
        indexes = [
            models.Index(fields=["retro", "server_version"], name="pulse_retro_serverver_idx"),
        ]

    def __str__(self) -> str:
        return f"PulseResponse({self.id}, retro={self.retro_id}, by={self.respondent_id})"


class SuggestionSource(models.TextChoices):
    """Why a TaskSuggestedAssignee was created (ADR-0071 §5)."""

    RETROSPECTIVE = "retrospective"
    OTHER = "other"  # reserved for future suggestion sources


class SuggestionState(models.TextChoices):
    """Lifecycle states for TaskSuggestedAssignee.

    PENDING → ACCEPTED: suggested_user accepted; Task.assignee bound.
    PENDING → DECLINED: suggested_user declined; no binding.
    PENDING → REVOKED: suggested_by (or ADMIN) withdrew before action.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    REVOKED = "revoked"


class TaskSuggestedAssignee(VersionedModel):
    """A soft suggestion that a user own a Task, awaiting their acceptance.

    Created when a retro action item is promoted with an assignee who is
    not the actor of the promote call (i.e. the SM suggests another team
    member). The suggested_user sees the suggestion on their My Work
    surface and accepts (binds Task.assignee) or declines.

    A Task may carry many suggestions over its lifetime (one per
    suggested_user); the partial unique constraint allows at most one
    PENDING suggestion per (task, suggested_user) pair so a repeated
    promote does not flood the user with duplicates.
    """

    task = models.ForeignKey(
        Task,
        on_delete=models.CASCADE,
        related_name="suggested_assignees",
    )
    suggested_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="task_suggestions",
    )
    suggested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="suggestions_made",
    )
    reason = models.TextField(blank=True, default="")
    source = models.CharField(
        max_length=24,
        choices=SuggestionSource.choices,
        default=SuggestionSource.RETROSPECTIVE,
    )
    state = models.CharField(
        max_length=12,
        choices=SuggestionState.choices,
        default=SuggestionState.PENDING,
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    accepted_at = models.DateTimeField(null=True, blank=True)
    declined_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "projects_tasksuggestedassignee"
        constraints = [
            models.UniqueConstraint(
                fields=["task", "suggested_user"],
                condition=Q(state="pending", is_deleted=False),
                name="unique_pending_suggestion_per_user_per_task",
            ),
        ]
        indexes = [
            models.Index(
                fields=["suggested_user", "state"],
                name="suggestion_user_state_idx",
            ),
            models.Index(
                fields=["task", "state"],
                name="suggestion_task_state_idx",
            ),
            # Sync delta pull joins via task then filters server_version (#810).
            models.Index(fields=["task", "server_version"], name="tsa_task_serverver_idx"),
        ]

    def __str__(self) -> str:
        return (
            f"TaskSuggestedAssignee(task={self.task_id}, "
            f"user={self.suggested_user_id}, state={self.state})"
        )


# ---------------------------------------------------------------------------
# Sprint scope-change audit (ADR-0060 #308)
# ---------------------------------------------------------------------------


class ScopeChangeStatus(models.TextChoices):
    """Decision outcome for a mid-sprint scope injection (ADR-0102 §1).

    The *audit* record of the accept-gate decision (who, when, outcome). It is
    NOT the source of truth for the commitment/burndown math — that is
    ``Task.sprint_pending`` (the three math paths query Task, not this audit
    row). The two are written together in one transaction by the accept/reject
    service functions and can never disagree.

    ADR-0102 §3 invariant — *no policy input*: the PENDING→ACCEPTED/REJECTED
    transition has zero policy/extension hook. The ONLY writers of ACCEPTED /
    REJECTED are the human-invoked ``accept_scope_change`` / ``reject_scope_change``
    services behind the role>=ADMIN + project-membership gated endpoints. The
    ``sprint_scope_changed`` signal is notify-only; the ``guardrail_policy_resolving``
    resolver supplies policy, never actions. Enterprise authors must not mistake
    this for an extensible hook — there is no auto-accept path by design (the
    sprint-sovereignty back-door close, VoC 🔴 #1).
    """

    PENDING = "pending", "Pending acceptance"
    ACCEPTED = "accepted", "Accepted into commitment"
    REJECTED = "rejected", "Rejected — removed from sprint"


class SprintScopeChange(models.Model):
    """Records each item injected into a task's ACTIVE sprint mid-sprint.

    Generalized in ADR-0101 §5 / ADR-0102 beyond the original subtask-spawn
    path: a row is now written whenever *any* task is linked to an ACTIVE sprint
    after activation (subtask spawn, direct assignment, drawer, API), all routed
    through the ``record_sprint_scope_change`` service helper.

    Rows are the canonical source for the scope-change indicator surfaced in the
    parent task's drawer SprintSection.  They survive subtask deletion (subtask_name
    is denormalized) so the audit trail is complete even if the subtask is later
    removed.  Rows are cleared when the sprint closes (SprintCloseRequest drain
    deletes rows for the sprint on completion).

    The ``sprint_scope_changed`` signal is fired after the row is saved so that
    Enterprise audit receivers can capture the event without modifying OSS code.

    ADR-0102: ``status`` is the audit of the accept-gate decision; the math
    exclusion lives on ``Task.sprint_pending``. See ``ScopeChangeStatus`` for the
    no-auto-accept invariant.

    Plain models.Model (not VersionedModel): scope-change rows are not synced to
    mobile; they are display metadata for the scope-change indicator chip only.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # The parent task whose sprint membership is affected.
    task = models.ForeignKey(
        Task,
        on_delete=models.CASCADE,
        related_name="sprint_scope_changes",
    )
    sprint = models.ForeignKey(
        "Sprint",
        on_delete=models.CASCADE,
        related_name="scope_changes",
    )
    # Denormalized — survives subtask deletion.
    #
    # Generalized in ADR-0101: this column now labels *any* item injected into an
    # active sprint, not only a spawned subtask. The legacy name is retained as a
    # column so existing rows and the deprecated read alias keep working for one
    # release; ``item_name`` is the forward-looking accessor (see ``item_name``).
    subtask_name = models.CharField(max_length=512)
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sprint_scope_changes_added",
    )
    added_at = models.DateTimeField(auto_now_add=True)
    # ADR-0101 §5: does this injected item advance the sprint's target_milestone
    # (or carry committed points)? Surfaces the "goal impact" flag on the board
    # banner and the drawer scope-change rows so the team can see at a glance
    # whether the late addition threatens the Sprint Goal, not just the count.
    goal_impact = models.BooleanField(default=False)
    # ADR-0102 §1: audit of the accept-gate decision. Default PENDING; flipped to
    # ACCEPTED/REJECTED only by the accept/reject services (no auto-accept path).
    # Indexed so the per-sprint pending list / pending_count are cheap.
    status = models.CharField(
        max_length=12,
        choices=ScopeChangeStatus.choices,
        default=ScopeChangeStatus.PENDING,
        db_index=True,
    )

    class Meta:
        db_table = "projects_sprintscopechange"
        ordering = ["added_at"]
        indexes = [
            models.Index(fields=["task", "sprint"], name="scope_change_task_sprint_idx"),
            # Per-sprint pending list (bulk accept/reject body resolution) and the
            # sprint.pending_count annotation filter on (sprint, status).
            models.Index(fields=["sprint", "status"], name="scope_change_sprint_status_idx"),
        ]

    def __str__(self) -> str:
        return f"SprintScopeChange(task={self.task_id}, sprint={self.sprint_id})"

    @property
    def item_name(self) -> str:
        """Forward-looking accessor for the injected item's display name.

        ADR-0101 generalized scope-injection beyond subtasks; ``item_name`` is the
        name new code should read. Backed by ``subtask_name`` until that column is
        renamed in a later release (kept now to avoid a breaking sync/payload change).
        """
        return self.subtask_name


class GuardrailRule(models.TextChoices):
    """Sprint/Phase/WBS guardrail rule keys (ADR-0101).

    Each rule is a legal-but-usually-wrong state the model permits but that almost
    always indicates a mistake. The string values are the stable contract shared
    with the web client (which evaluates the same rules offline) and with the
    structured ``guardrail_blocked`` error payload — do not rename without a
    coordinated frontend + sync change.

    The first four are *sprint-composition* rules: they may be escalated to a hard
    block, but only by the project Owner (or an acknowledged external policy) —
    sprint composition is the team's domain. ``SUBTASKS_SPLIT`` is advisory-only
    (it has no single offending assignment to block) and is never escalatable.
    """

    SUMMARY_IN_SPRINT = "summary_in_sprint", "Summary task in a sprint"
    PHASE_IN_SPRINT = "phase_in_sprint", "Phase in a sprint"
    TASK_OUTSIDE_SPRINT_WINDOW = (
        "task_outside_sprint_window",
        "Task scheduled outside its sprint window",
    )
    RECURRING_IN_SPRINT = "recurring_in_sprint", "Recurring task in a sprint"
    SUBTASKS_SPLIT = "subtasks_split", "Subtasks split across sprints"


# Composition rules that may be escalated warn->block (ADR-0101 §3). SUBTASKS_SPLIT
# is intentionally excluded: it is advisory and has no single assignment to reject.
COMPOSITION_GUARDRAIL_RULES: frozenset[str] = frozenset(
    {
        GuardrailRule.SUMMARY_IN_SPRINT,
        GuardrailRule.PHASE_IN_SPRINT,
        GuardrailRule.TASK_OUTSIDE_SPRINT_WINDOW,
        GuardrailRule.RECURRING_IN_SPRINT,
    }
)


class GuardrailLevel(models.TextChoices):
    """Enforcement level for a guardrail rule (ADR-0101).

    WARN (default): the assignment proceeds; the client shows a non-blocking notice
    with a one-tap override and an always-optional reason.
    BLOCK: the serializer rejects the assignment with a structured
    ``guardrail_blocked`` error, overridable only by removing the offending state.
    """

    WARN = "warn", "Warn"
    BLOCK = "block", "Block"


class GuardrailPolicySource(models.TextChoices):
    """Origin of a guardrail policy (ADR-0101 sprint-sovereignty gate).

    OWNER: set by the project's own Owner — takes effect immediately.
    EXTERNAL: supplied by a registered Enterprise resolver (cross-program policy
        template / org-imposed enforcement). An EXTERNAL block is *inert* until the
        team acknowledges it (``acknowledged_by_team``), and a persistent banner
        names who set it — enforced here in OSS so a high-ordinal custom role
        (ADR-0072) cannot silently impose a block over the team.
    """

    OWNER = "owner", "Project owner"
    EXTERNAL = "external", "External policy"


class ProjectGuardrailPolicy(VersionedModel):
    """Per-project guardrail enforcement policy (ADR-0101 §3).

    One row per Project (1:1), created lazily on first GET via ``get_or_create`` in
    the view layer so existing projects need no data migration. ``levels`` maps each
    :class:`GuardrailRule` value to a :class:`GuardrailLevel` value; a rule absent
    from the map defaults to WARN.

    Composition rules may only be set to BLOCK when ``source == OWNER`` *or*
    ``source == EXTERNAL and acknowledged_by_team`` — the OSS-enforced sprint-
    sovereignty gate. The level write itself is additionally permission-gated at the
    view (``role >= Role.OWNER``); this model holds the inertness rule so it cannot
    be bypassed by a caller that reaches the model directly (e.g. the Enterprise
    resolver).
    """

    project = models.OneToOneField(
        Project,
        on_delete=models.CASCADE,
        related_name="guardrail_policy",
    )
    # {rule_key: level}. Rules absent default to WARN. Stored as JSON rather than
    # a column-per-rule so adding a future rule needs no migration.
    levels = models.JSONField(default=dict, blank=True)
    source = models.CharField(
        max_length=16,
        choices=GuardrailPolicySource.choices,
        default=GuardrailPolicySource.OWNER,
    )
    # Who set an EXTERNAL policy (display name for the team-ack banner). Empty for
    # OWNER-sourced policies. Free text — the Enterprise resolver supplies it.
    source_label = models.CharField(max_length=255, blank=True, default="")
    # An EXTERNAL composition-block is inert until this is True (ADR-0101).
    acknowledged_by_team = models.BooleanField(default=False)
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    # Declared explicitly so django-stubs resolves the manager and the FK_id on a
    # VersionedModel subclass that also carries HistoricalRecords (the plugin
    # otherwise loses ``objects``/``project_id`` here — see project memory
    # feedback_cross_app_versionedmodel_stubs).
    objects = models.Manager()

    class Meta:
        db_table = "projects_guardrail_policy"

    def __str__(self) -> str:
        return f"ProjectGuardrailPolicy({self.pk})"

    def effective_level(self, rule: str) -> str:
        """Return the *enforced* level for ``rule``, applying the sovereignty gate.

        A composition rule set to BLOCK by an EXTERNAL source that the team has not
        acknowledged is downgraded to WARN — the block is inert until acknowledged.
        OWNER-sourced blocks, and acknowledged EXTERNAL blocks, are returned as-is.
        """
        level = self.levels.get(rule, GuardrailLevel.WARN)
        if level != GuardrailLevel.BLOCK:
            return GuardrailLevel.WARN
        if (
            rule in COMPOSITION_GUARDRAIL_RULES
            and self.source == GuardrailPolicySource.EXTERNAL
            and not self.acknowledged_by_team
        ):
            return GuardrailLevel.WARN
        return GuardrailLevel.BLOCK


# ---------------------------------------------------------------------------
# Team-signal privacy — ADR-0104 (#553 / #854 / #923)
# ---------------------------------------------------------------------------


class SignalAudience(models.TextChoices):
    """How far a team signal may travel — one ordered ladder (ADR-0104 §1).

    Strictly ordered: TEAM < TEAM_SM < TEAM_SM_PM < PROGRAM_SHARED. The order is
    load-bearing — ``audience_can_read`` compares a requester's tier against the
    signal's configured audience on this ladder, and the ``audience <= ceiling``
    invariant is an ordinal comparison. :data:`SIGNAL_AUDIENCE_LADDER` pins the
    canonical order so the comparison never depends on enum declaration order or
    string sorting.

    PROGRAM_SHARED is the single opt-in rung that makes a signal eligible for the
    cross-team rollup (the Enterprise extension point); nothing reaches it without
    a team raising a ceiling there.
    """

    TEAM = "team", "Team only"
    TEAM_SM = "team_sm", "Team + Scrum Master"
    TEAM_SM_PM = "team_sm_pm", "Team + SM + PM"
    PROGRAM_SHARED = "program_shared", "Shared to program rollup (opt-in)"


# Canonical rung order for ordinal comparisons (ladder position 0..3). A reader's
# tier and a signal's audience/ceiling are all SignalAudience values; comparing
# them means comparing these positions, never the raw strings.
SIGNAL_AUDIENCE_LADDER: list[str] = [
    SignalAudience.TEAM,
    SignalAudience.TEAM_SM,
    SignalAudience.TEAM_SM_PM,
    SignalAudience.PROGRAM_SHARED,
]


def signal_audience_rank(value: str) -> int:
    """Ladder position (0..3) of a SignalAudience value, for ordinal comparison."""
    return SIGNAL_AUDIENCE_LADDER.index(value)


# The three governed signals and their coded {audience, ceiling} defaults
# (ADR-0104 §1). An absent signal — or an absent key — resolves to these. Every
# audience defaults to TEAM (nothing is exposed upward by default); the ceiling
# encodes how far the team has authorized a signal *may* go.
SIGNAL_DEFAULTS: dict[str, dict[str, str]] = {
    # velocity (#553): TEAM/TEAM preserves today's any-member read and makes even
    # raising it a deliberate team-owned ceiling act.
    "velocity": {"audience": SignalAudience.TEAM, "ceiling": SignalAudience.TEAM},
    # throughput_rollup (#854): the per-project rollup opt-in *is* raising audience
    # to PROGRAM_SHARED; the ceiling already permits it, so consent is one step.
    "throughput_rollup": {
        "audience": SignalAudience.TEAM,
        "ceiling": SignalAudience.PROGRAM_SHARED,
    },
    # pulse (#923): most private; locked to team by default, team-raisable only.
    "pulse": {"audience": SignalAudience.TEAM, "ceiling": SignalAudience.TEAM},
}


class ProjectSignalPrivacyPolicy(VersionedModel):
    """Per-project team-signal privacy posture — one ladder for three signals.

    One row per Project (1:1), created lazily on first GET via ``get_or_create`` so
    existing projects need no data migration (the ``ProjectGuardrailPolicy`` idiom).
    ``signal_visibility`` maps each signal key to a ``{audience, ceiling}`` pair;
    an absent signal or key resolves to :data:`SIGNAL_DEFAULTS`. Stored as JSON so a
    future signal needs no migration.

    The two values per signal carry the sprint-sovereignty contract (ADR-0104 §1.1):
    ``audience`` is where a signal sits now and ``ceiling`` is the furthest the team
    has authorized, with the invariant ``audience <= ceiling`` on the ladder. The
    invariant and the two write gates (set-audience vs the team-owned raise-ceiling)
    are enforced in ``signal_privacy_services`` — a JSON map cannot carry a per-key
    DB ``CheckConstraint``, and the model deliberately exposes no bare field write.
    """

    project = models.OneToOneField(
        Project,
        on_delete=models.CASCADE,
        related_name="signal_privacy_policy",
    )
    # {signal_key: {"audience": SignalAudience, "ceiling": SignalAudience}}. Absent
    # signals/keys resolve to SIGNAL_DEFAULTS. JSON (not column-per-signal) so a new
    # signal needs no migration.
    signal_visibility = models.JSONField(default=dict, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_BASE)

    # Declared explicitly so django-stubs resolves the manager / project_id on a
    # VersionedModel subclass that also carries HistoricalRecords (project memory
    # feedback_cross_app_versionedmodel_stubs).
    objects = models.Manager()

    class Meta:
        db_table = "projects_signal_privacy_policy"

    def __str__(self) -> str:
        return f"ProjectSignalPrivacyPolicy({self.pk})"

    def resolved(self, signal_key: str) -> dict[str, str]:
        """Return the effective ``{audience, ceiling}`` for a signal.

        Merges the stored override (which may carry only one of the two keys) over
        the coded default, so a partially-written entry never loses the missing
        half. Unknown signal keys fall back to a TEAM/TEAM (fully private) shape.
        """
        default = SIGNAL_DEFAULTS.get(
            signal_key, {"audience": SignalAudience.TEAM, "ceiling": SignalAudience.TEAM}
        )
        stored = self.signal_visibility.get(signal_key, {})
        return {
            "audience": stored.get("audience", default["audience"]),
            "ceiling": stored.get("ceiling", default["ceiling"]),
        }

    def audience_of(self, signal_key: str) -> str:
        """Current audience of a signal (the value the read gate consults)."""
        return self.resolved(signal_key)["audience"]

    def ceiling_of(self, signal_key: str) -> str:
        """Team-authorized ceiling of a signal (bounds writes, never reads)."""
        return self.resolved(signal_key)["ceiling"]


# ---------------------------------------------------------------------------
# Inbound task-sync — ADR-0068 / issue #500 (Gap 3 of ADR-0065)
# ---------------------------------------------------------------------------


class ApiToken(VersionedModel):
    """API token for inbound integrations — polymorphically scoped to either
    a Project or a Program (ADR-0068 + ADR-0076 extension).

    The raw token is shown exactly once at creation, then stored as a SHA-256 hex
    digest in ``token_hash``.  Lookup is O(1) via the unique index on the hash;
    a non-match returns no row, which prevents the timing-attack class that
    constant-time string compare would defend against.

    ``token_prefix`` carries the first 8 hex chars of the raw token so audit-log
    entries can identify which token was used without revealing it.  The
    ``tppm_`` prefix on the raw token is greppable for secret-scanners
    (GitGuardian, GitHub) but is *not* stored — only the random portion counts.

    **Scope**: exactly one of ``project`` or ``program`` is set. A program-scoped
    token authorizes inbound writes into any project within that program; the
    caller specifies the target project on each request via the URL. The DB
    constraint enforces the XOR — neither both-set nor both-null is a valid row.

    ``status_map`` is immutable after creation by design: changing it requires
    minting a new token and revoking the old one, so the team can see (via the
    audit log + broadcast) when their status mapping changes.  Prevents the
    silent-remap-of-done failure mode (Morgan's 🟡 VoC concern).

    The DB table is kept at ``projects_api_token`` for migration safety —
    renaming the table would require coordinated cutovers; the Python class
    rename is purely cosmetic at the DB level.
    """

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="api_tokens",
        null=True,
        blank=True,
        help_text="Set when the token authorizes writes into a single project. "
        "Exactly one of project/program is non-null (DB constraint).",
    )
    program = models.ForeignKey(
        "projects.Program",
        on_delete=models.CASCADE,
        related_name="api_tokens",
        null=True,
        blank=True,
        help_text="Set when the token authorizes writes into any project within "
        "this program. Exactly one of project/program is non-null (DB constraint).",
    )
    name = models.CharField(
        max_length=128,
        help_text="Human-readable label (e.g. 'Jira Production').  Not unique.",
    )
    token_prefix = models.CharField(
        max_length=8,
        db_index=True,
        help_text="First 8 hex chars of the raw token (for audit identification).",
    )
    token_hash = models.CharField(
        max_length=64,
        unique=True,
        help_text="SHA-256 hex digest of the raw token.",
    )
    status_map = models.JSONField(
        default=dict,
        blank=True,
        help_text="Maps external source-status strings → TaskStatus values.  "
        "Empty dict falls back to the default map: "
        "{'todo': 'NOT_STARTED', 'in_progress': 'IN_PROGRESS', 'done': 'COMPLETE'}.",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="api_tokens_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Updated by the authenticator on each successful inbound request.",
    )
    revoked_at = models.DateTimeField(
        null=True,
        blank=True,
        db_index=True,
        help_text="Set when an Admin/PM revokes the token.  Non-null = inactive.",
    )

    class Meta:
        db_table = "projects_api_token"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["project", "revoked_at"]),
            models.Index(fields=["program", "revoked_at"]),
        ]
        constraints = [
            models.CheckConstraint(
                # Exactly one of project / program is non-null. Prevents
                # ambiguous-scope tokens at the database layer.
                condition=(
                    Q(project__isnull=False, program__isnull=True)
                    | Q(project__isnull=True, program__isnull=False)
                ),
                name="api_token_scope_xor",
            ),
        ]

    def __str__(self) -> str:
        if self.program_id is not None:
            return f"ApiToken({self.token_prefix}…, program={self.program_id})"
        return f"ApiToken({self.token_prefix}…, project={self.project_id})"

    @property
    def is_program_scoped(self) -> bool:
        """True when this token authorizes writes into any project in a program."""
        return self.program_id is not None


# Backwards-compat alias for any external code that still imports the old name.
# Slated for removal in 0.4 once the rename has propagated through downstream
# consumers (Helm chart, OSS contrib docs).
ProjectApiToken = ApiToken


class InboundTaskLink(VersionedModel):
    """One row per (project, source, external_id) — links a Task to its external origin.

    The unique constraint is partial on ``is_deleted=False`` so a re-push of the
    same external_id after the Task is soft-deleted creates a new link + new
    Task.  The historical link row is preserved for audit.

    ``parent_external_id`` records the external system's parent (e.g. Jira epic
    key) so the receiver can re-establish hierarchy when the parent's own link
    row arrives.  Resolution happens at write time: if a matching parent link
    exists in the same (project, source) scope, the new Task is created as a
    subtask under the parent's wbs_path.  No match → flat BACKLOG item.

    ``pending_assignee_email`` is populated when the inbound assignee_email
    does not match any project member.  The PM-visible
    ``unresolved_assignee_count`` field on the project detail response surfaces
    this so PMs have a triage signal (Sarah's 🟡 VoC concern).

    ``created_via_token`` and ``last_synced_via_token`` are SET_NULL so token
    deletion does not cascade-delete the link rows that depended on it.
    """

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="inbound_links",
    )
    task = models.ForeignKey(
        Task,
        on_delete=models.CASCADE,
        related_name="inbound_links",
    )
    source = models.CharField(
        max_length=32,
        help_text="External source key — 'jira', 'linear', 'github', 'custom'.",
    )
    external_id = models.CharField(
        max_length=255,
        help_text="The external system's identifier (e.g. 'PROJ-123').",
    )
    external_url = models.URLField(  # noqa: DJ001 — null distinguishes "not provided" from ""
        max_length=2000,
        null=True,
        blank=True,
        help_text="Optional canonical URL of the external task.",
    )
    parent_external_id = models.CharField(  # noqa: DJ001
        max_length=255,
        null=True,
        blank=True,
        help_text="External system's parent identifier (e.g. Jira epic key).",
    )
    pending_assignee_email = models.EmailField(  # noqa: DJ001
        max_length=254,
        null=True,
        blank=True,
        help_text="Set when assignee_email did not match a project member.  "
        "Resolved on a subsequent push if the user joins the project.",
    )
    created_via_token = models.ForeignKey(
        ProjectApiToken,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_links",
    )
    last_synced_via_token = models.ForeignKey(
        ProjectApiToken,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    last_synced_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_inbound_task_link"
        ordering = ["-last_synced_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "source", "external_id"],
                condition=Q(is_deleted=False),
                name="uniq_inbound_link_per_source",
            ),
        ]
        indexes = [
            models.Index(
                fields=["project", "pending_assignee_email"],
                condition=Q(is_deleted=False, pending_assignee_email__isnull=False),
                name="inbound_link_pending_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"InboundTaskLink({self.source}:{self.external_id} → task={self.task_id})"


class ApiTokenAuditAction(models.TextChoices):
    MINTED = "minted", "Minted"
    REVOKED = "revoked", "Revoked"
    USED = "used", "Used"


class ApiTokenAuditEntry(models.Model):
    """Append-only audit log for project API token lifecycle and use.

    Resolves Marcus + Morgan VoC 🟡: every mint/revoke/use is queryable for the
    auditor and visible to project members.  Status-map changes are not a
    distinct action because status_map is immutable (a change requires a new
    token, which lands as a ``minted`` entry).

    ``token_prefix`` is denormalized so the row remains identifiable after the
    parent token is deleted (FK is SET_NULL).  Plain models.Model (not
    VersionedModel) — audit rows are not synced to mobile.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Scope mirrors ApiToken: project XOR program (ADR-0076 program extension).
    # project becomes nullable so program-scoped tokens can be audited; existing
    # rows are all project-scoped and satisfy the XOR (program null).
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="api_token_audit",
        null=True,
        blank=True,
    )
    program = models.ForeignKey(
        "projects.Program",
        on_delete=models.CASCADE,
        related_name="api_token_audit",
        null=True,
        blank=True,
    )
    token = models.ForeignKey(
        ProjectApiToken,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="audit_entries",
    )
    token_prefix = models.CharField(
        max_length=8,
        help_text="Denormalized — preserved after token deletion.",
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        help_text="The user who performed the action.  NULL for 'used' entries "
        "(inbound requests have no Django user — the actor is the token itself).",
    )
    action = models.CharField(max_length=16, choices=ApiTokenAuditAction.choices)
    source_ip = models.GenericIPAddressField(null=True, blank=True)
    detail = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "projects_api_token_audit"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["project", "-created_at"], name="api_token_audit_proj_idx"),
            models.Index(fields=["program", "-created_at"], name="api_token_audit_prog_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                # Exactly one of project / program is non-null — mirrors ApiToken.
                condition=(
                    Q(project__isnull=False, program__isnull=True)
                    | Q(project__isnull=True, program__isnull=False)
                ),
                name="api_token_audit_scope_xor",
            ),
        ]

    def __str__(self) -> str:
        scope = f"program={self.program_id}" if self.program_id else f"project={self.project_id}"
        return f"ApiTokenAuditEntry({self.action} {self.token_prefix} {scope})"


# ---------------------------------------------------------------------------
# Task collaboration — ADR-0075
#   TaskAttachment, TaskComment, CommentAcknowledgement, CommentReaction
# ---------------------------------------------------------------------------


def _task_attachment_upload_to(instance: TaskAttachment, filename: str) -> str:
    """Year/month-partitioned upload path scoped by task UUID.

    Filename collisions are impossible because the row UUID prefixes the
    storage key — see TaskAttachment.save() override.
    """
    return f"attachments/{instance.task_id}/{instance.id}_{filename}"


class TaskAttachment(models.Model):
    """File or external link attached to a task. First-class (ADR-0075 §A.1).

    Plain Model (not VersionedModel) — synced via direct REST in 0.2; mobile
    WatermelonDB integration deferred to post-ADR-0026. Soft-delete preserves
    `[[attachment:uuid]]` comment references — rendered as
    "(deleted attachment)" rather than 404.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="attachments")

    # XOR: file XOR external_url (DB CheckConstraint below). Locked constraints
    # from ADR-0075 threat-model pass: 100 MB max file size; allow-listed MIME
    # types enforced at upload handler (TaskAttachmentSerializer). file uses
    # the FileField default convention (empty string = "no file"), so the XOR
    # check compares against "" rather than NULL.
    file = models.FileField(upload_to=_task_attachment_upload_to, blank=True, default="")
    file_name = models.CharField(max_length=255, blank=True, default="")
    file_size = models.BigIntegerField(null=True, blank=True)  # bytes
    file_mime = models.CharField(max_length=128, blank=True, default="")
    # Empty string = no external URL (Django convention DJ001).
    external_url = models.URLField(max_length=2048, blank=True, default="")
    external_title = models.CharField(max_length=255, blank=True, default="")

    is_pinned = models.BooleanField(default=False)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="uploaded_attachments",
    )
    # OSS-side accountability hook — captures actor without full Enterprise
    # audit trail (trueppm-enterprise#113 covers immutable log).
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="deleted_attachments",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "projects_taskattachment"
        ordering = ["-is_pinned", "-created_at"]
        constraints = [
            # file XOR external_url: exactly one of the two must be set.
            # Both fields default to "" (per Django convention DJ001 — no
            # nullable string-based columns).
            models.CheckConstraint(
                condition=(
                    (~models.Q(file="") & models.Q(external_url=""))
                    | (models.Q(file="") & ~models.Q(external_url=""))
                ),
                name="taskattachment_file_xor_url",
            ),
        ]
        indexes = [
            models.Index(
                fields=["task", "is_deleted", "-created_at"], name="ix_attach_task_recent"
            ),
        ]

    def __str__(self) -> str:
        kind = "url" if self.external_url else "file"
        return f"TaskAttachment({kind}, task={self.task_id})"

    @property
    def project_id(self) -> Any:
        # The RBAC helpers (`_get_project_id_from_obj`) traverse `obj.project_id`
        # to enforce object-level membership. TaskAttachment is task-scoped, so
        # we surface the parent project's id through this property — keeps the
        # permission classes unchanged.
        return self.task.project_id

    def soft_delete(self, *, actor: Any | None = None) -> None:
        """Soft-delete preserves `[[attachment:uuid]]` references in comments."""
        self.is_deleted = True
        self.deleted_at = timezone.now()
        self.deleted_by = actor
        self.save(update_fields=["is_deleted", "deleted_at", "deleted_by"])


class TaskComment(models.Model):
    """Append-only comment thread on a task (ADR-0075 §A.2).

    Mirrors RiskComment (ADR-0044) shape — plain Model, immutable after the
    15-min edit window. Single-level reply nesting enforced at the serializer
    layer (parent.parent_id must be NULL).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="comments")
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="replies",
    )
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="task_comments",
    )
    # Renderable markdown — supports @mention syntax and [[attachment:uuid]]
    # references. Body length capped at 10 000 chars in the serializer
    # (ADR-0075 locked constraint #3). HTML is escaped at render time.
    body = models.TextField()
    edited_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="deleted_task_comments",
    )

    class Meta:
        db_table = "projects_taskcomment"
        ordering = ["created_at"]
        indexes = [
            models.Index(
                fields=["task", "is_deleted", "created_at"], name="ix_comment_task_chrono"
            ),
        ]

    def __str__(self) -> str:
        return f"TaskComment({self.id}, task={self.task_id})"

    @property
    def project_id(self) -> Any:
        # See TaskAttachment.project_id — surfaces task.project_id so the RBAC
        # helpers can enforce object-level membership without bespoke wiring.
        return self.task.project_id

    def soft_delete(self, *, actor: Any | None = None) -> None:
        self.is_deleted = True
        self.deleted_at = timezone.now()
        self.deleted_by = actor
        self.save(update_fields=["is_deleted", "deleted_at", "deleted_by"])


class CommentAcknowledgement(models.Model):
    """First-class "I saw this / I'm on it" signal (ADR-0075 §A.3).

    Structurally separate from CommentReaction per Morgan VoC blocker —
    acknowledgements are queryable by team but NOT by PMO (enforced in
    viewset). Never triggers a notification.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    comment = models.ForeignKey(
        TaskComment, on_delete=models.CASCADE, related_name="acknowledgements"
    )
    # CASCADE: an unattributed acknowledgement has no archival value once the
    # user is hard-deleted (differs from comment authorship — the comment text
    # survives the user via SET_NULL on TaskComment.author).
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="comment_acknowledgements",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "projects_commentacknowledgement"
        constraints = [
            models.UniqueConstraint(
                fields=["comment", "user"],
                name="uq_commentack_comment_user",
            ),
        ]
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"CommentAcknowledgement(comment={self.comment_id}, user={self.user_id})"

    @property
    def project_id(self) -> Any:
        return self.comment.task.project_id


class CommentReaction(models.Model):
    """Lightweight emoji reaction (ADR-0075 §A.4).

    Structurally separate from CommentAcknowledgement — reactions are chatter,
    queryable by anyone in the project, NEVER trigger notifications. 0.2 allow-
    list is single emoji ("👍") enforced in serializer; expanded picker is 0.3.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    comment = models.ForeignKey(TaskComment, on_delete=models.CASCADE, related_name="reactions")
    # CASCADE: same rationale as CommentAcknowledgement — an unattributed
    # reaction is noise once the user is hard-deleted.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="comment_reactions",
    )
    emoji = models.CharField(max_length=16)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "projects_commentreaction"
        constraints = [
            models.UniqueConstraint(
                fields=["comment", "user", "emoji"],
                name="uq_commentreaction_comment_user_emoji",
            ),
        ]
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"CommentReaction({self.emoji}, comment={self.comment_id}, user={self.user_id})"

    @property
    def project_id(self) -> Any:
        return self.comment.task.project_id


# ---------------------------------------------------------------------------
# Project custom fields (#521)
# ---------------------------------------------------------------------------


class CustomFieldType(models.TextChoices):
    """Type of a project-scoped custom field.

    SINGLE_SELECT / MULTI_SELECT require non-empty ``options``; all others
    must leave ``options`` as an empty list.  USER carries a person reference
    (no options).  BOOLEAN is a checkbox.  Values for these fields are not
    yet persisted on tasks — that ships in a follow-up (custom-field values
    on TaskCustomFieldValue).
    """

    TEXT = "TEXT", "Text"
    NUMBER = "NUMBER", "Number"
    DATE = "DATE", "Date"
    SINGLE_SELECT = "SINGLE_SELECT", "Single-select"
    MULTI_SELECT = "MULTI_SELECT", "Multi-select"
    USER = "USER", "Person"
    BOOLEAN = "BOOLEAN", "Boolean"


# Soft cap on number of custom fields per project — defensive against admin
# sprawl. Mirrors typical PPM tool limits; raise if a real customer hits it.
PROJECT_CUSTOM_FIELD_MAX = 32


class ProjectCustomField(models.Model):
    """Project-scoped custom field definition for tasks (#521).

    This model stores *definitions only* (name + type + required + options).
    Per-task values come in a follow-up. Built-in fields (Phase, Owner,
    Duration, Risk, Critical-path) are not modeled here — they're a static
    catalog in the web client that the Fields settings page stitches above
    the dynamic custom list.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="custom_fields",
    )
    name = models.CharField(max_length=64)
    field_type = models.CharField(max_length=16, choices=CustomFieldType.choices)
    required = models.BooleanField(default=False)
    # Choice list for SINGLE_SELECT / MULTI_SELECT — list of {value, label, color?}.
    # Empty list for every other type; the serializer enforces the constraint.
    options = models.JSONField(default=list, blank=True)
    # Display order on the Workflow settings page. Drag-to-reorder is implemented
    # by issuing PATCHes on individual rows; no dedicated reorder endpoint.
    order = models.PositiveSmallIntegerField(default=0, db_index=True)
    server_version = models.BigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_projectcustomfield"
        ordering = ["order", "name"]
        constraints = [
            # Case-insensitive uniqueness so "Vendor" / "vendor" can't both exist.
            models.UniqueConstraint(
                Lower("name"),
                "project",
                name="unique_custom_field_name_per_project_ci",
            ),
        ]
        indexes = [models.Index(fields=["project", "order"])]
        verbose_name = "project custom field"
        verbose_name_plural = "project custom fields"

    def __str__(self) -> str:
        return f"ProjectCustomField({self.project_id}, {self.name!r}, {self.field_type})"


# ---------------------------------------------------------------------------
# Program backlog (ADR-0069 + Erratum, #733/#737/#739)
# ---------------------------------------------------------------------------


class BacklogItemType(models.TextChoices):
    """Item type bridging PM and PO vocabulary (ADR-0069).

    The same intake pool serves a waterfall PM (who thinks in WBS-style tasks)
    and a product owner (who thinks in epics/stories). ``item_type`` lets each
    framing coexist without forcing either onto the other; on pull it is carried
    into the Task only as metadata, so the Board and Schedule views still show
    plain Task vocabulary.
    """

    EPIC = "epic", "Epic"
    FEATURE = "feature", "Feature"
    STORY = "story", "Story"
    TASK = "task", "Task"


class BacklogItemStatus(models.TextChoices):
    """Lifecycle of a program backlog item (ADR-0069).

    Deliberately distinct from ``TaskStatus`` — a BacklogItem is a *candidate*,
    not committed delivery. ``PROPOSED`` items are pullable; ``pull`` transitions
    to ``PULLED`` and records the Task it became; ``ARCHIVED`` removes an item
    from the active pool without ever creating a Task.
    """

    PROPOSED = "proposed", "Proposed"
    PULLED = "pulled", "Pulled"
    ARCHIVED = "archived", "Archived"


class BacklogItem(VersionedModel):
    """A program-level intake-pool item (ADR-0069 Erratum, #733).

    The program backlog is the holding area for work *proposed* to a program but
    not yet committed to any one project. It lives at the ``Program`` level (not
    ``Project``) so a PM can pull a feature into whichever of the program's
    projects is ready for it — the core program-increment-planning use case.
    Cross-program/portfolio aggregation stays Enterprise per the Two-Repo Rule.

    Extends ``VersionedModel``, so the row is offline-sync ready: ``server_version``
    bumps atomically on every save and ``soft_delete()`` writes a tombstone
    (``is_deleted``/``deleted_version``). The model is not yet fanned into the
    project-scoped sync delta endpoint — that endpoint cannot reach program-scoped
    rows, mirroring the deliberate deferral already documented for ``Program`` and
    ``ProgramMembership`` in ``sync/serializers.py``. Program-level offline sync
    (Program, ProgramMembership, BacklogItem together) is a tracked follow-up.

    The status machine (PROPOSED → PULLED / ARCHIVED) is enforced by the pull
    service, not the model — see ``backlog_services.pull_to_project_backlog``.
    """

    program = models.ForeignKey(
        Program,
        on_delete=models.CASCADE,
        related_name="backlog_items",
    )
    title = models.CharField(max_length=512)
    description = models.TextField(blank=True, default="")
    item_type = models.CharField(
        max_length=16,
        choices=BacklogItemType.choices,
        default=BacklogItemType.TASK,
    )
    status = models.CharField(
        max_length=16,
        choices=BacklogItemStatus.choices,
        default=BacklogItemStatus.PROPOSED,
        db_index=True,
    )
    # Free-form labels. JSON list matches the repo convention for tag-like data
    # (Program.rollup_enabled_kpis, BoardColumnConfig.columns); trigram search
    # (#739) targets `title` only, so no ArrayField / GIN-on-tags is needed.
    tags = models.JSONField(default=list, blank=True)
    # Lower = higher priority. Nullable so an unranked pool is valid; drives the
    # default list ordering for the backlog UI (#742).
    priority_rank = models.PositiveIntegerField(null=True, blank=True)
    # Agile estimate, optional. Mapped onto Task.story_points on pull.
    story_points = models.PositiveSmallIntegerField(null=True, blank=True)
    # Set by the pull action — the Task this item became. SET_NULL (not CASCADE)
    # so deleting the Task never deletes the originating item; a post_save
    # rollback receiver instead resets the item to PROPOSED so it can be re-pulled.
    pulled_task = models.OneToOneField(
        "Task",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="source_backlog_item",
    )
    pulled_at = models.DateTimeField(null=True, blank=True)
    pulled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_backlog_item"
        ordering = ["priority_rank", "-created_at"]
        indexes = [
            # List + filter: the program backlog list is always program-scoped
            # and almost always status-filtered (PROPOSED by default).
            models.Index(fields=["program", "status"]),
            # Trigram fuzzy search on title (#739). gin_trgm_ops requires the
            # pg_trgm extension, enabled in the same migration that adds this
            # index (migration runs TrigramExtension before AddIndex).
            GinIndex(
                fields=["title"],
                opclasses=["gin_trgm_ops"],
                name="backlogitem_title_trgm",
            ),
        ]

    def __str__(self) -> str:
        return f"BacklogItem({self.program_id}, {self.title!r}, {self.status})"


# ---------------------------------------------------------------------------
# Forecast snapshot — the agile/waterfall bridge reforecast-on-close (ADR-0106 §5)
# ---------------------------------------------------------------------------


class ForecastBasis(models.TextChoices):
    """Which engine produced a ``ForecastSnapshot`` range (ADR-0106 §5).

    ``VELOCITY_BAND`` is the coarse fallback (avg ± 1σ re-paced to calendar days);
    ``MONTE_CARLO`` is the agile-aware simulation (#411). The on-close reforecast
    records the path it actually took so the UI can label the confidence honestly.
    """

    MONTE_CARLO = "monte_carlo", "Monte Carlo"
    VELOCITY_BAND = "velocity_band", "Velocity band"


class ForecastConfidence(models.TextChoices):
    """Coarse confidence band emitted upward with a milestone forecast (ADR-0106 §5).

    A *band*, never the raw velocity series — this is the only throughput-derived
    signal the privacy model lets cross the team boundary (§3/§6).
    """

    HIGH = "high", "High"
    MEDIUM = "medium", "Medium"
    LOW = "low", "Low"


class ForecastSnapshot(models.Model):
    """One persisted milestone reforecast (ADR-0106 §5 / #860 / #388).

    Written per reforecast-on-close and per explicit refresh; the forecast read
    returns the latest row per milestone. A plain ``models.Model`` (not a
    ``VersionedModel``) — display/forecast metadata, consistent with
    ``SprintBurnSnapshot`` / ``SprintScopeChange``; not on the mobile sync surface.

    **Velocity-privacy guarantee at rest (§3/§D):** stores only the derived
    ``velocity_low``/``velocity_high`` *band*, never the per-sprint
    ``completed_points`` series. The band — not the throughput — is the only
    thing that crosses upward, at the broadcast, the signal, and here at rest.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="forecast_snapshots"
    )
    # SET_NULL (not CASCADE): a deleted milestone leaves its forecast history
    # readable for the demo narrative ("P50 moved across the last K sprints").
    milestone = models.ForeignKey(
        Task,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="forecast_snapshots",
    )
    taken_at = models.DateTimeField(auto_now_add=True)
    basis = models.CharField(max_length=20, choices=ForecastBasis.choices)
    # The deterministic CPM spine (the milestone's early_finish at reforecast
    # time); p50/p80 are anchored on it. Nullable: a milestone with no CPM pass
    # yet has no finish to anchor.
    cpm_finish = models.DateField(null=True, blank=True)
    p50 = models.DateField(null=True, blank=True)
    p80 = models.DateField(null=True, blank=True)
    # The band, NEVER the series (§3 privacy). Null below the 2-closed-sprint floor.
    velocity_low = models.PositiveIntegerField(null=True, blank=True)
    velocity_high = models.PositiveIntegerField(null=True, blank=True)
    confidence = models.CharField(max_length=10, choices=ForecastConfidence.choices)
    unmodeled_dependency = models.BooleanField(default=False)

    class Meta:
        db_table = "projects_forecastsnapshot"
        ordering = ["-taken_at"]
        indexes = [
            # Latest-per-milestone read (the forecast endpoint + nightly purge).
            models.Index(fields=["milestone", "-taken_at"], name="forecast_milestone_recent_idx"),
            models.Index(fields=["project", "-taken_at"], name="forecast_project_recent_idx"),
        ]

    def __str__(self) -> str:
        return f"ForecastSnapshot({self.milestone_id} @ {self.taken_at:%Y-%m-%d} {self.basis})"
