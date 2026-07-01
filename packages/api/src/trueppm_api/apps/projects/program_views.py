"""ViewSets for the Program entity (ADR-0070).

Programs are top-level (not project-scoped), so they live in their own viewset
rather than under the ProjectViewSet nesting. Membership is nested separately
in the access app, mirroring how :class:`ProjectMembershipViewSet` lives next
to :class:`ProjectViewSet`.

This module is intentionally thin — the heavy lifting (atomic creation, cascade
delete, role checks) is in :mod:`trueppm_api.apps.access.services` and
:mod:`trueppm_api.apps.access.permissions`.
"""

from __future__ import annotations

import datetime
import json
from typing import Any, cast

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q, QuerySet, Subquery
from django.http import HttpResponse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership
from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProgramOwner,
    IsProgramScheduler,
    McpReadableViewMixin,
)
from trueppm_api.apps.access.services import (
    create_program,
    delete_program_cascade,
    transfer_program_sponsorship,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.bulk_settings import (
    BulkFieldsRequestSerializer,
    ProgramBulkFieldsSerializer,
    ProjectBulkFieldsSerializer,
    apply_bulk_fields,
    build_bulk_response,
)
from trueppm_api.apps.projects.models import (
    Methodology,
    Program,
    Project,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.serializers import (
    ProgramRiskPolicySerializer,
    ProgramRollupConfigSerializer,
    ProgramSerializer,
    ProjectSerializer,
)
from trueppm_api.apps.workspace.permissions import IsWorkspaceAdmin

# Upper bound on sub-programs created by a single split call (#967). Generous
# enough for "one sub-program per project" on a large program, but caps the
# unbounded-empty-program creation vector.
_MAX_SPLITS = 50


class LoadSampleResponseSerializer(serializers.Serializer[Any]):
    """Response envelope for the load-sample action (#1054).

    ``landing_project_id`` is the project whose first open sprint was assigned to
    the caller — the board a contributor should land on so their assigned work is
    immediately visible; ``null`` when the sample has no open sprint (e.g. the
    waterfall-only sample), in which case the client falls back to the program
    overview. ``sample_key`` echoes the loaded sample so the client renders the
    matching "Start exploring" guidance without having to guess the default.
    """

    program = ProgramSerializer()
    landing_project_id = serializers.UUIDField(allow_null=True)
    sample_key = serializers.CharField()


class ProgramViewSet(McpReadableViewMixin, IdempotencyMixin, viewsets.ModelViewSet[Program]):
    """CRUD for programs.

    URL: ``/api/v1/programs/``

    Permission matrix (ADR-0070 §RBAC):
      list      — IsAuthenticated; queryset filtered to programs the caller is a member of
      retrieve  — IsProgramMember (Viewer+)
      create    — IsAuthenticated; caller auto-becomes OWNER via ``create_program``
      update    — IsProgramAdmin
      destroy   — IsProgramOwner; cascade-removes memberships in one transaction
    """

    serializer_class = ProgramSerializer

    def get_permissions(self) -> list[BasePermission]:
        # ADR-0186 §E: append the read-only MCP token guards around the
        # action-specific RBAC list so a mcp:read token is confined to safe
        # methods on every action (no write-branch leak); human auth passes both.
        return [*self._rbac_permissions(), *self.mcp_token_guards()]

    def _rbac_permissions(self) -> list[BasePermission]:
        if self.action in ("update", "partial_update"):
            return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
        if self.action == "bulk_fields":
            # Workspace → programs matrix (ADR-0161): org-level workspace-admin authority.
            # Program has no workspace FK — the workspace is the singleton — so this is the
            # org-wide admin gate, not a per-program one.
            return [IsAuthenticated(), IsWorkspaceAdmin()]
        if self.action == "bulk_project_fields":
            # Program → projects matrix (ADR-0161): program-admin authority over the
            # program's own projects. The program PK in the URL is the IDOR boundary;
            # closed programs are not bulk-editable.
            return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
        if self.action in (
            "destroy",
            "close",
            "reopen",
            "transfer_sponsorship",
            "split",
            "remove_sample",
        ):
            # Lifecycle actions bypass the IsProgramNotClosed gate via the
            # class's _CLOSE_BYPASS_ACTIONS set — otherwise an Owner could
            # never reopen or delete a closed program.
            return [IsAuthenticated(), IsProgramOwner(), IsProgramNotClosed()]
        if self.action in ("rollup_config", "risk_policy"):
            # Method-level split: GET is read-open to any program member
            # (closed programs remain readable for audit/forensics); PATCH
            # requires admin and is blocked on closed programs. DRF evaluates
            # permissions before dispatch, so the discriminator is the HTTP
            # method on the request.
            if self.request.method == "PATCH":
                return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
            return [IsAuthenticated(), IsProgramMember()]
        if self.action in ("rollup", "export", "schedule"):
            # Computed overview rollup / JSON export / merged program schedule —
            # read-only. Open to any program member, including on closed programs
            # (overview, data portability, and the cross-project schedule stay
            # available for forensics/archival). Per-project task redaction inside
            # the schedule payload (ADR-0120 D5) is enforced in the action body,
            # not here — a program member who cannot read a member project still
            # reaches the endpoint but sees only that project's ExternalTaskCards.
            return [IsAuthenticated(), IsProgramMember()]
        if self.action == "resource_contention":
            # Resource allocation/contention data is Scheduler+ even on read
            # (web-rule 94, matching the per-project resource-allocation gate);
            # a Viewer or Member must not see who is staffed where.
            return [IsAuthenticated(), IsProgramScheduler()]
        if self.action in ("retrieve", "projects", "integrations_summary", "task_search"):
            # ``task_search`` backs the cross-project dependency picker (ADR-0120
            # D5): a create-assist read, gated exactly like ``projects`` — any
            # program member. ``IsProgramNotClosed`` is a no-op for the GET (it
            # only blocks writes) but is kept for parity with this read group; a
            # closed program is still browsable. The real authorization is the
            # per-project readability narrowing inside the action body (only
            # projects the caller can read are searched), which enforces the D5
            # "creator needs read access to both tasks" rule — the edge itself is
            # created later via the per-project ``/dependencies/`` POST, not here.
            return [IsAuthenticated(), IsProgramMember(), IsProgramNotClosed()]
        return [IsAuthenticated()]

    def get_queryset(self) -> QuerySet[Program]:
        """Programs visible to the current user (those they have membership on).

        Annotates ``_my_role`` (caller's role on each program), ``project_count``,
        and ``member_count`` so the serializer can render the role chip and
        counts without N+1 queries.
        """
        user = self.request.user
        if not (user and user.is_authenticated):
            return Program.objects.none()

        my_role_sq = ProgramMembership.objects.filter(
            program=OuterRef("pk"),
            user=user,
            is_deleted=False,
        ).values("role")[:1]

        qs = (
            Program.objects.filter(
                is_deleted=False,
                memberships__user=user,
                memberships__is_deleted=False,
            )
            # select_related on ``lead`` so ProgramSerializer.lead_detail does not
            # incur one extra User query per program on list responses (#523).
            .select_related("lead")
            .annotate(
                _my_role=Subquery(my_role_sq),
                project_count=Count(
                    "projects",
                    distinct=True,
                    filter=Q(projects__is_deleted=False),
                ),
                member_count=Count(
                    "memberships",
                    distinct=True,
                    filter=Q(memberships__is_deleted=False),
                ),
                _is_sample=Exists(
                    Project.objects.filter(program=OuterRef("pk"), is_sample=True, is_deleted=False)
                ),
            )
            .order_by("name")
        )
        return qs

    # -----------------------------------------------------------------------
    # CRUD
    # -----------------------------------------------------------------------

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        write = ProgramSerializer(data=request.data)
        write.is_valid(raise_exception=True)

        # Service-layer call wraps the Program + OWNER membership in a single
        # transaction — see ADR-0070 §Durable Execution.
        program = create_program(
            name=write.validated_data["name"],
            description=write.validated_data.get("description", ""),
            methodology=write.validated_data.get("methodology", Methodology.HYBRID),
            created_by=request.user,
        )

        # Re-fetch through the get_queryset so the response includes my_role
        # and the count annotations.
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Import a JSON seed bundle as a new program",
        responses={201: ProgramSerializer},
    )
    @action(detail=False, methods=["post"], url_path="import")
    def import_seed(self, request: Request) -> Response:
        """Import a JSON seed document, creating (or replacing) a program.

        Accepts either a ``file`` multipart upload or a raw JSON body. The caller
        becomes the program OWNER (same authorization as ``create`` — any
        authenticated user may create a program). ``create_users`` is forced off:
        importing a seed on a live instance must never mint arbitrary logins.
        """
        from django.conf import settings

        from trueppm_api.apps.projects.seed import SeedValidationError
        from trueppm_api.apps.projects.seed import import_seed as run_import

        upload = request.FILES.get("file")
        if upload is not None:
            # Bound the in-memory parse: an authenticated user must not be able
            # to exhaust memory with a giant upload (mirrors the MSP importer).
            max_bytes = settings.SEED_MAX_UPLOAD_MB * 1024 * 1024
            if upload.size is not None and upload.size > max_bytes:
                return Response(
                    {"detail": f"Seed file too large. Maximum: {settings.SEED_MAX_UPLOAD_MB} MB."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                payload = json.loads(upload.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return Response(
                    {"detail": "Uploaded file is not valid JSON."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            payload = request.data

        try:
            program = run_import(payload, owner=request.user, create_users=False)
        except SeedValidationError as exc:
            # Standardized on the `detail` envelope (#1325). For the line-level
            # import report `detail` is the *list* of validation messages (the FE
            # renders them as discrete items); the single-message errors above use
            # a plain string. seedImportErrors() normalizes both to a string list.
            return Response({"detail": exc.errors}, status=status.HTTP_400_BAD_REQUEST)

        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Export the program as a downloadable JSON seed file",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.BINARY,
                description="Canonical JSON seed document as a file attachment.",
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="export")
    def export(self, request: Request, pk: str | None = None) -> HttpResponse:
        """Export this program as a downloadable canonical JSON seed file (#616)."""
        from trueppm_api.apps.projects.seed.exporter import dump_seed, export_program

        program = self.get_object()
        body = dump_seed(export_program(program))
        filename = f"{program.code or program.pk}.json"
        response = HttpResponse(body, content_type="application/json")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response

    @extend_schema(
        summary="Within-program resource contention (cross-project allocation)",
        parameters=[
            OpenApiParameter(
                name="start",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window start (ISO 8601 `YYYY-MM-DD`). Defaults to the earliest "
                    "`early_start` across all member projects."
                ),
            ),
            OpenApiParameter(
                name="end",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window end (ISO 8601 `YYYY-MM-DD`). Defaults to the latest "
                    "`early_finish` across all member projects."
                ),
            ),
            OpenApiParameter(
                name="resource",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                many=True,
                description="Repeatable. Filter to specific resource IDs.",
            ),
            OpenApiParameter(
                name="status",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                many=True,
                description="Repeatable. Filter tasks by status value.",
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "{program_id, window_start, window_end, resources}. Each resource is "
                    "{id, name, email, max_units, tasks[]} and each task span is "
                    "{assignment_id, id, name, project_id, project_name, early_start, "
                    "early_finish, units, status} — aggregated across every member project "
                    "of the program and tagged with its source project, so a caller can "
                    "surface people over-allocated across sibling projects in overlapping "
                    "windows. Overallocation detection stays client-side per ADR-0031."
                ),
            ),
            400: OpenApiResponse(
                description="Malformed `start`/`end` date, or `start` is after `end`."
            ),
            409: OpenApiResponse(description="No member project has a computed schedule yet."),
        },
    )
    @action(detail=True, methods=["get"], url_path="resource-contention")
    def resource_contention(self, request: Request, pk: str | None = None) -> Response:
        """Cross-project resource allocation for the within-program contention view (#1149).

        The program-scoped counterpart to ``ProjectViewSet.resource_allocation`` (#85):
        returns each resource with their task spans across **every member project of this
        program**, each span tagged with its source project, so the client can show who is
        over-allocated across sibling projects in overlapping windows (the contention the
        GA-launch sample program deliberately creates).

        This is OSS, within-program **visibility** only — it surfaces contention data but
        does not level resources or cross a program boundary. Cross-program leveling and the
        portfolio heat map remain Enterprise. Overallocation detection is intentionally
        client-side (ADR-0031): the caller receives the merged spans and sums daily units
        against each resource's ``max_units``.

        Query parameters mirror the per-project endpoint:
          start    (YYYY-MM-DD, optional) — window start; defaults to the earliest
                   early_start across all member projects. Returns 409 if no member
                   project has CPM dates yet.
          end      (YYYY-MM-DD, optional) — window end; defaults to the latest early_finish.
          resource (UUID, optional, repeatable) — filter to specific resource IDs.
          status   (string, optional, repeatable) — filter tasks by status value.
        """
        from trueppm_api.apps.resources.models import TaskResource

        program = self.get_object()

        # Member projects (non-deleted) — the contention scope. With no live
        # projects (or none scheduled) and no explicit window, the window cannot
        # be resolved and the endpoint returns 409 like the per-project one.
        member_project_ids = list(
            program.projects.filter(is_deleted=False).values_list("id", flat=True)
        )

        def _parse_date(s: str, param: str) -> datetime.date:
            try:
                return datetime.date.fromisoformat(s)
            except ValueError:
                raise ValueError(f"'{param}' must be a valid ISO 8601 date (YYYY-MM-DD).") from None

        # --- Resolve window bounds across all member projects ---
        start_str = request.query_params.get("start")
        end_str = request.query_params.get("end")

        base_tasks = Task.objects.filter(project_id__in=member_project_ids, is_deleted=False)

        try:
            if start_str:
                window_start: datetime.date = _parse_date(start_str, "start")
            else:
                first = (
                    base_tasks.filter(early_start__isnull=False)
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
                    base_tasks.filter(early_finish__isnull=False)
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

        # --- Single query: all assignments across member projects in the window ---
        # Tasks with null CPM dates are retained (unscheduled); the client renders
        # them outside the contention math, mirroring the per-project endpoint.
        qs = (
            TaskResource.objects.filter(
                task__project_id__in=member_project_ids,
                task__is_deleted=False,
            )
            .select_related("resource", "task", "task__project")
            .order_by("resource__name", "task__project__name", "task__early_start")
        )

        if resource_ids:
            qs = qs.filter(resource__id__in=resource_ids)

        if status_filters:
            qs = qs.filter(task__status__in=status_filters)

        qs = qs.exclude(
            task__early_finish__isnull=False,
            task__early_start__isnull=False,
            task__early_finish__lt=window_start,
        ).exclude(
            task__early_finish__isnull=False,
            task__early_start__isnull=False,
            task__early_start__gt=window_end,
        )

        # --- Build response grouped by resource, each span tagged with its project ---
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
                    "project_id": str(task.project_id),
                    "project_name": task.project.name,
                    "early_start": task.early_start.isoformat() if task.early_start else None,
                    "early_finish": task.early_finish.isoformat() if task.early_finish else None,
                    "units": str(assignment.units),
                    "status": task.status,
                }
            )

        return Response(
            {
                "program_id": str(program.id),
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "resources": list(resources_map.values()),
            }
        )

    @extend_schema(
        summary="List bundled demo samples available to the loader",
        responses={
            200: OpenApiResponse(
                description=(
                    "Array of available samples, each with `key`, `title`, and `description`."
                )
            )
        },
    )
    @action(detail=False, methods=["get"], url_path="samples")
    def samples(self, request: Request) -> Response:
        """List the bundled samples available to the demo loader (#375)."""
        from trueppm_api.apps.projects.seed.samples import SAMPLES

        return Response(
            [
                {"key": s.key, "title": s.title, "description": s.description}
                for s in SAMPLES.values()
            ]
        )

    @extend_schema(
        summary="Load a bundled sample program",
        responses={201: LoadSampleResponseSerializer},
    )
    @action(detail=False, methods=["post"], url_path="load-sample")
    def load_sample(self, request: Request) -> Response:
        """Load a bundled sample program — the "Load demo data" action (#375, #1054).

        Body: ``{"sample": "<key>"}`` (optional; defaults to the launch demo).
        The caller becomes OWNER (same authorization as ``create``). Demo
        persona accounts are created so the boards render fully.

        The caller is then assigned the first open sprint's tasks (#1054) so a
        contributor who loads the demo from My Work sees their own work right
        away. The response is a ``{program, landing_project_id, sample_key}``
        envelope: ``landing_project_id`` is the board to land that contributor on
        (``null`` when the sample has no open sprint), and ``sample_key`` lets the
        client render the matching post-load "Start exploring" guidance.
        """
        from trueppm_api.apps.projects.seed.samples import (
            DEFAULT_SAMPLE,
            UnknownSampleError,
            load_sample,
            prepare_sample_for_user,
        )

        key = request.data.get("sample", DEFAULT_SAMPLE)
        try:
            program = load_sample(key, owner=request.user, create_users=True)
        except UnknownSampleError as exc:
            # Standardized on the `detail` envelope (#1325).
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        landing_project = prepare_sample_for_user(program, request.user)

        fresh = self.get_queryset().get(pk=program.pk)
        return Response(
            {
                "program": ProgramSerializer(fresh).data,
                "landing_project_id": (
                    str(landing_project.id) if landing_project is not None else None
                ),
                "sample_key": key,
            },
            status=status.HTTP_201_CREATED,
        )

    @extend_schema(
        summary="Tear down a sample program",
        responses={204: OpenApiResponse(description="Sample program purged; empty body.")},
    )
    @action(detail=True, methods=["post"], url_path="remove-sample")
    def remove_sample(self, request: Request, pk: str | None = None) -> Response:
        """Tear down a sample program — the "Remove sample data" action (#375).

        Owner-only. Refuses to delete a program that is not sample data, so the
        teardown can never remove real work. Hard-deletes the *entire* program
        subtree (all projects, not only is_sample ones — a sample program holds
        only sample projects). Unlike ``destroy`` this is a hard delete, not a
        soft delete: sample data is disposable, so it is purged outright. Offline
        sync clients reconcile via the ``program_deleted`` broadcast rather than a
        tombstone — acceptable because demo data is never offline-authored.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        program = self.get_object()
        is_sample = Project.objects.filter(
            program=program, is_sample=True, is_deleted=False
        ).exists()
        if not is_sample:
            return Response(
                {"detail": "This program is not sample data."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        program_id = str(program.pk)
        with transaction.atomic():
            # Lock the program row so a concurrent member-add / project-assign
            # can't resurrect a PROTECTed reference mid-teardown.
            Program.objects.select_for_update().filter(pk=program.pk).first()
            project_ids = list(Project.objects.filter(program=program).values_list("pk", flat=True))
            ProjectMembership.objects.filter(project_id__in=project_ids).delete()
            Project.objects.filter(pk__in=project_ids).delete()
            ProgramMembership.objects.filter(program=program).delete()
            Program.objects.filter(pk=program.pk).delete()
        transaction.on_commit(
            lambda: broadcast_board_event(program_id, "program_deleted", {"id": program_id})
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = self.get_object()
        program_id = str(instance.pk)
        delete_program_cascade(instance.pk)
        # delete_program_cascade detaches projects (program=NULL) — emit a single
        # program-level event rather than fanning out per-project; clients
        # already invalidate project queries on program_deleted.
        transaction.on_commit(
            lambda: broadcast_board_event(program_id, "program_deleted", {"id": program_id})
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    # -----------------------------------------------------------------------
    # Lifecycle actions (#530)
    # -----------------------------------------------------------------------

    @extend_schema(
        summary="Close the program",
        responses={200: ProgramSerializer},
    )
    @action(detail=True, methods=["post"], url_path="close")
    def close(self, request: Request, pk: str | None = None) -> Response:
        """Mark the program as closed (read-only shell). Owner only (#530).

        Closing a program freezes the program-level surfaces (members, settings,
        ceremonies). Child projects are NOT cascaded — they retain their own
        lifecycle, matching the UI dialog's "projects remain active" warning.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        program = self.get_object()
        if not program.is_closed:
            program.is_closed = True
            program.closed_at = timezone.now()
            program.closed_by = request.user  # type: ignore[assignment]
            program.save(update_fields=["is_closed", "closed_at", "closed_by"])
            program_id = str(program.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(program_id, "program_closed", {"id": program_id})
            )
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Reopen a closed program",
        responses={200: ProgramSerializer},
    )
    @action(detail=True, methods=["post"], url_path="reopen")
    def reopen(self, request: Request, pk: str | None = None) -> Response:
        """Reopen a closed program. Owner only (#530)."""
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        program = self.get_object()
        if program.is_closed:
            program.is_closed = False
            program.closed_at = None
            program.closed_by = None
            program.save(update_fields=["is_closed", "closed_at", "closed_by"])
            program_id = str(program.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(program_id, "program_reopened", {"id": program_id})
            )
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Transfer program sponsorship to another member",
        responses={200: ProgramSerializer},
    )
    @action(detail=True, methods=["post"], url_path="transfer-sponsorship")
    def transfer_sponsorship(self, request: Request, pk: str | None = None) -> Response:
        """Transfer program sponsorship to another existing member (#530).

        Body: ``{"new_owner_user_id": "<uuid>", "new_lead_user_id": "<uuid>?"}``.
        The new sponsor must already hold a ``ProgramMembership`` at any role —
        invite first if not. The current OWNER is atomically demoted to ADMIN.
        Optionally rotates ``program.lead`` so the program header chip moves
        with the role.
        """
        from django.contrib.auth import get_user_model

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        program = self.get_object()
        new_owner_id = request.data.get("new_owner_user_id")
        new_lead_id = request.data.get("new_lead_user_id")

        if not new_owner_id:
            return Response(
                {"detail": "new_owner_user_id is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        User = get_user_model()
        try:
            new_owner = User.objects.get(pk=new_owner_id)
        except (User.DoesNotExist, DjangoValidationError, ValueError):
            return Response(
                {"detail": "User not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        new_lead = None
        if new_lead_id:
            try:
                new_lead = User.objects.get(pk=new_lead_id)
            except (User.DoesNotExist, DjangoValidationError, ValueError):
                return Response(
                    {"detail": "Lead user not found."},
                    status=status.HTTP_404_NOT_FOUND,
                )

        try:
            transfer_program_sponsorship(
                program=program,
                new_owner=new_owner,
                actor=request.user,
                new_lead=new_lead,
            )
        except DjangoValidationError as exc:
            return Response(
                {"detail": exc.messages[0] if exc.messages else str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        program_id = str(program.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                program_id,
                "program_sponsorship_transferred",
                {"id": program_id, "new_owner_id": str(new_owner.pk)},
            )
        )
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Split a program into sub-programs",
        responses={
            200: OpenApiResponse(
                description=(
                    "The closed parent program plus the created sub-programs: "
                    "`{program, sub_programs}`."
                )
            ),
            400: OpenApiResponse(
                description="Invalid payload, or a project does not belong to this program."
            ),
        },
    )
    @action(detail=True, methods=["post"], url_path="split")
    def split(self, request: Request, pk: str | None = None) -> Response:
        """Split a program into sub-programs and close the original (ADR-0156, #967).

        Each entry in ``splits`` becomes a new program owned by the caller
        (methodology copied from the parent, inheritable settings left to inherit
        the workspace defaults); the entry's projects are moved under it. Only the
        ``Project.program`` FK moves, so tasks, dependencies, baselines, and history
        are preserved. The original program is closed afterwards and keeps any
        projects that were not redistributed. The whole operation is atomic.

        Owner only (``IsProgramOwner``); a closed program cannot be split
        (``IsProgramNotClosed``), which also makes a retried request safe — once
        the parent is closed a replay is rejected before it can double-split.

        Body: ``{"splits": [{"name": str, "project_ids": [uuid]}, ...]}``
        """
        from trueppm_api.apps.access.services import split_program
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Owner-only object check (also confirms the program exists).
        program = self.get_object()

        splits = request.data.get("splits")
        if not isinstance(splits, list) or not splits:
            return Response(
                {"detail": "splits must be a non-empty array."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Bound the number of sub-programs created in one call — even an Owner
        # shouldn't be able to spawn unbounded empty programs in a single request.
        if len(splits) > _MAX_SPLITS:
            return Response(
                {"detail": f"A program can be split into at most {_MAX_SPLITS} sub-programs."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        for split in splits:
            if not isinstance(split, dict):
                return Response(
                    {"detail": "Each split entry must be an object."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if not split.get("name") or not isinstance(split.get("project_ids"), list):
                return Response(
                    {"detail": "Each split must include 'name' and 'project_ids' array."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            sub_programs = split_program(program=program, splits=splits, actor=request.user)
        except DjangoValidationError as exc:
            return Response(
                {"detail": exc.messages[0] if exc.messages else str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        program_id = str(program.pk)
        sub_ids = [str(sub.pk) for sub in sub_programs]
        transaction.on_commit(
            lambda: broadcast_board_event(
                program_id,
                "program_split",
                {"id": program_id, "sub_program_ids": sub_ids},
            )
        )

        fresh = self.get_queryset().get(pk=program.pk)
        return Response(
            {
                "program": ProgramSerializer(fresh).data,
                "sub_programs": ProgramSerializer(sub_programs, many=True).data,
            },
            status=status.HTTP_200_OK,
        )

    # -----------------------------------------------------------------------
    # Custom actions
    # -----------------------------------------------------------------------

    @extend_schema(
        summary="List projects in this program",
        responses={200: ProjectSerializer(many=True)},
    )
    @action(detail=True, methods=["get"], url_path="projects")
    def projects(self, request: Request, pk: str | None = None) -> Response:
        """List projects in this program.

        URL: ``GET /api/v1/programs/{pk}/projects/``

        Permission: IsProgramMember (any program role can see the project list,
        but the project itself only opens if the user also has project membership
        — that gate is enforced by the project's own viewset on click-through).
        """
        program = self.get_object()
        # Per-project overdue / at-risk counts (#560), so the Projects tab reads
        # like a morning standup. Both are conditional COUNTs over the project's
        # own tasks in the SAME query (no N+1) — distinct=True guards against the
        # row-fanout that two filtered aggregates over one reverse relation would
        # otherwise produce. "Incomplete" excludes COMPLETE and soft-deleted rows;
        # "overdue" = past the CPM early_finish; "at-risk" reuses the canonical
        # ≤5-working-days-of-float rule (cf. ProjectViewSet.status_summary).
        today = timezone.localdate()
        incomplete = ~Q(tasks__status=TaskStatus.COMPLETE) & Q(tasks__is_deleted=False)
        qs = (
            Project.objects.filter(program=program, is_deleted=False)
            .select_related("calendar")
            .annotate(
                overdue_count=Count(
                    "tasks",
                    filter=incomplete & Q(tasks__early_finish__lt=today),
                    distinct=True,
                ),
                at_risk_count=Count(
                    "tasks",
                    filter=incomplete
                    & Q(tasks__total_float__isnull=False)
                    & Q(tasks__total_float__lte=5),
                    distinct=True,
                ),
            )
            .order_by("start_date", "name")
        )
        return Response(ProjectSerializer(qs, many=True).data)

    @extend_schema(
        summary="Get the program-scoped integrations summary",
        responses={
            200: OpenApiResponse(
                description=(
                    "Summary object with `webhooks` and `api_tokens` sections "
                    "scoped to the program."
                )
            ),
            503: OpenApiResponse(
                description="A subservice failed; body names the `failed` section."
            ),
        },
    )
    @action(detail=True, methods=["get"], url_path="integrations-summary")
    def integrations_summary(self, request: Request, pk: str | None = None) -> Response:
        """Program-scoped integrations summary (ADR-0076).

        URL: ``GET /api/v1/programs/{pk}/integrations-summary/``

        Returns the program's outbound webhooks and inbound API tokens that
        are scoped to the program itself — does NOT bubble up resources from
        child projects (those have their own per-project summaries).

        Same shape and per-section 503 fallback semantics as the project
        endpoint so the frontend can re-use the hook contract.
        """
        import logging

        from django.db.models import Q
        from rest_framework import status as drf_status

        from trueppm_api.apps.projects.views import (
            _summarize_api_tokens,
            _summarize_webhooks,
        )

        logger = logging.getLogger(__name__)

        program = self.get_object()
        sections: dict[str, Any] = {}

        try:
            sections["webhooks"] = _summarize_webhooks(Q(program_id=program.id))
        except Exception:
            logger.exception("program integrations-summary webhooks subservice failed")
            return Response(
                {"failed": "webhooks"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            sections["api_tokens"] = _summarize_api_tokens(Q(program_id=program.id))
        except Exception:
            logger.exception("program integrations-summary api_tokens subservice failed")
            return Response(
                {"failed": "api_tokens"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(sections, status=drf_status.HTTP_200_OK)

    @extend_schema(
        summary="Read or update the program rollup KPIs config",
        responses={200: ProgramRollupConfigSerializer},
    )
    @action(detail=True, methods=["get", "patch"], url_path="rollup-config")
    def rollup_config(self, request: Request, pk: str | None = None) -> Response:
        """Read or update the program rollup KPIs config (ADR-0169, #527).

        URL: ``GET|PATCH /api/v1/programs/{pk}/rollup-config/``

        Permission split is method-level (see ``get_permissions``): any
        member can read, only admins can write. Audit is automatic via the
        ``HistoricalRecords()`` already on Program — every successful PATCH
        creates a ``HistoricalProgram`` row with the field diff.
        """
        program = self.get_object()
        if request.method == "GET":
            return Response(ProgramRollupConfigSerializer(program).data)

        serializer = ProgramRollupConfigSerializer(program, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        # Re-serialize from the fresh instance so the response carries any
        # field-level normalization (de-duped KPI list) applied by the
        # serializer's validators.
        return Response(ProgramRollupConfigSerializer(program).data)

    @extend_schema(
        summary="Compute the program KPI rollup across its projects",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Program rollup computed on read (ADR-0088): aggregation_policy, "
                    "policy_available (whether that policy could be honored), project_count "
                    "(contributing projects), program_health (the program health dot), and "
                    "kpis — a per-KPI map where an available KPI is "
                    "{available: true, value, unit?} and a deferred KPI is "
                    "{available: false, reason}."
                ),
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="rollup")
    def rollup(self, request: Request, pk: str | None = None) -> Response:
        """Computed rollup of the enabled KPIs across the program's projects.

        URL: ``GET /api/v1/programs/{pk}/rollup/``

        Consumes the #527 config (``rollup_enabled_kpis`` +
        ``rollup_aggregation_policy``) and returns the rolled-up values per
        ADR-0088 — the program health dot, the active policy (and whether it
        could be honored), the contributing project count, and a per-KPI map
        where deferred KPIs carry ``{"available": False, "reason": ...}``.

        Read-only and computed on demand (no persisted rollup row), so it always
        reflects the projects' current state. Permission: any program member.
        """
        from trueppm_api.apps.projects.program_rollup import compute_program_rollup

        program = self.get_object()
        return Response(compute_program_rollup(program))

    @extend_schema(
        summary="Compute the program-true cross-project schedule",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Merged program schedule computed on read: project lanes, "
                    "tasks (full for projects the caller can read, redacted "
                    "ExternalTaskCard shape otherwise), leaf-level links flagged "
                    "cross-project, and the program-true critical path."
                ),
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="schedule")
    def schedule(self, request: Request, pk: str | None = None) -> Response:
        """Merged, program-true critical path across the program's projects.

        URL: ``GET /api/v1/programs/{pk}/schedule/``

        Loads every member project's tasks and every accepted cross-project edge
        into one engine graph and runs the deterministic CPM once (ADR-0120 D3
        read side; render-don't-derive per ADR-0115) — the source the #1118
        program schedule view consumes. Computed on demand; nothing is persisted,
        so it always reflects current project state.

        Permission: any program member (closed programs stay readable for
        forensics). Tasks in member projects the requester cannot read are
        redacted to the ADR-0120 D5 ExternalTaskCard shape — never their
        description, assignee, status, or points, only title and program-true
        CPM dates. ``can_access_project`` is the per-project membership predicate;
        injecting it keeps the schedule service request-agnostic.
        """
        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.projects.program_schedule import compute_program_schedule

        program = self.get_object()
        return Response(
            compute_program_schedule(
                program,
                can_access_project=lambda project_id: (
                    _membership_role(request, project_id) is not None
                ),
            )
        )

    @extend_schema(
        summary="Search tasks across a program's projects (cross-project dep picker)",
        parameters=[
            OpenApiParameter(
                "q",
                OpenApiTypes.STR,
                description="Case-insensitive substring matched against task name or notes.",
                required=True,
            ),
            OpenApiParameter(
                "exclude_project",
                OpenApiTypes.UUID,
                description=(
                    "Project to omit from results — the picker's own project, whose "
                    "tasks the client already has locally."
                ),
                required=False,
            ),
        ],
        responses={
            200: OpenApiResponse(
                description=(
                    "Slim rows `[{id, name, short_id, project_id, project_name}]` "
                    "for tasks in member projects the caller can read."
                )
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="task-search")
    def task_search(self, request: Request, pk: str | None = None) -> Response:
        """Search tasks across a program's projects, to pick a cross-project edge.

        URL: ``GET /api/v1/programs/{pk}/task-search/?q=<term>&exclude_project=<uuid>``

        Backs the ADR-0120 cross-project dependency picker: the schedule picker is
        single-project, so a user cannot today reach a sibling project's task to
        gate against it. This returns a slim, sensitive-field-free list scoped to
        the program's member projects **the caller can actively read** — the D5
        "creator needs read access to both tasks" creation rule. A member project
        the caller cannot read is simply not searched (its tasks are not offered),
        so no unauthorized task titles leak through the picker.

        Slim shape (``[{id, name, short_id, project_id, project_name}]``) carries no
        cost/budget/status/assignee fields, so role-based field visibility is moot —
        project readability is the only gate (same rationale as the per-project
        ``TaskViewSet.search`` action).
        """
        from django.db.models import Case, IntegerField, Value, When

        from trueppm_api.apps.access.models import ProjectMembership

        program = self.get_object()

        # IsAuthenticated already gates this action; the guard also narrows the
        # type for the membership lookup below.
        user = request.user
        if not (user and user.is_authenticated):
            return Response([], status=status.HTTP_200_OK)

        raw_q = (request.query_params.get("q") or "").strip()
        if not raw_q:
            return Response([], status=status.HTTP_200_OK)
        # DoS guard: a pathological term can't force an unbounded trigram scan.
        q = raw_q[:100]

        exclude_project = request.query_params.get("exclude_project")

        # Member projects the caller can read, minus the picker's own project.
        # Readability is the D5 "read access to both tasks" rule; a non-readable
        # member project is dropped entirely (rather than redacted, as ``schedule``
        # does) because an unpickable task should not appear at all. A single
        # membership query resolves the whole program's readable set — the same
        # ``ProjectMembership`` predicate ``_membership_role`` applies per row, but
        # here in one pass rather than N per-project lookups.
        readable_ids = set(
            ProjectMembership.objects.filter(
                project__program=program,
                project__is_deleted=False,
                user=user,
                is_deleted=False,
            ).values_list("project_id", flat=True)
        )
        readable: dict[str, str] = {}
        for row in Project.objects.filter(
            program=program, is_deleted=False, id__in=readable_ids
        ).values("id", "name"):
            pid = str(row["id"])
            if exclude_project is not None and pid == str(exclude_project):
                continue
            readable[pid] = row["name"]

        if not readable:
            return Response([], status=status.HTTP_200_OK)

        qs = (
            Task.objects.filter(project_id__in=list(readable.keys()), is_deleted=False)
            .filter(Q(name__icontains=q) | Q(notes__icontains=q))
            # Title matches rank above description-only matches; project then name
            # are the stable tiebreaks so grouped results stay deterministic.
            .annotate(
                _name_match=Case(
                    When(name__icontains=q, then=Value(0)),
                    default=Value(1),
                    output_field=IntegerField(),
                )
            )
            .order_by("_name_match", "project_id", "name")
        )
        # `.values()` after an `.annotate()` is typed by django-stubs as the
        # annotated Task row (carrying `_name_match`), not a plain dict, so the
        # index access below trips mypy. The projection genuinely yields dicts;
        # cast to reflect that.
        rows = cast(
            "list[dict[str, Any]]",
            list(qs.values("id", "name", "short_id", "project_id")[:200]),
        )
        results = [
            {
                "id": str(row["id"]),
                "name": row["name"],
                "short_id": row["short_id"],
                "project_id": str(row["project_id"]),
                "project_name": readable[str(row["project_id"])],
            }
            for row in rows
        ]
        return Response(results, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Read or update the program risk & dependencies policy",
        responses={200: ProgramRiskPolicySerializer},
    )
    @action(detail=True, methods=["get", "patch"], url_path="risk-policy")
    def risk_policy(self, request: Request, pk: str | None = None) -> Response:
        """Read or update the program risk & deps policy (#529).

        URL: ``GET|PATCH /api/v1/programs/{pk}/risk-policy/``

        Permission split mirrors ``rollup_config`` (see ``get_permissions``):
        any member can read, only admins can write. Audit is automatic via
        the ``HistoricalRecords()`` already on Program — every successful
        PATCH creates a ``HistoricalProgram`` row with the field diff.

        The 5×5 risk matrix surfaced on the same Settings page is
        intentionally out of scope here — those thresholds are workspace-
        wide and read-only at the program level.
        """
        program = self.get_object()
        if request.method == "GET":
            return Response(ProgramRiskPolicySerializer(program).data)

        serializer = ProgramRiskPolicySerializer(program, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(ProgramRiskPolicySerializer(program).data)

    @extend_schema(
        summary="Bulk-set inherited settings across multiple programs",
        request=BulkFieldsRequestSerializer,
        responses={
            200: OpenApiResponse(
                description="Per-program id + new server_version, and the fields applied."
            )
        },
    )
    @action(detail=False, methods=["post"], url_path="bulk-fields")
    def bulk_fields(self, request: Request) -> Response:
        """Set inherited settings on a selection of programs in one call (ADR-0161, #1233).

        URL: ``POST /api/v1/programs/bulk-fields/`` — the Workspace → Programs matrix scope.

        Body ``{"ids": [<program uuid>...], "fields": {"methodology": "AGILE", ...}}``:
        only the named fields on the named programs change; every other program and every
        other field keeps inheriting. Workspace-admin only — the matrix is a
        workspace-settings surface. Each row is written via ``save()`` so ``server_version``
        bumps for offline sync and ``HistoricalProgram`` audits the diff. All-or-nothing.
        """
        envelope = BulkFieldsRequestSerializer(data=request.data)
        envelope.is_valid(raise_exception=True)
        with transaction.atomic():
            rows = apply_bulk_fields(
                field_serializer_cls=ProgramBulkFieldsSerializer,
                queryset=Program.objects.filter(is_deleted=False, is_closed=False),
                ids=envelope.validated_data["ids"],
                fields=envelope.validated_data["fields"],
            )
        return Response(build_bulk_response(rows, envelope.validated_data["fields"]))

    @extend_schema(
        summary="Bulk-set inherited settings across this program's projects",
        request=BulkFieldsRequestSerializer,
        responses={
            200: OpenApiResponse(
                description="Per-project id + new server_version, and the fields applied."
            )
        },
    )
    @action(detail=True, methods=["post"], url_path="bulk-project-fields")
    def bulk_project_fields(self, request: Request, pk: str | None = None) -> Response:
        """Set inherited settings on a selection of this program's projects (ADR-0161, #1233).

        URL: ``POST /api/v1/programs/{pk}/bulk-project-fields/`` — the Program → Projects
        matrix scope.

        Program-admin only. Targets are constrained to this program's own non-archived
        projects, so the program PK in the URL is the IDOR boundary — a project id from
        another program is rejected as out-of-scope (400), never silently skipped. Only the
        two benign, non-schedule inherited fields (methodology, iteration_label) ship in
        this slice; ``calendar`` is deferred (schedule-affecting, no bulk recalc path yet).
        """
        program = self.get_object()
        envelope = BulkFieldsRequestSerializer(data=request.data)
        envelope.is_valid(raise_exception=True)
        with transaction.atomic():
            rows = apply_bulk_fields(
                field_serializer_cls=ProjectBulkFieldsSerializer,
                queryset=Project.objects.filter(
                    program_id=program.pk, is_deleted=False, is_archived=False
                ),
                ids=envelope.validated_data["ids"],
                fields=envelope.validated_data["fields"],
            )
        return Response(build_bulk_response(rows, envelope.validated_data["fields"]))
