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
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.workspace import services
from trueppm_api.apps.workspace.models import (
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
    IsWorkspaceOwner,
    _workspace_membership_role,
    request_is_workspace_owner,
)
from trueppm_api.apps.workspace.serializers import (
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

# Typed-confirmation header for the destructive workspace delete (ADR-0092). Its
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
        else:
            role_val = WorkspaceRole.OWNER if u.is_superuser else WorkspaceRole.MEMBER
            member_status = MemberStatus.ACTIVE
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
                "sso": False,
                "two_fa": False,
            }
        )
    return rows


def _group_dict(group: Group, members: list[Any], project_names: list[str]) -> dict[str, Any]:
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
        "projects": project_names,
    }


def _build_group_dict(group: Group) -> dict[str, Any]:
    """Single-group dict (used for create/patch/detail responses — 2 queries)."""
    members = list(
        GroupMembership.objects.filter(group=group, is_deleted=False).select_related("user")
    )
    project_names = list(
        GroupProject.objects.filter(group=group, project__is_deleted=False).values_list(
            "project__name", flat=True
        )
    )
    return _group_dict(group, members, project_names)


def _build_group_dicts(groups: list[Group]) -> list[dict[str, Any]]:
    """Bulk group dicts for the list endpoint — two queries total, no per-group N+1."""
    group_ids = [g.pk for g in groups]
    members_by_group: dict[Any, list[Any]] = defaultdict(list)
    for gm in GroupMembership.objects.filter(
        group_id__in=group_ids, is_deleted=False
    ).select_related("user"):
        members_by_group[gm.group_id].append(gm)
    projects_by_group: dict[Any, list[str]] = defaultdict(list)
    for group_id, project_name in GroupProject.objects.filter(
        group_id__in=group_ids, project__is_deleted=False
    ).values_list("group_id", "project__name"):
        projects_by_group[group_id].append(project_name)
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
        serializer = WorkspaceSettingsSerializer(workspace, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
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
        """Hard-delete the workspace and all its data (ADR-0092, #641).

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


class WorkspaceMemberListView(APIView):
    """GET /api/v1/workspace/members/ — list members (#518).

    Admins see every member; a non-admin member sees only their own row.
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

    @extend_schema(responses={200: WorkspaceMemberSerializer(many=True)})
    def get(self, request: Request) -> Response:
        role = _workspace_membership_role(request)
        if role is not None and role >= WorkspaceRole.ADMIN:
            users = list(self._annotated_users(User.objects.all()).order_by("username"))
        else:
            # Non-admin: only your own row.
            user_pk = request.user.pk
            assert user_pk is not None  # IsAuthenticated guarantees a real user
            users = list(self._annotated_users(User.objects.filter(pk=user_pk)))
        return Response(WorkspaceMemberSerializer(_build_member_rows(users), many=True).data)


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

            if new_role is not None:
                # An actor cannot grant a role above their own.
                if actor_role is not None and new_role > actor_role:
                    raise PermissionDenied("You cannot assign a role higher than your own.")
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

            membership.save()

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
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceInviteListView(IdempotencyMixin, APIView):
    """GET/POST /api/v1/workspace/invites/ (#518). Admin only."""

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

    @extend_schema(responses={200: WorkspaceInviteSerializer(many=True)})
    def get(self, request: Request) -> Response:
        invites = WorkspaceInvite.objects.filter(status=InviteStatus.PENDING).select_related(
            "invited_by"
        )
        return Response(
            WorkspaceInviteSerializer([_invite_dict(i) for i in invites], many=True).data
        )

    @extend_schema(
        request=WorkspaceInviteCreateSerializer, responses={201: WorkspaceInviteSerializer}
    )
    def post(self, request: Request) -> Response:
        serializer = WorkspaceInviteCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]

        # Actor-ceiling: an admin cannot invite someone above their own role —
        # the same rule WorkspaceMemberDetailView.patch enforces on existing
        # members, applied here so an invite can't be a back-door escalation.
        actor_role = _workspace_membership_role(request)
        if actor_role is not None and serializer.validated_data["role"] > actor_role:
            raise PermissionDenied("You cannot invite someone to a role higher than your own.")

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
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"detail": "Invitation accepted.", "username": user.username})


# ---------------------------------------------------------------------------
# #519 — Groups & teams
# ---------------------------------------------------------------------------


class GroupListView(IdempotencyMixin, APIView):
    """GET/POST /api/v1/workspace/groups/ (#519). Read: any member; create: admin."""

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

    @extend_schema(responses={200: GroupSerializer(many=True)})
    def get(self, request: Request) -> Response:
        groups = list(Group.objects.filter(is_deleted=False).select_related("lead"))
        return Response(GroupSerializer(_build_group_dicts(groups), many=True).data)

    @extend_schema(request=GroupWriteSerializer, responses={201: GroupSerializer})
    def post(self, request: Request) -> Response:
        serializer = GroupWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        group = serializer.save(workspace=Workspace.load())
        return Response(_build_group_dict(group), status=status.HTTP_201_CREATED)


class GroupDetailView(IdempotencyMixin, APIView):
    """GET/PATCH/DELETE /api/v1/workspace/groups/{id}/ (#519)."""

    permission_classes = [IsAuthenticated, IsWorkspaceAdmin]

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
# #641 — Workspace lifecycle: transfer ownership / export (ADR-0092)
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
            return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {"detail": "Workspace ownership transferred.", "new_owner_user_id": new_owner_id}
        )


class WorkspaceExportView(IdempotencyMixin, APIView):
    """GET lists recent export jobs; POST queues a new full export (#641). Owner only."""

    permission_classes = [IsAuthenticated, IsWorkspaceOwner]

    @extend_schema(responses={200: WorkspaceExportJobSerializer(many=True)})
    def get(self, request: Request) -> Response:
        jobs = WorkspaceExportJob.objects.all()[:20]
        return Response(WorkspaceExportJobSerializer(jobs, many=True).data)

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
