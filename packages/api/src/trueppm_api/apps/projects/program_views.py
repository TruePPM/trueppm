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

import json
from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Count, OuterRef, Q, QuerySet, Subquery
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.access.models import ProgramMembership
from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProgramOwner,
)
from trueppm_api.apps.access.services import (
    create_program,
    delete_program_cascade,
    transfer_program_sponsorship,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Methodology, Program, Project
from trueppm_api.apps.projects.serializers import (
    ProgramRiskPolicySerializer,
    ProgramRollupConfigSerializer,
    ProgramSerializer,
    ProjectSerializer,
)


class ProgramViewSet(IdempotencyMixin, viewsets.ModelViewSet[Program]):
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
        if self.action in ("update", "partial_update"):
            return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
        if self.action in (
            "destroy",
            "close",
            "reopen",
            "transfer_sponsorship",
            "split",
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
        if self.action in ("rollup", "export"):
            # Computed overview rollup / JSON export — read-only. Open to any
            # member, including on closed programs (overview and data portability
            # stay available for forensics/archival).
            return [IsAuthenticated(), IsProgramMember()]
        if self.action in ("retrieve", "projects", "integrations_summary"):
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
                    {
                        "errors": [
                            f"Seed file too large. Maximum: {settings.SEED_MAX_UPLOAD_MB} MB."
                        ]
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                payload = json.loads(upload.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return Response(
                    {"errors": ["Uploaded file is not valid JSON."]},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            payload = request.data

        try:
            program = run_import(payload, owner=request.user, create_users=False)
        except SeedValidationError as exc:
            return Response({"errors": exc.errors}, status=status.HTTP_400_BAD_REQUEST)

        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_201_CREATED)

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

    @action(detail=True, methods=["post"], url_path="split")
    def split(self, request: Request, pk: str | None = None) -> Response:
        """Split a program into sub-programs — stub for 0.2 (#530).

        Validates payload shape and Owner role, then returns 501 so the UI
        can render the dialog and a coherent "coming soon" toast without a
        client-side feature flag. Real implementation is tracked in a
        follow-up issue; the contract here is the one the eventual handler
        will accept.

        Body: ``{"splits": [{"name": str, "project_ids": [uuid]}, ...]}``
        """
        # Run the Owner-only get_object check (also confirms the program exists).
        self.get_object()

        splits = request.data.get("splits")
        if not isinstance(splits, list) or not splits:
            return Response(
                {"detail": "splits must be a non-empty array."},
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

        return Response(
            {
                "detail": "Program split is not yet implemented.",
                "tracking_issue": 530,
            },
            status=status.HTTP_501_NOT_IMPLEMENTED,
        )

    # -----------------------------------------------------------------------
    # Custom actions
    # -----------------------------------------------------------------------

    @action(detail=True, methods=["get"], url_path="projects")
    def projects(self, request: Request, pk: str | None = None) -> Response:
        """List projects in this program.

        URL: ``GET /api/v1/programs/{pk}/projects/``

        Permission: IsProgramMember (any program role can see the project list,
        but the project itself only opens if the user also has project membership
        — that gate is enforced by the project's own viewset on click-through).
        """
        program = self.get_object()
        qs = (
            Project.objects.filter(program=program, is_deleted=False)
            .select_related("calendar")
            .order_by("start_date", "name")
        )
        return Response(ProjectSerializer(qs, many=True).data)

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

    @action(detail=True, methods=["get", "patch"], url_path="rollup-config")
    def rollup_config(self, request: Request, pk: str | None = None) -> Response:
        """Read or update the program rollup KPIs config (ADR-0079, #527).

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
