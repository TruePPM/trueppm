"""DRF ViewSets for the projects app."""

from __future__ import annotations

import contextlib
import datetime
import logging
import re
import uuid
from typing import Any, cast

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.db import models as db_models
from django.db.models import (
    Avg,
    BooleanField,
    Count,
    Exists,
    ExpressionWrapper,
    F,
    IntegerField,
    Max,
    OuterRef,
    Q,
    QuerySet,
    Subquery,
    Sum,
)
from django.db.models.expressions import RawSQL
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import filters, generics, mixins, pagination, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import SAFE_METHODS, BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    IsOrgAdmin,
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProjectAdmin,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectMemberWriteOrOwn,
    IsProjectNotArchived,
    IsProjectOwner,
    IsProjectScheduler,
    IsTokenForProject,
    ProjectScopedViewSet,
)
from trueppm_api.apps.access.services import transfer_project_ownership
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import (
    ApiToken,
    Baseline,
    BaselineTask,
    BoardColumnConfig,
    BoardSavedView,
    Calendar,
    CommentAcknowledgement,
    CommentReaction,
    Dependency,
    EstimateStatus,
    EstimationMode,
    Project,
    ProjectApiToken,
    ProjectCustomField,
    Risk,
    RiskComment,
    RiskStatus,
    Sprint,
    SprintState,
    Task,
    TaskAttachment,
    TaskComment,
    TaskStatus,
)
from trueppm_api.apps.projects.serializers import (
    _DEFAULT_COLUMNS,
    ApiTokenAuditEntrySerializer,
    BaselineDetailSerializer,
    BaselineSerializer,
    BoardColumnConfigSerializer,
    BoardSavedViewSerializer,
    CalendarSerializer,
    CommentAcknowledgementSerializer,
    CommentReactionSerializer,
    CycleDetectedError,
    DependencySerializer,
    InboundTaskSyncPayloadSerializer,
    MeWorkActiveSprintSerializer,
    MeWorkTaskSerializer,
    MilestoneRollupLockedError,
    PhaseSerializer,
    ProgressAnchorError,
    ProjectApiTokenCreateSerializer,
    ProjectApiTokenSerializer,
    ProjectCustomFieldSerializer,
    ProjectDetailSerializer,
    ProjectSerializer,
    RiskCommentSerializer,
    RiskSerializer,
    SignedDownloadUrlSerializer,
    SprintBurnSnapshotSerializer,
    SprintCloseRequestSerializer,
    SprintSerializer,
    TaskAttachmentSerializer,
    TaskBulkSerializer,
    TaskCommentSerializer,
    TaskReorderSerializer,
    TaskSerializer,
)
from trueppm_api.apps.scheduling.models import ScheduleRequestReason
from trueppm_api.apps.scheduling.services import enqueue_recalculate as _enqueue_recalculate
from trueppm_api.apps.webhooks.models import (
    DeliveryStatus,
    Webhook,
    WebhookDelivery,
)

logger = logging.getLogger(__name__)

# Allow-list pattern for the X-Source request header value (ADR-0065 Gap 2).
# Lower-case ASCII letters and underscores, 1–64 chars. Any other input is
# coerced to "unknown" before reaching the stored webhook payload — protects
# downstream third-party consumers from arbitrary Unicode or oversized strings.
_VALID_SOURCE = re.compile(r"[a-z_]{1,64}")


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


class ProjectViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Project]):
    """CRUD for projects.

    Any authenticated user can create a project; on creation the creator is
    automatically assigned the Owner role via perform_create().

    Permission matrix (issue #11):
      list/retrieve/create/update — any member (IsProjectMember)
      destroy                     — Project Admin (Owner) only (IsProjectOwner)
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get_permissions(self) -> list[BasePermission]:
        # Lifecycle actions (archive/unarchive/destroy/transfer) bypass the
        # IsProjectNotArchived gate via its _ARCHIVE_BYPASS_ACTIONS set —
        # otherwise an Owner could never unarchive or delete an archived row.
        if self.action in ("destroy", "archive", "unarchive", "transfer"):
            return [IsAuthenticated(), IsProjectOwner(), IsProjectNotArchived()]
        if self.action in ("utilization", "resource_allocation", "heatmap", "resources_summary"):
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    queryset = Project.objects.select_related("calendar").order_by("start_date", "name")
    serializer_class = ProjectSerializer
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
        "Ungrouped projects" section (ADR-0083).

        The aggregates (``member_count``, ``percent_complete``) are attached ONLY
        on that branch — the default list stays a single unannotated query at
        portfolio scale. Archived and soft-deleted projects are excluded from the
        ungrouped view: a project that is out of active management should not be
        nagged as "needing a home".
        """
        qs = super().get_queryset()
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
        project_id = str(project.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_created", {"id": project_id})
        )
        payload = {"id": project_id, "name": project.name, "start_date": str(project.start_date)}
        transaction.on_commit(lambda: _dispatch_webhooks(project_id, "project.created", payload))

    def perform_update(self, serializer: BaseSerializer[Project]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_updated", {"id": project_id})
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
            transaction.on_commit(
                lambda: broadcast_board_event(
                    project_id, "project_hard_deleted", {"id": project_id}
                )
            )
            return

        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "project_deleted", {"id": project_id})
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

    @action(detail=True, methods=["get"], url_path="utilization")
    def utilization(self, request: Request, pk: str | None = None) -> Response:
        """Per-resource daily utilization for a project.

        Returns a sparse map of resource → working day → {hours, task_ids}.
        Requires Resource Manager role (SCHEDULER ≥ 2).

        Query parameters:
          start (YYYY-MM-DD) — window start, inclusive; defaults to earliest
                               early_start across all project tasks.
          end   (YYYY-MM-DD) — window end, inclusive; defaults to latest
                               early_finish across all project tasks.

        Returns 409 when no CPM dates exist on any task (scheduler not run yet).
        """
        from trueppm_api.apps.projects.utilization import compute_utilization

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
            if start_str:
                window_start = _parse_date(start_str, "start")
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
                window_end = _parse_date(end_str, "end")
            else:
                last = (
                    project.tasks.filter(is_deleted=False, early_finish__isnull=False)
                    .order_by("-early_finish")
                    .values_list("early_finish", flat=True)
                    .first()
                )
                window_end = last if last is not None else window_start

        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        if window_start > window_end:
            return Response(
                {"detail": "'start' must not be after 'end'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        result = compute_utilization(project, window_start, window_end)
        return Response(result)

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
                today = datetime.date.today()
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

        today = datetime.date.today()
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
        incomplete_tasks = project.tasks.filter(
            is_deleted=False,
        ).exclude(status=TaskStatus.COMPLETE)

        task_count = project.tasks.filter(is_deleted=False).count()

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
        at_risk_count = incomplete_tasks.filter(
            total_float__isnull=False,
            total_float__lte=5,
        ).count()

        critical_qs = (
            incomplete_tasks.filter(is_critical=True)
            .order_by("wbs_path")
            .values("id", "name", "wbs_path")[:5]
        )
        critical_tasks = [
            {"id": str(t["id"]), "name": t["name"], "wbs": t["wbs_path"]} for t in critical_qs
        ]
        critical_count = incomplete_tasks.filter(is_critical=True).count()

        # Task model uses server_version rather than auto_now timestamps, so
        # last_saved / recalculated_at are returned as null. The redesigned
        # StatusBar (issue #201) does not display these fields; they remain
        # in the response shape only for ShellStats back-compat.
        return Response(
            {
                "task_count": task_count,
                "critical_path_count": critical_count,
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
        items = (
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
    qs = ApiToken.objects.filter(
        scope_filter,
        is_deleted=False,
        revoked_at__isnull=True,
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


class TaskViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Task]):
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
        if self.action in ("update", "partial_update", "destroy"):
            return [IsAuthenticated(), IsProjectMemberWriteOrOwn(), IsProjectNotArchived()]
        if self.action == "create":
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        if self.action == "approve_estimates":
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    serializer_class = TaskSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name"]
    ordering_fields = ["wbs_path", "name", "early_start", "status"]
    queryset = (
        Task.objects.select_related("project", "sprint")
        .prefetch_related("assignments__resource")
        .filter(is_deleted=False)
    )

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
        start_gte = self.request.query_params.get("start__gte")
        if start_gte:
            qs = qs.filter(early_finish__gte=start_gte)
        finish_lte = self.request.query_params.get("finish__lte")
        if finish_lte:
            qs = qs.filter(early_start__lte=finish_lte)

        # Summary task annotations: is_summary = has at least one direct child,
        # parent_id = the task whose wbs_path is this task's parent path,
        # percent_complete_rollup = duration-weighted average of direct children's
        #   percent_complete (NULL for leaf tasks, avoids per-row raw query in serializer).
        # Uses ltree operators via RawSQL for PostgreSQL-native performance.
        qs = qs.annotate(
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
            # Returns the duration-weighted average percent_complete of ALL LEAF descendants,
            # or NULL for leaf tasks (which the serializer leaves untouched).
            #
            # Previously used '.*{1}' (direct children only). For 3-level WBS this caused
            # grandparent summaries to read zero — the intermediate summary's stored
            # percent_complete is 0 (not persisted); only leaves have live values.
            # Fix: select all descendants at any depth ('.*{1,}') then exclude any
            # descendant that itself has children (non-leaf), so only leaf tasks contribute.
            percent_complete_rollup=RawSQL(
                "("
                "  SELECT CASE WHEN SUM(c.duration) > 0"
                "              THEN SUM(c.duration * c.percent_complete) / SUM(c.duration)"
                "              ELSE NULL END"
                "  FROM projects_task c"
                "  WHERE c.project_id = projects_task.project_id"
                "    AND c.is_deleted = false"
                "    AND projects_task.wbs_path IS NOT NULL"
                "    AND c.wbs_path ~ (projects_task.wbs_path::text || '.*{1,}')::lquery"
                "    AND NOT EXISTS ("
                "      SELECT 1 FROM projects_task gc"
                "      WHERE gc.project_id = projects_task.project_id"
                "        AND gc.is_deleted = false"
                "        AND gc.wbs_path ~ (c.wbs_path::text || '.*{1}')::lquery"
                "    )"
                ")",
                [],
                output_field=db_models.FloatField(),
            ),
        )

        # Readiness annotation: has_predecessors = task has at least one incoming
        # Dependency edge.  Used by TaskSerializer.get_readiness() to distinguish
        # 'estimated' (has owner, no predecessors) from 'ready' (has owner + predecessors).
        qs = qs.annotate(
            has_predecessors=Exists(Dependency.objects.filter(successor=OuterRef("pk")))
        )

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
        )

        # Baseline overlay: annotate each task with baseline_start / baseline_finish.
        # Resolution order:
        #   1. ?baseline=<id> explicit override
        #   2. the project's active baseline (is_active=True)
        #   3. no annotation (both fields are null in the response)
        resolved_baseline_id: str | None = self.request.query_params.get("baseline")
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
            )
        )

        return cast("QuerySet[Task]", qs)

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
                    # Depth-1 enforcement (ADR-0060): subtasks are leaf nodes —
                    # no task of any kind may be created as a child of a subtask.
                    # Checked on every parent_id path, not only is_subtask=True
                    # requests, so the "Add Task" entry point cannot bypass it.
                    if parent.is_subtask:
                        raise DRFValidationError(
                            {"parent_id": "Cannot create a child of a subtask."}
                        )
                    children = _get_siblings(str(project.pk), str(parent.wbs_path), lock=True)
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
                    from trueppm_api.apps.projects.models import SprintScopeChange
                    from trueppm_api.apps.projects.signals import subtask_sprint_scope_changed

                    scope_change = SprintScopeChange.objects.create(
                        task=parent,
                        sprint_id=parent.sprint_id,
                        subtask_name=instance.name,
                        added_by=self.request.user if self.request.user.is_authenticated else None,
                    )
                    subtask_sprint_scope_changed.send(
                        sender=SprintScopeChange,
                        scope_change=scope_change,
                        parent_task=parent,
                    )

        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_created", {"id": task_id})
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

        instance = serializer.save()
        project_id = str(instance.project_id)
        task_id = str(instance.pk)
        transaction.on_commit(lambda: _enqueue_recalculate(project_id))
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "task_updated", {"id": task_id})
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
        # and the before/after snapshot is the idempotency guard, ADR-0083).
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

        # task.due_date_changed binds to planned_start (the PM-committed date) —
        # Task has no dedicated deadline field; #690 rebinds this to planned_finish.
        new_planned_start = payload["planned_start"]
        if new_planned_start != old_planned_start:
            date_payload = {**payload, "previous_planned_start": old_planned_start}
            transaction.on_commit(
                lambda: _dispatch_webhooks(project_id, "task.due_date_changed", date_payload)
            )

    def update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        try:
            return super().update(request, *args, **kwargs)
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

    def partial_update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        try:
            return super().partial_update(request, *args, **kwargs)
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

    @action(
        detail=True,
        methods=["post"],
        url_path="suggestions/accept",
    )
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

    @action(
        detail=True,
        methods=["post"],
        url_path="suggestions/decline",
    )
    def decline_suggestion(
        self,
        request: Request,
        pk: str | None = None,
        suggestion_pk: str | None = None,
        **kwargs: Any,
    ) -> Response:
        """Decline a PENDING TaskSuggestedAssignee.

        Only the ``suggested_user`` may call. No broadcast — declines are
        private (Priya's psych-safety note in the VoC).
        """
        from django.contrib.auth.models import User as _User

        from trueppm_api.apps.projects.models import (
            SuggestionState,
            TaskSuggestedAssignee,
        )

        if pk is None or suggestion_pk is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        suggestion = TaskSuggestedAssignee.objects.filter(
            pk=suggestion_pk, task_id=pk, is_deleted=False
        ).first()
        if suggestion is None:
            return Response(
                {"detail": "Suggestion not found."},
                status=status.HTTP_404_NOT_FOUND,
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
        return Response(
            {
                "id": str(suggestion.pk),
                "state": suggestion.state,
                "declined_at": suggestion.declined_at,
            },
            status=status.HTTP_200_OK,
        )

    @action(
        detail=True,
        methods=["post"],
        url_path="suggestions/revoke",
    )
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

        from trueppm_api.apps.access.models import ProjectMembership, Role
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
        is_originator = suggestion.suggested_by_id == caller.pk
        caller_role: int = (
            ProjectMembership.objects.filter(
                project_id=suggestion.task.project_id, user=caller, is_deleted=False
            )
            .values_list("role", flat=True)
            .first()
            or -1
        )
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
        return Response(
            {"id": str(suggestion.pk), "state": suggestion.state},
            status=status.HTTP_200_OK,
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
        """Snapshot all live task dates atomically and broadcast baseline_created."""
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, project)

        # Auto-name: "Baseline N" where N = existing count + 1
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
            )
        )
        has_cpm_dates = bool(live_tasks) and all(t["early_start"] is not None for t in live_tasks)

        with transaction.atomic():
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


class DependencyViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Dependency]):
    """CRUD for task dependencies.

    Dependency creation/modification affects CPM scheduling; Resource Manager+
    (IsProjectScheduler) is required for write operations (issue #11 role matrix).
    """

    permission_classes = [IsAuthenticated, IsProjectScheduler, IsProjectNotArchived]

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]

    serializer_class = DependencySerializer
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["dep_type"]
    queryset = Dependency.objects.select_related("predecessor", "successor").filter(
        is_deleted=False
    )

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
        qs = super().get_queryset()
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
        return qs

    def perform_create(self, serializer: BaseSerializer[Dependency]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # H1 fix: DRF does not call has_object_permission on create actions,
        # so we must verify the predecessor task belongs to a project the caller
        # is a member of (Resource Manager+) before saving.
        predecessor = serializer.validated_data.get("predecessor")
        if predecessor is not None:
            self.check_object_permissions(self.request, predecessor)

        instance = serializer.save()
        project_id = str(instance.predecessor.project_id)
        dep_id = str(instance.pk)
        transaction.on_commit(
            lambda: _enqueue_recalculate(project_id, reason=ScheduleRequestReason.DEPENDENCY_CHANGE)
        )
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

        instance = serializer.save()
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

        project_id = str(instance.predecessor.project_id)
        dep_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(
            lambda: _enqueue_recalculate(project_id, reason=ScheduleRequestReason.DEPENDENCY_CHANGE)
        )
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "dependency_deleted", {"id": dep_id})
        )
        transaction.on_commit(
            lambda: _dispatch_webhooks(project_id, "dependency.deleted", {"id": dep_id})
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

        new_parent_id = request.data.get("new_parent_id")

        with transaction.atomic():
            task = get_object_or_404(
                Task.objects.select_for_update(),
                pk=task_id,
                project_id=pk,
                is_deleted=False,
            )
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
                .select_related("sprint")
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
                    result["created"].append(TaskSerializer(task).data)

                elif op_type == "update":
                    task = locked_tasks[op["id"]]
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
                    result["updated"].append(TaskSerializer(task).data)

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
            transaction.on_commit(lambda: _enqueue_recalculate(project_id))
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_bulk_mutated", {})
            )

        return Response(result, status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# Risk register
# ---------------------------------------------------------------------------


class RiskViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Risk]):
    """CRUD for risks within a project.

    Permission matrix:
      list / retrieve         — Viewer+ (IsProjectMember)
      create / update         — Team Member+ (IsProjectMemberWrite)
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
        risk_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(str(project_pk), "risk_created", {"id": risk_id})
        )

    def perform_update(self, serializer: BaseSerializer[Risk]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = serializer.save()
        project_id = str(instance.project_id)
        risk_id = str(instance.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "risk_updated", {"id": risk_id})
        )

    def perform_destroy(self, instance: Risk) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_id = str(instance.project_id)
        risk_id = str(instance.pk)
        instance.soft_delete()
        transaction.on_commit(
            lambda: broadcast_board_event(project_id, "risk_deleted", {"id": risk_id})
        )


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
        get_object_or_404(Project, pk=pk)

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


# ---------------------------------------------------------------------------
# Board column configuration
# ---------------------------------------------------------------------------


class BoardColumnConfigView(IdempotencyMixin, APIView):
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
        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)
        try:
            config = BoardColumnConfig.objects.get(project_id=pk)
            columns = config.columns or _DEFAULT_COLUMNS
        except BoardColumnConfig.DoesNotExist:
            columns = _DEFAULT_COLUMNS
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


class BoardSavedViewListView(IdempotencyMixin, APIView):
    """GET/POST per-project board saved view list.

    GET  returns all saved views for the project, ordered by name.
    POST creates a new named view; name must be unique per project.
    Any authenticated project member may read and create views.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

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
        with transaction.atomic():
            saved_view = serializer.save(server_version=saved_view.server_version + 1)
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


class ProjectOverviewView(APIView):
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

    def get(self, request: Request, pk: str) -> Response:
        """Return KPI data for the project overview page."""
        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)

        today = datetime.date.today()
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
        else:
            # No baseline: fall back to CPM schedule (known limitation — drifts on rerun).
            planned_count = Task.objects.filter(
                project=project, is_deleted=False, early_finish__lte=today
            ).count()

        if planned_count > 0:
            # Count tasks complete by today; null actual_finish on a complete task counts.
            planned_complete: int = (
                Task.objects.filter(project=project, is_deleted=False, status=TaskStatus.COMPLETE)
                .filter(
                    db_models.Q(actual_finish__lte=today) | db_models.Q(actual_finish__isnull=True)
                )
                .count()
            )
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
        open_risks = list(
            Risk.objects.filter(
                project=project,
                status__in=[RiskStatus.OPEN, RiskStatus.MITIGATING],
            ).values("probability", "impact")
        )
        open_risk_count = len(open_risks)
        high_risk_count = sum(
            1 for r in open_risks if (r["probability"] or 0) * (r["impact"] or 0) >= 12
        )

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

    def get(self, request: Request, pk: str) -> Response:
        """Return attention items for the project overview page."""
        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)

        today = datetime.date.today()
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

    def get(self, request: Request, pk: str) -> Response:
        """Return this week's tasks for the requesting user."""
        project = get_object_or_404(Project, pk=pk)
        self.check_object_permissions(request, project)

        today = datetime.date.today()
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

# Fields exposed in the history diff — CPM outputs and sync internals excluded.
_HISTORY_DIFF_FIELDS = [
    "name",
    "duration",
    "status",
    "percent_complete",
    "planned_start",
    "actual_start",
    "actual_finish",
    "optimistic_duration",
    "most_likely_duration",
    "pessimistic_duration",
    "estimate_status",
]


class TaskHistoryView(APIView):
    """Paginated field-level diff history for a single task.

    Returns HistoricalTask records in descending date order, each with a diff
    list comparing it to the immediately preceding version.  The first record
    (task creation) always has an empty diff — no previous version to compare.

    Accessible to all project members (Viewer+).  history_user is the username
    of the user who made the change; null for programmatic writes.
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get(self, request: Request, project_pk: str, task_pk: str) -> Response:
        project = get_object_or_404(Project, pk=project_pk, is_deleted=False)
        if not IsProjectMember().has_object_permission(request, self, project):
            return Response({"detail": "Permission denied."}, status=status.HTTP_403_FORBIDDEN)

        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)

        records = list(task.history.order_by("-history_date").select_related("history_user"))

        result = []
        for i, record in enumerate(records):
            older = records[i + 1] if i + 1 < len(records) else None
            diff = []
            if older is not None:
                for field in _HISTORY_DIFF_FIELDS:
                    new_val = getattr(record, field, None)
                    old_val = getattr(older, field, None)
                    if new_val != old_val:
                        diff.append(
                            {
                                "field": field,
                                "old": str(old_val) if old_val is not None else None,
                                "new": str(new_val) if new_val is not None else None,
                            }
                        )

            result.append(
                {
                    "id": record.history_id,
                    "history_date": record.history_date.isoformat(),
                    "history_type": record.history_type,
                    "history_user": (record.history_user.username if record.history_user else None),
                    "diff": diff,
                }
            )

        from rest_framework.pagination import PageNumberPagination

        paginator = PageNumberPagination()
        paginator.page_size = 20
        page: list[Any] | None = paginator.paginate_queryset(result, request)  # type: ignore[arg-type]
        return paginator.get_paginated_response(page)


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
        """Set ``descendants_count`` on each phase from a single grouped query.

        Counts include the phase itself plus every non-deleted descendant
        task. For an empty phase the count is 1; for a phase with two child
        tasks it is 3. Two queries total (one for phases, one for the
        per-phase count map) rather than N+1 per-phase counts.
        """
        if not phases:
            return phases
        project_id = phases[0].project_id
        counts: dict[str, int] = {}
        # Single query: count non-deleted tasks per root prefix. We bucket every
        # task by its WBS root (the substring before the first dot, or the
        # whole path for L1 rows).
        rows = (
            Task.objects.filter(project_id=project_id, is_deleted=False)
            .exclude(wbs_path__isnull=True)
            .values_list("wbs_path", flat=True)
        )
        for path in rows:
            if path is None:
                continue
            root = str(path).split(".", 1)[0]
            counts[root] = counts.get(root, 0) + 1
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
        return Task.objects.filter(
            project_id=project_pk,
            is_deleted=False,
            wbs_path__regex=_ROOT_WBS_RE,
        ).order_by("priority_rank", "wbs_path", "name")

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


class SprintViewSet(ProjectScopedViewSet, viewsets.ModelViewSet[Sprint]):
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

    queryset = Sprint.objects.select_related("project", "created_by").filter(is_deleted=False)
    serializer_class = SprintSerializer
    filter_backends = [filters.OrderingFilter]
    ordering_fields = ["start_date", "finish_date", "name", "state"]

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("list", "retrieve", "burndown", "capacity"):
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # `retro` accepts GET (read) / POST (write) / PATCH (partial write).
        # Read needs membership; writes need write role.
        if self.action == "retro" and self.request.method == "GET":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # Retro-related read-only actions (prior retro): Viewer+ on the project.
        if self.action == "retro_prior":
            return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]
        # Pulling a carryover item into the sprint requires SCHEDULER+ — the
        # sole path that can assign a retro action item to a sprint per ADR-0071.
        if self.action == "pull_action_item_to_sprint":
            return [IsAuthenticated(), IsProjectScheduler(), IsProjectNotArchived()]
        if self.action == "destroy":
            return [IsAuthenticated(), IsProjectAdmin(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]

    def get_queryset(self) -> QuerySet[Sprint]:
        qs = super().get_queryset()
        project_pk = self.kwargs.get("project_pk")
        if project_pk:
            qs = qs.filter(project_id=project_pk)
        state_filter = self.request.query_params.get("state")
        if state_filter:
            qs = qs.filter(state=state_filter)
        return qs

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

    @action(detail=True, methods=["post"])
    def activate(self, request: Request, pk: str | None = None) -> Response:
        """Transition PLANNED → ACTIVE.

        Snapshots committed_points and committed_task_count from the current
        backlog. Enforces the single-active-sprint-per-project soft constraint
        (409 with conflicting sprint id). Returns the updated sprint plus a
        non-blocking ``warnings`` array for over-allocated members
        (ADR-0037 Q2 amendment).
        """
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
            # ADR-0074: recompute the linked milestone's rollup so the Gantt
            # reflects the now-active sprint immediately. No-op when the
            # sprint has no target milestone.
            if sprint.target_milestone_id is not None:
                recompute_milestone_rollup(sprint.target_milestone_id)

        data = SprintSerializer(sprint).data
        data["warnings"] = warnings
        return Response(data, status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"])
    def close(self, request: Request, pk: str | None = None) -> Response:
        """Async transition ACTIVE → COMPLETED via the outbox drain.

        Returns 202 Accepted with the SprintCloseRequest id. The frontend
        polls retrieve or subscribes via WebSocket to observe ``state=COMPLETED``.
        """
        from trueppm_api.apps.projects.services import enqueue_sprint_close

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

        with transaction.atomic():
            req = enqueue_sprint_close(
                sprint_id=sprint.pk,
                carry_over_to=carry_over_to,
                requested_by=request.user,
            )
        return Response(
            {"queued": True, "request_id": str(req.id)},
            status=status.HTTP_202_ACCEPTED,
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

    @action(detail=True, methods=["get"])
    def burndown(self, request: Request, pk: str | None = None) -> Response:
        """Return the sprint plus its actual burn snapshot series."""
        sprint = get_object_or_404(
            Sprint.objects.select_related("project", "created_by"),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, sprint)
        snapshots = sprint.burn_snapshots.all().order_by("snapshot_date")
        payload = {
            "sprint": SprintSerializer(sprint).data,
            "snapshots": SprintBurnSnapshotSerializer(snapshots, many=True).data,
        }
        return Response(payload, status=status.HTTP_200_OK)

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
            retro = SprintRetro.objects.filter(sprint=sprint, is_deleted=False).first()
            if retro is None:
                return Response(
                    {"detail": "No retro recorded for this sprint."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            serializer_cls = _pick_serializer(retro)
            return Response(serializer_cls(retro).data, status=status.HTTP_200_OK)

        # PATCH — partial update, currently scoped to team_visibility.
        if request.method == "PATCH":
            retro = SprintRetro.objects.filter(sprint=sprint, is_deleted=False).first()
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
            return Response(_pick_serializer(retro)(retro).data, status=status.HTTP_200_OK)

        # POST — upsert. Write permission already enforced via get_permissions().
        # ADR-0071: this path no longer auto-promotes. Action items land as
        # RetroActionItem rows only; the explicit /promote/ action converts
        # them to BACKLOG Tasks under sprint sovereignty.
        notes = request.data.get("notes", "")
        items_in: list[dict[str, Any]] = list(request.data.get("action_items", []) or [])
        new_visibility = request.data.get("team_visibility")

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
            retro.action_items.filter(is_deleted=False).delete()
            for entry in items_in:
                text = (entry.get("text") or "").strip()
                if not text:
                    continue
                RetroActionItem.objects.create(
                    retro=retro,
                    text=text,
                    assignee_id=entry.get("assignee") or None,
                    story_points=entry.get("story_points"),
                )

        retro.refresh_from_db()
        return Response(_pick_serializer(retro)(retro).data, status=status.HTTP_200_OK)

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
        prior_retro = SprintRetro.objects.filter(sprint=prior, is_deleted=False).first()
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
            capacity_summary,
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

        sprints = list(
            Sprint.objects.filter(pk__in=sprint_ids, is_deleted=False)
            .select_related("project", "target_milestone")
            .order_by("project__name")
        )

        today = timezone.localdate()
        results: list[dict[str, Any]] = []
        velocity_cache: dict[str, dict[str, Any]] = {}
        for sprint in sprints:
            window = (sprint.finish_date - sprint.start_date).days + 1
            elapsed = (today - sprint.start_date).days + 1
            day = max(1, min(elapsed, window))

            committed = sprint.committed_points or 0
            latest = (
                sprint.burn_snapshots.order_by("-snapshot_date").values("remaining_points").first()
            )
            remaining = latest["remaining_points"] if latest else committed
            ideal_now = committed * (1 - day / window) if window > 0 else 0
            trend_pts = round(ideal_now - remaining)  # positive = ahead

            cap = capacity_summary(sprint)
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


class MeWorkView(generics.ListAPIView[Task]):
    """``GET /api/v1/me/work/`` — contributor's flat task list across all projects.

    Returns the requesting user's assigned, non-BACKLOG, non-soft-deleted tasks
    grouped (client-side) by active sprint. Deliberately flat — no CPM fields,
    no WBS hierarchy, no phase tree. The contributor (Priya persona) reads this
    as a personal to-do list; PM-level concepts (critical path, float, schedule
    variance) are intentionally absent.

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
            "server_version_high_water": 12345
        }
    """

    permission_classes = [IsAuthenticated]
    serializer_class = MeWorkTaskSerializer
    pagination_class = MeWorkPagination

    def get_queryset(self) -> QuerySet[Task]:
        from django.db.models import Case, IntegerField, Value, When
        from django.db.models.functions import Coalesce

        # IsAuthenticated guarantees request.user is a real User (not Anonymous)
        # by the time this runs. Filter by ``user.pk`` rather than the instance
        # so the type-checker sees a concrete int/UUID and not the ``User |
        # AnonymousUser`` DRF union — matches MeActiveSprintsView. The
        # ``or -1`` keeps mypy happy about the ``int | None`` from .pk; the
        # value can't be None at runtime because IsAuthenticated rejected
        # anonymous callers earlier in the request lifecycle.
        user_pk = self.request.user.pk or -1
        return (
            Task.objects.filter(
                assignee_id=user_pk,
                is_deleted=False,
                project__is_deleted=False,
                project__memberships__user_id=user_pk,
                project__memberships__is_deleted=False,
            )
            .exclude(status=TaskStatus.BACKLOG)
            .select_related("project", "sprint")
            .annotate(
                _in_active_sprint=Case(
                    When(sprint__state=SprintState.ACTIVE, then=Value(0)),
                    default=Value(1),
                    output_field=IntegerField(),
                ),
                _sort_date=Coalesce("planned_start", "early_start"),
            )
            .order_by("_in_active_sprint", "_sort_date", "priority_rank", "id")
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
            .select_related("project")
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

        active_sprints_payload = MeWorkActiveSprintSerializer(active_sprints_qs, many=True).data

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
        .select_related("task", "suggested_by")
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
    owned_items = RetroActionItem.objects.filter(
        promoted_task_id__isnull=False,
        is_deleted=False,
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


class ProjectVelocityView(APIView):
    """``GET /api/v1/projects/<pk>/velocity/`` — last 8 closed sprints + stats."""

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get(self, request: Request, pk: str) -> Response:
        from trueppm_api.apps.projects.services import velocity_summary

        project = get_object_or_404(Project, pk=pk, is_deleted=False)
        self.check_object_permissions(request, project)
        return Response(velocity_summary(project.pk), status=status.HTTP_200_OK)


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

    # Exempt from the generic Idempotency-Key path (ADR-0083): inbound sync is already
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
    permission_classes = [IsAuthenticated, IsTokenForProject]
    throttle_classes = [TaskSyncThrottle]

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


class ProjectApiTokenViewSet(IdempotencyMixin, viewsets.ModelViewSet[Any]):
    """``/api/v1/projects/{project_pk}/api-tokens/`` — token CRUD for Admin/PM.

    ``list`` / ``retrieve`` are open to any project member so the team can see
    what integrations exist (Morgan's VoC 🟡 — sprint sovereignty signal).
    ``create`` / ``destroy`` require Admin/PM (role ≥ 3).

    The raw token is returned only on ``create``, in a one-time response field
    ``token``.  Subsequent reads never expose it.
    """

    # Exempt from the generic Idempotency-Key path (ADR-0083): the create response
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
        return (
            ProjectApiToken.objects.filter(
                **{f"{self._scope_field}_id": self.kwargs[self._scope_kwarg]},
                is_deleted=False,
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
            token = ProjectApiToken.objects.create(
                **scope_kwargs,
                name=write_serializer.validated_data["name"],
                status_map=write_serializer.validated_data.get("status_map", {}),
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
                detail={"name": token.name},
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
SIGNED_URL_DEFAULT_TTL_SECONDS = 15 * 60  # constraint #6
SIGNED_URL_MAX_TTL_SECONDS = 60 * 60  # constraint #7 (OSS hard-cap)


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

    def get_queryset(self) -> QuerySet[TaskAttachment]:
        user = self.request.user
        if not user.is_authenticated:
            return TaskAttachment.objects.none()
        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        if not ProjectMembership.objects.filter(
            user=user, project_id=project_pk, is_deleted=False
        ).exists():
            return TaskAttachment.objects.none()
        return TaskAttachment.objects.filter(
            task__project_id=project_pk,
            task_id=task_pk,
            is_deleted=False,
        ).select_related("uploaded_by", "deleted_by")

    def get_permissions(self) -> list[BasePermission]:
        if self.action in ("create", "destroy"):
            return [IsAuthenticated(), IsProjectMemberWrite(), IsProjectNotArchived()]
        return [IsAuthenticated(), IsProjectMember(), IsProjectNotArchived()]

    def perform_create(self, serializer: BaseSerializer[TaskAttachment]) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        project_pk = self.kwargs["project_pk"]
        task_pk = self.kwargs["task_pk"]
        task = get_object_or_404(Task, pk=task_pk, project_id=project_pk, is_deleted=False)
        self.check_object_permissions(self.request, task)

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

    @action(detail=True, methods=["get"], url_path="signed-url")
    def signed_url(self, request: Request, project_pk: str, task_pk: str, pk: str) -> Response:
        """Issue a short-lived download URL for the attachment's underlying file.

        TTL defaults to 15 minutes; clamped to 60 minutes max in OSS. External-
        URL attachments reject this action (they're already a URL).
        """
        attachment = self.get_object()
        if attachment.external_url:
            raise serializers.ValidationError(
                {"detail": "This attachment is an external link; no signed URL is needed."},
                code="signed_url_external",
            )

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

        # Backend-agnostic URL: storage backend handles signing transparently
        # in production (S3/MinIO). For local/dev FileSystemStorage we return
        # the unsigned media URL — the cost of a perfect signed-URL emulation
        # for dev is more than the security benefit, and ops gate the real
        # storage backend in Helm.
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
        if not ProjectMembership.objects.filter(
            user=user, project_id=project_pk, is_deleted=False
        ).exists():
            return TaskComment.objects.none()
        return (
            TaskComment.objects.filter(
                task__project_id=project_pk,
                task_id=task_pk,
                is_deleted=False,
            )
            .select_related("author", "parent", "deleted_by")
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

        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id_str,
                "task_comment_created",
                {
                    "id": comment_id_str,
                    "task_id": task_id_str,
                    "parent_id": parent_id,
                },
            )
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

    @action(detail=True, methods=["post", "delete"], url_path="acknowledge")
    def acknowledge(self, request: Request, project_pk: str, task_pk: str, pk: str) -> Response:
        """Toggle the requesting user's acknowledgement on this comment.

        POST creates an ack (idempotent — second POST returns 200 with the existing row).
        DELETE removes the ack. NEVER triggers a notification (per ADR-0075 §A.3).
        """
        comment = self.get_object()
        user = request.user
        if not user.is_authenticated:
            return Response(status=status.HTTP_401_UNAUTHORIZED)
        if request.method == "POST":
            ack, _created = CommentAcknowledgement.objects.get_or_create(comment=comment, user=user)
            return Response(CommentAcknowledgementSerializer(ack).data, status=status.HTTP_200_OK)
        # DELETE
        deleted, _ = CommentAcknowledgement.objects.filter(comment=comment, user=user).delete()
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
    permission_classes: list[type[BasePermission]] = [IsAuthenticated, IsProjectMemberWrite]

    def get_queryset(self) -> QuerySet[CommentReaction]:
        user = self.request.user
        if not user.is_authenticated:
            return CommentReaction.objects.none()
        project_pk = self.kwargs["project_pk"]
        comment_pk = self.kwargs["comment_pk"]
        if not ProjectMembership.objects.filter(
            user=user, project_id=project_pk, is_deleted=False
        ).exists():
            return CommentReaction.objects.none()
        return CommentReaction.objects.filter(
            comment_id=comment_pk, comment__task__project_id=project_pk
        ).select_related("user")

    def perform_create(self, serializer: BaseSerializer[CommentReaction]) -> None:
        project_pk = self.kwargs["project_pk"]
        comment_pk = self.kwargs["comment_pk"]
        comment = get_object_or_404(
            TaskComment, pk=comment_pk, task__project_id=project_pk, is_deleted=False
        )
        self.check_object_permissions(self.request, comment)
        serializer.save(comment=comment, user=self.request.user)

    def perform_destroy(self, instance: CommentReaction) -> None:
        if instance.user_id != self.request.user.pk:
            raise serializers.ValidationError(
                {"detail": "You can only remove your own reactions."},
                code="reaction_delete_forbidden",
            )
        instance.delete()
