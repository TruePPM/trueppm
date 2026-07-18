"""DRF ViewSets for the projects app."""

from __future__ import annotations

import contextlib
import datetime
import functools
import logging
import re
import uuid
from collections.abc import Iterable, Sequence
from typing import Any, cast

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.db import models as db_models
from django.db.models import (
    Avg,
    BooleanField,
    Case,
    Count,
    Exists,
    ExpressionWrapper,
    F,
    IntegerField,
    Max,
    Min,
    OuterRef,
    Q,
    QuerySet,
    Subquery,
    Sum,
    When,
)
from django.db.models.expressions import RawSQL
from django.http import FileResponse, Http404, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiExample,
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    extend_schema_view,
    inline_serializer,
)
from rest_framework import filters, generics, mixins, pagination, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, NotAuthenticated, PermissionDenied
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import SAFE_METHODS, BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    IsOrgAdmin,
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProjectAdmin,
    IsProjectBacklogManager,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectMemberWriteOrOwn,
    IsProjectNotArchived,
    IsProjectOwner,
    IsProjectScheduler,
    IsProjectScopeManager,
    IsTaskScopeManager,
    IsTokenForProject,
    McpReadableViewMixin,
    ProjectScopedViewSet,
    TokenHasScope,
    can_user_edit_task,
)
from trueppm_api.apps.access.services import transfer_project_ownership
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.integrations.registry import LINK_STATUS_RANK, LINK_STATUS_UNKNOWN
from trueppm_api.apps.profiles.serializers import RecentProjectSerializer
from trueppm_api.apps.projects.models import (
    _HISTORY_EXCLUDED_TASK,
    SCOPE_LEGACY_FULL,
    AcceptanceCriterion,
    ApiToken,
    BacklogItem,
    BacklogItemType,
    Baseline,
    BaselineTask,
    BoardColumnConfig,
    BoardSavedView,
    Calendar,
    CalendarException,
    CalendarRole,
    CommentAcknowledgement,
    CommentReaction,
    CrossProjectSlipConflict,
    Dependency,
    EstimateStatus,
    EstimationMode,
    ExportJobStatus,
    Health,
    Label,
    Project,
    ProjectApiToken,
    ProjectCalendarLayer,
    ProjectCustomField,
    ProjectExportJob,
    RetroBoardItem,
    Risk,
    RiskComment,
    RiskStatus,
    Sprint,
    SprintScopeChange,
    SprintState,
    SprintTaskOutcome,
    Task,
    TaskActivityEvent,
    TaskAttachment,
    TaskComment,
    TaskLabel,
    TaskNote,
    TaskRecurrenceRule,
    TaskRelation,
    TaskStatus,
    TaskType,
)
from trueppm_api.apps.projects.schema_migrations import (
    SURFACE_BOARD_SAVED_VIEW,
    current_version,
)
from trueppm_api.apps.projects.serializers import (
    _DEFAULT_COLUMNS,
    AcceptanceCriterionSerializer,
    ApiTokenAuditEntrySerializer,
    AppliedCalendarsSerializer,
    ApplyCalendarsSerializer,
    BaselineDetailSerializer,
    BaselineSerializer,
    BoardColumnConfigSerializer,
    BoardSavedViewSerializer,
    CalendarExceptionSerializer,
    CalendarPreviewSerializer,
    CalendarSerializer,
    CommentAcknowledgementSerializer,
    CommentReactionSerializer,
    CrossProjectSlipConflictSerializer,
    CycleDetectedError,
    DecisionNoteSerializer,
    DependencySerializer,
    FlowMetricsSerializer,
    ForecastSnapshotSerializer,
    GuardrailBlockedError,
    InboundTaskSyncPayloadSerializer,
    InboundTaskSyncResultSerializer,
    LabelSerializer,
    MeActiveSprintCardSerializer,
    MeWorkActiveSprintSerializer,
    MeWorkTaskSerializer,
    MilestoneListItemSerializer,
    MilestoneRollupLockedError,
    MyApiTokenCreateSerializer,
    MyApiTokenSerializer,
    OmniSearchResultSerializer,
    PhaseSerializer,
    ProgressAnchorError,
    ProjectApiTokenCreateSerializer,
    ProjectApiTokenSerializer,
    ProjectCustomFieldSerializer,
    ProjectDetailSerializer,
    ProjectExportJobSerializer,
    ProjectForecastSerializer,
    ProjectSerializer,
    ReforecastPreviewSerializer,
    RetroActionItemSerializer,
    RetroBoardItemSerializer,
    RiskCommentSerializer,
    RiskImportResultSerializer,
    RiskSerializer,
    SignedDownloadUrlSerializer,
    SprintBurnSnapshotSerializer,
    SprintCloseRequestSerializer,
    SprintDailyDeltaSerializer,
    SprintForecastSerializer,
    SprintOutcomeSerializer,
    SprintSerializer,
    TaskAttachmentSerializer,
    TaskBulkSerializer,
    TaskCommentSerializer,
    TaskDurationChangeEventSerializer,
    TaskLabelChipSerializer,
    TaskNoteSerializer,
    TaskRecurrenceRuleSerializer,
    TaskRelationSerializer,
    TaskReorderSerializer,
    TaskScopeRollupSerializer,
    TaskSerializer,
)
from trueppm_api.apps.scheduling.models import ScheduleRequestReason
from trueppm_api.apps.scheduling.services import enqueue_recalculate as _enqueue_recalculate
from trueppm_api.apps.sync.conflict import FieldLevelMergeMixin, check_field_conflict
from trueppm_api.apps.webhooks.models import (
    DeliveryStatus,
    Webhook,
    WebhookDelivery,
)
from trueppm_api.core.openapi import suppress_list_pagination

logger = logging.getLogger(__name__)

# Allow-list pattern for the X-Source request header value (ADR-0065 Gap 2).
# Lower-case ASCII letters and underscores, 1–64 chars. Any other input is
# coerced to "unknown" before reaching the stored webhook payload — protects
# downstream third-party consumers from arbitrary Unicode or oversized strings.
_VALID_SOURCE = re.compile(r"[a-z_]{1,64}")

# Task fields whose mutation never changes the CPM schedule, so a PATCH touching
# *only* these must not enqueue a whole-project recalculation (#965). This is a
# conservative DENYLIST: any field not listed here still triggers a recalc, so a
# new scheduling input added later defaults to the safe (recalc) behavior.
#   - notes / name: pure metadata.
# Status, dates, duration, PERT estimates, sprint, parent, etc. are deliberately
# absent — they can move the schedule and must keep recalculating immediately.
#
# ``percent_complete`` is deliberately NOT in this set (#1500). It was
# originally denylisted on the premise that the CPM forward/backward pass never
# reads it. ADR-0132 (progress-aware forecasting) made that premise false:
# ``trueppm_scheduler.engine._effective_duration_days`` derives an in-progress
# task's *remaining* duration from ``percent_complete``
# (``duration - floor(duration * pct/100)``), and ``_is_complete`` pins a task
# once ``percent_complete >= 100`` — both unconditionally, independent of
# whether ``Project.status_date`` is set. (A status date only changes the
# *floor* applied to not-started/in-progress work; it does not gate whether
# percent_complete itself is consumed — verified directly against the engine:
# a bare percent_complete write shifts ``early_finish`` even with no
# status_date and no actuals.) So a PATCH writing only ``percent_complete``
# must always recalc, on every project — nobody reads it from the API only to
# have the schedule silently drift stale.
_NON_SCHEDULE_TASK_FIELDS = frozenset({"notes", "name"})


# ---------------------------------------------------------------------------
# OpenAPI response serializers (#781)
#
# Response-only serializers that describe the ad-hoc dict payloads these
# endpoints return, so the generated schema documents a real shape instead of
# "No response body". They are never used to parse input — only to advertise
# the output contract to integrators reading docs/api/openapi.json.
# ---------------------------------------------------------------------------


class WbsPathEntrySerializer(serializers.Serializer[Any]):
    """A single task's new WBS path after a structural move."""

    id = serializers.UUIDField()
    wbs_path = serializers.CharField()


class TaskReorderResponseSerializer(serializers.Serializer[Any]):
    """Response for the sibling-reorder endpoint."""

    updated = WbsPathEntrySerializer(many=True)


class TaskRestructureResponseSerializer(serializers.Serializer[Any]):
    """Response for indent / outdent / reparent — moved rows plus an optional warning."""

    updated = WbsPathEntrySerializer(many=True)
    warning = serializers.CharField(
        allow_null=True,
        help_text=(
            "'has_assignments' when the move turned a task into a summary that "
            "still carries resource assignments; otherwise null."
        ),
    )


class TaskBulkResponseSerializer(serializers.Serializer[Any]):
    """Response for the atomic task bulk-mutation endpoint."""

    created = TaskSerializer(many=True)
    updated = TaskSerializer(many=True)
    deleted = serializers.ListField(child=serializers.UUIDField())


class PhaseReorderResponseSerializer(serializers.Serializer[Any]):
    """Response for the phase-reorder endpoint — count of rows re-ranked."""

    updated = serializers.IntegerField()


class ProjectPresenceEntrySerializer(serializers.Serializer[Any]):
    """A single user currently connected to a project's WebSocket."""

    user_id = serializers.CharField()
    display_name = serializers.CharField()


class BoardColumnConfigResponseSerializer(serializers.Serializer[Any]):
    """Response for the board column-config endpoints: the ordered column list."""

    columns = serializers.ListField(child=serializers.DictField())


class CalendarViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Calendar]):
    """CRUD for project calendars.

    Calendars define working days, hours per day, and holiday exceptions.
    They are shared org-level resources — not scoped to a single project.

    Read access: any authenticated user.
    Write operations: org admin (Project Manager+ on at least one project).
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]
    queryset = Calendar.objects.prefetch_related("exceptions").order_by("name")
    serializer_class = CalendarSerializer
    search_fields = ["name"]
    ordering_fields = ["name"]

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method in SAFE_METHODS:
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsOrgAdmin()]

    def get_queryset(self) -> QuerySet[Calendar]:
        # Calendars are not project-scoped — they are shared org-level resources.
        # Return the full queryset for any authenticated user.
        return Calendar.objects.prefetch_related("exceptions").order_by("name")

    def perform_update(self, serializer: BaseSerializer[Calendar]) -> None:
        # working_days and hours_per_day are the only CPM inputs on Calendar —
        # changing either shifts every finish date on every project scheduled
        # against this calendar (#1492). timezone is round-tripped but not yet
        # consumed by the scheduler (trueppm_scheduler.models.Calendar docstring),
        # and name is pure metadata, so a PATCH touching only those must not fan
        # out a recompute (over-triggering wastes a recalc pass on every project
        # bound to the calendar for a no-op schedule change). Compare before/after
        # rather than inspecting serializer.validated_data so this also catches a
        # PUT that re-sends the same values under a different field set.
        old_working_days = serializer.instance.working_days if serializer.instance else None
        old_hours_per_day = serializer.instance.hours_per_day if serializer.instance else None

        instance = serializer.save()

        if instance.working_days != old_working_days or instance.hours_per_day != old_hours_per_day:
            _recalc_projects_for_calendar(instance.pk)


def _enqueue_calendar_recalc(project_ids: Sequence[uuid.UUID | str]) -> None:
    """Defer a CALENDAR_CHANGE recompute for each project to ``transaction.on_commit``.

    Routed through the scheduling outbox (ADR-0027) so a broker outage cannot drop the
    recompute; ``enqueue_recalculate`` coalesces onto any PENDING request per project,
    so several edits in one transaction cost one recompute each.
    """
    if not project_ids:
        return

    def _dispatch() -> None:
        for pid in project_ids:
            _enqueue_recalculate(str(pid), reason=ScheduleRequestReason.CALENDAR_CHANGE)

    transaction.on_commit(_dispatch)


def _recalc_projects_for_calendar(calendar_id: uuid.UUID | str) -> None:
    """Enqueue a CPM recompute for every live project this calendar's edit affects.

    Calendar (and calendar-exception) edits are org-admin writes that may touch
    projects the editor is not a member of, so the fan-out is by calendar FK, not by
    membership. A project is affected when it applies the calendar as its **base**, as
    an **overlay** layer (#906/ADR-0251), OR when it **inherits** the calendar as its
    effective base from its program or the workspace (ADR-0441): a program-default or
    workspace-default calendar edit must reach the projects that resolve up to it, not
    only the projects that name it directly. distinct() because the layer join can
    multiply a project row.
    """
    from trueppm_api.apps.projects.calendar_settings import calendar_override_locked
    from trueppm_api.apps.workspace.models import Workspace

    workspace = Workspace.load()

    if calendar_override_locked(workspace) and workspace.calendar_id == calendar_id:
        # Enterprise lock active and this is the (mandatory) workspace calendar: every
        # live project effectively schedules against it regardless of its own override.
        # (OSS registers no enforcement provider, so this branch never fires there.)
        selector = Q()
    else:
        # Direct base, overlay layer, or inherited-from-program base.
        selector = (
            Q(calendar_id=calendar_id)
            | Q(calendar_layers__calendar_id=calendar_id)
            | Q(calendar__isnull=True, program__calendar_id=calendar_id)
        )
        # Inherited-from-workspace base: only when this IS the workspace calendar, and
        # only for projects with no base of their own AND no program-level override.
        if workspace.calendar_id == calendar_id:
            selector |= Q(calendar__isnull=True, program__isnull=True)
            selector |= Q(calendar__isnull=True, program__calendar__isnull=True)

    project_ids = list(
        Project.objects.filter(selector, is_deleted=False).distinct().values_list("id", flat=True)
    )
    _enqueue_calendar_recalc(project_ids)


def _recalc_projects_for_program_calendar(program_id: uuid.UUID | str) -> None:
    """Recompute a program's projects that inherit its calendar (ADR-0441).

    Called when a program's ``calendar`` FK is reassigned (a different default, or
    cleared to inherit the workspace) — every member project that sets no calendar of
    its own now resolves to a different effective base and must be rescheduled. Projects
    that override with their own calendar are unaffected and deliberately skipped.
    """
    project_ids = list(
        Project.objects.filter(
            program_id=program_id, calendar__isnull=True, is_deleted=False
        ).values_list("id", flat=True)
    )
    _enqueue_calendar_recalc(project_ids)


def _recalc_projects_for_workspace_calendar() -> None:
    """Recompute every project that inherits the workspace calendar (ADR-0441).

    Called when the workspace ``calendar`` FK (or its override policy) is reassigned —
    a project resolves to the workspace calendar only when it sets no calendar of its
    own AND its program sets none either (or it has no program). Under an active
    Enterprise lock every project resolves to the workspace calendar, so the fan-out
    widens to all live projects.
    """
    from trueppm_api.apps.projects.calendar_settings import calendar_override_locked
    from trueppm_api.apps.workspace.models import Workspace

    if calendar_override_locked(Workspace.load()):
        selector = Q()
    else:
        selector = Q(calendar__isnull=True, program__isnull=True) | Q(
            calendar__isnull=True, program__calendar__isnull=True
        )
    project_ids = list(
        Project.objects.filter(selector, is_deleted=False).distinct().values_list("id", flat=True)
    )
    _enqueue_calendar_recalc(project_ids)


class CalendarExceptionViewSet(IdempotencyMixin, viewsets.ModelViewSet[CalendarException]):
    """CRUD for a calendar's non-working date ranges (holidays, shutdowns).

    Mounted under /calendars/<calendar_pk>/exceptions/ via explicit path()s
    (ADR-0194) rather than a router @action, to keep the OpenAPI schema clean
    (#846). Exceptions are an aggregate of their calendar: every write bumps the
    parent Calendar.server_version (so the change rides the existing calendar
    sync delta) and fans out a CPM recompute to affected projects.

    Read access: any authenticated user. Writes: org admin (Project Manager+),
    mirroring CalendarViewSet.
    """

    serializer_class = CalendarExceptionSerializer

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method in SAFE_METHODS:
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsOrgAdmin()]

    def get_queryset(self) -> QuerySet[CalendarException]:
        # Scope strictly to the URL calendar so an exception id from calendar A
        # can never be read or mutated through calendar B (IDOR guard).
        return CalendarException.objects.filter(calendar_id=self.kwargs["calendar_pk"]).order_by(
            "exc_start", "exc_end"
        )

    def _calendar(self) -> Calendar:
        return get_object_or_404(Calendar, pk=self.kwargs["calendar_pk"], is_deleted=False)

    def _touch(self, calendar: Calendar) -> None:
        # Bump the aggregate root so the mutation propagates through the calendar
        # sync delta, then recompute dependent projects.
        calendar.save()
        _recalc_projects_for_calendar(calendar.pk)

    def perform_create(self, serializer: BaseSerializer[CalendarException]) -> None:
        calendar = self._calendar()
        serializer.save(calendar=calendar)
        self._touch(calendar)

    def perform_update(self, serializer: BaseSerializer[CalendarException]) -> None:
        instance = serializer.save()
        self._touch(instance.calendar)

    def perform_destroy(self, instance: CalendarException) -> None:
        calendar = instance.calendar
        instance.delete()
        self._touch(calendar)


class DirectoryPagination(pagination.PageNumberPagination):
    """Raised default page size for the project / program directory endpoints.

    The DRF default of 50 silently truncated the sidebar Browse tree and the
    command-palette Tier-1 jump targets at the 50th entity (ADR-0401, #1940). 200
    covers the target account scale (40+ projects) in a single request, so the nav
    surfaces stop truncating without the client having to loop. ``page_size`` stays
    client-tunable (bounded by ``max_page_size``) and the response ``count`` drives
    the "showing N of M" overflow cue for accounts past the ceiling.
    """

    page_size = 200
    page_size_query_param = "page_size"
    max_page_size = 500


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="program__isnull",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When truthy (true/1/yes), return only ungrouped projects "
                    "(no program), excluding archived and soft-deleted ones, and "
                    "annotate each row with member_count and percent_complete "
                    "(Programs directory 'Ungrouped projects' section)."
                ),
            ),
        ],
    ),
    destroy=extend_schema(
        parameters=[
            OpenApiParameter(
                name="force",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When truthy (1/true/yes), permanently hard-delete the "
                    "project (and its memberships) instead of soft-deleting it. "
                    "Requires the project to already be archived, otherwise a 400 "
                    "is returned."
                ),
            ),
        ],
    ),
)
class ProjectViewSet(
    FieldLevelMergeMixin, McpReadableViewMixin, ProjectScopedViewSet, viewsets.ModelViewSet[Project]
):
    """CRUD for projects.

    Any authenticated user can create a project; on creation the creator is
    automatically assigned the Owner role via perform_create().

    Permission matrix (issue #11; update tightened in #769):
      list/retrieve/create        — any member (IsProjectMember)
      update/partial_update       — Scheduler+ at the gate (IsProjectScheduler);
                                     general settings (name/dates/calendar/…) are
                                     further restricted to Admin+ in the serializer,
                                     so a Scheduler may change only methodology and
                                     estimation_mode (ADR-0041, estimation governance)
      destroy/archive/unarchive/transfer — Project Admin (Owner) only (IsProjectOwner)
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get_permissions(self) -> list[BasePermission]:
        # Additively guard the API-token path (ADR-0186 §E): a mcp:read token is
        # confined to safe methods and must carry the scope; human JWT/Session
        # auth passes both guards. Wrapping the action-specific RBAC list here (vs
        # per branch) guarantees no write branch can leak a token past the guards.
        return [*self._rbac_permissions(), *self.mcp_token_guards()]

    def _rbac_permissions(self) -> list[BasePermission]:
        # Lifecycle actions (archive/unarchive/destroy/transfer) bypass the
        # IsProjectNotArchived gate via its _ARCHIVE_BYPASS_ACTIONS set —
        # otherwise an Owner could never unarchive or delete an archived row.
        if self.action in ("destroy", "archive", "unarchive", "transfer", "restore"):
            return [IsAuthenticated(), IsProjectOwner(), IsProjectNotArchived()]
        # Trash listing (#1113) is any-member: it lists the caller's own
        # soft-deleted projects (the queryset is membership-scoped). Restore itself
        # is Owner-gated above; a non-Owner member sees the row but cannot restore.
        if self.action == "trash":
            return [IsAuthenticated(), IsProjectMember()]
        # Cross-project health summary (ADR-0401, #1941): a list-style read over the
        # caller's own member projects. Object-level IsProjectMember / IsProjectNotArchived
        # do not apply to a detail=False action — the get_queryset membership filter is the
        # guard — so this is authenticated-only, matching the plain `list` gate.
        if self.action == "health_summary":
            return [IsAuthenticated()]
        # Editing a project requires Scheduler+ at the gate — this closes the
        # #769 blocker (update/partial_update used to fall through to
        # IsProjectMember, which passes for Viewer (role 0) and Member). The
        # finer split — general settings (name/description/color/dates/calendar)
        # are Admin-only, while methodology and estimation_mode are Scheduler-
        # writable per ADR-0041 and the estimation-governance design — is
        # enforced field-by-field in ProjectSerializer.validate().
        if self.action in ("update", "partial_update"):
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        if self.action in ("utilization", "resource_allocation", "heatmap", "resources_summary"):
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        # Composable working calendars (#906/ADR-0251): reading the applied set (and
        # its preview) is any-member (Viewer+, same level as reading the schedule);
        # applying/replacing the set is a project scheduling decision gated Scheduler+
        # (it mutates no shared resource — only which library calendars overlay THIS
        # project). SAFE_METHODS branch keeps GET on the read gate.
        if self.action == "working_calendars":
            if self.request.method in SAFE_METHODS:
                return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        if self.action == "working_calendars_preview":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # ADR-0105: reading the grooming view is any-member; auto-rank is a structural
        # backlog action gated on can_manage_backlog (Admin+ today, PO-role seam).
        if self.action == "product_backlog":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        if self.action in (
            "product_backlog_auto_rank",
            "product_backlog_reorder",
            "queue_reorder",
        ):
            # Priority reorder is a structural backlog action (permissions.can_manage_backlog):
            # Admin+ or the Product Owner facet. The board queue's promote/demote rides the
            # same gate as the product-backlog drag so the capability is declared once.
            return [IsAuthenticated(), IsProjectBacklogManager(), IsProjectNotArchived()]
        # Recording a last-visited ping is any-member (Viewer+) and intentionally
        # skips IsProjectNotArchived: a user opening an archived project is still a
        # real visit (ADR-0150 D4). The resolver separately filters archived
        # projects out of the landing result, so recording one is harmless.
        if self.action == "visit":
            return [IsAuthenticated(), IsProjectMember()]
        # Decisions list (ADR-0167, #748): any project member reaches the endpoint; the
        # finer team-vs-oversight read gate is enforced in the action body via
        # `can_read_decisions` (a Viewer is suppressed with 403 unless the team opted in).
        # Stated explicitly so the body-level gate can't be silently widened by a change
        # to the default clause below.
        if self.action == "decisions":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # Project export (#967, ADR-0109 addendum): read-only data portability,
        # available on archived projects too — it skips IsProjectNotArchived (like
        # `visit`), mirroring program export's "portability stays available for
        # archival/forensics" stance.
        if self.action == "export":
            # Admin+ for BOTH the GET sync JSON seed and the POST async .tar.gz
            # bundle (#1957). The seed dumps team-private data raw — story points,
            # committed/completed/capacity velocity, per-member effort — with no
            # ADR-0104 field-gating (that redaction is deferred to 0.5, #1959), so a
            # Viewer/Member reaching it is an ADR-0104 bypass: they could pull raw
            # what the normal API surface gates per audience. Gating the sync seed
            # to Admin+ matches the async bundle (which already required Admin+
            # because it aggregates the full audit history, every member's time
            # entries, and all attachment binaries). Bulk export is an Admin-tier
            # action on either path.
            return [IsAuthenticated(), IsProjectAdmin()]
        # Export-job list / poll / download (#1266, ADR-0219): Admin+, matching the
        # POST enqueue. Like the sync export these stay available on archived projects
        # (portability for archival/forensics), so they skip IsProjectNotArchived.
        # Object-level cross-project IDOR (a job_id from another project) is closed in
        # the action bodies via project-scoped lookups.
        if self.action in ("export_jobs", "export_job_detail", "export_job_download"):
            return [IsAuthenticated(), IsProjectAdmin()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    queryset = (
        Project.objects.select_related("calendar", "lead", "program", "program__calendar")
        # ADR-0441: ProjectSerializer.effective_calendar resolves project ?? program ??
        # workspace and reports holiday_count, so prefetch the base and program-tier
        # calendars' exceptions to keep the project list N+1-free. (The workspace-tier
        # calendar is the shared singleton, resolved once via the serializer's cache.)
        .prefetch_related("calendar__exceptions", "program__calendar__exceptions")
        .order_by("start_date", "name")
    )
    serializer_class = ProjectSerializer
    pagination_class = DirectoryPagination
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name"]
    ordering_fields = ["start_date", "name"]

    def get_serializer_class(self) -> type[BaseSerializer[Project]]:
        # Detail view includes unresolved_assignee_count (Sarah's VoC 🟡, ADR-0068).
        # List stays on the lightweight ProjectSerializer to keep the project
        # list fast at portfolio scale.
        if self.action == "retrieve":
            return ProjectDetailSerializer
        return ProjectSerializer

    def get_queryset(self) -> QuerySet[Project]:
        """Membership-scoped project list (from ``ProjectScopedViewSet``), with an
        optional ``?program__isnull=true`` branch for the Programs directory's
        "Ungrouped projects" section (ADR-0171).

        The aggregates (``member_count``, ``percent_complete``) are attached ONLY
        on that branch — the default list stays a single unannotated query at
        portfolio scale. Archived and soft-deleted projects are excluded from the
        ungrouped view: a project that is out of active management should not be
        nagged as "needing a home".
        """
        from django.db.models.functions import Coalesce

        qs = super().get_queryset()
        # Caller's role on each project (ADR-0186 §F, #504) — a Subquery over the
        # active ProjectMembership so ProjectSerializer.my_role / my_role_label
        # (the MCP ``caller_role`` enrichment) render without an N+1. Mirrors the
        # program list view's ``_my_role`` annotation (program_views.py). Anonymous
        # callers already receive an empty queryset from ProjectScopedViewSet, so
        # guard the annotation on auth.
        user = self.request.user
        if user is not None and user.is_authenticated:
            my_role_sq = ProjectMembership.objects.filter(
                project=OuterRef("pk"),
                user=user,
                is_deleted=False,
            ).values("role")[:1]
            qs = qs.annotate(_my_role=Subquery(my_role_sq))
        if self.action == "retrieve":
            # ProjectDetailSerializer.unresolved_assignee_count would otherwise
            # issue a live COUNT() per detail retrieve; fold it into the row as a
            # correlated subquery so the detail fetch is one query (#821).
            from trueppm_api.apps.projects.models import InboundTaskLink

            unresolved = (
                InboundTaskLink.objects.filter(
                    project=OuterRef("pk"),
                    is_deleted=False,
                    pending_assignee_email__isnull=False,
                )
                .order_by()
                .values("project")
                .annotate(c=Count("pk"))
                .values("c")
            )
            qs = qs.annotate(
                unresolved_assignee_count=Coalesce(
                    Subquery(unresolved, output_field=IntegerField()), 0
                )
            )
        if self.action == "list":
            # Per-project open-task count for the sidebar row badge (#960):
            # non-deleted tasks that are not yet COMPLETE. A LEFT JOIN + Count
            # over ``tasks`` here would fan out against the ``memberships`` join
            # added on the ungrouped branch below (and inflate both), so this is
            # a correlated Subquery — one extra scalar per row, no N+1, no join
            # multiplication (mirrors ``unresolved_assignee_count`` above).
            open_tasks = (
                Task.objects.filter(project=OuterRef("pk"), is_deleted=False)
                .exclude(status=TaskStatus.COMPLETE)
                .order_by()
                .values("project")
                .annotate(c=Count("pk"))
                .values("c")
            )
            qs = qs.annotate(
                open_task_count=Coalesce(Subquery(open_tasks, output_field=IntegerField()), 0)
            )
        flag = self.request.query_params.get("program__isnull")
        if flag is not None and flag.lower() in ("true", "1", "yes"):
            # Both aggregates LEFT JOIN a different to-many relation, so the rows
            # fan out (memberships × tasks) before aggregation. ``member_count``
            # is safe because ``distinct=True`` collapses the duplicates; the
            # ``Avg`` is safe because a mean is invariant under the *uniform*
            # duplication this fan-out produces. WARNING: any non-distinct,
            # non-mean aggregate (Sum, Count) added to this same .annotate() over
            # ``tasks`` or ``memberships`` WILL be inflated by the join — split it
            # into a Subquery annotation instead of adding it here.
            qs = qs.filter(program__isnull=True, is_deleted=False, is_archived=False).annotate(
                member_count=Count(
                    "memberships",
                    distinct=True,
                    filter=Q(memberships__is_deleted=False),
                ),
                percent_complete=Avg(
                    "tasks__percent_complete",
                    filter=Q(tasks__is_deleted=False),
                ),
            )
        return qs

    def perform_create(self, serializer: BaseSerializer[Project]) -> None:
        """Create the project and auto-assign the creator as Owner.

        The Owner membership is created in the same request so the creator can
        immediately perform admin operations without a second round-trip.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = serializer.save()
        ProjectMembership.objects.create(
            project=project,
            user=self.request.user,  # type: ignore[misc]
            role=Role.OWNER,
        )
        _record_project_audit_event(
            event_type="project_created",
            actor=self.request.user,
            project=project,
        )
        project_id = str(project.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_created", {"id": project_id})
        )
        payload = {"id": project_id, "name": project.name, "start_date": str(project.start_date)}
        transaction.on_commit(lambda: _dispatch_webhooks(project_id, "project.created", payload))

    def perform_update(self, serializer: BaseSerializer[Project]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Field-level conflict gate (ADR-0217, #322): raises 409 on an overlapping
        # stale write; returns the concurrently-changed fields for the response header.
        self._merge_concurrent_fields = check_field_conflict(self.request, serializer)

        # Capture the persisted calendar before save() mutates the instance in
        # place. CPM lag is calendar-aware (ADR-0027), so swapping the working
        # calendar shifts every task's working-day math — it is a scheduling
        # input change and must trigger a full recompute, exactly like a
        # dependency edit. Without this, edited task dates/floats silently stay
        # computed against the old calendar until some unrelated change forces a
        # recompute (#1267).
        old_calendar_id = serializer.instance.calendar_id if serializer.instance else None

        instance = serializer.save()
        project_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_updated", {"id": project_id})
        )

        if instance.calendar_id != old_calendar_id:
            transaction.on_commit(
                lambda: _enqueue_recalculate(
                    project_id, reason=ScheduleRequestReason.CALENDAR_CHANGE
                )
            )

    def perform_destroy(self, instance: Project) -> None:
        """Delete a project — soft by default, hard when ``?force=true``.

        Soft delete (default): bumps ``server_version`` and sets ``is_deleted``;
        mobile sync clients receive a tombstone. Always permitted for Owner.

        Hard delete (``?force=true``): permanently removes the row. Requires
        the project to already be archived — the two-step "archive → force
        delete" pattern matches the UI dialog and prevents accidental
        irreversible loss. Issues a distinct ``project_hard_deleted`` event so
        clients can hard-evict rather than mark-tombstoned.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.pk)
        force_raw = (self.request.query_params.get("force") or "").lower()
        force = force_raw in ("1", "true", "yes")

        if force:
            if not instance.is_archived:
                from rest_framework.exceptions import ValidationError as DRFValidationError

                raise DRFValidationError(
                    {"detail": "Archive the project before requesting a permanent delete."}
                )
            # ProjectMembership.project is on_delete=PROTECT so a bare
            # Project.delete() raises ProtectedError. The two-step archive →
            # force-delete dialog already gates against accidents; at this
            # point the Owner has confirmed and the membership rows must go
            # with the project row.
            from trueppm_api.apps.access.models import ProjectMembership

            ProjectMembership.objects.filter(project=instance).delete()
            Project.objects.filter(pk=instance.pk).delete()
            _record_project_audit_event(
                event_type="project_deleted",
                actor=self.request.user,
                project=instance,
                metadata={"mode": "hard"},
            )
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id, "project_hard_deleted", {"id": project_id}
                )
            )
            return

        # Capture the team BEFORE the soft-delete + on_commit fan-out so the
        # recipient set is the membership as it stood at delete time. Memberships
        # survive a soft-delete (only the hard-delete path removes them), but
        # binding the ids here keeps the closure independent of later row state.
        # The actor is excluded — you don't notify yourself of your own action.
        # IsProjectOwner already guarantees an authenticated user here, so the cast
        # is safe and narrows request.user off the AnonymousUser union for the query
        # and the display-name lookup below.
        from django.contrib.auth.models import User

        from trueppm_api.apps.access.models import ProjectMembership

        actor = cast(User, self.request.user)
        team_recipient_ids: list[str | None] = [
            str(uid)
            for uid in ProjectMembership.objects.filter(project=instance, is_deleted=False)
            .exclude(user=actor)
            .values_list("user_id", flat=True)
        ]

        # Tombstone the project ROW synchronously — instant and cheap — then
        # offload the child cascade (#1112). Overview/retrieve/list all filter
        # is_deleted=False, so the project reads as gone the moment this commits,
        # even while the enqueued cascade is still draining its children.
        # Record who deleted it (#1113) so the Trash list can show "Deleted by X";
        # set before soft_delete() so it lands in the same UPDATE as is_deleted.
        instance.deleted_by = actor
        instance.soft_delete()
        _record_project_audit_event(
            event_type="project_deleted",
            actor=self.request.user,
            project=instance,
            metadata={"mode": "soft"},
        )
        # Offload the (potentially ~24k round-trip) child tombstone cascade to a
        # background task; enqueue_* defers dispatch via transaction.on_commit so a
        # rolled-back request never fires the worker.
        from trueppm_api.apps.projects.services import enqueue_project_cascade_soft_delete

        enqueue_project_cascade_soft_delete(project_id)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_deleted", {"id": project_id})
        )
        # In-app team notification (#1115). Only on soft-delete: the project row
        # survives the retention window, so the Notification.project FK stays valid
        # and the member can restore it from Trash. The hard-delete path removes the
        # project row (and cascades its notifications away), so there is nothing to
        # link back to and no retention window to restore within — no notification
        # there by design. Deferred via on_commit so the durable inbox rows are
        # written only if the delete actually commits (mirrors the _notify_event
        # calls elsewhere). NEVER push: create_event_notifications routes in-app +
        # opt-in email only, so this can never surface as an unsolicited interrupt.
        if team_recipient_ids:
            actor_name = (actor.get_full_name() or actor.get_username()).strip()
            project_name = instance.name
            subject = f'Project "{project_name}" was deleted'
            body = (
                f'{actor_name} deleted the project "{project_name}". '
                "You can restore it from Trash while it is in the retention window."
            )
            transaction.on_commit(
                # Literal mirrors NotificationEventType.PROJECT_DELETED — the other
                # _notify_event sites use the bare event string the same way, and it
                # keeps the notifications import lazy (inside _notify_event) to avoid
                # a module-load cycle.
                lambda: _notify_event(
                    "project.deleted",
                    team_recipient_ids,
                    subject,
                    body,
                    project_id,
                )
            )

    @extend_schema(
        summary="Get the product backlog grooming view",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Grooming payload: epics with nested stories and rollups, "
                    "ungrouped stories, a grooming-health summary, and the active "
                    "scoring model."
                ),
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="product-backlog")
    def product_backlog(self, request: Request, pk: str | None = None) -> Response:
        """Grooming view payload (ADR-0105 DA-10): epics with nested stories + health.

        One query for the project's backlog stories (status=BACKLOG, sprint-less,
        non-epic) plus its epics, assembled into epic groups with rollups and a
        grooming-health summary. The active scoring model is passed into each
        TaskSerializer via context so the computed ``score`` needs no per-row query.
        """
        from trueppm_api.apps.projects.models import (
            DorState,
            Sprint,
            SprintScopeChange,
            TaskStatus,
            TaskType,
        )
        from trueppm_api.apps.projects.product_backlog_services import ac_counts

        project = self.get_object()
        model = project.prioritization_model
        ctx = {**self.get_serializer_context(), "prioritization_model": model}

        # Prefetch what TaskSerializer reads per row so the grooming view stays O(1) in
        # queries rather than O(stories): assignments (+resource), acceptance criteria
        # (the AC meter + nested read), and the ADR-0060 sprint scope-change rows. Without
        # these the serializer N+1s on every story/epic (perf-check 🔴).
        def _backlog_qs() -> Any:
            return (
                Task.objects.filter(project=project, is_deleted=False)
                # ADR-0124 (#1135): the TaskSerializer blocker getters read
                # blocked_by (actor) and blocking_task (soft link); select_related
                # so each blocked story serializes them without a per-row query
                # (mirrors annotate_tasks_queryset). Both are forward FKs.
                .select_related("blocked_by", "blocking_task")
                .prefetch_related(
                    "assignments__resource",
                    # select_related("met_by") collapses each criterion's
                    # met_by_name review-trail lookup so a satisfied DoR criterion
                    # costs no extra query (mirrors annotate_tasks_queryset, #922).
                    db_models.Prefetch(
                        "acceptance_criteria",
                        queryset=AcceptanceCriterion.objects.select_related("met_by"),
                    ),
                    db_models.Prefetch(
                        "sprint_scope_changes",
                        queryset=SprintScopeChange.objects.select_related("added_by"),
                        to_attr="_prefetched_sprint_scope_changes",
                    ),
                    # Nested label pills (ADR-0400): this LIST path bypasses
                    # annotate_tasks_queryset, so prefetch labels here too or the
                    # serializer N+1s one query per story/epic. Filter tombstoned
                    # labels so a soft-deleted label never renders as a pill.
                    db_models.Prefetch("labels", queryset=Label.objects.filter(is_deleted=False)),
                )
                # Freshness signal (ADR-0143, #740) — this LIST path bypasses
                # annotate_tasks_queryset, so annotate latest_note_at here too or
                # the field renders null on the grooming board.
                .annotate(
                    latest_note_at=db_models.Max(
                        "notes_log__created_at",
                        filter=db_models.Q(notes_log__is_deleted=False),
                    )
                )
            )

        epics = list(_backlog_qs().filter(type=TaskType.EPIC).order_by("priority_rank", "name"))
        stories = list(
            _backlog_qs()
            .filter(status=TaskStatus.BACKLOG, sprint__isnull=True)
            .exclude(type=TaskType.EPIC)
            .order_by("priority_rank", "short_id")
        )

        def ser(task: Task) -> dict[str, Any]:
            return TaskSerializer(task, context=ctx).data

        grouped: dict[Any, list[Task]] = {}
        ungrouped: list[Task] = []
        for s in stories:
            if s.parent_epic_id:
                grouped.setdefault(s.parent_epic_id, []).append(s)
            else:
                ungrouped.append(s)

        epic_payload = []
        for e in epics:
            children = grouped.get(e.id, [])
            pts = sum(c.story_points or 0 for c in children)
            done = sum((c.story_points or 0) for c in children if c.status == TaskStatus.COMPLETE)
            epic_payload.append(
                {
                    "epic": ser(e),
                    "stories": [ser(c) for c in children],
                    "rollup": {
                        "story_count": len(children),
                        "points_total": pts,
                        "points_done": done,
                    },
                }
            )

        # Grooming health (DA-10 strip). ready-line capacity reads the active sprint
        # (ADR-0073) — advisory only (ADR-0105 §F).
        total = len(stories)
        ready = sum(1 for s in stories if s.dor == DorState.READY)
        unestimated = sum(1 for s in stories if s.story_points is None)
        ac_met_total = sum(ac_counts(s)[0] for s in stories)
        ac_all = sum(ac_counts(s)[1] for s in stories)
        active_sprint = (
            Sprint.objects.filter(project=project, state="ACTIVE", is_deleted=False)
            .order_by("-start_date")
            .first()
        )
        ready_points = sum((s.story_points or 0) for s in stories if s.dor == DorState.READY)

        return Response(
            {
                "epics": epic_payload,
                "ungrouped": [ser(s) for s in ungrouped],
                "health": {
                    "dor_pct": round(100 * ready / total) if total else 0,
                    "ready_count": ready,
                    "ready_points": ready_points,
                    "capacity_points": getattr(active_sprint, "capacity_points", None),
                    "unestimated": unestimated,
                    "ac_met": ac_met_total,
                    "ac_total": ac_all,
                    "story_count": total,
                },
                "scoring": {"model": model},
            }
        )

    @extend_schema(
        summary="Auto-rank the product backlog from the active scoring model",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Body includes the reranked count and the active scoring model.",
            )
        },
    )
    @action(detail=True, methods=["post"], url_path="product-backlog/auto-rank")
    def product_backlog_auto_rank(self, request: Request, pk: str | None = None) -> Response:
        """One-shot recompute of priority_rank from the active model (ADR-0105 DA-11)."""
        from trueppm_api.apps.projects.product_backlog_services import auto_rank

        project = self.get_object()
        changed = auto_rank(project, request.user)
        return Response({"reranked": changed, "model": project.prioritization_model})

    @extend_schema(
        summary="Manually reorder the product backlog",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Body includes the updated row count.",
            ),
            400: OpenApiResponse(description="Malformed body (missing, oversized, or invalid)."),
            409: OpenApiResponse(
                description=(
                    "Backlog changed under the client; body includes the conflicting ids "
                    "so the client refetches and replays the drag."
                )
            ),
        },
    )
    @action(detail=True, methods=["post"], url_path="product-backlog/reorder")
    def product_backlog_reorder(self, request: Request, pk: str | None = None) -> Response:
        """Manual drag reorder of the project backlog (ADR-0110, #494).

        Body: ``{"stories": [{"id": "<uuid>", "server_version": <int>}, ...]}`` in target
        priority order — the *complete* current backlog. Writes dense ``priority_rank`` 1..N,
        optimistic-locked on ``server_version``. Returns ``200 {"updated": <count>}``; ``409``
        with the offending ids if the backlog changed under the client (a story was added,
        removed, or reordered concurrently) so the client refetches and replays the drag.
        ``400`` on a malformed body. Idempotency-Key is honored via ``IdempotencyMixin``.
        """
        from trueppm_api.apps.projects.product_backlog_services import (
            BacklogReorderConflict,
            reorder_backlog,
        )

        project = self.get_object()

        # A fuzzed/malformed request body may be a JSON list or scalar, not an
        # object — guard the .get so it degrades to the 400 below instead of an
        # unhandled AttributeError (#2213). None flows into the list check.
        stories_data = request.data.get("stories") if isinstance(request.data, dict) else None
        if not isinstance(stories_data, list) or not stories_data:
            return Response(
                {"stories": ["This field is required and must be a non-empty list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Bound the payload before the parse loop + select_for_update: a project backlog is
        # realistically a few hundred stories, so 2000 is generous headroom while preventing
        # a giant list from exhausting CPU and locking every backlog row (DoS guard).
        if len(stories_data) > 2000:
            return Response(
                {"stories": ["Too many entries to reorder in one request (max 2000)."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        invalid: list[str] = []
        parsed: list[tuple[str, int]] = []
        for entry in stories_data:
            if not isinstance(entry, dict):
                invalid.append(repr(entry))
                continue
            tid = entry.get("id")
            sv = entry.get("server_version")
            # bool is an int subclass — exclude it so {"server_version": true} is rejected.
            if not isinstance(tid, str) or not isinstance(sv, int) or isinstance(sv, bool):
                invalid.append(repr(entry))
                continue
            try:
                uuid.UUID(tid)
            except ValueError:
                invalid.append(tid)
                continue
            parsed.append((tid, sv))

        if invalid:
            bad = ", ".join(invalid)
            return Response(
                {"stories": [f"Invalid entries (expected {{id, server_version}}): {bad}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Reject duplicate ids up front — a dup would make the completeness set-diff pass
        # while the order is ambiguous.
        ids = [tid for tid, _ in parsed]
        if len(set(ids)) != len(ids):
            return Response(
                {"stories": ["Duplicate task ids in the ordered list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            changed = reorder_backlog(project, parsed, request.user)
        except BacklogReorderConflict as exc:
            return Response(
                {"detail": "Backlog changed — reload and retry.", "conflicts": exc.ids},
                status=status.HTTP_409_CONFLICT,
            )
        return Response({"updated": changed})

    @extend_schema(
        summary="Promote / demote tasks in the board queue",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Body includes the updated row count.",
            ),
            400: OpenApiResponse(
                description=(
                    "Malformed body, or an id that is not a live NOT_STARTED / IN_PROGRESS / "
                    "REVIEW task of this project."
                )
            ),
            409: OpenApiResponse(
                description=(
                    "A task changed under the client; body includes the conflicting ids so "
                    "the client refetches and replays the reorder."
                )
            ),
        },
    )
    @action(detail=True, methods=["post"], url_path="queue/reorder")
    def queue_reorder(self, request: Request, pk: str | None = None) -> Response:
        """Promote / demote tasks in the board queue's priority-sorted groups (issue 1610).

        Body: ``{"tasks": [{"id": "<uuid>", "server_version": <int>}, ...]}`` — one queue
        group (*Next up* or *In flight*) in the target display order. Writes dense
        ``priority_rank = position * 10``, optimistic-locked per row on ``server_version``.
        Returns ``200 {"updated": <count>}``; ``409`` with the offending ids if a row moved
        under the client; ``400`` on a malformed body or an id that is not a live, reorderable
        (NOT_STARTED / IN_PROGRESS / REVIEW) task of this project. Unlike the product-backlog
        reorder there is no set-completeness check — the queue may be filtered, so a partial
        group is a valid reorder (see ``reorder_queue_priority``).
        """
        from trueppm_api.apps.projects.services import (
            QueueReorderConflict,
            QueueReorderValidation,
            reorder_queue_priority,
        )

        project = self.get_object()

        # Guard against a non-object body (fuzzed list/scalar) so .get degrades to
        # the 400 below rather than an unhandled AttributeError (#2213).
        tasks_data = request.data.get("tasks") if isinstance(request.data, dict) else None
        if not isinstance(tasks_data, list) or not tasks_data:
            return Response(
                {"tasks": ["This field is required and must be a non-empty list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Bound the payload before the parse loop + select_for_update — a queue group is
        # realistically a few hundred rows; 2000 is generous headroom while preventing a
        # giant list from locking every task row (DoS guard). Mirrors product_backlog_reorder.
        if len(tasks_data) > 2000:
            return Response(
                {"tasks": ["Too many entries to reorder in one request (max 2000)."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        invalid: list[str] = []
        parsed: list[tuple[str, int]] = []
        for entry in tasks_data:
            if not isinstance(entry, dict):
                invalid.append(repr(entry))
                continue
            tid = entry.get("id")
            sv = entry.get("server_version")
            # bool is an int subclass — exclude it so {"server_version": true} is rejected.
            if not isinstance(tid, str) or not isinstance(sv, int) or isinstance(sv, bool):
                invalid.append(repr(entry))
                continue
            try:
                uuid.UUID(tid)
            except ValueError:
                invalid.append(tid)
                continue
            parsed.append((tid, sv))

        if invalid:
            bad = ", ".join(invalid)
            return Response(
                {"tasks": [f"Invalid entries (expected {{id, server_version}}): {bad}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ids = [tid for tid, _ in parsed]
        if len(set(ids)) != len(ids):
            return Response(
                {"tasks": ["Duplicate task ids in the ordered list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            changed = reorder_queue_priority(project, parsed, request.user)
        except QueueReorderValidation as exc:
            bad = ", ".join(exc.ids)
            return Response(
                {"tasks": [f"Not reorderable in the queue: {bad}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except QueueReorderConflict as exc:
            return Response(
                {"detail": "Queue changed — reload and retry.", "conflicts": exc.ids},
                status=status.HTTP_409_CONFLICT,
            )
        return Response({"updated": changed})

    @extend_schema(
        summary="Archive a project",
        responses={200: ProjectSerializer},
    )
    @action(detail=True, methods=["post"], url_path="archive")
    def archive(self, request: Request, pk: str | None = None) -> Response:
        """Mark the project as archived (read-only) (#530).

        Idempotent — archiving an already-archived project succeeds with the
        existing ``archived_at`` / ``archived_by`` values preserved. Owner only.
        Broadcasts ``project_archived`` so connected clients flip their UI to
        read-only without a manual refresh.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = self.get_object()
        if not project.is_archived:
            project.is_archived = True
            project.archived_at = timezone.now()
            project.archived_by = request.user
            project.save(update_fields=["is_archived", "archived_at", "archived_by"])
            project_id = str(project.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "project_archived", {"id": project_id})
            )
        serializer = self.get_serializer(project)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Unarchive a project",
        responses={200: ProjectSerializer},
    )
    @action(detail=True, methods=["post"], url_path="unarchive")
    def unarchive(self, request: Request, pk: str | None = None) -> Response:
        """Restore writes on an archived project (#530). Owner only."""
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = self.get_object()
        if project.is_archived:
            project.is_archived = False
            project.archived_at = None
            project.archived_by = None
            project.save(update_fields=["is_archived", "archived_at", "archived_by"])
            project_id = str(project.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "project_unarchived", {"id": project_id})
            )
        serializer = self.get_serializer(project)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def _trashed_queryset(self) -> QuerySet[Project]:
        """Membership-scoped queryset of the caller's soft-deleted projects (#1113).

        Deliberately bypasses ``ProjectScopedViewSet.get_queryset()``'s
        ``is_deleted=False`` filter — the Trash list and Restore need the tombstoned
        rows the normal project surface hides. Still membership-scoped (only projects
        the caller is an active member of) so it never leaks another team's trash; the
        Owner-only gate on ``restore`` is enforced separately by ``IsProjectOwner``.
        """
        user = self.request.user
        if user is None or not user.is_authenticated:
            return Project.objects.none()
        member_ids = ProjectMembership.objects.filter(user=user, is_deleted=False).values_list(
            "project_id", flat=True
        )
        return Project.objects.filter(pk__in=member_ids, is_deleted=True).select_related(
            "deleted_by"
        )

    @extend_schema(
        summary="List soft-deleted projects in Trash (recoverable within the retention window)",
        responses={
            200: inline_serializer(
                name="TrashProjectList",
                many=True,
                fields={
                    "id": serializers.UUIDField(),
                    "name": serializers.CharField(),
                    "code": serializers.CharField(),
                    "deleted_at": serializers.DateTimeField(allow_null=True),
                    "deleted_by": serializers.UUIDField(allow_null=True),
                    "deleted_by_name": serializers.CharField(allow_null=True),
                    "days_remaining": serializers.IntegerField(allow_null=True),
                    "retention_days": serializers.IntegerField(allow_null=True),
                    "my_role": serializers.IntegerField(allow_null=True),
                    "can_restore": serializers.BooleanField(),
                },
            )
        },
    )
    @suppress_list_pagination
    @action(detail=False, methods=["get"], url_path="trash")
    def trash(self, request: Request) -> Response:
        """List the caller's soft-deleted projects still inside the retention window (#1113).

        Any member sees their own team's trashed projects (the queryset is
        membership-scoped); ``can_restore`` is true only for the Owner, so the web can
        disable Restore for non-Owners. The retention window comes from the #1114
        resolver: rows past ``now - window`` are omitted (they are eligible for the
        background purge and may already be gone); a NULL ``deleted_at`` (legacy delete,
        never auto-purged) is always shown with an indefinite retention.
        """
        from datetime import timedelta

        from trueppm_api.apps.observability.retention import resolve_retention

        retention_days = resolve_retention("TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS")
        now = timezone.now()
        qs = self._trashed_queryset().order_by("-deleted_at")
        if retention_days is not None:
            cutoff = now - timedelta(days=retention_days)
            qs = qs.filter(Q(deleted_at__isnull=True) | Q(deleted_at__gt=cutoff))
        projects = list(qs)
        # Caller's role per project in one query (no N+1) so the web can gate Restore.
        role_by_project = {
            pid: role
            for pid, role in ProjectMembership.objects.filter(
                user=request.user.pk, is_deleted=False, project__in=projects
            ).values_list("project_id", "role")
        }
        rows = []
        for p in projects:
            days_remaining: int | None = None
            if retention_days is not None and p.deleted_at is not None:
                elapsed = (now - p.deleted_at).days
                days_remaining = max(0, retention_days - elapsed)
            role = role_by_project.get(p.pk)
            deleter = p.deleted_by
            rows.append(
                {
                    "id": str(p.pk),
                    "name": p.name,
                    "code": p.code,
                    "deleted_at": p.deleted_at,
                    "deleted_by": str(p.deleted_by_id) if p.deleted_by_id else None,
                    "deleted_by_name": (
                        (deleter.get_full_name() or deleter.get_username()).strip()
                        if deleter is not None
                        else None
                    ),
                    "days_remaining": days_remaining,
                    "retention_days": retention_days,
                    "my_role": role,
                    "can_restore": role == Role.OWNER,
                }
            )
        return Response(rows, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Restore a soft-deleted project from Trash",
        request=None,
        responses={
            200: ProjectSerializer,
            404: OpenApiResponse(description="No soft-deleted project with that id in your Trash."),
        },
    )
    @action(detail=True, methods=["post"], url_path="restore")
    def restore(self, request: Request, pk: str | None = None) -> Response:
        """Un-tombstone a soft-deleted project and all its children atomically (#1113).

        Owner-only (``IsProjectOwner``), scoped to the caller's Trash. The project row
        and every currently-tombstoned child (tasks, dependency edges, sprints,
        baselines, risks) are un-tombstoned in a single ``transaction.atomic()`` block:
        a failure part-way through rolls the whole restore back rather than leave a
        half-restored project (ADR-0202). Every restored row's ``server_version`` is
        bumped so offline sync clients re-materialize it on their next delta.

        The child restore is itself idempotent (a re-run touches only still-tombstoned
        rows), but a *second HTTP restore* of an already-live project returns **404**:
        once restored it is no longer in the caller's Trash, so ``_trashed_queryset`` no
        longer resolves it. The action therefore fails closed on a double-submit rather
        than re-applying — clients must not rely on a 200 for an already-restored id.
        """
        from trueppm_api.apps.projects.models import cascade_project_children_restore
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Look up the tombstoned row directly — self.get_object() would 404 because the
        # normal queryset filters is_deleted=False. check_object_permissions still runs
        # IsProjectOwner (and the archive-bypass) against it.
        project = get_object_or_404(self._trashed_queryset(), pk=pk)
        self.check_object_permissions(request, project)

        with transaction.atomic():
            project.restore()
            cascade_project_children_restore(project)
            _record_project_audit_event(
                event_type="project_restored",
                actor=request.user,
                project=project,
                metadata={"mode": "restore"},
            )

        project_id = str(project.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_restored", {"id": project_id})
        )
        serializer = self.get_serializer(project)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Record a last-visited ping for this project",
        request=None,
        responses={
            200: inline_serializer(
                name="ProjectVisitResponse",
                fields={"recorded": serializers.BooleanField()},
            )
        },
    )
    @action(detail=True, methods=["post"], url_path="visit")
    def visit(self, request: Request, pk: str | None = None) -> Response:
        """Record that the current user just opened this project (ADR-0150, #1182).

        Fire-and-forget from the web ``ProjectShell`` mount; feeds the real
        last-visited landing default (``services.most_recent_project``). The write
        is server-side coalesced to at most once per minute per (user, project) —
        a coalesced ping returns ``200 {"recorded": false}`` (a no-op, never a
        429: a dropped navigation ping is inconsequential). Any member (Viewer+)
        may record their own visit; the upsert is scoped to ``request.user`` so a
        user can never affect another user's visit row.
        """
        from trueppm_api.apps.profiles.services import record_project_visit
        from trueppm_api.apps.projects.throttles import claim_visit_window

        project = self.get_object()
        if claim_visit_window(request.user.pk, project.pk):
            record_project_visit(request.user, project)
            return Response({"recorded": True}, status=status.HTTP_200_OK)
        return Response({"recorded": False}, status=status.HTTP_200_OK)

    # -- Composable working calendars (#906, ADR-0251) ----------------------

    def _applied_calendars_with_roles(
        self, project: Project
    ) -> list[tuple[ProjectCalendarLayer | None, str, Calendar]]:
        """Ordered ``[(layer_or_None, role, calendar)]`` — base first, then overlays.

        The base carries ``layer=None`` and ``role=project``; overlays carry their
        ``ProjectCalendarLayer`` row and its role, ordered by ``sort_order`` (the
        model's default ordering). Callers must have prefetched ``calendar`` and
        ``calendar_layers__calendar`` (plus their exceptions for the preview).
        """
        applied: list[tuple[ProjectCalendarLayer | None, str, Calendar]] = []
        base = project.calendar
        if base is not None:
            applied.append((None, CalendarRole.PROJECT.value, base))
        for layer in project.calendar_layers.all():
            applied.append((layer, layer.role, layer.calendar))
        return applied

    def _serialize_applied_calendars(self, project: Project) -> dict[str, Any]:
        base_data = CalendarSerializer(project.calendar).data if project.calendar_id else None
        applied: list[dict[str, Any]] = []
        for order, (layer, role, calendar) in enumerate(
            self._applied_calendars_with_roles(project)
        ):
            applied.append(
                {
                    "layer_id": layer.id if layer is not None else None,
                    "role": role,
                    "sort_order": layer.sort_order if layer is not None else order,
                    "calendar": CalendarSerializer(calendar).data,
                }
            )
        overlays = [entry for entry in applied if entry["role"] != CalendarRole.PROJECT.value]
        return {"base": base_data, "overlays": overlays, "applied": applied}

    @extend_schema(
        methods=["GET"],
        summary="Get the calendars applied to a project (base + overlays)",
        responses={200: AppliedCalendarsSerializer},
    )
    @extend_schema(
        methods=["PUT"],
        summary="Replace the calendars applied to a project",
        request=ApplyCalendarsSerializer,
        responses={200: AppliedCalendarsSerializer},
    )
    @action(detail=True, methods=["get", "put"], url_path="calendars")
    def working_calendars(self, request: Request, pk: str | None = None) -> Response:
        """Get or atomically replace a project's composed working-calendar set (#906).

        The project's effective non-working mask for CPM is the overlay (union) of
        its base ``Calendar`` plus every applied ``ProjectCalendarLayer`` — a day is
        non-working if *any* applied calendar marks it so (ADR-0251). ``GET`` is
        any-member; ``PUT`` is Scheduler+ (gated in ``_rbac_permissions``).
        """
        project = self.get_object()  # 404 + object-level permission
        if request.method == "PUT":
            return self._replace_working_calendars(request, project)
        project = (
            Project.objects.select_related("calendar")
            .prefetch_related("calendar__exceptions", "calendar_layers__calendar__exceptions")
            .get(pk=project.pk)
        )
        return Response(self._serialize_applied_calendars(project))

    def _replace_working_calendars(self, request: Request, project: Project) -> Response:
        serializer = ApplyCalendarsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        base_id = data.get("base_calendar_id")
        overlays = data["overlays"]

        # Validate every referenced calendar against the shared org library in one
        # query — a 400 for an unknown id beats a 500 on the FK insert, and never
        # leaks whether the id exists in some other tenant (all calendars are org
        # -shared, so existence is not sensitive here).
        referenced = {o["calendar_id"] for o in overlays}
        if base_id is not None:
            referenced.add(base_id)
        found = set(Calendar.objects.filter(id__in=referenced).values_list("id", flat=True))
        missing = referenced - found
        if missing:
            raise DRFValidationError(
                {"detail": f"Unknown calendar id(s): {', '.join(str(m) for m in sorted(missing))}."}
            )

        with transaction.atomic():
            # Atomic replace: set the base FK, then drop and rebuild the overlay
            # layer rows so sort_order matches the submitted array order. One
            # on_commit recompute covers the whole change (composition is
            # order-independent, but the mask/exception set did change).
            # update_fields=["calendar"] so a concurrent write to an unrelated
            # Project column (name/status/dates) between this handler's read and
            # write is not clobbered by a full-row save. VersionedModel.save still
            # bumps server_version atomically, so the base-calendar change rides the
            # sync delta.
            project.calendar_id = base_id
            project.save(update_fields=["calendar"])
            project.calendar_layers.all().delete()
            ProjectCalendarLayer.objects.bulk_create(
                [
                    ProjectCalendarLayer(
                        project=project,
                        calendar_id=o["calendar_id"],
                        role=o["role"],
                        sort_order=idx,
                    )
                    for idx, o in enumerate(overlays)
                ]
            )

            def _dispatch(pid: str = str(project.id)) -> None:
                _enqueue_recalculate(pid, reason=ScheduleRequestReason.CALENDAR_CHANGE)

            transaction.on_commit(_dispatch)

        project = (
            Project.objects.select_related("calendar")
            .prefetch_related("calendar__exceptions", "calendar_layers__calendar__exceptions")
            .get(pk=project.pk)
        )
        return Response(self._serialize_applied_calendars(project), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Preview effective working time for a project's composed calendars",
        parameters=[
            OpenApiParameter("start", str, required=True, description="ISO date, inclusive."),
            OpenApiParameter("end", str, required=True, description="ISO date, inclusive."),
        ],
        responses={200: CalendarPreviewSerializer},
    )
    @action(detail=True, methods=["get"], url_path="calendars/preview")
    def working_calendars_preview(self, request: Request, pk: str | None = None) -> Response:
        """Per-day effective working time over a window, with source provenance (#906).

        For each day in ``[start, end]`` returns whether it is working and, if not,
        which applied calendar(s) blocked it — the "why is this day off?" affordance.
        Provenance requires evaluating each applied calendar individually (the merged
        composition loses which source caused a block). Window capped at 366 days to
        keep it O(days × layers). Any project member (Viewer+).
        """
        from trueppm_api.apps.scheduling.services import build_sched_calendar

        _MAX_PREVIEW_DAYS = 366

        obj = self.get_object()  # 404 + object-level permission
        project = (
            Project.objects.select_related("calendar")
            .prefetch_related("calendar__exceptions", "calendar_layers__calendar__exceptions")
            .get(pk=obj.pk)
        )

        def _parse(param: str) -> datetime.date:
            raw = request.query_params.get(param)
            if not raw:
                raise DRFValidationError({param: f"'{param}' is required (YYYY-MM-DD)."})
            try:
                return datetime.date.fromisoformat(raw)
            except ValueError:
                raise DRFValidationError(
                    {param: f"'{param}' must be a valid ISO 8601 date (YYYY-MM-DD)."}
                ) from None

        start = _parse("start")
        end = _parse("end")
        if end < start:
            raise DRFValidationError({"end": "'end' must be on or after 'start'."})
        if (end - start).days + 1 > _MAX_PREVIEW_DAYS:
            raise DRFValidationError(
                {"end": f"Preview window is capped at {_MAX_PREVIEW_DAYS} days."}
            )

        # One scheduler Calendar per applied source, so a per-day is_working_day
        # check attributes the block back to its source calendar.
        sources = [
            (role, calendar, build_sched_calendar(calendar))
            for (_layer, role, calendar) in self._applied_calendars_with_roles(project)
        ]

        days: list[dict[str, Any]] = []
        day = start
        while day <= end:
            blocking = [
                {"role": role, "calendar_id": calendar.id, "name": calendar.name}
                for (role, calendar, sched) in sources
                if not sched.is_working_day(day)
            ]
            days.append({"date": day, "working": not blocking, "sources": blocking})
            day += datetime.timedelta(days=1)

        return Response({"start": start, "end": end, "days": days})

    @extend_schema(
        summary="Transfer project ownership",
        responses={
            200: ProjectSerializer,
            400: OpenApiResponse(description="Missing new_owner_user_id or invalid transfer."),
            404: OpenApiResponse(description="Target user not found."),
        },
    )
    @action(detail=True, methods=["post"], url_path="transfer")
    def transfer(self, request: Request, pk: str | None = None) -> Response:
        """Transfer project ownership to another existing member (#530).

        Body: ``{"new_owner_user_id": "<uuid>"}``. The target must already be
        a project member at any role — invite first if necessary. The current
        OWNER is atomically demoted to ADMIN.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = self.get_object()
        new_owner_id = request.data.get("new_owner_user_id")
        if not new_owner_id:
            return Response(
                {"detail": "new_owner_user_id is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from django.contrib.auth import get_user_model

        User = get_user_model()
        try:
            new_owner = User.objects.get(pk=new_owner_id)
        except (User.DoesNotExist, DjangoValidationError, ValueError):
            return Response(
                {"detail": "User not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        try:
            transfer_project_ownership(
                project=project,
                new_owner=new_owner,
                actor=request.user,
            )
        except DjangoValidationError as exc:
            return Response(
                # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
                {"detail": exc.messages[0] if exc.messages else str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        project_id = str(project.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id,
                "project_transferred",
                {"id": project_id, "new_owner_id": str(new_owner.pk)},
            )
        )
        serializer = self.get_serializer(project)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @extend_schema(
        methods=["GET"],
        summary="Export project as canonical JSON seed (synchronous)",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "A downloadable canonical JSON seed document (ADR-0109) describing this "
                    "single project inside a synthesized single-project program wrapper. "
                    "Round-trips back through the importer."
                ),
            ),
        },
    )
    @extend_schema(
        methods=["POST"],
        summary="Queue a richer asynchronous project export bundle",
        request=None,
        responses={
            202: OpenApiResponse(
                response=ProjectExportJobSerializer,
                description=(
                    "An async export job (ADR-0219, #1266). The job builds a .tar.gz "
                    "bundle containing the JSON seed, MS Project XML (MSPDI), task "
                    "attachments, time entries, and the project audit/change history. "
                    "Poll GET .../export/jobs/{job_id}/ until status is 'success', then "
                    "fetch download_url. Admin+ only; an in-flight job is returned rather "
                    "than queuing a duplicate build."
                ),
            ),
        },
    )
    @action(detail=True, methods=["get", "post"], url_path="export")
    def export(self, request: Request, pk: str | None = None) -> HttpResponse:
        """GET: synchronous JSON seed (#967). POST: queue the async bundle (#1266).

        The GET path mirrors program export (#616): a synchronous JSON attachment built
        from ``export_project`` + ``dump_seed``, open to any project member, available on
        archived projects. The POST path (ADR-0219) enqueues the richer async ``.tar.gz``
        bundle and returns ``202`` with the job row; it is Admin+ (see get_permissions).
        """
        project = self.get_object()

        if request.method == "POST":
            from trueppm_api.apps.projects.services import enqueue_project_export

            job = enqueue_project_export(project=project, requested_by=request.user)
            return Response(ProjectExportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)

        from trueppm_api.apps.projects.seed.exporter import dump_seed, export_project

        body = dump_seed(export_project(project))
        filename = f"{project.code or project.pk}.json"
        response = HttpResponse(body, content_type="application/json")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response

    @extend_schema(
        summary="List this project's async export jobs",
        responses={200: ProjectExportJobSerializer(many=True)},
    )
    @action(detail=True, methods=["get"], url_path="export/jobs")
    def export_jobs(self, request: Request, pk: str | None = None) -> Response:
        """List recent async export jobs for this project (#1266, ADR-0219). Admin+.

        Page-number envelope so an integrator can tell a truncated list from a complete
        one. Scoped to the resolved (membership-checked) project, so no cross-project rows
        leak.
        """
        project = self.get_object()
        jobs = ProjectExportJob.objects.filter(project=project)
        paginator = pagination.PageNumberPagination()
        page = paginator.paginate_queryset(jobs, request, view=self)
        data = ProjectExportJobSerializer(page if page is not None else jobs, many=True).data
        return paginator.get_paginated_response(data)

    @extend_schema(
        summary="Poll one async export job's status",
        responses={200: ProjectExportJobSerializer},
    )
    @action(
        detail=True,
        methods=["get"],
        url_path=r"export/jobs/(?P<job_id>[0-9a-f-]{36})",
    )
    def export_job_detail(
        self, request: Request, pk: str | None = None, job_id: str | None = None
    ) -> Response:
        """Poll an async export job (#1266, ADR-0219). Admin+.

        The job is looked up scoped to the resolved project, so a ``job_id`` belonging
        to another project 404s rather than leaking (object-level IDOR guard).
        """
        project = self.get_object()
        job = get_object_or_404(ProjectExportJob, pk=job_id, project=project)
        return Response(ProjectExportJobSerializer(job).data)

    @extend_schema(
        summary="Download a completed async export bundle",
        responses={
            (200, "application/gzip"): OpenApiResponse(
                response=OpenApiTypes.BINARY,
                description="The project export .tar.gz as a file attachment.",
            ),
            409: OpenApiResponse(
                response=OpenApiTypes.OBJECT, description="Export is not ready yet."
            ),
            410: OpenApiResponse(
                response=OpenApiTypes.OBJECT, description="Download link has expired."
            ),
        },
    )
    @action(
        detail=True,
        methods=["get"],
        url_path=r"export/jobs/(?P<job_id>[0-9a-f-]{36})/download",
    )
    def export_job_download(
        self, request: Request, pk: str | None = None, job_id: str | None = None
    ) -> Any:
        """Stream a completed export bundle (#1266, ADR-0219). Admin+.

        Authenticated — the archive contains the whole project including its audit
        history, so it is never served from a raw, unauthenticated storage URL. ``409``
        if not ready, ``410 Gone`` once the link has expired. The job is project-scoped
        so a ``job_id`` from another project 404s (object-level IDOR guard).
        """
        from django.core.files.storage import default_storage

        project = self.get_object()
        job = get_object_or_404(ProjectExportJob, pk=job_id, project=project)
        if job.status != ExportJobStatus.SUCCESS or not job.file_path:
            return Response({"detail": "Export is not ready yet."}, status=status.HTTP_409_CONFLICT)
        if job.expires_at is not None and job.expires_at < timezone.now():
            return Response(
                {"detail": "This export has expired. Request a new one."},
                status=status.HTTP_410_GONE,
            )
        try:
            handle = default_storage.open(job.file_path, "rb")
        except (FileNotFoundError, OSError) as exc:
            raise Http404("Export archive is no longer available.") from exc
        return FileResponse(
            handle,
            as_attachment=True,
            filename=f"project-{project.code or project.pk}.tar.gz",
            content_type="application/gzip",
        )

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="start",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window start (inclusive), ISO 8601 YYYY-MM-DD. Defaults to the "
                    "near-term window start (today - 8 weeks, clamped into the CPM span)."
                ),
            ),
            OpenApiParameter(
                name="end",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window end (inclusive), ISO 8601 YYYY-MM-DD. Defaults to the "
                    "near-term window end (today + 8 weeks, clamped into the CPM span)."
                ),
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Sparse map of resource -> working day -> "
                    "{hours, task_ids, load_pct, load_band, overallocated} for the "
                    "requested window. load_band is on-track | at-risk | critical "
                    "(>100% load); each resource also carries a top-level "
                    "overallocated flag (true if any day exceeds 100%)."
                ),
            ),
            409: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="No CPM dates exist on any task (scheduler not run yet).",
            ),
        },
    )
    @action(detail=True, methods=["get"], url_path="utilization")
    def utilization(self, request: Request, pk: str | None = None) -> Response:
        """Per-resource daily utilization for a project.

        Returns a sparse map of resource → working day → {hours, task_ids}.
        Requires Resource Manager role (SCHEDULER ≥ 2).

        Query parameters:
          start (YYYY-MM-DD) — window start, inclusive; defaults to the near-term
                               window start (see below).
          end   (YYYY-MM-DD) — window end, inclusive; defaults to the near-term
                               window end (see below).

        When the caller omits ``start``/``end`` the default is a *near-term heat
        map*: anchored on today, capped at ±8 weeks, and clamped into the project
        CPM span ``[first early_start, last early_finish]``.  Clamping the anchor
        into the span means a project scheduled entirely in the past or future
        still returns its nearest real working days instead of an empty window
        (an unclamped today ± 8 weeks produced exactly that — #772).  The ±8-week
        cap keeps the per-day expansion at O(assignments × ~16 weeks) instead of
        O(assignments × full multi-year span).  Pass explicit bounds to request a
        wider range (up to the full project span).

        Returns 409 when no CPM dates exist on any task (scheduler not run yet).
        """
        from trueppm_api.apps.projects.utilization import compute_utilization

        # Half-width of the default near-term window (today ± this many weeks).
        _DEFAULT_WINDOW_WEEKS = 8

        project = self.get_object()  # handles 404 + object-level permission check

        # Resolve window bounds
        start_str = request.query_params.get("start")
        end_str = request.query_params.get("end")

        def _parse_date(s: str, param: str) -> datetime.date:
            try:
                return datetime.date.fromisoformat(s)
            except ValueError:
                raise ValueError(f"'{param}' must be a valid ISO 8601 date (YYYY-MM-DD).") from None

        try:
            if start_str and end_str:
                # Caller fully specifies the window — no CPM-span lookup needed.
                window_start = _parse_date(start_str, "start")
                window_end = _parse_date(end_str, "end")
            else:
                # At least one bound is defaulted: derive the near-term window
                # from the CPM span. The min/max aggregates are cheap, indexed
                # single-row lookups — the expensive part the perf fix targets is
                # the per-day expansion in compute_utilization, which the ±8-week
                # cap below bounds regardless of project length.
                first = (
                    project.tasks.filter(is_deleted=False, early_start__isnull=False)
                    .order_by("early_start")
                    .values_list("early_start", flat=True)
                    .first()
                )
                if first is None:
                    return Response(
                        {"detail": "Schedule has not been computed. Run the scheduler first."},
                        status=status.HTTP_409_CONFLICT,
                    )
                last = (
                    project.tasks.filter(is_deleted=False, early_finish__isnull=False)
                    .order_by("-early_finish")
                    .values_list("early_finish", flat=True)
                    .first()
                ) or first
                # Anchor on today, but clamp the anchor into [first, last] so a
                # schedule entirely in the past or future still yields its nearest
                # real days rather than an empty window.
                anchor = min(max(timezone.localdate(), first), last)
                window = datetime.timedelta(weeks=_DEFAULT_WINDOW_WEEKS)
                window_start = (
                    _parse_date(start_str, "start") if start_str else max(anchor - window, first)
                )
                window_end = _parse_date(end_str, "end") if end_str else min(anchor + window, last)

        except ValueError as exc:
            # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        if window_start > window_end:
            return Response(
                {"detail": "'start' must not be after 'end'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        result = compute_utilization(project, window_start, window_end)
        return Response(result)

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="start",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window start, ISO 8601 YYYY-MM-DD. Defaults to the earliest "
                    "early_start across all tasks; returns 409 if no CPM dates exist."
                ),
            ),
            OpenApiParameter(
                name="end",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window end, ISO 8601 YYYY-MM-DD. Defaults to the latest "
                    "early_finish across all tasks."
                ),
            ),
            OpenApiParameter(
                name="resource",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                many=True,
                description="Filter to specific resource IDs. Repeatable.",
            ),
            OpenApiParameter(
                name="status",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                many=True,
                description="Filter tasks by status value. Repeatable.",
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Per-resource task spans within the window: "
                    "{project_id, window_start, window_end, resources: "
                    "[{id, name, email, max_units, tasks: [{assignment_id, id, "
                    "name, early_start, early_finish, units, status}]}]}."
                ),
            ),
            409: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="No CPM dates exist (scheduler not run yet).",
            ),
        },
    )
    @action(detail=True, methods=["get"], url_path="resource-allocation")
    def resource_allocation(self, request: Request, pk: str | None = None) -> Response:
        """Per-resource task spans for the allocation timeline view (issue #85).

        Returns each resource assigned to the project with their task spans
        (early_start / early_finish / units / status) within the requested window.
        Resources with no assignments in the window are excluded.

        Overallocation detection is intentionally client-side: the caller receives
        all spans and computes daily unit sums against max_units. See ADR-0031.

        Query parameters:
          start    (YYYY-MM-DD, optional) — window start; defaults to earliest
                   early_start across all tasks. Returns 409 if no CPM dates exist.
          end      (YYYY-MM-DD, optional) — window end; defaults to latest
                   early_finish across all tasks.
          resource (UUID, optional, repeatable) — filter to specific resource IDs.
          status   (string, optional, repeatable) — filter tasks by status value.
        """
        from trueppm_api.apps.resources.models import TaskResource

        project = self.get_object()

        def _parse_date(s: str, param: str) -> datetime.date:
            try:
                return datetime.date.fromisoformat(s)
            except ValueError:
                raise ValueError(f"'{param}' must be a valid ISO 8601 date (YYYY-MM-DD).") from None

        # --- Resolve window bounds ---
        start_str = request.query_params.get("start")
        end_str = request.query_params.get("end")

        try:
            if start_str:
                window_start: datetime.date = _parse_date(start_str, "start")
            else:
                first = (
                    project.tasks.filter(is_deleted=False, early_start__isnull=False)
                    .order_by("early_start")
                    .values_list("early_start", flat=True)
                    .first()
                )
                if first is None:
                    return Response(
                        {"detail": "Schedule has not been computed. Run the scheduler first."},
                        status=status.HTTP_409_CONFLICT,
                    )
                window_start = first

            if end_str:
                window_end: datetime.date = _parse_date(end_str, "end")
            else:
                last = (
                    project.tasks.filter(is_deleted=False, early_finish__isnull=False)
                    .order_by("-early_finish")
                    .values_list("early_finish", flat=True)
                    .first()
                )
                window_end = last if last is not None else window_start

        except ValueError as exc:
            # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        if window_start > window_end:
            return Response(
                {"detail": "'start' must not be after 'end'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # --- Optional filters ---
        resource_ids = request.query_params.getlist("resource")
        status_filters = request.query_params.getlist("status")

        # --- Single query: all assignments for this project in the window ---
        # Tasks with null early_start / early_finish are included (unscheduled);
        # the client renders them in the "Unscheduled" section.
        qs = (
            TaskResource.objects.filter(
                task__project=project,
                task__is_deleted=False,
            )
            .select_related("resource", "task")
            .order_by("resource__name", "task__early_start")
        )

        if resource_ids:
            qs = qs.filter(resource__id__in=resource_ids)

        if status_filters:
            qs = qs.filter(task__status__in=status_filters)

        # Exclude tasks that are completely outside the window (both dates not null
        # and finish < window_start or start > window_end). Tasks with null dates
        # are retained for the unscheduled section.
        qs = qs.exclude(
            task__early_finish__isnull=False,
            task__early_start__isnull=False,
            task__early_finish__lt=window_start,
        ).exclude(
            task__early_finish__isnull=False,
            task__early_start__isnull=False,
            task__early_start__gt=window_end,
        )

        # --- Build response grouped by resource ---
        resources_map: dict[str, dict[str, Any]] = {}
        for assignment in qs:
            resource = assignment.resource
            rid = str(resource.id)
            if rid not in resources_map:
                resources_map[rid] = {
                    "id": rid,
                    "name": resource.name,
                    "email": resource.email,
                    "max_units": str(resource.max_units),
                    "tasks": [],
                }
            task = assignment.task
            resources_map[rid]["tasks"].append(
                {
                    "assignment_id": str(assignment.id),
                    "id": str(task.id),
                    "name": task.name,
                    "early_start": task.early_start.isoformat() if task.early_start else None,
                    "early_finish": task.early_finish.isoformat() if task.early_finish else None,
                    "units": str(assignment.units),
                    "status": task.status,
                }
            )

        return Response(
            {
                "project_id": str(project.id),
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "resources": list(resources_map.values()),
            }
        )

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="weeks",
                type=OpenApiTypes.INT,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Rolling window width in weeks; one of 4, 8, 12, 16. Defaults to 8.",
            ),
            OpenApiParameter(
                name="start",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "ISO 8601 YYYY-MM-DD; normalised to the Monday of that week. "
                    "Defaults to the Monday of the current ISO week."
                ),
            ),
            OpenApiParameter(
                name="group_by",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                enum=["role", "project", "none"],
                description="Row sort hint; one of role, project, none. Defaults to none.",
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Week x person utilization heatmap.",
            ),
            409: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="No CPM dates exist on any task.",
            ),
        },
    )
    @action(detail=True, methods=["get"], url_path="resources/heatmap")
    def heatmap(self, request: Request, pk: str | None = None) -> Response:
        """Week × person utilization heatmap (issue #217, ADR-0042).

        Query parameters:
          weeks    (4|8|12|16, default 8)  — rolling window width
          start    (YYYY-MM-DD, optional)  — Monday of first week; defaults to
                                             Monday of the current ISO week
          group_by (role|project|none, default none) — row sort hint; sorting
                                             is done server-side so clients that
                                             don't implement re-sort still work,
                                             but clients MAY re-sort from the
                                             returned job_role field without a
                                             second request.

        Returns 409 when no CPM dates exist on any task.
        """
        from trueppm_api.apps.projects.utilization import aggregate_utilization_weekly

        project = self.get_object()

        weeks_str = request.query_params.get("weeks", "8")
        try:
            num_weeks = int(weeks_str)
            if num_weeks not in (4, 8, 12, 16):
                return Response(
                    {"detail": "weeks must be 4, 8, 12, or 16."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        except ValueError:
            return Response(
                {"detail": "weeks must be an integer."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        start_str = request.query_params.get("start")
        try:
            if start_str:
                start_date: datetime.date = datetime.date.fromisoformat(start_str)
            else:
                today = timezone.localdate()
                start_date = today - datetime.timedelta(days=today.weekday())
        except ValueError:
            return Response(
                {"detail": "'start' must be a valid ISO 8601 date (YYYY-MM-DD)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Normalise to Monday of the given week regardless of what day was passed.
        start_date = start_date - datetime.timedelta(days=start_date.weekday())

        group_by = request.query_params.get("group_by", "none")
        if group_by not in ("role", "project", "none"):
            return Response(
                {"detail": "group_by must be 'role', 'project', or 'none'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        has_cpm = project.tasks.filter(is_deleted=False, early_start__isnull=False).exists()
        if not has_cpm:
            return Response(
                {"detail": "Schedule has not been computed. Run the scheduler first."},
                status=status.HTTP_409_CONFLICT,
            )

        result = aggregate_utilization_weekly(project, start_date, num_weeks, group_by)
        return Response(result)

    @extend_schema(
        summary="Get the resources KPI summary",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Resource KPIs over an 8-week window: avg utilization, "
                    "over/under-allocation counts, headcount, and contractor count."
                ),
            ),
            409: OpenApiResponse(description="Schedule has not been computed; run the scheduler."),
        },
    )
    @action(detail=True, methods=["get"], url_path="resources/summary")
    def resources_summary(self, request: Request, pk: str | None = None) -> Response:
        """KPI summary for the Resources page header (issue #219, ADR-0042).

        Computes four metrics over an 8-week rolling window from today:
          avg_utilization_pct, over_allocated_count, over_allocated_weeks,
          under_utilized_count, under_utilized_names, headcount, contractor_count.

        Returns 409 when no CPM dates exist.
        """
        from trueppm_api.apps.projects.utilization import aggregate_utilization_weekly
        from trueppm_api.apps.resources.models import ProjectResource

        project = self.get_object()

        has_cpm = project.tasks.filter(is_deleted=False, early_start__isnull=False).exists()
        if not has_cpm:
            return Response(
                {"detail": "Schedule has not been computed. Run the scheduler first."},
                status=status.HTTP_409_CONFLICT,
            )

        today = timezone.localdate()
        start_date = today - datetime.timedelta(days=today.weekday())
        heatmap = aggregate_utilization_weekly(project, start_date, 8, "none")

        # Headcount from project roster (not just assigned resources).
        project_resources = list(
            ProjectResource.objects.select_related("resource").filter(
                project=project, is_deleted=False
            )
        )
        headcount = len(project_resources)
        contractor_count = sum(
            1
            for pr in project_resources
            if "contractor" in (pr.resource.job_role or "").lower()
            or "contractor" in (pr.role_title or "").lower()
        )

        all_util: list[int] = [u for r in heatmap["resources"] for u in r["util"] if u > 0]
        avg_util = round(sum(all_util) / len(all_util)) if all_util else 0

        over_allocated = [r for r in heatmap["resources"] if any(u > 100 for u in r["util"])]
        # Under-utilised: assigned in at least one week but avg < 70 % across the window.
        under_utilized = [
            r
            for r in heatmap["resources"]
            if any(u > 0 for u in r["util"]) and (sum(r["util"]) / len(r["util"])) < 70
        ]

        # Collect distinct over-allocated week labels and format as "W21–W23".
        over_week_indices: list[int] = sorted(
            {i for r in over_allocated for i, u in enumerate(r["util"]) if u > 100}
        )
        if over_week_indices:
            first_w = heatmap["weeks"][over_week_indices[0]].split("-W")[1]
            last_w = heatmap["weeks"][over_week_indices[-1]].split("-W")[1]
            over_weeks_str = f"W{first_w}-W{last_w}" if first_w != last_w else f"W{first_w}"
        else:
            over_weeks_str = ""

        def _short_name(full_name: str) -> str:
            parts = full_name.split()
            return f"{parts[0][0]}. {parts[-1]}" if len(parts) >= 2 else full_name

        return Response(
            {
                "avg_utilization_pct": avg_util,
                "over_allocated_count": len(over_allocated),
                "over_allocated_weeks": over_weeks_str,
                "under_utilized_count": len(under_utilized),
                "under_utilized_names": [_short_name(r["name"]) for r in under_utilized[:3]],
                "headcount": headcount,
                "contractor_count": contractor_count,
            }
        )

    @extend_schema(
        summary="Get the project status summary",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Task counts and health signals for the shell: task_count, "
                    "critical/at-risk counts, top-5 critical and at-risk task lists, "
                    "and recency metadata."
                ),
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="status-summary")
    def status_summary(self, request: Request, pk: str | None = None) -> Response:
        """Project health summary for the TopBar and StatusBar shell components.

        Returns task counts, health signals, and recency metadata in a single
        request so the shell avoids waterfall fetches on every project view.

        At-risk: incomplete tasks with total_float <= 5 working days (or
        negative float, which means already late).
        Critical: incomplete tasks where is_critical=True.

        P80 is omitted (null) until a Monte Carlo result store is added — the
        front-end falls back to "P80: —" when the field is null.
        """
        project = self.get_object()

        # Single aggregate (#812): the three counts previously fired three
        # separate COUNT queries against the same base queryset. status_summary
        # is hit on every dashboard mount; collapsing to one aggregate() saves
        # 2 DB round-trips per call without changing the response shape.
        from django.db.models import Count, Q

        live_tasks = project.tasks.filter(is_deleted=False)
        counts = live_tasks.aggregate(
            task_count=Count("id"),
            at_risk_count=Count(
                "id",
                filter=~Q(status=TaskStatus.COMPLETE)
                & Q(total_float__isnull=False)
                & Q(total_float__lte=5),
            ),
            critical_count=Count(
                "id",
                filter=~Q(status=TaskStatus.COMPLETE) & Q(is_critical=True),
            ),
        )
        task_count = counts["task_count"]
        at_risk_count = counts["at_risk_count"]
        critical_count = counts["critical_count"]

        # Top-5 lists for the dropdown menus still need to fetch the WBS path
        # and name fields; those are bounded LIMIT 5 queries and not collapsed
        # into the aggregate.
        incomplete_tasks = live_tasks.exclude(status=TaskStatus.COMPLETE)
        at_risk_qs = (
            incomplete_tasks.filter(
                total_float__isnull=False,
                total_float__lte=5,
            )
            .order_by("total_float", "wbs_path")
            .values("id", "name", "wbs_path")[:5]
        )
        at_risk_tasks = [
            {"id": str(t["id"]), "name": t["name"], "wbs": t["wbs_path"]} for t in at_risk_qs
        ]

        critical_qs = (
            incomplete_tasks.filter(is_critical=True)
            .order_by("wbs_path")
            .values("id", "name", "wbs_path")[:5]
        )
        critical_tasks = [
            {"id": str(t["id"]), "name": t["name"], "wbs": t["wbs_path"]} for t in critical_qs
        ]

        # Task model uses server_version rather than auto_now timestamps, so
        # last_saved / recalculated_at are returned as null. The redesigned
        # StatusBar (issue #201) does not display these fields; they remain
        # in the response shape only for ShellStats back-compat.
        return Response(
            {
                "task_count": task_count,
                # `critical_path_count` was an exact alias of `critical_count`
                # (same aggregate). Dropped pre-0.3 so the public status-summary
                # contract carries the count once (#1325).
                "monte_carlo_p80": None,
                "at_risk_count": at_risk_count,
                "critical_count": critical_count,
                "at_risk_tasks": at_risk_tasks,
                "critical_tasks": critical_tasks,
                "last_saved": None,
                "recalculated_at": None,
            },
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        summary="Health summary across the caller's own projects (ADR-0401, #1941)",
        responses={
            200: inline_serializer(
                name="ProjectHealthSummary",
                many=True,
                fields={
                    "id": serializers.UUIDField(),
                    "name": serializers.CharField(),
                    "health_band": serializers.CharField(),
                    "at_risk_count": serializers.IntegerField(),
                    "critical_count": serializers.IntegerField(),
                },
            )
        },
    )
    @suppress_list_pagination
    @action(detail=False, methods=["get"], url_path="health-summary")
    def health_summary(self, request: Request) -> Response:
        """Compact "my projects" health triage for the My Work page (ADR-0401).

        Returns one row per project the caller is a member of (excluding archived),
        each carrying a derived ``health_band`` plus the same at-risk / critical task
        counts the single-project status-summary uses, so a PM overseeing many
        projects can see "which of mine is on fire?" without opening each.

        Scope is the caller's OWN member projects (adoption lens, OSS) — it is NOT a
        cross-program or portfolio rollup (that governance surface stays Enterprise,
        ADR-0030/0088). The membership filter lives in ProjectScopedViewSet.get_queryset.

        At-risk / critical use the status_summary semantics: incomplete tasks with
        total_float <= 5 working days → at_risk_count; incomplete is_critical=True →
        critical_count. ``distinct=True`` on both conditional counts matches the
        annotate-over-reverse-FK convention of ProgramViewSet.projects — defensive
        against fan-out if a second to-many join is ever added to this queryset (the
        membership scope is a ``pk__in`` subquery, not a join, so today there is only
        the one ``tasks`` join).

        health_band is derived: the manual Project.health override wins when set (not
        AUTO); otherwise counts-first — critical_count > 0 → critical, else
        at_risk_count > 0 → at_risk, else on_track.
        """
        from django.db.models import Count, Q

        incomplete = ~Q(tasks__status=TaskStatus.COMPLETE) & Q(tasks__is_deleted=False)
        rows = (
            self.get_queryset()
            .filter(is_archived=False)
            .annotate(
                at_risk_count=Count(
                    "tasks",
                    filter=incomplete
                    & Q(tasks__total_float__isnull=False)
                    & Q(tasks__total_float__lte=5),
                    distinct=True,
                ),
                critical_count=Count(
                    "tasks",
                    filter=incomplete & Q(tasks__is_critical=True),
                    distinct=True,
                ),
            )
            .values("id", "name", "health", "at_risk_count", "critical_count")
            .order_by("name")
        )

        override = {
            Health.ON_TRACK.value: "on_track",
            Health.AT_RISK.value: "at_risk",
            Health.CRITICAL.value: "critical",
        }

        def compute_band(health: str, at_risk: int, critical: int) -> str:
            manual = override.get(health)  # None when AUTO
            if manual is not None:
                return manual
            if critical > 0:
                return "critical"
            if at_risk > 0:
                return "at_risk"
            return "on_track"

        return Response(
            [
                {
                    "id": str(row["id"]),
                    "name": row["name"],
                    "health_band": compute_band(
                        row["health"], row["at_risk_count"], row["critical_count"]
                    ),
                    "at_risk_count": row["at_risk_count"],
                    "critical_count": row["critical_count"],
                }
                for row in rows
            ],
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        summary="Blocked tasks on this project (ADR-0124, #1134)",
        responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="blocker_type",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Filter to one BlockerType (dependency / resource / vendor / "
                    "decision / other). Unknown value → 400."
                ),
            ),
            OpenApiParameter(
                name="min_age_days",
                type=OpenApiTypes.INT,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Keep only tasks blocked at least N days. Non-negative integer; "
                    "negative or non-integer → 400."
                ),
            ),
        ],
    )
    @action(detail=True, methods=["get"], url_path="blocked")
    def blocked(self, request: Request, pk: str | None = None) -> Response:
        """List flagged-blocked tasks on this project — the PM's impediment roll-up.

        Returns every task whose ``blocked_reason`` is non-empty (the flag of
        record), oldest-blocked first (age drives escalation), each row carrying
        ``blocker_type`` + age + actor + assignee + the soft ``blocking_task`` link.
        Optionally narrowed by ``?blocker_type=`` and ``?min_age_days=`` (#1157) —
        both filter on the team-shareable structured signal only.

        Reason text is **omitted entirely** from every row, for every requester —
        the roll-up is a triage surface, not a place to read contributor voice
        (ADR-0124 §4, the Morgan boundary). The private reason is read only on the
        task drawer, gated to the assignee + @-mentioned. There is no filter, sort,
        or search param on reason anywhere on this endpoint — the filters touch only
        ``blocker_type`` and ``blocked_since`` (age).

        Project membership (Viewer+) is required — enforced by the viewset
        permission classes plus ``check_object_permissions`` on the project.
        """
        from trueppm_api.apps.projects.blocker_services import (
            parse_blocked_filters,
            project_blocked_rollup,
        )

        project = self.get_object()
        self.check_object_permissions(request, project)
        filters = parse_blocked_filters(request.query_params)
        return Response(project_blocked_rollup(project, **filters), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Decision-flagged notes for this project (ADR-0167, #748)",
        parameters=[
            OpenApiParameter(
                name="sprint",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Scope to one sprint's decisions. Omit for the whole project "
                    "(including closed sprints)."
                ),
            )
        ],
        responses={200: DecisionNoteSerializer(many=True)},
    )
    @action(detail=True, methods=["get"], url_path="decisions")
    def decisions(self, request: Request, pk: str | None = None) -> Response:
        """Paginated list of decision-flagged task notes for the project (ADR-0167 §2).

        Serves both Decisions views under one gate: no ``sprint`` param → every decision
        across the project, **including closed sprints** (the project view); ``?sprint=<id>``
        → that sprint's decisions (the sprint view, the web passes the active sprint id).
        Visibility is team-owned — an oversight reader (a non-team, sub-Admin project
        member) is suppressed with 403 until the team opts in via
        ``ProjectDecisionsPolicy.oversight_visible``. The gate runs before any filtering so
        ``?sprint`` can never be a hole around it.
        """
        from rest_framework.exceptions import PermissionDenied

        from trueppm_api.apps.projects.decisions_services import (
            can_read_decisions,
            decision_notes_queryset,
        )

        project = self.get_object()
        self.check_object_permissions(request, project)
        if not can_read_decisions(request, project.pk):
            raise PermissionDenied(
                "Decisions are visible to the team and project managers. A project admin "
                "can extend visibility to oversight stakeholders."
            )
        sprint_id = request.query_params.get("sprint")
        if sprint_id:
            try:
                uuid.UUID(sprint_id)
            except (ValueError, TypeError):
                return Response(
                    {"detail": "Invalid sprint id."}, status=status.HTTP_400_BAD_REQUEST
                )
        qs = decision_notes_queryset(project.pk, sprint_id=sprint_id or None)
        page = self.paginate_queryset(qs)
        serializer = DecisionNoteSerializer(page if page is not None else qs, many=True)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Get the project integrations summary",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Aggregated webhooks and API tokens sections for the project.",
            ),
            503: OpenApiResponse(
                description="A subservice failed; body includes a `failed` key naming the section."
            ),
        },
    )
    @action(detail=True, methods=["get"], url_path="integrations-summary")
    def integrations_summary(self, request: Request, pk: str | None = None) -> Response:
        """Project-scoped integrations summary for the Project → Settings → Integrations page.

        Aggregates the project's outbound webhooks (ADR-0019) and inbound API tokens
        (ADR-0068) into a single round-trip so the settings page avoids waterfall
        fetches. Per ADR-0076, the page is read-only in 0.2; CRUD is delegated to the
        underlying viewsets via deep-links from the UI.

        Each section is computed independently. If one subservice errors, the
        response degrades gracefully: a 503 is returned with a ``failed`` key
        naming the section, and the frontend falls back to fetching that section
        via its own viewset (the per-section retry contract from ADR-0076).
        """
        project = self.get_object()
        sections: dict[str, Any] = {}

        try:
            sections["webhooks"] = _summarize_webhooks(Q(project_id=project.id))
        except Exception:
            logger.exception("integrations-summary webhooks subservice failed")
            return Response(
                {"failed": "webhooks"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            sections["api_tokens"] = _summarize_api_tokens(Q(project_id=project.id))
        except Exception:
            logger.exception("integrations-summary api_tokens subservice failed")
            return Response(
                {"failed": "api_tokens"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(sections, status=status.HTTP_200_OK)

    @extend_schema(
        summary="List unresolved retro carryover action items",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Body includes an `items` array of unresolved action items from the "
                    "last one or two completed retros."
                ),
            )
        },
    )
    @action(
        detail=True,
        methods=["get"],
        url_path="retrospective/carryover",
    )
    def retro_carryover(self, request: Request, pk: str | None = None) -> Response:
        """Unresolved retro action items from the last 1–2 completed retros.

        Used by the Sprint Planning "From last retro" lane (ADR-0071 §4b).

        An item is "unresolved" when:
          - ``promoted_task_id IS NULL`` (never promoted to a Task), OR
          - the promoted Task is not yet COMPLETE.

        Items are scoped to the project; the response is the union over the
        most recent two COMPLETED retros for the project, sorted by source
        sprint finish_date descending then by action item created_at.
        """
        from trueppm_api.apps.projects.models import (
            RetroActionItem,
            Task,
            TaskStatus,
        )

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        # Last two COMPLETED sprints with a retro.
        prior_sprints = list(
            Sprint.objects.filter(
                project_id=project.pk,
                state=SprintState.COMPLETED,
                is_deleted=False,
                retro__isnull=False,
            )
            .order_by("-finish_date")
            .values_list("pk", "short_id", "finish_date")[:2]
        )
        if not prior_sprints:
            return Response({"items": []}, status=status.HTTP_200_OK)

        sprint_pks = [pk_ for pk_, _, _ in prior_sprints]
        # P23: materialize once so the queryset SQL executes a single time.
        # The lazy queryset was previously iterated twice — once to collect
        # promoted_ids and once in the for-loop — issuing the SQL twice.
        items = list(
            RetroActionItem.objects.filter(
                retro__sprint_id__in=sprint_pks,
                is_deleted=False,
            )
            .select_related("retro__sprint", "assignee")
            .order_by("-retro__sprint__finish_date", "created_at")
        )

        # Resolve the promoted Tasks in a single query to avoid N+1.
        promoted_ids = [it.promoted_task_id for it in items if it.promoted_task_id is not None]
        tasks_by_id: dict[uuid.UUID, Task] = {}
        if promoted_ids:
            for task in Task.objects.filter(pk__in=promoted_ids, is_deleted=False):
                tasks_by_id[task.pk] = task

        today = timezone.now().date()
        rows: list[dict[str, Any]] = []
        for it in items:
            promoted_task = tasks_by_id.get(it.promoted_task_id) if it.promoted_task_id else None
            # Skip if the action item has been promoted AND that task is COMPLETE.
            if promoted_task is not None and promoted_task.status == TaskStatus.COMPLETE:
                continue
            from_sprint = it.retro.sprint
            rows.append(
                {
                    "action_item_id": it.pk,
                    "text": it.text,
                    "from_retro_id": it.retro_id,
                    "from_sprint_id": from_sprint.pk,
                    "from_sprint_short_id": from_sprint.short_id,
                    "promoted_task_id": it.promoted_task_id,
                    "promoted_task_status": promoted_task.status if promoted_task else None,
                    "promoted_task_short_id": promoted_task.short_id if promoted_task else None,
                    "age_days": (today - it.created_at.date()).days,
                    "assignee_id": it.assignee_id,
                    "assignee_username": (
                        getattr(it.assignee, "username", None) if it.assignee_id else None
                    ),
                    "story_points": it.story_points,
                }
            )
        return Response({"items": rows}, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# integrations_summary helpers (ADR-0076)
#
# These will move to apps/integrations/services.py once #302 lands that app.
# Kept module-local in 0.2 so the integrations summary ships without a new
# Django app + migration that #302 will own.
# ---------------------------------------------------------------------------

_INTEGRATIONS_SUMMARY_ITEM_LIMIT = 5
_INTEGRATIONS_RECENT_FAILURE_WINDOW = datetime.timedelta(days=7)


def _summarize_webhooks(scope_filter: Q) -> dict[str, Any]:
    """Compact summary of a scope's outbound webhooks (ADR-0019).

    ``scope_filter`` is a Django Q expression that selects which webhooks to
    include — typically ``Q(project_id=...)`` for the project surface or
    ``Q(program_id=...)`` for the program surface (ADR-0076).

    Returns the most recently created webhooks (up to ``_INTEGRATIONS_SUMMARY_ITEM_LIMIT``)
    plus aggregate counts. The ``last_delivery`` per row is the most recent delivery
    attempt's status + timestamp — non-null only when the webhook has fired at least once.

    The per-row latest-delivery and recent-failure-count fields are computed via
    ``Subquery``/``annotate`` so the entire summary uses a single underlying SQL
    query rather than 2N round-trips. See ADR-0076 perf-check rationale.
    """
    recent_window_start = timezone.now() - _INTEGRATIONS_RECENT_FAILURE_WINDOW

    latest_delivery_sq = (
        WebhookDelivery.objects.filter(webhook=OuterRef("pk"))
        .order_by("-created_at")
        .values("status", "created_at", "response_status", "attempt_count")[:1]
    )

    base_qs = Webhook.objects.filter(scope_filter)
    annotated_qs = base_qs.annotate(
        _latest_status=Subquery(latest_delivery_sq.values("status")),
        _latest_created_at=Subquery(latest_delivery_sq.values("created_at")),
        _latest_response_status=Subquery(latest_delivery_sq.values("response_status")),
        _latest_attempt_count=Subquery(latest_delivery_sq.values("attempt_count")),
        _recent_failure_count=Count(
            "deliveries",
            filter=Q(
                deliveries__status=DeliveryStatus.FAILED,
                deliveries__created_at__gte=recent_window_start,
            ),
        ),
    ).order_by("-created_at")

    total = base_qs.count()
    active_total = base_qs.filter(is_active=True).count()

    items: list[dict[str, Any]] = []
    last_delivery_at: datetime.datetime | None = None
    for webhook in annotated_qs[:_INTEGRATIONS_SUMMARY_ITEM_LIMIT]:
        latest_created_at = getattr(webhook, "_latest_created_at", None)
        latest_status = getattr(webhook, "_latest_status", None)
        items.append(
            {
                "id": str(webhook.id),
                "url": webhook.url,
                "is_active": webhook.is_active,
                "events": list(webhook.events),
                "created_at": webhook.created_at.isoformat(),
                "last_delivery": (
                    {
                        "status": latest_status,
                        "created_at": latest_created_at.isoformat(),
                        "response_status": getattr(webhook, "_latest_response_status", None),
                        "attempt_count": getattr(webhook, "_latest_attempt_count", 0),
                    }
                    if latest_status and latest_created_at
                    else None
                ),
                "recent_failure_count": getattr(webhook, "_recent_failure_count", 0),
            }
        )
        if latest_created_at and (last_delivery_at is None or latest_created_at > last_delivery_at):
            last_delivery_at = latest_created_at

    return {
        "items": items,
        "total": total,
        "active_total": active_total,
        "last_delivery_at": last_delivery_at.isoformat() if last_delivery_at else None,
    }


def _summarize_api_tokens(scope_filter: Q) -> dict[str, Any]:
    """Compact summary of a scope's inbound API tokens (ADR-0068).

    ``scope_filter`` is a Django Q expression that selects which tokens to
    include — typically ``Q(project_id=...)`` for the project surface or
    ``Q(program_id=...)`` for the program surface (ADR-0076).

    Returns non-revoked tokens (up to ``_INTEGRATIONS_SUMMARY_ITEM_LIMIT``) plus the
    aggregate active count. Revoked tokens are intentionally hidden from the summary —
    they remain visible on the dedicated API token page for audit purposes.
    """
    # owner__isnull=True keeps user-scoped Personal Access Tokens (ADR-0214) out
    # of the project/program integration summary — ApiToken is now polymorphic
    # across project/program/owner scopes, and a personal token must never surface
    # on a project's or program's token list even though the scope_filter already
    # pins a specific id.
    qs = ApiToken.objects.filter(
        scope_filter,
        is_deleted=False,
        revoked_at__isnull=True,
        owner__isnull=True,
    ).order_by("-created_at")
    active_total = qs.count()
    last_used_at: datetime.datetime | None = None

    items: list[dict[str, Any]] = []
    for token in qs[:_INTEGRATIONS_SUMMARY_ITEM_LIMIT]:
        items.append(
            {
                "id": str(token.id),
                "name": token.name,
                "token_prefix": token.token_prefix,
                "created_at": token.created_at.isoformat(),
                "last_used_at": (token.last_used_at.isoformat() if token.last_used_at else None),
            }
        )
        if token.last_used_at and (last_used_at is None or token.last_used_at > last_used_at):
            last_used_at = token.last_used_at

    return {
        "items": items,
        "active_total": active_total,
        "last_used_at": last_used_at.isoformat() if last_used_at else None,
    }


def annotate_tasks_queryset(
    qs: QuerySet[Task],
    request: Request | None = None,
    project_id: str | None = None,
) -> QuerySet[Task]:
    """Apply every read-only annotation/prefetch that ``TaskSerializer``'s
    annotation- and method-backed fields depend on (is_summary, parent_id,
    percent_complete_rollup, has_predecessors, predecessor_count, is_blocked,
    linked_risks_*, baseline_*, assignee_is_overallocated, sprint scope changes,
    acceptance criteria).

    Shared by ``TaskViewSet.get_queryset`` and ``TaskBulkView.post`` so a bulk
    create/update response re-fetches its tasks through this *annotated* queryset
    instead of serializing bare instances — without it every annotation-backed
    field on a bulk result degrades to a per-row live query or a silently-wrong
    default (#998).

    ``request`` supplies the optional ``?baseline=`` override; ``project_id`` scopes
    the active-baseline lookup. Both are optional so the non-request bulk re-fetch
    (which passes ``project_id`` explicitly) still gets the full annotation set.
    """
    # Base joins/prefetches matching TaskViewSet's class-level queryset, so a caller
    # that starts from a bare ``Task.objects`` manager (the #998 bulk re-fetch) gets
    # the same per-row-query-free serialization as the list path — not just the
    # annotations below. Idempotent for the viewset path (already applied upstream).
    # ADR-0124 (#1135): blocked_by (actor) and blocking_task (soft link) are read
    # by the TaskSerializer blocker getters — select_related so a list response
    # serializes them without one query per row.
    qs = qs.select_related("project", "sprint", "blocked_by", "blocking_task").prefetch_related(
        "assignments__resource",
        # Nested label pills (ADR-0400) are serialized by TaskSerializer; prefetch
        # here — not just on the list viewset — so the bulk re-fetch path (#998) and
        # any bare-manager caller serialize labels O(1) instead of one query per row.
        # Filter tombstoned labels so a soft-deleted label never renders as a pill.
        db_models.Prefetch("labels", queryset=Label.objects.filter(is_deleted=False)),
    )

    # Summary task annotations: is_summary = has at least one direct child,
    # parent_id = the task whose wbs_path is this task's parent path,
    # percent_complete_rollup = duration-weighted average of direct children's
    #   percent_complete (NULL for leaf tasks, avoids per-row raw query in serializer).
    # Uses ltree operators via RawSQL for PostgreSQL-native performance.
    # All three RawSQL annotations below are static SQL literals with empty params
    # lists (no user input interpolated); the ltree/CTE expressions can't be
    # expressed in the ORM.
    qs = qs.annotate(
        # nosemgrep: avoid-raw-sql
        is_summary=RawSQL(
            "EXISTS("
            "  SELECT 1 FROM projects_task c"
            "  WHERE c.project_id = projects_task.project_id"
            "    AND c.is_deleted = false"
            "    AND c.id != projects_task.id"
            "    AND c.wbs_path IS NOT NULL"
            "    AND projects_task.wbs_path IS NOT NULL"
            "    AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{1}')::lquery"
            ")",
            [],
            output_field=BooleanField(),
        ),
        # is_phase = has at least one direct child that is NOT a subtask, i.e.
        # a structural (WBS) child. A phase is a rollup: its status, estimate,
        # assignee, percent, and time are computed from its children, never set
        # directly (ADR-0293). This refines is_summary — a leaf-with-subtasks is
        # is_summary=True but is_phase=False, because its only children are drawer
        # subtasks, not structural work. Same ltree shape as is_summary with an
        # added ``c.is_subtask = false`` on the child.
        # nosemgrep: avoid-raw-sql
        is_phase=RawSQL(
            "EXISTS("
            "  SELECT 1 FROM projects_task c"
            "  WHERE c.project_id = projects_task.project_id"
            "    AND c.is_deleted = false"
            "    AND c.is_subtask = false"
            "    AND c.id != projects_task.id"
            "    AND c.wbs_path IS NOT NULL"
            "    AND projects_task.wbs_path IS NOT NULL"
            "    AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{1}')::lquery"
            ")",
            [],
            output_field=BooleanField(),
        ),
        # nosemgrep: avoid-raw-sql
        parent_id=RawSQL(
            "("
            "  SELECT p.id FROM projects_task p"
            "  WHERE p.project_id = projects_task.project_id"
            "    AND p.is_deleted = false"
            "    AND projects_task.wbs_path IS NOT NULL"
            "    AND nlevel(projects_task.wbs_path) > 1"
            "    AND p.wbs_path = subpath("
            "        projects_task.wbs_path, 0,"
            "        nlevel(projects_task.wbs_path) - 1"
            "    )"
            "  LIMIT 1"
            ")",
            [],
            output_field=db_models.UUIDField(),
        ),
        # Replaces the per-row Task.objects.raw() in TaskSerializer.to_representation.
        # Returns the delivery-mode-aware weighted average percent_complete of ALL
        # LEAF descendants, or NULL for leaf tasks (which the serializer leaves
        # untouched). ADR-0108 §1: each leaf contributes a (weight, pct) pair from
        # ITS OWN delivery_mode —
        #   waterfall → pct=percent_complete,  weight=duration (working days)
        #   scrum     → pct=story-point burndown (100 if COMPLETE, else
        #               (1 - remaining/story_points)*100, fallback percent_complete),
        #               weight=story_points (fallback duration)
        #   kanban    → pct=100 if COMPLETE else 0,  weight=1 (→ parent %=done/total)
        #   milestone → pct=100 if COMPLETE else 0,  weight=0 (a zero-work gate never
        #               dilutes the phase percent)
        # Mixed-mode subtrees sum weights in each leaf's native unit (documented
        # approximation, ADR-0108). Recurring tasks have wbs_path=NULL so the ltree
        # match already excludes them.
        #
        # Leaf selection: all descendants at any depth ('.*{1,}') minus any that
        # themselves have children (non-leaf), so only leaves contribute — fixes the
        # 3-level grandparent-reads-zero case (intermediate summaries aren't persisted).
        # nosemgrep: avoid-raw-sql
        percent_complete_rollup=RawSQL(
            "("
            "  SELECT CASE WHEN SUM(w.weight) > 0"
            "              THEN SUM(w.weight * w.pct) / SUM(w.weight)"
            "              ELSE NULL END"
            "  FROM ("
            "    SELECT"
            "      CASE c.delivery_mode"
            "        WHEN 'scrum' THEN COALESCE(c.story_points, c.duration)"
            "        WHEN 'kanban' THEN 1"
            "        WHEN 'milestone' THEN 0"
            "        ELSE c.duration"
            "      END AS weight,"
            "      CASE c.delivery_mode"
            "        WHEN 'scrum' THEN"
            "          CASE WHEN c.status = 'COMPLETE' THEN 100.0"
            "               WHEN COALESCE(c.story_points, 0) > 0"
            "                 THEN (1.0 - COALESCE(c.remaining_points, c.story_points)::float"
            "                              / c.story_points) * 100.0"
            "               ELSE c.percent_complete END"
            "        WHEN 'kanban' THEN"
            "          CASE WHEN c.status = 'COMPLETE' THEN 100.0 ELSE 0.0 END"
            "        WHEN 'milestone' THEN"
            "          CASE WHEN c.status = 'COMPLETE' THEN 100.0 ELSE 0.0 END"
            "        ELSE c.percent_complete"
            "      END AS pct"
            "    FROM projects_task c"
            "    WHERE c.project_id = projects_task.project_id"
            "      AND c.is_deleted = false"
            "      AND projects_task.wbs_path IS NOT NULL"
            "      AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{1,}')::lquery"
            "      AND NOT EXISTS ("
            "        SELECT 1 FROM projects_task gc"
            "        WHERE gc.project_id = projects_task.project_id"
            "          AND gc.is_deleted = false"
            "          AND gc.wbs_path ~ (c.wbs_path::text || '.*{1}')::lquery"
            "      )"
            "  ) w"
            ")",
            [],
            output_field=db_models.FloatField(),
        ),
    )

    # Readiness annotation: has_predecessors = task has at least one incoming
    # Dependency edge.  Used by TaskSerializer.get_readiness() to distinguish
    # 'estimated' (has owner, no predecessors) from 'ready' (has owner + predecessors).
    qs = qs.annotate(has_predecessors=Exists(Dependency.objects.filter(successor=OuterRef("pk"))))

    # Board batch 3 (#182, #188) — PPM signal annotations consumed by BoardCard:
    #   predecessor_count       — count of live incoming Dependency edges.
    #   is_blocked              — True when any predecessor is not yet COMPLETE.
    #   linked_risks_count      — count of active linked risks (OPEN + MITIGATING only).
    #   linked_risks_max_severity — Max(probability * impact) across active linked risks.
    # All four are read-only annotations; no migration. ADR-0035.
    active_risk_filter = Q(risks__is_deleted=False) & Q(
        risks__status__in=[RiskStatus.OPEN, RiskStatus.MITIGATING]
    )
    qs = qs.annotate(
        predecessor_count=Count(
            "predecessors",
            filter=Q(predecessors__is_deleted=False),
            distinct=True,
        ),
        is_blocked=Exists(
            Dependency.objects.filter(
                successor=OuterRef("pk"),
                is_deleted=False,
            ).exclude(predecessor__status=TaskStatus.COMPLETE)
        ),
        linked_risks_count=Count(
            "risks",
            filter=active_risk_filter,
            distinct=True,
        ),
        linked_risks_max_severity=Max(
            F("risks__probability") * F("risks__impact"),
            filter=active_risk_filter,
        ),
        # Freshness signal for the board card / schedule row (ADR-0143, #740):
        # timestamp of the most recent non-deleted note on the task.
        latest_note_at=Max(
            "notes_log__created_at",
            filter=Q(notes_log__is_deleted=False),
        ),
    )

    # External-link summary (#767, ADR-0155): the count of a task's non-deleted
    # external links and the *worst* link status across them, for the at-a-glance
    # glyph on the task-list row and the Gantt bar. Two filtered aggregates over the
    # `links` relation (integrations.TaskLink, related_name="links"):
    #   external_link_count      — distinct count of non-deleted links.
    #   external_link_worst_rank — Min of the canonical rank (LINK_STATUS_RANK,
    #                              most-attention-first); the serializer maps it back
    #                              to a status string and null when count is 0.
    # `distinct=True` keeps the count correct under the other multi-relation joins on
    # this queryset; `Min` is multiplication-invariant so the worst rank is correct
    # regardless of join fan-out (same reason linked_risks_max_severity uses a bare
    # filtered Max above). No N+1.
    live_link_filter = Q(links__is_deleted=False)
    qs = qs.annotate(
        external_link_count=Count("links", filter=live_link_filter, distinct=True),
        external_link_worst_rank=Min(
            Case(
                *(
                    When(links__status=status_value, then=rank)
                    for status_value, rank in LINK_STATUS_RANK.items()
                ),
                default=LINK_STATUS_RANK[LINK_STATUS_UNKNOWN],
                output_field=IntegerField(),
            ),
            filter=live_link_filter,
        ),
    )

    # Baseline overlay: annotate each task with baseline_start / baseline_finish.
    # Resolution order:
    #   1. ?baseline=<id> explicit override
    #   2. the project's active baseline (is_active=True)
    #   3. no annotation (both fields are null in the response)
    resolved_baseline_id: str | None = (
        request.query_params.get("baseline") if request is not None else None
    )
    if resolved_baseline_id is None and project_id:
        active = (
            Baseline.objects.filter(project_id=project_id, is_active=True, is_deleted=False)
            .values_list("id", flat=True)
            .first()
        )
        if active is not None:
            resolved_baseline_id = str(active)

    if resolved_baseline_id is not None:
        start_sub = BaselineTask.objects.filter(
            baseline_id=resolved_baseline_id,
            task_id=OuterRef("id"),
        ).values("start")[:1]
        finish_sub = BaselineTask.objects.filter(
            baseline_id=resolved_baseline_id,
            task_id=OuterRef("id"),
        ).values("finish")[:1]
        qs = qs.annotate(
            baseline_start=Subquery(start_sub),
            baseline_finish=Subquery(finish_sub),
        )

    # Wave 3 (#210) — passive overalloc indicator in the task detail drawer.
    # Sum TaskResource.units across all active (non-COMPLETE, non-BACKLOG) tasks
    # in this project where the assignee user matches the outer task's assignee.
    # Resource has no direct user FK, so we join through Task.assignee instead of
    # Resource.user — units allocated to any resource on a task assigned to the
    # same user contribute to that user's overallocation total.
    from trueppm_api.apps.resources.models import TaskResource as _TR

    overallocated_subq = (
        _TR.objects.filter(
            task__assignee_id=OuterRef("assignee_id"),
            task__project_id=OuterRef("project_id"),
            task__status__in=[
                TaskStatus.NOT_STARTED,
                TaskStatus.IN_PROGRESS,
                TaskStatus.REVIEW,
            ],
            task__is_deleted=False,
        )
        .values("task__assignee_id")
        .annotate(total=Sum("units"))
        .filter(total__gt=1.0)
        .values("total")[:1]
    )
    qs = qs.annotate(assignee_is_overallocated=Exists(overallocated_subq))

    # Prefetch sprint scope-change audit rows (ADR-0060) so TaskSerializer
    # can include them without an N+1 query per task.
    from trueppm_api.apps.projects.models import SprintScopeChange

    qs = qs.prefetch_related(
        db_models.Prefetch(
            "sprint_scope_changes",
            queryset=SprintScopeChange.objects.select_related("added_by"),
            to_attr="_prefetched_sprint_scope_changes",
        ),
        # Prefetch acceptance criteria (ADR-0105) into the default related
        # cache so the nested AcceptanceCriterionSerializer and all three
        # ac_counts-backed method fields (criteria_met_count / criteria_total
        # / dor_blockers) reuse a single set per task instead of re-querying
        # per row — without this the four accesses are an N+1 over the task
        # list (#922). select_related("met_by") collapses the review-trail
        # name lookup so each criterion's met_by_name costs no extra query.
        db_models.Prefetch(
            "acceptance_criteria",
            queryset=AcceptanceCriterion.objects.select_related("met_by"),
        ),
    )

    return cast("QuerySet[Task]", qs)


def _attach_milestone_rollups(tasks: list[Task]) -> None:
    """Pre-compute and attach milestone rollups for a page of tasks (#999).

    Batches every milestone task in ``tasks`` through
    ``batch_compute_milestone_rollups`` (2 queries total) and stashes the payload
    on each as ``_milestone_rollup`` so ``TaskSerializer.get_milestone_rollup``
    reads an attribute instead of an O(milestones × sprints) per-row cascade.
    Non-milestone tasks are skipped (the serializer short-circuits on them).
    """
    from trueppm_api.apps.projects.services import batch_compute_milestone_rollups

    milestones = [t for t in tasks if t.is_milestone]
    if not milestones:
        return
    rollups = batch_compute_milestone_rollups(milestones)
    for task in milestones:
        task._milestone_rollup = rollups.get(task.pk)  # type: ignore[attr-defined]


def _attach_target_milestone_rollups(sprints: list[Sprint]) -> None:
    """Pre-compute and attach target-milestone rollups for a page of sprints (#999).

    Mirror of ``_attach_milestone_rollups`` for ``SprintSerializer
    .get_target_milestone_detail`` — batches every linked target milestone in 2
    queries and stashes the payload as ``_target_milestone_rollup`` on each sprint.
    """
    from trueppm_api.apps.projects.services import batch_compute_milestone_rollups

    milestones = [s.target_milestone for s in sprints if s.target_milestone_id is not None]
    if not milestones:
        return
    rollups = batch_compute_milestone_rollups(milestones)
    for sprint in sprints:
        if sprint.target_milestone_id is not None:
            sprint._target_milestone_rollup = rollups.get(  # type: ignore[attr-defined]
                sprint.target_milestone_id
            )


class ScheduleFetchPagination(pagination.PageNumberPagination):
    """Client-tunable pagination for the Schedule view's task/dependency reads (issue 1519).

    The global default (PAGE_SIZE=50) forces the Gantt initial load to walk
    ``ceil(N / 50)`` pages of the ``next`` cursor sequentially — ~20 serial round
    trips for a 1K-task project, repaid on every ``['tasks']`` invalidation. Exposing
    ``page_size`` lets the client request a large first page (200) and fetch the small
    remainder in parallel, collapsing the round-trip count. ``max_page_size`` caps the
    per-request cost so a caller cannot force an unbounded single-page fetch. The global
    default is unchanged; this override applies only to the two Schedule-fetch viewsets.
    """

    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 500


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="project",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to tasks in this project.",
            ),
            OpenApiParameter(
                name="short_id",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter by short_id (case-insensitive; matched upper-cased).",
            ),
            OpenApiParameter(
                name="is_critical",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to critical-path tasks when true (true/1).",
            ),
            OpenApiParameter(
                name="status",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter by task status value.",
            ),
            OpenApiParameter(
                name="type",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Filter by task type value (epic/story/task/bug/spike/tech_debt). "
                    "Backs the board tech-debt filter (ADR-0178, #1076)."
                ),
            ),
            OpenApiParameter(
                name="mine",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "When true (true/1), return only tasks the requesting user is "
                    "assigned to (via Resource.user, with a legacy email fallback)."
                ),
            ),
            OpenApiParameter(
                name="sprint",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Sprint membership filter. A sprint UUID returns only tasks in "
                    "that sprint; the literal 'none' returns only sprint-less tasks "
                    "(project backlog)."
                ),
            ),
            OpenApiParameter(
                name="parent",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Return the subtasks (is_subtask=true) of this parent task.",
            ),
            OpenApiParameter(
                name="is_subtask",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter by the is_subtask flag (true/1 or false/0).",
            ),
            OpenApiParameter(
                name="start__gte",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "ISO 8601 YYYY-MM-DD; keep tasks whose early_finish is at or "
                    "after this date (still active in the window)."
                ),
            ),
            OpenApiParameter(
                name="finish__lte",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "ISO 8601 YYYY-MM-DD; keep tasks whose early_start is at or "
                    "before this date (already started by the window)."
                ),
            ),
            OpenApiParameter(
                name="baseline",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Baseline ID used to annotate each task with baseline_start / "
                    "baseline_finish. Defaults to the project's active baseline when "
                    "?project is supplied."
                ),
            ),
        ],
    ),
)
class TaskViewSet(
    FieldLevelMergeMixin, McpReadableViewMixin, ProjectScopedViewSet, viewsets.ModelViewSet[Task]
):
    """CRUD for tasks within a project.

    CPM output fields (early_start, early_finish, late_start, late_finish,
    total_float, free_float, is_critical) are read-only and populated by
    the auto-scheduling Celery task.

    Permission matrix (issue #11):
      list/retrieve    — any member (IsProjectMember)
      create           — Team Member+ (IsProjectMemberWrite)
      update/destroy   — Project Manager+ or assignee (IsProjectMemberWriteOrOwn)
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite, IsProjectNotArchived]

    def get_permissions(self) -> list[BasePermission]:
        # ADR-0186 §E: append the read-only MCP token guards around the
        # action-specific RBAC list so a mcp:read token is confined to safe
        # methods on every action (no write-branch leak); human auth passes both.
        return [*self._rbac_permissions(), *self.mcp_token_guards()]

    def _rbac_permissions(self) -> list[BasePermission]:
        # restore (#2078) mirrors destroy exactly — whoever could delete a task can
        # un-delete it (Admin+ or the task's assignee via IsProjectMemberWriteOrOwn).
        if self.action in ("update", "partial_update", "destroy", "restore"):
            return [IsAuthenticated(), IsProjectMemberWriteOrOwn(), IsProjectNotArchived()]
        if self.action == "create":
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        if self.action == "approve_estimates":
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        # ADR-0105: splitting a story restructures the backlog → can_manage_backlog
        # (Admin+), the same gate as auto-rank / epic management. The custom
        # get_permissions here overrides the @action's inline permission_classes, so
        # the gate must be declared in this branch to take effect (rbac-check 🟡).
        if self.action == "split":
            return [IsAuthenticated(), IsProjectBacklogManager(), IsProjectNotArchived()]
        # ADR-0217 §2: drag-reorder writes priority_rank → a board edit, gated to
        # Team Member+ (Viewer must not reorder), consistent with create/queue-reorder.
        if self.action == "reorder":
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    serializer_class = TaskSerializer
    # issue 1519: let the Gantt request a large first page and parallelize the walk.
    pagination_class = ScheduleFetchPagination
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name"]
    ordering_fields = ["wbs_path", "name", "early_start", "status"]
    queryset = (
        Task.objects.select_related("project", "sprint")
        .prefetch_related("assignments__resource")
        .filter(is_deleted=False)
    )
    # NB: the board/schedule label-pill prefetch (ADR-0400) lives in
    # annotate_tasks_queryset, not here — every read path (list/retrieve/bulk)
    # routes through it. Prefetching ``labels`` in *both* places double-registers
    # the lookup with a distinct queryset; get_object() then raises ValueError,
    # which get_object_or_404 silently converts to a 404 on every retrieve.

    def get_queryset(self) -> QuerySet[Task]:
        qs = super().get_queryset()
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        short_id = self.request.query_params.get("short_id")
        if short_id:
            qs = qs.filter(short_id=short_id.upper())
        is_critical = self.request.query_params.get("is_critical")
        if is_critical is not None:
            qs = qs.filter(is_critical=is_critical.lower() in ("true", "1"))
        status = self.request.query_params.get("status")
        if status:
            qs = qs.filter(status=status)
        # Task-type filter (ADR-0178, #1076) — backs the board tech-debt toggle
        # and lets any client chart debt distinctly via ?type=tech_debt. An
        # unrecognized value simply matches nothing (consistent with ?status=).
        task_type = self.request.query_params.get("type")
        if task_type:
            qs = qs.filter(type=task_type)

        # "My tasks" filter (issue #198): tasks the requesting user is
        # assigned to via Resource.user. Falls back to email match for
        # legacy resources whose user FK has not been backfilled — keeps
        # pre-#198 fixtures working without a data migration. Distinct
        # collapses the M2M-through join into one row per task.
        mine = self.request.query_params.get("mine")
        if mine and mine.lower() in ("true", "1"):
            user = self.request.user
            user_email = (getattr(user, "email", "") or "").strip().lower()
            mine_q = Q(assignments__resource__user=user)
            if user_email:
                mine_q |= Q(
                    assignments__resource__user__isnull=True,
                    assignments__resource__email__iexact=user_email,
                )
            qs = qs.filter(mine_q).distinct()

        # Sprint membership filter (ADR-0037 Q5):
        #   ?sprint=<uuid>  — only tasks in that sprint
        #   ?sprint=none    — only sprint-less tasks (project backlog)
        sprint_filter = self.request.query_params.get("sprint")
        if sprint_filter == "none":
            qs = qs.filter(sprint__isnull=True)
        elif sprint_filter:
            qs = qs.filter(sprint_id=sprint_filter)

        # Subtask filters (ADR-0060 #308):
        #   ?parent=<uuid>       — subtasks of a specific parent task
        #   ?is_subtask=true     — all drawer-created subtasks in the project
        parent_filter = self.request.query_params.get("parent")
        if parent_filter:
            qs = qs.filter(
                wbs_path__startswith=Task.objects.filter(pk=parent_filter)
                .values_list("wbs_path", flat=True)
                .first()
                or "",
                is_subtask=True,
            ).exclude(pk=parent_filter)
        is_subtask_filter = self.request.query_params.get("is_subtask")
        if is_subtask_filter is not None:
            qs = qs.filter(is_subtask=is_subtask_filter.lower() in ("true", "1"))

        # Date-range filter for calendar / resource views.
        # ?start__gte=YYYY-MM-DD  — tasks whose early_finish >= this date (still active)
        # ?finish__lte=YYYY-MM-DD — tasks whose early_start <= this date (already started)
        # Combined, they return tasks that overlap [start__gte, finish__lte].
        # Parse the date params before filtering: early_start/early_finish are
        # DateFields, so passing an unvalidated string straight into .filter()
        # lets Django raise a ValidationError at query time that the (UUID-only)
        # exception handler doesn't map, surfacing as a 500 (#2213). Coerce here
        # and 400 on a malformed date, matching the _parse idiom above.
        start_gte = self.request.query_params.get("start__gte")
        if start_gte:
            try:
                qs = qs.filter(early_finish__gte=datetime.date.fromisoformat(start_gte))
            except ValueError:
                raise DRFValidationError(
                    {"start__gte": "Must be a valid ISO 8601 date (YYYY-MM-DD)."}
                ) from None
        finish_lte = self.request.query_params.get("finish__lte")
        if finish_lte:
            try:
                qs = qs.filter(early_start__lte=datetime.date.fromisoformat(finish_lte))
            except ValueError:
                raise DRFValidationError(
                    {"finish__lte": "Must be a valid ISO 8601 date (YYYY-MM-DD)."}
                ) from None

        return annotate_tasks_queryset(qs, self.request, project_id)

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Attach batched milestone rollups to the page before serialization.

        ``TaskSerializer.milestone_rollup`` is O(milestones × sprints) when computed
        per row on the hot Gantt fetch (#999). Batch every milestone in the page in
        2 queries here and stash the payload on each task instance so the serializer
        reads an attribute instead of re-querying per milestone.
        """
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        if page is not None:
            _attach_milestone_rollups(list(page))
            serializer = self.get_serializer(page, many=True)
            return self.get_paginated_response(serializer.data)
        tasks = list(queryset)
        _attach_milestone_rollups(tasks)
        serializer = self.get_serializer(tasks, many=True)
        return Response(serializer.data)

    def retrieve(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        # No docstring: keep the class-level permission-matrix description as this
        # operation's public schema. The list() override batches milestone rollups
        # per page; retrieve uses the same _attach_milestone_rollups helper so a
        # single-task fetch of a milestone does not fall back to per-row
        # compute_milestone_rollup_payload. The sprint scope-change prefetch is
        # already attached by annotate_tasks_queryset in get_queryset().
        instance = self.get_object()
        _attach_milestone_rollups([instance])
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    def perform_create(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # H1 fix: DRF does not call has_object_permission on create actions,
        # so we must enforce project membership explicitly before saving.
        project = serializer.validated_data.get("project")
        if project is not None:
            self.check_object_permissions(self.request, project)

        # Auto-assign wbs_path when the client doesn't supply one.  Optional
        # parent_id in the request body places the task as the last child of that
        # parent (e.g. "1.3" if parent "1" already has two children).  Without a
        # parent_id the task is appended at root level.
        #
        # The count + save share one atomic block so the SELECT FOR UPDATE lock
        # covers the INSERT and prevents concurrent creates racing to the same path.
        is_subtask = str(self.request.data.get("is_subtask", "")).lower() in ("true", "1")
        parent: Task | None = None

        with transaction.atomic():
            if not serializer.validated_data.get("wbs_path") and project is not None:
                from rest_framework.exceptions import ErrorDetail
                from rest_framework.exceptions import ValidationError as DRFValidationError

                parent_id = self.request.data.get("parent_id")
                if parent_id:
                    try:
                        parent = Task.objects.select_for_update().get(
                            pk=parent_id, project=project, is_deleted=False
                        )
                    except Task.DoesNotExist as exc:
                        raise DRFValidationError(
                            {"parent_id": "Parent task not found in this project."}
                        ) from exc
                    if not parent.wbs_path:
                        raise DRFValidationError({"parent_id": "Parent task has no WBS path."})
                    # Milestone guard (#1773): a milestone is a zero-duration gate,
                    # not a container — it must never acquire children, or the phase
                    # rollup would try to aggregate under a node the CPM treats as a
                    # single point. Mirrors the subtask depth-1 / phase guards below.
                    if parent.is_milestone:
                        raise DRFValidationError(
                            {
                                "parent_id": [
                                    ErrorDetail(
                                        "A milestone is a single point and cannot have children.",
                                        code="child_of_milestone",
                                    )
                                ]
                            }
                        )
                    # Depth-1 enforcement (ADR-0060): subtasks are leaf nodes —
                    # no task of any kind may be created as a child of a subtask.
                    # Checked on every parent_id path, not only is_subtask=True
                    # requests, so the "Add Task" entry point cannot bypass it.
                    if parent.is_subtask:
                        raise DRFValidationError(
                            {"parent_id": "Cannot create a child of a subtask."}
                        )
                    children = _get_siblings(str(project.pk), str(parent.wbs_path), lock=True)
                    # Phase guard (#1750): a phase — a summary task that groups real
                    # WBS work — must not accept drawer-subtasks. Drawer-subtasks and
                    # WBS-phase children are both WBS children, so both make the parent
                    # ``is_summary``; the discriminator is whether the parent already has
                    # a *structural* (non-subtask) child. If it does, it is a phase, and a
                    # subtask would conflate the two decomposition models (the subtask
                    # surfaces as an ordinary task in the WBS). A leaf — no children, or
                    # only ``is_subtask`` children — stays decomposable. Reuses the
                    # already-fetched, locked sibling list, so it costs no extra query.
                    if is_subtask and any(not c.is_subtask for c in children):
                        raise DRFValidationError(
                            {
                                "parent_id": [
                                    ErrorDetail(
                                        "Phases group work — add tasks inside the phase, "
                                        "not subtasks.",
                                        code="subtask_on_phase",
                                    )
                                ]
                            }
                        )
                    wbs_path = _build_wbs_path(str(parent.wbs_path), len(children) + 1)
                else:
                    root_count = (
                        Task.objects.select_for_update()
                        .filter(project=project, is_deleted=False, wbs_path__regex=r"^\d+$")
                        .count()
                    )
                    wbs_path = str(root_count + 1)
                instance = serializer.save(wbs_path=wbs_path, is_subtask=is_subtask)
            else:
                instance = serializer.save(is_subtask=is_subtask)

            # When a subtask is created: bump parent server_version so sync clients
            # detect the parent's new is_summary=True state, and record a
            # SprintScopeChange row if the parent belongs to an active sprint.
            if is_subtask and parent is not None:
                Task.objects.filter(pk=parent.pk).update(
                    server_version=db_models.F("server_version") + 1
                )
                if parent.sprint_id is not None:
                    from trueppm_api.apps.projects.models import Sprint
                    from trueppm_api.apps.projects.services import record_sprint_scope_change

                    parent_sprint = Sprint.objects.filter(pk=parent.sprint_id).first()
                    if parent_sprint is not None:
                        # Subtask spawn: record the audit row against the already-
                        # committed parent for the drawer chip (flag_pending=False —
                        # the parent stays in the commitment; flagging it pending
                        # would wrongly drop the whole parent from the burndown).
                        record_sprint_scope_change(
                            task=parent,
                            sprint=parent_sprint,
                            by=self.request.user,
                            item_name=instance.name,
                            flag_pending=False,
                        )

            # ADR-0102 §4: a NON-subtask task created directly into an ACTIVE
            # sprint (the board "add card to the active sprint" flow) is a
            # mid-sprint injection — it enters pending-acceptance rather than the
            # commitment, same as a task linked via PATCH or sync. The shared
            # helper self-skips subtasks (their sprint_id is None) and
            # PLANNED/COMPLETED targets, so calling it unconditionally is safe.
            from trueppm_api.apps.projects.services import maybe_record_scope_injection

            maybe_record_scope_injection(instance, None, self.request.user)

        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_created", {"id": task_id})
        )
        # #867: a new task placed before the project start pulled the boundary
        # earlier (auto-shift in TaskSerializer.create). Broadcast the project
        # change in the same on_commit batch so collaborators re-fetch the start.
        if getattr(instance, "_project_start_shifted_from", None) is not None:
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "project_updated", {"id": project_id})
            )
        if is_subtask and parent is not None:
            parent_id_str = str(parent.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "task_updated", {"id": parent_id_str})
            )
        payload = _task_webhook_payload(instance)
        transaction.on_commit(lambda: _dispatch_webhooks(project_id, "task.created", payload))

    def perform_update(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Stash the bound serializer so _handle_task_write can read the guardrail
        # rules it recorded in validate() and surface them as response warnings
        # (ADR-0101). validate() ran before perform_update, so the attribute is set.
        self._last_task_serializer = serializer

        # Field-level conflict gate (ADR-0217, #322): raises 409 on an overlapping
        # stale write; returns the concurrently-changed fields for the response header.
        self._merge_concurrent_fields = check_field_conflict(self.request, serializer)

        # Snapshot the fields the granular webhook events compare on, BEFORE the
        # save mutates the instance. serializer.instance still holds the prior DB
        # values here (#638 / ADR-0083). Captured as plain scalars so the
        # on_commit lambdas don't close over the ORM object.
        old_assignee_id = (
            str(serializer.instance.assignee_id)
            if serializer.instance and serializer.instance.assignee_id
            else None
        )
        old_planned_start = (
            str(serializer.instance.planned_start)
            if serializer.instance and serializer.instance.planned_start
            else None
        )
        # ADR-0102 §4: capture the prior sprint link so a *direct* task→sprint
        # link can be detected after save and routed through the scope-injection
        # approve-gate when the new sprint is ACTIVE (post-activation injection).
        old_sprint_id = (
            str(serializer.instance.sprint_id)
            if serializer.instance and serializer.instance.sprint_id
            else None
        )
        # #855: capture prior blocked state so the task.blocked notification fires
        # only on the unblocked→blocked transition (re-saving an already-blocked
        # task, or editing its reason, must not re-notify — the before/after
        # snapshot is the idempotency guard). "Blocked" = non-empty blocked_reason.
        old_is_blocked = bool(
            (getattr(serializer.instance, "blocked_reason", "") or "").strip()
            if serializer.instance
            else False
        )

        instance = serializer.save()
        project_id = str(instance.project_id)
        task_id = str(instance.pk)

        # ADR-0102 §4 — generalized scope-injection write path. A task newly
        # linked to an ACTIVE sprint enters pending-acceptance. The detection lives
        # in the shared ``maybe_record_scope_injection`` service so this REST path
        # and the mobile sync upload stay in lockstep (a divergence here was how
        # sync originally bypassed the gate). Disposition of an already-pending task
        # is blocked at TaskSerializer.validate — it must go through accept/reject.
        from trueppm_api.apps.projects.services import (
            maybe_record_scope_injection,
            notify_sprint_membership_change,
        )

        maybe_record_scope_injection(instance, old_sprint_id, self.request.user)

        # ADR-0412 (#1946): a committed change to this task's sprint FK that enters
        # or leaves an ACTIVE sprint fans out a targeted in-app notification to the
        # project leads — closing the "silent mid-sprint injection" audit gap. The
        # emitter self-guards (no-op PATCH / non-active sprint) and defers a
        # best-effort dispatch, so it can never fail or revert the task update.
        notify_sprint_membership_change(
            instance, old_sprint_id, instance.sprint_id, self.request.user
        )

        # Only recalculate when a schedule-affecting field changed (#965). A
        # PATCH that touches only non-scheduling fields (notes, name) would
        # otherwise enqueue a full-project CPM recalc on every keystroke — the
        # dominant source of drawer-edit lag. `validated_data` holds exactly the
        # fields this partial update wrote, so an empty/subset-of-denylist write
        # skips the recalc; everything else still recalculates immediately.
        # `percent_complete` is deliberately NOT in the denylist (#1500) — since
        # ADR-0132 it is a live CPM input (remaining-duration + completion) on
        # every project, status_date set or not.
        changed_fields = set(getattr(serializer, "validated_data", {}).keys())
        if not changed_fields or not changed_fields <= _NON_SCHEDULE_TASK_FIELDS:
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        # The board broadcast always fires — collaborators must see a progress or
        # name change land even though it doesn't move the schedule. ADR-0152 (#327):
        # carry the field-level delta (names only — never gated values), the
        # post-commit server_version, and the actor so the originating client can
        # suppress its own echo instead of re-fetching over its optimistic update.
        from trueppm_api.apps.sync.broadcast import broadcast_task_updated

        delta_fields = sorted(changed_fields)
        version = instance.server_version
        actor_id = str(self.request.user.pk) if self.request.user.is_authenticated else None
        transaction.on_commit(
            lambda: broadcast_task_updated(
                project_id,
                task_id=task_id,
                changed_fields=delta_fields,
                version=version,
                actor_id=actor_id,
            )
        )
        # #867: this edit pulled the project start earlier (auto-shift in
        # TaskSerializer.update). Broadcast the project change in the same batch
        # so collaborators re-fetch the new boundary alongside the task update.
        if getattr(instance, "_project_start_shifted_from", None) is not None:
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "project_updated", {"id": project_id})
            )
        # ADR-0151 (#414): a user edit changed this task's duration on a task with
        # progress. Broadcast the WS-only task_duration_changed event so the desktop
        # client can render the inline "Recalc %?" / confirm affordance without a
        # refetch. WS-only (no webhook): external consumers already see the new
        # duration via task.updated, and the OSS webhook set is at its cap (ADR-0147).
        # The event row is already persisted by the serializer; this is the live hint.
        duration_event: dict[str, Any] | None = getattr(instance, "_duration_change_event", None)
        if duration_event is not None:
            event_payload = duration_event
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "task_duration_changed", event_payload)
            )
        # Capture the calling surface from X-Source header so downstream consumers
        # (webhooks, future audit views) can distinguish a status flip from /me/work
        # vs the schedule canvas vs the board — Morgan's sprint-sovereignty concern
        # (ADR-0065 Gap 2). The header is optional; absent → "unknown".
        # Validate against an allow-list pattern (lowercase letters and underscores,
        # max 64 chars) so a hostile or buggy client cannot inject Unicode / huge
        # strings into stored webhook payloads forwarded to third-party consumers.
        raw_source = self.request.headers.get("X-Source", "unknown")
        source = raw_source if _VALID_SOURCE.fullmatch(raw_source) else "unknown"
        payload = _task_webhook_payload(instance, source=source)
        transaction.on_commit(lambda: _dispatch_webhooks(project_id, "task.updated", payload))

        # Granular task events (#638). Each fires only when the relevant field
        # actually changed — a PATCH that doesn't touch the assignee/date does
        # not emit the specific event (keeps the at-least-once stream meaningful
        # and the before/after snapshot is the idempotency guard, ADR-0170).
        # The same field-change triggers ALSO drive per-user email/in-app
        # notifications (#639, ADR-0085) — a sibling dispatch to the new assignee
        # / task owner, never the actor.
        actor_id = str(self.request.user.pk) if self.request.user.is_authenticated else None
        task_name = payload["name"]
        new_assignee_id = payload["assignee"]
        if new_assignee_id != old_assignee_id:
            assignee_payload = {**payload, "previous_assignee": old_assignee_id}
            # None → user is an assignment; user → user is a reassignment.
            # Clearing the assignee (user → None) is just task.updated.
            if old_assignee_id is None and new_assignee_id is not None:
                transaction.on_commit(
                    lambda: _dispatch_webhooks(project_id, "task.assigned", assignee_payload)
                )
            elif new_assignee_id is not None:
                transaction.on_commit(
                    lambda: _dispatch_webhooks(
                        project_id, "task.assignee_changed", assignee_payload
                    )
                )
            # Notify the NEW assignee either way (assigned or reassigned to them).
            if new_assignee_id is not None and new_assignee_id != actor_id:
                a_subj = f"You were assigned to {task_name}"
                a_body = f'You were assigned to the task "{task_name}" in TruePPM.'
                a_rcpt = new_assignee_id
                transaction.on_commit(
                    lambda: _notify_event("task.assigned", [a_rcpt], a_subj, a_body, project_id)
                )

        # task.due_date_changed binds to planned_start (the PM-committed date) —
        # Task has no dedicated deadline field; #690 rebinds this to planned_finish.
        new_planned_start = payload["planned_start"]
        if new_planned_start != old_planned_start:
            date_payload = {**payload, "previous_planned_start": old_planned_start}
            transaction.on_commit(
                lambda: _dispatch_webhooks(project_id, "task.due_date_changed", date_payload)
            )
            # Notify the task's current assignee (the owner of the work), if any.
            # #497: carry both old and new dates and deep-link to the task — a
            # Confirmed schedule-canvas reschedule (ADR-0067) lands a deliberate
            # date change on someone else's committed work, and they must learn of
            # it as a targeted signal, not a generic feed entry.
            old_label = old_planned_start or "unscheduled"
            if new_assignee_id is not None and new_assignee_id != actor_id:
                d_subj = f"Planned start changed on {task_name}"
                d_body = f'"{task_name}" moved from {old_label} to {new_planned_start}.'
                d_rcpt = new_assignee_id
                transaction.on_commit(
                    lambda: _notify_event(
                        "task.due_date_changed",
                        [d_rcpt],
                        d_subj,
                        d_body,
                        project_id,
                        task_id=task_id,
                    )
                )
            # #497: when the rescheduled task is in an ACTIVE sprint, the rest of
            # the sprint team also needs the signal — a moved commitment ripples
            # across the iteration. Recipients are the *other* sprint assignees
            # (the targeted assignee already got the dedicated notice above, and
            # the actor is never notified of their own edit), so nobody is
            # double-notified. PLANNED/COMPLETED/CANCELLED sprints don't fan out.
            sprint = instance.sprint
            if sprint is not None and sprint.state == SprintState.ACTIVE:
                already_notified = {x for x in (new_assignee_id, actor_id) if x}
                # Scope the fan-out to *current* project members and *live* tasks:
                # member removal is a soft delete that leaves task assignments
                # intact, so a revoked member could otherwise be notified about a
                # project they've left (rbac/security 🟡).
                member_ids = {
                    str(uid)
                    for uid in ProjectMembership.objects.filter(
                        project_id=instance.project_id, is_deleted=False
                    ).values_list("user_id", flat=True)
                }
                team_ids: list[str | None] = [
                    aid
                    for aid in {
                        str(x)
                        for x in Task.objects.filter(
                            sprint_id=sprint.pk, assignee__isnull=False, is_deleted=False
                        ).values_list("assignee_id", flat=True)
                    }
                    if aid not in already_notified and aid in member_ids
                ]
                if team_ids:
                    s_name = sprint.name
                    s_subj = f"{task_name} rescheduled in {s_name}"
                    s_body = (
                        f'"{task_name}" in sprint {s_name} moved from '
                        f"{old_label} to {new_planned_start}."
                    )
                    transaction.on_commit(
                        lambda: _notify_event(
                            "sprint.task_rescheduled",
                            team_ids,
                            s_subj,
                            s_body,
                            project_id,
                            task_id=task_id,
                        )
                    )

        # task.blocked (#855, #476, ADR-0124 #1134) — fires on the unblocked→blocked
        # transition only. The recipient set is the impediment-clearers: the
        # assignee (existing) + the project's Scrum Master(s) + the PM(s), so the
        # people whose job is removing impediments are told, not just the assignee
        # who already knows. Each recipient is independently gated by their own
        # NotificationPreference downstream. The subject/body carry blocker_type +
        # age + NEVER the reason text (the Morgan boundary, enforced at render —
        # see blocker_services.render_blocker_notification).
        new_is_blocked = bool((instance.blocked_reason or "").strip())
        became_blocked = not old_is_blocked and new_is_blocked
        if became_blocked:
            from trueppm_api.apps.projects.blocker_services import (
                render_blocker_notification,
                resolve_impediment_recipients,
            )

            recipients = resolve_impediment_recipients(instance)
            # Never notify the actor who raised the flag (they took the action),
            # whether they reach the set as the assignee, a Scrum Master, or a PM.
            # NOTE: ``recipients`` holds raw user PKs (ints) from the resolver, while
            # ``actor_id`` is ``str(pk)`` — discarding the string is a no-op against
            # an int set, so discard the raw PK to actually drop the actor.
            actor_pk = self.request.user.pk if self.request.user.is_authenticated else None
            recipients.discard(actor_pk)
            if recipients:
                b_subj, b_body = render_blocker_notification(instance)
                b_rcpts = list(recipients)
                # Literal mirrors NotificationEventType.TASK_BLOCKED (kept a literal
                # here per the line-833 convention). It MUST stay in step with that
                # value: notifications.DND_BYPASS_EVENTS is keyed on it so a blocker
                # always emails through Do-Not-Disturb (#1707, ADR-0292) — a drift
                # here would silently let DND swallow the flagship blocker alert.
                transaction.on_commit(
                    lambda: _notify_event(
                        "task.blocked", b_rcpts, b_subj, b_body, project_id, task_id=task_id
                    )
                )

    def _handle_task_write(
        self, super_method: Any, request: Request, *args: Any, **kwargs: Any
    ) -> Response:
        """Shared error/warning handling for task update + partial_update.

        Maps the structured serializer errors to their stable response bodies, and
        — on a successful write — attaches any tripped *warn*-level guardrails as a
        ``warnings`` array (ADR-0101). Warnings never change the status code: the
        write succeeded; the client shows a non-blocking notice + one-tap override.
        A *block*-level guardrail raised :class:`GuardrailBlockedError` instead, and
        is returned here as a 400 with the offending rule.
        """
        try:
            response: Response = super_method(request, *args, **kwargs)
        except ProgressAnchorError:
            return Response(
                {
                    "code": "progress_requires_anchor",
                    "detail": (
                        "Cannot record progress without a planned start date or sprint assignment."
                    ),
                    "suggested_action": "set_planned_start",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except MilestoneRollupLockedError:
            return Response(
                {
                    "code": "milestone_rollup_locked",
                    "detail": (
                        "This milestone's progress is rolled up from its linked sprint(s) "
                        "and cannot be edited manually. Close or unlink the sprint to edit."
                    ),
                    "suggested_action": "unlink_or_close_sprint",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except GuardrailBlockedError as exc:
            return Response(
                {
                    "code": "guardrail_blocked",
                    "rule": exc.rule,
                    "detail": exc.detail,
                    "suggested_action": exc.suggested_action,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Surface warn-level guardrails the serializer recorded during validate().
        # The serializer instance is the one bound to this request; read the rules
        # it stashed and translate them to {rule, detail} for the client notice.
        serializer = getattr(self, "_last_task_serializer", None)
        tripped = getattr(serializer, "_tripped_guardrails", None) if serializer else None
        if tripped and isinstance(response.data, dict):
            from trueppm_api.apps.projects.serializers import GUARDRAIL_WARNING_COPY

            response.data["warnings"] = [
                {"rule": rule, "detail": GUARDRAIL_WARNING_COPY.get(rule, "")} for rule in tripped
            ]
        return response

    def update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return self._handle_task_write(super().update, request, *args, **kwargs)

    def partial_update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        return self._handle_task_write(super().partial_update, request, *args, **kwargs)

    @extend_schema(
        summary="Reorder a board card relative to an anchor (server-computed rank)",
        request=OpenApiTypes.OBJECT,
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Moved card's new priority_rank plus any renormalized siblings.",
            ),
            400: OpenApiResponse(description="Malformed body or an anchor outside the column."),
        },
    )
    @action(detail=True, methods=["post"], url_path="reorder")
    def reorder(self, request: Request, **kwargs: Any) -> Response:
        """Reposition this task within its board column under a row lock (ADR-0217, #322).

        Body: exactly one anchor — ``{"before_id": "<uuid>"}``, ``{"after_id": "<uuid>"}``,
        or ``{"to_end": true}``. The sibling group is the project's *live* tasks in the
        same status column; the new dense ``priority_rank`` is computed server-side under
        ``SELECT ... FOR UPDATE`` so two concurrent drags cannot crisscross. Returns
        ``200 {"id", "priority_rank", "renormalized": [...]}``; ``400`` on a bad anchor.
        Replaces the old client-computed ``priority_rank`` PATCH for drag-reorder.
        """
        from trueppm_api.apps.projects.reorder_services import ReorderError, reorder_by_anchor
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        task = self.get_object()
        body = request.data if isinstance(request.data, dict) else {}
        before_id = body.get("before_id")
        after_id = body.get("after_id")
        to_end = bool(body.get("to_end", False))

        for key, val in (("before_id", before_id), ("after_id", after_id)):
            if val is not None and not isinstance(val, str):
                return Response(
                    {key: ["Must be a task UUID string."]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Sibling group = live tasks of this project sharing the moved card's column.
        siblings = Task.objects.filter(
            project_id=task.project_id, status=task.status, is_deleted=False
        )
        try:
            result = reorder_by_anchor(
                queryset=siblings,
                item_id=str(task.pk),
                before_id=before_id,
                after_id=after_id,
                to_end=to_end,
            )
        except ReorderError as exc:
            # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # Reuse the existing frozen `tasks_reordered` event (already handled on the
        # web client as "reorder happened → refetch tasks"), so renormalized siblings
        # and the moved card all refresh in one board invalidation. Deferred to commit
        # and captures only the plain project id string.
        project_id = str(task.project_id)
        transaction.on_commit(lambda: broadcast_board_event(project_id, "tasks_reordered", {}))
        return Response(result, status=status.HTTP_200_OK)

    def perform_destroy(self, instance: Task) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_deleted", {"id": task_id})
        )
        transaction.on_commit(
            lambda: _dispatch_webhooks(
                project_id, "task.deleted", {"id": task_id, "project": project_id}
            )
        )

    def _trashed_task_queryset(self) -> QuerySet[Task]:
        """Membership-scoped queryset of the caller's soft-deleted tasks (#2078).

        Deliberately bypasses ``get_queryset()``'s ``is_deleted=False`` filter — restore
        needs the tombstoned row the normal task surface hides. Still membership-scoped
        (only tasks in a project the caller is an active member of) so a foreign task id
        404s rather than leaking existence; the delete-parity role gate
        (``IsProjectMemberWriteOrOwn``) is enforced separately by ``check_object_permissions``.
        """
        user = self.request.user
        if user is None or not user.is_authenticated:
            return Task.objects.none()
        member_ids = ProjectMembership.objects.filter(user=user, is_deleted=False).values_list(
            "project_id", flat=True
        )
        return Task.objects.filter(project_id__in=member_ids, is_deleted=True)

    @extend_schema(
        summary="Restore a soft-deleted task, its subtree, and its dependency edges",
        request=None,
        responses={200: TaskSerializer},
    )
    @action(detail=True, methods=["post"], url_path="restore")
    def restore(self, request: Request, pk: str | None = None) -> Response:
        """Un-tombstone a soft-deleted task and its cascade, atomically (#2078, ADR-0494).

        The faithful inverse of ``perform_destroy``: restores the task, its ``is_subtask``
        subtree, and every dependency edge that both-endpoints-live allows — the real
        recovery the create-a-new-row Undo only approximated. Resource assignments were
        never tombstoned, so they return with the row.

        Same gate as delete (``IsProjectMemberWriteOrOwn`` — Admin+ or the assignee). A
        second restore of an already-live task returns **404**: it is no longer in the
        caller's trash, so the lookup fails closed rather than re-applying. The whole
        restore runs in one ``transaction.atomic()`` block — a mid-way failure rolls back
        rather than leaving a half-restored subtree. ``server_version`` is bumped on every
        restored row so offline clients re-materialize them (ADR-0202).
        """
        from trueppm_api.apps.projects.models import cascade_task_children_restore
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Look up the tombstoned row directly — get_queryset() filters is_deleted=False.
        # check_object_permissions still runs the delete-parity gate against it.
        task = get_object_or_404(self._trashed_task_queryset(), pk=pk)
        self.check_object_permissions(request, task)

        project_id = str(task.project_id)
        task_id = str(task.pk)
        with transaction.atomic():
            task.restore()
            cascade_task_children_restore(task)

        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_restored", {"id": task_id})
        )

        # Re-fetch through the annotated read path so the response carries the same shape
        # as retrieve (labels, rollups) rather than the bare trashed row.
        restored = annotate_tasks_queryset(
            Task.objects.filter(pk=task.pk), request, project_id
        ).get(pk=task.pk)
        serializer = self.get_serializer(restored)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @extend_schema(responses=TaskScopeRollupSerializer)
    @action(detail=True, methods=["get"], url_path="scope")
    def scope(self, request: Request, **kwargs: Any) -> Response:
        """Scope rollup for a task's subtree (ADR-0108 §3, #408).

        Returns the live story-point sum over leaf descendants, the active
        baseline's snapshot of that scope, and the delta (null when no active
        baseline). Detail-scoped so the per-call queries are not an N+1; any
        project member may read (the default permission applies — no schedule or
        backlog gate, this is a read-only computed view).
        """
        from trueppm_api.apps.projects.services import compute_scope_rollup

        task = self.get_object()
        return Response(compute_scope_rollup(task), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Duration-change audit events for a task (ADR-0151, #414)",
        # Without this, drf-spectacular infers the viewset's default TaskSerializer
        # and the paginated event list fails schema conformance against Task (#2127).
        responses={200: TaskDurationChangeEventSerializer(many=True)},
    )
    @action(detail=True, methods=["get"], url_path="duration-events")
    def duration_events(self, request: Request, **kwargs: Any) -> Response:
        """Duration-change audit events for a task, newest first (ADR-0151, #414).

        Detail-scoped read of the task's ``TaskDurationChangeEvent`` rows — old/new
        duration, the percent-complete policy applied, the actor, and the active
        sprint (if any) at change time. Any project member may read (same gate as
        ``scope``). IDOR-safe: ``ProjectScopedViewSet`` restricts the queryset to the
        caller's projects, so ``get_object`` 404s on a foreign task. Paginated
        newest-first; ``select_related`` keeps actor-name rendering off the N+1 path.
        """
        from trueppm_api.apps.projects.serializers import TaskDurationChangeEventSerializer

        task = self.get_object()
        events = task.duration_change_events.select_related("actor", "sprint").all()
        page = self.paginate_queryset(events)
        if page is not None:
            serializer = TaskDurationChangeEventSerializer(page, many=True)
            return self.get_paginated_response(serializer.data)
        serializer = TaskDurationChangeEventSerializer(events, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Full-text search board cards by title and description (#323)",
        parameters=[
            OpenApiParameter(
                "project",
                OpenApiTypes.UUID,
                OpenApiParameter.QUERY,
                required=True,
                description="Project to search within (required).",
            ),
            OpenApiParameter(
                "q",
                OpenApiTypes.STR,
                OpenApiParameter.QUERY,
                required=True,
                description=(
                    "Search term. Case-insensitive substring match over a card's "
                    "name (title) and notes (description). Trimmed; capped at 100 chars."
                ),
            ),
        ],
        responses={
            200: inline_serializer(
                name="BoardCardSearchResult",
                fields={
                    "id": serializers.UUIDField(),
                    "name": serializers.CharField(),
                    "status": serializers.CharField(),
                    "short_id": serializers.CharField(),
                },
                many=True,
            ),
            400: OpenApiResponse(description="The 'project' query parameter is required."),
        },
    )
    @suppress_list_pagination
    @action(detail=False, methods=["get"], url_path="search")
    def search(self, request: Request, **kwargs: Any) -> Response:
        """Board card full-text search (#323, ADR-0145).

        Returns a slim ``[{id, name, status, short_id}]`` list of cards whose title
        (``name``) or description (``notes``) contains ``?q=`` (case-insensitive
        substring), so the board client can dim non-matching cards in place. The
        slim shape deliberately carries no cost/budget/sensitive fields, so
        role-based field visibility is moot — project membership is the only gate.
        IDOR-safe: ``ProjectScopedViewSet`` already restricts the queryset to
        projects the requester is an active member of, and ``?project=`` is required.

        Comment-body search is out of scope until task comments land an indexed body.
        # TODO(#311): include TaskComment.body once threaded comments merge.
        """
        from django.db.models import Case, IntegerField, Q, Value, When

        project_id = request.query_params.get("project")
        if not project_id:
            return Response(
                {"detail": "The 'project' query parameter is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        raw_q = (request.query_params.get("q") or "").strip()
        if not raw_q:
            return Response([], status=status.HTTP_200_OK)
        # DoS guard: a pathological term can't force an unbounded trigram scan.
        q = raw_q[:100]

        # super().get_queryset() is the membership-scoped base queryset
        # (ProjectScopedViewSet) — already filtered to is_deleted=False and to
        # projects the user belongs to. We add the project + substring filters and
        # use .values() to emit a single slim query (prefetch_related is dropped by
        # values()), avoiding the heavy annotate_tasks_queryset on the hot list path.
        qs = (
            super()
            .get_queryset()
            .filter(project_id=project_id)
            .filter(Q(name__icontains=q) | Q(notes__icontains=q))
            # Title matches rank above description-only matches; name is the stable
            # tiebreak so results are deterministic.
            .annotate(
                _name_match=Case(
                    When(name__icontains=q, then=Value(0)),
                    default=Value(1),
                    output_field=IntegerField(),
                )
            )
            .order_by("_name_match", "name")
        )
        rows = list(qs.values("id", "name", "status", "short_id")[:500])
        results = [
            {
                "id": str(row["id"]),
                "name": row["name"],
                "status": row["status"],
                "short_id": row["short_id"],
            }
            for row in rows
        ]
        return Response(results, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Split a story into a sibling task",
        responses={201: TaskSerializer},
    )
    @action(
        detail=True,
        methods=["post"],
        url_path="split",
        permission_classes=[IsAuthenticated, IsProjectBacklogManager, IsProjectNotArchived],
    )
    def split(self, request: Request, **kwargs: Any) -> Response:
        """Split a story into a sibling under the same epic (ADR-0105 DA-13).

        The child carries over only the unmet acceptance criteria and inherits the
        parent's epic so the split stays grouped; points are not auto-divided (the PO
        re-estimates both halves, so velocity is never double-counted — Alex's VoC
        note). Returns the new child task. Permission: Admin+ via can_manage_backlog —
        splitting restructures the backlog, so it rides the same gate as auto-rank /
        epic management rather than the assignee-scoped task-write class (rbac-check 🟡).
        """
        parent: Task = self.get_object()
        from trueppm_api.apps.projects.product_backlog_services import split_story

        name = request.data.get("name") if isinstance(request.data, dict) else None
        child = split_story(parent, request.user, name=name)
        serializer = self.get_serializer(child)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Approve pending three-point estimates on a task",
        responses={
            200: TaskSerializer,
            400: OpenApiResponse(description="Project estimation_mode is not suggest_approve."),
        },
    )
    @action(
        detail=True,
        methods=["post"],
        url_path="approve-estimates",
        permission_classes=[IsAuthenticated, IsProjectScheduler, IsProjectNotArchived],
    )
    def approve_estimates(self, request: Request, **kwargs: Any) -> Response:
        """Accept pending three-point estimates on a task.

        Only meaningful when the project's estimation_mode is SUGGEST_APPROVE.
        Returns 400 for other modes. Idempotent — calling on an already-accepted
        task is a no-op (200, no DB write, no broadcast).

        Permission: IsProjectScheduler+ (Resource Manager and above).
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        task: Task = self.get_object()
        project: Project = task.project

        if project.estimation_mode != EstimationMode.SUGGEST_APPROVE:
            detail = "approve-estimates is only available when estimation_mode is suggest_approve."
            return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)

        # Idempotent: already accepted — no write, no broadcast.
        if task.estimate_status == EstimateStatus.ACCEPTED:
            serializer = self.get_serializer(task)
            return Response(serializer.data)

        task.estimate_status = EstimateStatus.ACCEPTED
        task.save(update_fields=["estimate_status"])

        project_id = str(task.project_id)
        task_id = str(task.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_updated", {"id": task_id})
        )

        serializer = self.get_serializer(task)
        return Response(serializer.data)

    # -----------------------------------------------------------------
    # TaskSuggestedAssignee actions (ADR-0071 §5)
    # -----------------------------------------------------------------

    # Routed explicitly in urls.py as
    # tasks/<pk>/suggestions/<uuid:suggestion_pk>/accept/ (the action needs
    # suggestion_pk). NOT an @action: a detail=True @action would also register a
    # parameterless tasks/{pk}/suggestions/accept/ route that 404s at runtime
    # (suggestion_pk always None) and pollutes the OpenAPI schema (#846).
    def accept_suggestion(
        self,
        request: Request,
        pk: str | None = None,
        suggestion_pk: str | None = None,
        **kwargs: Any,
    ) -> Response:
        """Accept a PENDING TaskSuggestedAssignee — binds Task.assignee.

        Only the ``suggested_user`` may call. If ``Task.assignee`` is already
        non-null (another path set it concurrently), returns 409 and the
        suggestion is marked ACCEPTED without overwriting — the suggestion
        is resolved either way.
        """
        from django.contrib.auth.models import User as _User

        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.projects.models import (
            SuggestionState,
            TaskSuggestedAssignee,
        )
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        if pk is None or suggestion_pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        suggestion = (
            TaskSuggestedAssignee.objects.select_related("task")
            .filter(pk=suggestion_pk, task_id=pk, is_deleted=False)
            .first()
        )
        if suggestion is None:
            return Response(
                {"detail": "Suggestion not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        # Re-check actor membership at call time (#1373). The suggestion row's
        # ``suggested_user`` FK is not authorization on its own: a user named as
        # suggested_user who has since lost project membership must not be able
        # to bind ``Task.assignee``. Resolve the project from the (already
        # select_related) task and require a current, non-soft-deleted membership
        # before any further gate or write.
        if _membership_role(request, suggestion.task.project_id) is None:
            return Response(
                {"detail": "You must be a member of this project."},
                status=status.HTTP_403_FORBIDDEN,
            )
        caller = cast(_User, request.user)
        if suggestion.suggested_user_id != caller.pk:
            return Response(
                {"detail": "Only the suggested user can accept this suggestion."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if suggestion.state != SuggestionState.PENDING:
            return Response(
                {"detail": f"Suggestion is already {suggestion.state}."},
                status=status.HTTP_409_CONFLICT,
            )

        with transaction.atomic():
            task = Task.objects.select_for_update().get(pk=suggestion.task_id)
            assignee_conflict = False
            assigned_now = False
            if task.assignee_id is None:
                task.assignee_id = suggestion.suggested_user_id
                task.save(update_fields=["assignee", "server_version"])
                assigned_now = True
            elif task.assignee_id != suggestion.suggested_user_id:
                assignee_conflict = True
            suggestion.state = SuggestionState.ACCEPTED
            suggestion.accepted_at = timezone.now()
            suggestion.save(update_fields=["state", "accepted_at", "server_version"])

            project_id = str(task.project_id)
            task_id = str(task.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id, "task_updated", {"id": task_id, "source": "suggestion_accept"}
                )
            )
            # Fire task.assigned (#638) when this accept actually bound the
            # assignee (None → suggested_user). Mirrors the perform_update path
            # so the retro-flow assignment isn't a blind spot for consumers.
            if assigned_now:
                assigned_payload = {
                    **_task_webhook_payload(task, source="suggestion_accept"),
                    "previous_assignee": None,
                }
                transaction.on_commit(
                    lambda: _dispatch_webhooks(project_id, "task.assigned", assigned_payload)
                )

        if assignee_conflict:
            return Response(
                {
                    "detail": (
                        "Task is already assigned to another user. "
                        "Suggestion resolved without binding."
                    ),
                    "task_id": str(task.pk),
                    "current_assignee_id": task.assignee_id,
                },
                status=status.HTTP_409_CONFLICT,
            )
        return Response(
            {
                "id": str(suggestion.pk),
                "state": suggestion.state,
                "accepted_at": suggestion.accepted_at,
            },
            status=status.HTTP_200_OK,
        )

    # Routed explicitly in urls.py (see accept_suggestion) — not an @action so
    # no parameterless ghost route is generated (#846).
    def decline_suggestion(
        self,
        request: Request,
        pk: str | None = None,
        suggestion_pk: str | None = None,
        **kwargs: Any,
    ) -> Response:
        """Decline a PENDING TaskSuggestedAssignee.

        Only the ``suggested_user`` may call. The broadcast is a *silent*
        state-reconciliation hint, not a social signal: it carries only the
        suggestion/task id — never the decliner's identity — and drives no
        notification UI, so the suggester's pending list and the suggested
        user's My Work clear the stale "Pending" badge without the social cost
        the psych-safety note (Priya, VoC) warned a *visible* decline would
        carry. Without it, peers stayed stale until a manual refetch (#1323).
        """
        from django.contrib.auth.models import User as _User

        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.projects.models import (
            SuggestionState,
            TaskSuggestedAssignee,
        )

        if pk is None or suggestion_pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        suggestion = (
            TaskSuggestedAssignee.objects.select_related("task")
            .filter(pk=suggestion_pk, task_id=pk, is_deleted=False)
            .first()
        )
        if suggestion is None:
            return Response(
                {"detail": "Suggestion not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        # Re-check actor membership at call time (#1373) — an ex-member named as
        # suggested_user must not be able to mutate the suggestion's state.
        if _membership_role(request, suggestion.task.project_id) is None:
            return Response(
                {"detail": "You must be a member of this project."},
                status=status.HTTP_403_FORBIDDEN,
            )
        caller = cast(_User, request.user)
        if suggestion.suggested_user_id != caller.pk:
            return Response(
                {"detail": "Only the suggested user can decline this suggestion."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if suggestion.state != SuggestionState.PENDING:
            return Response(
                {"detail": f"Suggestion is already {suggestion.state}."},
                status=status.HTTP_409_CONFLICT,
            )
        suggestion.state = SuggestionState.DECLINED
        suggestion.declined_at = timezone.now()
        suggestion.save(update_fields=["state", "declined_at", "server_version"])
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Snapshot to plain strings so the deferred closure can never read a
        # later-mutated ORM instance.
        _project_id = str(suggestion.task.project_id)
        _suggestion_id = str(suggestion.pk)
        _task_id = str(pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                _project_id,
                "suggestion_declined",
                {"id": _suggestion_id, "task_id": _task_id},
            )
        )
        return Response(
            {
                "id": str(suggestion.pk),
                "state": suggestion.state,
                "declined_at": suggestion.declined_at,
            },
            status=status.HTTP_200_OK,
        )

    # Routed explicitly in urls.py (see accept_suggestion) — not an @action so
    # no parameterless ghost route is generated (#846).
    def revoke_suggestion(
        self,
        request: Request,
        pk: str | None = None,
        suggestion_pk: str | None = None,
        **kwargs: Any,
    ) -> Response:
        """Revoke a PENDING TaskSuggestedAssignee.

        Allowed callers: the original ``suggested_by`` user, or any Project
        ADMIN+ on the suggestion's project.
        """
        from django.contrib.auth.models import User as _User

        from trueppm_api.apps.access.models import Role
        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.projects.models import (
            SuggestionState,
            TaskSuggestedAssignee,
        )

        if pk is None or suggestion_pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        suggestion = (
            TaskSuggestedAssignee.objects.select_related("task")
            .filter(pk=suggestion_pk, task_id=pk, is_deleted=False)
            .first()
        )
        if suggestion is None:
            return Response(
                {"detail": "Suggestion not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        caller = cast(_User, request.user)
        # Re-check actor membership at call time (#1373): an ex-member must not be
        # able to revoke even a suggestion they originated. ``_membership_role``
        # returns ``None`` for a non-member (or soft-deleted membership) and the
        # role ordinal otherwise — distinguishing it cleanly from ``Role.VIEWER``
        # (``0``), which a raw ``... or -1`` sentinel would falsely collapse to a
        # non-member. This floor runs before the originator/Admin branch so losing
        # membership revokes the ability.
        caller_role = _membership_role(request, suggestion.task.project_id)
        if caller_role is None:
            return Response(
                {"detail": "You must be a member of this project."},
                status=status.HTTP_403_FORBIDDEN,
            )
        is_originator = suggestion.suggested_by_id == caller.pk
        if not is_originator and caller_role < Role.ADMIN:
            return Response(
                {
                    "detail": (
                        "Only the suggesting user or a Project Admin can revoke this suggestion."
                    )
                },
                status=status.HTTP_403_FORBIDDEN,
            )
        if suggestion.state != SuggestionState.PENDING:
            return Response(
                {"detail": f"Suggestion is already {suggestion.state}."},
                status=status.HTTP_409_CONFLICT,
            )
        suggestion.state = SuggestionState.REVOKED
        suggestion.save(update_fields=["state", "server_version"])
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Silent state-reconciliation broadcast so the suggested user's My Work
        # and any peer's pending list drop the now-revoked suggestion without a
        # manual refetch (#1323). Snapshot to plain strings for the deferred
        # closure; ``task`` is already select_related above.
        _project_id = str(suggestion.task.project_id)
        _suggestion_id = str(suggestion.pk)
        _task_id = str(pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                _project_id,
                "suggestion_revoked",
                {"id": _suggestion_id, "task_id": _task_id},
            )
        )
        return Response(
            {"id": str(suggestion.pk), "state": suggestion.state},
            status=status.HTTP_200_OK,
        )


class AcceptanceCriterionViewSet(IdempotencyMixin, viewsets.ModelViewSet[AcceptanceCriterion]):
    """CRUD for a story's acceptance criteria (ADR-0105 §2).

    Acceptance criteria are a collaborative refinement + sprint-review artifact — the PO
    drafts them during grooming and the team ticks them met at review — so writes are
    gated at Member+ (``IsProjectMemberWrite``), not the Admin+ ``can_manage_backlog``
    gate that guards the *structural* backlog actions (auto-rank, epic management, split).
    The review trail (``met_by``/``met_at``) is stamped here when ``met`` flips; it is
    surfaced as the criterion's status with attribution only on drill-down and is never
    aggregated to a PMO surface (ADR-0105 §2 privacy guard).

    Flat route ``/api/v1/acceptance-criteria/`` with a ``?task=`` list filter. Soft-delete
    keeps sync tombstones (the model is a ``VersionedModel``).
    """

    serializer_class = AcceptanceCriterionSerializer
    queryset = AcceptanceCriterion.objects.select_related("task", "met_by").filter(
        is_deleted=False, task__is_deleted=False
    )

    def get_permissions(self) -> list[BasePermission]:
        return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[AcceptanceCriterion]:
        qs = (
            super()
            .get_queryset()
            .filter(
                task__project__memberships__user=self.request.user,  # type: ignore[misc]
                task__project__memberships__is_deleted=False,
            )
        )
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(task_id=task_id)
        return qs.distinct().order_by("task", "position")

    def _require_member_write(self, project_id: Any) -> None:
        from rest_framework.exceptions import PermissionDenied

        from trueppm_api.apps.access.permissions import _membership_role

        role = _membership_role(self.request, project_id)
        if role is None or role < Role.MEMBER:
            raise PermissionDenied(
                "You need at least Team Member role to edit acceptance criteria."
            )

    def perform_create(self, serializer: BaseSerializer[AcceptanceCriterion]) -> None:
        # Flat route carries no project_pk, so IsProjectMemberWrite.has_permission can't
        # gate create — enforce membership on the target task's project here.
        task = serializer.validated_data["task"]
        self._require_member_write(task.project_id)
        # Wrap both writes in one atomic block: if the met_by/met_at stamp fails,
        # the criterion row itself is rolled back rather than being left with null
        # attribution on a criterion that appears met (P25 correctness fix).
        with transaction.atomic():
            criterion = serializer.save()
            # If created already-met, stamp the review trail so a met criterion never has
            # null attribution (and dor_blockers' all-met check has a real author).
            if criterion.met and criterion.met_by_id is None:
                criterion.met_by = self.request.user  # type: ignore[assignment]
                criterion.met_at = timezone.now()
                criterion.save(update_fields=["met_by", "met_at", "server_version"])
        self._broadcast(criterion)

    def perform_update(self, serializer: BaseSerializer[AcceptanceCriterion]) -> None:
        from trueppm_api.apps.projects.product_backlog_services import (
            apply_acceptance_met_change,
        )

        was_met = serializer.instance.met if serializer.instance else False
        criterion = serializer.save()
        # Stamp / clear the review trail when met flips — via the shared attribution
        # rule (ADR-0148) so the interactive and CI-ingestion paths can't diverge.
        apply_acceptance_met_change(
            criterion, was_met=was_met, actor=self.request.user, now=timezone.now()
        )
        self._broadcast(criterion)

    def perform_destroy(self, instance: AcceptanceCriterion) -> None:
        instance.soft_delete()
        self._broadcast(instance)

    def _broadcast(self, criterion: AcceptanceCriterion) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        pid, tid = str(criterion.task.project_id), str(criterion.task_id)
        transaction.on_commit(lambda: broadcast_board_event(pid, "task_updated", {"id": tid}))


class SprintTaskOutcomeViewSet(IdempotencyMixin, viewsets.GenericViewSet[SprintTaskOutcome]):
    """Review-time curation of the demo-ready flag on a closing-membership row (ADR-0118).

    Flat route ``/api/v1/sprint-task-outcomes/<pk>/toggle-demo/``. The team curates
    which shipped stories to walk stakeholders through; gated team-owned (Member+)
    via object-level ``IsProjectMemberWrite``, resolving the project through
    ``SprintTaskOutcome.project_id`` (→ sprint). The membership-filtered queryset
    404s a non-member rather than leaking existence. The flag write + best-effort
    broadcast live in the ``toggle_demo_ready`` service.
    """

    queryset = SprintTaskOutcome.objects.select_related("sprint")

    def get_permissions(self) -> list[BasePermission]:
        return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[SprintTaskOutcome]:
        return (
            super()
            .get_queryset()
            .filter(
                sprint__project__memberships__user=self.request.user,  # type: ignore[misc]
                sprint__project__memberships__is_deleted=False,
            )
            .distinct()
        )

    @extend_schema(
        summary="Toggle whether a shipped story is in the Sprint Review demo list (ADR-0118)",
        request=OpenApiTypes.OBJECT,
        responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    @action(detail=True, methods=["post"], url_path="toggle-demo")
    def toggle_demo(self, request: Request, pk: str | None = None) -> Response:
        """Set ``demo_ready`` to the request body's boolean (Member+; idempotent)."""
        from trueppm_api.apps.projects.services import toggle_demo_ready

        outcome = self.get_object()  # runs object-level IsProjectMemberWrite
        demo_ready = bool(request.data.get("demo_ready", True))
        toggle_demo_ready(outcome, demo_ready=demo_ready)
        return Response(
            {"id": str(outcome.id), "demo_ready": outcome.demo_ready},
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        summary="Set the demo presenter for a shipped story (ADR-0118 amend, #1130)",
        request=OpenApiTypes.OBJECT,
        responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    @action(detail=True, methods=["post"], url_path="set-presenter")
    def set_presenter(self, request: Request, pk: str | None = None) -> Response:
        """Set the per-story demo presenter (Member+; ``{presenter: str}``, ≤120)."""
        from trueppm_api.apps.projects.services import set_demo_presenter

        outcome = self.get_object()  # runs object-level IsProjectMemberWrite
        presenter = request.data.get("presenter", "")
        if not isinstance(presenter, str):
            return Response(
                {"presenter": ["Must be a string."]}, status=status.HTTP_400_BAD_REQUEST
            )
        set_demo_presenter(outcome, presenter=presenter)
        return Response(
            {"id": str(outcome.id), "presenter": outcome.presenter},
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        summary="Set the contributor review note on a story (#1131)",
        request=OpenApiTypes.OBJECT,
        responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    @action(detail=True, methods=["post"], url_path="set-note")
    def set_note(self, request: Request, pk: str | None = None) -> Response:
        """Set the optional contributor review note (Member+; ``{note: str}``, ≤200).

        Always optional — an empty string clears it (Priya's no-required-data-entry
        constraint). Over-length notes are truncated server-side in the service.
        """
        from trueppm_api.apps.projects.services import set_review_note

        outcome = self.get_object()  # runs object-level IsProjectMemberWrite
        note = request.data.get("note", "")
        if not isinstance(note, str):
            return Response({"note": ["Must be a string."]}, status=status.HTTP_400_BAD_REQUEST)
        set_review_note(outcome, note=note)
        return Response(
            {"id": str(outcome.id), "review_note": outcome.review_note},
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        summary="Carry a not-shipped story forward to the backlog in one tap (#1132)",
        request=None,
        responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    @action(detail=True, methods=["post"], url_path="flag-for-backlog")
    def flag_for_backlog(self, request: Request, pk: str | None = None) -> Response:
        """Create a BACKLOG task from this story in one tap (Member+; idempotent).

        A second tap is a no-op — the created task is recorded on the outcome row,
        so two clicks never spawn two backlog items. Returns the (possibly already
        existing) backlog task id and the flagged state.
        """
        from trueppm_api.apps.projects.services import flag_outcome_for_backlog

        outcome = self.get_object()  # runs object-level IsProjectMemberWrite
        result = flag_outcome_for_backlog(outcome, actor=request.user)
        return Response(
            {
                "id": str(result.id),
                "flagged_to_backlog": result.flagged_to_backlog_task_id is not None,
                "task_id": str(result.flagged_to_backlog_task_id)
                if result.flagged_to_backlog_task_id
                else None,
            },
            status=status.HTTP_200_OK,
        )


class RetroBoardItemViewSet(IdempotencyMixin, viewsets.GenericViewSet[RetroBoardItem]):
    """Detail ops for live retro-board stickies — edit / move / delete / convert (ADR-0117).

    Flat route ``/api/v1/retro-items/<pk>/``. Creation is sprint-scoped
    (``SprintViewSet.retro_board`` POST) so membership is checked against the sprint;
    this viewset gates each detail op via object-level ``IsProjectMemberWrite``,
    resolving the project through ``RetroBoardItem.project_id`` (retro→sprint). The
    membership-filtered queryset 404s a non-member rather than leaking existence.
    All writes broadcast (best-effort, on commit) inside the service layer.
    """

    serializer_class = RetroBoardItemSerializer
    queryset = RetroBoardItem.objects.select_related("retro__sprint", "author").filter(
        is_deleted=False
    )

    def get_permissions(self) -> list[BasePermission]:
        return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[RetroBoardItem]:
        return (
            super()
            .get_queryset()
            .filter(
                retro__sprint__project__memberships__user=self.request.user,  # type: ignore[misc]
                retro__sprint__project__memberships__is_deleted=False,
            )
            .distinct()
        )

    def partial_update(self, request: Request, pk: str | None = None) -> Response:
        """Edit text/color and/or move (column + fractional position); LWW (ADR-0117 §3)."""
        from trueppm_api.apps.projects.retro_board_services import (
            move_board_item,
            update_board_item,
        )

        item = self.get_object()  # runs object-level IsProjectMemberWrite
        data = request.data
        if "column" in data or "position" in data:
            try:
                position = float(data.get("position", item.position))
            except (TypeError, ValueError):
                return Response(
                    {"position": "Must be a number."}, status=status.HTTP_400_BAD_REQUEST
                )
            move_board_item(item, column=data.get("column", item.column), position=position)
        if "text" in data or "color" in data:
            update_board_item(item, text=data.get("text"), color=data.get("color"))
        item.refresh_from_db()
        return Response(RetroBoardItemSerializer(item).data, status=status.HTTP_200_OK)

    def destroy(self, request: Request, pk: str | None = None) -> Response:
        """Soft-delete a sticky (broadcasts ``retro_item_deleted``)."""
        from trueppm_api.apps.projects.retro_board_services import delete_board_item

        item = self.get_object()
        delete_board_item(item)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @extend_schema(
        summary="Convert a discussion sticky into a retro action item (ADR-0117 §1)",
        request=None,
        responses={201: RetroActionItemSerializer, 200: RetroActionItemSerializer},
    )
    @action(detail=True, methods=["post"], url_path="convert-to-action")
    def convert_to_action(self, request: Request, pk: str | None = None) -> Response:
        """Distil a sticky into a RetroActionItem (idempotent; then uses #858 promote)."""
        from django.contrib.auth.models import User

        from trueppm_api.apps.projects.retro_board_services import (
            convert_to_action as convert_svc,
        )

        item = self.get_object()
        already = item.converted_action_item_id is not None
        action_item = convert_svc(item, cast(User, request.user))
        return Response(
            RetroActionItemSerializer(action_item).data,
            status=status.HTTP_200_OK if already else status.HTTP_201_CREATED,
        )


class BaselineViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Baseline]):
    """CRUD for schedule baselines within a project.

    A baseline is a frozen snapshot of all task dates at a point in time,
    used for plan-vs-actual tracking via ghost bars on the Gantt.

    Permission matrix:
      list / retrieve — any project member (Viewer+)
      create          — Project Manager+ (IsProjectAdmin, role ≥ 3)
      destroy         — Project Owner only (IsProjectOwner, role == Role.OWNER)
    """

    queryset = Baseline.objects.filter(is_deleted=False)
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["created_at", "name"]

    def get_serializer_class(self) -> type:
        if self.action == "retrieve":
            return BaselineDetailSerializer
        return BaselineSerializer

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        if self.action == "destroy":
            return [IsAuthenticated(), IsProjectOwner(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectAdmin(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[Baseline]:
        qs = super().get_queryset()
        project_pk = self.kwargs.get("project_pk")
        if project_pk:
            qs = qs.filter(project_id=project_pk)
        return qs.annotate(task_count=Count("tasks"))  # type: ignore[no-any-return]

    def perform_create(self, serializer: BaseSerializer[Baseline]) -> None:
        """Snapshot all live task dates atomically and broadcast baseline_created.

        All three pre-flight reads (auto-name count, unique-name check, task values)
        are inside the atomic block so concurrent creates can't race on the auto-name
        counter — two simultaneous POSTs can't both read ``count=2`` and both produce
        "Baseline 3" (P24 correctness fix).
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, project)

        with transaction.atomic():
            # Auto-name: "Baseline N" where N = existing count + 1. Done inside
            # the atomic block so concurrent creates read a consistent count and
            # can't both produce the same auto-name (P24 correctness fix).
            name = serializer.validated_data.get("name") or ""
            if not name:
                existing_count = Baseline.objects.filter(
                    project_id=project_pk, is_deleted=False
                ).count()
                name = f"Baseline {existing_count + 1}"

            # Enforce unique name per project
            if Baseline.objects.filter(project_id=project_pk, name=name, is_deleted=False).exists():
                raise serializers.ValidationError(
                    {"name": f"A baseline named '{name}' already exists for this project."}
                )

            live_tasks = list(
                Task.objects.filter(project_id=project_pk, is_deleted=False).values(
                    "id",
                    "name",
                    "early_start",
                    "early_finish",
                    "duration",
                    "actual_start",
                    "actual_finish",
                    "story_points",
                )
            )
            has_cpm_dates = bool(live_tasks) and all(
                t["early_start"] is not None for t in live_tasks
            )

            baseline = serializer.save(
                project=project,
                created_by=self.request.user,
                name=name,
                has_cpm_dates=has_cpm_dates,
            )
            BaselineTask.objects.bulk_create(
                [
                    BaselineTask(
                        baseline=baseline,
                        task_id=t["id"],
                        task_name=t["name"],
                        start=t["early_start"],
                        finish=t["early_finish"],
                        duration=t["duration"],
                        actual_start=t["actual_start"],
                        actual_finish=t["actual_finish"],
                        story_points=t["story_points"],
                    )
                    for t in live_tasks
                ]
            )
            # Annotate task_count on the instance so the create response includes it
            # (get_queryset annotates for list/retrieve, but perform_create returns the
            # unsaved instance which lacks the annotation).
            baseline.task_count = len(live_tasks)  # type: ignore[attr-defined]
            baseline_id = str(baseline.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(
                    str(project_pk), "baseline_created", {"id": baseline_id}
                )
            )
            # ADR-0206: emit the baseline.captured webhook (first-party domain
            # event). Payload is built now inside the transaction (task_count is
            # known from the snapshot) and captured by value.
            project_id_str = str(project_pk)
            captured_payload = _baseline_webhook_payload(
                baseline, task_count=len(live_tasks), source="api"
            )
            transaction.on_commit(
                lambda: _dispatch_webhooks(project_id_str, "baseline.captured", captured_payload)
            )

    def perform_destroy(self, instance: Baseline) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        baseline_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "baseline_deleted", {"id": baseline_id})
        )


class BaselineActivateView(IdempotencyMixin, APIView):
    """Activate a specific baseline, deactivating all others for the project.

    POST /api/v1/projects/{project_pk}/baselines/{baseline_pk}/activate/

    Requires Project Manager+ (IsProjectAdmin, role ≥ 3).
    Returns 200 with the updated baseline object.
    """

    permission_classes = [IsAuthenticated, IsProjectAdmin, IsProjectNotArchived]

    @extend_schema(
        summary="Activate a baseline",
        request=None,
        responses={200: BaselineSerializer},
    )
    def post(self, request: Request, project_pk: str, baseline_pk: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(request, project)

        baseline = get_object_or_404(
            Baseline, pk=baseline_pk, project_id=project_pk, is_deleted=False
        )

        with transaction.atomic():
            Baseline.objects.filter(project_id=project_pk, is_active=True).update(is_active=False)
            Baseline.objects.filter(pk=baseline_pk).update(is_active=True)
            baseline.refresh_from_db()

            baseline_id = str(baseline.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(project_pk, "baseline_activated", {"id": baseline_id})
            )

        serializer = BaselineSerializer(baseline)
        return Response(serializer.data, status=status.HTTP_200_OK)


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="project",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to dependencies whose predecessor is in this project.",
            ),
            OpenApiParameter(
                name="dep_type",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter by dependency type (FS, SS, FF, SF).",
            ),
            OpenApiParameter(
                name="task",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Return all edges where this task is either the predecessor or the successor."
                ),
            ),
        ],
    ),
)
class DependencyViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Dependency]):
    """CRUD for task dependencies.

    Dependency creation/modification affects CPM scheduling; Resource Manager+
    (IsProjectScheduler) is required for write operations (issue #11 role matrix).
    """

    permission_classes = [IsAuthenticated, IsProjectScheduler, IsProjectNotArchived]

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        if self.action in ("accept", "reject"):
            # Object-level authority for a pending cross-project edge is the
            # downstream (successor) project's Scheduler+, which the generic
            # project-scoped permission classes can't express (they resolve the
            # predecessor's project). It is enforced inside the action body —
            # ADR-0120 D2 / C2.
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]

    serializer_class = DependencySerializer
    # issue 1519: mirror TaskViewSet so the Gantt dependency walk parallelizes too.
    pagination_class = ScheduleFetchPagination
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["dep_type"]
    # ``predecessor__project`` / ``successor__project`` are prefetched so the D5
    # ExternalTaskCard's ``project_name`` does not N+1 on a cross-project list.
    queryset = Dependency.objects.select_related(
        "predecessor", "predecessor__project", "successor", "successor__project"
    ).filter(is_deleted=False)

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        try:
            return super().create(request, *args, **kwargs)
        except CycleDetectedError as exc:
            return Response(
                {"detail": "cyclic_dependency", "cycle": exc.cycle},
                status=status.HTTP_400_BAD_REQUEST,
            )

    def update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        try:
            return super().update(request, *args, **kwargs)
        except CycleDetectedError as exc:
            return Response(
                {"detail": "cyclic_dependency", "cycle": exc.cycle},
                status=status.HTTP_400_BAD_REQUEST,
            )

    def get_queryset(self) -> QuerySet[Dependency]:
        # ProjectScopedViewSet scopes Dependency to the *predecessor's* project
        # membership only. A cross-project edge (ADR-0120) must also be visible
        # to — and acceptable by — members of the *successor's* project (the side
        # an incoming edge constrains), so widen the membership scope to either
        # endpoint. Same-project edges are unaffected (both endpoints share the
        # one project). The minimal D5 card, not the full task, is what a reader
        # gets for a counterpart in a project they cannot otherwise open.
        base = Dependency.objects.select_related(
            "predecessor", "predecessor__project", "successor", "successor__project"
        ).filter(is_deleted=False)
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated:
            return base.none()
        member_project_ids = ProjectMembership.objects.filter(
            user=user, is_deleted=False
        ).values_list("project_id", flat=True)
        qs = base.filter(
            Q(predecessor__project_id__in=member_project_ids)
            | Q(successor__project_id__in=member_project_ids)
        )
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(predecessor__project_id=project_id)
        dep_type = self.request.query_params.get("dep_type")
        if dep_type:
            qs = qs.filter(dep_type=dep_type)
        # ?task=<uuid> — return all edges where the task is either predecessor
        # or successor (board DepPopover click-through; ADR-0035 b3).
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(Q(predecessor_id=task_id) | Q(successor_id=task_id))
        # ?pending_for_project=<uuid> — the *incoming* pending cross-project edges
        # a downstream (successor) team must review (ADR-0120 D2). Scopes to edges
        # whose successor sits in that project and that are still inert. Layered on
        # the member-scope filter above, so it can only ever narrow what the caller
        # may already see — no new disclosure. Backs the schedule review panel
        # without pulling every edge the caller can read.
        pending_for_project = self.request.query_params.get("pending_for_project")
        if pending_for_project:
            qs = qs.filter(successor__project_id=pending_for_project, pending_acceptance=True)
        return qs

    def perform_create(self, serializer: BaseSerializer[Dependency]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # H1 fix: DRF does not call has_object_permission on create actions, so we
        # re-check Scheduler+ on the predecessor's project before saving. A
        # cross-project edge (ADR-0120) is exempt: the serializer's consent gate
        # has already authorized both sides, and the legitimate proposer may hold
        # schedule authority on only the *successor* side — this single-project
        # check would wrongly 403 them.
        predecessor = serializer.validated_data.get("predecessor")
        successor = serializer.validated_data.get("successor")
        cross_project = bool(
            predecessor is not None
            and successor is not None
            and predecessor.project_id != successor.project_id
        )
        if predecessor is not None and not cross_project:
            self.check_object_permissions(self.request, predecessor)

        # Apply the cross-project consent decision (pending/accepted) resolved in
        # the serializer's validate(); same-project edges fall back to the model
        # default (accepted, not pending).
        consent = getattr(serializer, "_consent", None)
        instance = serializer.save(**consent) if consent else serializer.save()
        predecessor_pid = str(instance.predecessor.project_id)
        successor_pid = str(instance.successor.project_id)
        project_id = predecessor_pid
        dep_id = str(instance.pk)
        # ADR-0120 D3: an *accepted* cross-project edge changes the CPM input on
        # both sides, so enqueue a recompute for each endpoint project; the
        # dispatch path coalesces the two member requests into one program-scoped
        # pass. A pending cross edge is inert (excluded from the gather) so only the
        # predecessor's per-project recompute is enqueued, as for a same-project
        # edge. The reason flags the cross-project provenance for forensics.
        accepted_cross = predecessor_pid != successor_pid and not instance.pending_acceptance
        recalc_reason = (
            ScheduleRequestReason.CROSS_PROJECT_DEPENDENCY
            if accepted_cross
            else ScheduleRequestReason.DEPENDENCY_CHANGE
        )
        transaction.on_commit(lambda: _enqueue_recalculate(predecessor_pid, reason=recalc_reason))
        if accepted_cross:
            transaction.on_commit(lambda: _enqueue_recalculate(successor_pid, reason=recalc_reason))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_created", {"id": dep_id})
        )
        dep_payload = {
            "id": dep_id,
            "predecessor": str(instance.predecessor_id),
            "successor": str(instance.successor_id),
            "dep_type": instance.dep_type,
            "lag": instance.lag,
        }
        transaction.on_commit(
            lambda: _dispatch_webhooks(project_id, "dependency.created", dep_payload)
        )

    def perform_update(self, serializer: BaseSerializer[Dependency]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Apply the consent decision when an update repoints an endpoint into a
        # new cross-project relationship (ADR-0120 D2). Without this, a
        # predecessor-side Scheduler could PATCH the successor to a project they
        # cannot schedule and have the edge land live, bypassing the consent gate
        # — the create path resolves consent but the update path must too. The
        # serializer only sets ``_consent`` when the endpoints actually changed,
        # so an in-place lag/dep_type edit preserves the existing acceptance state.
        consent = getattr(serializer, "_consent", None)
        instance = serializer.save(**consent) if consent else serializer.save()
        project_id = str(instance.predecessor.project_id)
        dep_id = str(instance.pk)
        transaction.on_commit(
            lambda: _enqueue_recalculate(project_id, reason=ScheduleRequestReason.DEPENDENCY_CHANGE)
        )
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_updated", {"id": dep_id})
        )

    def perform_destroy(self, instance: Dependency) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        predecessor_pid = str(instance.predecessor.project_id)
        successor_pid = str(instance.successor.project_id)
        project_id = predecessor_pid
        dep_id = str(instance.pk)
        # ADR-0120 D3: deleting an *accepted* cross-project edge removes a
        # constraint from both sides — and may un-escalate the program (if it was
        # the last accepted cross edge), so each endpoint must recompute. The
        # dispatch path re-evaluates the escalation predicate, so a now-edgeless
        # program correctly falls back to per-project passes.
        accepted_cross = predecessor_pid != successor_pid and not instance.pending_acceptance
        recalc_reason = (
            ScheduleRequestReason.CROSS_PROJECT_DEPENDENCY
            if accepted_cross
            else ScheduleRequestReason.DEPENDENCY_CHANGE
        )
        instance.soft_delete()
        transaction.on_commit(lambda: _enqueue_recalculate(predecessor_pid, reason=recalc_reason))
        if accepted_cross:
            transaction.on_commit(lambda: _enqueue_recalculate(successor_pid, reason=recalc_reason))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_deleted", {"id": dep_id})
        )
        transaction.on_commit(
            lambda: _dispatch_webhooks(project_id, "dependency.deleted", {"id": dep_id})
        )

    @action(detail=True, methods=["post"], url_path="accept")
    def accept(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Accept a pending cross-project dependency (ADR-0120 D2 / C2).

        Only Scheduler+ on the **successor** (downstream) project may accept — the
        successor is the side a cross-project edge newly constrains, so its team
        holds the consent (no management bypass, ADR-0102 precedent). Returns 400
        if the edge is not pending. The accept is audited via the history row.
        """
        return self._resolve_pending(request, accept=True)

    @action(detail=True, methods=["post"], url_path="reject")
    def reject(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Reject (soft-delete) a pending cross-project dependency (ADR-0120 D2).

        Same downstream-consent gate as :meth:`accept`. Soft-deletes the edge so
        the history row preserves the audit of who declined it.
        """
        return self._resolve_pending(request, accept=False)

    def _resolve_pending(self, request: Request, *, accept: bool) -> Response:
        from rest_framework.exceptions import PermissionDenied
        from rest_framework.exceptions import ValidationError as DRFValidationError

        from trueppm_api.apps.access.permissions import _is_project_archived, effective_project_role
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        dependency = self.get_object()

        # Downstream consent (C2): Scheduler+ on the successor's project. Checked
        # before the pending-state check so a caller without downstream authority
        # gets a uniform 403 and cannot probe the edge's acceptance state.
        successor_project_id = dependency.successor.project_id
        role = effective_project_role(request, successor_project_id)
        if role is None or role < Role.SCHEDULER:
            raise PermissionDenied(
                "Only a Resource Manager+ on the successor's project can "
                "accept or reject this cross-project dependency."
            )

        # Archived successor project is read-only (#530); the consent action is a
        # write, so block it like every other dependency mutation.
        if _is_project_archived(request, successor_project_id):
            raise PermissionDenied("Cannot act on a dependency in an archived project.")

        if not dependency.pending_acceptance:
            raise DRFValidationError("This dependency is not pending acceptance.")

        predecessor_pid = str(dependency.predecessor.project_id)
        successor_pid = str(successor_project_id)
        dep_id = str(dependency.pk)

        # Both endpoints are notified; accept/reject only ever happen on a
        # cross-project edge, whose two projects are distinct. Literal event
        # types (one direct broadcast_board_event call per branch) so the WS
        # freeze-test AST scanner registers them — see FROZEN_WS_EVENT_TYPES.
        if accept:
            dependency.pending_acceptance = False
            dependency.accepted_by = request.user
            dependency.accepted_at = timezone.now()
            dependency.save()
            # A now-accepted cross edge makes the program eligible for the
            # program-scoped pass (ADR-0120 D3); recompute both endpoint projects.
            # Each per-project dispatch self-escalates and the program run coalesces
            # them — and that run upserts any D4 sprint-boundary slip conflict the
            # newly-bound edge introduces.
            transaction.on_commit(
                lambda: _enqueue_recalculate(
                    predecessor_pid, reason=ScheduleRequestReason.CROSS_PROJECT_DEPENDENCY
                )
            )
            transaction.on_commit(
                lambda: _enqueue_recalculate(
                    successor_pid, reason=ScheduleRequestReason.CROSS_PROJECT_DEPENDENCY
                )
            )
            transaction.on_commit(
                lambda: broadcast_board_event(
                    predecessor_pid, "dependency_accepted", {"id": dep_id}
                )
            )
            transaction.on_commit(
                lambda: broadcast_board_event(successor_pid, "dependency_accepted", {"id": dep_id})
            )
        else:
            dependency.soft_delete()
            transaction.on_commit(
                lambda: broadcast_board_event(
                    predecessor_pid, "dependency_rejected", {"id": dep_id}
                )
            )
            transaction.on_commit(
                lambda: broadcast_board_event(successor_pid, "dependency_rejected", {"id": dep_id})
            )

        serializer = self.get_serializer(dependency)
        return Response(serializer.data)


class TaskRelationViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[TaskRelation]):
    """CRUD for informational task-to-task relations (ADR-0455).

    A relation (``relates_to`` / ``blocks`` / ``duplicates``) is a cross-reference,
    NOT a scheduling :class:`Dependency` — it is inert: no CPM effect, no lag, no
    cycle check, and **no schedule recompute** on write (the one deliberate
    divergence from :class:`DependencyViewSet`, which recalculates). Endpoints may
    sit in the same project or in two projects of the same *program* (ADR-0120 D1);
    cross-*program* is rejected in the serializer.

    Permission shape mirrors ``TaskLabelView`` (annotate-my-own-task): reads need
    project membership (Viewer+); writes need write authority on the **source**
    task (Member-may-relate-own, Resource Manager read-only, PM+ any). The write
    gate is evaluated against the *source task*, not the relation row (which carries
    no assignee), so the Member-own rule resolves correctly.
    """

    serializer_class = TaskRelationSerializer
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["relation_type", "created_at"]
    # Deterministic default so pagination over an unordered queryset can't drift.
    ordering = ["created_at"]
    queryset = TaskRelation.objects.select_related(
        "source", "source__project", "target", "target__project"
    ).filter(is_deleted=False)

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMemberWriteOrOwn(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[TaskRelation]:
        # A relation is visible to members of EITHER endpoint's project — a
        # cross-project relation (ADR-0120) must be readable from both sides. The
        # membership-scoped queryset is the IDOR gate (this viewset is top-level, so
        # ProjectScopedViewSet's project-FK scoping does not apply — TaskRelation
        # reaches its project only through the source FK).
        base = TaskRelation.objects.select_related(
            "source", "source__project", "target", "target__project"
        ).filter(is_deleted=False)
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated:
            return base.none()
        member_project_ids = ProjectMembership.objects.filter(
            user=user, is_deleted=False
        ).values_list("project_id", flat=True)
        qs = base.filter(
            Q(source__project_id__in=member_project_ids)
            | Q(target__project_id__in=member_project_ids)
        )
        # ?project=<uuid> — the relations owned by that project (source side, which
        # is the relation's .project_id). Layered on the member scope, so it can
        # only narrow what the caller may already see.
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(source__project_id=project_id)
        relation_type = self.request.query_params.get("relation_type")
        if relation_type:
            qs = qs.filter(relation_type=relation_type)
        # ?task=<uuid> — every relation where the task is either endpoint (the task
        # detail "Relations" panel click-through), covering the derived inverse.
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(Q(source_id=task_id) | Q(target_id=task_id))
        return qs

    def get_object(self) -> TaskRelation:
        # Resolve within the membership-scoped queryset (the read IDOR gate), then
        # authorize writes against the SOURCE task — like TaskLabelView. A relation
        # has no assignee, so running IsProjectMemberWriteOrOwn against the relation
        # row would wrongly deny a Member editing a relation on a task they own.
        # Reads are already gated by the scoped queryset (either endpoint), and a
        # per-object re-check would wrongly 403 a target-only member of a
        # cross-project relation whose source project they cannot open.
        queryset = self.filter_queryset(self.get_queryset())
        obj: TaskRelation = get_object_or_404(queryset, pk=self.kwargs["pk"])
        if self.request.method not in SAFE_METHODS:
            self.check_object_permissions(self.request, obj.source)
        return obj

    def perform_create(self, serializer: BaseSerializer[TaskRelation]) -> None:
        # DRF skips has_object_permission on create — re-check write authority on
        # the source task before saving, mirroring DependencyViewSet.perform_create.
        # The source is always the write side (the annotated task), so this is
        # unconditional (unlike the cross-project dependency exemption).
        source = serializer.validated_data.get("source")
        if source is not None:
            self.check_object_permissions(self.request, source)
        instance = serializer.save(created_by=self.request.user)
        self._broadcast(instance, "task_relation_created")

    def perform_update(self, serializer: BaseSerializer[TaskRelation]) -> None:
        instance = serializer.save()
        self._broadcast(instance, "task_relation_updated")

    def perform_destroy(self, instance: TaskRelation) -> None:
        instance.soft_delete()
        self._broadcast(instance, "task_relation_deleted")

    def _broadcast(self, instance: TaskRelation, event_type: str) -> None:
        """Fan the relation event to both endpoint projects on commit.

        A relation is inert, so — unlike DependencyViewSet — there is deliberately
        NO ``_enqueue_recalculate`` here: the CPM input is unchanged. A cross-project
        relation broadcasts to each endpoint project so a board open on either side
        refreshes. Literal event_type strings (one direct ``broadcast_board_event``
        call per branch) keep the WS freeze-test AST scanner able to register them —
        see FROZEN_WS_EVENT_TYPES.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        source_pid = str(instance.source.project_id)
        target_pid = str(instance.target.project_id)
        rel_id = str(instance.pk)
        if event_type == "task_relation_created":
            transaction.on_commit(
                lambda: broadcast_board_event(source_pid, "task_relation_created", {"id": rel_id})
            )
            if target_pid != source_pid:
                transaction.on_commit(
                    lambda: broadcast_board_event(
                        target_pid, "task_relation_created", {"id": rel_id}
                    )
                )
        elif event_type == "task_relation_updated":
            transaction.on_commit(
                lambda: broadcast_board_event(source_pid, "task_relation_updated", {"id": rel_id})
            )
            if target_pid != source_pid:
                transaction.on_commit(
                    lambda: broadcast_board_event(
                        target_pid, "task_relation_updated", {"id": rel_id}
                    )
                )
        else:
            transaction.on_commit(
                lambda: broadcast_board_event(source_pid, "task_relation_deleted", {"id": rel_id})
            )
            if target_pid != source_pid:
                transaction.on_commit(
                    lambda: broadcast_board_event(
                        target_pid, "task_relation_deleted", {"id": rel_id}
                    )
                )


class SlipConflictPagination(pagination.PageNumberPagination):
    """Explicit bounded pagination for the cross-project slip-conflict list (#1317).

    The list mixin already paged through the project default, but the bound was
    implicit and no per-request page-size cap existed. A program with many
    cross-project sprint-boundary slips could otherwise grow this set without a
    declared ceiling. Page-number (default scheme) is kept for parity with the
    other read viewsets in this module.
    """

    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="project",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to conflicts whose threatened task is in this project.",
            ),
            OpenApiParameter(
                name="program",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to conflicts across this program's member projects.",
            ),
            OpenApiParameter(
                name="sprint",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to conflicts threatening this sprint.",
            ),
            OpenApiParameter(
                name="open",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description="When true, only unresolved + unacknowledged conflicts (badge set).",
            ),
        ],
    ),
)
class CrossProjectSlipConflictViewSet(
    IdempotencyMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet[CrossProjectSlipConflict],
):
    """Cross-project sprint-boundary slip conflicts (ADR-0120 D4).

    Read + acknowledge only — a conflict is detected and resolved by the
    program-scoped CPM pass, never written through the API. Scoped to conflicts in
    projects the requester is a member of (object existence is not leaked across the
    boundary). Acknowledgment is gated to the downstream project's scope manager
    (Admin+ or the Scrum Master / Product Owner facet) and is management-inert:
    there is no program/portfolio bypass path — only a real membership + facet on
    the threatened project grants it (ADR-0102 §3).
    """

    serializer_class = CrossProjectSlipConflictSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = SlipConflictPagination
    queryset = CrossProjectSlipConflict.objects.all()

    def get_permissions(self) -> list[BasePermission]:
        """Gate ``acknowledge`` at the permission layer with the scope-manager rule.

        Acknowledge is Admin+ OR the Scrum Master / Product Owner facet on the
        downstream project (ADR-0102 §3). The action body re-checks the same rule
        (defense-in-depth, #1351); IsTaskScopeManager expresses it object-level —
        resolving the project through the conflict's ``task`` FK — so a Viewer who
        is a member of the project is denied at the permission layer rather than
        deep in the body. Non-members are already filtered out of the queryset, so
        they still get a 404 (the existence oracle stays closed). Reads keep the
        bare IsAuthenticated gate; queryset scoping enforces membership.
        """
        perms: list[BasePermission] = [IsAuthenticated()]
        if self.action == "acknowledge":
            perms.append(IsTaskScopeManager())
        return perms

    def get_queryset(self) -> QuerySet[CrossProjectSlipConflict]:
        from trueppm_api.apps.projects.models import SlipConflictResolution

        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated:
            return CrossProjectSlipConflict.objects.none()
        member_project_ids = ProjectMembership.objects.filter(
            user=user, is_deleted=False
        ).values_list("project_id", flat=True)
        # Full select_related covers all FK hops in get_upstream_task (🔴-4):
        # dep → predecessor → project (3 hops per row without this).
        qs = (
            CrossProjectSlipConflict.objects.select_related(
                "sprint",
                "task",
                "task__project",
                "dependency",
                "dependency__predecessor",
                "dependency__predecessor__project",
                "dependency__successor",
                "dependency__successor__project",
                "acknowledged_by",
            )
            .filter(task__project_id__in=member_project_ids)
            .order_by("-detected_at")
        )
        sprint_id = self.request.query_params.get("sprint")
        if sprint_id:
            qs = qs.filter(sprint_id=sprint_id)
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(task__project_id=project_id)
        program_id = self.request.query_params.get("program")
        if program_id:
            qs = qs.filter(task__project__program_id=program_id)
        open_only = self.request.query_params.get("open")
        if open_only and open_only.lower() in ("1", "true"):
            qs = qs.filter(
                resolution=SlipConflictResolution.UNRESOLVED, acknowledged_at__isnull=True
            )
        return qs

    @extend_schema(request=None, responses=CrossProjectSlipConflictSerializer)
    @action(detail=True, methods=["post"], url_path="acknowledge")
    def acknowledge(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Acknowledge a cross-project slip conflict (ADR-0120 D4).

        An audit act — "seen, handling it" — *not* a schedule mutation: it never
        moves the task, the sprint, or any commitment. Only the downstream project's
        scope manager (Admin+ or SM/PO facet) may acknowledge; the resolution itself
        happens through the team's own surfaces. Returns 400 if the conflict is
        already resolved.
        """
        from django.contrib.auth.models import AnonymousUser
        from rest_framework.exceptions import PermissionDenied
        from rest_framework.exceptions import ValidationError as DRFValidationError

        from trueppm_api.apps.access.permissions import (
            can_manage_scope_with_facet,
            effective_project_role,
        )
        from trueppm_api.apps.projects.models import SlipConflictResolution

        conflict = self.get_object()
        project_id = conflict.task.project_id
        role = effective_project_role(request, project_id)
        if not can_manage_scope_with_facet(request.user, project_id, role):
            raise PermissionDenied(
                "You need Admin or the Scrum Master / Product Owner facet on this "
                "project to acknowledge a cross-project slip conflict."
            )
        if conflict.resolution != SlipConflictResolution.UNRESOLVED:
            raise DRFValidationError("This conflict is no longer open.")
        # Idempotent: re-acknowledging keeps the first acknowledger and timestamp.
        if conflict.acknowledged_at is None:
            user = request.user
            conflict.acknowledged_by = None if isinstance(user, AnonymousUser) else user
            conflict.acknowledged_at = timezone.now()
            conflict.save(update_fields=["acknowledged_by", "acknowledged_at"])
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            # Clear the downstream project's stale conflict badge for peers
            # without a manual refetch (#1323). Only on a real state change —
            # a re-acknowledge is a no-op and broadcasts nothing. Snapshot to
            # plain strings for the deferred closure.
            _project_id = str(project_id)
            _conflict_id = str(conflict.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(
                    _project_id,
                    "slip_conflict_acknowledged",
                    {"id": _conflict_id},
                )
            )
        return Response(self.get_serializer(conflict).data)


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="project",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to recurrence rules whose task is in this project.",
            ),
            OpenApiParameter(
                name="task",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter to the recurrence rule attached to this task.",
            ),
        ],
    ),
)
class TaskRecurrenceRuleViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[TaskRecurrenceRule]):
    """CRUD for a task's recurrence rule (ADR-0090, #736).

    Attaching a rule pulls its template task out of the CPM graph (recurring tasks
    are parallel, calendar-driven activities, not nodes in the logical network);
    detaching puts it back. Because this changes what the scheduler sees, writes
    require Resource Manager+ (IsProjectScheduler — same gate as DependencyViewSet)
    and re-trigger a CPM recompute on commit. Reads are open to any project member.
    """

    permission_classes = [IsAuthenticated, IsProjectScheduler, IsProjectNotArchived]

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]

    serializer_class = TaskRecurrenceRuleSerializer
    queryset = TaskRecurrenceRule.objects.select_related("task").filter(is_deleted=False)

    def get_queryset(self) -> QuerySet[TaskRecurrenceRule]:
        user = getattr(self.request, "user", None)
        if not user or not user.is_authenticated:
            return TaskRecurrenceRule.objects.none()
        qs = super().get_queryset()
        # Scope to projects the caller is a member of — prevents cross-project reads.
        member_project_ids = ProjectMembership.objects.filter(
            user=user, is_deleted=False
        ).values_list("project_id", flat=True)
        qs = qs.filter(task__project_id__in=member_project_ids)
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(task__project_id=project_id)
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(task_id=task_id)
        # Annotate the occurrence count so the serializer avoids a COUNT-per-row N+1
        # when listing rules for a project. Explicit order_by keeps list pagination
        # deterministic (the Count annotation otherwise clears the queryset's ordering).
        annotated: QuerySet[TaskRecurrenceRule] = qs.annotate(
            _occurrence_count=Count("occurrences", filter=Q(occurrences__is_deleted=False))
        ).order_by("task_id")
        return annotated

    def perform_create(self, serializer: BaseSerializer[TaskRecurrenceRule]) -> None:
        # DRF does not call has_object_permission on create — verify the caller has
        # Scheduler+ on the template task's project before saving (same guard as
        # DependencyViewSet).
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        task = serializer.validated_data.get("task")
        if task is not None:
            self.check_object_permissions(self.request, task)
        instance = serializer.save()
        template = instance.task
        project_id = str(template.project_id)
        # The template just left the CPM graph — flag it and recompute the schedule
        # without it (ADR-0090). is_recurring is the single load-bearing exclusion key.
        if not template.is_recurring:
            template.is_recurring = True
            template.save(update_fields=["is_recurring"])
        task_id = str(template.pk)
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        # The template's is_recurring badge changed — notify live boards (ADR-0060
        # parent-update pattern); the save() above already bumped its server_version.
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_updated", {"id": task_id})
        )

    def perform_destroy(self, instance: TaskRecurrenceRule) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Soft-delete the rule (stops further generation; the hourly sweep skips
        # is_deleted rules). Existing occurrences are real tasks and are retained.
        template = instance.task
        project_id = str(template.project_id)
        instance.soft_delete()
        # The template rejoins the CPM graph — clear the flag and recompute.
        if template.is_recurring:
            template.is_recurring = False
            template.save(update_fields=["is_recurring"])
        task_id = str(template.pk)
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_updated", {"id": task_id})
        )


# ---------------------------------------------------------------------------
# Reorder and Bulk views
# ---------------------------------------------------------------------------


def _build_wbs_path(parent_path: str, position: int) -> str:
    """Compute a sibling's ltree path given its parent and 1-based position.

    Examples:
        _build_wbs_path("", 1)       → "1"
        _build_wbs_path("1.2", 3)    → "1.2.3"
    """
    label = str(position)
    return f"{parent_path}.{label}" if parent_path else label


class TaskReorderView(IdempotencyMixin, APIView):
    """Reorder sibling tasks within a WBS level.

    POST /api/v1/projects/{pk}/tasks/reorder/

    Body:
        {
            "parent_path": "1.2",          # empty string for root level
            "ordered_ids": ["<uuid>", ...]  # all live siblings in desired order
        }

    The server recomputes wbs_path for every sibling (e.g. "1.2.1", "1.2.2",
    ...) and saves them atomically.  All supplied IDs must be live, non-deleted
    tasks belonging to this project under the given parent — otherwise 400.

    Returns:
        200 { "updated": [{ "id": "<uuid>", "wbs_path": "1.2.1" }, ...] }
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite, IsProjectNotArchived]

    @extend_schema(
        summary="Reorder sibling tasks within a WBS level",
        request=TaskReorderSerializer,
        responses={200: TaskReorderResponseSerializer},
    )
    def post(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        serializer = TaskReorderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        parent_path: str = serializer.validated_data["parent_path"]
        ordered_ids: list[uuid.UUID] = serializer.validated_data["ordered_ids"]

        # Fetch live siblings for this parent, locked for update.
        siblings_qs = Task.objects.select_for_update().filter(project_id=pk, is_deleted=False)
        if parent_path:
            # Exact siblings: their path is "{parent_path}.{single_label}",
            # i.e. the path starts with the parent prefix and adds exactly one
            # label segment.  We filter by prefix match then exclude deeper paths.
            siblings_qs = siblings_qs.filter(wbs_path__startswith=f"{parent_path}.").exclude(
                # Exclude tasks deeper than one level below parent_path.
                # A descendant at depth+2 would have at least two dots after
                # the parent prefix — filter those out.
                wbs_path__regex=rf"^{parent_path}\.\d+\."
            )
        else:
            # Root-level siblings have no dot in their path.
            siblings_qs = siblings_qs.filter(wbs_path__regex=r"^\d+$")

        siblings_by_id = {t.pk: t for t in siblings_qs}

        # Validate: every supplied ID must be a live sibling.
        supplied_ids = {uid: True for uid in ordered_ids}
        unknown = [str(uid) for uid in ordered_ids if uid not in siblings_by_id]
        if unknown:
            return Response(
                {"ordered_ids": [f"Unknown or invalid task IDs: {', '.join(unknown)}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate: the supplied list must be complete (no missing siblings).
        missing = [str(pk_) for pk_ in siblings_by_id if pk_ not in supplied_ids]
        if missing:
            return Response(
                {"ordered_ids": [f"Missing siblings from ordered_ids: {', '.join(missing)}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # A reorder rewrites wbs_path for every task in the level, so — like
        # indent/outdent/reparent (#1771) — it requires per-task edit authority
        # on each sibling, not merely IsProjectMemberWrite. Without this a Member
        # who cannot rename a colleague's task could still renumber it by
        # reordering the level it lives in. Reorder is complete-set validated, so
        # gating every supplied sibling matches the invariant exactly.
        for task in siblings_by_id.values():
            _require_wbs_restructure_permission(request, task)

        updated: list[dict[str, Any]] = []

        with transaction.atomic():
            for position, task_id in enumerate(ordered_ids, start=1):
                task = siblings_by_id[task_id]
                new_path = _build_wbs_path(parent_path, position)
                if task.wbs_path != new_path:
                    task.wbs_path = new_path
                    task.save(update_fields=["wbs_path"])
                updated.append({"id": str(task_id), "wbs_path": new_path})

            project_id = str(project.pk)
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(lambda: broadcast_board_event(project_id, "tasks_reordered", {}))

        return Response({"updated": updated}, status=status.HTTP_200_OK)


def _get_parent_path(wbs_path: str) -> str:
    """Return the parent's wbs_path by stripping the last label, or '' for root."""
    parts = wbs_path.split(".")
    return ".".join(parts[:-1]) if len(parts) > 1 else ""


def _get_siblings(project_id: str, parent_path: str, *, lock: bool = False) -> list[Task]:
    """Fetch live tasks at the given parent level, ordered by wbs_path."""
    qs = Task.objects.filter(project_id=project_id, is_deleted=False)
    if lock:
        qs = qs.select_for_update()
    if parent_path:
        qs = qs.filter(wbs_path__startswith=f"{parent_path}.").exclude(
            wbs_path__regex=rf"^{parent_path}\.\d+\."
        )
    else:
        qs = qs.filter(wbs_path__regex=r"^\d+$")
    return list(qs.order_by("wbs_path"))


def _get_descendants(project_id: str, wbs_path: str, *, lock: bool = False) -> list[Task]:
    """Fetch all live descendants of a task (not including the task itself)."""
    qs = Task.objects.filter(
        project_id=project_id,
        is_deleted=False,
        wbs_path__startswith=f"{wbs_path}.",
    )
    if lock:
        qs = qs.select_for_update()
    return list(qs.order_by("wbs_path"))


def _renumber_siblings(siblings: list[Task], parent_path: str) -> list[dict[str, Any]]:
    """Assign sequential wbs_path to siblings and save changed ones.

    Returns list of {"id": ..., "wbs_path": ...} for all siblings.
    """
    updated: list[dict[str, Any]] = []
    for position, task in enumerate(siblings, start=1):
        new_path = _build_wbs_path(parent_path, position)
        if task.wbs_path != new_path:
            task.wbs_path = new_path
            task.save(update_fields=["wbs_path"])
        updated.append({"id": str(task.pk), "wbs_path": new_path})
    return updated


def _rewrite_descendants(
    descendants: list[Task], old_prefix: str, new_prefix: str
) -> list[dict[str, Any]]:
    """Update wbs_path for all descendants when a parent's path changes."""
    updated: list[dict[str, Any]] = []
    for task in descendants:
        if task.wbs_path and task.wbs_path.startswith(old_prefix):
            new_path = new_prefix + task.wbs_path[len(old_prefix) :]
            if task.wbs_path != new_path:
                task.wbs_path = new_path
                task.save(update_fields=["wbs_path"])
            updated.append({"id": str(task.pk), "wbs_path": new_path})
    return updated


def _require_wbs_restructure_permission(request: Request, task: Task) -> None:
    """Gate a WBS structural move at the same authority as a field edit (#1771).

    Indent/outdent/reparent only declare ``IsProjectMemberWrite`` (any Member may
    write the project), but moving a task rewrites its phase, rollup parent, and
    summary-lock across the whole subtree — a heavier act than a field PATCH, which
    is gated by ``IsProjectMemberWriteOrOwn`` (Member = own-assigned tasks only).
    Left weaker, a Member who cannot rename a colleague's task could still reparent
    it anywhere in the tree. Delegate to the ADR-0133 source of truth so restructure
    authority tracks field-edit authority exactly (Admin+, PO facet on EPIC/STORY,
    or own-assigned Member).
    """
    if not can_user_edit_task(request, task):
        raise PermissionDenied("You do not have permission to restructure this task.")


@extend_schema_view(
    post=extend_schema(
        summary="Indent a task under its previous sibling",
        request=None,
        responses={200: TaskRestructureResponseSerializer},
    )
)
class TaskIndentView(IdempotencyMixin, APIView):
    """Indent a task — make it the last child of its previous sibling.

    POST /api/v1/projects/{pk}/tasks/{task_id}/indent/

    No request body.  The task moves under the immediately preceding sibling
    at the same WBS level.

    Returns:
        200 { "updated": [...], "warning": null | "has_assignments" }
        400 when the task is first at its level (no previous sibling).
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite, IsProjectNotArchived]

    def post(self, request: Request, pk: str, task_id: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        with transaction.atomic():
            task = get_object_or_404(
                Task.objects.select_for_update(),
                pk=task_id,
                project_id=pk,
                is_deleted=False,
            )
            _require_wbs_restructure_permission(request, task)
            if not task.wbs_path:
                return Response(
                    {"detail": "Task has no WBS path."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            parent_path = _get_parent_path(task.wbs_path)
            siblings = _get_siblings(str(project.pk), parent_path, lock=True)

            task_idx = next((i for i, s in enumerate(siblings) if s.pk == task.pk), None)
            if task_idx is None or task_idx == 0:
                return Response(
                    {"detail": "Cannot indent: task is first at its level."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            prev_sibling = siblings[task_idx - 1]
            # Milestone guard (#1773): indenting makes prev_sibling the new parent;
            # a milestone is a single point and cannot acquire children.
            if prev_sibling.is_milestone:
                return Response(
                    {
                        "code": "child_of_milestone",
                        "detail": "A milestone is a single point and cannot have children.",
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            descendants = _get_descendants(str(project.pk), task.wbs_path, lock=True)

            # Count existing children of previous sibling to determine insertion position.
            prev_children = _get_siblings(str(project.pk), prev_sibling.wbs_path, lock=True)
            new_position = len(prev_children) + 1
            old_path = task.wbs_path
            new_path = _build_wbs_path(prev_sibling.wbs_path, new_position)

            # Move the task under previous sibling.
            task.wbs_path = new_path
            task.save(update_fields=["wbs_path"])

            all_updated: list[dict[str, Any]] = [{"id": str(task.pk), "wbs_path": new_path}]
            all_updated.extend(_rewrite_descendants(descendants, old_path, new_path))

            # Renumber old siblings (remove the gap left by the moved task).
            remaining_siblings = [s for s in siblings if s.pk != task.pk]
            all_updated.extend(_renumber_siblings(remaining_siblings, parent_path))

            # Check if previous sibling just became a summary task with assignments.
            warning: str | None = None
            if not prev_children:
                from trueppm_api.apps.resources.models import TaskResource

                if TaskResource.objects.filter(task=prev_sibling).exists():
                    warning = "has_assignments"

            project_id = str(project.pk)
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_restructured", {})
            )

        return Response(
            {"updated": all_updated, "warning": warning},
            status=status.HTTP_200_OK,
        )


@extend_schema_view(
    post=extend_schema(
        summary="Outdent a task to its parent's level",
        request=None,
        responses={200: TaskRestructureResponseSerializer},
    )
)
class TaskOutdentView(IdempotencyMixin, APIView):
    """Outdent a task — promote to parent's level (MS Project convention).

    POST /api/v1/projects/{pk}/tasks/{task_id}/outdent/

    No request body.  Following siblings at the old level become children
    of the outdented task (MS Project convention).

    Returns:
        200 { "updated": [...], "warning": null | "has_assignments" }
        400 when the task is at root level.
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite, IsProjectNotArchived]

    def post(self, request: Request, pk: str, task_id: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        with transaction.atomic():
            task = get_object_or_404(
                Task.objects.select_for_update(),
                pk=task_id,
                project_id=pk,
                is_deleted=False,
            )
            _require_wbs_restructure_permission(request, task)
            if not task.wbs_path:
                return Response(
                    {"detail": "Task has no WBS path."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            parent_path = _get_parent_path(task.wbs_path)
            if not parent_path:
                return Response(
                    {"detail": "Cannot outdent: task is at root level."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            grandparent_path = _get_parent_path(parent_path)

            # Current siblings and task position.
            old_siblings = _get_siblings(str(project.pk), parent_path, lock=True)
            task_idx = next((i for i, s in enumerate(old_siblings) if s.pk == task.pk), None)
            if task_idx is None:
                return Response(
                    {"detail": "Task not found among its siblings."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # MS Project convention: following siblings become children.
            following_siblings = old_siblings[task_idx + 1 :]
            remaining_old = old_siblings[:task_idx]

            # Task's existing descendants.
            task_descendants = _get_descendants(str(project.pk), task.wbs_path, lock=True)

            # Siblings at the new (grandparent) level — for insertion positioning.
            new_level_siblings = _get_siblings(str(project.pk), grandparent_path, lock=True)
            parent_idx = next(
                (i for i, s in enumerate(new_level_siblings) if s.wbs_path == parent_path),
                None,
            )
            if parent_idx is None:
                return Response(
                    {"detail": "Parent task not found."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            old_path = task.wbs_path

            # Count existing children of the task.
            existing_children = _get_siblings(str(project.pk), task.wbs_path, lock=True)
            next_child_pos = len(existing_children) + 1

            all_updated: list[dict[str, Any]] = []

            # Step 1: Compute the task's new path at the grandparent level.
            # It goes immediately after its old parent.
            new_task_path = _build_wbs_path(grandparent_path, parent_idx + 2)

            # Step 2: Move the task itself.
            task.wbs_path = new_task_path
            task.save(update_fields=["wbs_path"])
            all_updated.append({"id": str(task.pk), "wbs_path": new_task_path})

            # Rewrite the task's original descendants under the new path.
            all_updated.extend(_rewrite_descendants(task_descendants, old_path, new_task_path))

            # Step 3: Adopt following siblings as children of the outdented task.
            # Use new_task_path as parent so paths are immediately correct.
            for follower in following_siblings:
                follower_old_path = follower.wbs_path
                follower_new_path = _build_wbs_path(new_task_path, next_child_pos)
                follower_desc = _get_descendants(str(project.pk), follower_old_path, lock=True)

                follower.wbs_path = follower_new_path
                follower.save(update_fields=["wbs_path"])
                all_updated.append({"id": str(follower.pk), "wbs_path": follower_new_path})
                all_updated.extend(
                    _rewrite_descendants(follower_desc, follower_old_path, follower_new_path)
                )
                next_child_pos += 1

            # Step 3: Renumber remaining siblings at the old level.
            all_updated.extend(_renumber_siblings(remaining_old, parent_path))

            # Step 4: Renumber siblings at the new level (insert task after parent).
            refreshed_new_siblings = _get_siblings(str(project.pk), grandparent_path, lock=True)
            all_updated.extend(_renumber_siblings(refreshed_new_siblings, grandparent_path))

            # Assignment warning if the task gained children (adopted followers).
            warning: str | None = None
            if following_siblings and not existing_children:
                from trueppm_api.apps.resources.models import TaskResource

                if TaskResource.objects.filter(task=task).exists():
                    warning = "has_assignments"

            project_id = str(project.pk)
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_restructured", {})
            )

        return Response(
            {"updated": all_updated, "warning": warning},
            status=status.HTTP_200_OK,
        )


@extend_schema_view(
    post=extend_schema(
        summary="Reparent a task under an arbitrary summary (or to root)",
        request=inline_serializer(
            name="TaskReparentRequest",
            fields={
                "new_parent_id": serializers.UUIDField(
                    allow_null=True,
                    help_text="Target parent task id, or null to move the task to root level.",
                )
            },
        ),
        responses={200: TaskRestructureResponseSerializer},
    )
)
class TaskReparentView(IdempotencyMixin, APIView):
    """Reparent a task — move it under an arbitrary summary (or to root).

    POST /api/v1/projects/{pk}/tasks/{task_id}/reparent/

    Body:
        { "new_parent_id": "<uuid>" | null }  (null = root level)

    Inserts the task as the last child of the target parent, rewrites
    descendants, renumbers old siblings, and triggers CPM recalc.
    Unlike indent/, the target is explicit rather than previous-sibling.

    Returns:
        200 { "updated": [...], "warning": null | "has_assignments" }
        400 on cycle (target is self or descendant) or missing WBS path.
        404 when new_parent_id does not exist in the project.
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite, IsProjectNotArchived]

    def post(self, request: Request, pk: str, task_id: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        # Reject a non-object body explicitly rather than letting .get raise an
        # unhandled AttributeError (#2213). A guard mapping to None is wrong here:
        # new_parent_id=None is a *valid* request ("move to project root"), so a
        # malformed list/scalar body must 400, not silently reparent to root.
        if not isinstance(request.data, dict):
            return Response(
                {"detail": "Request body must be a JSON object."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        new_parent_id = request.data.get("new_parent_id")

        with transaction.atomic():
            task = get_object_or_404(
                Task.objects.select_for_update(),
                pk=task_id,
                project_id=pk,
                is_deleted=False,
            )
            _require_wbs_restructure_permission(request, task)
            if not task.wbs_path:
                return Response(
                    {"detail": "Task has no WBS path."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            old_path = task.wbs_path
            old_parent_path = _get_parent_path(old_path)

            if new_parent_id is None:
                new_parent: Task | None = None
                new_parent_path = ""
            else:
                if str(new_parent_id) == str(task.pk):
                    return Response(
                        {"detail": "Cannot reparent a task under itself."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                try:
                    new_parent = Task.objects.select_for_update().get(
                        pk=new_parent_id, project_id=pk, is_deleted=False
                    )
                except Task.DoesNotExist:
                    return Response(
                        {"detail": "New parent not found."},
                        status=status.HTTP_404_NOT_FOUND,
                    )
                if not new_parent.wbs_path:
                    return Response(
                        {"detail": "New parent has no WBS path."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                # Milestone guard (#1773): a milestone is a single point and cannot
                # acquire children via reparent.
                if new_parent.is_milestone:
                    return Response(
                        {
                            "code": "child_of_milestone",
                            "detail": "A milestone is a single point and cannot have children.",
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                # Cycle guard — new parent cannot be a descendant of the task.
                if new_parent.wbs_path.startswith(f"{old_path}."):
                    return Response(
                        {"detail": "Cannot reparent under own descendant."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                new_parent_path = new_parent.wbs_path

            # No-op when the task is already a child of the target parent.
            if old_parent_path == new_parent_path:
                return Response(
                    {"updated": [], "warning": None},
                    status=status.HTTP_200_OK,
                )

            descendants = _get_descendants(str(project.pk), old_path, lock=True)
            old_siblings = _get_siblings(str(project.pk), old_parent_path, lock=True)
            new_children = _get_siblings(str(project.pk), new_parent_path, lock=True)

            new_position = len(new_children) + 1
            new_path = _build_wbs_path(new_parent_path, new_position)

            task.wbs_path = new_path
            task.save(update_fields=["wbs_path"])

            all_updated: list[dict[str, Any]] = [{"id": str(task.pk), "wbs_path": new_path}]
            all_updated.extend(_rewrite_descendants(descendants, old_path, new_path))

            remaining_old = [s for s in old_siblings if s.pk != task.pk]
            all_updated.extend(_renumber_siblings(remaining_old, old_parent_path))

            # Warning: new parent just became a summary and has resource assignments.
            warning: str | None = None
            if new_parent is not None and not new_children:
                from trueppm_api.apps.resources.models import TaskResource

                if TaskResource.objects.filter(task=new_parent).exists():
                    warning = "has_assignments"

            project_id = str(project.pk)
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_restructured", {})
            )

        return Response(
            {"updated": all_updated, "warning": warning},
            status=status.HTTP_200_OK,
        )


@extend_schema_view(
    post=extend_schema(
        summary="Atomically create, update, and delete tasks in one request",
        request=TaskBulkSerializer,
        responses={200: TaskBulkResponseSerializer},
    )
)
class TaskBulkView(IdempotencyMixin, APIView):
    """Atomically create, update, and delete tasks in a single request.

    POST /api/v1/projects/{pk}/tasks/bulk/

    Body:
        {
            "operations": [
                { "op": "create", "data": { "name": "Sprint 1", "duration": 5, ... } },
                { "op": "update", "id": "<uuid>", "data": { "percent_complete": 0.5 } },
                { "op": "delete", "id": "<uuid>" }
            ]
        }

    All operations execute inside a single transaction.atomic() block.
    The scheduling engine is triggered once after commit regardless of how
    many tasks were mutated.

    Returns:
        200 {
            "created": [{ "id": "<uuid>", ...task fields... }, ...],
            "updated": [{ "id": "<uuid>", ...task fields... }, ...],
            "deleted": ["<uuid>", ...]
        }
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite, IsProjectNotArchived]

    def post(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        serializer = TaskBulkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        operations: list[dict[str, Any]] = serializer.validated_data["operations"]

        # Collect update/delete IDs up front so we can lock the rows in one
        # select_for_update() call — avoids repeated individual lookups.
        mutated_ids = [op["id"] for op in operations if op["op"] in ("update", "delete")]
        locked_tasks: dict[uuid.UUID, Task] = {}
        if mutated_ids:
            # of=("self",) restricts the row lock to the Task table — without it,
            # select_related on the nullable Sprint FK creates an outer join that
            # Postgres rejects ("FOR UPDATE cannot be applied to the nullable side
            # of an outer join"). Sprint is needed read-only by the progress-gate
            # serializer; only Task rows need a write lock.
            qs = (
                Task.objects.select_for_update(of=("self",))
                .select_related("sprint", "project")
                .filter(pk__in=mutated_ids, project_id=pk, is_deleted=False)
            )
            locked_tasks = {t.pk: t for t in qs}

            # Validate all referenced tasks exist and belong to this project.
            missing = [str(uid) for uid in mutated_ids if uid not in locked_tasks]
            if missing:
                return Response(
                    {"operations": [f"Task(s) not found in project: {', '.join(missing)}"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        result: dict[str, Any] = {"created": [], "updated": [], "deleted": []}
        # #998: collect mutated PKs and serialize them in ONE annotated batch
        # fetch after the loop. Serializing a bare freshly-created / locked Task
        # degrades every annotation-backed TaskSerializer field (is_summary,
        # has_predecessors, baseline_*, …) to a per-row live query or a
        # silently-wrong default — O(N) extra queries on this hot write path.
        created_ids: list[uuid.UUID] = []
        updated_ids: list[uuid.UUID] = []
        # #867: track whether any create/update pulled the project start earlier
        # so a single project_updated event rides the bulk on_commit batch.
        project_start_shifted = False

        # Fetch the caller's role once for the delete permission check below.
        # delete mirrors IsProjectMemberWriteOrOwn: Admin+ or task assignee.
        from django.contrib.auth.models import User as _User

        _caller = cast(_User, request.user)
        caller_role: int = (
            ProjectMembership.objects.filter(project_id=pk, user=_caller, is_deleted=False)
            .values_list("role", flat=True)
            .first()
            or -1
        )

        with transaction.atomic():
            for op in operations:
                op_type: str = op["op"]
                data: dict[str, Any] = op.get("data", {})

                if op_type == "create":
                    serializer_ctx = {"request": request, "caller_role": caller_role}
                    task_serializer = TaskSerializer(
                        data={**data, "project": str(project.pk)}, context=serializer_ctx
                    )
                    try:
                        task_serializer.is_valid(raise_exception=True)
                    except ProgressAnchorError:
                        return Response(
                            {
                                "code": "progress_requires_anchor",
                                "detail": (
                                    "Cannot record progress without a planned start date"
                                    " or sprint assignment."
                                ),
                                "suggested_action": "set_planned_start",
                            },
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    task = task_serializer.save()
                    created_ids.append(task.pk)
                    if getattr(task, "_project_start_shifted_from", None) is not None:
                        project_start_shifted = True

                elif op_type == "update":
                    task = locked_tasks[op["id"]]
                    # Enforce the SAME per-task ownership rule the single-task
                    # TaskViewSet.update path applies via IsProjectMemberWriteOrOwn
                    # (ADR-0133 can_user_edit_task): Admin+ edit any task, a Member
                    # only their own assigned task, PO the EPIC/STORY items. Without
                    # this a plain Member could bulk-edit tasks assigned to others,
                    # bypassing the check enforced everywhere else (#1548). Non-
                    # editable tasks 403 the whole request, mirroring the delete
                    # branch below so both bulk ops behave consistently.
                    if not can_user_edit_task(request, task, method="PATCH"):
                        return Response(
                            {
                                "operations": [
                                    "You do not have permission to edit one or more tasks "
                                    "in this batch."
                                ]
                            },
                            status=status.HTTP_403_FORBIDDEN,
                        )
                    serializer_ctx = {"request": request, "caller_role": caller_role}
                    task_serializer = TaskSerializer(
                        task, data=data, partial=True, context=serializer_ctx
                    )
                    try:
                        task_serializer.is_valid(raise_exception=True)
                    except ProgressAnchorError:
                        return Response(
                            {
                                "code": "progress_requires_anchor",
                                "detail": (
                                    "Cannot record progress without a planned start date"
                                    " or sprint assignment."
                                ),
                                "suggested_action": "set_planned_start",
                                "task_id": str(op["id"]),
                            },
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    except MilestoneRollupLockedError:
                        return Response(
                            {
                                "code": "milestone_rollup_locked",
                                "detail": (
                                    "This milestone's progress is rolled up from its linked "
                                    "sprint(s) and cannot be edited manually. Close or unlink "
                                    "the sprint to edit."
                                ),
                                "suggested_action": "unlink_or_close_sprint",
                                "task_id": str(op["id"]),
                            },
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    task = task_serializer.save()
                    updated_ids.append(task.pk)
                    if getattr(task, "_project_start_shifted_from", None) is not None:
                        project_start_shifted = True

                elif op_type == "delete":
                    task = locked_tasks[op["id"]]
                    # Mirrors IsProjectMemberWriteOrOwn: Admin+ or task assignee may delete.
                    if caller_role < Role.ADMIN:
                        is_assignee = task.assignments.filter(resource__user=_caller).exists()
                        if not is_assignee:
                            return Response(
                                {
                                    "operations": [
                                        "Only Project Managers and task assignees may delete tasks."
                                    ]
                                },
                                status=status.HTTP_403_FORBIDDEN,
                            )
                    task.soft_delete()
                    result["deleted"].append(str(op["id"]))

            project_id = str(project.pk)
            # #1009: carry the ids of the tasks this bulk op touched (created,
            # updated, and deleted) so the payload matches close_sprint's
            # tasks_bulk_mutated shape ({"task_ids": [...]}) instead of an empty {} —
            # clients that key off task_ids can target the refetch instead of
            # blind-refetching the whole board. Bound via a default arg so closure
            # late-binding can't swap the list.
            mutated_task_ids: list[str] = [str(tid) for tid in created_ids + updated_ids] + list(
                result["deleted"]
            )

            def _broadcast_bulk_mutated(ids: list[str] = mutated_task_ids) -> None:
                broadcast_board_event(project_id, "tasks_bulk_mutated", {"task_ids": ids})

            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(_broadcast_bulk_mutated)
            # #867: a bulk op pulled the project start earlier — collaborators
            # must re-fetch the boundary, which tasks_bulk_mutated doesn't carry.
            if project_start_shifted:
                transaction.on_commit(
                    lambda: broadcast_board_event(project_id, "project_updated", {"id": project_id})
                )

        # #998: one annotated batch fetch for every created/updated task, instead
        # of serializing bare instances inside the loop. Runs after the atomic
        # block commits so the re-fetch sees the final persisted state. Milestone
        # rollups are batched too (#999) so a bulk milestone mutation does not fan
        # out per-row on read. Order is preserved per bucket via the id lists.
        all_ids = created_ids + updated_ids
        if all_ids:
            batch = annotate_tasks_queryset(
                Task.objects.filter(pk__in=all_ids, is_deleted=False), request, str(project.pk)
            )
            by_id = {t.pk: t for t in batch}
            _attach_milestone_rollups(list(by_id.values()))
            result["created"] = [
                TaskSerializer(by_id[tid]).data for tid in created_ids if tid in by_id
            ]
            result["updated"] = [
                TaskSerializer(by_id[tid]).data for tid in updated_ids if tid in by_id
            ]

        return Response(result, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Risk register
# ---------------------------------------------------------------------------


def _record_risk_link_events(
    risk: Risk,
    *,
    added: Iterable[Any],
    removed: Iterable[Any],
    actor: Any,
) -> None:
    """Record risk_linked / risk_unlinked events on each affected task's feed.

    The ``RiskTask`` through-table carries no timestamp or actor, so a link/unlink
    is captured as :class:`TaskActivityEvent` rows (ADR-0207, #1604) — one per task
    added or removed — with the acting member and the risk's identity. Written
    synchronously inside the request transaction so the rows commit or roll back
    with the risk change itself (unlike the on_commit board broadcast, these are
    DB rows, not an external side effect).
    """
    detail = {
        "risk_id": str(risk.pk),
        "risk_short_id": risk.short_id,
        "risk_title": risk.title,
    }
    rows = [
        TaskActivityEvent(task_id=tid, actor=actor, event_type="risk_linked", detail=detail)
        for tid in added
    ] + [
        TaskActivityEvent(task_id=tid, actor=actor, event_type="risk_unlinked", detail=detail)
        for tid in removed
    ]
    if rows:
        TaskActivityEvent.objects.bulk_create(rows)


class RiskViewSet(
    FieldLevelMergeMixin, McpReadableViewMixin, ProjectScopedViewSet, viewsets.ModelViewSet[Risk]
):
    """CRUD for risks within a project.

    Permission matrix:
      list / retrieve         — Viewer+ (IsProjectMember)
      create / update         — Team Member+ (IsProjectMemberWrite)
      import (CSV)            — Team Member+ (IsProjectMemberWrite, default branch)
      destroy                 — Project Owner only (IsProjectOwner)

    Severity (probability × impact) is annotated on the queryset so
    OrderingFilter can sort by it without a Python round-trip.
    """

    queryset = (
        Risk.objects.select_related("project", "owner", "created_by")
        .prefetch_related("tasks")
        .filter(is_deleted=False)
    )
    serializer_class = RiskSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["title", "description"]
    ordering_fields = ["severity", "probability", "impact", "status", "created_at"]

    def get_permissions(self) -> list[BasePermission]:
        # ADR-0186 §E: append the read-only MCP token guards around the
        # action-specific RBAC list so a mcp:read token is confined to safe
        # methods on every action (no write-branch leak); human auth passes both.
        return [*self._rbac_permissions(), *self.mcp_token_guards()]

    def _rbac_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        if self.action == "destroy":
            return [IsAuthenticated(), IsProjectOwner(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[Risk]:
        qs = super().get_queryset()
        project_pk = self.kwargs.get("project_pk")
        if project_pk:
            qs = qs.filter(project_id=project_pk)
        short_id = self.request.query_params.get("short_id")
        if short_id:
            qs = qs.filter(short_id=short_id.upper())
        status_filter = self.request.query_params.get("status")
        if status_filter:
            qs = qs.filter(status=status_filter)
        # ?task=<uuid> — return only risks linked to that task (for board RiskPopover
        # click-through; ADR-0035 b3). Uses the RiskTask through-table reverse path.
        task_id = self.request.query_params.get("task")
        if task_id:
            qs = qs.filter(tasks__id=task_id)
        # Annotate computed severity so OrderingFilter can sort without Python.
        return qs.annotate(  # type: ignore[no-any-return]
            severity=ExpressionWrapper(
                F("probability") * F("impact"),
                output_field=IntegerField(),
            )
        )

    def perform_create(self, serializer: BaseSerializer[Risk]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        # DRF does not call has_object_permission on create — check explicitly.
        self.check_object_permissions(self.request, project)

        instance = serializer.save(
            project=project,
            created_by=self.request.user,
        )
        # ADR-0207 (#1604): a new risk links its tasks for the first time, so every
        # linked task gets a risk_linked activity event (actor = the creator).
        _record_risk_link_events(
            instance,
            added=list(instance.tasks.values_list("id", flat=True)),
            removed=[],
            actor=self.request.user,
        )
        risk_id = str(instance.pk)
        project_id_str = str(project_pk)
        transaction.on_commit(
            lambda: broadcast_board_event(str(project_pk), "risk_created", {"id": risk_id})
        )
        # ADR-0206: emit risk.opened only when the risk is actually created OPEN.
        # status is client-writable, so a risk POSTed straight to CLOSED/RESOLVED
        # must not emit an "opened" it will never balance with a "closed" (which
        # only fires on a transition in perform_update). Payload built now (row
        # loaded in the transaction) and captured by value for the on_commit.
        if instance.status == RiskStatus.OPEN:
            opened_payload = _risk_webhook_payload(instance, source="api")
            transaction.on_commit(
                lambda: _dispatch_webhooks(project_id_str, "risk.opened", opened_payload)
            )

    def perform_update(self, serializer: BaseSerializer[Risk]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Capture the pre-save scoring/status so we can tell what transition this
        # update represents (ADR-0206): risk.escalated fires when computed severity
        # (probability × impact) increases; risk.closed on the transition into
        # CLOSED. Both are read off the loaded instance before serializer.save()
        # overwrites it.
        # Field-level conflict gate (ADR-0217, #322): raises 409 on an overlapping
        # stale write; returns the concurrently-changed fields for the response header.
        self._merge_concurrent_fields = check_field_conflict(self.request, serializer)

        old = cast(Risk, serializer.instance)
        old_status = old.status
        old_severity = old.probability * old.impact

        # Capture the linked-task set before save so the RiskTask through-rows
        # (which carry no timestamp/actor) can be diffed into risk_linked /
        # risk_unlinked activity events (ADR-0207, #1604).
        old_task_ids = set(old.tasks.values_list("id", flat=True))

        instance = serializer.save()
        new_task_ids = set(instance.tasks.values_list("id", flat=True))
        _record_risk_link_events(
            instance,
            added=new_task_ids - old_task_ids,
            removed=old_task_ids - new_task_ids,
            actor=self.request.user,
        )
        project_id = str(instance.project_id)
        risk_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "risk_updated", {"id": risk_id})
        )

        # ADR-0206: emit domain events for the transitions this update represents.
        # A single update may emit both (severity up *and* moved to CLOSED) — each
        # payload is built now and captured by value.
        new_severity = instance.probability * instance.impact
        if new_severity > old_severity:
            escalated_payload = _risk_webhook_payload(instance, source="api")
            transaction.on_commit(
                lambda: _dispatch_webhooks(project_id, "risk.escalated", escalated_payload)
            )
        if old_status != RiskStatus.CLOSED and instance.status == RiskStatus.CLOSED:
            closed_payload = _risk_webhook_payload(instance, source="api")
            transaction.on_commit(
                lambda: _dispatch_webhooks(project_id, "risk.closed", closed_payload)
            )

    def perform_destroy(self, instance: Risk) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        risk_id = str(instance.pk)
        # Deleting a risk severs every task link, so each linked task's feed gets a
        # risk_unlinked event (ADR-0207, #1877) — mirrors perform_create/perform_update.
        _record_risk_link_events(
            instance,
            added=[],
            removed=list(instance.tasks.values_list("id", flat=True)),
            actor=self.request.user,
        )
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "risk_deleted", {"id": risk_id})
        )

    @extend_schema(
        summary="Import risks from CSV",
        request={
            "multipart/form-data": {
                "type": "object",
                "properties": {"file": {"type": "string", "format": "binary"}},
                "required": ["file"],
            }
        },
        responses={200: RiskImportResultSerializer},
    )
    @action(
        detail=False,
        methods=["post"],
        url_path="import",
        parser_classes=[MultiPartParser, FormParser],
    )
    def import_csv(self, request: Request, project_pk: str | None = None) -> Response:
        """Bulk-create risks from an uploaded CSV (issue 223, ADR-0043 addendum).

        The symmetric counterpart of the #222 export — a file from "Export CSV"
        round-trips back in. Valid rows are created atomically; invalid rows are
        skipped and reported per-row so the user can fix and re-upload. A single
        ``risks_imported`` board event is broadcast on commit (not one per row).
        """
        from dataclasses import asdict

        from trueppm_api.apps.projects.risk_import import (
            MAX_BYTES,
            RiskImportError,
            build_owner_index,
            parse_risk_csv,
        )
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        # @action does not trigger has_object_permission — enforce Member+ here
        # the same way perform_create does for the standard POST path.
        self.check_object_permissions(request, project)

        upload = request.FILES.get("file")
        if upload is None:
            return Response(
                {"detail": "No file uploaded. Attach a CSV in the 'file' field."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if upload.size is not None and upload.size > MAX_BYTES:
            return Response(
                {"detail": f"File too large (limit {MAX_BYTES // (1024 * 1024)} MB)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        owner_index = build_owner_index(str(project.pk))
        try:
            plan = parse_risk_csv(upload.read(), owner_index)
        except RiskImportError as exc:
            # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        # IsAuthenticated + IsProjectMemberWrite guarantee a real user here; the
        # guard narrows the type for the create() calls below (created_by FK).
        creator = request.user
        if not creator.is_authenticated:
            return Response(status=status.HTTP_403_FORBIDDEN)

        # Create via the model's normal save() path (not bulk_create) so each
        # risk gets its short_id / server_version / sync invariants. Bounded by
        # MAX_ROWS, so the per-row query cost is acceptable for a one-time import.
        created_ids: list[str] = []
        with transaction.atomic():
            for draft in plan.drafts:
                risk = Risk.objects.create(
                    project=project,
                    created_by=creator,
                    title=draft.title,
                    description=draft.description,
                    status=draft.status,
                    probability=draft.probability,
                    impact=draft.impact,
                    category=draft.category,
                    response=draft.response,
                    mitigation_due_date=draft.mitigation_due_date,
                    trigger=draft.trigger,
                    contingency=draft.contingency,
                    owner=draft.owner,
                )
                created_ids.append(str(risk.pk))

        if created_ids:
            project_id = str(project.pk)
            ids = created_ids
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id, "risks_imported", {"count": len(ids), "ids": ids}
                )
            )

        return Response(
            {
                "imported": len(created_ids),
                "skipped": plan.skipped,
                "errors": [asdict(issue) for issue in plan.errors],
                "warnings": [asdict(issue) for issue in plan.warnings],
            },
            status=status.HTTP_200_OK,
        )


# ---------------------------------------------------------------------------
# Task labels (ADR-0400, closes #1089)
# ---------------------------------------------------------------------------

# Soft cap on label definitions per project. A ceiling — not a hard governance
# limit — that keeps the member-create escape valve (a team coins `tech-debt`
# mid-retro) from degenerating into 50 near-duplicate labels. Configurable via
# settings so an operator can raise it without a migration.
_LABEL_SOFT_CAP_DEFAULT = 50


def _label_soft_cap() -> int:
    from django.conf import settings

    return int(getattr(settings, "TRUEPPM_LABEL_SOFT_CAP", _LABEL_SOFT_CAP_DEFAULT))


class LabelViewSet(McpReadableViewMixin, ProjectScopedViewSet, viewsets.ModelViewSet[Label]):
    """CRUD for the project-scoped label catalog (ADR-0400).

    Permission matrix (adoption-first with a curation floor):
      list / retrieve                 — Viewer+ (IsProjectMember): everyone sees the vocabulary
      create                          — Team Member+ (IsProjectMemberWrite): coin a label mid-retro
      update / partial_update         — Project Admin+ (IsProjectAdmin): renaming/recoloring a
                                        shared label changes *everyone's* board
      destroy                         — Project Admin+ (IsProjectAdmin): destructive across tasks

    Reads are MCP-reachable (``mcp:read``) via the mixin; label *writes* stay
    human-only until the 0.6 agent write surface (ADR-0186).
    """

    # No select_related: the serializer emits neither project nor created_by, and
    # scoping filters on the project_id column (no join) — the FK joins were dead weight.
    queryset = Label.objects.filter(is_deleted=False)
    serializer_class = LabelSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name"]
    ordering_fields = ["position", "name", "created_at"]

    def get_permissions(self) -> list[BasePermission]:
        # ADR-0186 §E: append the read-only MCP token guards so a mcp:read token
        # can never reach a write branch; human auth passes both layers.
        return [*self._rbac_permissions(), *self.mcp_token_guards()]

    def _rbac_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        if self.action == "create":
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        # update / partial_update / destroy — curation is admin-gated.
        return [IsAuthenticated(), IsProjectAdmin(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[Label]:
        qs = super().get_queryset()
        project_pk = self.kwargs.get("project_pk")
        if project_pk:
            qs = qs.filter(project_id=project_pk)
        # Annotate usage so the settings delete-confirm can quantify blast radius
        # ("Used on N tasks", #2070) without a per-row query. Count only live tasks
        # — soft-deleted rows are not user-visible usage. distinct=True guards the
        # through-join from double-counting under any future annotation join.
        # Re-apply the palette order explicitly: the aggregate GROUP BY drops the
        # model's Meta ordering, leaving the list unordered (UnorderedObjectListWarning).
        annotated: QuerySet[Label] = qs.annotate(
            task_count=Count("tasks", filter=Q(tasks__is_deleted=False), distinct=True)
        ).order_by("position", "name")
        return annotated

    def get_serializer_context(self) -> dict[str, Any]:
        # Feed project_id into the serializer so its case-insensitive uniqueness
        # check works on create (the instance has no project yet). Build a fresh
        # dict — the base return is typed as an immutable Mapping.
        return {**super().get_serializer_context(), "project_id": self.kwargs.get("project_pk")}

    def perform_create(self, serializer: BaseSerializer[Label]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        # DRF does not call has_object_permission on create — check explicitly.
        self.check_object_permissions(self.request, project)

        # Soft cap: enforced here (not the serializer) because it needs the live
        # project-scoped count. A clean 400, not an opaque IntegrityError.
        current = Label.objects.filter(project=project, is_deleted=False).count()
        if current >= _label_soft_cap():
            raise DRFValidationError(
                {
                    "detail": (
                        f"This project has reached the label limit "
                        f"({_label_soft_cap()}). Delete an unused label first."
                    )
                }
            )
        # Append to the end of the palette order unless the client pinned a position.
        next_position = serializer.validated_data.get("position")
        if next_position is None:
            max_position = (
                Label.objects.filter(project=project, is_deleted=False).aggregate(
                    m=Max("position")
                )["m"]
                or 0
            )
            next_position = max_position + 1

        instance = serializer.save(
            project=project,
            created_by=self.request.user,
            position=next_position,
        )
        label_id = str(instance.pk)
        project_id_str = str(project_pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id_str, "label_created", {"id": label_id})
        )

    def perform_update(self, serializer: BaseSerializer[Label]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.project_id)
        label_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "label_updated", {"id": label_id})
        )

    def perform_destroy(self, instance: Label) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        label_id = str(instance.pk)
        # Detach the label from every task it's on so it stops rendering as a pill.
        # The plain ``TaskLabel`` through-rows are hard-deleted; the ``Label`` itself
        # soft-deletes so the tombstone reaches mobile via the sync-delta.
        TaskLabel.objects.filter(label=instance).delete()
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "label_deleted", {"id": label_id})
        )


class TaskLabelView(IdempotencyMixin, APIView):
    """Idempotent attach/detach of a label to a task (ADR-0400 §D4).

    Deliberately NOT a replace-set PATCH: attaching label X and detaching label Y
    are commutative single-row operations, so two concurrent clients toggling
    *different* labels never clobber each other (the lost-update race a replace-set
    ``label_ids`` PATCH would carry — Nadia's 🔴). ``unique(task, label)`` makes a
    duplicate attach a no-op. Both operations bump ``Task.server_version`` (only when
    the set actually changed) so the WS ``task_updated`` broadcast and the sync-delta
    reconcile; the pull carries the flat ``label_ids`` array (SyncTaskSerializer).

    Assignment is a *task edit*, not vocabulary management, so it is gated by the
    same ``IsProjectMemberWriteOrOwn`` predicate the task write endpoints use — a
    Member may label their own editable tasks; a Viewer cannot. Label writes stay
    human-only (no MCP token guard) until the 0.6 agent write surface (ADR-0186).
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWriteOrOwn, IsProjectNotArchived]

    def _get_task(self, project_pk: str, task_pk: str) -> Task:
        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)
        # APIView does not auto-run has_object_permission — enforce the task-edit
        # verdict (assignee-own vs project-write) explicitly.
        self.check_object_permissions(self.request, task)
        return task

    def _broadcast(self, task: Task) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_task_updated

        project_id = str(task.project_id)
        task_id = str(task.pk)
        version = task.server_version
        actor_id = str(self.request.user.pk) if self.request.user.is_authenticated else None
        transaction.on_commit(
            lambda: broadcast_task_updated(
                project_id,
                task_id=task_id,
                changed_fields=["labels"],
                version=version,
                actor_id=actor_id,
            )
        )

    def _labels_payload(self, task: Task) -> Any:
        # Serialized nested-pill list for the attach response; DRF's ``.data`` is a
        # ReturnList, so the return type stays ``Any`` (as the rest of the app does).
        labels = task.labels.filter(is_deleted=False)
        return TaskLabelChipSerializer(labels, many=True).data

    @extend_schema(
        summary="Attach a label to a task",
        request=inline_serializer(
            name="TaskLabelAttachRequest",
            fields={"label_id": serializers.UUIDField()},
        ),
        responses={200: TaskLabelChipSerializer(many=True)},
    )
    def post(self, request: Request, project_pk: str, task_pk: str) -> Response:
        task = self._get_task(project_pk, task_pk)
        label_id = request.data.get("label_id")
        if not label_id:
            raise DRFValidationError({"label_id": "This field is required."})
        # Cross-project IDOR guard: the label must belong to the task's OWN project.
        # A label id from another project resolves to 404, never an attach.
        label = get_object_or_404(Label, pk=label_id, project_id=task.project_id, is_deleted=False)
        _, created = TaskLabel.objects.get_or_create(task=task, label=label)
        if created:
            # Bump the task version only on a real change so an idempotent re-attach
            # does not churn server_version or emit a spurious broadcast.
            task.save(known_exists=True, update_fields=["server_version"])
            self._broadcast(task)
        return Response(self._labels_payload(task), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Detach a label from a task",
        responses={204: OpenApiResponse(description="Detached (idempotent)")},
    )
    def delete(self, request: Request, project_pk: str, task_pk: str, label_id: str) -> Response:
        task = self._get_task(project_pk, task_pk)
        deleted, _ = TaskLabel.objects.filter(task=task, label_id=label_id).delete()
        if deleted:
            task.save(known_exists=True, update_fields=["server_version"])
            self._broadcast(task)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Risk comments — append-only thread per risk
# ---------------------------------------------------------------------------


class RiskCommentViewSet(
    ProjectScopedViewSet,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet[RiskComment],
):
    """Append-only comment thread on a Risk.

    Permission matrix:
      list    — Viewer+ (IsProjectMember)
      create  — Team Member+ (IsProjectMemberWrite)
      (no update, no destroy — comments are immutable)
    """

    serializer_class = RiskCommentSerializer

    def get_queryset(self) -> QuerySet[RiskComment]:
        user = getattr(self.request, "user", None)
        if not user or not user.is_authenticated:
            return RiskComment.objects.none()
        project_pk = self.kwargs["project_pk"]
        # Scope to projects the user is a member of — prevents cross-project reads.
        if not ProjectMembership.objects.filter(
            user=user, project_id=project_pk, is_deleted=False
        ).exists():
            return RiskComment.objects.none()
        return RiskComment.objects.filter(
            risk__project_id=project_pk,
            risk_id=self.kwargs["risk_pk"],
        ).select_related("author")

    def get_permissions(self) -> list[BasePermission]:
        if self.action == "create":
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    def perform_create(self, serializer: BaseSerializer[RiskComment]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        risk_pk = self.kwargs["risk_pk"]
        risk = get_object_or_404(Risk, pk=risk_pk, project_id=project_pk, is_deleted=False)
        # DRF does not call has_object_permission on create — check explicitly.
        # This enforces the MEMBER+ requirement (same pattern as RiskViewSet).
        self.check_object_permissions(self.request, risk)
        instance = serializer.save(risk=risk, author=self.request.user)
        comment_id = str(instance.pk)
        risk_id = str(risk.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                str(project_pk),
                "comment_created",
                {"risk_id": risk_id, "id": comment_id},
            )
        )


# ---------------------------------------------------------------------------
# Presence endpoint — who is currently connected to this project
# ---------------------------------------------------------------------------


@extend_schema_view(
    get=extend_schema(
        summary="List users currently connected to a project's WebSocket",
        responses={200: ProjectPresenceEntrySerializer(many=True)},
    )
)
class ProjectPresenceView(APIView):
    """Return the list of users currently connected to a project's WebSocket.

    Reads from the Redis hash written by ``ProjectConsumer`` on connect/disconnect.
    The hash key has a 60-second TTL refreshed by each heartbeat, so entries are
    always live — no additional staleness filtering is needed.

    Permissions: Member (role ≥ 1) required, matching the WebSocket auth rule.

    Response: ``[{user_id: str, display_name: str}, …]``
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get(self, request: Request, pk: str) -> Response:
        """Return JSON list of online users for the given project."""
        # This route binds on a bare ``pk`` (not ``project_pk``), so
        # IsProjectMember.has_permission short-circuits to True; object-level
        # membership must be enforced explicitly, matching ProjectOverviewView
        # and ProjectAttentionView (#1547).
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        try:
            import json as _json

            import redis as redis_lib
            from django.conf import settings

            from trueppm_api.apps.sync.consumers import _presence_key

            r = redis_lib.from_url(settings.REDIS_URL, decode_responses=True)
            raw: dict[str, str] = r.hgetall(_presence_key(pk))  # type: ignore[assignment]
        except Exception:
            logger.exception("ProjectPresenceView: failed to read presence for project %s", pk)
            return Response([], status=status.HTTP_200_OK)

        users = []
        for _uid, entry_json in raw.items():
            with contextlib.suppress(ValueError, KeyError):
                users.append(_json.loads(entry_json))

        return Response(users, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Webhook dispatch helpers
# ---------------------------------------------------------------------------


def _dispatch_webhooks(project_id: str, event_type: str, payload: dict) -> None:  # type: ignore[type-arg]
    """Enqueue webhook deliveries for matching subscriptions."""
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    dispatch_webhooks(project_id, event_type, payload)


def _record_project_audit_event(
    *,
    event_type: str,
    actor: Any,
    project: Project,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Write a workspace operational audit row for a project lifecycle event.

    Bridges projects → workspace (ADR-0157, #859) at call time only, via a
    function-level import, so there is no module-load cycle. The row is written
    inside the request transaction and rolls back if the action does.
    """
    from trueppm_api.apps.workspace.services import record_audit_event

    record_audit_event(
        event_type=event_type,
        actor=actor,
        target_type="project",
        target_id=project.pk,
        target_label=project.name,
        metadata=metadata,
    )


def _notify_event(
    event_type: str,
    recipient_ids: list[str | None],
    subject: str,
    body: str,
    project_id: str,
    task_id: str | None = None,
) -> None:
    """Create per-user email/in-app notifications for an own-task event (#639).

    Thin trampoline so call sites can defer via ``transaction.on_commit`` without
    importing the notifications service at module load (avoids an import cycle).
    ``task_id`` deep-links the inbox row to the affected task (#497).
    """
    from trueppm_api.apps.notifications.services import create_event_notifications

    create_event_notifications(
        event_type=event_type,
        recipient_ids=recipient_ids,
        subject=subject,
        body=body,
        project_id=project_id,
        task_id=task_id,
    )


def _task_webhook_payload(task: Task, source: str = "unknown") -> dict:  # type: ignore[type-arg]
    """Build a webhook payload dict for a task event.

    ``source`` carries the originating UI surface (e.g. ``my_work``, ``schedule``,
    ``board``) when the X-Source request header is set on the inbound PATCH —
    ADR-0065 Gap 2 introduces this so external consumers can correlate status
    changes with the surface that triggered them. Defaults to ``"unknown"``
    for calls that don't set the header (most existing surfaces).
    """
    return {
        "id": str(task.pk),
        "project": str(task.project_id),
        "name": task.name,
        "status": task.status,
        "duration": task.duration,
        "assignee": str(task.assignee_id) if task.assignee_id else None,
        "planned_start": str(task.planned_start) if task.planned_start else None,
        "actual_start": str(task.actual_start) if task.actual_start else None,
        "actual_finish": str(task.actual_finish) if task.actual_finish else None,
        "source": source,
    }


def _sprint_base_webhook_payload(sprint: Sprint, *, source: str) -> dict:  # type: ignore[type-arg]
    """Common sprint fields shared by the activate/closed webhook payloads (ADR-0147).

    ``committed_*`` is the plan the team published when it pulled work in — not a
    performance metric — so it is never privacy-gated. The completion snapshot
    (velocity) is added only by :func:`_sprint_closed_webhook_payload`, behind the
    ADR-0104 gate.
    """
    return {
        "id": str(sprint.pk),
        "project": str(sprint.project_id),
        "name": sprint.name,
        "goal": sprint.goal,
        "state": sprint.state,
        "start_date": str(sprint.start_date) if sprint.start_date else None,
        "finish_date": str(sprint.finish_date) if sprint.finish_date else None,
        "activated_at": sprint.activated_at.isoformat() if sprint.activated_at else None,
        "committed_points": sprint.committed_points,
        "committed_task_count": sprint.committed_task_count,
        "source": source,
    }


def _sprint_closed_webhook_payload(sprint: Sprint, *, source: str) -> dict:  # type: ignore[type-arg]
    """Payload for the ``sprint.closed`` event, with ADR-0147 velocity privacy.

    The completion snapshot (``completed_points`` / ``completed_task_count`` /
    ``goal_outcome``) *is* team velocity. A webhook consumer is external, so the
    fields are emitted only when the team has shared the ``velocity`` signal outward
    (``audience == PROGRAM_SHARED``, see
    :func:`signal_privacy_services.velocity_shared_externally`). Otherwise they are
    ``null`` and ``velocity_suppressed`` is ``True`` — the "suppress, don't drop the
    keys" contract from ``suppress_velocity_summary`` so consumers keep a stable shape.
    """
    from trueppm_api.apps.projects.signal_privacy_services import velocity_shared_externally

    payload = _sprint_base_webhook_payload(sprint, source=source)
    payload["closed_at"] = sprint.closed_at.isoformat() if sprint.closed_at else None

    shared = velocity_shared_externally(sprint.project)
    payload["velocity_suppressed"] = not shared
    payload["completed_points"] = sprint.completed_points if shared else None
    payload["completed_task_count"] = sprint.completed_task_count if shared else None
    payload["goal_outcome"] = sprint.goal_outcome if shared else None
    return payload


def _sprint_scope_change_webhook_payload(scope_change: SprintScopeChange, *, source: str) -> dict:  # type: ignore[type-arg]
    """Payload for ``sprint.scope_changed`` — fired only on accept (ADR-0102/0147).

    Carries no velocity/pulse signal, so no privacy gate applies. ``id`` is the
    scope-change row id (the event is *about* the scope change), with the sprint,
    task, and project carried alongside.
    """
    return {
        "id": str(scope_change.pk),
        "sprint": str(scope_change.sprint_id),
        "project": str(scope_change.sprint.project_id),
        "task": str(scope_change.task_id) if scope_change.task_id else None,
        "item_name": scope_change.item_name,
        "status": scope_change.status,
        "goal_impact": scope_change.goal_impact,
        # When the item was injected into the sprint. SprintScopeChange does not
        # stamp the accept decision with its own timestamp (status is the audit),
        # so the event carries the injection time rather than a synthetic one.
        "added_at": scope_change.added_at.isoformat() if scope_change.added_at else None,
        "source": source,
    }


def _risk_webhook_payload(risk: Risk, *, source: str) -> dict:  # type: ignore[type-arg]
    """Build a webhook payload for a risk event (ADR-0206).

    Used by ``risk.opened`` / ``risk.escalated`` / ``risk.closed``. ``severity`` is
    the computed ``probability * impact`` (the model stores neither; it is derived
    at read time), included so an external consumer does not have to recompute it.
    None of these fields is a team-performance (velocity/pulse) signal, so no
    ADR-0104 privacy gate applies.

    Args:
        risk: The risk row, loaded inside the request transaction.
        source: Originating surface for consumer correlation (e.g. ``"api"``).

    Returns:
        A JSON-serializable dict describing the risk at emit time.
    """
    return {
        "id": str(risk.pk),
        "project": str(risk.project_id),
        "short_id": risk.short_id,
        "title": risk.title,
        "status": risk.status,
        "probability": risk.probability,
        "impact": risk.impact,
        "severity": risk.probability * risk.impact,
        "category": risk.category,
        "owner": str(risk.owner_id) if risk.owner_id else None,
        "source": source,
    }


def _baseline_webhook_payload(baseline: Baseline, *, task_count: int, source: str) -> dict:  # type: ignore[type-arg]
    """Build a webhook payload for the ``baseline.captured`` event (ADR-0206).

    ``task_count`` is passed in rather than read off the instance because
    ``perform_create`` snapshots the tasks and knows the count without an extra
    query (the ``task_count`` annotation only exists on list/retrieve querysets).
    Baseline name and dates are plan facts, not performance signals, so no ADR-0104
    gate applies.

    Args:
        baseline: The baseline row, loaded inside the request transaction.
        task_count: Number of tasks captured in this baseline snapshot.
        source: Originating surface for consumer correlation (e.g. ``"api"``).

    Returns:
        A JSON-serializable dict describing the captured baseline.
    """
    return {
        "id": str(baseline.pk),
        "project": str(baseline.project_id),
        "name": baseline.name,
        "has_cpm_dates": baseline.has_cpm_dates,
        "task_count": task_count,
        "created_by": str(baseline.created_by_id) if baseline.created_by_id else None,
        "source": source,
    }


def _comment_created_webhook_payload(task: Task, comment: TaskComment, *, source: str) -> dict:  # type: ignore[type-arg]
    """Build a webhook payload for the ``comment.created`` event (ADR-0206).

    Spreads the task payload (so consumers get task context) and adds comment
    metadata. The comment **body is deliberately excluded** — the event carries
    only that a comment was created and by whom, not its content, which keeps the
    payload privacy-conservative (a webhook consumer is external to the team).
    Distinct from ``task.mentioned``, which fires only when a comment @mentions
    someone; ``comment.created`` fires for every comment.

    Args:
        task: The commented-on task, loaded inside the request transaction.
        comment: The newly created comment row.
        source: Originating surface for consumer correlation (e.g. ``"api"``).

    Returns:
        A JSON-serializable dict with task context plus comment metadata (no body).
    """
    author = comment.author
    return {
        **_task_webhook_payload(task, source=source),
        "comment_id": str(comment.pk),
        "author": str(comment.author_id) if comment.author_id else None,
        "author_display": (author.get_full_name() or author.username) if author else None,
        "created_at": comment.created_at.isoformat() if comment.created_at else None,
    }


def _broadcast_retro_updated(sprint: Sprint) -> None:
    """Defer a ``sprint_retro_updated`` board broadcast for a retro mutation (#1359).

    The sprint retrospective (notes + action items + visibility) is a
    collaborative surface, but its REST writes emitted no WebSocket event, so a
    peer with the retro open silently desynced until a manual refresh. Carries
    only the sprint id (the retro is read back through the visibility-aware
    serializer per viewer); no role-gated values are placed on the wire. Snapshot
    to a plain string before the closure and defer to commit so a rolled-back
    upsert never broadcasts.
    """
    sprint_id = str(sprint.pk)
    project_id = str(sprint.project_id)

    def _on_commit() -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        broadcast_board_event(project_id, "sprint_retro_updated", {"sprint_id": sprint_id})

    transaction.on_commit(_on_commit)


# ---------------------------------------------------------------------------
# Board column configuration
# ---------------------------------------------------------------------------


@extend_schema_view(
    get=extend_schema(
        summary="Get the board column configuration",
        responses={200: BoardColumnConfigResponseSerializer},
    ),
    put=extend_schema(
        summary="Replace the board column configuration",
        request=BoardColumnConfigSerializer,
        responses={200: BoardColumnConfigResponseSerializer},
    ),
)
class BoardColumnConfigView(McpReadableViewMixin, IdempotencyMixin, APIView):
    """GET/PUT per-project board column configuration.

    GET returns the saved config or the hardcoded 5-column defaults.
    PUT validates and saves the config, creating the row if it doesn't exist.
    Requires SCHEDULER role (≥ 2) for writes — same as schedule-affecting changes.
    Reads are open to all project members.
    """

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method in SAFE_METHODS:
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]

    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import annotate_wip_breach

        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)
        try:
            config = BoardColumnConfig.objects.get(project_id=pk)
            columns = config.columns or _DEFAULT_COLUMNS
        except BoardColumnConfig.DoesNotExist:
            columns = _DEFAULT_COLUMNS
        # D2 (#1071): annotate each column with its live count + WIP-breach verdict
        # so the breach is a server fact (API-first). Passive — visible to every
        # project member (current board state, not gated historical performance).
        columns = annotate_wip_breach(pk, columns)
        return Response({"columns": columns}, status=status.HTTP_200_OK)

    def put(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)
        serializer = BoardColumnConfigSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        validated = serializer.validated_data
        with transaction.atomic():
            BoardColumnConfig.objects.update_or_create(
                project_id=pk,
                defaults={"columns": validated["columns"]},
            )
            project_id = str(pk)
            columns_payload = list(validated["columns"])
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id, "board_config_updated", {"columns": columns_payload}
                )
            )
        return Response(validated, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Board saved views endpoints (issue #191)
# ---------------------------------------------------------------------------


@extend_schema_view(
    get=extend_schema(
        summary="List the project's board saved views",
        responses={200: BoardSavedViewSerializer(many=True)},
    ),
    post=extend_schema(
        summary="Create a named board saved view",
        request=BoardSavedViewSerializer,
        responses={201: BoardSavedViewSerializer},
    ),
)
class BoardSavedViewListView(IdempotencyMixin, APIView):
    """GET/POST per-project board saved view list.

    GET  returns all saved views for the project, ordered by name.
    POST creates a new named view; name must be unique per project.
    Read is open to any project member (Viewer+); creating a project-shared view
    requires Member+ (role >= Role.MEMBER) — a Viewer may use shared views but not
    add to the shared set (#820). IsProjectMemberWrite enforces this: it falls back
    to IsProjectMember on safe methods (GET) and requires Member+ on writes (POST).
    """

    permission_classes = [IsAuthenticated, IsProjectMemberWrite, IsProjectNotArchived]

    def get(self, request: Request, pk: str) -> Response:
        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)
        qs = BoardSavedView.objects.filter(project_id=pk).order_by("name")
        serializer = BoardSavedViewSerializer(qs, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def post(self, request: Request, pk: str) -> Response:
        from rest_framework.exceptions import ValidationError as DRFValidationError

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)
        serializer = BoardSavedViewSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                view = serializer.save(
                    project=project,
                    created_by=request.user,
                    server_version=1,
                    # Stamp the current schema version explicitly (mirrors
                    # server_version above) rather than relying on the model
                    # column's default — see BoardSavedView's docstring for why
                    # a version bump must not require a migration (#1918).
                    schema_version=current_version(SURFACE_BOARD_SAVED_VIEW),
                )
                view_id = str(view.id)
                project_id = str(pk)
                transaction.on_commit(
                    lambda: broadcast_board_event(project_id, "board_view_created", {"id": view_id})
                )
        except IntegrityError:
            raise DRFValidationError(
                {"name": "A saved view with this name already exists in this project."}
            ) from None
        return Response(
            BoardSavedViewSerializer(view).data,
            status=status.HTTP_201_CREATED,
        )


@extend_schema_view(
    patch=extend_schema(
        summary="Update a board saved view",
        request=BoardSavedViewSerializer,
        responses={200: BoardSavedViewSerializer},
    ),
)
class BoardSavedViewDetailView(IdempotencyMixin, APIView):
    """PATCH/DELETE a single board saved view.

    PATCH updates name and/or config. Only the creator or a Scheduler-role
    member (role ≥ 2) may modify a view.
    DELETE removes the view with the same role constraints.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def _get_view_or_403(self, request: Request, pk: str, view_pk: str) -> BoardSavedView:
        """Return the view, enforcing creator-or-Scheduler write permission."""
        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)
        saved_view = get_object_or_404(BoardSavedView, pk=view_pk, project_id=pk)
        # Allow creator or Scheduler+ to modify.
        from trueppm_api.apps.access.permissions import _membership_role

        raw_role = _membership_role(request, pk)
        role: int = raw_role if raw_role is not None else -1
        is_creator = saved_view.created_by_id == request.user.pk
        if not (is_creator or role >= Role.SCHEDULER):
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("Only the view creator or a Scheduler can modify this view.")
        return saved_view

    def patch(self, request: Request, pk: str, view_pk: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        saved_view = self._get_view_or_403(request, pk, view_pk)
        serializer = BoardSavedViewSerializer(saved_view, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        save_kwargs: dict[str, Any] = {"server_version": saved_view.server_version + 1}
        if "config" in request.data:
            # Only stamp schema_version when this PATCH actually rewrites
            # config: validate_config only ran (and only emitted the full
            # current-shape key set) because "config" was present. A name-only
            # rename leaves the stored config untouched, so bumping the version
            # column here would falsely claim a v1 payload is v2-shaped and the
            # migration chain would skip backfilling the newer keys on the next
            # read (#1918).
            save_kwargs["schema_version"] = current_version(SURFACE_BOARD_SAVED_VIEW)
        with transaction.atomic():
            saved_view = serializer.save(**save_kwargs)
            view_id = str(saved_view.id)
            project_id = str(pk)
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "board_view_updated", {"id": view_id})
            )
        return Response(BoardSavedViewSerializer(saved_view).data, status=status.HTTP_200_OK)

    def delete(self, request: Request, pk: str, view_pk: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        saved_view = self._get_view_or_403(request, pk, view_pk)
        view_id = str(saved_view.id)
        project_id = str(pk)
        with transaction.atomic():
            saved_view.delete()
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "board_view_deleted", {"id": view_id})
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Project overview endpoints (ADR-0030)
# ---------------------------------------------------------------------------


class ProjectOverviewView(McpReadableViewMixin, APIView):
    """Aggregated KPI snapshot for the single-project overview dashboard.

    Returns schedule health, late task count, critical task count, the next
    upcoming milestone, and team utilisation.  All values are computed from
    the current CPM output stored on Task rows — no additional DB schema is
    needed.

    Performance target: ≤ 200 ms at p95 for 500 tasks.  Implemented using
    a single annotated queryset per metric; no N+1 queries.

    Permission: Member (any role ≥ Viewer).
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Aggregated KPI snapshot for the single-project overview dashboard.",
                examples=[
                    OpenApiExample(
                        "overview",
                        value={
                            "schedule_health": "on_track",
                            "spi": 1.02,
                            "tasks_late_count": 2,
                            "critical_task_count": 7,
                            "total_tasks": 48,
                            "complete_tasks": 19,
                            "next_milestone": {"id": "…", "name": "Beta", "date": "2026-03-01"},
                            "team_utilization_pct": None,
                            "owner_name": "Sarah Chen",
                            "open_risk_count": 4,
                            "high_risk_count": 1,
                            "start_date": "2026-01-05",
                        },
                    ),
                ],
            ),
        },
    )
    def get(self, request: Request, pk: str) -> Response:
        """Return KPI data for the project overview page."""
        # is_deleted=False so a soft-deleted project 404s here as it does on
        # every other detail endpoint — without it the deleted-project URL keeps
        # resolving to an empty "zombie" overview shell (#1111).
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        today = timezone.localdate()
        active_statuses = [
            TaskStatus.BACKLOG,
            TaskStatus.NOT_STARTED,
            TaskStatus.IN_PROGRESS,
            TaskStatus.REVIEW,
            TaskStatus.ON_HOLD,  # legacy — included for rows not yet migrated
        ]

        # ── Task counts (single query) ──────────────────────────────────────
        counts = Task.objects.filter(project=project, is_deleted=False).aggregate(
            total=Count("id"),
            complete=Count("id", filter=db_models.Q(status=TaskStatus.COMPLETE)),
            critical=Count("id", filter=db_models.Q(is_critical=True)),
            # Late: CPM says it should be done but status is not complete
            late=Count(
                "id",
                filter=db_models.Q(early_finish__lt=today, status__in=active_statuses),
            ),
        )

        total: int = counts["total"] or 0
        complete: int = counts["complete"] or 0
        critical_count: int = counts["critical"] or 0
        tasks_late: int = counts["late"] or 0

        # ── Schedule health: SPI proxy ─────────────────────────────────────
        # SPI = BCWP / BCWS (can exceed 1.0 when ahead of schedule).
        #
        # BCWS denominator: tasks whose baseline finish is ≤ today — stable
        # across CPM reruns. Falls back to early_finish when no baseline exists.
        # BCWP numerator: tasks that are COMPLETE with actual_finish ≤ today
        # (or COMPLETE with no actual_finish recorded). Using actual_finish
        # rather than status alone prevents late completions from masquerading
        # as on-time. The 1.0 cap is intentionally absent — SPI > 1.0 is a
        # genuine ahead-of-schedule signal.
        active_baseline_for_spi = Baseline.objects.filter(
            project=project, is_active=True, is_deleted=False
        ).first()

        if active_baseline_for_spi is not None:
            planned_count = active_baseline_for_spi.tasks.filter(finish__lte=today).count()
            if planned_count > 0:
                # Count tasks complete by today; null actual_finish on a complete task counts.
                planned_complete: int = (
                    Task.objects.filter(
                        project=project, is_deleted=False, status=TaskStatus.COMPLETE
                    )
                    .filter(
                        db_models.Q(actual_finish__lte=today)
                        | db_models.Q(actual_finish__isnull=True)
                    )
                    .count()
                )
            else:
                planned_complete = 0
        else:
            # P17: No baseline — merge both SPI COUNT queries into one aggregate()
            # call so a single DB round-trip returns both the denominator (tasks
            # with early_finish ≤ today) and numerator (COMPLETE tasks).
            spi_agg = Task.objects.filter(project=project, is_deleted=False).aggregate(
                planned=Count("id", filter=db_models.Q(early_finish__lte=today)),
                planned_complete=Count(
                    "id",
                    filter=db_models.Q(status=TaskStatus.COMPLETE)
                    & (
                        db_models.Q(actual_finish__lte=today)
                        | db_models.Q(actual_finish__isnull=True)
                    ),
                ),
            )
            planned_count = spi_agg["planned"] or 0
            planned_complete = spi_agg["planned_complete"] or 0

        if planned_count > 0:
            spi = round(planned_complete / planned_count, 3)
            if spi >= 0.95:
                health = "on_track"
            elif spi >= 0.85:
                health = "at_risk"
            else:
                health = "critical"
        else:
            spi = None
            health = "unknown"

        # ── Next milestone ─────────────────────────────────────────────────
        next_milestone_qs = (
            Task.objects.filter(
                project=project,
                is_deleted=False,
                is_milestone=True,
                early_finish__gte=today,
            )
            .order_by("early_finish")
            .values("id", "name", "early_finish", "percent_complete")
            .first()
        )
        next_milestone = None
        if next_milestone_qs:
            early_finish: datetime.date | None = next_milestone_qs["early_finish"]
            next_milestone = {
                "id": str(next_milestone_qs["id"]),
                "name": next_milestone_qs["name"],
                "date": early_finish.isoformat() if early_finish else None,
                "percent_complete": next_milestone_qs["percent_complete"],
            }

        # ── Risk counts (open + high-severity band) ───────────────────────
        # Severity = probability * impact; high band ≥ 12 matches the
        # frontend "Open risks" KPI card. Both counts exclude resolved/closed.
        # P16: replaced Python-side aggregation (loads all risk rows into memory)
        # with a single DB aggregate() call. annotate+aggregate on the same
        # queryset lets Django produce one SQL SELECT with two conditional COUNTs.
        # probability and impact are non-nullable PositiveSmallIntegerField.
        _RISK_HIGH_THRESHOLD = 12
        risk_agg = (
            Risk.objects.filter(
                project=project,
                status__in=[RiskStatus.OPEN, RiskStatus.MITIGATING],
            )
            .annotate(
                severity=ExpressionWrapper(
                    F("probability") * F("impact"),
                    output_field=IntegerField(),
                )
            )
            .aggregate(
                open_risk_count=Count("id"),
                high_risk_count=Count("id", filter=db_models.Q(severity__gte=_RISK_HIGH_THRESHOLD)),
            )
        )
        open_risk_count = risk_agg["open_risk_count"] or 0
        high_risk_count = risk_agg["high_risk_count"] or 0

        # ── Project owner (first Owner-role member) ───────────────────────
        owner_membership = (
            ProjectMembership.objects.filter(project=project, role=Role.OWNER)
            .select_related("user")
            .first()
        )
        owner_name: str | None = None
        if owner_membership:
            u = owner_membership.user
            owner_name = u.get_full_name() or u.username

        return Response(
            {
                "schedule_health": health,
                "spi": spi,
                "tasks_late_count": tasks_late,
                "critical_task_count": critical_count,
                "total_tasks": total,
                "complete_tasks": complete,
                "next_milestone": next_milestone,
                # Populated by the resource utilisation module when it extends this endpoint.
                "team_utilization_pct": None,
                "owner_name": owner_name,
                "open_risk_count": open_risk_count,
                "high_risk_count": high_risk_count,
                "start_date": project.start_date.isoformat(),
            },
            status=status.HTTP_200_OK,
        )


class ProjectAttentionView(APIView):
    """Prioritised attention list for the project overview dashboard.

    Returns up to 10 items, ordered by severity (critical > warning > info).
    Items cover: critical-path tasks that are late, unassigned tasks starting
    within 7 days, and baseline drift (if an active baseline exists).

    Permission: Member (any role ≥ Viewer).
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    # Maximum items returned per severity bucket — keeps the panel scannable.
    _MAX_PER_BUCKET = 3

    @extend_schema(
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Prioritised attention list: {items: [{severity, type, task_id, "
                    "task_name, assignee_name, date, detail, link_target}]}. severity "
                    "is one of critical/warning/info; type is one of "
                    "critical_task_late, unassigned_approaching, baseline_drift, "
                    "overallocation."
                ),
                examples=[
                    OpenApiExample(
                        "attention",
                        value={
                            "items": [
                                {
                                    "severity": "critical",
                                    "type": "critical_task_late",
                                    "task_id": "…",
                                    "task_name": "Cutover",
                                    "assignee_name": "Priya N.",
                                    "date": "2026-02-10",
                                    "detail": "On critical path",
                                    "link_target": None,
                                }
                            ]
                        },
                    ),
                ],
            ),
        },
    )
    def get(self, request: Request, pk: str) -> Response:
        """Return attention items for the project overview page."""
        # is_deleted=False — same zombie-URL guard as the overview KPI endpoint (#1111).
        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        today = timezone.localdate()
        items: list[dict[str, Any]] = []

        # ── Critical-path tasks that are already late ──────────────────────
        critical_late = (
            Task.objects.filter(
                project=project,
                is_deleted=False,
                is_critical=True,
                early_finish__lt=today,
                status__in=[
                    TaskStatus.BACKLOG,
                    TaskStatus.NOT_STARTED,
                    TaskStatus.IN_PROGRESS,
                    TaskStatus.REVIEW,
                    TaskStatus.ON_HOLD,  # legacy
                ],
            )
            .select_related("assignee")
            .order_by("early_finish")[: self._MAX_PER_BUCKET]
        )
        for task in critical_late:
            items.append(
                {
                    "severity": "critical",
                    "type": "critical_task_late",
                    "task_id": str(task.id),
                    "task_name": task.name,
                    "assignee_name": (
                        task.assignee.get_full_name() or task.assignee.username
                        if task.assignee
                        else None
                    ),
                    "date": task.early_finish.isoformat() if task.early_finish else None,
                    "detail": "On critical path",
                    "link_target": None,
                }
            )

        # ── Unassigned tasks starting within 7 days ────────────────────────
        soon = today + datetime.timedelta(days=7)
        unassigned_soon = Task.objects.filter(
            project=project,
            is_deleted=False,
            assignee__isnull=True,
            early_start__range=(today, soon),
            status=TaskStatus.NOT_STARTED,
        ).order_by("early_start")[: self._MAX_PER_BUCKET]
        for task in unassigned_soon:
            items.append(
                {
                    "severity": "warning",
                    "type": "unassigned_approaching",
                    "task_id": str(task.id),
                    "task_name": task.name,
                    "assignee_name": None,
                    "date": task.early_start.isoformat() if task.early_start else None,
                    "detail": "Unassigned — starts soon",
                    "link_target": None,
                }
            )

        # ── Baseline drift: tasks that have slipped vs the active baseline ─
        try:
            active_baseline = project.baselines.filter(is_deleted=False).get(is_active=True)
        except Exception:
            active_baseline = None

        if active_baseline:
            # Tasks where CPM early_finish is later than the baseline snapshot finish.
            # BaselineTask.finish mirrors Task.early_finish at snapshot time (field is
            # named "finish", not "early_finish" — see BaselineTask model).
            drift_items = (
                Task.objects.filter(
                    project=project,
                    is_deleted=False,
                    is_critical=True,
                    early_finish__isnull=False,
                )
                .annotate(
                    baseline_finish=Subquery(
                        active_baseline.tasks.filter(task_id=OuterRef("pk")).values("finish")[:1]
                    )
                )
                .filter(
                    baseline_finish__isnull=False,
                    early_finish__gt=db_models.F("baseline_finish"),
                )
                .order_by((db_models.F("early_finish") - db_models.F("baseline_finish")).desc())[
                    : self._MAX_PER_BUCKET
                ]
            )
            for task in drift_items:
                baseline_finish = getattr(task, "baseline_finish", None)
                if baseline_finish and task.early_finish:
                    drift_days = (task.early_finish - baseline_finish).days
                    items.append(
                        {
                            "severity": "info",
                            "type": "baseline_drift",
                            "task_id": str(task.id),
                            "task_name": task.name,
                            "assignee_name": None,
                            "date": task.early_finish.isoformat(),
                            "detail": f"Slipped +{drift_days}d vs baseline",
                            "link_target": None,
                        }
                    )

        # ── Over-allocated resources ───────────────────────────────────────
        from trueppm_api.apps.resources.models import Resource, TaskResource

        overalloc_rows = cast(
            "list[dict[str, Any]]",
            (
                TaskResource.objects.filter(
                    task__project=project,
                    task__is_deleted=False,
                )
                .exclude(task__status=TaskStatus.COMPLETE)
                .values("resource_id")
                .annotate(total=Sum("units"))
                .filter(total__gt=db_models.F("resource__max_units"))
            )[: self._MAX_PER_BUCKET],
        )

        if overalloc_rows:
            resource_ids = [r["resource_id"] for r in overalloc_rows]
            resource_map = {str(r.pk): r for r in Resource.objects.filter(pk__in=resource_ids)}
            for row in overalloc_rows:
                res = resource_map.get(str(row["resource_id"]))
                resource_name = res.name if res else str(row["resource_id"])
                items.append(
                    {
                        "severity": "warning",
                        "type": "overallocation",
                        "task_id": None,
                        "task_name": resource_name,
                        "assignee_name": None,
                        "date": None,
                        "detail": f"Allocated {row['total']:.0%} — over capacity",
                        "link_target": None,
                    }
                )

        return Response({"items": items}, status=status.HTTP_200_OK)


class ProjectMyTasksView(APIView):
    """Tasks assigned to the requesting user that are due in the current calendar week.

    "Current week" is Monday–Sunday of the week containing today (UTC).  Only
    non-complete tasks are returned; tasks are ordered by ``early_finish`` ascending
    so the most urgent appears first.

    Permission: Member (any role ≥ Viewer) — a user can only see their own tasks.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "This week's tasks assigned to the requesting user: "
                    "{tasks: [{id, name, due, status, percent_complete, is_critical, "
                    "owner_name, owner_initials}]}."
                ),
                examples=[
                    OpenApiExample(
                        "my-tasks",
                        value={
                            "tasks": [
                                {
                                    "id": "…",
                                    "name": "Write migration",
                                    "due": "2026-02-12",
                                    "status": "IN_PROGRESS",
                                    "percent_complete": 40,
                                    "is_critical": False,
                                    "owner_name": "Priya N.",
                                    "owner_initials": "PN",
                                }
                            ]
                        },
                    ),
                ],
            ),
        },
    )
    def get(self, request: Request, pk: str) -> Response:
        """Return this week's tasks for the requesting user."""
        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)

        today = timezone.localdate()
        # ISO week: Monday = 0
        week_start = today - datetime.timedelta(days=today.weekday())
        week_end = week_start + datetime.timedelta(days=6)

        tasks = (
            Task.objects.filter(
                project=project,
                is_deleted=False,
                assignee_id=request.user.pk,
                early_finish__range=(week_start, week_end),
            )
            .exclude(status=TaskStatus.COMPLETE)
            .order_by("early_finish")
        )

        # Owner display data — by definition the requesting user (assignee==self)
        # but the frontend's row layout expects the avatar/name fields, so emit
        # them here once rather than have the client re-derive from /auth/me.
        # IsAuthenticated permission guarantees request.user is a real user, not
        # an AnonymousUser; cast for mypy's benefit since DRF's request.user
        # union type still includes AnonymousUser at the type level.
        from django.contrib.auth.models import AbstractBaseUser

        u = cast(AbstractBaseUser, request.user)
        first_name = getattr(u, "first_name", "") or ""
        last_name = getattr(u, "last_name", "") or ""
        username = getattr(u, "username", "") or ""
        full_name = f"{first_name} {last_name}".strip()
        owner_name = full_name or username
        first_initial = first_name[0].upper() if first_name else ""
        last_initial = last_name[0].upper() if last_name else ""
        owner_initials = (first_initial + last_initial) or username[:2].upper()

        return Response(
            {
                "tasks": [
                    {
                        "id": str(t.id),
                        "name": t.name,
                        "due": t.early_finish.isoformat() if t.early_finish else None,
                        "status": t.status,
                        "percent_complete": t.percent_complete,
                        "is_critical": t.is_critical,
                        "owner_name": owner_name,
                        "owner_initials": owner_initials,
                    }
                    for t in tasks
                ]
            },
            status=status.HTTP_200_OK,
        )


# ---------------------------------------------------------------------------
# Task detail drawer — history and baseline endpoints (ADR-0032)
# ---------------------------------------------------------------------------

# Fields excluded from the user-facing history diff (ADR-0096 Part 1).
#
# CPM outputs and sync internals are already absent from the historical model
# (``_HISTORY_EXCLUDED_TASK``). This set drops the few remaining low-signal
# bookkeeping columns from the *display* diff; everything else that is tracked is
# surfaced (allow-by-exclusion). The previous 11-field opt-in allow-list left every
# edit to a tracked-but-unlisted field — a WBS reorder (``wbs_path``, the highest-
# frequency case), reassignment, sprint move, story-point or priority change —
# rendering a bare "Updated" pill with no diff rows. Allow-by-exclusion fixes that
# and surfaces newly-tracked fields automatically rather than silently dropping them.
_HISTORY_DIFF_DISPLAY_EXCLUDED = frozenset(
    {
        # blocked_reason is contributor-private (the "Morgan surveillance boundary"):
        # the task serializer read-gates it to the assignee + @-mentioned users via
        # can_read_blocker_reason(). The history endpoint is Viewer+ for every member,
        # so surfacing the reason's old/new text here would bypass that gate — exclude
        # it. The structured blocker_type signal (visible to all members) is kept.
        "blocked_reason",
        "is_deleted",  # deletion is conveyed by history_type, not a diff row
        "short_id",  # immutable, system-assigned identifier
        "status_changed_at",  # derived bookkeeping timestamp
        "blocked_since",  # derived bookkeeping timestamp
        "sprint_pending",  # transient ADR-0102 scope-injection flag
        # sprint-backlog reorder bookkeeping: drag-reorder rewrites the team's
        # within-sprint sequence on every affected sibling, so surfacing it would
        # flood the timeline with integer noise — mirrors the other rank/bookkeeping
        # exclusions (#1885). Deliberate ordering signals (priority_rank) stay visible.
        "sprint_rank",
        "parent_governance_inherited",  # internal inheritance bookkeeping
        "recurrence_occurrence_date",  # system-set during recurrence expansion
        "recurrence_rule",  # FK to the rule object; recurrence shown via is_recurring
    }
)


@functools.lru_cache(maxsize=1)
def _history_diff_fields() -> tuple[Any, ...]:
    """Concrete ``Task`` fields surfaced in the history diff (allow-by-exclusion).

    Every tracked, non-PK field except the project link and the low-signal
    bookkeeping columns in ``_HISTORY_DIFF_DISPLAY_EXCLUDED``. CPM/sync fields are
    already absent from the historical model (``_HISTORY_EXCLUDED_TASK``). Cached:
    the model field set is static for the process lifetime.
    """
    return tuple(
        field
        for field in Task._meta.concrete_fields
        if not field.primary_key
        and field.name != "project"
        and field.name not in _HISTORY_DIFF_DISPLAY_EXCLUDED
        and field.name not in _HISTORY_EXCLUDED_TASK
    )


def _history_fk_label(obj: Any) -> str:
    """Human-readable label for a related object referenced in a diff value."""
    get_full_name = getattr(obj, "get_full_name", None)
    if callable(get_full_name):
        # User: prefer the full name, fall back to the username.
        return str(get_full_name() or obj.get_username())
    return str(getattr(obj, "name", None) or obj)


# P18: cap the in-memory history load for a single task. Loading the full history
# for a long-running task (potentially thousands of edits) would OOM the worker on
# page-1 requests.
#
# NOTE(#1889): this cap intentionally differs from the history app's
# ``apps.history.views._MAX_HISTORY_ROWS`` (5000). This view backs the wired
# ``/projects/<pk>/tasks/<pk>/history/`` route (the history app's
# ``TaskHistoryListView`` is deliberately unwired — see ``apps/history/urls.py``)
# and serves the task drawer, so it uses the tighter per-task bound. Do not "sync"
# the two numbers; cross-reference comments live at both constants.
_MAX_HISTORY_ROWS = 2000

# Opt-in activity sources for the ``?include=`` query param on TaskHistoryView
# (issue 413). Absent/empty ``include`` keeps the response byte-identical to the
# legacy field-diff feed, so existing consumers are untouched (backward compat).
# Each token maps to a per-task event stream merged into the unified feed. The
# ``schedule``, ``risks``, and ``resources`` tokens (ADR-0207/ADR-0394) are backed by
# ``TaskActivityEvent``: ``schedule`` surfaces ``cpm_recalculated`` and
# ``baseline_drift_detected`` (system events, null actor); ``risks`` surfaces
# ``risk_linked`` / ``risk_unlinked``; ``resources`` surfaces ``assignee_added`` /
# ``assignee_removed`` / ``assignee_units_changed`` (actor is the acting member).
# The ``dependencies`` token (ADR-0394, #1887) reads ``HistoricalDependency`` for edges
# touching the task and synthesizes ``dependency_added`` / ``dependency_removed`` from
# the create row and the ``is_deleted`` soft-delete transition. ``time_log_edited``
# remains deliberately absent rather than faked until its source lands.
_ACTIVITY_SOURCES = frozenset(
    {"comments", "time", "attachments", "schedule", "risks", "dependencies", "resources"}
)

# Max characters of a comment body surfaced as a timeline preview. The full body
# is already readable by any project member via the comments thread endpoint, so
# a truncated preview is not a new disclosure — but keep it short so the activity
# payload stays light and never doubles as a bulk comment export.
_ACTIVITY_COMMENT_PREVIEW_CHARS = 140


def _activity_actor(user: Any | None) -> dict[str, Any] | None:
    """Serialize the actor of an activity event, or ``None`` for system events.

    Returns ``{"id", "display_name"}`` so every event type carries a consistent
    actor shape. ``None`` is the contract for system-generated events (issue 413
    acceptance criterion: actor is null when there is no human author) and for
    rows whose author FK was ``SET_NULL`` after an account deletion.
    """
    if user is None:
        return None
    full = (user.get_full_name() or "").strip()
    return {"id": str(user.pk), "display_name": full or user.get_username()}


# DB-fetch bound for the dependency stream. Transition detection needs each edge's
# recent timeline, so we fetch a small multiple of the per-source cap newest-first and
# process in memory (a task's edge-history count is small in practice). The bound keeps
# the query from ever being an unbounded scan.
def _dependency_activity_events(
    task: Any,
    request: Request,
    cap: int,
    until: datetime.datetime | None = None,
) -> tuple[list[tuple[Any, dict[str, Any]]], bool]:
    """Dependency add/remove events for edges touching ``task`` (ADR-0394, #1887).

    Reads ``HistoricalDependency`` (Dependency IS history-tracked, so no new table) for
    edges where the task is the predecessor or the successor, and synthesizes:

    * ``dependency_added`` — from each ``+`` create row, and from a ``~`` row whose
      ``is_deleted`` transitions ``True → False`` (restore);
    * ``dependency_removed`` — from a ``~`` row whose ``is_deleted`` transitions
      ``False → True`` (``Dependency.soft_delete()`` writes a ``~`` row, never a ``-``).

    Plain field edits (lag, acceptance) produce no event. Transition detection compares
    each row to the immediately-older row of the *same* edge; at the fetch-window
    boundary the prior state is unknown, so such a row is recorded as state without
    emitting — under-reporting at the truncation edge rather than emitting a false event.

    **Cross-project guard (ADR-0120):** an edge's far endpoint can live in a project the
    caller is not a member of, and this endpoint only authorized the current task's
    project. The far task's name is rendered only when the caller can access its project;
    otherwise ``other_task_name`` is null (direction + dep_type still shown), closing the
    cross-project title-leak vector.
    """
    from django.db.models import Q

    historical_model = Dependency.history.model
    qs = historical_model.objects.filter(
        Q(predecessor_id=task.pk) | Q(successor_id=task.pk)
    ).select_related("history_user")
    if until is not None:
        qs = qs.filter(history_date__lt=until)
    # Newest-first, bounded. cap*3+1 gives headroom for add/edit/remove per edge while
    # never scanning unboundedly; +1 lets us detect that the window itself was truncated.
    fetch_cap = cap * 3 + 1
    rows = list(qs.order_by("-history_date")[:fetch_cap])
    window_truncated = len(rows) > cap * 3
    if not rows:
        return [], False

    # Group by edge id and walk each edge's timeline oldest-first to detect transitions.
    by_edge: dict[Any, list[Any]] = {}
    for row in rows:
        by_edge.setdefault(row.id, []).append(row)

    # Resolve far-endpoint task labels in one batched query, gated by caller access.
    other_task_ids = {
        (row.successor_id if row.predecessor_id == task.pk else row.predecessor_id) for row in rows
    }
    other_task_ids.discard(None)
    other_tasks = {
        t.pk: t for t in Task.objects.filter(pk__in=other_task_ids).only("id", "name", "project_id")
    }
    # Projects the caller may see the far task's name in: the current project is already
    # authorized; add any other project the caller is a member of.
    far_project_ids = {t.project_id for t in other_tasks.values()} - {task.project_id}
    accessible_projects = {task.project_id}
    if far_project_ids:
        accessible_projects |= set(
            ProjectMembership.objects.filter(
                user=request.user,  # type: ignore[misc]
                project_id__in=far_project_ids,
                # Revoked memberships are soft-deleted (access/views.py soft_delete),
                # so exclude them — a removed member must not regain the far task's
                # name. Matches the M1 contract in access.permissions._membership_role.
                is_deleted=False,
            ).values_list("project_id", flat=True)
        )

    def _label(other_id: Any) -> str | None:
        other = other_tasks.get(other_id)
        if other is None or other.project_id not in accessible_projects:
            return None
        return other.name

    candidates: list[tuple[Any, dict[str, Any]]] = []
    for edge_rows in by_edge.values():
        edge_rows.sort(key=lambda r: r.history_date)
        prev_deleted: bool | None = None
        for row in edge_rows:
            event_type: str | None = None
            if row.history_type == "+":
                event_type = "dependency_added"
            elif row.history_type == "~" and prev_deleted is not None:
                if row.is_deleted and not prev_deleted:
                    event_type = "dependency_removed"
                elif not row.is_deleted and prev_deleted:
                    event_type = "dependency_added"
            prev_deleted = row.is_deleted
            if event_type is None:
                continue
            if row.predecessor_id == task.pk:
                # This task is the predecessor → the OTHER task is downstream.
                other_id, direction = row.successor_id, "successor"
            else:
                other_id, direction = row.predecessor_id, "predecessor"
            candidates.append(
                (
                    row.history_date,
                    {
                        "event_type": event_type,
                        "actor": _activity_actor(row.history_user),
                        "timestamp": row.history_date.isoformat(),
                        "detail": {
                            "dependency_id": str(row.id),
                            "dep_type": row.dep_type,
                            "lag": row.lag,
                            # Role of the OTHER task relative to this one:
                            # "predecessor" = upstream (this task depends on it),
                            # "successor" = downstream (depends on this task).
                            "direction": direction,
                            "other_task_id": str(other_id) if other_id else None,
                            "other_task_name": _label(other_id),
                        },
                    },
                )
            )

    candidates.sort(key=lambda pair: pair[0], reverse=True)
    truncated = window_truncated or len(candidates) > cap
    return candidates[:cap], truncated


def _build_activity_events(
    task: Any,
    include: frozenset[str],
    request: Request,
    cap: int,
    until: datetime.datetime | None = None,
) -> tuple[list[tuple[Any, dict[str, Any]]], bool]:
    """Build the opt-in activity streams merged into the task history feed.

    Returns ``(events, truncated)`` where each event is ``(timestamp_dt, payload)``
    and ``payload`` is the unified ``{event_type, actor, timestamp, detail}`` shape.
    ``truncated`` is true when any source hit ``cap`` (so the caller can OR it into
    ``count_truncated``). Each source is independently bounded and uses
    ``select_related`` on its actor FK to avoid an N+1 over the stream.

    ``until`` (keyset paging, #1882) bounds every source to events strictly older
    than the cursor: the bound is pushed into each source's ``created_at`` DB filter
    so deep pages never rescan the newest rows, then re-applied in memory to the
    derived ``edited_at``/``deleted_at`` events (whose parent row's ``created_at``
    passed the DB filter but whose own timestamp may not).
    """
    from trueppm_api.apps.timetracking.models import TimeEntry

    # Keyset bound: strictly-older-than on the source row's created_at.
    created_before = {"created_at__lt": until} if until is not None else {}

    events: list[tuple[Any, dict[str, Any]]] = []
    truncated = False

    if "comments" in include:
        # Fetch cap+1 to detect truncation. Newest-first so a truncated batch keeps
        # the most recent comments. deleted_by joined for the comment_deleted actor.
        comments = list(
            task.comments.filter(**created_before)
            .select_related("author", "deleted_by")
            .order_by("-created_at")[: cap + 1]
        )
        truncated = truncated or len(comments) > cap
        for c in comments[:cap]:
            # Deleted comments contribute only the add + delete events with no
            # preview — the body is gone from the thread, so don't resurface it.
            preview = "" if c.is_deleted else c.body[:_ACTIVITY_COMMENT_PREVIEW_CHARS]
            events.append(
                (
                    c.created_at,
                    {
                        "event_type": "comment_added",
                        "actor": _activity_actor(c.author),
                        "timestamp": c.created_at.isoformat(),
                        "detail": {
                            "comment_id": str(c.id),
                            "parent_id": str(c.parent_id) if c.parent_id else None,
                            "preview": preview,
                        },
                    },
                )
            )
            if c.edited_at is not None and not c.is_deleted:
                events.append(
                    (
                        c.edited_at,
                        {
                            "event_type": "comment_edited",
                            "actor": _activity_actor(c.author),
                            "timestamp": c.edited_at.isoformat(),
                            "detail": {"comment_id": str(c.id), "preview": preview},
                        },
                    )
                )
            if c.is_deleted and c.deleted_at is not None:
                events.append(
                    (
                        c.deleted_at,
                        {
                            "event_type": "comment_deleted",
                            "actor": _activity_actor(c.deleted_by),
                            "timestamp": c.deleted_at.isoformat(),
                            "detail": {"comment_id": str(c.id)},
                        },
                    )
                )

    if "time" in include:
        # Time entries are private to the logging user: TaskTimeEntryView filters
        # ``user=request.user`` and never exposes another member's hours/notes. The
        # shared activity feed MUST NOT widen that boundary, so scope to the
        # caller's own entries (security-review: no cross-user time disclosure).
        #
        # Soft-deleted entries are deliberately INCLUDED (no ``is_deleted`` filter,
        # issue #1888): a deleted entry keeps its ``time_logged`` event and gains a
        # synthesized ``time_deleted`` from ``deleted_at`` so revised/removed hours
        # leave a trace — an EVM/billing integrity requirement — mirroring the
        # attachments stream (#1879) below.
        entries = list(
            TimeEntry.objects.select_related("deleted_by")
            .filter(
                task=task,
                user=request.user,  # type: ignore[misc]
                **created_before,
            )
            .order_by("-created_at")[: cap + 1]
        )
        truncated = truncated or len(entries) > cap
        actor = _activity_actor(request.user)
        for e in entries[:cap]:
            events.append(
                (
                    e.created_at,
                    {
                        "event_type": "time_logged",
                        "actor": actor,
                        "timestamp": e.created_at.isoformat(),
                        "detail": {
                            "time_entry_id": str(e.id),
                            "minutes": e.minutes,
                            "entry_date": e.entry_date.isoformat(),
                            "note": e.note,
                            "source": e.source,
                        },
                    },
                )
            )
            # Rows deleted before deleted_at was stamped (legacy null) contribute
            # only their retained log event — no timestamp to anchor a delete. The
            # note is omitted from the delete event: the entry is gone, so don't
            # resurface its body (same reasoning as the deleted-comment preview).
            if e.is_deleted and e.deleted_at is not None:
                events.append(
                    (
                        e.deleted_at,
                        {
                            "event_type": "time_deleted",
                            "actor": _activity_actor(e.deleted_by),
                            "timestamp": e.deleted_at.isoformat(),
                            "detail": {
                                "time_entry_id": str(e.id),
                                "minutes": e.minutes,
                                "entry_date": e.entry_date.isoformat(),
                            },
                        },
                    )
                )

    if "attachments" in include:
        # Append-only feed (#1879): soft-deleted attachments keep their upload
        # event (the label is non-sensitive metadata, mirroring the comments
        # stream above) and gain an attachment_deleted event from deleted_at.
        attachments = list(
            task.attachments.filter(**created_before)
            .select_related("uploaded_by", "deleted_by")
            .order_by("-created_at")[: cap + 1]
        )
        truncated = truncated or len(attachments) > cap
        for a in attachments[:cap]:
            is_url = bool(a.external_url)
            detail = {
                "attachment_id": str(a.id),
                "kind": "url" if is_url else "file",
                "label": a.external_title if is_url else a.file_name,
            }
            events.append(
                (
                    a.created_at,
                    {
                        "event_type": "attachment_uploaded",
                        "actor": _activity_actor(a.uploaded_by),
                        "timestamp": a.created_at.isoformat(),
                        "detail": detail,
                    },
                )
            )
            # Rows deleted before deleted_at was stamped (legacy null) contribute
            # only their retained upload event — no timestamp to anchor a delete.
            if a.is_deleted and a.deleted_at is not None:
                events.append(
                    (
                        a.deleted_at,
                        {
                            "event_type": "attachment_deleted",
                            "actor": _activity_actor(a.deleted_by),
                            "timestamp": a.deleted_at.isoformat(),
                            "detail": dict(detail),
                        },
                    )
                )

    # schedule + risks share the TaskActivityEvent source (ADR-0207); each token
    # selects its own event_type subset so the per-source cap semantics match the
    # other streams. detail is stored verbatim on the row (CPM date deltas cannot
    # be reconstructed at read time), so it is surfaced as-is. actor is null for
    # the system events (cpm_recalculated, baseline_drift_detected).
    if "schedule" in include:
        rows = list(
            task.activity_events.select_related("actor")
            .filter(
                event_type__in=["cpm_recalculated", "baseline_drift_detected"], **created_before
            )
            .order_by("-created_at")[: cap + 1]
        )
        truncated = truncated or len(rows) > cap
        for ev in rows[:cap]:
            events.append(
                (
                    ev.created_at,
                    {
                        "event_type": ev.event_type,
                        "actor": _activity_actor(ev.actor),
                        "timestamp": ev.created_at.isoformat(),
                        "detail": ev.detail,
                    },
                )
            )

    if "risks" in include:
        rows = list(
            task.activity_events.select_related("actor")
            .filter(event_type__in=["risk_linked", "risk_unlinked"], **created_before)
            .order_by("-created_at")[: cap + 1]
        )
        truncated = truncated or len(rows) > cap
        for ev in rows[:cap]:
            events.append(
                (
                    ev.created_at,
                    {
                        "event_type": ev.event_type,
                        "actor": _activity_actor(ev.actor),
                        "timestamp": ev.created_at.isoformat(),
                        "detail": ev.detail,
                    },
                )
            )

    # resources: assignment add/remove/re-allocation, also backed by TaskActivityEvent
    # (TaskResource is a through-table with no history; ADR-0394, #1886). detail is
    # stored verbatim ({resource_id, resource_name, units}) and surfaced as-is.
    if "resources" in include:
        rows = list(
            task.activity_events.select_related("actor")
            .filter(
                event_type__in=[
                    "assignee_added",
                    "assignee_removed",
                    "assignee_units_changed",
                ],
                **created_before,
            )
            .order_by("-created_at")[: cap + 1]
        )
        truncated = truncated or len(rows) > cap
        for ev in rows[:cap]:
            events.append(
                (
                    ev.created_at,
                    {
                        "event_type": ev.event_type,
                        "actor": _activity_actor(ev.actor),
                        "timestamp": ev.created_at.isoformat(),
                        "detail": ev.detail,
                    },
                )
            )

    if "dependencies" in include:
        dep_events, dep_truncated = _dependency_activity_events(task, request, cap, until)
        events.extend(dep_events)
        truncated = truncated or dep_truncated

    if until is not None:
        # The DB filter above bounds created_at only; a comment/attachment created
        # before the cursor can still carry a derived edited_at/deleted_at event at
        # or after it. Re-apply the strict bound on the derived event timestamps.
        events = [pair for pair in events if pair[0] < until]

    return events, truncated


@extend_schema_view(
    get=extend_schema(
        summary="Paginated field-level diff history for a task",
        parameters=[
            OpenApiParameter(
                name="include",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Comma-separated opt-in activity sources to merge into the feed "
                    "(issue 413). Valid tokens: "
                    # Interpolated from _ACTIVITY_SOURCES so the docs cannot drift
                    # from the tokens the view actually accepts (#1884) — this is the
                    # same source of truth the 400 error message is built from.
                    f"{', '.join(f'`{tok}`' for tok in sorted(_ACTIVITY_SOURCES))}, or "
                    "`all`. When omitted the response is the legacy field-diff feed, "
                    "byte-identical to prior releases (backward compatible). When "
                    "present, `results` becomes a timestamp-desc merged feed where "
                    "every entry carries the unified `{event_type, actor, timestamp, "
                    "detail}` shape (field-diff entries also retain their legacy "
                    "`{id, history_date, history_type, history_user, "
                    "history_user_display, diff}` keys). "
                    "`time` is scoped to the requesting user's own entries."
                ),
            ),
            OpenApiParameter(
                name="until",
                type=OpenApiTypes.DATETIME,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Keyset cursor for the merged feed (#1882); only valid together "
                    "with `include` (400 otherwise). Returns events **strictly older "
                    "than** this ISO-8601 datetime and switches the response to the "
                    "keyset envelope `{results, next_until, count_truncated}` — no "
                    "`count`/`next`/`previous`, and `page` is ignored. `next_until` "
                    "is the oldest returned timestamp (pass it back as `until` to "
                    "fetch the next page), or null when no events older than the "
                    "cursor remain. Cursoring is on the timestamp alone: events "
                    "sharing the exact boundary timestamp can repeat or be skipped "
                    "across pages (the documented ADR-0160 keyset tradeoff). When "
                    "`until` is omitted but `include` is present, the offset "
                    "envelope additionally carries `next_until` computed from the "
                    "returned page, so a client can resume via keyset without "
                    "offset paging."
                ),
            ),
            OpenApiParameter(
                name="page_size",
                type=OpenApiTypes.INT,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Page size for the merged feed (default 20, clamped to 1..100); "
                    "only valid together with `include` (400 otherwise). Applies in "
                    "both offset mode and `until` keyset mode."
                ),
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Page-number-paginated envelope `{count, next, previous, "
                    "results, count_truncated}`. Without `include`, each `results` "
                    "entry is `{id, history_date, history_type, history_user, "
                    "history_user_display, diff}`, where `diff` is a list of "
                    "`{field, old, new}` changes, `history_user` is the author's "
                    "username, and `history_user_display` is their full name "
                    "(username fallback; both null for programmatic writes). With "
                    "`include` "
                    f"({', '.join(f'`{tok}`' for tok in sorted(_ACTIVITY_SOURCES))}), "
                    "each entry additionally carries `{event_type, actor, timestamp, "
                    "detail}`; field-diff entries emit `task_created`, "
                    "`fields_changed`, or `task_deleted`, and non-diff events "
                    "(`comment_added`, `comment_edited`, `comment_deleted`, "
                    "`time_logged`, `time_deleted`, `attachment_uploaded`, "
                    "`attachment_deleted`, "
                    "`cpm_recalculated`, `baseline_drift_detected`, `risk_linked`, "
                    "`risk_unlinked`, `dependency_added`, `dependency_removed`, "
                    "`assignee_added`, `assignee_removed`, `assignee_units_changed`) "
                    "carry only that unified shape, with `actor` null for "
                    "system/authorless events. `count_truncated` is true when any "
                    "source exceeded the row cap and only the most recent events "
                    "are returned."
                ),
            )
        },
    )
)
class TaskHistoryView(APIView):
    """Paginated field-level diff history for a single task.

    Returns HistoricalTask records in descending date order, each with a diff
    list comparing it to the immediately preceding version (allow-by-exclusion;
    ADR-0096 Part 1). The creation record (history_type ``+``) has an empty diff
    — no previous version to compare. Change records (``~``) whose every changed
    field is display-excluded are dropped, so the endpoint never emits a bare
    "Updated" pill with no diff rows.

    Accessible to all project members (Viewer+). history_user is the username of
    the user who made the change; history_user_display is their full name with a
    username fallback (both null for programmatic writes). FK values
    (assignee, sprint, …) are resolved to human-readable labels via a single
    batched query per related model (no N+1 over the history).
    """

    # IsProjectNotArchived is deliberately omitted: history/activity is a read-only
    # audit surface that must stay accessible after a project is archived. (It was
    # also a no-op here — the permission passes all SAFE_METHODS and this view is
    # GET-only — so listing it only misdocumented the RBAC contract; #1890.)
    permission_classes = [IsAuthenticated, IsProjectMember]

    def get(self, request: Request, project_pk: str, task_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        if not IsProjectMember().has_object_permission(request, self, project):
            return Response({"detail": "Permission denied."}, status=status.HTTP_403_FORBIDDEN)

        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)

        # Opt-in activity sources (issue 413). Absent => legacy field-diff feed,
        # byte-identical to prior releases. ``all`` expands to every known source.
        include_raw = request.query_params.get("include", "").strip()
        if include_raw:
            requested = {tok.strip() for tok in include_raw.split(",") if tok.strip()}
            if "all" in requested:
                requested = set(_ACTIVITY_SOURCES)
            invalid = requested - _ACTIVITY_SOURCES
            if invalid:
                return Response(
                    {
                        "detail": (
                            f"Invalid include value(s): {', '.join(sorted(invalid))}. "
                            f"Choose from: {', '.join(sorted(_ACTIVITY_SOURCES))}, all."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            include = frozenset(requested)
        else:
            include = frozenset()

        # Keyset paging for the merged feed (#1882, board_activity/ADR-0160
        # precedent): `until` returns events strictly older than the cursor, so deep
        # pages neither drift when new events arrive nor rescan the newest rows.
        # Both params are meaningless on the bare field-diff feed — which must stay
        # byte-identical for existing consumers — so reject them without `include`.
        until_raw = request.query_params.get("until")
        page_size_raw = request.query_params.get("page_size")
        if (until_raw is not None or page_size_raw is not None) and not include:
            return Response(
                {"detail": "until and page_size are only valid together with include=."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        until: datetime.datetime | None = None
        if until_raw is not None:
            from django.utils.dateparse import parse_datetime

            try:
                # parse_datetime returns None on a malformed string, but RAISES
                # ValueError on a well-formed-but-out-of-range one (e.g. month 13) —
                # both are the caller's error, so both get the same 400.
                until = parse_datetime(until_raw)
            except ValueError:
                until = None
            if until is None:
                return Response(
                    {"detail": f"Invalid until datetime '{until_raw}' (expected ISO 8601)."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if timezone.is_naive(until):
                until = timezone.make_aware(until, timezone.get_current_timezone())
        page_size = 20
        if page_size_raw is not None:
            try:
                page_size = int(page_size_raw)
            except (TypeError, ValueError):
                return Response(
                    {"detail": "page_size must be an integer."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            page_size = max(1, min(page_size, 100))

        # The paginator slices from this list; count_truncated in the response signals
        # to the client that older records are not included. Fetch one past the cap so
        # an exactly-cap history is not falsely reported as truncated.
        history_qs = task.history.order_by("-history_date").select_related("history_user")
        if until is not None:
            # Push the keyset bound into the DB (strictly older than the cursor) so
            # a deep page never re-reads the newest rows.
            history_qs = history_qs.filter(history_date__lt=until)
        records = list(history_qs[: _MAX_HISTORY_ROWS + 1])
        count_truncated: bool = len(records) > _MAX_HISTORY_ROWS
        # When truncated, keep the one-past-the-cap row PURELY as a diff seed for the
        # oldest kept record (#1889). Without it that record has no older row to
        # compare against, yields an empty diff, and is silently dropped by the
        # bare-"Updated" filter below — the change at the cap boundary vanishes from
        # the feed. The seed row is never rendered and never counted.
        diff_seed = records[_MAX_HISTORY_ROWS] if count_truncated else None
        records = records[:_MAX_HISTORY_ROWS]
        diff_fields = _history_diff_fields()

        # Pass 1: compute raw per-record changes, collecting FK ids to resolve in a
        # single batched query per related model (avoids an N+1 over the history).
        fk_ids: dict[str, set[Any]] = {}
        raw_changes: list[list[tuple[Any, Any, Any]]] = []
        for i, record in enumerate(records):
            older = records[i + 1] if i + 1 < len(records) else diff_seed
            changes: list[tuple[Any, Any, Any]] = []
            if older is not None:
                for field in diff_fields:
                    new_val = getattr(record, field.attname, None)
                    old_val = getattr(older, field.attname, None)
                    if new_val != old_val:
                        changes.append((field, old_val, new_val))
                        if field.is_relation:
                            bucket = fk_ids.setdefault(field.name, set())
                            if old_val is not None:
                                bucket.add(old_val)
                            if new_val is not None:
                                bucket.add(new_val)
            raw_changes.append(changes)

        # Batch-resolve FK ids to human-readable labels: {field_name: {pk: label}}.
        fields_by_name = {field.name: field for field in diff_fields}
        fk_labels: dict[str, dict[Any, str]] = {}
        for field_name, ids in fk_ids.items():
            related_model = fields_by_name[field_name].related_model
            fk_labels[field_name] = {
                obj.pk: _history_fk_label(obj)
                for obj in related_model._default_manager.filter(pk__in=ids)
            }

        # Pass 2: render the response, dropping change records whose entire diff
        # was display-excluded (the bare-"Updated"-pill case). Creation (+) and
        # deletion (-) records are always kept.
        #
        # ``result`` is the legacy field-diff list (byte-identical when ``include``
        # is empty). ``merged`` accumulates (timestamp_dt, payload) tuples only when
        # ``include`` is set, so the legacy path pays nothing for the new feature.
        _HISTORY_EVENT_TYPE = {"+": "task_created", "~": "fields_changed", "-": "task_deleted"}
        result = []
        merged: list[tuple[Any, dict[str, Any]]] = []
        for record, changes in zip(records, raw_changes, strict=True):
            diff = []
            for field, old_val, new_val in changes:
                if field.is_relation:
                    labels = fk_labels.get(field.name, {})
                    old_repr = labels.get(old_val) if old_val is not None else None
                    new_repr = labels.get(new_val) if new_val is not None else None
                else:
                    old_repr = str(old_val) if old_val is not None else None
                    new_repr = str(new_val) if new_val is not None else None
                diff.append({"field": field.name, "old": old_repr, "new": new_repr})

            if record.history_type == "~" and not diff:
                continue

            item = {
                "id": record.history_id,
                "history_date": record.history_date.isoformat(),
                "history_type": record.history_type,
                "history_user": (record.history_user.username if record.history_user else None),
                # Additive (#1878): the human label the UI should render, so change
                # events and comment events resolve to the SAME person label instead
                # of username-vs-display-name splitting one human into two actors.
                # history_user stays the bare username for backward compatibility.
                "history_user_display": (
                    (record.history_user.get_full_name() or record.history_user.username)
                    if record.history_user
                    else None
                ),
                "diff": diff,
            }
            result.append(item)
            if include:
                # Additive unified fields on the field-diff entry — legacy keys above
                # are retained unchanged so a client reading the old shape still works.
                item["event_type"] = _HISTORY_EVENT_TYPE.get(record.history_type, "fields_changed")
                item["actor"] = _activity_actor(record.history_user)
                item["timestamp"] = record.history_date.isoformat()
                item["detail"] = {"diff": diff}
                merged.append((record.history_date, item))

        from rest_framework.pagination import PageNumberPagination

        if include:
            extra_events, extra_truncated = _build_activity_events(
                task, include, request, _MAX_HISTORY_ROWS, until=until
            )
            merged.extend(extra_events)
            count_truncated = count_truncated or extra_truncated
            # Stable newest-first order across all sources; ties keep insertion order.
            merged.sort(key=lambda pair: pair[0], reverse=True)
            feed: list[Any] = [payload for _, payload in merged]
        else:
            feed = result

        if until is not None:
            # Keyset mode (#1882): slice one page off the merged until-window and
            # hand the client the oldest returned timestamp to resume from. `page`
            # is ignored — offset and keyset cannot be mixed coherently. Cursoring
            # is strictly-older-than on the timestamp alone, so events sharing the
            # exact boundary timestamp can repeat or be skipped across pages — the
            # documented ADR-0160 tradeoff the board activity feed already accepts.
            page_items = feed[:page_size]
            # More-than-page_size events in the window means older events exist;
            # otherwise the window is exhausted (mirrors board_activity).
            next_until = (
                page_items[-1]["timestamp"] if len(feed) > page_size and page_items else None
            )
            return Response(
                {
                    "results": page_items,
                    "next_until": next_until,
                    "count_truncated": count_truncated,
                }
            )

        paginator = PageNumberPagination()
        paginator.page_size = page_size
        page: list[Any] | None = paginator.paginate_queryset(feed, request)  # type: ignore[arg-type]
        response = paginator.get_paginated_response(page)
        # Expose count_truncated so the client can surface "showing recent 2,000
        # changes" when the task has a very long edit history (P18).
        response.data["count_truncated"] = count_truncated
        if include:
            # Additive keyset resume point (#1882): a client that started on offset
            # paging can hop to keyset by passing this back as `until`. Null when
            # this offset page is the last one (nothing older to fetch).
            response.data["next_until"] = (
                page[-1]["timestamp"] if page and response.data.get("next") else None
            )
        return response


@extend_schema_view(
    get=extend_schema(
        summary="Active-baseline comparison for a single task",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Baseline comparison object. `{has_baseline: false}` when the "
                    "project has no active baseline; `{has_baseline: true, "
                    "in_baseline: false, ...}` when the task post-dates the "
                    "baseline; otherwise the full snapshot with planned vs current "
                    "dates/durations and signed `*_delta*` values (positive = "
                    "slipping behind plan)."
                ),
            )
        },
    )
)
class TaskBaselineDetailView(APIView):
    """Active-baseline comparison for a single task.

    Returns the task's current schedule dates alongside the baseline snapshot,
    plus signed delta values (positive = slipping behind plan).

    Response flags:
      has_baseline=False — the project has no active baseline yet
      in_baseline=False  — the task was added after the baseline was taken
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get(self, request: Request, project_pk: str, task_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        if not IsProjectMember().has_object_permission(request, self, project):
            return Response({"detail": "Permission denied."}, status=status.HTTP_403_FORBIDDEN)

        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)

        try:
            baseline = Baseline.objects.get(project_id=project_pk, is_active=True, is_deleted=False)
        except Baseline.DoesNotExist:
            return Response({"has_baseline": False})

        try:
            bt = BaselineTask.objects.get(baseline=baseline, task_id=task.pk)
        except BaselineTask.DoesNotExist:
            return Response(
                {
                    "has_baseline": True,
                    "in_baseline": False,
                    "baseline_name": baseline.name,
                    "baseline_taken_at": baseline.created_at.isoformat(),
                }
            )

        def _day_delta(
            current: datetime.date | None,
            planned: datetime.date | None,
        ) -> int | None:
            if current is None or planned is None:
                return None
            return (current - planned).days

        return Response(
            {
                "has_baseline": True,
                "in_baseline": True,
                "baseline_name": baseline.name,
                "baseline_taken_at": baseline.created_at.isoformat(),
                "has_cpm_dates": baseline.has_cpm_dates,
                "planned_start": bt.start.isoformat() if bt.start else None,
                "planned_finish": bt.finish.isoformat() if bt.finish else None,
                "planned_duration": bt.duration,
                "planned_actual_start": bt.actual_start.isoformat() if bt.actual_start else None,
                "planned_actual_finish": bt.actual_finish.isoformat() if bt.actual_finish else None,
                "current_start": task.early_start.isoformat() if task.early_start else None,
                "current_finish": task.early_finish.isoformat() if task.early_finish else None,
                "current_duration": task.duration,
                "current_actual_start": (
                    task.actual_start.isoformat() if task.actual_start else None
                ),
                "current_actual_finish": (
                    task.actual_finish.isoformat() if task.actual_finish else None
                ),
                "start_delta_days": _day_delta(task.early_start, bt.start),
                "finish_delta_days": _day_delta(task.early_finish, bt.finish),
                "duration_delta": task.duration - bt.duration,
            }
        )


@extend_schema_view(
    patch=extend_schema(
        summary="Reorder phase columns (root-level WBS tasks)",
        request=inline_serializer(
            name="PhaseReorderRequest",
            fields={
                "phases": serializers.ListField(
                    child=inline_serializer(
                        name="PhaseReorderEntry",
                        fields={
                            "id": serializers.UUIDField(),
                            "server_version": serializers.IntegerField(),
                        },
                    )
                )
            },
        ),
        responses={200: PhaseReorderResponseSerializer},
    )
)
class PhaseReorderView(IdempotencyMixin, APIView):
    """Reorder phase columns on the board by updating priority_rank on WBS L1 tasks.

    PATCH /api/v1/projects/{pk}/phases/reorder/

    Body:
        {
            "phases": [
                {"id": "<uuid>", "server_version": 12},
                {"id": "<uuid>", "server_version": 7}
            ]
        }

    Requires ADMIN (role ≥ 3).  Verifies server_version for every supplied task
    before writing — returns 409 if any version is stale (another participant
    modified a phase concurrently).  Atomically sets priority_rank = position * 10,
    bumps server_version via F() increment, broadcasts phases_reordered, and
    enqueues a CPM recalculation.

    All IDs must be non-deleted, root-level tasks (wbs_path matches ^\\d+$)
    belonging to this project — any violation returns 400.
    """

    permission_classes = [IsAuthenticated, IsProjectAdmin, IsProjectNotArchived]

    def patch(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        phases_data = request.data.get("phases")
        if not isinstance(phases_data, list) or not phases_data:
            return Response(
                {"phases": ["This field is required and must be a non-empty list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate each entry: must be a dict with a UUID id and integer server_version.
        invalid: list[str] = []
        parsed: list[tuple[str, int]] = []
        for entry in phases_data:
            if not isinstance(entry, dict):
                invalid.append(repr(entry))
                continue
            tid = entry.get("id")
            sv = entry.get("server_version")
            if not isinstance(tid, str) or not isinstance(sv, int):
                invalid.append(repr(entry))
                continue
            try:
                uuid.UUID(tid)
            except ValueError:
                invalid.append(tid)
                continue
            parsed.append((tid, sv))

        if invalid:
            bad = ", ".join(invalid)
            return Response(
                {"phases": [f"Invalid entries (expected {{id, server_version}}): {bad}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        project_id_str = str(project.pk)
        with transaction.atomic():
            # Lock rows first to serialise concurrent reorders.
            root_tasks = Task.objects.select_for_update().filter(
                project_id=pk, is_deleted=False, wbs_path__regex=r"^\d+$"
            )
            root_by_id = {str(t.pk): t for t in root_tasks}

            unknown = [tid for tid, _ in parsed if tid not in root_by_id]
            if unknown:
                bad = ", ".join(unknown)
                return Response(
                    {"phases": [f"Unknown or non-root task IDs: {bad}"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # Optimistic lock — reject if any server_version is stale.
            stale = [tid for tid, sv in parsed if root_by_id[tid].server_version != sv]
            if stale:
                bad = ", ".join(stale)
                return Response(
                    {"detail": f"Conflict: stale server_version for tasks: {bad}"},
                    status=status.HTTP_409_CONFLICT,
                )

            for position, (task_id, _) in enumerate(parsed, start=1):
                task = root_by_id[task_id]
                task.priority_rank = position * 10
                task.server_version = F("server_version") + 1
                task.save(update_fields=["priority_rank", "server_version"])

            transaction.on_commit(
                lambda: broadcast_board_event(project_id_str, "phases_reordered", {})
            )
            transaction.on_commit(lambda: _enqueue_recalculate(project_id_str))

        return Response({"updated": len(parsed)}, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Workflow settings — Phase (root-task) and ProjectCustomField viewsets (#521)
# ---------------------------------------------------------------------------


# Root-task discriminator — wbs_path matches a single integer with no dot.  The
# Workflow settings page edits these and nothing else.
_ROOT_WBS_RE = r"^\d+$"


class PhaseViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Task]):
    """CRUD for project phases (root-level WBS tasks).

    Mounted at ``/projects/<project_pk>/phases/`` — the Workflow settings page
    surface. Each row corresponds to a Task with ``wbs_path ~ '^\\d+$'``; the
    Board groups by these as swim-lanes and the Schedule view renders them as
    summary rows.

    Permission matrix:
      list / retrieve — Viewer+ (IsProjectMember)
      create / update / partial_update / destroy — Project Manager+ (IsProjectAdmin)

    Reordering uses the pre-existing ``PATCH /projects/<pk>/phases/reorder/``
    endpoint (ADR-0046); this viewset does not expose its own reorder action
    to avoid drift.

    Destroy refuses (409) when the phase has any descendant tasks — silently
    cascading 36 tasks would surprise a PM. The client should move or delete
    the children first.
    """

    serializer_class = PhaseSerializer
    # Class-level queryset is the DRF introspection hook; the real queryset
    # is built in ``get_queryset`` so it can filter by ``project_pk`` from the
    # URL kwargs and attach per-row task counts.
    queryset = Task.objects.filter(is_deleted=False)

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectAdmin(), IsProjectNotArchived()]

    def _attach_task_counts(self, phases: list[Task]) -> list[Task]:
        """Set ``descendants_count`` on each phase from a single grouped DB query.

        Counts include the phase itself plus every non-deleted descendant
        task. For an empty phase the count is 1; for a phase with two child
        tasks it is 3. Two queries total (one for phases, one for the
        per-phase count map) rather than N+1 per-phase counts.

        P20: replaced the Python scan (loads all wbs_paths into memory, grows
        linearly with task count) with a DB-side GROUP BY using SPLIT_PART so
        the aggregation happens in PostgreSQL and only the small summary rows
        are returned.
        """
        if not phases:
            return phases
        project_id = phases[0].project_id
        # DB-side GROUP BY on the root WBS label (the part before the first dot).
        # SPLIT_PART(text, '.', 1) returns the whole string when there is no dot,
        # so root-level tasks contribute to their own bucket correctly.
        rows = (
            Task.objects.filter(project_id=project_id, is_deleted=False)
            .exclude(wbs_path__isnull=True)
            .annotate(
                # nosemgrep: avoid-raw-sql
                root_label=db_models.expressions.RawSQL(
                    "SPLIT_PART(projects_task.wbs_path::text, '.', 1)",
                    [],
                    output_field=db_models.TextField(),
                )
            )
            .values("root_label")
            .annotate(cnt=Count("id"))
        )
        counts: dict[str, int] = {str(row["root_label"]): row["cnt"] for row in rows}
        for phase in phases:
            phase.descendants_count = counts.get(  # type: ignore[attr-defined]
                str(phase.wbs_path) if phase.wbs_path else "", 0
            )
        return phases

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        queryset = self.filter_queryset(self.get_queryset())
        phases = list(queryset)
        self._attach_task_counts(phases)
        serializer = self.get_serializer(phases, many=True)
        return Response(serializer.data)

    def retrieve(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        instance = self.get_object()
        self._attach_task_counts([instance])
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    def get_queryset(self) -> QuerySet[Task]:
        project_pk = self.kwargs.get("project_pk")
        if not project_pk:
            return Task.objects.none()
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated:
            return Task.objects.none()
        # P19: select_related so PhaseSerializer's project/assignee FK accesses
        # don't issue extra queries per phase row.
        return (
            Task.objects.filter(
                project_id=project_pk,
                is_deleted=False,
                wbs_path__regex=_ROOT_WBS_RE,
            )
            .select_related("project", "assignee")
            .order_by("priority_rank", "wbs_path", "name")
        )

    def perform_create(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, project)

        with transaction.atomic():
            # Append at the end of the root list — match the convention used by
            # TaskViewSet.perform_create when no parent_id is supplied.
            root_count = (
                Task.objects.select_for_update()
                .filter(project=project, is_deleted=False, wbs_path__regex=_ROOT_WBS_RE)
                .count()
            )
            wbs_path = str(root_count + 1)
            # priority_rank uses the existing 10-step convention from PhaseReorderView
            # so new phases sit at the bottom of the swim-lane order.
            priority_rank = (root_count + 1) * 10
            instance = serializer.save(
                project=project,
                wbs_path=wbs_path,
                priority_rank=priority_rank,
                is_subtask=False,
            )
            # Mirror the count that get_queryset() annotates — for the response
            # body the new phase has only itself as a "task".
            instance.descendants_count = 1  # type: ignore[attr-defined]
            project_id_str = str(project_pk)
            task_id_str = str(instance.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(project_id_str, "task_created", {"id": task_id_str})
            )

    def perform_update(self, serializer: BaseSerializer[Task]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        # VersionedModel.save() already bumps server_version atomically via F() on
        # every UPDATE — no second bump needed here.
        # Attach the task count so the response body includes it (mirrors list).
        self._attach_task_counts([instance])
        project_id_str = str(instance.project_id)
        task_id_str = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id_str, "task_updated", {"id": task_id_str})
        )

    def perform_destroy(self, instance: Task) -> None:
        from rest_framework.exceptions import ValidationError as DRFValidationError

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Refuse when the phase still has descendant tasks. Cascading a phase
        # delete would silently soft-delete potentially-dozens of tasks; PMs
        # expect to move children out first.
        descendant_count = Task.objects.filter(
            project_id=instance.project_id,
            is_deleted=False,
            wbs_path__startswith=str(instance.wbs_path) + ".",
        ).count()
        if descendant_count > 0:
            raise DRFValidationError(
                {
                    "detail": (
                        f"Cannot delete phase {instance.name!r}: it has {descendant_count} "
                        "descendant tasks. Move or delete the tasks first."
                    )
                }
            )
        project_id_str = str(instance.project_id)
        task_id_str = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id_str, "task_deleted", {"id": task_id_str})
        )


class ProjectCustomFieldViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[ProjectCustomField]):
    """CRUD for project custom field *definitions* (#521).

    Mounted at ``/projects/<project_pk>/fields/``. Per-task values for these
    fields are not yet persisted; this endpoint shapes the workflow schema
    only. Built-in fields (Phase, Owner, Duration, Risk, Critical-path) are
    a static frontend catalog and not exposed here.

    Permission matrix:
      list / retrieve — Viewer+ (IsProjectMember)
      create / update / partial_update / destroy — Scheduler+ (IsProjectScheduler)

    Mirrors BoardColumnConfigView's read=member, write=scheduler split:
    custom fields shape how tasks are tracked and are therefore a
    schedule-affecting concern.
    """

    serializer_class = ProjectCustomFieldSerializer
    queryset = ProjectCustomField.objects.all()
    # Per-project list is capped at 32 rows (PROJECT_CUSTOM_FIELD_MAX) — no need
    # for pagination, and the unpaginated shape matches the BoardSavedView list.
    pagination_class = None

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[ProjectCustomField]:
        qs = super().get_queryset()
        project_pk = self.kwargs.get("project_pk")
        if project_pk:
            qs = qs.filter(project_id=project_pk)
        return qs.order_by("order", "name")

    def perform_create(self, serializer: BaseSerializer[ProjectCustomField]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, project)
        instance = serializer.save(project=project, server_version=1)
        project_id_str = str(project_pk)
        field_id_str = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "project_custom_fields_updated",
                {"id": field_id_str, "action": "created"},
            )
        )

    def perform_update(self, serializer: BaseSerializer[ProjectCustomField]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id_str = str(instance.project_id)
        field_id_str = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "project_custom_fields_updated",
                {"id": field_id_str, "action": "updated"},
            )
        )

    def perform_destroy(self, instance: ProjectCustomField) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id_str = str(instance.project_id)
        field_id_str = str(instance.pk)
        instance.delete()
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "project_custom_fields_updated",
                {"id": field_id_str, "action": "deleted"},
            )
        )


# ---------------------------------------------------------------------------
# Sprint endpoints (ADR-0037)
# ---------------------------------------------------------------------------


@extend_schema_view(
    list=extend_schema(
        parameters=[
            OpenApiParameter(
                name="state",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Filter by sprint state (PLANNED, ACTIVE, CLOSED, CANCELED).",
            ),
        ],
    ),
)
class SprintViewSet(McpReadableViewMixin, ProjectScopedViewSet, viewsets.ModelViewSet[Sprint]):
    """CRUD plus state-transition actions for sprints (ADR-0037).

    Routes are nested under projects for list/create
    (``/projects/<project_pk>/sprints/``) and exposed at top level for detail
    and actions (``/sprints/<id>/``, ``.../activate/``, ``.../close/``,
    ``.../cancel/``, ``.../burndown/``).

    Permission matrix:
      list / retrieve / burndown      — Viewer+ (IsProjectMember)
      create / update / activate /
      close / cancel                  — Team Member+ (IsProjectMemberWrite)
      destroy (PLANNED only)          — Project Manager+ (IsProjectAdmin)
    """

    queryset = Sprint.objects.select_related("project", "created_by", "target_milestone").filter(
        is_deleted=False
    )
    serializer_class = SprintSerializer
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["start_date", "finish_date", "name", "state"]

    def get_permissions(self) -> list[BasePermission]:
        # ADR-0186 §E: append the read-only MCP token guards around the
        # action-specific RBAC list so a mcp:read token is confined to safe
        # methods on every action (no write-branch leak); human auth passes both.
        return [*self._rbac_permissions(), *self.mcp_token_guards()]

    def _rbac_permissions(self) -> list[BasePermission]:
        if self.action in (
            "list",
            "retrieve",
            "burndown",
            "capacity",
            "incoming_carryover",
            "outcome",
            "daily_delta",
            "scope_changes",
            # ADR-0151 (issue 1254): the per-sprint duration-change audit is a
            # team-readable Viewer+ read, exactly mirroring scope_changes above.
            "duration_events",
        ):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # ADR-0106 §E1.1/§E1.4 (#928): the reforecast preview is a read-only dry
        # run (computes dates + the team-pace band, persists nothing, writes no
        # schedule) — any project member, matching the §5 forecast-read posture.
        if self.action == "reforecast_preview":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # `retro` accepts GET (read) / POST (write) / PATCH (partial write).
        # Read needs membership; writes need write role.
        if self.action == "retro" and self.request.method == "GET":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # Retro-related read-only actions (prior retro): Viewer+ on the project.
        if self.action == "retro_prior":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # Live retro board read + pulse reads (ADR-0117): membership to reach the
        # endpoint. The pulse *trend* is further gated inside the service by
        # ADR-0104's `pulse` signal (team + coach only; PM/PMO omitted entirely).
        # retro_board/pulse also accept writes (POST/PUT) — those fall through to
        # IsProjectMemberWrite below so a VIEWER cannot create a sticky / answer.
        if self.action == "pulse_trend":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        if self.action in ("retro_board", "pulse") and self.request.method == "GET":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # Pulling a carryover item into the sprint requires SCHEDULER+ — the
        # sole path that can assign a retro action item to a sprint per ADR-0071.
        if self.action == "pull_action_item_to_sprint":
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        if self.action == "destroy":
            return [IsAuthenticated(), IsProjectAdmin(), IsProjectNotArchived()]
        # ADR-0102 §3 (widened ADR-0123 §3 / #1140): the scope-injection accept-gate
        # is team-owned — role>=ADMIN OR the Scrum Master / Product Owner facet (the
        # PO owns sprint scope, the SM facilitates). The service layer
        # (assert_scope_gate_for_project) re-checks the same role-or-facet rule
        # against a real membership/facet row regardless of role ordinal, so a
        # non-member high-ordinal Enterprise role is still 403 (the back-door close).
        if self.action in ("scope_changes_accept", "scope_changes_reject"):
            return [IsAuthenticated(), IsProjectScopeManager(), IsProjectNotArchived()]
        # ADR-0106 §2: promote/unbind write a *schedule* object (the milestone
        # binding) onto the CPM line — a schedule-authoring action gated at
        # SCHEDULER+ (Resource Manager and up, which includes the PM/ADMIN).
        # Deliberately NOT the team sprint-lifecycle gate (>=ADMIN for
        # activate/close): binding a milestone is not reshaping sprint scope.
        if self.action in ("promote_to_milestone", "unbind_milestone"):
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[Sprint]:
        qs = super().get_queryset()
        project_pk = self.kwargs.get("project_pk")
        if project_pk:
            qs = qs.filter(project_id=project_pk)
        state_filter = self.request.query_params.get("state")
        if state_filter:
            qs = qs.filter(state=state_filter)
        # ADR-0102 §5/§8: annotate pending_count so SprintSerializer reads it
        # without an N+1 COUNT per row (the serializer falls back to a single
        # COUNT only for actions that build a sprint outside this queryset).
        qs = qs.annotate(
            pending_count=db_models.Count(
                "tasks",
                filter=db_models.Q(tasks__sprint_pending=True, tasks__is_deleted=False),
            ),
            # #546: in-flight task count for the SprintPanel WIP chip. IN_PROGRESS
            # + REVIEW are the in-flight columns (the two carrying default
            # per-column WIP limits). Both filtered Counts target the same
            # ``tasks`` relation, so Django reuses one LEFT JOIN with two
            # conditional aggregates — no row fan-out between them.
            wip_count=db_models.Count(
                "tasks",
                filter=db_models.Q(
                    tasks__status__in=(TaskStatus.IN_PROGRESS, TaskStatus.REVIEW),
                    tasks__is_deleted=False,
                ),
            ),
        )
        # 🔴-3: SprintSerializer.get_target_milestone_detail reads the
        # milestone's predecessor Dependency ids. Without this prefetch it fires
        # one Dependency query per sprint that has a target_milestone.
        qs = qs.prefetch_related(
            db_models.Prefetch(
                "target_milestone__predecessors",
                queryset=Dependency.objects.filter(predecessor__is_deleted=False).only(
                    "predecessor_id", "dep_type", "successor_id"
                ),
                to_attr="_prefetched_predecessor_deps",
            )
        )
        return cast(QuerySet[Sprint], qs)

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Attach batched target-milestone rollups to the page before serialization.

        ``SprintSerializer.target_milestone_detail`` embeds the same rollup payload
        as ``TaskSerializer.milestone_rollup`` and was likewise O(milestones ×
        sprints) per row (#999). Batch every linked milestone in the page in 2
        queries and stash the payload on each sprint instance.
        """
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        if page is not None:
            _attach_target_milestone_rollups(list(page))
            serializer = self.get_serializer(page, many=True)
            return self.get_paginated_response(serializer.data)
        sprints = list(queryset)
        _attach_target_milestone_rollups(sprints)
        serializer = self.get_serializer(sprints, many=True)
        return Response(serializer.data)

    def perform_create(self, serializer: BaseSerializer[Sprint]) -> None:
        from trueppm_api.apps.projects.services import recompute_milestone_rollup
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        # DRF does not call has_object_permission on create — check explicitly.
        self.check_object_permissions(self.request, project)
        instance = serializer.save(project=project, created_by=self.request.user)
        sprint_id = str(instance.pk)
        project_id_str = str(project_pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id_str, "sprint_created", {"id": sprint_id})
        )
        # ADR-0074: a PLANNED sprint with a target milestone contributes to
        # the denominator immediately so the milestone shows "0% of 24 pts."
        if instance.target_milestone_id is not None:
            recompute_milestone_rollup(instance.target_milestone_id)

    def perform_update(self, serializer: BaseSerializer[Sprint]) -> None:
        from trueppm_api.apps.projects.services import recompute_milestone_rollup
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # ADR-0074: capture pre-save target_milestone so a re-link recomputes
        # both the OLD and NEW milestones — neither holds a stale rollup.
        old_milestone_id = serializer.instance.target_milestone_id if serializer.instance else None
        instance = serializer.save()
        project_id = str(instance.project_id)
        sprint_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "sprint_updated", {"id": sprint_id})
        )
        new_milestone_id = instance.target_milestone_id
        if old_milestone_id is not None and old_milestone_id != new_milestone_id:
            recompute_milestone_rollup(old_milestone_id)
        if new_milestone_id is not None:
            recompute_milestone_rollup(new_milestone_id)

    def perform_destroy(self, instance: Sprint) -> None:
        if instance.state not in (SprintState.PLANNED, SprintState.CANCELLED):
            raise serializers.ValidationError(
                {"detail": "Only PLANNED or CANCELLED sprints can be deleted."}
            )
        from trueppm_api.apps.projects.services import recompute_milestone_rollup
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        sprint_id = str(instance.pk)
        target_milestone_id = instance.target_milestone_id
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "sprint_deleted", {"id": sprint_id})
        )
        # ADR-0074: a deleted sprint stops contributing to the rollup.
        if target_milestone_id is not None:
            recompute_milestone_rollup(target_milestone_id)

    @extend_schema(
        summary="Activate a sprint",
        responses={
            200: SprintSerializer,
            400: OpenApiResponse(description="Sprint is not in PLANNED state."),
            409: OpenApiResponse(
                description="Another sprint is already active; body includes conflicting_sprint_id."
            ),
        },
    )
    @action(detail=True, methods=["post"])
    def activate(self, request: Request, pk: str | None = None) -> Response:
        """Transition PLANNED → ACTIVE.

        Snapshots committed_points and committed_task_count from the current
        backlog. Enforces the single-active-sprint-per-project soft constraint
        (409 with conflicting sprint id). Returns the updated sprint plus a
        non-blocking ``warnings`` array for over-allocated members
        (ADR-0037 Q2 amendment).
        """
        from trueppm_api.apps.projects.product_backlog_services import seed_sprint_rank
        from trueppm_api.apps.projects.services import (
            capacity_check,
            recompute_milestone_rollup,
            snapshot_committed_metrics,
        )
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        if pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        with transaction.atomic():
            sprint = (
                Sprint.objects.select_for_update()
                .select_related("project")
                .filter(pk=pk, is_deleted=False)
                .first()
            )
            if sprint is None:
                return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
            self.check_object_permissions(request, sprint)
            if sprint.state != SprintState.PLANNED:
                return Response(
                    {
                        "detail": (
                            f"Sprint state {sprint.state} cannot be activated (must be PLANNED)."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            existing_active = (
                Sprint.objects.filter(
                    project_id=sprint.project_id,
                    state=SprintState.ACTIVE,
                    is_deleted=False,
                )
                .exclude(pk=sprint.pk)
                .first()
            )
            if existing_active is not None:
                return Response(
                    {
                        "detail": "Another sprint is already active for this project.",
                        "conflicting_sprint_id": str(existing_active.pk),
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            snapshot_committed_metrics(sprint)
            # ADR-0105 §5: seed the within-sprint execution order (sprint_rank) from
            # product-backlog priority at commit. The sprint_activated broadcast below
            # covers the resulting ordering change (no separate event needed).
            seed_sprint_rank(sprint)
            sprint.state = SprintState.ACTIVE
            sprint.activated_at = timezone.now()
            sprint.save(
                update_fields=[
                    "committed_points",
                    "committed_task_count",
                    "state",
                    "activated_at",
                ]
            )
            warnings = capacity_check(sprint)
            project_id_str = str(sprint.project_id)
            sprint_id_str = str(sprint.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id_str, "sprint_activated", {"id": sprint_id_str}
                )
            )
            # ADR-0147: emit the sprint.activated webhook (first-party domain event).
            # Payload is built now (the sprint row is loaded inside the transaction)
            # and captured by value so the on_commit callback does no DB work.
            activated_payload = _sprint_base_webhook_payload(sprint, source="api")
            transaction.on_commit(
                lambda: _dispatch_webhooks(project_id_str, "sprint.activated", activated_payload)
            )
            # ADR-0074: recompute the linked milestone's rollup so the Gantt
            # reflects the now-active sprint immediately. No-op when the
            # sprint has no target milestone.
            if sprint.target_milestone_id is not None:
                recompute_milestone_rollup(sprint.target_milestone_id)

        data = SprintSerializer(sprint).data
        data["warnings"] = warnings
        return Response(data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Close a sprint",
        responses={
            202: OpenApiResponse(
                description=(
                    "Close request accepted; body includes the SprintCloseRequest id "
                    "(request_id) and an optional pending-scope advisory."
                )
            ),
            400: OpenApiResponse(
                description="Sprint is not ACTIVE or carry_over_to target is invalid."
            ),
            403: OpenApiResponse(
                description="Rejecting pending scope changes is team-owned (Admin or SM/PO facet)."
            ),
        },
    )
    @action(detail=True, methods=["post"])
    def close(self, request: Request, pk: str | None = None) -> Response:
        """Async transition ACTIVE → COMPLETED via the outbox drain.

        Returns 202 Accepted with the SprintCloseRequest id. The frontend
        polls retrieve or subscribes via WebSocket to observe ``state=COMPLETED``.
        """
        from trueppm_api.apps.projects.services import (
            ScopeAcceptForbidden,
            assert_scope_gate_for_project,
            enqueue_sprint_close,
            pending_scope_advisory,
        )

        sprint = get_object_or_404(Sprint, pk=pk, is_deleted=False)
        self.check_object_permissions(request, sprint)
        if sprint.state != SprintState.ACTIVE:
            return Response(
                {"detail": (f"Sprint state {sprint.state} cannot be closed (must be ACTIVE).")},
                status=status.HTTP_400_BAD_REQUEST,
            )
        body = SprintCloseRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        carry_over_to = body.validated_data["carry_over_to"]
        pending_disposition = body.validated_data["pending_disposition"]

        if carry_over_to not in {"backlog", "none"}:
            target = Sprint.objects.filter(
                pk=carry_over_to,
                project_id=sprint.project_id,
                is_deleted=False,
            ).first()
            if target is None:
                return Response(
                    {"carry_over_to": "Target sprint must exist in the same project."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if target.state == SprintState.COMPLETED:
                return Response(
                    {"carry_over_to": "Cannot carry over to a closed sprint."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # ADR-0102 §7: surface the non-blocking pending-scope advisory in the
        # close response so the frontend can confirm the disposition. Closing is
        # NEVER blocked by pending items — this is informational only.
        advisory = pending_scope_advisory(sprint)

        # ADR-0102 §3 (the load-bearing team-ownership invariant): closing a sprint
        # is MEMBER-gated, but REJECTING pending scope injections is a scope
        # decision reserved for role>=ADMIN. A MEMBER may close (carry-over is the
        # safe default disposition) but may not use the close path to reject
        # injected work — that would bypass the same gate enforced on the
        # accept/reject endpoints. Carry-over (default) needs no extra gate.
        if pending_disposition == "reject" and advisory is not None:
            try:
                assert_scope_gate_for_project(sprint.project_id, request.user)
            except ScopeAcceptForbidden:
                return Response(
                    {
                        "code": "scope_accept_forbidden",
                        "detail": (
                            "Rejecting pending scope changes is team-owned (Admin or SM/PO facet)."
                        ),
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )

        with transaction.atomic():
            req = enqueue_sprint_close(
                sprint_id=sprint.pk,
                carry_over_to=carry_over_to,
                pending_disposition=pending_disposition,
                requested_by=request.user,
            )
        payload: dict[str, Any] = {"queued": True, "request_id": str(req.id)}
        if advisory is not None:
            payload["scope_pending_on_close"] = advisory
        return Response(payload, status=status.HTTP_202_ACCEPTED)

    @extend_schema(
        summary="Cancel a planned sprint",
        responses={
            200: SprintSerializer,
            400: OpenApiResponse(description="Sprint is not in PLANNED state."),
        },
    )
    @action(detail=True, methods=["post"])
    def cancel(self, request: Request, pk: str | None = None) -> Response:
        """Transition PLANNED → CANCELLED.

        ACTIVE → CANCELLED requires admin role and is a rare admin-only
        recovery path; not exposed via this action in v1.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        if pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        with transaction.atomic():
            sprint = Sprint.objects.select_for_update().filter(pk=pk, is_deleted=False).first()
            if sprint is None:
                return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
            self.check_object_permissions(request, sprint)
            if sprint.state != SprintState.PLANNED:
                return Response(
                    {
                        "detail": (
                            f"Sprint state {sprint.state} cannot be cancelled (must be PLANNED)."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            sprint.state = SprintState.CANCELLED
            sprint.save(update_fields=["state"])
            project_id_str = str(sprint.project_id)
            sprint_id_str = str(sprint.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id_str, "sprint_cancelled", {"id": sprint_id_str}
                )
            )
            # ADR-0074: cancelled sprints contribute nothing to the rollup;
            # recompute so the milestone drops the cancelled sprint's
            # denominator contribution immediately.
            if sprint.target_milestone_id is not None:
                from trueppm_api.apps.projects.services import recompute_milestone_rollup

                recompute_milestone_rollup(sprint.target_milestone_id)
        return Response(SprintSerializer(sprint).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Bind a sprint to a schedule milestone",
        responses={
            200: SprintSerializer,
            201: SprintSerializer,
            400: OpenApiResponse(description="Milestone not found in this project."),
            409: OpenApiResponse(
                description="Sprint already bound to a milestone (code: sprint_already_bound)."
            ),
        },
    )
    @action(detail=True, methods=["post"], url_path="promote-to-milestone")
    def promote_to_milestone(self, request: Request, pk: str | None = None) -> Response:
        """Bind this sprint to a schedule milestone (ADR-0106 §2).

        Body ``{}`` mints a new ``Task(is_milestone=True)`` from the sprint goal
        (dated at finish), then binds it (``201``). Optional create overrides
        ``{"name": str, "target_date": date}`` rename/re-date the new milestone
        (ADR-0106 §E1.2, #928); both are ignored when ``milestone_id`` is given.
        Body ``{"milestone_id": uuid}`` binds an existing milestone in the same
        project (``200``). Re-binding the same milestone is an idempotent no-op
        ``200``; binding a *different* one while already bound is ``409
        sprint_already_bound`` — the binding never silently re-points. SCHEDULER+.
        """
        from trueppm_api.apps.projects.serializers import PromoteToMilestoneRequestSerializer
        from trueppm_api.apps.projects.services import (
            MilestoneNotFound,
            SprintAlreadyBound,
            promote_sprint_to_milestone,
        )

        if pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        body = PromoteToMilestoneRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        milestone_id = body.validated_data.get("milestone_id")
        override_name = body.validated_data.get("name")
        override_target_date = body.validated_data.get("target_date")
        with transaction.atomic():
            sprint = (
                # NB: do not select_related the nullable target_milestone here —
                # Postgres rejects FOR UPDATE on the nullable side of an outer
                # join. The service reads target_milestone_id (no join) and
                # assigns the bound object in-memory for the response serializer.
                Sprint.objects.select_for_update()
                .select_related("project")
                .filter(pk=pk, is_deleted=False)
                .first()
            )
            if sprint is None:
                return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
            self.check_object_permissions(request, sprint)
            try:
                sprint, created = promote_sprint_to_milestone(
                    sprint,
                    milestone_id=milestone_id,
                    actor=request.user,
                    name=override_name,
                    target_date=override_target_date,
                )
            except SprintAlreadyBound as exc:
                return Response(
                    {
                        "code": "sprint_already_bound",
                        "detail": "Unbind before binding to a different milestone.",
                        "current_milestone_id": str(exc.current_milestone_id),
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            except MilestoneNotFound:
                return Response(
                    {"milestone_id": "Milestone not found in this project."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
        return Response(SprintSerializer(sprint).data, status=code)

    @extend_schema(
        summary="Unbind a sprint from its milestone",
        responses={200: SprintSerializer},
    )
    @action(detail=True, methods=["post"], url_path="unbind-milestone")
    def unbind_milestone(self, request: Request, pk: str | None = None) -> Response:
        """Unbind this sprint from its milestone (ADR-0106 §2).

        Clears the FK and all three provenance fields; the freed milestone's
        rollup recomputes (clears if this was its last targeting sprint).
        No-op-safe — an already-unbound sprint returns ``200`` unchanged.
        SCHEDULER+.
        """
        from trueppm_api.apps.projects.services import unbind_sprint_milestone

        if pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        with transaction.atomic():
            sprint = (
                # NB: do not select_related the nullable target_milestone here —
                # Postgres rejects FOR UPDATE on the nullable side of an outer
                # join. The service reads target_milestone_id (no join) and
                # assigns the bound object in-memory for the response serializer.
                Sprint.objects.select_for_update()
                .select_related("project")
                .filter(pk=pk, is_deleted=False)
                .first()
            )
            if sprint is None:
                return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
            self.check_object_permissions(request, sprint)
            sprint = unbind_sprint_milestone(sprint)
        return Response(SprintSerializer(sprint).data, status=status.HTTP_200_OK)

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="milestone_id",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Existing milestone to preview against. Omit for the create-mode "
                    "preview of the milestone the dialog will mint (spine = sprint finish)."
                ),
            )
        ],
        responses=ReforecastPreviewSerializer,
    )
    @action(detail=True, methods=["get"], url_path="reforecast-preview")
    def reforecast_preview(self, request: Request, pk: str | None = None) -> Response:
        """Dry-run reforecast for the promote dialog (ADR-0106 §E1.1, #928).

        Computes the same dates + team-pace band the on-close reforecast (§3)
        will, but **live and persisting nothing**. Velocity-band only until #411
        Monte Carlo lands (``basis="velocity_band"``). ``?milestone_id=<uuid>``
        previews against an existing milestone (same project; ``404`` otherwise);
        omitted previews the to-be-created milestone. Any project member.
        """
        from trueppm_api.apps.projects.services import MilestoneNotFound, reforecast_preview

        if pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        sprint = Sprint.objects.select_related("project").filter(pk=pk, is_deleted=False).first()
        if sprint is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        self.check_object_permissions(request, sprint)
        milestone_id = request.query_params.get("milestone_id") or None
        try:
            payload = reforecast_preview(sprint, milestone_id=milestone_id)
        except MilestoneNotFound:
            return Response(
                {"milestone_id": "Milestone not found in this project."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(ReforecastPreviewSerializer(payload).data, status=status.HTTP_200_OK)

    def _bulk_scope_change(self, request: Request, pk: str | None, *, accept: bool) -> Response:
        """Shared body for the bulk accept/reject scope-change actions (ADR-0102 §5).

        Resolves the target PENDING SprintScopeChange rows (explicit ``ids`` or all
        pending in the sprint), applies the gated service per row, and returns
        ``{"accepted"|"rejected": [...], "pending_count": N}``. Tolerates partial
        failure: a row that errors (e.g. concurrently decided) is skipped and the
        rest still apply — the response lists only the rows that succeeded.
        """
        from trueppm_api.apps.projects.models import ScopeChangeStatus, SprintScopeChange
        from trueppm_api.apps.projects.serializers import (
            ScopeChangeBulkSerializer,
            SprintScopeChangeSerializer,
        )
        from trueppm_api.apps.projects.services import (
            ScopeAcceptForbidden,
            accept_scope_change,
            reject_scope_change,
            sprint_pending_count,
        )

        sprint = get_object_or_404(Sprint, pk=pk, is_deleted=False)
        self.check_object_permissions(request, sprint)
        body = ScopeChangeBulkSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        ids = body.validated_data["ids"]

        # Collect the candidate PENDING ids first, then lock + process each row in
        # its own atomic savepoint. select_for_update() requires an open transaction,
        # and a per-row lock that re-checks PENDING is what actually prevents two
        # concurrent accept/reject calls from double-processing the same row (P26),
        # while keeping the per-row partial-failure tolerance below.
        pending_qs = SprintScopeChange.objects.filter(
            sprint_id=sprint.pk, status=ScopeChangeStatus.PENDING
        )
        if ids:
            pending_qs = pending_qs.filter(pk__in=ids)
        pending_ids = list(pending_qs.values_list("pk", flat=True))

        service = accept_scope_change if accept else reject_scope_change
        done: list[Any] = []
        for sc_id in pending_ids:
            try:
                with transaction.atomic():
                    sc = (
                        SprintScopeChange.objects.select_for_update()
                        .select_related("task")
                        .get(pk=sc_id, status=ScopeChangeStatus.PENDING)
                    )
                    result = service(sc, request.user)
            except SprintScopeChange.DoesNotExist:
                # Decided by a concurrent call between the id scan and the row lock — skip.
                continue
            except ScopeAcceptForbidden:
                # The gate is checked at the viewset layer too; reaching here means
                # the actor lost membership mid-request — fail the whole call closed.
                return Response(
                    {"code": ScopeAcceptForbidden.code, "detail": ScopeAcceptForbidden.detail},
                    status=status.HTTP_403_FORBIDDEN,
                )
            except Exception:
                # Tolerate partial failure per row — one row that errors (e.g.
                # decided concurrently) is skipped; the rest still apply.
                logger.exception("bulk scope-change failed for %s", sc_id)
                continue
            done.append(result)

        key = "accepted" if accept else "rejected"
        return Response(
            {
                key: [SprintScopeChangeSerializer(row).data for row in done],
                "pending_count": sprint_pending_count(sprint.pk),
            },
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        summary="Bulk-accept pending sprint scope changes",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Body includes the accepted scope-change rows and the pending_count.",
            ),
            403: OpenApiResponse(
                description="Accepting scope changes is team-owned (Admin or SM/PO facet)."
            ),
        },
    )
    @action(detail=True, methods=["post"], url_path="scope-changes/accept")
    def scope_changes_accept(self, request: Request, pk: str | None = None) -> Response:
        """Bulk-accept pending scope injections in a sprint (ADR-0102 §5).

        Body ``{"ids": [uuid, ...]}`` — omit or empty to accept *all* pending.
        Returns ``{"accepted": [...], "pending_count": N}``.
        """
        return self._bulk_scope_change(request, pk, accept=True)

    @extend_schema(
        summary="Bulk-reject pending sprint scope changes",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Body includes the rejected scope-change rows and the pending_count.",
            ),
            403: OpenApiResponse(
                description="Rejecting scope changes is team-owned (Admin or SM/PO facet)."
            ),
        },
    )
    @action(detail=True, methods=["post"], url_path="scope-changes/reject")
    def scope_changes_reject(self, request: Request, pk: str | None = None) -> Response:
        """Bulk-reject pending scope injections in a sprint (ADR-0102 §5).

        Body ``{"ids": [uuid, ...]}`` — omit or empty to reject *all* pending.
        Returns ``{"rejected": [...], "pending_count": N}``.
        """
        return self._bulk_scope_change(request, pk, accept=False)

    @extend_schema(
        summary="List a sprint's mid-sprint scope changes (audit + delta)",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Body includes a summary (points_added/points_removed/"
                    "added_mid_sprint_count/total) and the ordered scope-change events."
                ),
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="scope-changes")
    def scope_changes(self, request: Request, pk: str | None = None) -> Response:
        """Read the sprint's mid-sprint scope-change audit + delta (#543/#550).

        Read-only; any project member (Viewer+) — the audit is team-readable first
        (sprint sovereignty). Surfaces the existing ``SprintScopeChange`` injection
        rows as actor/timestamp/item/points/status plus the aggregate the
        persistent scope-change chip and the SprintPanel badge render from. No
        mutation, no new table.
        """
        from trueppm_api.apps.projects.services import sprint_scope_change_payload

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)
        return Response(sprint_scope_change_payload(sprint), status=status.HTTP_200_OK)

    @action(detail=True, methods=["get"], url_path="duration-events")
    def duration_events(self, request: Request, pk: str | None = None) -> Response:
        """Read the sprint's mid-sprint duration-change events (ADR-0151, issue 1254).

        Read-only; any project member (Viewer+) — the team-readable audit that
        surfaces on the sprint changes-log so a duration change made during the
        sprint is visible alongside scope changes. The per-task read action
        already exists; this per-sprint aggregate exists so the changes-log does
        not fan out one request per sprint task. No mutation, no new table.
        """
        from trueppm_api.apps.projects.services import sprint_duration_change_payload

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)
        return Response(sprint_duration_change_payload(sprint), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Get a sprint's burndown series",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Body includes the serialized sprint and its burn snapshot series.",
            )
        },
    )
    @action(detail=True, methods=["get"])
    def burndown(self, request: Request, pk: str | None = None) -> Response:
        """Return the sprint, its actual burn series, and the server-computed
        burn pace (#984): burn_status + projected_finish_date, so MCP/mobile read
        the pace verdict from REST instead of re-deriving it client-side."""
        from trueppm_api.apps.projects.services import compute_sprint_burn_status

        sprint = get_object_or_404(
            Sprint.objects.select_related("project", "created_by"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)
        snapshot_list = list(sprint.burn_snapshots.all().order_by("snapshot_date"))
        burn = compute_sprint_burn_status(sprint, snapshot_list)
        payload = {
            "sprint": SprintSerializer(sprint).data,
            "snapshots": SprintBurnSnapshotSerializer(snapshot_list, many=True).data,
            "burn_status": burn["burn_status"],
            "trend_points": burn["trend_points"],
            "projected_finish_date": burn["projected_finish_date"],
        }
        return Response(payload, status=status.HTTP_200_OK)

    @extend_schema(responses=SprintOutcomeSerializer)
    @action(detail=True, methods=["get"])
    def outcome(self, request: Request, pk: str | None = None) -> Response:
        """Consolidated sprint-review read (#985, ADR-0176 §3).

        One surface composing the goal verdict (#983), velocity delta + burn
        status (#984, ADR-0104 gated), the closing "didn't ship" membership
        (#982), commitment aggregates, and a retro summary — so the review UI and
        the MCP adapter bind to a single endpoint instead of stitching calls or
        deriving the numbers client-side. Viewer+; privacy enforced in the service.
        """
        from trueppm_api.apps.projects.services import sprint_outcome_payload

        sprint = get_object_or_404(
            # target_milestone is select_related so the #1098 realized-slip lookup
            # doesn't add a query for the bound milestone.
            Sprint.objects.select_related("project", "created_by", "target_milestone"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)
        payload = sprint_outcome_payload(sprint, request)
        return Response(payload, status=status.HTTP_200_OK)

    @extend_schema(responses=SprintDailyDeltaSerializer)
    @action(detail=True, methods=["get"], url_path="daily-delta")
    def daily_delta(self, request: Request, pk: str | None = None) -> Response:
        """Team standup "what changed since yesterday" read (#925, ADR-0121).

        Server-computed delta for the team's Daily Scrum: status moves, new blockers
        (the blocked_reason flag transition — split impediment vs paused, ADR-0124
        #1125), scope injections, the burndown swing, and a per-actor count rollup —
        all from existing history/snapshot data, no model. Pull-only.
        ``?since=<iso8601>`` sets the window (default 24h ago, floored at sprint
        activation). Team-private by membership: a PMO/org non-member is denied;
        the read is status-level only (never hours/keystroke — Morgan's hard-NO).
        """
        from datetime import timedelta

        from django.utils import timezone
        from django.utils.dateparse import parse_datetime

        from trueppm_api.apps.projects.services import sprint_daily_delta

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"), pk=pk, is_deleted=False
        )
        self.check_object_permissions(request, sprint)

        raw = request.query_params.get("since")
        try:
            # parse_datetime returns None on a malformed string, but RAISES
            # ValueError on a well-formed-but-out-of-range one (e.g. month 13) —
            # both fall back to the default window, never a 500.
            since = parse_datetime(raw) if raw else None
        except ValueError:
            since = None
        if since is None:
            since = timezone.now() - timedelta(hours=24)
        elif timezone.is_naive(since):
            since = timezone.make_aware(since)

        payload = sprint_daily_delta(sprint, since, request)
        return Response(payload, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Blocked tasks in this sprint (ADR-0124, #1134)",
        responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="blocker_type",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Filter to one BlockerType (dependency / resource / vendor / "
                    "decision / other). Unknown value → 400."
                ),
            ),
            OpenApiParameter(
                name="min_age_days",
                type=OpenApiTypes.INT,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Keep only tasks blocked at least N days. Non-negative integer; "
                    "negative or non-integer → 400."
                ),
            ),
        ],
    )
    @action(detail=True, methods=["get"], url_path="blocked")
    def blocked(self, request: Request, pk: str | None = None) -> Response:
        """List flagged-blocked tasks in this sprint — the SM's impediment roll-up.

        Same reason-free shape as ``GET /projects/{id}/blocked/`` (type + age +
        actor + assignee + soft link, oldest-blocked first), scoped to this
        sprint's tasks, with the same optional ``?blocker_type=`` / ``?min_age_days=``
        filters (#1157). Reason text is omitted from every row for every requester
        (ADR-0124 §4); no reason filter/sort/search param is exposed. Sprint
        membership (Viewer+) is enforced via ``check_object_permissions``.
        """
        from trueppm_api.apps.projects.blocker_services import (
            parse_blocked_filters,
            sprint_blocked_rollup,
        )

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"), pk=pk, is_deleted=False
        )
        self.check_object_permissions(request, sprint)
        filters = parse_blocked_filters(request.query_params)
        return Response(sprint_blocked_rollup(sprint, **filters), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Reorder the Sprint Review demo list (ADR-0118 amend, #1130)",
        request=OpenApiTypes.OBJECT,
        responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    @action(detail=True, methods=["post"], url_path="demo-list/reorder")
    def demo_list_reorder(self, request: Request, pk: str | None = None) -> Response:
        """Drag reorder of the demo walkthrough (Member+; ADR-0110 shape, #1130).

        Body: ``{"outcome_ids": ["<uuid>", ...]}`` — the *complete* set of
        demo-flagged ``SprintTaskOutcome`` ids in target walkthrough order. Writes
        dense ``demo_order`` 1..N under a row lock. Returns ``200 {"updated": <n>}``;
        ``409`` with the offending ids if the demo set changed under the client (a
        flag was toggled concurrently) so the client refetches and replays; ``400``
        on a malformed body. Gated team-owned (Member+) via the viewset's write
        permission, which checks object-level project membership on the sprint.
        """
        from trueppm_api.apps.projects.services import (
            DemoReorderConflict,
            reorder_demo_list,
        )

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"), pk=pk, is_deleted=False
        )
        self.check_object_permissions(request, sprint)

        ids = request.data.get("outcome_ids")
        if not isinstance(ids, list) or not ids:
            return Response(
                {"outcome_ids": ["This field is required and must be a non-empty list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Bound the payload (DoS guard) — a demo list is realistically a handful of
        # stories; 500 is generous headroom before the lock + parse loop.
        if len(ids) > 500:
            return Response(
                {"outcome_ids": ["Too many entries to reorder in one request (max 500)."]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        parsed: list[str] = []
        invalid: list[str] = []
        for entry in ids:
            if not isinstance(entry, str):
                invalid.append(repr(entry))
                continue
            try:
                uuid.UUID(entry)
            except ValueError:
                invalid.append(entry)
                continue
            parsed.append(entry)
        if invalid:
            return Response(
                {"outcome_ids": [f"Invalid entries (expected uuids): {', '.join(invalid)}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(set(parsed)) != len(parsed):
            return Response(
                {"outcome_ids": ["Duplicate outcome ids in the ordered list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            changed = reorder_demo_list(sprint, parsed)
        except DemoReorderConflict as exc:
            return Response(
                {"detail": "Demo list changed — reload and retry.", "conflicts": exc.ids},
                status=status.HTTP_409_CONFLICT,
            )
        return Response({"updated": changed}, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Reorder a sprint's within-sprint execution order (#365)",
        request=OpenApiTypes.OBJECT,
        responses={200: OpenApiResponse(response=OpenApiTypes.OBJECT)},
    )
    @action(detail=True, methods=["post"], url_path="reorder")
    def reorder(self, request: Request, pk: str | None = None) -> Response:
        """Drag reorder of a sprint's execution order — writes ``sprint_rank`` only (#365).

        The sprint-backlog counterpart to ``product-backlog/reorder`` (ADR-0105 §5): reordering
        for execution writes ``sprint_rank`` and never disturbs the Product Owner's
        ``priority_rank``, so the two backlogs are independently ordered.

        Body: ``{"tasks": [{"id": "<uuid>", "server_version": <int>}, ...]}`` in target
        execution order — the *complete* current sprint set. Writes dense ``sprint_rank`` 1..N,
        optimistic-locked on ``server_version``. Returns ``200 {"updated": <count>}``; ``409``
        with the offending ids if the sprint set changed under the client (a task pulled in,
        carried out, or reordered concurrently) so the client refetches and replays; ``400`` on
        a malformed body or a non-ACTIVE sprint. ``sprint_rank`` only exists for the live
        execution order, which is seeded on activate and cleared on close, so reordering is
        gated to ACTIVE sprints (Member+, via the viewset's write permission).
        """
        from trueppm_api.apps.projects.product_backlog_services import (
            SprintReorderConflict,
            reorder_sprint,
        )

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"), pk=pk, is_deleted=False
        )
        self.check_object_permissions(request, sprint)

        # sprint_rank is the *live* execution order — seeded on activate, cleared on close.
        # A PLANNED sprint hasn't been seeded (activate would overwrite a manual order from
        # priority_rank); a COMPLETED/CANCELLED sprint has had its ranks cleared. So reordering
        # is only meaningful for an ACTIVE sprint.
        if sprint.state != SprintState.ACTIVE:
            return Response(
                {"detail": "Only an active sprint's execution order can be reordered."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        tasks_data = request.data.get("tasks") if isinstance(request.data, dict) else None
        if not isinstance(tasks_data, list) or not tasks_data:
            return Response(
                {"tasks": ["This field is required and must be a non-empty list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Bound the payload before the parse loop + select_for_update (DoS guard): a sprint
        # holds at most a few dozen stories, so 2000 is generous headroom.
        if len(tasks_data) > 2000:
            return Response(
                {"tasks": ["Too many entries to reorder in one request (max 2000)."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        invalid: list[str] = []
        parsed: list[tuple[str, int]] = []
        for entry in tasks_data:
            if not isinstance(entry, dict):
                invalid.append(repr(entry))
                continue
            tid = entry.get("id")
            sv = entry.get("server_version")
            # bool is an int subclass — exclude it so {"server_version": true} is rejected.
            if not isinstance(tid, str) or not isinstance(sv, int) or isinstance(sv, bool):
                invalid.append(repr(entry))
                continue
            try:
                uuid.UUID(tid)
            except ValueError:
                invalid.append(tid)
                continue
            parsed.append((tid, sv))

        if invalid:
            bad = ", ".join(invalid)
            return Response(
                {"tasks": [f"Invalid entries (expected {{id, server_version}}): {bad}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ids = [tid for tid, _ in parsed]
        if len(set(ids)) != len(ids):
            return Response(
                {"tasks": ["Duplicate task ids in the ordered list."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            changed = reorder_sprint(sprint, parsed, request.user)
        except SprintReorderConflict as exc:
            return Response(
                {"detail": "Sprint changed — reload and retry.", "conflicts": exc.ids},
                status=status.HTTP_409_CONFLICT,
            )
        return Response({"updated": changed}, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Get a sprint's capacity summary",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Per-person and aggregate capacity for the sprint.",
            )
        },
    )
    @action(detail=True, methods=["get"])
    def capacity(self, request: Request, pk: str | None = None) -> Response:
        """Return per-person and aggregate capacity for a sprint (#228).

        Exposes every assigned member (not only over-allocated ones) plus
        aggregate totals — what the wave/10 capacity preflight panel
        renders. The activate endpoint still returns the warnings-only
        slice via ``capacity_check``.
        """
        from trueppm_api.apps.projects.services import capacity_summary

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)
        return Response(capacity_summary(sprint), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Incoming carryover preview for a PLANNED sprint",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "The prior closed sprint summary plus its unfinished tasks, each "
                    "flagged pulled_in_to_current. Empty tasks when no prior sprint."
                ),
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="incoming_carryover")
    def incoming_carryover(self, request: Request, pk: str | None = None) -> Response:
        """Read-only "what rolled forward from the prior sprint" preview (#865, ADR-0094 §3).

        Re-derives the prior closed sprint's unfinished tasks and whether each was
        pulled into this PLANNED sprint, from the immutable ``SprintTaskOutcome``
        snapshot — no mutation, no schema change. RBAC mirrors ``retrieve`` (any
        project member): the payload exposes only denormalized task identity and a
        derived boolean, never the close-time decision write.
        """
        from trueppm_api.apps.projects.services import (
            incoming_carryover as compute_incoming_carryover,
        )

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)
        return Response(compute_incoming_carryover(sprint), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Get or upsert a sprint retrospective",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "The retro, using the full or summary serializer depending on the "
                    "caller's role and the retro's team_visibility."
                ),
            ),
            403: OpenApiResponse(description="Below the role required to change visibility."),
            404: OpenApiResponse(description="No retro recorded for this sprint."),
        },
    )
    @action(detail=True, methods=["get", "post", "patch"])
    def retro(self, request: Request, pk: str | None = None) -> Response:
        """Sprint retrospective (#486 / ADR-0071).

        ``GET`` returns the retro using the visibility-aware serializer:
        callers whose role meets the retro's ``team_visibility`` threshold
        receive the full serializer (``notes``, ``action_items`` with text
        and assignees); below the threshold, a summary serializer (counts
        only) is returned. 404 when no retro exists.

        ``POST`` upserts the retro: replaces ``notes`` and the action-item
        set. Action items no longer auto-promote (sprint sovereignty per
        ADR-0071); use the explicit ``/promote/`` action below.

        ``PATCH`` partially updates the retro — currently scoped to
        ``team_visibility``. Only the retro ``created_by`` or a Project
        ADMIN+ may change visibility; lower roles get 403.

        Permissions: read = IsProjectMember; write = IsProjectMemberWrite.
        """
        from trueppm_api.apps.access.models import ProjectMembership, Role
        from trueppm_api.apps.projects.models import (
            RetroActionItem,
            RetroVisibility,
            SprintRetro,
        )
        from trueppm_api.apps.projects.serializers import (
            SprintRetroSerializer,
            SprintRetroSummarySerializer,
        )

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)

        from django.contrib.auth.models import User as _User

        caller = cast(_User, request.user)
        caller_role: int = (
            ProjectMembership.objects.filter(
                project_id=sprint.project_id, user=caller, is_deleted=False
            )
            .values_list("role", flat=True)
            .first()
            or -1
        )

        def _pick_serializer(retro_obj: SprintRetro) -> type:
            """Visibility × role gate (ADR-0071 §3).

            TEAM_ONLY → MEMBER+ sees full; VIEWER sees summary.
            PROJECT  → any project member sees full.
            ORG      → falls back to PROJECT behaviour until Program ships.
            """
            vis = retro_obj.team_visibility
            if vis == RetroVisibility.TEAM_ONLY:
                return (
                    SprintRetroSerializer
                    if caller_role >= Role.MEMBER
                    else SprintRetroSummarySerializer
                )
            return SprintRetroSerializer

        if request.method == "GET":
            # Prefetch action_items so SprintRetroSummarySerializer.get_action_items_count /
            # get_promoted_count can read the cache instead of issuing per-object COUNT
            # queries (N+1 risk on list-like surfaces that embed retro summaries).
            retro = (
                SprintRetro.objects.filter(sprint=sprint, is_deleted=False)
                # select_related the assignee on the prefetched action_items so
                # RetroActionItemSerializer.get_assignee_username doesn't N+1 on
                # the assignee FK once the full serializer renders them (#821).
                .prefetch_related(
                    db_models.Prefetch(
                        "action_items",
                        queryset=RetroActionItem.objects.select_related("assignee"),
                    )
                )
                .first()
            )
            if retro is None:
                return Response(
                    {"detail": "No retro recorded for this sprint."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            serializer_cls = _pick_serializer(retro)
            return Response(serializer_cls(retro).data, status=status.HTTP_200_OK)

        # PATCH — partial update, currently scoped to team_visibility.
        if request.method == "PATCH":
            # Prefetch action_items+assignee so the serializer response doesn't
            # N+1 per action item (P13 perf fix — mirrors the GET path above).
            retro = (
                SprintRetro.objects.filter(sprint=sprint, is_deleted=False)
                .prefetch_related(
                    db_models.Prefetch(
                        "action_items",
                        queryset=RetroActionItem.objects.select_related("assignee"),
                    )
                )
                .first()
            )
            if retro is None:
                return Response(
                    {"detail": "No retro recorded for this sprint."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            new_visibility = request.data.get("team_visibility")
            if new_visibility is not None:
                # Author or Project ADMIN+ only.
                is_author = retro.created_by_id == caller.pk
                if not is_author and caller_role < Role.ADMIN:
                    return Response(
                        {
                            "detail": (
                                "Only the retro author or a Project Admin can change visibility."
                            )
                        },
                        status=status.HTTP_403_FORBIDDEN,
                    )
                if new_visibility not in RetroVisibility.values:
                    return Response(
                        {"team_visibility": f"Invalid value '{new_visibility}'."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                retro.team_visibility = new_visibility
                retro.save(update_fields=["team_visibility", "server_version"])
                _broadcast_retro_updated(sprint)
            return Response(_pick_serializer(retro)(retro).data, status=status.HTTP_200_OK)

        # POST — upsert. Write permission already enforced via get_permissions().
        # ADR-0071: this path no longer auto-promotes. Action items land as
        # RetroActionItem rows only; the explicit /promote/ action converts
        # them to BACKLOG Tasks under sprint sovereignty.
        notes = request.data.get("notes", "")
        items_in: list[dict[str, Any]] = list(request.data.get("action_items", []) or [])
        new_visibility = request.data.get("team_visibility")

        # #1725 (security): an action-item assignee must be a live member of the
        # retro's project. ``assignee`` is set straight from the request body
        # below (this endpoint, not the read-only serializer, is the write path),
        # so without this guard any writer could point an item at ANY user id and
        # the GET response would echo back that user's real username — a
        # display-name / user-enumeration disclosure primitive. Mirrors the
        # Task.assignee guard (#684). ``AUTH_USER_MODEL`` uses integer PKs, so a
        # malformed (non-integer) id is rejected with a clean 400 rather than
        # 500-ing at the membership query or bulk_create.
        requested_assignees: set[int] = set()
        for entry in items_in:
            raw = entry.get("assignee")
            if raw in (None, ""):
                continue
            try:
                parsed = int(str(raw))
            except (ValueError, TypeError):
                parsed = -1
            # Reject anything outside the int32 PK range too: an out-of-range but
            # numerically-valid id would otherwise raise a Postgres DataError (500)
            # at the ``user_id__in`` query rather than a clean 400. No real user PK
            # can fall outside this range.
            if not 1 <= parsed <= 2_147_483_647:
                return Response(
                    {"action_items": "Each assignee id must be a valid user identifier."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            requested_assignees.add(parsed)
        if requested_assignees:
            member_ids = set(
                ProjectMembership.objects.filter(
                    project_id=sprint.project_id,
                    user_id__in=requested_assignees,
                    is_deleted=False,
                ).values_list("user_id", flat=True)
            )
            if requested_assignees - member_ids:
                return Response(
                    {"action_items": "Each assignee must be a member of this project."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        with transaction.atomic():
            defaults: dict[str, Any] = {"notes": notes, "created_by": caller}
            if new_visibility is not None:
                if new_visibility not in RetroVisibility.values:
                    return Response(
                        {"team_visibility": f"Invalid value '{new_visibility}'."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                defaults["team_visibility"] = new_visibility
            retro, _ = SprintRetro.objects.update_or_create(
                sprint=sprint,
                defaults=defaults,
            )
            # Replace the action item set on each save — retros are
            # append-on-save semantics at the meeting boundary.
            # P15: use bulk_create to replace O(N) INSERT round-trips with one.
            retro.action_items.filter(is_deleted=False).delete()
            new_items = [
                RetroActionItem(
                    retro=retro,
                    text=(entry.get("text") or "").strip(),
                    assignee_id=entry.get("assignee") or None,
                    story_points=entry.get("story_points"),
                )
                for entry in items_in
                if (entry.get("text") or "").strip()
            ]
            if new_items:
                RetroActionItem.objects.bulk_create(new_items)

        # Notes + action items just changed under any peer with the retro open
        # (#1359). Broadcast so their view refetches instead of silently desyncing
        # until a manual refresh — deferred to commit inside _broadcast_retro_updated.
        _broadcast_retro_updated(sprint)

        # P13: replace refresh_from_db() (wipes prefetch cache) with a fresh
        # fetch that prefetches action_items+assignee so the serializer doesn't
        # N+1 per action item when rendering the POST response.
        retro = (
            SprintRetro.objects.filter(sprint=sprint, is_deleted=False)
            .prefetch_related(
                db_models.Prefetch(
                    "action_items",
                    queryset=RetroActionItem.objects.select_related("assignee"),
                )
            )
            .first()
        ) or retro
        return Response(_pick_serializer(retro)(retro).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Live retro board — stickies + columns (ADR-0117 §1)",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "The board's column definitions and all live stickies for this "
                    "sprint's retro. Presence ('who is in the retro') arrives over the "
                    "project WebSocket, not this endpoint. POST creates a sticky."
                ),
            ),
        },
    )
    @action(detail=True, methods=["get", "post"], url_path="retro-board")
    def retro_board(self, request: Request, pk: str | None = None) -> Response:
        """Live multi-writer retro board (ADR-0117 §1, §7).

        ``GET`` returns ``{columns, items}`` — the fixed column template and every
        live sticky for this sprint's retro (read = any project member). ``POST``
        creates a sticky in a column (write = Member+); the resulting state is
        broadcast over the project board channel as ``retro_item_created``.
        """
        from django.contrib.auth.models import User

        from trueppm_api.apps.projects.models import RetroBoardItem, RetroColumn, SprintRetro
        from trueppm_api.apps.projects.retro_board_services import create_board_item
        from trueppm_api.apps.projects.serializers import RetroBoardItemSerializer

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"), pk=pk, is_deleted=False
        )
        self.check_object_permissions(request, sprint)

        columns = [{"key": value, "label": label} for value, label in RetroColumn.choices]

        if request.method == "GET":
            retro = SprintRetro.objects.filter(sprint=sprint, is_deleted=False).first()
            items: list[RetroBoardItem] = []
            if retro is not None:
                items = list(
                    RetroBoardItem.objects.filter(retro=retro, is_deleted=False)
                    .select_related("author", "retro__sprint")
                    .order_by("column", "position", "created_at")
                )
            return Response(
                {"columns": columns, "items": RetroBoardItemSerializer(items, many=True).data},
                status=status.HTTP_200_OK,
            )

        # POST — create a sticky. Write role already enforced via get_permissions
        # (IsProjectMemberWrite fallthrough), re-checked on the sprint object above.
        item = create_board_item(
            sprint,
            column=request.data.get("column", RetroColumn.WENT_WELL),
            text=request.data.get("text", ""),
            color=request.data.get("color", ""),
            author=cast(User, request.user),
        )
        return Response(RetroBoardItemSerializer(item).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Team-health pulse — answer (one tap) or read your own (ADR-0117 §5)",
        responses={
            200: OpenApiResponse(response=OpenApiTypes.OBJECT),
            204: OpenApiResponse(description="No response recorded yet (GET)."),
        },
    )
    @action(detail=True, methods=["get", "put"], url_path="pulse")
    def pulse(self, request: Request, pk: str | None = None) -> Response:
        """The requester's own pulse response for this sprint (#923, ADR-0117 §5).

        ``GET`` echoes the requester's own current mood/energy/confidence (or 204 if
        unanswered) so they can change it. ``PUT`` upserts it (one per person per
        sprint). Deliberately no broadcast — a pulse event would reach the PM band
        as a read-receipt (Morgan 🔴). The aggregate trend is the gated
        ``pulse-trend`` endpoint.
        """
        from django.contrib.auth.models import User

        from trueppm_api.apps.projects.retro_board_services import (
            my_pulse_response,
            upsert_pulse_response,
        )
        from trueppm_api.apps.projects.serializers import PulseResponseSerializer

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"), pk=pk, is_deleted=False
        )
        self.check_object_permissions(request, sprint)
        user = cast(User, request.user)

        if request.method == "GET":
            mine = my_pulse_response(sprint, user)
            if mine is None:
                return Response(status=status.HTTP_204_NO_CONTENT)
            return Response(PulseResponseSerializer(mine).data, status=status.HTTP_200_OK)

        response = upsert_pulse_response(
            sprint,
            respondent=user,
            mood=request.data.get("mood"),
            energy=request.data.get("energy"),
            confidence=request.data.get("confidence"),
        )
        return Response(PulseResponseSerializer(response).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Team-health pulse trend — team + coach only (ADR-0117 §5 / ADR-0104)",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Aggregate per-sprint mood/energy/confidence trend. Returns "
                    "{gated: true} with NO data for any reader outside the team's "
                    "`pulse` audience (PM/PMO by default; non-member always)."
                ),
            ),
        },
    )
    @action(detail=True, methods=["get"], url_path="pulse-trend")
    def pulse_trend(self, request: Request, pk: str | None = None) -> Response:
        """Cross-sprint pulse trend, gated by ADR-0104's `pulse` signal (the 🔴).

        The service applies ``can_read_signal(..., 'pulse')`` and returns
        ``{gated: true}`` (no count, no points) for any reader above the signal's
        audience — a redacted aggregate is no pulse.
        """
        from trueppm_api.apps.projects.retro_board_services import pulse_trend

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"), pk=pk, is_deleted=False
        )
        self.check_object_permissions(request, sprint)
        return Response(pulse_trend(request, sprint), status=status.HTTP_200_OK)

    @extend_schema(
        summary="Get the prior completed sprint's retrospective",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "The most-recent prior completed retro, using the full or summary "
                    "serializer depending on the caller's role and team_visibility."
                ),
            ),
            404: OpenApiResponse(description="No prior retrospective."),
        },
    )
    @action(
        detail=True,
        methods=["get"],
        url_path="retrospective/prior",
    )
    def retro_prior(self, request: Request, pk: str | None = None) -> Response:
        """Most-recent prior completed retro for the same project (ADR-0071 §4a).

        Returns 404 if no prior COMPLETED sprint with a retro exists. Filters
        out CANCELLED sprints — the prior context is the team's most recent
        actually-finished sprint, not the most recent of any state.
        """
        from trueppm_api.apps.access.models import ProjectMembership, Role
        from trueppm_api.apps.projects.models import (
            RetroActionItem,
            RetroVisibility,
            SprintRetro,
        )
        from trueppm_api.apps.projects.serializers import (
            SprintRetroSerializer,
            SprintRetroSummarySerializer,
        )

        sprint = get_object_or_404(
            Sprint.objects.select_related("project"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)

        # Find the most-recent prior COMPLETED sprint with a retro.
        prior = (
            Sprint.objects.filter(
                project_id=sprint.project_id,
                state=SprintState.COMPLETED,
                is_deleted=False,
                finish_date__lt=sprint.start_date,
            )
            .order_by("-finish_date")
            .first()
        )
        if prior is None:
            return Response(
                {"detail": "No prior retrospective."},
                status=status.HTTP_404_NOT_FOUND,
            )
        # P14: prefetch action_items+assignee so the serializer doesn't N+1 per
        # action item when rendering this retro (mirrors the GET path above).
        prior_retro = (
            SprintRetro.objects.filter(sprint=prior, is_deleted=False)
            .prefetch_related(
                db_models.Prefetch(
                    "action_items",
                    queryset=RetroActionItem.objects.select_related("assignee"),
                )
            )
            .first()
        )
        if prior_retro is None:
            return Response(
                {"detail": "No prior retrospective."},
                status=status.HTTP_404_NOT_FOUND,
            )

        from django.contrib.auth.models import User as _User

        caller = cast(_User, request.user)
        caller_role: int = (
            ProjectMembership.objects.filter(
                project_id=sprint.project_id, user=caller, is_deleted=False
            )
            .values_list("role", flat=True)
            .first()
            or -1
        )
        serializer_cls = (
            SprintRetroSerializer
            if prior_retro.team_visibility != RetroVisibility.TEAM_ONLY
            or caller_role >= Role.MEMBER
            else SprintRetroSummarySerializer
        )
        return Response(serializer_cls(prior_retro).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Promote a retro action item to a backlog task",
        responses={
            201: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Body includes the created task under a `task` key.",
            ),
            404: OpenApiResponse(description="Action item not found on this sprint's retro."),
            409: OpenApiResponse(
                description="Action item already promoted; body includes the existing task_id."
            ),
        },
    )
    @action(
        detail=True,
        methods=["post"],
        url_path="retrospective/action-items/promote",
    )
    def promote_action_item(
        self,
        request: Request,
        pk: str | None = None,
        item_pk: str | None = None,
    ) -> Response:
        """Promote a RetroActionItem into a project-backlog Task (ADR-0071 §2).

        The created Task is unconditionally ``status=BACKLOG, sprint=NULL``.
        Any ``sprint_id`` field in the request body is structurally ignored —
        the serializer does not accept it, so sprint sovereignty cannot be
        bypassed via this endpoint.

        Returns 409 with the existing task_id if the action item is already
        promoted (idempotent client retry).
        """
        from trueppm_api.apps.projects.models import (
            RetroActionItem,
            Task,
        )
        from trueppm_api.apps.projects.retro_services import (
            AlreadyPromotedError,
            promote_retro_action_item,
        )
        from trueppm_api.apps.projects.serializers import TaskSerializer

        if pk is None or item_pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        sprint = get_object_or_404(
            Sprint.objects.select_related("project"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)

        action_item = (
            RetroActionItem.objects.select_related("retro__sprint")
            .filter(pk=item_pk, retro__sprint=sprint, is_deleted=False)
            .first()
        )
        if action_item is None:
            return Response(
                {"detail": "Action item not found on this sprint's retrospective."},
                status=status.HTTP_404_NOT_FOUND,
            )

        from django.contrib.auth.models import User as _User

        actor = cast(_User, request.user)
        try:
            task = promote_retro_action_item(action_item, actor)
        except AlreadyPromotedError as exc:
            return Response(
                {"detail": "Already promoted.", "task_id": exc.existing_task_id},
                status=status.HTTP_409_CONFLICT,
            )
        # Reload with select_related so the TaskSerializer doesn't emit follow-up queries.
        task = Task.objects.select_related("project", "assignee", "sprint").get(pk=task.pk)
        return Response({"task": TaskSerializer(task).data}, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Pull a retro action item into a planned sprint",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Body includes the promoted-and-assigned task under a `task` key.",
            ),
            400: OpenApiResponse(description="Missing target_sprint_id or invalid pull."),
            404: OpenApiResponse(description="Action item or target sprint not found."),
        },
    )
    @action(
        detail=True,
        methods=["post"],
        url_path="retrospective/action-items/pull-to-sprint",
    )
    def pull_action_item_to_sprint(
        self,
        request: Request,
        pk: str | None = None,
        item_pk: str | None = None,
    ) -> Response:
        """Atomically promote + assign a retro action item to a PLANNED sprint.

        SCHEDULER+ gated (the only path that can put a retro action item into
        a sprint per ADR-0071 §4b). The target sprint must be in the same
        project and in PLANNED state.

        Request body: ``{"target_sprint_id": "<uuid>"}``.
        """
        from django.contrib.auth.models import User as _User

        from trueppm_api.apps.projects.models import (
            RetroActionItem,
            Task,
        )
        from trueppm_api.apps.projects.retro_services import (
            pull_carryover_item_to_sprint,
        )
        from trueppm_api.apps.projects.serializers import TaskSerializer

        if pk is None or item_pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        sprint = get_object_or_404(
            Sprint.objects.select_related("project"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)

        action_item = (
            RetroActionItem.objects.select_related("retro__sprint")
            .filter(pk=item_pk, retro__sprint=sprint, is_deleted=False)
            .first()
        )
        if action_item is None:
            return Response(
                {"detail": "Action item not found on this sprint's retrospective."},
                status=status.HTTP_404_NOT_FOUND,
            )

        target_sprint_id = request.data.get("target_sprint_id")
        if not target_sprint_id:
            return Response(
                {"target_sprint_id": "Required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        target_sprint = Sprint.objects.filter(
            pk=target_sprint_id,
            project_id=sprint.project_id,
            is_deleted=False,
        ).first()
        if target_sprint is None:
            return Response(
                {"target_sprint_id": "Sprint not found in this project."},
                status=status.HTTP_404_NOT_FOUND,
            )

        actor = cast(_User, request.user)
        try:
            task = pull_carryover_item_to_sprint(action_item, target_sprint, actor)
        except DjangoValidationError as exc:
            return Response(
                {"detail": "; ".join(exc.messages)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        task = Task.objects.select_related("project", "assignee", "sprint").get(pk=task.pk)
        return Response({"task": TaskSerializer(task).data}, status=status.HTTP_200_OK)


class SprintScopeChangeViewSet(IdempotencyMixin, viewsets.GenericViewSet[Any]):
    """Single-item accept/reject for mid-sprint scope injections (ADR-0102 §5).

    ``POST /api/v1/scope-changes/{id}/accept/`` and ``/reject/``. Authorization is
    layered: ``get_queryset`` first scopes to the caller's member projects, so a
    non-member gets a uniform 404 (no 403-vs-404 existence oracle, #996). The
    service-layer gate (``_assert_scope_gate``) then requires a real
    ProjectMembership at role>=ADMIN on the scope-change's task's project, so a
    member below ADMIN gets 403 ``scope_accept_forbidden`` *regardless of role
    ordinal* — closing the Enterprise back-door (VoC 🔴 #1) at the OSS boundary.
    There is no auto-accept path: these two actions are the only writers of
    ACCEPTED/REJECTED.
    """

    # permission_classes is intentionally just IsAuthenticated: every action
    # routes through _act -> _assert_scope_gate in the service layer, which is
    # the real authorization gate (role >= ADMIN + project membership). The
    # queryset below is the second half of that contract — it must stay scoped to
    # the caller's member projects so a non-member gets 404 (not a 403-vs-404
    # discriminator that leaks cross-project scope-change existence, #996).
    #
    # #1351 carve-out: unlike the membership and slip-conflict viewsets, this one
    # is *not* given a permission-layer role class. The service gate returns a
    # structured ``{"code": "scope_accept_forbidden", "detail": ...}`` 403 that the
    # frontend relies on (tested in test_scope_injection_approve_gate.py); a DRF
    # permission class would pre-empt the body with a plain ``{"detail": ...}`` 403
    # and break that contract. The existence oracle is already closed by the
    # member-scoped queryset above (non-members get 404), so the only caller who
    # reaches the structured 403 is a member below the bar — who can already see
    # the project exists. This mirrors the DependencyViewSet decision (ADR-0120 D2)
    # and is recorded in ADR-0184.
    permission_classes = [IsAuthenticated]

    def get_queryset(self) -> QuerySet[Any]:
        from typing import cast

        from django.contrib.auth.models import User

        from trueppm_api.apps.access.models import ProjectMembership
        from trueppm_api.apps.projects.models import SprintScopeChange

        # Scope to scope-changes on projects the caller is a member of. Without
        # this, get_object_or_404 over an unscoped .all() returns 403 (found, no
        # permission) vs 404 (absent), letting any authenticated user probe
        # whether an arbitrary scope-change UUID exists anywhere (IDOR, #996).
        # IsAuthenticated has already excluded AnonymousUser; cast narrows for mypy.
        user = cast(User, self.request.user)
        member_project_ids = ProjectMembership.objects.filter(
            user=user, is_deleted=False
        ).values_list("project_id", flat=True)
        return SprintScopeChange.objects.select_related("task", "sprint").filter(
            task__project_id__in=member_project_ids
        )

    def _act(self, request: Request, pk: str | None, *, accept: bool) -> Response:
        from trueppm_api.apps.projects.serializers import SprintScopeChangeSerializer
        from trueppm_api.apps.projects.services import (
            ScopeAcceptForbidden,
            accept_scope_change,
            reject_scope_change,
            sprint_pending_count,
        )

        scope_change = get_object_or_404(self.get_queryset(), pk=pk)
        service = accept_scope_change if accept else reject_scope_change
        try:
            result = service(scope_change, request.user)
        except ScopeAcceptForbidden:
            return Response(
                {"code": ScopeAcceptForbidden.code, "detail": ScopeAcceptForbidden.detail},
                status=status.HTTP_403_FORBIDDEN,
            )
        data = SprintScopeChangeSerializer(result).data
        # The sprint may be null after a reject only on the task; the scope-change
        # row retains sprint_id, so pending_count resolves against it.
        data["pending_count"] = sprint_pending_count(result.sprint_id)
        return Response(data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Accept a single pending scope change",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="The accepted scope-change row plus the sprint's pending_count.",
            ),
            403: OpenApiResponse(
                description="Accepting scope changes is team-owned (Admin or SM/PO facet)."
            ),
        },
    )
    @action(detail=True, methods=["post"])
    def accept(self, request: Request, pk: str | None = None) -> Response:
        """Accept a single pending scope injection into the sprint commitment."""
        return self._act(request, pk, accept=True)

    @extend_schema(
        summary="Reject a single pending scope change",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="The rejected scope-change row plus the sprint's pending_count.",
            ),
            403: OpenApiResponse(
                description="Rejecting scope changes is team-owned (Admin or SM/PO facet)."
            ),
        },
    )
    @action(detail=True, methods=["post"])
    def reject(self, request: Request, pk: str | None = None) -> Response:
        """Reject a single pending scope injection, removing the task from the sprint."""
        return self._act(request, pk, accept=False)


@extend_schema_view(
    get=extend_schema(
        summary="The current user's recently-visited projects",
        responses={200: RecentProjectSerializer(many=True)},
    )
)
class MeRecentProjectsView(APIView):
    """``GET /api/v1/me/recent-projects/`` — the ⌘K "Recent" group (ADR-0508, #1557).

    Returns the caller's most recently *visited* projects (from the
    :class:`~trueppm_api.apps.profiles.models.ProjectVisit` telemetry, ADR-0150),
    newest-first, as a fixed navigation strip — default 5, hard max 10 via
    ``?limit``. Not a search surface and not paginated.

    **RBAC contract**: hard-scoped to ``request.user``'s own visit rows, and each
    row is re-joined to live project membership in
    ``services.recent_projects`` so a project the user lost access to (revoked
    membership, archive, delete) never leaks its name from a stale visit. There is
    no ``?user=`` escape hatch — the endpoint is per-user private telemetry, never
    a cross-user surveillance surface (mirrors ``MeWorkView``).
    """

    permission_classes = [IsAuthenticated]

    def get(self, request: Request) -> Response:
        from trueppm_api.apps.profiles.services import recent_projects

        try:
            limit = int(request.query_params.get("limit", 5))
        except (TypeError, ValueError):
            limit = 5
        visits = recent_projects(request.user, limit=limit)
        return Response(RecentProjectSerializer(visits, many=True).data, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Global cross-program Epic/Story omni-search (ADR-0508 D4, #2103)
# ---------------------------------------------------------------------------

# The agile-taxonomy values the palette omni-search understands. Each maps 1:1 onto
# a ``TaskType`` and a ``BacklogItemType`` value (they share the string literals), so
# one requested set filters both sources uniformly.
_OMNI_SEARCH_TYPES: dict[str, tuple[str, str]] = {
    "epic": (TaskType.EPIC, BacklogItemType.EPIC),
    "story": (TaskType.STORY, BacklogItemType.STORY),
    "task": (TaskType.TASK, BacklogItemType.TASK),
}
# Default result kinds when ``?type`` is absent — the marquee "Epic ▸ Story" ask
# (ADR-0508 D4). ``task`` is opt-in via ``?type=…,task`` so a cold search never
# dumps every plain task the user can see.
_OMNI_SEARCH_DEFAULT_TYPES = ("epic", "story")
# Minimum query length. A one-character search is not selective enough to be useful
# and would scan a large fraction of the trigram index; mirror the user_search /
# board-search floor.
_OMNI_SEARCH_MIN_Q = 2
# DoS guard: cap the term length so a pathological string cannot force an unbounded
# ILIKE scan (mirrors the board search's raw_q[:100]).
_OMNI_SEARCH_MAX_Q = 100
# Per-source scan bound. Each of the two membership-scoped queries returns at most
# this many rows before the in-Python merge/rank; the merged, ranked list is then
# paginated. A search palette reads the first page only, so a bounded top-N is the
# right trade — it keeps the endpoint's DB work O(scan_cap) regardless of how many
# epics/stories the term matches across every project the user can see.
_OMNI_SEARCH_SCAN_CAP = 100


class MeSearchView(McpReadableViewMixin, APIView):
    """``GET /api/v1/me/search/`` — global cross-program Epic/Story omni-search (ADR-0508 D4).

    The ⌘K palette's Epic/Story result type (the marquee #1557 VoC ask). Spans two
    sources with **different** RBAC scopes and merges them into one ranked, paginated
    list, each row carrying an **agile-vocabulary** breadcrumb (program / project /
    parent epic) — never a WBS code (the Product-Owner persona's hard-NO):

    * committed ``Task`` rows of type EPIC / STORY / TASK — **project-membership** scope;
    * program ``BacklogItem`` intake rows — **program-membership** scope.

    **🔴 RBAC / IDOR contract**: every row is filtered to the requesting user's *live*
    membership — a ``Task`` only via ``project__memberships__user`` (project not
    deleted, membership not deleted) and a ``BacklogItem`` only via
    ``program__memberships__user`` (program not deleted, membership not deleted). There
    is no ``?user=`` / ``?project=`` / ``?program=`` escape hatch: the search is keyed
    on ``request.user`` alone, so it can never surface an epic/story/backlog title from
    a project or program the caller is not a member of. Mirrors the membership
    re-filter of ``MeWorkView`` / ``/me/recent-projects/``.

    **Query params**:
      * ``q`` — the search term. Fewer than :data:`_OMNI_SEARCH_MIN_Q` characters
        (after trim) returns an empty page; the term is truncated to
        :data:`_OMNI_SEARCH_MAX_Q` characters as a DoS guard.
      * ``type`` — comma-separated agile kinds to include, from
        ``epic`` / ``story`` / ``task``. Unknown values are ignored; an empty/absent
        value defaults to ``epic,story`` (:data:`_OMNI_SEARCH_DEFAULT_TYPES`).
      * ``page`` — standard DRF page number over the merged result list.

    **Response**: the standard ``{count, next, previous, results}`` envelope where each
    result is an :class:`~trueppm_api.apps.projects.serializers.OmniSearchResultSerializer`
    row. Results are bounded to the top :data:`_OMNI_SEARCH_SCAN_CAP` matches per source
    (a search palette reads only the first page), ranked title-prefix-first then
    alphabetically.

    **API-first / agent**: ``McpReadableViewMixin`` exposes the read to a personal
    ``mcp:read`` token so an MCP agent can resolve "find the Login epic" under its own
    owner-scoped token — the resolution fact is not stranded in the web client.
    """

    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    # A per-keystroke (debounced) search surface; bound it like the other
    # typeahead/search endpoints so one account cannot bulk-enumerate titles.
    throttle_scope = "omni_search"

    def _requested_types(self) -> list[str]:
        raw = self.request.query_params.get("type")
        if raw is None:
            return list(_OMNI_SEARCH_DEFAULT_TYPES)
        requested = [t.strip().lower() for t in raw.split(",") if t.strip()]
        # Preserve the caller's set but drop anything we don't support; fall back to
        # the default when the filter is present but names nothing we recognize.
        allowed = [t for t in requested if t in _OMNI_SEARCH_TYPES]
        return allowed or list(_OMNI_SEARCH_DEFAULT_TYPES)

    def _task_results(self, user_pk: Any, q: str, types: list[str]) -> list[dict[str, Any]]:
        task_types = [_OMNI_SEARCH_TYPES[t][0] for t in types]
        rows = (
            Task.objects.filter(
                type__in=task_types,
                name__icontains=q,
                is_deleted=False,
                project__is_deleted=False,
                # The 🔴 IDOR gate: live project membership only.
                project__memberships__user_id=user_pk,
                project__memberships__is_deleted=False,
            )
            # Fold the whole breadcrumb (project → program, parent epic) in one query
            # so building the rows below is N+1-free.
            .select_related("project", "project__program", "parent_epic")
            .distinct()[:_OMNI_SEARCH_SCAN_CAP]
        )
        results: list[dict[str, Any]] = []
        for task in rows:
            program = task.project.program
            parent_epic = task.parent_epic
            results.append(
                {
                    "id": str(task.id),
                    "kind": "task",
                    "type": task.type,
                    "title": task.name,
                    "program_id": str(program.id) if program else None,
                    "program_name": program.name if program else None,
                    "project_id": str(task.project_id),
                    "project_name": task.project.name,
                    "parent_epic_id": str(parent_epic.id) if parent_epic else None,
                    "parent_epic_name": parent_epic.name if parent_epic else None,
                }
            )
        return results

    def _backlog_results(self, user_pk: Any, q: str, types: list[str]) -> list[dict[str, Any]]:
        item_types = [_OMNI_SEARCH_TYPES[t][1] for t in types]
        rows = (
            BacklogItem.objects.filter(
                item_type__in=item_types,
                title__icontains=q,
                is_deleted=False,
                program__is_deleted=False,
                # The 🔴 IDOR gate: live program membership only.
                program__memberships__user_id=user_pk,
                program__memberships__is_deleted=False,
            )
            .select_related("program")
            .distinct()[:_OMNI_SEARCH_SCAN_CAP]
        )
        return [
            {
                "id": str(item.id),
                "kind": "backlog_item",
                "type": item.item_type,
                "title": item.title,
                "program_id": str(item.program_id),
                "program_name": item.program.name,
                # A backlog item is program-level intake, not yet pulled into any
                # project — so it has no project or parent-epic breadcrumb.
                "project_id": None,
                "project_name": None,
                "parent_epic_id": None,
                "parent_epic_name": None,
            }
            for item in rows
        ]

    @extend_schema(
        summary="Global cross-program Epic/Story omni-search",
        parameters=[
            OpenApiParameter(
                name="q",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                description=(
                    "Search term. Fewer than 2 characters returns an empty page; "
                    "truncated to 100 characters."
                ),
            ),
            OpenApiParameter(
                name="type",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                description=(
                    "Comma-separated agile kinds to include, from epic,story,task. "
                    "Absent defaults to epic,story."
                ),
            ),
        ],
        responses={200: OmniSearchResultSerializer(many=True)},
    )
    def get(self, request: Request) -> Response:
        # IsAuthenticated guarantees a concrete user; ``or -1`` keeps mypy happy about
        # the ``int | None`` from ``.pk`` (matches MeWorkView) and can never match a
        # real membership row at runtime.
        user_pk = request.user.pk or -1

        raw_q = (request.query_params.get("q") or "").strip()
        paginator = pagination.PageNumberPagination()
        if len(raw_q) < _OMNI_SEARCH_MIN_Q:
            # A merged Python list, not a QuerySet, is a valid paginate_queryset
            # argument (Django's Paginator accepts sequences); the stub types the
            # first arg as QuerySet, hence the ignore (mirrors the task-activity
            # feed pagination).
            empty: list[dict[str, Any]] = []
            page: list[Any] | None = paginator.paginate_queryset(empty, request, view=self)  # type: ignore[arg-type]
            return paginator.get_paginated_response(
                OmniSearchResultSerializer(page or [], many=True).data
            )
        q = raw_q[:_OMNI_SEARCH_MAX_Q]
        types = self._requested_types()

        merged = self._task_results(user_pk, q, types) + self._backlog_results(user_pk, q, types)
        # Rank: exact prefix matches first (what the user most likely means), then
        # alphabetically, then id for a stable total order across pages.
        lowered = q.lower()
        merged.sort(
            key=lambda r: (
                0 if r["title"].lower().startswith(lowered) else 1,
                r["title"].lower(),
                r["id"],
            )
        )

        page = paginator.paginate_queryset(merged, request, view=self)  # type: ignore[arg-type]
        return paginator.get_paginated_response(
            OmniSearchResultSerializer(page or [], many=True).data
        )


@extend_schema_view(
    get=extend_schema(
        summary="Multi-team active-sprints lens for the current user",
        responses={
            200: OpenApiResponse(
                response=MeActiveSprintCardSerializer(many=True),
                description=(
                    "Array of per-project summary cards, one for each project where "
                    "the caller owns a non-complete task in that project's ACTIVE "
                    "sprint. Each entry carries `{project_id, project_name, sprint, "
                    "capacity_ratio, capacity_label, velocity}`, where `sprint` "
                    "holds the burndown snapshot (day N of M, points remaining, "
                    "trend) and `velocity` the rolling forecast range. Sorted "
                    "most-behind first. Empty array when the user has no active "
                    "sprint work."
                ),
            )
        },
    )
)
class MeActiveSprintsView(APIView):
    """``GET /api/v1/me/active-sprints/`` — multi-team Sprints lens (#230).

    Returns a summary entry for every project where the requesting user has
    a non-complete task assignment in that project's currently-ACTIVE
    sprint. Frontends use this to render the multi-team Sprints lens
    without iterating ``/projects/`` and ``/sprints/`` per project.

    Each entry includes enough data to render a card without follow-up
    requests: sprint name + window + day-N-of-M, points remaining, capacity
    ratio + label, and the rolling-velocity forecast range. The user's
    project membership is implicit — if they are assigned to a task they
    are at minimum a Member.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request: Request) -> Response:
        from trueppm_api.apps.projects.services import (
            capacity_summaries_for_sprints,
            velocity_summary,
        )

        # Find every (project, sprint) pair where the user owns a non-complete
        # task in the currently-ACTIVE sprint.
        active_pairs = (
            Task.objects.filter(
                assignee_id=request.user.pk,
                is_deleted=False,
                sprint__state=SprintState.ACTIVE,
                sprint__is_deleted=False,
            )
            .exclude(status=TaskStatus.COMPLETE)
            .values("project_id", "sprint_id")
            .distinct()
        )

        sprint_ids = {row["sprint_id"] for row in active_pairs}
        if not sprint_ids:
            return Response([], status=status.HTTP_200_OK)

        from trueppm_api.apps.projects.models import SprintBurnSnapshot

        sprints = list(
            Sprint.objects.filter(pk__in=sprint_ids, is_deleted=False)
            .select_related("project", "project__calendar", "target_milestone")
            # Prefetch the most-recent burn snapshot per sprint so the loop
            # below can read `sprint._latest_snapshot` without one extra query
            # per sprint.  to_attr names the list; we take [0] when non-empty.
            .prefetch_related(
                db_models.Prefetch(
                    "burn_snapshots",
                    queryset=SprintBurnSnapshot.objects.order_by("-snapshot_date"),
                    to_attr="_latest_snapshot_list",
                )
            )
            .order_by("project__name")
        )

        # One TaskResource query for every sprint's capacity instead of one per
        # sprint (#1012); project__calendar is select_related above so the shared
        # capacity helper's calendar read doesn't re-introduce a per-sprint query.
        capacities = capacity_summaries_for_sprints(sprints)

        today = timezone.localdate()
        results: list[dict[str, Any]] = []
        velocity_cache: dict[str, dict[str, Any]] = {}
        for sprint in sprints:
            window = (sprint.finish_date - sprint.start_date).days + 1
            elapsed = (today - sprint.start_date).days + 1
            day = max(1, min(elapsed, window))

            committed = sprint.committed_points or 0
            snapshot_list: list[Any] = getattr(sprint, "_latest_snapshot_list", [])
            remaining = snapshot_list[0].remaining_points if snapshot_list else committed
            ideal_now = committed * (1 - day / window) if window > 0 else 0
            trend_pts = round(ideal_now - remaining)  # positive = ahead

            cap = capacities[sprint.pk]
            project_id = str(sprint.project_id)
            if project_id not in velocity_cache:
                velocity_cache[project_id] = velocity_summary(sprint.project_id)
            vel = velocity_cache[project_id]

            results.append(
                {
                    "project_id": project_id,
                    "project_name": sprint.project.name,
                    "sprint": {
                        "id": str(sprint.pk),
                        "name": sprint.name,
                        "short_id_display": f"SP-{sprint.short_id}" if sprint.short_id else "",
                        "start_date": sprint.start_date.isoformat(),
                        "finish_date": sprint.finish_date.isoformat(),
                        "day": day,
                        "total": window,
                        "remaining_points": remaining,
                        "committed_points": committed,
                        "trend_pts": trend_pts,
                    },
                    "capacity_ratio": cap["totals"]["ratio"],
                    "capacity_label": cap["totals"]["label"],
                    "velocity": {
                        "rolling_avg_points": vel["rolling_avg_points"],
                        "forecast_range_low": vel["forecast_range_low"],
                        "forecast_range_high": vel["forecast_range_high"],
                    },
                }
            )

        # Sort by burndown deviation, most-behind first; on_track sprints
        # fall to the bottom so the UI shows urgency without a manual sort.
        results.sort(key=lambda r: r["sprint"]["trend_pts"])
        return Response(results, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# My Work — cross-project contributor surface (ADR-0065 Gap 2, issue #499)
# ---------------------------------------------------------------------------


class MeWorkPagination(pagination.LimitOffsetPagination):
    """Limit/offset pagination for the My Work cross-project list.

    DRF's ``CursorPagination`` filters subsequent pages on the *leading*
    ordering field only. The architect-specified sort has ``_in_active_sprint``
    (a binary 0/1 annotation) as the leading field, which makes the cursor
    filter ``_in_active_sprint > <last value>`` silently return zero rows on
    page 2. Limit/offset preserves the full multi-key sort intact across
    pages.

    The trade-off — concurrent inserts can shift offsets and produce
    duplicates or skips at page boundaries — is acceptable for this surface:
    Priya's task list rarely changes mid-scroll, and the matching sort that
    groups the UI's active-sprint rendering is more valuable than absolute
    pagination stability.

    Default page size 100; clients may request smaller via ``?limit=`` but
    not larger than 200.
    """

    default_limit = 100
    max_limit = 200


class MeWorkView(McpReadableViewMixin, generics.ListAPIView[Task]):
    """``GET /api/v1/me/work/`` — contributor's flat task list across all projects.

    Returns the requesting user's assigned, non-BACKLOG, non-soft-deleted tasks,
    each tagged with a server-computed ``group`` bucket (today / this_sprint /
    upcoming, #484/ADR-0122) and pre-sorted so the buckets are contiguous.
    Deliberately flat — no CPM fields, no WBS hierarchy, no phase tree. The
    contributor (Priya persona) reads this as a personal to-do list; PM-level
    concepts (critical path, float, schedule variance) are intentionally absent.

    **RBAC contract (Morgan's sprint-sovereignty requirement)**: the queryset is
    hard-scoped to ``assignee=request.user`` *and* re-checks project membership
    via ``project__memberships``. There is no ``?user=`` escape hatch — a PM-role
    or admin caller gets a 200 with their *own* assigned tasks (which may be
    empty). The endpoint cannot be used as a manager surveillance surface.

    Status updates flow through the existing ``PATCH /api/v1/tasks/{id}/`` path,
    not through this endpoint. Clients should send ``X-Source: my_work`` on the
    PATCH so the webhook payload carries the originating surface.

    Response shape::

        {
            "results": [{ ...flat task fields... }],
            "next": "<cursor>" | null,
            "previous": "<cursor>" | null,
            "active_sprints": [{ ...minimal sprint card... }],
            "due_today_count": 3,
            "server_version_high_water": 12345,
            "signals": { ...cross-program focus-card aggregates, #1236... },
            "external_items": [{ ...read-only Jira/etc. item, #1422... }],
            "external_sources": [{ ...connected-source freshness, #1422... }]
        }

    ``external_items`` / ``external_sources`` (#1422, ADR-0097 §4) surface the
    user's read-only external work items (their assigned Jira issues) alongside
    native tasks in one feed. Like ``signals``, both are first-page-only side
    blocks (the bounded ≤500 personal cache is not paginated with ``results``)
    and always present on page 1 (possibly empty). An external item is never a
    Task — it carries no schedule/board/write fields.

    ``signals`` (#1236, ADR-0221) rolls up per-user cross-program aggregates for
    the focus cards — schedule health / SPI, a Monte-Carlo P80 ship-date forecast,
    a real sprint burndown series, and the caller's own load-vs-capacity for the
    lead sprint (``utilization``, #1912) — over the user's own member projects.
    Each sub-key appears only when a real server-side computation backs it (rule
    120: no fabrication), and only on the first page. See
    ``services.me_work_signals``.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = MeWorkTaskSerializer
    pagination_class = MeWorkPagination

    def get_queryset(self) -> QuerySet[Task]:
        from django.db.models import Case, DateField, IntegerField, Value, When
        from django.db.models.functions import Coalesce

        # IsAuthenticated guarantees request.user is a real User (not Anonymous)
        # by the time this runs. Filter by ``user.pk`` rather than the instance
        # so the type-checker sees a concrete int/UUID and not the ``User |
        # AnonymousUser`` DRF union — matches MeActiveSprintsView. The
        # ``or -1`` keeps mypy happy about the ``int | None`` from .pk; the
        # value can't be None at runtime because IsAuthenticated rejected
        # anonymous callers earlier in the request lifecycle.
        user_pk = self.request.user.pk or -1
        today = timezone.localdate()
        return (
            Task.objects.filter(
                assignee_id=user_pk,
                is_deleted=False,
                project__is_deleted=False,
                project__memberships__user_id=user_pk,
                project__memberships__is_deleted=False,
            )
            .exclude(status=TaskStatus.BACKLOG)
            # ``project__program`` joins the program in the same query so the
            # serializer's program_name/program_color (#964) don't fire a
            # per-row lookup (N+1). project + sprint were already joined.
            .select_related("project", "sprint", "project__program")
            .annotate(
                _sort_date=Coalesce("planned_start", "early_start"),
                # Same due cascade the serializer's ``due`` field uses (ADR-0065),
                # so the bucket boundary matches the date the UI shows.
                _due=Coalesce(
                    "actual_finish",
                    "planned_start",
                    "early_finish",
                    "sprint__finish_date",
                    output_field=DateField(),
                ),
                # Blocked-first ordering within a group (#484): the human blocker
                # flag is the most urgent thing a contributor needs to see.
                _blocked=Case(
                    When(~Q(blocked_reason=""), then=Value(0)),
                    default=Value(1),
                    output_field=IntegerField(),
                ),
            )
            # ``_group_rank`` references the ``_due`` alias, so it must be a second
            # annotate() pass — Django cannot reference an alias defined in the same
            # call. 0=Today (due today or overdue and not done), 1=This Sprint (in
            # the active sprint), 2=Upcoming (everything else). Serializer maps the
            # rank → the contributor-facing bucket name.
            .annotate(
                _group_rank=Case(
                    When(
                        Q(_due__lte=today) & ~Q(status=TaskStatus.COMPLETE),
                        then=Value(0),
                    ),
                    When(sprint__state=SprintState.ACTIVE, then=Value(1)),
                    default=Value(2),
                    output_field=IntegerField(),
                ),
            )
            .order_by("_group_rank", "_blocked", "_sort_date", "priority_rank", "id")
        )

    @extend_schema(
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Paginated flat task list for the requesting contributor across "
                    "all their projects, wrapped with sprint and freshness metadata: "
                    "{results: [<flat task>], next, previous, active_sprints: "
                    "[<minimal sprint card>], due_today_count, "
                    "server_version_high_water, retro_action_items, signals, "
                    "external_items, external_sources}. "
                    "`signals` (#1236) carries cross-program focus-card aggregates — "
                    "`schedule_health`, `forecast` (Monte-Carlo P80), "
                    "`sprint_burndown`, and `utilization` (the caller's own "
                    "load-vs-capacity for the lead sprint, #1912) — each present "
                    "only when a real server-side computation backs it (rule 120), "
                    "and only on the first page. "
                    "`external_items`/`external_sources` (#1422) are the user's "
                    "read-only external work items (Jira etc.) and connected-source "
                    "freshness, also first-page-only."
                ),
            ),
        },
    )
    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Wrap the paginated list with active_sprints + due_today_count + cursor."""
        from django.db.models import Count, DateField
        from django.db.models.functions import Coalesce

        # See ``get_queryset`` for the ``or -1`` rationale.
        user_pk = request.user.pk or -1

        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        serializer = self.get_serializer(page if page is not None else queryset, many=True)

        # Active sprints the user has tasks in — minimal card data only. Burndown
        # and capacity ratio live on /me/active-sprints/; here we only need what
        # the section header in the UI renders.
        active_sprints_qs = (
            Sprint.objects.filter(
                is_deleted=False,
                state=SprintState.ACTIVE,
                project__is_deleted=False,
                project__memberships__user_id=user_pk,
                project__memberships__is_deleted=False,
                tasks__assignee_id=user_pk,
                tasks__is_deleted=False,
            )
            .exclude(tasks__status=TaskStatus.BACKLOG)
            .annotate(
                task_count=Count(
                    "tasks",
                    filter=(
                        Q(tasks__assignee_id=user_pk)
                        & Q(tasks__is_deleted=False)
                        & ~Q(tasks__status=TaskStatus.BACKLOG)
                    ),
                    distinct=True,
                )
            )
            # ``project__calendar`` is joined so the utilization signal's
            # ``capacity_summary(lead_sprint)`` (#1912) reads the sprint calendar
            # from this fetch instead of firing a separate lazy query.
            .select_related("project", "project__calendar")
            .distinct()
            .order_by("finish_date")
        )

        # Due-today count — drives the Sidebar "My Work" badge. Coalesce the
        # same cascade the serializer's `due` field uses so the count matches
        # exactly what the UI shows.
        today = timezone.localdate()
        due_today_count = (
            Task.objects.filter(
                assignee_id=user_pk,
                is_deleted=False,
                project__is_deleted=False,
                project__memberships__user_id=user_pk,
                project__memberships__is_deleted=False,
            )
            .exclude(status__in=[TaskStatus.BACKLOG, TaskStatus.COMPLETE])
            .annotate(
                _due=Coalesce(
                    "actual_finish",
                    "planned_start",
                    "early_finish",
                    "sprint__finish_date",
                    output_field=DateField(),
                )
            )
            .filter(_due=today)
            .count()
        )

        # High-water mark for offline delta sync — the largest server_version
        # in the user's currently-visible task set. Mobile clients persist this
        # and pass it on the next pull as ``?since=`` to fetch only changes.
        server_version_high_water = queryset.aggregate(_max=Max("server_version"))["_max"] or 0

        # Materialize once: the serializer reads it and the cross-program signal
        # rollup (#1236) reuses the same Sprint rows to pick the lead sprint, so
        # the burndown signal costs no extra active-sprint query.
        active_sprints_list = list(active_sprints_qs)
        active_sprints_payload = MeWorkActiveSprintSerializer(active_sprints_list, many=True).data

        # Cross-program focus-card signals (#1236, ADR-0221). Bounded grouped
        # queries over the user's member projects, so compute them only on the
        # first page — the web reads aggregates from page 1 and this keeps the
        # ~7 extra queries off every infinite-scroll page. The ``signals`` KEY is
        # therefore a stable first-page fact: it is ALWAYS present on page 1 (an
        # empty ``{}`` when nothing is backable) and absent on later pages, so the
        # web binds one shape. Each *sub*-key inside it appears only when a real
        # server-side computation backs it (rule 120: honest omission, never a
        # fabricated number).
        is_first_page = self.paginator is None or getattr(self.paginator, "offset", 0) == 0
        me_work_signals_payload: dict[str, Any] = {}
        # Read-only external items (Jira etc.) surfaced alongside native tasks
        # (#1422, ADR-0097 §4). First-page-only side-blocks, same lifecycle as
        # ``signals``: the bounded (≤500 per source) personal cache is not
        # paginated with the task ``results``; the web reads both from page 1. Kept
        # in the integrations app so the read-only isolation invariant does not
        # leak into projects — this view never touches ExternalWorkItem directly.
        external_blocks: dict[str, Any] = {}
        if is_first_page:
            from trueppm_api.apps.integrations.me_work import me_work_external_blocks
            from trueppm_api.apps.projects.services import me_work_signals

            me_work_signals_payload = me_work_signals(request.user, active_sprints_list, today)
            external_blocks = me_work_external_blocks(request.user)

        # Retro action items relevant to this user (ADR-0071 §4c):
        #   - Suggestions PENDING for this user
        #   - Action items whose promoted Task is assigned to this user AND not COMPLETE
        retro_items_payload = _me_work_retro_action_items(request.user)

        if page is not None:
            paginated = self.get_paginated_response(serializer.data).data
            assert isinstance(paginated, dict)
            paginated["active_sprints"] = active_sprints_payload
            paginated["due_today_count"] = due_today_count
            paginated["server_version_high_water"] = server_version_high_water
            paginated["retro_action_items"] = retro_items_payload
            # First page: always include the key (even ``{}``) for a stable shape.
            # Later pages omit it — the web reads signals from page 1 only.
            if is_first_page:
                paginated["signals"] = me_work_signals_payload
                # external_items/external_sources ride the same first-page-only
                # contract (always present, possibly empty). #1422.
                paginated.update(external_blocks)
            return Response(paginated, status=status.HTTP_200_OK)

        return Response(
            {
                "results": serializer.data,
                "next": None,
                "previous": None,
                "active_sprints": active_sprints_payload,
                "due_today_count": due_today_count,
                "server_version_high_water": server_version_high_water,
                "retro_action_items": retro_items_payload,
                "signals": me_work_signals_payload,
                **external_blocks,
            },
            status=status.HTTP_200_OK,
        )


def _me_work_retro_action_items(user: Any) -> list[dict[str, Any]]:
    """Build the ``retro_action_items`` payload for ``GET /me/work/`` (ADR-0071 §4c).

    Two row sources merged into a single ordered list (most recent retro first):
      - PENDING TaskSuggestedAssignee rows where ``suggested_user = user`` →
        ``suggestion_state = "suggested"``.
      - RetroActionItem rows whose promoted Task is assigned to ``user`` and
        whose Task status is not COMPLETE → ``suggestion_state = "owned"``.

    Items appear at most once (suggestion takes precedence over owned). Owned
    items whose Task is in a sprint do not show here — those already appear in
    the user's My Work sprint groups.
    """
    from trueppm_api.apps.projects.models import (
        RetroActionItem,
        SuggestionState,
        Task,
        TaskStatus,
        TaskSuggestedAssignee,
    )

    today = timezone.now().date()
    rows: list[dict[str, Any]] = []
    seen_task_ids: set[uuid.UUID] = set()

    # PENDING suggestions for this user.
    suggestion_rows = (
        TaskSuggestedAssignee.objects.filter(
            suggested_user=user,
            state=SuggestionState.PENDING,
            is_deleted=False,
        )
        # P6: add suggested_user so TaskSuggestedAssigneeSerializer.get_suggested_user_username
        # doesn't fire a per-row User query (suggested_by was already covered).
        .select_related("task", "suggested_by", "suggested_user")
        .order_by("-created_at")
    )
    # Resolve action items via reverse lookup on promoted_task_id (one query).
    suggested_task_ids = [s.task_id for s in suggestion_rows]
    items_by_task_id: dict[uuid.UUID, RetroActionItem] = {}
    if suggested_task_ids:
        for it in RetroActionItem.objects.filter(
            promoted_task_id__in=suggested_task_ids, is_deleted=False
        ).select_related("retro__sprint"):
            # promoted_task_id is non-null by the filter above; satisfy mypy.
            if it.promoted_task_id is not None:
                items_by_task_id[it.promoted_task_id] = it

    for s in suggestion_rows:
        action_item = items_by_task_id.get(s.task_id)
        if action_item is None:
            continue  # task isn't from a retro — skip
        from_sprint = action_item.retro.sprint
        rows.append(
            {
                "suggestion_state": "suggested",
                "suggestion_id": str(s.pk),
                "task_id": str(s.task_id),
                "task_status": s.task.status,
                "task_short_id": s.task.short_id,
                "text": action_item.text,
                "from_retro_id": str(action_item.retro_id),
                "from_sprint_id": str(from_sprint.pk),
                "from_sprint_short_id": from_sprint.short_id,
                "suggested_by_id": s.suggested_by_id,
                "suggested_by_username": (
                    getattr(s.suggested_by, "username", None) if s.suggested_by_id else None
                ),
                "reason": s.reason,
                "age_days": (today - action_item.created_at.date()).days,
                "story_points": action_item.story_points,
            }
        )
        seen_task_ids.add(s.task_id)

    # Owned retro action items: promoted Task is assigned to user, not COMPLETE,
    # and not in any sprint (sprint-tracked owned items already show in the
    # sprint groups of My Work — surface only the orphan-backlog retro items
    # here to avoid double-counting).
    #
    # Scope to the requesting user's member projects so this query is bounded
    # by the user's membership set rather than the entire org.  Without this
    # scope the filter scans every non-deleted RetroActionItem in the DB
    # regardless of project, which is O(all retros × all action items) and
    # dominates GET /me/work/ latency on multi-tenant deployments.
    member_project_ids = list(
        ProjectMembership.objects.filter(user=user, is_deleted=False).values_list(
            "project_id", flat=True
        )
    )
    owned_items = RetroActionItem.objects.filter(
        promoted_task_id__isnull=False,
        is_deleted=False,
        retro__sprint__project_id__in=member_project_ids,
    ).select_related("retro__sprint")
    owned_task_ids = [it.promoted_task_id for it in owned_items if it.promoted_task_id]
    owned_tasks: dict[uuid.UUID, Task] = {}
    if owned_task_ids:
        for task in Task.objects.filter(
            pk__in=owned_task_ids,
            assignee=user,
            sprint__isnull=True,
            is_deleted=False,
        ).exclude(status=TaskStatus.COMPLETE):
            owned_tasks[task.pk] = task

    for it in owned_items:
        if it.promoted_task_id not in owned_tasks:
            continue
        if it.promoted_task_id in seen_task_ids:
            continue
        task = owned_tasks[it.promoted_task_id]
        from_sprint = it.retro.sprint
        rows.append(
            {
                "suggestion_state": "owned",
                "suggestion_id": None,
                "task_id": str(task.pk),
                "task_status": task.status,
                "task_short_id": task.short_id,
                "text": it.text,
                "from_retro_id": str(it.retro_id),
                "from_sprint_id": str(from_sprint.pk),
                "from_sprint_short_id": from_sprint.short_id,
                "suggested_by_id": None,
                "suggested_by_username": None,
                "reason": "",
                "age_days": (today - it.created_at.date()).days,
                "story_points": it.story_points,
            }
        )

    return rows


@extend_schema_view(
    get=extend_schema(
        summary="Velocity summary — last 8 closed sprints plus rolling stats",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Velocity summary object: the per-sprint completed-points series "
                    "plus `rolling_avg_points` and the `forecast_range_low`/"
                    "`forecast_range_high` band. Under the ADR-0104 velocity privacy "
                    "gate the detail (series + rolling points) is stripped for "
                    "requesters below the velocity audience."
                ),
            )
        },
    )
)
class ProjectVelocityView(APIView):
    """``GET /api/v1/projects/<pk>/velocity/`` — last 8 closed sprints + stats."""

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import velocity_summary
        from trueppm_api.apps.projects.signal_privacy_services import (
            can_read_signal,
            suppress_velocity_summary,
        )

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        summary = velocity_summary(project.pk)
        # ADR-0104 §2.1: strip the team-private velocity detail (series + rolling
        # points) when the requester's tier is below the velocity audience. At the
        # TEAM default every member passes, so the payload is byte-for-byte
        # unchanged from before this gate existed — only a non-member, or a team
        # that opted velocity up, triggers suppression.
        if not can_read_signal(request, project.pk, "velocity"):
            summary = suppress_velocity_summary(summary)
        return Response(summary, status=status.HTTP_200_OK)


@extend_schema(
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "Tier-3 sprint-health signals (ADR-0101 §4). "
                "{signals: [{key, count, tone, detail}]} — only tripped signals "
                "are present (orphan tasks, active sprint spanning ≥3 phases, "
                "parent tasks in a sprint). `tone` is info|warn; `detail` is the "
                "server-owned consequence copy the client renders verbatim. "
                "Empty list when the project is healthy."
            ),
        ),
        404: OpenApiResponse(response=OpenApiTypes.OBJECT, description="Project does not exist."),
    },
)
class ProjectSprintHealthView(McpReadableViewMixin, APIView):
    """``GET /api/v1/projects/<pk>/sprint-health/`` — server-owned Tier-3 signals (#988).

    The Sprints view's read-only hygiene badges (orphan tasks, active-sprint phase
    span, parent tasks in a sprint) were derived in the browser, re-parsing WBS
    dot-paths and synthesizing their own copy (violating web-rule 141). This
    endpoint moves the count, threshold, tone, and consequence copy server-side so
    the verdict is identical for any API client and the web renders it verbatim.

    Permission: Member (any role ≥ Viewer) — a team+coach surface, not velocity.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import sprint_health

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        return Response(sprint_health(project.pk), status=status.HTTP_200_OK)


class ProjectForecastView(McpReadableViewMixin, APIView):
    """``GET /api/v1/projects/<pk>/forecast/`` — the bridge forecast read (ADR-0106 §5).

    Returns the velocity range + per-sprint series, the remaining committed
    backlog re-paced into a sprints-to-complete range, and the latest
    ``ForecastSnapshot`` per bound milestone (cpm_finish + p50/p80 + confidence
    band). Any project member (matching ``ProjectVelocityView``); the
    privacy-sensitive direction is upward (cross-team aggregation, Enterprise),
    never downward to the team. The ``velocity`` payload is byte-identical to the
    existing ``/velocity/`` read for the same VIEWER+ audience — the velocity
    privacy gate (ADR-0104 / #553, not yet merged) will, when it lands, suppress
    the per-sprint series for below-tier readers at the shared ``velocity_summary``
    sink so both endpoints inherit it.
    """

    mcp_compute_heavy = True  # computed-on-read forecast (velocity Monte Carlo) (#1808 F4)
    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(responses=ProjectForecastSerializer)
    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import project_forecast
        from trueppm_api.apps.projects.signal_privacy_services import (
            can_read_signal,
            suppress_velocity_summary,
        )

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        data = project_forecast(project.pk)
        velocity = data["velocity"]
        remaining = data["remaining_committed_points"]
        stc_low = data["sprints_to_complete_low"]
        stc_high = data["sprints_to_complete_high"]
        milestones = ForecastSnapshotSerializer(data["milestones"], many=True).data
        # ADR-0104 §2.1: the velocity gate must fire at every sink exposing the
        # team-private velocity detail, not just /velocity/. project_forecast
        # embeds the raw velocity series AND derives sprints-to-complete (plus the
        # remaining-points basis) from it, so a below-audience reader suppressed on
        # /velocity/ must be suppressed here too — otherwise /forecast/ is a
        # side-channel back to the same band (#981).
        if not can_read_signal(request, project.pk, "velocity"):
            velocity = suppress_velocity_summary(velocity)
            remaining = None
            stc_low = None
            stc_high = None
            # ForecastSnapshot.velocity_low/high ARE the velocity forecast band:
            # services.py seeds them straight from velocity_summary's
            # forecast_range_low/high — the same two fields suppress_velocity_summary
            # nulls — so they re-leak the band through milestones unless stripped
            # here too. cpm_finish / p50 / p80 / confidence are milestone-date
            # confidence artifacts (ADR-0106 §3), separately gated, and stay intact.
            for milestone in milestones:
                milestone["velocity_low"] = None
                milestone["velocity_high"] = None
                # The prior snapshot (#730) carries the same band, so it re-leaks
                # it through the delta read unless nulled here too (same #981 gate).
                prev = milestone.get("previous")
                if prev is not None:
                    prev["velocity_low"] = None
                    prev["velocity_high"] = None
        return Response(
            {
                "velocity": velocity,
                "remaining_committed_points": remaining,
                "sprints_to_complete_low": stc_low,
                "sprints_to_complete_high": stc_high,
                "milestones": milestones,
            },
            status=status.HTTP_200_OK,
        )


class ProjectSprintForecastView(McpReadableViewMixin, APIView):
    """``GET /api/v1/projects/<pk>/sprint-forecast/`` — backlog delivery forecast (#487).

    P50/P80 sprint counts + calendar dates for clearing the remaining committed
    backlog, from a velocity Monte Carlo. Any project member, same audience as
    ``/velocity/`` and ``/forecast/`` — and gated the same way: every field derives
    from the team-private velocity series, so a reader below the velocity audience
    (ADR-0104) is suppressed here too, or this endpoint is a side-channel back to
    the band (#981). The forecast itself is computed-on-read and cached for an hour
    inside the service; the view only owns the privacy gate.
    """

    mcp_compute_heavy = True  # computed-on-read backlog delivery forecast (#1808 F4)
    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(responses=SprintForecastSerializer)
    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import sprint_forecast
        from trueppm_api.apps.projects.signal_privacy_services import can_read_signal

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        data = sprint_forecast(project.pk)
        if not can_read_signal(request, project.pk, "velocity"):
            # The entire payload is velocity-derived, so a below-audience reader
            # gets the suppressed shape rather than a backlog horizon they could
            # reverse into the team's throughput.
            # Null EVERY velocity-derived signal. sample_count (the team's
            # closed-sprint count) and a "ready" status are themselves
            # organisational facts the ADR-0104 boundary excludes from a
            # below-audience reader — the same class as the zeroed excluded_count
            # in suppress_velocity_summary — so they are withheld too, and status
            # collapses to the only non-revealing constant.
            data = {
                "status": "warming_up",
                "remaining_points": None,
                "remaining_count": None,
                "sample_count": None,
                "p50_sprints": None,
                "p80_sprints": None,
                "p50_date": None,
                "p80_date": None,
                "p95_date": None,
                "basis": data["basis"],
                # forecast_basis is a non-revealing discriminator (which input *would*
                # drive the forecast), not a team-private value, so it survives
                # suppression — the client still knows whether to label the (empty)
                # forecast a velocity or throughput one.
                "forecast_basis": data["forecast_basis"],
                "velocity_suppressed": True,
            }
        return Response(SprintForecastSerializer(data).data, status=status.HTTP_200_OK)


class FlowMetricsView(APIView):
    """``GET /api/v1/projects/<pk>/flow-metrics/`` — methodology-neutral flow analytics.

    Cycle/lead-time distributions, a cumulative flow diagram, and a weekly throughput
    series (ADR-0130 D1, #1072), computed-on-read from ``Task`` history — no new model.
    ``?window=<days>`` (default 90, capped) sets the look-back window.

    Permission: any project member (matching the velocity/forecast reads). The
    historical distributions are team-health performance analytics, so they are gated
    under the ``flow_metrics`` signal (ADR-0130 D4): a reader below the signal's
    audience (e.g. a PM/PMO at the TEAM_SM_PM band when the default is TEAM) gets the
    payload with the distribution arrays emptied and ``flow_metrics_suppressed=true``,
    never a 403 — the team always reads its own flow metrics, the PM reads them only
    once the team shares upward. The aggregate-only ``data_integrity`` advisory block
    is not a performance signal and survives suppression.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="window",
                type=OpenApiTypes.INT,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Look-back window in days (default 90, capped at 365).",
            )
        ],
        responses=FlowMetricsSerializer,
    )
    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import flow_metrics
        from trueppm_api.apps.projects.signal_privacy_services import (
            can_read_signal,
            suppress_flow_metrics,
        )

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        try:
            window_days = int(request.query_params.get("window", 90))
        except (TypeError, ValueError):
            window_days = 90

        data = flow_metrics(project.pk, window_days=window_days)
        # ADR-0130 D4: the cycle/lead/CFD/throughput SERIES are team-private historical
        # performance analytics. A reader below the flow_metrics audience gets the
        # suppressed shape (arrays emptied, flag set), not a 403 — current board state
        # (D2 breach) stays visible elsewhere, but historical distributions do not.
        if not can_read_signal(request, project.pk, "flow_metrics"):
            data = suppress_flow_metrics(data)
        return Response(FlowMetricsSerializer(data).data, status=status.HTTP_200_OK)


class ProjectMilestonesView(APIView):
    """``GET /api/v1/projects/<pk>/milestones/`` — slim milestone list (ADR-0106 §E1.3).

    Feeds the promote dialog's bind-existing picker without loading the whole
    task list. ``?unbound=true`` filters to milestones no sprint targets yet.
    Each row carries ``is_bound`` (annotated via one ``Exists``). Any project
    member; read-only.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="unbound",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                required=False,
                description="When true, return only milestones no sprint is bound to yet.",
            )
        ],
        responses=MilestoneListItemSerializer(many=True),
    )
    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import list_project_milestones

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        unbound_only = request.query_params.get("unbound", "").lower() in ("true", "1", "yes")
        milestones = list_project_milestones(project.pk, unbound_only=unbound_only)
        return Response(
            MilestoneListItemSerializer(milestones, many=True).data,
            status=status.HTTP_200_OK,
        )


class ProjectBurnView(APIView):
    """``GET /api/v1/projects/<pk>/burn/`` — burndown / burnup series (issue #239).

    Reconstructs daily task counts (or story-point sums) from
    ``HistoricalTask`` snapshots and returns the actual / scope / linear
    ideal curves needed to render burn charts. Includes a planned overlay
    derived from the project's active baseline when one exists.

    Query params:
      ``chart_type`` — ``burndown`` (default) or ``burnup``
      ``metric``     — ``tasks`` (default) or ``points``
      ``since``      — window start, ISO date; defaults to project start
      ``until``      — window end, ISO date; defaults to today
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="chart_type",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                enum=["burndown", "burnup", "combined"],
                description=(
                    "Curve to return; one of burndown (default), burnup, or combined. "
                    "combined merges the remaining (burndown) and completed (burnup) "
                    "curves into one series."
                ),
            ),
            OpenApiParameter(
                name="metric",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                enum=["tasks", "points"],
                description="Quantity to chart; tasks (default) or points (story points).",
            ),
            OpenApiParameter(
                name="since",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window start, ISO 8601 YYYY-MM-DD. Defaults to the project start date."
                ),
            ),
            OpenApiParameter(
                name="until",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description="Window end, ISO 8601 YYYY-MM-DD. Defaults to today.",
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Burn series. For burndown/burnup: {chart_type, metric, since, "
                    "until, series: [{date, actual, scope, ideal}]}. For combined: "
                    "series rows are {date, remaining, completed, total, ideal}."
                ),
                examples=[
                    OpenApiExample(
                        "burndown",
                        value={
                            "chart_type": "burndown",
                            "metric": "tasks",
                            "since": "2026-01-01",
                            "until": "2026-01-14",
                            "series": [
                                {"date": "2026-01-01", "actual": 20, "scope": 20, "ideal": 20},
                                {"date": "2026-01-14", "actual": 3, "scope": 20, "ideal": 0},
                            ],
                        },
                    ),
                ],
            ),
            400: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description="Invalid chart_type, metric, or date parameter.",
            ),
        },
    )
    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import burn_series

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)

        chart_type = request.query_params.get("chart_type", "burndown")
        metric = request.query_params.get("metric", "tasks")
        since_param = request.query_params.get("since")
        until_param = request.query_params.get("until")

        since = self._parse_date(since_param) if since_param else project.start_date
        until = self._parse_date(until_param) if until_param else timezone.localdate()

        if since is None or until is None:
            return Response(
                {"detail": "since and until must be ISO dates (YYYY-MM-DD)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Validate chart_type and metric before dispatching — guards both combined
        # and non-combined paths with a consistent 400 response (security-review finding).
        _VALID_CHART_TYPES = {"burndown", "burnup", "combined"}
        _VALID_METRICS = {"tasks", "points"}
        if chart_type not in _VALID_CHART_TYPES:
            return Response(
                {"detail": f"chart_type must be one of: {', '.join(sorted(_VALID_CHART_TYPES))}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if metric not in _VALID_METRICS:
            return Response(
                {"detail": f"metric must be one of: {', '.join(sorted(_VALID_METRICS))}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if chart_type == "combined":
            # Merge burndown (remaining) and burnup (completed) into one series so
            # the client gets both curves in a single request (ADR-0062).
            try:
                bd = burn_series(
                    project_id=project.pk,
                    chart_type="burndown",
                    since=since,
                    until=until,
                    metric=metric,
                )
                bu = burn_series(
                    project_id=project.pk,
                    chart_type="burnup",
                    since=since,
                    until=until,
                    metric=metric,
                )
            except ValueError as exc:
                # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            bu_by_date = {p["date"]: p for p in bu["series"]}
            payload = {
                "chart_type": "combined",
                "metric": metric,
                "since": str(since),
                "until": str(until),
                "series": [
                    {
                        "date": p["date"],
                        "remaining": p["actual"],
                        "completed": bu_by_date.get(p["date"], {}).get("actual", 0),
                        "total": p["scope"],
                        "ideal": p["ideal"],
                    }
                    for p in bd["series"]
                ],
            }
            return Response(payload, status=status.HTTP_200_OK)

        try:
            payload = burn_series(
                project_id=project.pk,
                chart_type=chart_type,
                since=since,
                until=until,
                metric=metric,
            )
        except ValueError as exc:
            # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(payload, status=status.HTTP_200_OK)

    @staticmethod
    def _parse_date(raw: str) -> datetime.date | None:
        try:
            return datetime.date.fromisoformat(raw)
        except ValueError:
            return None


# ---------------------------------------------------------------------------
# Inbound task-sync — ADR-0068 / issue #500 (closes ADR-0065 Gap 3)
# ---------------------------------------------------------------------------


def _client_ip(request: Request) -> str | None:
    """Best-effort client-IP extraction for audit rows.

    Reads ``X-Forwarded-For`` first (most TruePPM deployments sit behind a
    reverse proxy or ingress), falling back to ``REMOTE_ADDR``.  Returns the
    first hop from XFF — the chain after that is forgeable.  ``None`` if
    neither is present (e.g. test client).
    """
    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    if xff:
        # Comma-separated; take the leftmost (client) hop.
        return xff.split(",")[0].strip() or None
    return request.META.get("REMOTE_ADDR") or None


class TaskSyncView(IdempotencyMixin, APIView):
    """``POST /api/v1/projects/{project_id}/task-sync/`` — inbound task push.

    Authenticated via project-scoped API token (Authorization: Bearer tppm_…).
    The auth class sets ``request.user`` to the token creator and
    ``request.auth`` to the token itself.

    IDOR defense: verifies the token's project matches the URL ``project_id``.
    A mismatch returns ``401`` (not ``403``) to avoid leaking whether the URL
    project exists.

    Per-project rate limit applies via ``TaskSyncThrottle`` (100 req/min steady,
    1000 req/min during the first 60 minutes after token creation).
    """

    # Exempt from the generic Idempotency-Key path (ADR-0170): inbound sync is already
    # idempotent by (project, source, external_id) upsert (ADR-0068), and requests carry
    # a token principal rather than a JWT/session user to scope keys by.
    idempotency_exempt = True

    # Only token auth — explicitly disable JWT/Session so a logged-in user
    # cannot hit this endpoint with their normal credentials and bypass the
    # token-creation audit trail.
    from trueppm_api.apps.projects.authentication import ProjectApiTokenAuthentication
    from trueppm_api.apps.projects.throttles import TaskSyncThrottle

    authentication_classes = [ProjectApiTokenAuthentication]
    # IsTokenForProject enforces the IDOR check structurally (token.project_id
    # must match the URL pk) and raises AuthenticationFailed (401) on mismatch
    # so callers cannot enumerate project existence.
    # TokenHasScope(legacy:full) rejects a read-only mcp:read token at this write
    # path (ADR-0186 §E): the scope system is fail-closed for writes — mcp:read
    # never satisfies legacy:full, so only a full-scope token can push tasks.
    permission_classes = [
        IsAuthenticated,
        IsTokenForProject,
        TokenHasScope(SCOPE_LEGACY_FULL),
    ]
    throttle_classes = [TaskSyncThrottle]

    @extend_schema(
        summary="Push an external task into a project (inbound task-sync)",
        request=InboundTaskSyncPayloadSerializer,
        # The endpoint returns 201 on first push (task created) and 200 on an
        # idempotent re-push (existing task updated). Declaring both lets an
        # integrator distinguish first-seen from update by status code, not only
        # the `created` body flag (#1329).
        responses={
            200: InboundTaskSyncResultSerializer,
            201: InboundTaskSyncResultSerializer,
        },
    )
    def post(self, request: Request, pk: str) -> Response:
        # request.auth is the ApiToken; request.user is its creator.
        # IsTokenForProject in permission_classes has already verified that the
        # token authorizes writes to the URL pk (either via direct
        # token.project_id match for project-scoped tokens, or via program
        # membership for program-scoped tokens). For program-scoped tokens we
        # must resolve the target project from the URL rather than from the
        # token, since `token.project_id` is None.
        from trueppm_api.apps.projects.inbound_sync import upsert_inbound_task
        from trueppm_api.apps.projects.models import ApiToken

        token = request.auth
        if not isinstance(token, ApiToken):
            # Unreachable in practice — IsTokenForProject already guarantees this.
            # Kept for type narrowing so mypy understands the auth path below.
            return Response(
                {"detail": "Token authentication required."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        # Resolve the target project from the URL. IsTokenForProject has
        # already validated the token authorizes this project — this lookup
        # cannot fail with a project the caller is unauthorized to touch.
        # Always go through get_object_or_404 (works for both project- and
        # program-scoped tokens) so the type is concretely Project, not
        # Optional[Project] — keeps mypy happy and the code branch-free.
        target_project = get_object_or_404(Project, pk=pk, is_deleted=False)

        serializer = InboundTaskSyncPayloadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload: dict[str, Any] = serializer.validated_data

        result = upsert_inbound_task(
            project=target_project,
            token=token,
            payload=payload,
            source_ip=_client_ip(request),
        )

        return Response(
            {
                "task_id": str(result.task.pk),
                "short_id": result.task.short_id,
                "created": result.created,
                "assignee_resolved": result.assignee_resolved,
            },
            # 201 on first push (resource created); 200 on idempotent re-push
            # (resource existed and was updated).  The `created` boolean
            # carries the same signal, but proxies and clients that switch on
            # the status code see the correct semantics.
            status=status.HTTP_201_CREATED if result.created else status.HTTP_200_OK,
        )


@extend_schema_view(
    post=extend_schema(
        summary="Ingest CI acceptance-test verdicts for a project's criteria",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Result object: `{updated, unchanged, unknown, tasks}`. "
                    "`updated`/`unchanged` are the criterion ids whose `met` flag "
                    "was flipped or already matched; `unknown` are ids that belong "
                    "to another project (never touched — IDOR boundary). `tasks` is "
                    "a per-task report `{task, dor_ready, criteria_met, "
                    "criteria_total}`, where `dor_ready` reports whether that task's "
                    "Definition-of-Ready gate is now clear. Authenticates with a "
                    "project-scoped API token (`projectApiTokenAuth`), not a user "
                    "session."
                ),
            )
        },
    )
)
class AcceptanceResultIngestView(IdempotencyMixin, APIView):
    """``POST /api/v1/projects/{project_id}/acceptance-results/`` — CI test ingest (ADR-0148).

    Closes the XP acceptance-test-driven loop: a CI job that runs a story's
    acceptance tests reports the verdicts here and the matching
    ``AcceptanceCriterion.met`` flags flip, stamping the review trail to the human
    who minted the token (``met_by``/``met_at``). Flipping the last unmet criterion
    *satisfies* the Definition-of-Ready gate but does NOT auto-transition the task to
    READY — the team keeps the deliberate Mark-ready step (the ``dor_ready`` flag in
    the response tells CI the gate is now clear).

    OSS boundary (ADR-0097 carve-out, rule 9): this reuses the EXISTING ADR-0068
    ``ProjectApiTokenAuthentication`` — a single narrow authenticated endpoint, no
    provider registry, no HMAC/OAuth, no conflict resolution, no reconciliation loop.
    The general multi-provider bidirectional ingest hub remains Enterprise.

    IDOR defense: ``IsTokenForProject`` verifies the token authorizes the URL project
    (401 on mismatch). Criteria that belong to a *different* project than the URL are
    never flipped — they are returned in ``unknown`` rather than touched, so a token
    cannot reach across the project boundary by naming foreign criterion ids.
    """

    # Idempotent by construction — re-reporting the same verdict is a no-op flip
    # (apply_acceptance_met_change returns False) — so the generic Idempotency-Key
    # path is unnecessary and would key on a token principal rather than a JWT user.
    idempotency_exempt = True

    from trueppm_api.apps.projects.authentication import ProjectApiTokenAuthentication
    from trueppm_api.apps.projects.throttles import AcceptanceResultThrottle

    authentication_classes = [ProjectApiTokenAuthentication]
    # TokenHasScope(legacy:full) rejects a read-only mcp:read token at this write
    # path (ADR-0186 §E): only a full-scope token may report acceptance verdicts.
    permission_classes = [
        IsAuthenticated,
        IsTokenForProject,
        TokenHasScope(SCOPE_LEGACY_FULL),
    ]
    throttle_classes = [AcceptanceResultThrottle]

    def post(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.models import AcceptanceCriterion, ApiToken
        from trueppm_api.apps.projects.product_backlog_services import (
            ac_counts,
            apply_acceptance_met_change,
            dor_blockers,
        )
        from trueppm_api.apps.projects.serializers import AcceptanceResultIngestSerializer
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        token = request.auth
        if not isinstance(token, ApiToken):
            # Unreachable — IsTokenForProject guarantees this; kept for type narrowing.
            return Response(
                {"detail": "Token authentication required."},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        # IsTokenForProject has already validated the token authorizes this project.
        target_project = get_object_or_404(Project, pk=pk, is_deleted=False)

        serializer = AcceptanceResultIngestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        results: list[dict[str, Any]] = serializer.validated_data["results"]

        requested_ids = [item["criterion_id"] for item in results]
        # Scope the lookup to the URL project: a criterion in another project is
        # treated as unknown, never flipped (cross-project write-IDOR defense).
        criteria_by_id = {
            c.pk: c
            for c in AcceptanceCriterion.objects.select_related("task").filter(
                pk__in=requested_ids,
                task__project_id=target_project.pk,
                is_deleted=False,
                task__is_deleted=False,
            )
        }

        actor = token.created_by
        now = timezone.now()
        updated = 0
        unchanged = 0
        unknown: list[str] = []
        affected_tasks: dict[Any, Task] = {}

        with transaction.atomic():
            for item in results:
                criterion = criteria_by_id.get(item["criterion_id"])
                if criterion is None:
                    unknown.append(str(item["criterion_id"]))
                    continue
                was_met = criterion.met
                criterion.met = item["passed"]
                changed = apply_acceptance_met_change(
                    criterion, was_met=was_met, actor=actor, now=now
                )
                if changed:
                    updated += 1
                    affected_tasks[criterion.task_id] = criterion.task
                else:
                    unchanged += 1

            # Broadcast one task_updated per affected task so connected clients
            # refresh the DoR meter without a manual refetch (deferred to commit).
            # functools.partial freezes the per-iteration task id (avoiding the
            # late-binding closure trap) and lets the type checker infer the
            # argument types from broadcast_board_event's signature.
            project_id_str = str(target_project.pk)
            for task_id in list(affected_tasks):
                transaction.on_commit(
                    functools.partial(
                        broadcast_board_event,
                        project_id_str,
                        "task_updated",
                        {"id": str(task_id)},
                    )
                )

        # Report the post-flip DoR state per affected task so CI knows whether the
        # gate cleared. Counts are recomputed from the now-current criteria rows.
        # Re-fetch the affected tasks once with their criteria prefetched so the
        # per-task ac_counts + dor_blockers calls below stay O(1) queries total
        # rather than O(affected tasks) — the select_related("task") instances above
        # carry no prefetched criteria, so a naive loop would re-query per task.
        reported_tasks = (
            Task.objects.filter(pk__in=list(affected_tasks))
            .prefetch_related("acceptance_criteria")
            .order_by("pk")
        )
        task_reports = []
        for task in reported_tasks:
            met, total = ac_counts(task)
            task_reports.append(
                {
                    "task": str(task.pk),
                    "dor_ready": not dor_blockers(task),
                    "criteria_met": met,
                    "criteria_total": total,
                }
            )

        return Response(
            {
                "updated": updated,
                "unchanged": unchanged,
                "unknown": unknown,
                "tasks": task_reports,
            },
            status=status.HTTP_200_OK,
        )


class ProjectApiTokenViewSet(IdempotencyMixin, viewsets.ModelViewSet[Any]):
    """``/api/v1/projects/{project_pk}/api-tokens/`` — token CRUD for Admin/PM.

    ``list`` / ``retrieve`` are open to any project member so the team can see
    what integrations exist (Morgan's VoC 🟡 — sprint sovereignty signal).
    ``create`` / ``destroy`` require Admin/PM (role ≥ 3).

    The raw token is returned only on ``create``, in a one-time response field
    ``token``.  Subsequent reads never expose it.
    """

    # Exempt from the generic Idempotency-Key path (ADR-0170): the create response
    # carries the one-time plaintext token, which must never be persisted in the
    # idempotency store for replay. Token issuance is also throttled separately.
    idempotency_exempt = True

    from trueppm_api.apps.projects.throttles import TokenIssuanceThrottle

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]
    serializer_class = ProjectApiTokenSerializer
    http_method_names = ["get", "post", "delete", "head", "options"]

    def get_throttles(self) -> list[Any]:
        from trueppm_api.apps.projects.throttles import TokenIssuanceThrottle as _TIT

        if self.action == "create":
            return [_TIT()]
        return []

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("create", "destroy"):
            return [IsAuthenticated(), IsProjectAdmin(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    # Scope hooks — the program subclass (ProgramApiTokenViewSet) overrides these
    # so the create/destroy/list bodies stay scope-agnostic (ADR-0076).
    _scope_field = "project"  # ApiToken / audit FK field name for this scope
    _scope_kwarg = "project_pk"  # URL kwarg carrying the scope id

    def _resolve_scope(self) -> Any:
        """Return the Project this viewset is scoped to (404 if missing)."""
        return self._get_project_or_404(self.kwargs[self._scope_kwarg])

    def get_queryset(self) -> QuerySet[Any]:
        # owner__isnull=True excludes user-scoped Personal Access Tokens (ADR-0214)
        # — they share the ApiToken table but must never appear on a project's or
        # program's token list.
        return (
            ProjectApiToken.objects.filter(
                **{f"{self._scope_field}_id": self.kwargs[self._scope_kwarg]},
                is_deleted=False,
                owner__isnull=True,
            )
            .select_related("created_by", self._scope_field)
            .order_by("-created_at")
        )

    def get_object(self) -> Any:
        obj = super().get_object()
        # Object-level RBAC against the token's scope object — the active
        # permission classes (Is{Project,Program}Admin) match the scope.
        self.check_object_permissions(self.request, getattr(obj, self._scope_field))
        return obj

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Mint a new token and return the raw value once.

        After the response is sent the raw token is not retrievable; it must
        be copied at this moment.
        """
        import secrets

        from trueppm_api.apps.projects.authentication import (
            TOKEN_PREFIX,
            sha256_hex,
        )
        from trueppm_api.apps.projects.models import (
            ApiTokenAuditAction,
            ApiTokenAuditEntry,
        )
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        scope_obj = self._resolve_scope()
        scope_kwargs = {self._scope_field: scope_obj}

        write_serializer = ProjectApiTokenCreateSerializer(data=request.data)
        write_serializer.is_valid(raise_exception=True)

        raw_token = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
        token_prefix = raw_token[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8]

        with transaction.atomic():
            token_scopes = write_serializer.validated_data.get("scopes", [SCOPE_LEGACY_FULL])
            token = ProjectApiToken.objects.create(
                **scope_kwargs,
                name=write_serializer.validated_data["name"],
                status_map=write_serializer.validated_data.get("status_map", {}),
                scopes=token_scopes,
                # An mcp:read token is required to expire (serializer-validated);
                # legacy:full sync tokens leave this null and never expire.
                expires_at=write_serializer.validated_data.get("expires_at"),
                token_prefix=token_prefix,
                token_hash=sha256_hex(raw_token),
                created_by=request.user if request.user.is_authenticated else None,
            )
            ApiTokenAuditEntry.objects.create(
                **scope_kwargs,
                token=token,
                token_prefix=token_prefix,
                actor=request.user if request.user.is_authenticated else None,
                action=ApiTokenAuditAction.MINTED.value,
                source_ip=_client_ip(request),
                # Record the granted scopes so the audit trail shows whether a
                # mint was full-access or a narrowed read-only (mcp:read) token.
                detail={"name": token.name, "scopes": list(token.scopes)},
            )
            # Project-scoped mints surface on the project board over WS. Program
            # tokens have no single board, so the broadcast is skipped — the
            # audit row is the durable record either way.
            if self._scope_field == "project":
                project_id = str(scope_obj.pk)
                token_name = token.name

                def _broadcast_mint(
                    pid: str = project_id, pfx: str = token_prefix, nm: str = token_name
                ) -> None:
                    broadcast_board_event(
                        pid, "api_token_minted", {"token_prefix": pfx, "name": nm}
                    )

                transaction.on_commit(_broadcast_mint)

        # Single-shot response: token field is present here, never on subsequent reads.
        read_data = ProjectApiTokenSerializer(token).data
        return Response(
            {**read_data, "token": raw_token},
            status=status.HTTP_201_CREATED,
        )

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Revoke (soft-delete) a token.  Idempotent — re-revoking is a no-op."""
        from django.utils import timezone

        from trueppm_api.apps.projects.models import (
            ApiTokenAuditAction,
            ApiTokenAuditEntry,
        )
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        token = self.get_object()
        if token.revoked_at is None:
            with transaction.atomic():
                token.revoked_at = timezone.now()
                token.save(update_fields=["revoked_at"])
                ApiTokenAuditEntry.objects.create(
                    **{self._scope_field: getattr(token, self._scope_field)},
                    token=token,
                    token_prefix=token.token_prefix,
                    actor=request.user if request.user.is_authenticated else None,
                    action=ApiTokenAuditAction.REVOKED.value,
                    source_ip=_client_ip(request),
                    detail={"name": token.name},
                )
                if token.project_id is not None:
                    project_id = str(token.project_id)
                    token_prefix = token.token_prefix
                    token_name = token.name

                    def _broadcast_revoke(
                        pid: str = project_id, pfx: str = token_prefix, nm: str = token_name
                    ) -> None:
                        broadcast_board_event(
                            pid, "api_token_revoked", {"token_prefix": pfx, "name": nm}
                        )

                    transaction.on_commit(_broadcast_revoke)
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _get_project_or_404(self, project_pk: Any) -> Project:
        # Re-uses the standard project-existence check.  ``IsProjectMember``
        # already gated access; this just resolves the FK target.
        try:
            return Project.objects.get(pk=project_pk, is_deleted=False)
        except Project.DoesNotExist as exc:
            from django.http import Http404

            raise Http404("Project not found.") from exc


class ProgramApiTokenViewSet(ProjectApiTokenViewSet):
    """``/api/v1/programs/{program_pk}/api-tokens/`` — program-scoped token CRUD.

    A program-scoped token authorizes inbound writes into any project within the
    program (ADR-0076). Reuses the one-time-reveal create, soft-delete revoke,
    and audit substrate from ProjectApiTokenViewSet via the scope hooks; only the
    scope resolution and RBAC ladder change. Reads: Program Member+; create/revoke:
    Program Admin+ on a non-closed program.
    """

    _scope_field = "program"
    _scope_kwarg = "program_pk"

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("create", "destroy"):
            return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
        return [IsAuthenticated(), IsProgramMember()]

    def _resolve_scope(self) -> Any:
        from django.http import Http404

        from trueppm_api.apps.projects.models import Program

        try:
            return Program.objects.get(pk=self.kwargs["program_pk"], is_deleted=False)
        except Program.DoesNotExist as exc:
            raise Http404("Program not found.") from exc


class MyApiTokenViewSet(IdempotencyMixin, viewsets.ModelViewSet[Any]):
    """``/api/v1/me/api-tokens/`` — a user's own Personal Access Tokens (ADR-0214).

    A PAT authenticates a script *as the requesting user*: it acts with exactly
    their RBAC, never more (the authenticator sets ``request.user`` to the token's
    ``owner``). This viewset is auto-scoped to ``owner=request.user`` — a user can
    only ever see, create, or revoke their own tokens.

    - ``list`` / ``retrieve`` never expose the raw token or hash.
    - ``create`` generates the raw token, returns it **once** in a ``token`` field,
      writes a MINTED audit row, and enforces the ``MAX_PERSONAL_ACCESS_TOKENS``
      active-token cap. Full-access only in v1 (scopes fixed to ``legacy:full``).
    - ``destroy`` soft-revokes and writes a REVOKED audit row; idempotent.

    No WebSocket broadcast: a personal token has no board channel, so the audit row
    is the durable record (ADR-0214 §Durable Execution).
    """

    # Exempt from the generic Idempotency-Key path (ADR-0170): the create response
    # carries the one-time plaintext token, which must never be persisted in the
    # idempotency store for replay — same rationale as the project token viewset.
    idempotency_exempt = True

    permission_classes = [IsAuthenticated]
    serializer_class = MyApiTokenSerializer
    http_method_names = ["get", "post", "delete", "head", "options"]

    def get_throttles(self) -> list[Any]:
        from trueppm_api.apps.projects.throttles import TokenIssuanceThrottle

        if self.action == "create":
            return [TokenIssuanceThrottle()]
        return []

    def get_queryset(self) -> QuerySet[Any]:
        # Auto-scoped to the requesting user: owner=request.user is the only object
        # boundary — there is no project/program RBAC to check because a PAT is a
        # purely personal credential.
        return (
            ProjectApiToken.objects.filter(
                owner=self.request.user,  # type: ignore[misc]
                is_deleted=False,
            )
            .select_related("owner")
            .order_by("-created_at")
        )

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Mint a personal token and return the raw value once.

        Enforces the active-token cap before generating anything so a user at the
        cap gets a clear 400 rather than a token they cannot keep. After the
        response is sent the raw token is not retrievable.
        """
        import secrets

        from django.conf import settings
        from django.contrib.auth.models import User

        from trueppm_api.apps.projects.authentication import (
            TOKEN_PREFIX,
            sha256_hex,
        )
        from trueppm_api.apps.projects.models import (
            SCOPE_LEGACY_FULL,
            ApiToken,
            ApiTokenAuditAction,
            ApiTokenAuditEntry,
        )

        # IsAuthenticated guarantees a real user; narrow for the FK assignments.
        caller = cast(User, request.user)

        write_serializer = MyApiTokenCreateSerializer(data=request.data)
        write_serializer.is_valid(raise_exception=True)

        # Cap gate (ADR-0214, #2021): count only ACTIVE tokens (not revoked, not
        # expired, not deleted) so revoking or letting one expire frees a slot.
        # Mirrors the per-task comment count-gate precedent. The cap is read from
        # settings at request time so an operator can retune it per deployment.
        max_personal_tokens = settings.TRUEPPM_MAX_PERSONAL_ACCESS_TOKENS
        active_count = ApiToken.active_personal_tokens_for(caller).count()
        if active_count >= max_personal_tokens:
            return Response(
                {
                    "detail": (
                        f"You already have {max_personal_tokens} active personal "
                        "access tokens (the maximum). Revoke one before creating another."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        raw_token = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
        token_prefix = raw_token[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8]

        with transaction.atomic():
            token = ProjectApiToken.objects.create(
                owner=caller,
                name=write_serializer.validated_data["name"],
                # PATs default to full-access (acts as you); mcp:read is accepted so
                # a personal token can drive the owner-scoped MCP read surface
                # (#1712/#1713). An mcp:read PAT must expire (serializer-validated).
                scopes=write_serializer.validated_data.get("scopes", [SCOPE_LEGACY_FULL]),
                expires_at=write_serializer.validated_data.get("expires_at"),
                token_prefix=token_prefix,
                token_hash=sha256_hex(raw_token),
                # A PAT is minted by, and owned by, the same user.
                created_by=caller,
            )
            ApiTokenAuditEntry.objects.create(
                owner=caller,
                token=token,
                token_prefix=token_prefix,
                actor=caller,
                action=ApiTokenAuditAction.MINTED.value,
                source_ip=_client_ip(request),
                detail={"name": token.name},
            )
            # No WS broadcast — a personal token has no board channel (ADR-0214).

        # Single-shot response: the raw token field is present here, never on reads.
        read_data = MyApiTokenSerializer(token).data
        return Response({**read_data, "token": raw_token}, status=status.HTTP_201_CREATED)

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        """Revoke (soft-revoke) a personal token. Idempotent — re-revoking no-ops."""
        from django.contrib.auth.models import User
        from django.utils import timezone

        from trueppm_api.apps.projects.models import (
            ApiTokenAuditAction,
            ApiTokenAuditEntry,
        )

        caller = cast(User, request.user)  # IsAuthenticated guarantees a real user
        token = self.get_object()  # get_queryset already scopes to owner=request.user
        if token.revoked_at is None:
            with transaction.atomic():
                token.revoked_at = timezone.now()
                token.save(update_fields=["revoked_at"])
                ApiTokenAuditEntry.objects.create(
                    owner=caller,
                    token=token,
                    token_prefix=token.token_prefix,
                    actor=caller,
                    action=ApiTokenAuditAction.REVOKED.value,
                    source_ip=_client_ip(request),
                    detail={"name": token.name},
                )
        return Response(status=status.HTTP_204_NO_CONTENT)


class _ApiTokenAuditPagination(pagination.LimitOffsetPagination):
    """Bounded pagination for the audit log — prevents a member from pulling
    an unbounded page (a project with a noisy integration can accumulate
    millions of audit rows; the unbounded default would be a DoS vector
    against the DB even for an authenticated request)."""

    default_limit = 50
    max_limit = 500


class ApiTokenAuditView(generics.ListAPIView[Any]):
    """``GET /api/v1/projects/{project_pk}/api-token-audit/`` — per-project audit log.

    Visible to any project member (Viewer+) — the team can see when integration
    tokens are minted, revoked, and used (Morgan's VoC 🟡 sprint-sovereignty
    concern is resolved by visibility, not by gating writes more tightly).

    The ``project_id=project_pk`` filter in get_queryset is defense-in-depth
    against a future refactor that changes how ``project_pk`` is sourced;
    the primary gate is ``IsProjectMember.has_permission`` reading the same
    URL kwarg.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]
    serializer_class = ApiTokenAuditEntrySerializer
    pagination_class = _ApiTokenAuditPagination

    def get_queryset(self) -> QuerySet[Any]:
        from trueppm_api.apps.projects.models import ApiTokenAuditEntry

        project_pk = self.kwargs["project_pk"]
        return (
            ApiTokenAuditEntry.objects.filter(project_id=project_pk)
            .select_related("actor", "token")
            .order_by("-created_at")
        )


class ProgramApiTokenAuditView(ApiTokenAuditView):
    """``GET /api/v1/programs/{program_pk}/api-token-audit/`` — program audit log.

    Visible to any program member. Mirrors the project audit view; filters the
    append-only ApiTokenAuditEntry rows by program scope (ADR-0076).
    """

    permission_classes = [IsAuthenticated, IsProgramMember]

    def get_queryset(self) -> QuerySet[Any]:
        from trueppm_api.apps.projects.models import ApiTokenAuditEntry

        program_pk = self.kwargs["program_pk"]
        return (
            ApiTokenAuditEntry.objects.filter(program_id=program_pk)
            .select_related("actor", "token")
            .order_by("-created_at")
        )


# ---------------------------------------------------------------------------
# Task collaboration viewsets — ADR-0075 (#310 #311)
# ---------------------------------------------------------------------------


# Locked constraints from ADR-0075 surfaced via per-task counts.
MAX_ATTACHMENTS_PER_TASK = 50  # constraint #12
MAX_COMMENTS_PER_TASK = 1_000  # constraint #13
MAX_NOTES_PER_TASK = 1_000  # ADR-0143 per-task cap (DoS guard)
SIGNED_URL_DEFAULT_TTL_SECONDS = 15 * 60  # constraint #6
SIGNED_URL_MAX_TTL_SECONDS = 60 * 60  # constraint #7 (OSS hard-cap)


class AttachmentSigningNotSupported(APIException):
    """The configured storage backend cannot produce a real signed URL (#573, MED-2).

    ``501 Not Implemented``: this is a deployment-configuration gap, not a
    malformed request or a permissions problem. ``FileSystemStorage`` (and any
    backend ``storage_backend_supports_signed_urls`` doesn't recognize) returns
    the same indefinite-lifetime path forever, so honoring the request would hand
    back an ``expires_at`` that lies. Refusing outright — rather than silently
    returning the unsigned path — is the fix; see
    ``docs/administration/`` for configuring a signing-capable backend.
    """

    status_code = status.HTTP_501_NOT_IMPLEMENTED
    default_detail = (
        "This server's attachment storage backend does not support signed "
        "download URLs. Configure a signing-capable backend (e.g. S3/MinIO or "
        "GCS via django-storages) for production use. See the self-hosting "
        "storage documentation for setup instructions."
    )
    default_code = "signed_url_backend_unsupported"


class TaskAttachmentViewSet(
    ProjectScopedViewSet,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[TaskAttachment],
):
    """File-XOR-URL attachments on a task (ADR-0075 §A.1).

    Routes (relative to /projects/{project_pk}/tasks/{task_pk}/):
      GET    attachments/
      POST   attachments/                  (multipart: file XOR external_url)
      GET    attachments/{pk}/
      DELETE attachments/{pk}/             (soft-delete)
      GET    attachments/{pk}/signed-url/

    Permissions:
      list / retrieve — Viewer+ (IsProjectMember)
      create          — Member+ (IsProjectMemberWrite)
      destroy         — uploader OR Admin+ (object-level check in perform_destroy)
    """

    serializer_class = TaskAttachmentSerializer

    def get_throttles(self) -> list[Any]:
        # Only the create action uploads; list/retrieve/destroy stay unthrottled
        # (#574, security review !306 LOW-3).
        from trueppm_api.apps.projects.throttles import TaskAttachmentUploadThrottle

        if self.action == "create":
            return [TaskAttachmentUploadThrottle()]
        return []

    def get_queryset(self) -> QuerySet[TaskAttachment]:
        user = self.request.user
        if not user.is_authenticated:
            return TaskAttachment.objects.none()
        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        # Membership already enforced by IsProjectMember/IsProjectMemberWrite
        # (get_permissions) before get_queryset runs, so the per-request .exists()
        # round-trip was redundant (#821). `task` is select_related so
        # perform_destroy's instance.task.project_id is free.
        return TaskAttachment.objects.filter(
            task__project_id=project_pk,
            task_id=task_pk,
            is_deleted=False,
        ).select_related("uploaded_by", "deleted_by", "task")

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("create", "destroy"):
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    def get_serializer_context(self) -> dict[str, Any]:
        """Inject the project into the serializer context on create so the
        attachment MIME check enforces the *resolved* per-project allow-list
        (ADR-0153, #976) instead of the system default. ``program`` is
        select_related so the policy resolver's parent lookup is free.

        P22: the project is resolved once in perform_create and stashed on
        ``self._attachment_project`` to avoid a second DB round-trip here.
        On the create path, perform_create always runs before the serializer
        renders the response, so the stashed value is available.
        """
        # DRF types the base return as Mapping; copy into a mutable dict so the
        # injection below type-checks and never aliases the base context.
        context: dict[str, Any] = dict(super().get_serializer_context())
        if self.action == "create":
            # Use the project resolved in perform_create if available; fall back
            # to a DB lookup only when called before perform_create (e.g. during
            # schema generation or in tests that call get_serializer_context directly).
            cached = getattr(self, "_attachment_project", None)
            if cached is not None:
                context["attachment_project"] = cached
            else:
                project_pk = self.kwargs.get("project_pk")
                if project_pk:
                    context["attachment_project"] = (
                        Project.objects.filter(pk=project_pk).select_related("program").first()
                    )
        return context

    def perform_create(self, serializer: BaseSerializer[TaskAttachment]) -> None:
        from rest_framework.exceptions import PermissionDenied

        from trueppm_api.apps.projects.attachment_policy import (
            resolve_attachments_enabled,
        )
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, task)

        # P22: resolve the project once here and stash it so get_serializer_context
        # can read it without a second DB query (attachment policy check + context).
        self._attachment_project: Project | None = (
            Project.objects.filter(pk=project_pk).select_related("program").first()
        )

        # ADR-0153 (#976): file uploads are gated by the resolved attachments_enabled
        # policy (external links are a separate capability, unaffected). 403 not 400 —
        # the project's policy forbids uploads here, it isn't a malformed request.
        if serializer.validated_data.get("file"):
            project = self._attachment_project
            if project is not None and not resolve_attachments_enabled(project):
                raise PermissionDenied("File attachments are disabled for this project.")

        # Per-task count cap (ADR-0075 #12)
        if (
            TaskAttachment.objects.filter(task=task, is_deleted=False).count()
            >= MAX_ATTACHMENTS_PER_TASK
        ):
            raise serializers.ValidationError(
                {
                    "detail": f"This task already has {MAX_ATTACHMENTS_PER_TASK} attachments. "
                    "Remove one to add another."
                },
                code="attachment_count_cap",
            )

        instance = serializer.save(task=task, uploaded_by=self.request.user)
        att_id = str(instance.pk)
        task_id_str = str(task.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                str(project_pk),
                "task_attachment_created",
                {"id": att_id, "task_id": task_id_str},
            )
        )

    def perform_destroy(self, instance: TaskAttachment) -> None:
        """Soft-delete with actor capture; uploader OR Admin+ only."""
        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        user = self.request.user
        role = _membership_role(self.request, instance.task.project_id)
        is_uploader = instance.uploaded_by_id == user.pk
        is_admin = role is not None and role >= Role.ADMIN
        if not (is_uploader or is_admin):
            raise serializers.ValidationError(
                {"detail": "Only the uploader or a project admin can delete this."},
                code="attachment_delete_forbidden",
            )

        instance.soft_delete(actor=user)
        att_id = str(instance.pk)
        task_id_str = str(instance.task_id)
        project_id_str = str(instance.task.project_id)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_attachment_deleted",
                {"id": att_id, "task_id": task_id_str},
            )
        )

    @extend_schema(
        summary="Issue a signed download URL for an attachment",
        responses={200: SignedDownloadUrlSerializer},
    )
    @action(detail=True, methods=["get"], url_path="signed-url")
    def signed_url(self, request: Request, project_pk: str, task_pk: str, pk: str) -> Response:
        """Issue a short-lived download URL for the attachment's underlying file.

        TTL defaults to 15 minutes; clamped to 60 minutes max in OSS. External-
        URL attachments reject this action (they're already a URL). Refuses with
        501 when the configured storage backend can't actually produce a signed,
        time-limited URL (#573, MED-2) — see ``AttachmentSigningNotSupported``.
        """
        from django.conf import settings

        from trueppm_api.core.security_checks import storage_backend_supports_signed_urls

        attachment = self.get_object()
        if attachment.external_url:
            raise serializers.ValidationError(
                {"detail": "This attachment is an external link; no signed URL is needed."},
                code="signed_url_external",
            )

        # Checked before TTL parsing: a backend that can't sign at all makes the
        # TTL moot, and failing fast avoids implying the TTL was the problem.
        backend = (getattr(settings, "STORAGES", {}) or {}).get("default", {}).get("BACKEND")
        if not storage_backend_supports_signed_urls(
            backend,
            force_signing_capable=bool(getattr(settings, "ATTACHMENT_STORAGE_SIGNS_URLS", False)),
        ):
            raise AttachmentSigningNotSupported()

        try:
            ttl = int(request.query_params.get("ttl") or SIGNED_URL_DEFAULT_TTL_SECONDS)
        except ValueError as exc:
            raise serializers.ValidationError(
                {"ttl": "Must be an integer (seconds)."},
                code="signed_url_invalid_ttl",
            ) from exc
        if ttl <= 0 or ttl > SIGNED_URL_MAX_TTL_SECONDS:
            raise serializers.ValidationError(
                {"ttl": f"TTL must be between 1 and {SIGNED_URL_MAX_TTL_SECONDS} seconds."},
                code="signed_url_ttl_out_of_range",
            )

        # The backend check above already confirmed this is a signing-capable
        # backend (S3/MinIO, GCS, Azure Blob via django-storages), so .url()
        # transparently returns a real query-string-signed, time-limited URL.
        url = attachment.file.url if attachment.file else ""
        expires_at = timezone.now() + datetime.timedelta(seconds=ttl)
        data = SignedDownloadUrlSerializer({"url": url, "expires_at": expires_at}).data
        return Response(data, status=status.HTTP_200_OK)


class TaskCommentViewSet(
    ProjectScopedViewSet,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[TaskComment],
):
    """Task comment thread with @mention fan-out (ADR-0075 §A.2).

    Routes (relative to /projects/{project_pk}/tasks/{task_pk}/):
      GET    comments/
      POST   comments/
      GET    comments/{pk}/
      PATCH  comments/{pk}/             (within 15-min edit window only)
      DELETE comments/{pk}/             (author OR Admin+; soft-delete)
      POST   comments/{pk}/acknowledge/ (toggle ack — POST creates, DELETE removes)

    The @mention parser runs on create — fan-out creates Mention + Notification
    rows in the same transaction. Rate-limited to 1000 mentions/day, 100/hour
    per user (ADR-0075 locked constraints #8, #9).
    """

    serializer_class = TaskCommentSerializer

    def get_throttles(self) -> list[Any]:
        from trueppm_api.apps.notifications.throttles import MentionRateThrottle

        if self.action in ("create", "partial_update", "update"):
            return [MentionRateThrottle()]
        return []

    def get_queryset(self) -> QuerySet[TaskComment]:
        user = self.request.user
        if not user.is_authenticated:
            return TaskComment.objects.none()
        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        # Membership is already enforced by IsProjectMember/IsProjectMemberWrite
        # (get_permissions) before get_queryset runs — has_permission checks
        # _membership_role for the URL's project_pk — so the previous per-request
        # .exists() round-trip was redundant (#821). `task` is select_related so
        # perform_destroy's instance.task.project_id is free.
        return (
            TaskComment.objects.filter(
                task__project_id=project_pk,
                task_id=task_pk,
                is_deleted=False,
            )
            .select_related("author", "parent", "deleted_by", "task")
            .prefetch_related("acknowledgements", "reactions")
        )

    def get_permissions(self) -> list[BasePermission]:
        # `acknowledge` is the active "I'm on it" stance — Member+ only;
        # Viewers shouldn't be able to ack per ADR-0075 §A.3.
        if self.action in ("create", "partial_update", "update", "destroy", "acknowledge"):
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    def perform_create(self, serializer: BaseSerializer[TaskComment]) -> None:
        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.notifications.services import (
            create_mention_notifications,
            parse_mentions,
            resolve_parsed_mentions,
        )
        from trueppm_api.apps.notifications.throttles import record_mention_usage
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, task)

        # Per-task count cap (ADR-0075 #13)
        if TaskComment.objects.filter(task=task, is_deleted=False).count() >= MAX_COMMENTS_PER_TASK:
            raise serializers.ValidationError(
                {"detail": f"This task has the maximum of {MAX_COMMENTS_PER_TASK} comments."},
                code="comment_count_cap",
            )

        comment = serializer.save(task=task, author=self.request.user)
        comment_id_str = str(comment.pk)
        task_id_str = str(task.pk)
        project_id_str = str(project_pk)
        parent_id = str(comment.parent_id) if comment.parent_id else None

        # Count of non-account external stakeholders reached by an
        # @program-stakeholders mention (#1658, ADR-0264). Surfaced informationally
        # on the real-time comment event so a client can note "N external
        # stakeholders would be emailed" — no email is sent (delivery deferred to
        # #1675) and no Notification rows are created for them.
        external_recipient_count = 0

        # Parse mentions + fan out notifications transactionally
        parsed = parse_mentions(comment.body)
        if parsed:
            actor_role = _membership_role(self.request, project_pk)
            resolved = resolve_parsed_mentions(parsed, project_pk, actor_role=actor_role)
            if resolved.skipped_users or resolved.skipped_groups:
                # Caller gets a structured 400 listing exactly what was rejected
                # — they can fix the body and retry. We do not partially commit.
                detail: dict[str, list[str] | str] = {
                    "detail": "One or more @mentions could not be resolved.",
                }
                if resolved.skipped_users:
                    detail["skipped_users"] = resolved.skipped_users
                if resolved.skipped_groups:
                    detail["skipped_groups"] = resolved.skipped_groups
                raise serializers.ValidationError(detail, code="mention_resolution_failed")
            external_recipient_count = len(resolved.external_targets)
            created = create_mention_notifications(
                task_comment=comment,
                mentioner=self.request.user,  # type: ignore[arg-type]
                parsed_result=resolved,
                project_id=project_pk,
            )
            record_mention_usage(str(self.request.user.pk), created)

            # Fire task.mentioned (#638) once per comment that actually mentioned
            # someone. The webhook is deferred (on_commit) even though the
            # notification fan-out is synchronous — the notification count must be
            # in the API response, but the outbound webhook must not enqueue for a
            # rolled-back comment (ADR-0083 / ADR-0019).
            if created:
                mention_payload = {
                    **_task_webhook_payload(task),
                    "comment_id": comment_id_str,
                    "mention_count": created,
                }
                transaction.on_commit(
                    lambda: _dispatch_webhooks(project_id_str, "task.mentioned", mention_payload)
                )

        # comment_on_my_task (#639, ADR-0085 §4): notify the task's assignee that
        # their task got a comment — unless they wrote it, or were already
        # @mentioned in it (the mention path notifies them separately, so we
        # de-dup to avoid two pings for one comment).
        from django.contrib.auth.models import User as _User

        author = cast(_User, self.request.user)
        author_id = str(author.pk)
        assignee_id = str(task.assignee_id) if task.assignee_id else None
        if assignee_id and assignee_id != author_id and task.assignee:
            mentioned_usernames = {p.value for p in parsed if p.kind == "user"}
            assignee_username = task.assignee.username
            if assignee_username not in mentioned_usernames:
                author_name = author.get_full_name() or author.username
                c_subj = f"New comment on {task.name}"
                c_body = f'{author_name} commented on your task "{task.name}" in TruePPM.'
                transaction.on_commit(
                    lambda: _notify_event(
                        "comment_on_my_task", [assignee_id], c_subj, c_body, project_id_str
                    )
                )

        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_comment_created",
                {
                    "id": comment_id_str,
                    "task_id": task_id_str,
                    "parent_id": parent_id,
                    # Informational only (#1658): how many non-account external
                    # stakeholders an @program-stakeholders mention reached. 0 unless
                    # the comment resolved that group. No email is sent yet (#1675).
                    "external_recipient_count": external_recipient_count,
                },
            )
        )

        # ADR-0206: comment.created fires for *every* comment (distinct from
        # task.mentioned above, which fires only when a comment mentions someone).
        # The payload carries no body text (privacy-conservative) — see
        # _comment_created_webhook_payload. Built now inside the transaction and
        # captured by value so the on_commit callback does no DB work.
        comment_payload = _comment_created_webhook_payload(task, comment, source="api")
        transaction.on_commit(
            lambda: _dispatch_webhooks(project_id_str, "comment.created", comment_payload)
        )

    def perform_update(self, serializer: BaseSerializer[TaskComment]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = cast(TaskComment, serializer.instance)
        if instance.author_id != self.request.user.pk:
            raise serializers.ValidationError(
                {"detail": "Only the author can edit a comment."},
                code="comment_edit_not_author",
            )
        serializer.save()
        # Snapshot plain values BEFORE the on_commit lambda — never dereference
        # ORM instances inside the closure (broadcast-check H-1 pattern).
        project_id_str = str(instance.task.project_id)
        task_id_str = str(instance.task_id)
        comment_id_str = str(instance.pk)
        parent_id_str = str(instance.parent_id) if instance.parent_id else None
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_comment_updated",
                {
                    "id": comment_id_str,
                    "task_id": task_id_str,
                    "parent_id": parent_id_str,
                },
            )
        )

    def perform_destroy(self, instance: TaskComment) -> None:
        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        user = self.request.user
        role = _membership_role(self.request, instance.task.project_id)
        is_author = instance.author_id == user.pk
        is_admin = role is not None and role >= Role.ADMIN
        if not (is_author or is_admin):
            raise serializers.ValidationError(
                {"detail": "Only the author or a project admin can delete a comment."},
                code="comment_delete_forbidden",
            )
        instance.soft_delete(actor=user)
        # Snapshot plain values BEFORE the on_commit lambda (broadcast-check H-1).
        project_id_str = str(instance.task.project_id)
        task_id_str = str(instance.task_id)
        comment_id_str = str(instance.pk)
        parent_id_str = str(instance.parent_id) if instance.parent_id else None
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_comment_deleted",
                {
                    "id": comment_id_str,
                    "task_id": task_id_str,
                    "parent_id": parent_id_str,
                },
            )
        )

    @extend_schema(
        summary="Toggle acknowledgement on a comment",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "POST returns the acknowledgement row; DELETE returns a `deleted` count. "
                    "DELETE returns 404 when no acknowledgement existed."
                ),
            ),
            401: OpenApiResponse(description="Authentication required."),
            404: OpenApiResponse(description="No acknowledgement to remove (DELETE)."),
        },
    )
    @action(detail=True, methods=["post", "delete"], url_path="acknowledge")
    def acknowledge(self, request: Request, project_pk: str, task_pk: str, pk: str) -> Response:
        """Toggle the requesting user's acknowledgement on this comment.

        POST creates an ack (idempotent — second POST returns 200 with the existing row).
        DELETE removes the ack. NEVER triggers a notification (per ADR-0075 §A.3).
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        comment = self.get_object()
        user = request.user
        if not user.is_authenticated:
            return Response(status=status.HTTP_401_UNAUTHORIZED)

        # Body-less peer-state ping (#837): clients refetch the gated ack list via
        # REST, so the broadcast must NOT carry the acknowledger identity or an
        # aggregate count — that preserves the ADR-0075 §A.3 team-only ack
        # visibility (no PMO leak). Broadcast != notify; this still never notifies.
        def _broadcast_ack_changed() -> None:
            transaction.on_commit(
                lambda: broadcast_board_event(
                    str(project_pk),
                    "task_comment_ack_changed",
                    {"comment_id": str(pk), "task_id": str(task_pk)},
                )
            )

        if request.method == "POST":
            ack, _created = CommentAcknowledgement.objects.get_or_create(comment=comment, user=user)
            _broadcast_ack_changed()
            return Response(CommentAcknowledgementSerializer(ack).data, status=status.HTTP_200_OK)
        # DELETE
        deleted, _ = CommentAcknowledgement.objects.filter(comment=comment, user=user).delete()
        if deleted:
            _broadcast_ack_changed()
        return Response(
            {"deleted": deleted},
            status=status.HTTP_200_OK if deleted else status.HTTP_404_NOT_FOUND,
        )


class CommentReactionViewSet(
    ProjectScopedViewSet,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[CommentReaction],
):
    """👍 reaction on a task comment (ADR-0075 §A.4).

    Routes:
      POST   /projects/{project_pk}/tasks/{task_pk}/comments/{comment_pk}/reactions/
             { "emoji": "👍" }
      DELETE /projects/{project_pk}/tasks/{task_pk}/comments/{comment_pk}/reactions/{pk}/

    NEVER triggers a notification. Allow-list is enforced in the serializer.
    """

    serializer_class = CommentReactionSerializer
    # IsProjectNotArchived enforces the archived-read-only contract: reactions are
    # a write on a board-scoped resource and must be blocked once a project is archived.
    permission_classes: list[type[BasePermission]] = [
        IsAuthenticated,
        IsProjectMemberWrite,
        IsProjectNotArchived,
    ]

    def get_queryset(self) -> QuerySet[CommentReaction]:
        user = self.request.user
        if not user.is_authenticated:
            return CommentReaction.objects.none()
        project_pk = self.kwargs["project_pk"]
        comment_pk = self.kwargs["comment_pk"]
        # P21: membership is already enforced by IsProjectMemberWrite in
        # get_permissions() before get_queryset() runs — the extra
        # ProjectMembership.objects.exists() is a redundant round-trip (same
        # anti-pattern fixed for TaskAttachmentViewSet in #821).
        return CommentReaction.objects.filter(
            comment_id=comment_pk, comment__task__project_id=project_pk
        ).select_related("user")

    def perform_create(self, serializer: BaseSerializer[CommentReaction]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        comment_pk = self.kwargs["comment_pk"]
        task_pk = self.kwargs["task_pk"]
        comment = get_object_or_404(
            TaskComment, pk=comment_pk, task__project_id=project_pk, is_deleted=False
        )
        self.check_object_permissions(self.request, comment)
        # IsAuthenticated already gates this viewset; the guard narrows the type
        # for get_or_create's user kwarg (same idiom as the acknowledge action).
        user = self.request.user
        if not user.is_authenticated:
            raise NotAuthenticated
        # Idempotent create: a reaction is a toggle-on, and offline sync replays
        # the same POST until it sees a success. A bare serializer.save() hits the
        # (comment, user, emoji) unique constraint on any duplicate — a double-tap
        # or a sync retry — and raises IntegrityError → 500, which wedges the whole
        # sync queue in a retry loop (#1956). get_or_create makes the repeat a no-op
        # that returns the existing row, and only a genuinely new row broadcasts.
        emoji = serializer.validated_data["emoji"]
        reaction, created = CommentReaction.objects.get_or_create(
            comment=comment, user=user, emoji=emoji
        )
        serializer.instance = reaction
        if not created:
            return
        # Body-less peer-state ping (#837): the reaction renders inline on the
        # comment, so clients refetch ['task-comments', task_id]. Not a
        # notification (ADR-0075 §A.4) — broadcast != notify.
        # Snapshot plain values BEFORE the on_commit lambda (broadcast-check H-1).
        reaction_id = str(reaction.pk)
        project_id_str = str(project_pk)
        comment_id_str = str(comment_pk)
        task_id_str = str(task_pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_comment_reaction_added",
                {"id": reaction_id, "comment_id": comment_id_str, "task_id": task_id_str},
            )
        )

    def perform_destroy(self, instance: CommentReaction) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        if instance.user_id != self.request.user.pk:
            raise serializers.ValidationError(
                {"detail": "You can only remove your own reactions."},
                code="reaction_delete_forbidden",
            )
        # Snapshot plain values BEFORE the on_commit lambda (broadcast-check H-1).
        reaction_id = str(instance.pk)
        comment_id = str(instance.comment_id)
        project_pk = str(self.kwargs["project_pk"])
        task_pk = str(self.kwargs["task_pk"])
        instance.delete()
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_pk,
                "task_comment_reaction_removed",
                {"id": reaction_id, "comment_id": comment_id, "task_id": task_pk},
            )
        )


class TaskNoteViewSet(
    ProjectScopedViewSet,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet[TaskNote],
):
    """Per-author task note — the why/decision log (ADR-0143, #740).

    Routes (relative to /projects/{project_pk}/tasks/{task_pk}/):
      GET    notes/
      POST   notes/
      GET    notes/{pk}/
      PATCH  notes/{pk}/      (author only, within the 15-min edit window)
      DELETE notes/{pk}/      (author OR Admin+; soft-delete)
      POST   notes/{pk}/pin/  (toggle pin — Member+; exempt from the edit window)

    Distinct from TaskCommentViewSet: no @mention fan-out, no replies/reactions/
    acks. Note CRUD never touches Task scheduling fields, so it never triggers a
    CPM recalculate.
    """

    serializer_class = TaskNoteSerializer

    def get_queryset(self) -> QuerySet[TaskNote]:
        user = self.request.user
        if not user.is_authenticated:
            return TaskNote.objects.none()
        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        # Membership is enforced by IsProjectMember/IsProjectMemberWrite
        # (get_permissions) before get_queryset runs. `task` is select_related so
        # perform_destroy's instance.task.project_id is free. Ordering comes from
        # Meta (-pinned, -created_at) — pinned-first, then newest.
        # P4: add task__sprint and task__project so DecisionNoteSerializer's
        # get_sprint (task.sprint FK) and get_project context (task.project FK)
        # don't fire extra queries per note row.
        return TaskNote.objects.filter(
            task__project_id=project_pk,
            task_id=task_pk,
            is_deleted=False,
        ).select_related("author", "deleted_by", "task", "task__sprint", "task__project")

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("create", "partial_update", "update", "destroy", "pin", "decision"):
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    def perform_create(self, serializer: BaseSerializer[TaskNote]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, task)

        # Per-task count cap (ADR-0143 DoS guard).
        if TaskNote.objects.filter(task=task, is_deleted=False).count() >= MAX_NOTES_PER_TASK:
            raise serializers.ValidationError(
                {"detail": f"This task has the maximum of {MAX_NOTES_PER_TASK} notes."},
                code="note_count_cap",
            )

        note = serializer.save(task=task, author=self.request.user)
        # Snapshot plain values BEFORE the on_commit lambda (broadcast-check H-1).
        note_id_str = str(note.pk)
        task_id_str = str(task.pk)
        project_id_str = str(project_pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_note_created",
                {"id": note_id_str, "task_id": task_id_str},
            )
        )

    def perform_update(self, serializer: BaseSerializer[TaskNote]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = cast(TaskNote, serializer.instance)
        # Author-only edit — the serializer enforces the time window; this guards
        # the actor. (Pin uses a separate action that bypasses both.)
        if instance.author_id != self.request.user.pk:
            raise serializers.ValidationError(
                {"detail": "Only the author can edit a note."},
                code="note_edit_not_author",
            )
        serializer.save()
        # Snapshot plain values BEFORE the on_commit lambda (broadcast-check H-1).
        project_id_str = str(instance.task.project_id)
        task_id_str = str(instance.task_id)
        note_id_str = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_note_updated",
                {"id": note_id_str, "task_id": task_id_str},
            )
        )

    def perform_destroy(self, instance: TaskNote) -> None:
        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        user = self.request.user
        role = _membership_role(self.request, instance.task.project_id)
        is_author = instance.author_id == user.pk
        is_admin = role is not None and role >= Role.ADMIN
        if not (is_author or is_admin):
            raise serializers.ValidationError(
                {"detail": "Only the author or a project admin can delete a note."},
                code="note_delete_forbidden",
            )
        instance.soft_delete(actor=user)
        # Snapshot plain values BEFORE the on_commit lambda (broadcast-check H-1).
        project_id_str = str(instance.task.project_id)
        task_id_str = str(instance.task_id)
        note_id_str = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_note_deleted",
                {"id": note_id_str, "task_id": task_id_str},
            )
        )

    @extend_schema(
        summary="Toggle pin on a note",
        request=None,
        responses={
            200: TaskNoteSerializer,
            401: OpenApiResponse(description="Authentication required."),
            404: OpenApiResponse(description="Note not found."),
        },
    )
    @action(detail=True, methods=["post"], url_path="pin")
    def pin(self, request: Request, project_pk: str, task_pk: str, pk: str) -> Response:
        """Toggle this note's pinned state.

        Curation, not authorship — any project writer (Member+) may pin/unpin any
        note, and pinning is exempt from the author-only 15-min edit window.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        note = self.get_object()
        note.pinned = not note.pinned
        note.save(update_fields=["pinned"])
        # Snapshot plain values BEFORE the on_commit lambda (broadcast-check H-1).
        project_id_str = str(project_pk)
        task_id_str = str(task_pk)
        note_id_str = str(note.pk)
        pinned_now = note.pinned
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_note_pinned",
                {"id": note_id_str, "task_id": task_id_str, "pinned": pinned_now},
            )
        )
        return Response(self.get_serializer(note).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Toggle the decision flag on a note (ADR-0167, #748)",
        request=None,
        responses={
            200: TaskNoteSerializer,
            401: OpenApiResponse(description="Authentication required."),
            404: OpenApiResponse(description="Note not found."),
        },
    )
    @action(detail=True, methods=["post"], url_path="decision")
    def decision(self, request: Request, project_pk: str, task_pk: str, pk: str) -> Response:
        """Toggle this note's ``decision`` flag — the seam that promotes a note into the
        project/sprint Decisions log (ADR-0167).

        Curation, not authorship — any project writer (Member+) may flag/unflag any note,
        exempt from the author-only 15-min edit window, exactly like ``pin``. The flag is
        the only structured Decisions marker (no taxonomy). ``TaskNote`` is intentionally
        not a ``VersionedModel`` (ADR-0143), so there is no ``server_version`` to bump;
        clients reconcile via REST refetch + the board broadcast below.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        note = self.get_object()
        note.decision = not note.decision
        note.save(update_fields=["decision"])
        # Snapshot plain values BEFORE the on_commit lambda (broadcast-check H-1). The
        # event carries no note body — a board event is never a place to read note text
        # (ADR-0124 privacy idiom); the Decisions list itself is REST-gated.
        project_id_str = str(project_pk)
        task_id_str = str(task_pk)
        note_id_str = str(note.pk)
        decision_now = note.decision
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_note_decision_toggled",
                {"id": note_id_str, "task_id": task_id_str, "decision": decision_now},
            )
        )
        return Response(self.get_serializer(note).data, status=status.HTTP_200_OK)
