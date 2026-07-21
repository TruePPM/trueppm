"""Workspace settings API (#517 General, #518 Members/Invites, #519 Groups).

See ADR-0087. RBAC: any active member reads; ADMIN+ writes (``IsWorkspaceAdmin``).
The invite-accept endpoint is the one public surface (``AllowAny``) — it
authenticates with a one-time token, not a session.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Count, Q, QuerySet
from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.pagination import CursorPagination, PageNumberPagination
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.workspace import services
from trueppm_api.apps.workspace.models import (
    AuditEvent,
    AuditEventType,
    ExportJobStatus,
    Group,
    GroupMembership,
    GroupProject,
    InviteStatus,
    MemberStatus,
    Workspace,
    WorkspaceExportJob,
    WorkspaceInvite,
    WorkspaceMembership,
    WorkspaceRole,
)
from trueppm_api.apps.workspace.permissions import (
    IsWorkspaceAdmin,
    IsWorkspaceAdminStrict,
    IsWorkspaceAuditViewer,
    IsWorkspaceOwner,
    _workspace_membership_role,
    request_is_workspace_owner,
)
from trueppm_api.apps.workspace.serializers import (
    AuditEventSerializer,
    GroupMemberAddSerializer,
    GroupProjectWriteSerializer,
    GroupSerializer,
    GroupWriteSerializer,
    InviteAcceptSerializer,
    TransferOwnershipSerializer,
    WorkspaceExportJobSerializer,
    WorkspaceInviteCreateSerializer,
    WorkspaceInviteSerializer,
    WorkspaceMemberSerializer,
    WorkspaceMemberUpdateSerializer,
    WorkspaceSettingsSerializer,
    color_for,
    display_name_for,
    initials_for,
)

# Typed-confirmation header for the destructive workspace delete (ADR-0174). Its
# value must equal the workspace name exactly — the web danger page sends it.
CONFIRM_WORKSPACE_HEADER = "X-Confirm-Workspace"

User = get_user_model()


class InviteAcceptThrottle(AnonRateThrottle):
    """Defense-in-depth rate limit on the public invite-accept endpoint.

    The token is 256-bit and SHA-256-hashed at rest, so brute force is already
    infeasible; this caps it regardless and bounds account-provisioning abuse.
    """

    scope = "invite_accept"
    rate = "20/min"


# ---------------------------------------------------------------------------
# Row builders (shared by list + detail responses)
# ---------------------------------------------------------------------------


def _initials(user: Any) -> str:
    return initials_for(user.first_name, user.last_name, user.username)


def _build_member_rows(users: list[Any]) -> list[dict[str, Any]]:
    user_ids = [u.id for u in users]
    memberships = {
        m.user_id: m
        for m in WorkspaceMembership.objects.filter(user_id__in=user_ids, is_deleted=False)
    }
    group_map: dict[Any, list[str]] = defaultdict(list)
    for gm in GroupMembership.objects.filter(
        user_id__in=user_ids, is_deleted=False, group__is_deleted=False
    ).select_related("group"):
        group_map[gm.user_id].append(gm.group.name)

    rows: list[dict[str, Any]] = []
    for u in users:
        membership = memberships.get(u.id)
        if membership is not None:
            role_val = membership.role
            member_status = membership.status
            avail_percent = membership.availability_percent
            avail_from = membership.availability_effective_from
            avail_to = membership.availability_effective_to
            avail_notes = membership.availability_notes
        else:
            role_val = WorkspaceRole.OWNER if u.is_superuser else WorkspaceRole.MEMBER
            member_status = MemberStatus.ACTIVE
            # A user without a membership row is fully available by default —
            # mirrors the lazy-creation default the PATCH handler applies (#542).
            avail_percent = 100
            avail_from = None
            avail_to = None
            avail_notes = ""
        rows.append(
            {
                "id": str(u.id),
                "name": display_name_for(u.first_name, u.last_name, u.username),
                "initials": _initials(u),
                "color": color_for(u.id),
                "email": u.email,
                "role": WorkspaceRole(role_val).label,
                "role_value": role_val,
                "groups": sorted(group_map.get(u.id, [])),
                "project_count": getattr(u, "project_count", 0),
                "last_active": u.last_login.isoformat() if u.last_login else None,
                "status": member_status,
                "availability_percent": avail_percent,
                "availability_effective_from": avail_from.isoformat() if avail_from else None,
                "availability_effective_to": avail_to.isoformat() if avail_to else None,
                "availability_notes": avail_notes,
                "sso": False,
                "two_fa": False,
            }
        )
    return rows


def _group_dict(
    group: Group, members: list[Any], project_links: list[dict[str, Any]]
) -> dict[str, Any]:
    lead = group.lead
    return {
        "id": str(group.pk),
        "name": group.name,
        "description": group.description,
        "lead": _initials(lead) if lead is not None else None,
        "lead_user_id": str(lead.pk) if lead is not None else None,
        "member_count": len(members),
        "members": [
            {
                "id": str(gm.user_id),
                "name": display_name_for(gm.user.first_name, gm.user.last_name, gm.user.username),
                "initials": _initials(gm.user),
                "color": color_for(gm.user_id),
            }
            for gm in members
        ],
        # #2253: project links carry id + conferred role (not just the name) so the
        # management UI can render the granted role and revoke by project UUID.
        "projects": project_links,
    }


def _project_link(project_id: Any, name: str, role: int) -> dict[str, Any]:
    """One group→project access grant, with the conferred role and its label (#2253)."""
    return {"id": str(project_id), "name": name, "role": role, "role_label": Role(role).label}


def _build_group_dict(group: Group) -> dict[str, Any]:
    """Single-group dict (used for create/patch/detail responses — 2 queries)."""
    members = list(
        GroupMembership.objects.filter(group=group, is_deleted=False).select_related("user")
    )
    project_links = [
        _project_link(pid, name, role)
        for pid, name, role in GroupProject.objects.filter(
            group=group, project__is_deleted=False
        ).values_list("project_id", "project__name", "role")
    ]
    return _group_dict(group, members, project_links)


def _build_group_dicts(groups: list[Group]) -> list[dict[str, Any]]:
    """Bulk group dicts for the list endpoint — two queries total, no per-group N+1."""
    group_ids = [g.pk for g in groups]
    members_by_group: dict[Any, list[Any]] = defaultdict(list)
    for gm in GroupMembership.objects.filter(
        group_id__in=group_ids, is_deleted=False
    ).select_related("user"):
        members_by_group[gm.group_id].append(gm)
    projects_by_group: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for group_id, project_id, project_name, role in GroupProject.objects.filter(
        group_id__in=group_ids, project__is_deleted=False
    ).values_list("group_id", "project_id", "project__name", "role"):
        projects_by_group[group_id].append(_project_link(project_id, project_name, role))
    return [
        _group_dict(g, members_by_group.get(g.pk, []), projects_by_group.get(g.pk, []))
        for g in groups
    ]


def _invite_dict(invite: WorkspaceInvite) -> dict[str, Any]:
    inviter = invite.invited_by
    return {
        "id": str(invite.pk),
        "email": invite.email,
        "role": WorkspaceRole(invite.role).label,
        "role_value": invite.role,
        "status": invite.status,
        "invited_by": _initials(inviter) if inviter is not None else None,
        "created_at": invite.created_at,
        "expires_at": invite.expires_at,
    }


# ---------------------------------------------------------------------------
# #517 — General settings
# ---------------------------------------------------------------------------


class WorkspaceSettingsView(IdempotencyMixin, APIView):
    """GET/PATCH /api/v1/workspace/ — singleton workspace config (#517).

    Read for any active member; PATCH requires workspace ADMIN+.
    """

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

    @extend_schema(responses={200: WorkspaceSettingsSerializer})
    def get(self, request: Request) -> Response:
        workspace = Workspace.load()
        return Response(WorkspaceSettingsSerializer(workspace).data)

    @extend_schema(
        request=WorkspaceSettingsSerializer, responses={200: WorkspaceSettingsSerializer}
    )
    def patch(self, request: Request) -> Response:
        workspace = Workspace.load()
        # The workspace calendar (or its override policy) is the root of the calendar
        # inheritance chain (ADR-0441): changing either re-points every project that
        # inherits up to the workspace, so capture the before-values to fan out a CPM
        # recompute only when they actually change (a no-op PATCH must not recompute).
        old_calendar_id = workspace.calendar_id
        old_calendar_policy = workspace.calendar_override_policy
        serializer = WorkspaceSettingsSerializer(workspace, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        if (
            workspace.calendar_id != old_calendar_id
            or workspace.calendar_override_policy != old_calendar_policy
        ):
            from trueppm_api.apps.projects.views import _recalc_projects_for_workspace_calendar

            _recalc_projects_for_workspace_calendar()
        # Audit the change (ADR-0157). Record which settings keys were touched —
        # not their values, which may be large or sensitive (e.g. branding blobs).
        services.record_audit_event(
            event_type=AuditEventType.SETTINGS_CHANGED,
            actor=request.user,
            target_type="workspace",
            target_label="Workspace settings",
            metadata={"fields": sorted(serializer.validated_data.keys())},
        )
        return Response(serializer.data)

    @extend_schema(
        request=None,
        responses={204: OpenApiResponse(description="Workspace purged and reset.")},
        description=(
            "Permanently delete the workspace and all its data (factory reset). "
            f"Owner only. Requires the {CONFIRM_WORKSPACE_HEADER} header set to the "
            "exact workspace name."
        ),
    )
    def delete(self, request: Request) -> Response:
        """Hard-delete the workspace and all its data (ADR-0174, #641).

        Owner-only (PATCH is ADMIN+, so the owner gate is enforced here rather than
        via the class-level permission). A typed-confirmation header must match the
        workspace name exactly, mirroring the inline typed-confirmation on the web
        danger page. ``purge_workspace`` deletes every workspace-scoped row and the
        singleton; ``Workspace.load()`` recreates a fresh default on next access.
        """
        if not request_is_workspace_owner(request):
            raise PermissionDenied("Only the workspace Owner can delete the workspace.")

        workspace = Workspace.load()
        confirmation = request.headers.get(CONFIRM_WORKSPACE_HEADER, "")
        if confirmation != workspace.name:
            raise ValidationError(
                {
                    "detail": (
                        f"Confirmation failed — set the {CONFIRM_WORKSPACE_HEADER} header to the "
                        "exact workspace name to delete it."
                    )
                }
            )

        services.purge_workspace()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# #518 — Members
# ---------------------------------------------------------------------------


class WorkspaceMemberCursorPagination(CursorPagination):
    """Depth-independent pagination for the workspace member list (#1317).

    The roster grows with the org and was previously serialized in full —
    ``User.objects.all()`` with no bound — which risks OOM / slow responses on a
    large workspace. A username-keyed cursor is stable under concurrent member
    creation and avoids the COUNT + deep-OFFSET cost a page-number scheme would
    pay on an unbounded user table. Mirrors AuditEventCursorPagination.
    """

    ordering = "username"
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


class WorkspaceMemberListView(APIView):
    """GET /api/v1/workspace/members/ — list members (#518).

    Admins see every member; a non-admin member sees only their own row.
    Cursor-paginated (#1317): each page materializes at most ``page_size`` rows,
    so the member-row builder's batched queries stay bounded regardless of org
    size.
    """

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

    def _annotated_users(self, qs: QuerySet[Any]) -> QuerySet[Any]:
        annotated: QuerySet[Any] = qs.annotate(
            project_count=Count(
                "memberships",
                filter=Q(memberships__is_deleted=False, memberships__project__is_deleted=False),
                distinct=True,
            )
        )
        return annotated

    @extend_schema(
        # This view manually cursor-paginates (it is an APIView, so drf-spectacular
        # does not auto-wrap); declare the envelope explicitly so the schema matches
        # the ``{next, previous, results}`` body (#2127).
        responses={
            200: inline_serializer(
                name="PaginatedWorkspaceMemberList",
                fields={
                    "next": serializers.URLField(allow_null=True),
                    "previous": serializers.URLField(allow_null=True),
                    "results": WorkspaceMemberSerializer(many=True),
                },
            )
        }
    )
    def get(self, request: Request) -> Response:
        role = _workspace_membership_role(request)
        if role is not None and role >= WorkspaceRole.ADMIN:
            qs = self._annotated_users(User.objects.all())
        else:
            # Non-admin: only your own row.
            user_pk = request.user.pk
            assert user_pk is not None  # IsAuthenticated guarantees a real user
            qs = self._annotated_users(User.objects.filter(pk=user_pk))

        # Paginate the user queryset first, then build rows only for the page —
        # _build_member_rows fans out into membership/group lookups keyed on the
        # page's user ids, so bounding the page bounds those queries too.
        paginator = WorkspaceMemberCursorPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        rows = _build_member_rows(list(page) if page is not None else [])
        data = WorkspaceMemberSerializer(rows, many=True).data
        return paginator.get_paginated_response(data)


class WorkspaceMemberDetailView(IdempotencyMixin, APIView):
    """PATCH/DELETE /api/v1/workspace/members/{user_id}/ (#518). Admin only."""

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

    def _get_user_or_404(self, user_id: str) -> Any:
        return get_object_or_404(User, pk=user_id)

    @extend_schema(
        request=WorkspaceMemberUpdateSerializer, responses={200: WorkspaceMemberSerializer}
    )
    def patch(self, request: Request, user_id: str) -> Response:
        target = self._get_user_or_404(user_id)
        serializer = WorkspaceMemberUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        actor_role = _workspace_membership_role(request)
        new_role = data.get("role")
        new_status = data.get("status")

        with transaction.atomic():
            membership, _ = WorkspaceMembership.objects.select_for_update().get_or_create(
                workspace=Workspace.load(),
                user=target,
                defaults={
                    "role": WorkspaceRole.OWNER if target.is_superuser else WorkspaceRole.MEMBER,
                    "status": MemberStatus.ACTIVE,
                },
            )

            # Peer/higher-role guard: an actor may only change the role or change
            # the active status of a member whose CURRENT role is strictly below
            # their own (mirrors access.views.ProjectMembershipViewSet.destroy).
            # Without this an Admin could deactivate a peer Admin, or — with two
            # Owners — an Owner could be deactivated by an Admin. REACTIVATION
            # (status→ACTIVE) is gated too (#901): otherwise a lower-role Admin
            # could flip a deactivated Owner/peer-Admin back to ACTIVE, restoring
            # their login. Self-edits are exempt so an actor can still change their
            # own row (e.g. step down).
            mutating = new_role is not None or new_status in (
                MemberStatus.DEACTIVATED,
                MemberStatus.ACTIVE,
            )
            if (
                mutating
                and target.pk != request.user.pk
                and actor_role is not None
                and membership.role >= actor_role
            ):
                raise PermissionDenied(
                    "You can only modify members with a role lower than your own."
                )

            role_changed_from: int | None = None
            if new_role is not None:
                # An actor may only grant a role STRICTLY BELOW their own (#1728).
                # ``>`` let an Admin mint a peer Admin (equal role); combined with
                # the peer-guard above (an actor can't modify a member at or above
                # their own role) that peer was then unmanageable by either Admin.
                # ``>=`` matches the project analog
                # (access.views.ProjectMembershipViewSet.create).
                if actor_role is not None and new_role >= actor_role:
                    raise PermissionDenied(
                        "You cannot assign a role equal to or higher than your own."
                    )
                # Demoting an owner must not strand the workspace.
                if (
                    membership.role == WorkspaceRole.OWNER
                    and new_role < WorkspaceRole.OWNER
                    and services.would_strand_workspace(target.pk)
                ):
                    raise ValidationError(
                        {"detail": "Cannot demote the last Owner of the workspace."}
                    )
                if new_role != membership.role:
                    role_changed_from = membership.role
                    membership.role = new_role
                    membership.role_changed_at = timezone.now()

            if new_status is not None:
                if (
                    new_status == MemberStatus.DEACTIVATED
                    and membership.role == WorkspaceRole.OWNER
                    and services.would_strand_workspace(target.pk)
                ):
                    raise ValidationError(
                        {"detail": "Cannot deactivate the last Owner of the workspace."}
                    )
                membership.status = new_status
                # Sync the Django account active flag so a deactivated member
                # cannot authenticate, and reactivation restores login.
                target.is_active = new_status != MemberStatus.DEACTIVATED
                target.save(update_fields=["is_active"])

            # Resource-availability baseline (#542). Benign capacity metadata —
            # it neither escalates a role nor gates login — so it is deliberately
            # NOT subject to the peer/higher-role guard above: a resource manager
            # (Admin) declares availability for everyone, peers included. Presence
            # of the key (not its truthiness) drives the write so 0% and an
            # explicit-null date clear are honored, not skipped.
            if "availability_percent" in data:
                membership.availability_percent = data["availability_percent"]
            if "availability_effective_from" in data:
                membership.availability_effective_from = data["availability_effective_from"]
            if "availability_effective_to" in data:
                membership.availability_effective_to = data["availability_effective_to"]
            if "availability_notes" in data:
                membership.availability_notes = data["availability_notes"]
            # Authoritative from<=to guard after the partial merge: a PATCH that
            # sets only one bound must still be validated against the stored other.
            if (
                membership.availability_effective_from is not None
                and membership.availability_effective_to is not None
                and membership.availability_effective_from > membership.availability_effective_to
            ):
                raise ValidationError(
                    {
                        "availability_effective_to": (
                            "Must be on or after availability_effective_from."
                        )
                    }
                )

            membership.save()

            # Audit a real role change (ADR-0157) inside the same transaction so
            # it rolls back with a failed save. A status-only PATCH leaves
            # role_changed_from None and records nothing here.
            if role_changed_from is not None:
                services.record_audit_event(
                    event_type=AuditEventType.MEMBER_ROLE_CHANGED,
                    actor=request.user,
                    target_type="member",
                    target_label=services._actor_label(target),
                    metadata={
                        "old_role": WorkspaceRole(role_changed_from).label,
                        "new_role": WorkspaceRole(membership.role).label,
                    },
                )

        users = list(WorkspaceMemberListView()._annotated_users(User.objects.filter(pk=target.pk)))
        return Response(_build_member_rows(users)[0] if users else {})

    def delete(self, request: Request, user_id: str) -> Response:
        target = self._get_user_or_404(user_id)
        actor_role = _workspace_membership_role(request)
        with transaction.atomic():
            membership, _ = WorkspaceMembership.objects.select_for_update().get_or_create(
                workspace=Workspace.load(),
                user=target,
                defaults={
                    # Materialize the implicit role so a deactivated superuser's
                    # row reflects their true OWNER tier (consistent with PATCH).
                    "role": WorkspaceRole.OWNER if target.is_superuser else WorkspaceRole.MEMBER,
                    "status": MemberStatus.ACTIVE,
                },
            )
            # Peer/higher-role guard (mirrors PATCH and access.views): an actor may
            # only deactivate a member whose role is strictly below their own, so an
            # Admin cannot deactivate a peer Admin or an Owner. Self-removal is exempt.
            # This runs BEFORE the strand check so a forbidden peer/owner removal
            # returns 403, not a 400 about ownership.
            if (
                target.pk != request.user.pk
                and actor_role is not None
                and membership.role >= actor_role
            ):
                raise PermissionDenied(
                    "You can only remove members with a role lower than your own."
                )
            # Only an Owner removal can strand the workspace — gate the check on the
            # target's role (mirrors PATCH) so deactivating a Member/Admin in an
            # owner-less workspace is not spuriously blocked with a 400.
            if membership.role == WorkspaceRole.OWNER and services.would_strand_workspace(
                target.pk
            ):
                raise ValidationError({"detail": "Cannot remove the last Owner of the workspace."})
            membership.status = MemberStatus.DEACTIVATED
            membership.save()
            target.is_active = False
            target.save(update_fields=["is_active"])

            # Audit inside the same transaction so the row rolls back with a
            # failed deactivation (ADR-0157). "Removed" here is a deactivation —
            # the OSS workspace deactivates members rather than hard-deleting them.
            services.record_audit_event(
                event_type=AuditEventType.MEMBER_REMOVED,
                actor=request.user,
                target_type="member",
                target_label=services._actor_label(target),
                metadata={"role": WorkspaceRole(membership.role).label},
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceInviteListView(IdempotencyMixin, APIView):
    """GET/POST /api/v1/workspace/invites/ (#518). Admin only."""

    # #1724: pending invites expose PII (email / role / invited_by). IsWorkspaceAdmin
    # would admit any implicit member on GET — gate reads at ADMIN too.
    permission_classes = [IsAuthenticated, IsWorkspaceAdminStrict]
    # Standard page-number envelope so this bounded admin list returns the same
    # {count,next,previous,results} shape as every other list endpoint — an
    # integrator can't tell paginated from unpaginated when one list returns a
    # bare array (#1355). Set as an attribute (not just instantiated below) so
    # drf-spectacular documents the envelope in the OpenAPI schema too.
    pagination_class = PageNumberPagination

    @extend_schema(responses={200: WorkspaceInviteSerializer(many=True)})
    def get(self, request: Request) -> Response:
        invites = WorkspaceInvite.objects.filter(status=InviteStatus.PENDING).select_related(
            "invited_by"
        )
        # Paginate the queryset first, then build dicts only for the page.
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(invites, request, view=self)
        rows = [_invite_dict(i) for i in (page if page is not None else invites)]
        data = WorkspaceInviteSerializer(rows, many=True).data
        return paginator.get_paginated_response(data)

    @extend_schema(
        request=WorkspaceInviteCreateSerializer, responses={201: WorkspaceInviteSerializer}
    )
    def post(self, request: Request) -> Response:
        serializer = WorkspaceInviteCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]

        # Actor-ceiling: an actor may only invite someone to a role STRICTLY
        # BELOW their own — the same ``>=`` rule WorkspaceMemberDetailView.patch
        # enforces on existing members (#1728), applied here so an invite can't
        # be a back-door escalation. ``>`` would let an Admin invite a peer Admin
        # (equal role); the accept path grants the invite's role verbatim, so the
        # peer-Admin hole the PATCH gate closes would stay reachable via invites.
        actor_role = _workspace_membership_role(request)
        if actor_role is not None and serializer.validated_data["role"] >= actor_role:
            raise PermissionDenied(
                "You cannot invite someone to a role equal to or higher than your own."
            )

        if User.objects.filter(email__iexact=email, is_active=True).exists():
            raise ValidationError({"email": "A member with this email already exists."})
        if WorkspaceInvite.objects.filter(
            email__iexact=email, status=InviteStatus.PENDING
        ).exists():
            raise ValidationError({"email": "An invite for this email is already pending."})

        invite = services.create_invite(
            workspace=Workspace.load(),
            email=email,
            role=serializer.validated_data["role"],
            invited_by=request.user,
        )
        return Response(_invite_dict(invite), status=status.HTTP_201_CREATED)


class WorkspaceInviteDetailView(IdempotencyMixin, APIView):
    """DELETE /api/v1/workspace/invites/{id}/ — revoke a pending invite (#518)."""

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

    def delete(self, request: Request, invite_id: str) -> Response:
        invite = get_object_or_404(WorkspaceInvite, pk=invite_id)
        if invite.status == InviteStatus.PENDING:
            invite.status = InviteStatus.REVOKED
            invite.email_pending = False
            invite.email_token = ""
            invite.save(update_fields=["status", "email_pending", "email_token"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class InviteAcceptView(IdempotencyMixin, APIView):
    """POST /api/v1/workspace/invites/accept/ — accept an invite (public, token-auth).

    No session required: the one-time token in the body is the credential. Errors
    are generic to avoid token enumeration.
    """

    permission_classes = [AllowAny]
    authentication_classes: list[Any] = []
    throttle_classes = [InviteAcceptThrottle]

    @extend_schema(request=InviteAcceptSerializer, responses={200: None})
    def post(self, request: Request) -> Response:
        serializer = InviteAcceptSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            user = services.accept_invite(
                token=serializer.validated_data["token"],
                username=serializer.validated_data.get("username", ""),
                password=serializer.validated_data.get("password", ""),
            )
        except services.InviteError as exc:
            # Return the 400 directly rather than raising: DRF's exception handler
            # calls set_rollback(), which would revert the expired-status write
            # accept_invite makes for an overdue token under ATOMIC_REQUESTS.
            # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"detail": "Invitation accepted.", "username": user.username})


class InviteResendThrottle(ScopedRateThrottle):
    """Caps invite-resend frequency (ADR-0149) to bound email-bomb abuse.

    Scoped per-admin via ``invite_resend`` (5/min). The bulk resend-all endpoint
    is one request → one bucket hit, so it cannot be looped to exceed the cap.
    """

    scope = "invite_resend"


class WorkspaceInviteResendView(IdempotencyMixin, APIView):
    """POST /api/v1/workspace/invites/{id}/resend/ — re-queue one invite (ADR-0149).

    Admin only. Re-issues a fresh token (the old email link stops working) and puts
    the row back in the outbox for ``drain_invite_emails`` to pick up. Best-effort
    dispatch → 202 ``{"queued": true}``. Only PENDING/FAILED invites are resendable;
    accepted/revoked/expired return 409.
    """

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]
    throttle_classes = [InviteResendThrottle]

    @extend_schema(
        request=None,
        responses={
            202: OpenApiResponse(description="Invite re-queued for sending."),
            404: OpenApiResponse(description="Invite not found."),
            409: OpenApiResponse(description="Invite is not in a resendable state."),
        },
    )
    def post(self, request: Request, invite_id: str) -> Response:
        if not WorkspaceInvite.objects.filter(pk=invite_id).exists():
            raise Http404("Invite not found.")
        invite = services.resend_invite(invite_id)
        if invite is None:
            # Exists (checked above) but not resendable → accepted/revoked/expired.
            return Response(
                {"detail": "This invite can no longer be resent."},
                status=status.HTTP_409_CONFLICT,
            )
        transaction.on_commit(services.drain_invite_emails_soon)
        return Response({"queued": True}, status=status.HTTP_202_ACCEPTED)


class WorkspaceInviteResendAllView(IdempotencyMixin, APIView):
    """POST /api/v1/workspace/invites/resend-all/ — re-queue every pending invite.

    Admin only. One transaction, one throttle bucket — emails everyone with a
    resendable invite at once. Returns 202 ``{"requeued": n}`` (n excludes invites
    already in flight).
    """

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]
    throttle_classes = [InviteResendThrottle]

    @extend_schema(
        request=None,
        responses={202: OpenApiResponse(description="Pending invites re-queued.")},
    )
    def post(self, request: Request) -> Response:
        count = services.resend_all_pending(Workspace.load())
        if count:
            transaction.on_commit(services.drain_invite_emails_soon)
        return Response({"requeued": count}, status=status.HTTP_202_ACCEPTED)


# Magic-byte signatures for the raster logo allowlist (ADR-0149). We sniff the
# leading bytes rather than trust the multipart Content-Type, and accept no SVG —
# a publicly-served SVG is a stored-XSS vector.
_LOGO_MAX_BYTES = 2 * 1024 * 1024  # 2 MB
_LOGO_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_LOGO_MIME_PNG = "image/png"
_LOGO_MIME_WEBP = "image/webp"


def _sniff_logo_mime(head: bytes) -> str | None:
    """Return the canonical MIME for a PNG/WebP byte head, or None if neither."""
    if head.startswith(_LOGO_PNG_MAGIC):
        return _LOGO_MIME_PNG
    # WebP: 'RIFF' <4-byte size> 'WEBP'.
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return _LOGO_MIME_WEBP
    return None


class WorkspaceLogoView(IdempotencyMixin, APIView):
    """Workspace logo: POST upload, DELETE clear (admin), GET serve (public).

    GET is ``AllowAny`` — the logo is non-sensitive branding shown on public share
    pages, so serving it without auth avoids a JWT-in-``<img>`` problem. Write paths
    require workspace ADMIN+. Raster only (PNG/WebP); content type is decided by a
    magic-byte sniff, not the client-declared Content-Type (ADR-0149).

    Carries ``IdempotencyMixin`` like every other unsafe workspace view: the mixin
    only intercepts unsafe methods bearing an Idempotency-Key, so the public GET
    surface is unaffected.
    """

    parser_classes = [MultiPartParser, FormParser]

    def get_permissions(self) -> list[Any]:
        if self.request.method == "GET":
            return [AllowAny()]
        return [IsAuthenticated(), IsWorkspaceAdmin()]

    def get_authenticators(self) -> list[Any]:
        # Public GET must not 401 on an absent/invalid token; only the write paths
        # authenticate. Mirrors InviteAcceptView's anonymous surface.
        if getattr(self.request, "method", None) == "GET":
            return []
        return super().get_authenticators()

    @extend_schema(
        responses={
            200: OpenApiResponse(description="Logo image bytes."),
            404: OpenApiResponse(description="No logo set."),
        },
        description="Serve the workspace logo (public). Returns 404 when unset.",
    )
    def get(self, request: Request) -> FileResponse:
        workspace = Workspace.load()
        if not workspace.logo:
            raise Http404("No workspace logo set.")
        content_type = workspace.logo_mime or _LOGO_MIME_PNG
        response = FileResponse(workspace.logo.open("rb"), content_type=content_type)
        # Branding is non-sensitive but still user-uploaded: force inline rendering,
        # block content-type sniffing, and let caches hold it (busted via ?v= on the
        # serializer URL when the logo changes).
        response["Content-Disposition"] = "inline"
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "public, max-age=86400"
        return response

    @extend_schema(
        request={
            "multipart/form-data": {
                "type": "object",
                "properties": {"file": {"type": "string", "format": "binary"}},
            }
        },
        responses={200: WorkspaceSettingsSerializer},
    )
    def post(self, request: Request) -> Response:
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationError({"file": "No file was uploaded."})
        if upload.size > _LOGO_MAX_BYTES:
            return Response(
                {"file": "Logo must be 2 MB or smaller."},
                status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        head = upload.read(32)
        upload.seek(0)
        mime = _sniff_logo_mime(head)
        if mime is None:
            return Response(
                {"file": "Logo must be a PNG or WebP image."},
                status=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            )
        workspace = services.set_workspace_logo(file=upload, mime=mime)
        return Response(WorkspaceSettingsSerializer(workspace).data)

    @extend_schema(responses={200: WorkspaceSettingsSerializer})
    def delete(self, request: Request) -> Response:
        workspace = services.clear_workspace_logo()
        return Response(WorkspaceSettingsSerializer(workspace).data)


# ---------------------------------------------------------------------------
# #519 — Groups & teams
# ---------------------------------------------------------------------------


class GroupListView(IdempotencyMixin, APIView):
    """GET/POST /api/v1/workspace/groups/ (#519). Read and create: admin only."""

    # #1724: group rosters are org structure — IsWorkspaceAdmin would leak them to
    # any implicit member on GET. Gate reads at ADMIN, matching create.
    permission_classes = [IsAuthenticated, IsWorkspaceAdminStrict]
    # Standard page-number envelope so this admin list matches every other list
    # endpoint's {count,next,previous,results} shape (#1355).
    pagination_class = PageNumberPagination

    @extend_schema(responses={200: GroupSerializer(many=True)})
    def get(self, request: Request) -> Response:
        groups = Group.objects.filter(is_deleted=False).select_related("lead")
        # Paginate the queryset first, then build dicts only for the page —
        # _build_group_dicts fans out into membership/project lookups.
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(groups, request, view=self)
        rows = _build_group_dicts(list(page) if page is not None else list(groups))
        data = GroupSerializer(rows, many=True).data
        return paginator.get_paginated_response(data)

    @extend_schema(request=GroupWriteSerializer, responses={201: GroupSerializer})
    def post(self, request: Request) -> Response:
        serializer = GroupWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        group = serializer.save(workspace=Workspace.load())
        return Response(_build_group_dict(group), status=status.HTTP_201_CREATED)


class GroupDetailView(IdempotencyMixin, APIView):
    """GET/PATCH/DELETE /api/v1/workspace/groups/{id}/ (#519)."""

    # #1724: a group's roster is org structure — IsWorkspaceAdmin would leak it to
    # any implicit member on GET. Gate reads at ADMIN, matching patch/delete.
    permission_classes = [IsAuthenticated, IsWorkspaceAdminStrict]

    def _get_group_or_404(self, group_id: str) -> Group:
        return get_object_or_404(Group, pk=group_id, is_deleted=False)

    @extend_schema(responses={200: GroupSerializer})
    def get(self, request: Request, group_id: str) -> Response:
        return Response(_build_group_dict(self._get_group_or_404(group_id)))

    @extend_schema(request=GroupWriteSerializer, responses={200: GroupSerializer})
    def patch(self, request: Request, group_id: str) -> Response:
        group = self._get_group_or_404(group_id)
        serializer = GroupWriteSerializer(group, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(_build_group_dict(group))

    def delete(self, request: Request, group_id: str) -> Response:
        group = self._get_group_or_404(group_id)
        with transaction.atomic():
            group.soft_delete()
            services.reconcile_group_access(group.pk)
        return Response(status=status.HTTP_204_NO_CONTENT)


class GroupMemberView(IdempotencyMixin, APIView):
    """POST/DELETE /api/v1/workspace/groups/{id}/members/[{user_id}/] (#519)."""

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

    def _get_group_or_404(self, group_id: str) -> Group:
        return get_object_or_404(Group, pk=group_id, is_deleted=False)

    @extend_schema(request=GroupMemberAddSerializer, responses={201: GroupSerializer})
    def post(self, request: Request, group_id: str) -> Response:
        group = self._get_group_or_404(group_id)
        serializer = GroupMemberAddSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target = get_object_or_404(User, pk=serializer.validated_data["user"])
        with transaction.atomic():
            membership = (
                GroupMembership.objects.select_for_update().filter(group=group, user=target).first()
            )
            if membership is None:
                GroupMembership.objects.create(group=group, user=target)
            elif membership.is_deleted:
                membership.is_deleted = False
                membership.deleted_version = None
                membership.save()
            services.reconcile_group_access(group.pk)
        return Response(_build_group_dict(group), status=status.HTTP_201_CREATED)

    def delete(self, request: Request, group_id: str, user_id: str) -> Response:
        group = self._get_group_or_404(group_id)
        with transaction.atomic():
            membership = (
                GroupMembership.objects.select_for_update()
                .filter(group=group, user_id=user_id, is_deleted=False)
                .first()
            )
            if membership is not None:
                membership.soft_delete()
            services.reconcile_group_access(group.pk)
        return Response(status=status.HTTP_204_NO_CONTENT)


class GroupProjectView(IdempotencyMixin, APIView):
    """POST/DELETE /api/v1/workspace/groups/{id}/projects/[{project_id}/] (#519).

    Linking a group to a project confers the chosen role on every group member
    via the cascade (ADR-0087 §5).
    """

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

    def _get_group_or_404(self, group_id: str) -> Group:
        return get_object_or_404(Group, pk=group_id, is_deleted=False)

    @extend_schema(request=GroupProjectWriteSerializer, responses={201: GroupSerializer})
    def post(self, request: Request, group_id: str) -> Response:
        from trueppm_api.apps.projects.models import Project

        group = self._get_group_or_404(group_id)
        serializer = GroupProjectWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        project = get_object_or_404(
            Project, pk=serializer.validated_data["project"], is_deleted=False
        )
        with transaction.atomic():
            GroupProject.objects.update_or_create(
                group=group,
                project=project,
                defaults={
                    "role": serializer.validated_data["role"],
                    # IsAuthenticated guarantees a concrete User, not AnonymousUser.
                    "added_by": request.user,  # type: ignore[misc]
                },
            )
            services.reconcile_group_access(group.pk)
        return Response(_build_group_dict(group), status=status.HTTP_201_CREATED)

    def delete(self, request: Request, group_id: str, project_id: str) -> Response:
        group = self._get_group_or_404(group_id)
        with transaction.atomic():
            GroupProject.objects.filter(group=group, project_id=project_id).delete()
            services.reconcile_group_access(group.pk)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# #641 — Workspace lifecycle: transfer ownership / export (ADR-0174)
# (Workspace hard-delete is ``WorkspaceSettingsView.delete`` above.)
# ---------------------------------------------------------------------------


class TransferOwnershipView(IdempotencyMixin, APIView):
    """POST /api/v1/workspace/transfer-ownership/ — hand the workspace to a member.

    Owner only. The target must already be an active member; the current owner is
    demoted to Admin (#641). Mirrors the project transfer action.
    """

    permission_classes = [IsAuthenticated, IsWorkspaceOwner]

    @extend_schema(
        request=TransferOwnershipSerializer,
        responses={200: OpenApiResponse(description="Ownership transferred.")},
    )
    def post(self, request: Request) -> Response:
        serializer = TransferOwnershipSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        new_owner_id = serializer.validated_data["new_owner_user_id"]

        try:
            new_owner = User.objects.get(pk=new_owner_id)
        except User.DoesNotExist:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        try:
            services.transfer_workspace_ownership(new_owner=new_owner, actor=request.user)
        except DjangoValidationError as exc:
            detail = exc.messages[0] if exc.messages else str(exc)
            # codeql[py/stack-trace-exposure] -- intentional user-facing validation message
            return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {"detail": "Workspace ownership transferred.", "new_owner_user_id": new_owner_id}
        )


class WorkspaceExportView(IdempotencyMixin, APIView):
    """GET lists recent export jobs; POST queues a new full export (#641). Owner only."""

    permission_classes = [IsAuthenticated, IsWorkspaceOwner]
    # Standard page-number envelope so the job list matches every other list
    # endpoint's {count,next,previous,results} shape — the previous bare ``[:20]``
    # slice gave an integrator no way to tell a truncated list from a complete one
    # (#1355). Bounded in practice by the export-retention purge.
    pagination_class = PageNumberPagination

    @extend_schema(responses={200: WorkspaceExportJobSerializer(many=True)})
    def get(self, request: Request) -> Response:
        jobs = WorkspaceExportJob.objects.all()
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(jobs, request, view=self)
        data = WorkspaceExportJobSerializer(page if page is not None else jobs, many=True).data
        return paginator.get_paginated_response(data)

    @extend_schema(request=None, responses={202: WorkspaceExportJobSerializer})
    def post(self, request: Request) -> Response:
        job = services.enqueue_workspace_export(requested_by=request.user)
        return Response(WorkspaceExportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class WorkspaceExportDetailView(APIView):
    """GET /api/v1/workspace/export/{job_id}/ — poll an export's status (#641). Owner only."""

    permission_classes = [IsAuthenticated, IsWorkspaceOwner]

    @extend_schema(responses={200: WorkspaceExportJobSerializer})
    def get(self, request: Request, job_id: str) -> Response:
        job = get_object_or_404(WorkspaceExportJob, pk=job_id)
        return Response(WorkspaceExportJobSerializer(job).data)


class WorkspaceExportDownloadView(APIView):
    """GET /api/v1/workspace/export/{job_id}/download/ — stream the archive (#641).

    Owner only and authenticated — the archive contains every project's data, so it
    is never served from a raw, unauthenticated storage URL. ``409`` if not ready,
    ``410 Gone`` once the link has expired.
    """

    permission_classes = [IsAuthenticated, IsWorkspaceOwner]

    def get(self, request: Request, job_id: str) -> Any:
        from django.core.files.storage import default_storage

        job = get_object_or_404(WorkspaceExportJob, pk=job_id)
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
            filename=f"workspace-export-{job.id}.tar.gz",
            content_type="application/gzip",
        )


class AuditEventCursorPagination(CursorPagination):
    """Stable, depth-independent pagination for the unbounded audit log (ADR-0157).

    Cursor (not page-number) pagination because the log grows without bound and is
    appended to concurrently — a cursor keyed on ``created_at`` stays correct under
    inserts and is O(1) regardless of how deep the reader scrolls.
    """

    ordering = "-created_at"
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


def _parse_audit_bound(value: str) -> Any:
    """Parse a ``since``/``until`` filter into an aware datetime, or raise 400.

    Accepts an ISO-8601 datetime or a bare date (interpreted as midnight). A naive
    value is made timezone-aware in the active timezone.
    """
    import datetime as _datetime

    parsed = parse_datetime(value)
    if parsed is None:
        as_date = parse_date(value)
        if as_date is None:
            raise ValidationError({"detail": f"Invalid date/time value: {value!r}."})
        parsed = _datetime.datetime.combine(as_date, _datetime.time.min)
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed)
    return parsed


class WorkspaceAuditEventListView(APIView):
    """GET /api/v1/workspace/audit-events/ — operational audit log (ADR-0157, #859).

    Owner/Admin only (``IsWorkspaceAuditViewer``). Cursor-paginated, newest first.
    Optional filters, all ANDed: ``?event_type=`` (an ``AuditEventType`` value),
    ``?actor=`` (user id), ``?since=`` / ``?until=`` (ISO-8601 on ``created_at``).
    """

    permission_classes = [IsAuthenticated, IsWorkspaceAuditViewer]

    @extend_schema(
        parameters=[
            OpenApiParameter(
                "event_type",
                str,
                description="Filter to a single AuditEventType value.",
            ),
            OpenApiParameter("actor", int, description="Filter by actor user id."),
            OpenApiParameter(
                "since", str, description="Only events at/after this ISO-8601 instant."
            ),
            OpenApiParameter(
                "until", str, description="Only events at/before this ISO-8601 instant."
            ),
        ],
        responses={200: AuditEventSerializer(many=True)},
    )
    def get(self, request: Request) -> Response:
        qs = AuditEvent.objects.select_related("actor").all()

        event_type = request.query_params.get("event_type")
        if event_type:
            if event_type not in AuditEventType.values:
                raise ValidationError({"detail": f"Unknown event_type: {event_type!r}."})
            qs = qs.filter(event_type=event_type)

        actor = request.query_params.get("actor")
        if actor:
            try:
                actor_id = int(actor)
            except (TypeError, ValueError) as exc:
                raise ValidationError({"detail": "actor must be an integer user id."}) from exc
            qs = qs.filter(actor_id=actor_id)

        since = request.query_params.get("since")
        if since:
            qs = qs.filter(created_at__gte=_parse_audit_bound(since))
        until = request.query_params.get("until")
        if until:
            qs = qs.filter(created_at__lte=_parse_audit_bound(until))

        paginator = AuditEventCursorPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        data = AuditEventSerializer(page, many=True).data
        return paginator.get_paginated_response(data)
