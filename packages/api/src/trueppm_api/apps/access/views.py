"""ViewSets for the access app."""

from __future__ import annotations

import uuid
from typing import Any

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, IntegerField, OuterRef, Q, QuerySet, Subquery
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import serializers as drf_serializers
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import (
    ExternalStakeholder,
    ProgramMembership,
    ProgramUserDefinedMentionGroup,
    ProjectMembership,
    Role,
    UserDefinedMentionGroup,
)
from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProgramOwner,
    IsProjectMember,
    IsProjectNotArchived,
    IsProjectOwner,
    McpReadableViewMixin,
    _membership_role,
    _program_membership_role,
)
from trueppm_api.apps.access.serializers import (
    ExternalStakeholderSerializer,
    MeSerializer,
    ProgramMembershipReadSerializer,
    ProgramMembershipWriteSerializer,
    ProgramUserDefinedMentionGroupReadSerializer,
    ProgramUserDefinedMentionGroupWriteSerializer,
    ProjectMembershipReadSerializer,
    ProjectMembershipWriteSerializer,
    UserDefinedMentionGroupReadSerializer,
    UserDefinedMentionGroupWriteSerializer,
    UserSearchResultSerializer,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.workspace.permissions import IsWorkspaceMember

_PK = str | uuid.UUID


class ProjectMembershipViewSet(IdempotencyMixin, viewsets.GenericViewSet[ProjectMembership]):
    """Nested CRUD for project memberships.

    URL: /api/v1/projects/{project_pk}/members/
         /api/v1/projects/{project_pk}/members/{pk}/

    Permission matrix:
      list/retrieve  — any project member (Viewer+)
      create         — Owner only (role == Role.OWNER)
      partial_update — Owner only; caller may not assign role >= their own
      destroy        — Owner only for others; any member may self-remove
                       (last-Owner guard prevents stranding a project)
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get_permissions(self) -> list[BasePermission]:
        """Express the Owner-only create/partial_update gate at the permission layer.

        The view bodies already enforce ``Role.OWNER`` (and the assign-below-self
        and last-Owner invariants), but a Viewer reached the body before being
        rejected — the role gate was invisible to DRF-level audits and OpenAPI
        security generation (#1351). Adding IsProjectOwner here is defense-in-depth,
        not a behavior change: the in-body checks remain authoritative. ``destroy``
        is deliberately excluded — any member may self-remove (the last-Owner guard
        prevents stranding a project), so it must not require Owner.
        """
        perms: list[BasePermission] = [
            IsAuthenticated(),
            IsProjectMember(),
            IsProjectNotArchived(),
        ]
        if self.action in ("create", "partial_update"):
            perms.append(IsProjectOwner())
        return perms

    def get_queryset(self) -> QuerySet[ProjectMembership]:
        project_pk = self.kwargs["project_pk"]
        # Annotate each row with the member's count of OTHER active projects (#598)
        # via a correlated subquery — one extra query for the whole page, no N+1.
        # Coalesce to 0 for members who are on no other active project.
        other_active = (
            ProjectMembership.objects.filter(
                user_id=OuterRef("user_id"),
                is_deleted=False,
                project__is_deleted=False,
                project__is_archived=False,
            )
            .exclude(project_id=project_pk)
            .values("user_id")
            .annotate(c=Count("project_id", distinct=True))
            .values("c")
        )
        return (
            ProjectMembership.objects.select_related("project", "user")
            .filter(project_id=project_pk, is_deleted=False)
            .annotate(
                other_active_count=Coalesce(Subquery(other_active, output_field=IntegerField()), 0)
            )
        )

    def _build_other_project_names_map(
        self, request: Request, memberships: list[ProjectMembership], current_project_pk: _PK
    ) -> dict[object, list[str]]:
        """Map user_id -> names of their other active projects the REQUESTER owns (#598).

        Visibility gate: a project name is revealed only for projects the requesting user
        is OWNER of — never leak the name of a project the requester cannot already see.
        Bounded query cost: one query for the requester's owned projects + one for the
        members' memberships within that owned set (no per-row queries).
        """
        names_map: dict[object, list[str]] = {m.user_id: [] for m in memberships}
        if not memberships:
            return names_map
        owned_ids = set(
            ProjectMembership.objects.filter(
                # IsAuthenticated guarantees a real User, but mypy still sees
                # request.user as User | AnonymousUser for the lookup.
                user=request.user,  # type: ignore[misc]
                role=Role.OWNER,
                is_deleted=False,
                project__is_deleted=False,
                project__is_archived=False,
            )
            .exclude(project_id=current_project_pk)
            .values_list("project_id", flat=True)
        )
        if not owned_ids:
            return names_map
        rows = (
            ProjectMembership.objects.filter(
                user_id__in=list(names_map.keys()),
                is_deleted=False,
                project_id__in=owned_ids,
                # Self-contained active-project gate (defense in depth): owned_ids is
                # already built from active projects, but pin it here too so a future
                # change to owned_ids can't silently surface an archived/deleted name.
                project__is_deleted=False,
                project__is_archived=False,
            )
            .select_related("project")
            .order_by("project__name")
        )
        for row in rows:
            names_map[row.user_id].append(row.project.name)
        return names_map

    def get_serializer_class(self) -> type[BaseSerializer[ProjectMembership]]:
        if self.action in ("create", "partial_update", "update"):
            return ProjectMembershipWriteSerializer
        return ProjectMembershipReadSerializer

    def _get_project_or_404(self) -> Project:
        try:
            return Project.objects.get(pk=self.kwargs["project_pk"], is_deleted=False)
        except Project.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound("Project not found.") from err

    def _require_actor_role(self, request: Request, project_id: _PK, minimum: int) -> int:
        """Return the actor's role, raising 403 if below minimum."""
        role = _membership_role(request, project_id)
        if role is None or role < minimum:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You do not have permission to perform this action.")
        return role

    def _check_last_owner_guard(self, project_id: _PK, exclude_pk: _PK | None = None) -> None:
        """Raise 422 if removing/demoting would strand the project without an Owner."""
        qs = ProjectMembership.objects.filter(
            project_id=project_id, role=Role.OWNER, is_deleted=False
        )
        if exclude_pk:
            qs = qs.exclude(pk=exclude_pk)
        # select_for_update prevents concurrent removal of both owners simultaneously.
        if not qs.select_for_update().exists():
            raise drf_serializers.ValidationError(
                {"detail": "Cannot remove or demote the last Owner of a project."}
            )

    # -----------------------------------------------------------------------
    # Actions
    # -----------------------------------------------------------------------

    def list(self, request: Request, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        # has_permission only checks authentication; enforce membership explicitly
        # because DRF only calls has_object_permission on retrieve/update/destroy.
        if _membership_role(request, project.pk) is None:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You must be a member of this project.")
        qs = self.get_queryset()
        # ?self=true: return only the requesting user's own membership row.
        # Used by the frontend useCurrentUserRole() hook for tab-level RBAC.
        if request.query_params.get("self") == "true":
            user_pk = request.user.pk
            assert user_pk is not None  # IsAuthenticated ensures a real user
            qs = qs.filter(user_id=user_pk)
        memberships = list(qs)
        names_map = self._build_other_project_names_map(request, memberships, project.pk)
        serializer = ProjectMembershipReadSerializer(
            memberships,
            many=True,
            context={"request": request, "other_project_names_map": names_map},
        )
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        instance = self.get_object()
        names_map = self._build_other_project_names_map(request, [instance], project.pk)
        return Response(
            ProjectMembershipReadSerializer(
                instance,
                context={"request": request, "other_project_names_map": names_map},
            ).data
        )

    def create(self, request: Request, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        self._require_actor_role(request, project.pk, Role.OWNER)

        serializer = ProjectMembershipWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        actor_role = _membership_role(request, project.pk)
        new_role = serializer.validated_data["role"]
        # Caller may only assign roles strictly below their own.
        if actor_role is not None and new_role >= actor_role:
            raise drf_serializers.ValidationError(
                {"role": "You cannot assign a role equal to or higher than your own."}
            )

        # Detect duplicate membership (unique_together enforces at DB level, but
        # return a clean 409 rather than a 500 IntegrityError).
        user = serializer.validated_data["user"]
        if ProjectMembership.objects.filter(project=project, user=user, is_deleted=False).exists():
            return Response(
                {"detail": "User is already a member of this project."},
                status=status.HTTP_409_CONFLICT,
            )

        instance = serializer.save(project=project)

        project_id = str(project.pk)
        membership_id = str(instance.pk)
        user_id = str(user.pk)
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id,
                "member_added",
                {"membership_id": membership_id, "user_id": user_id, "role": new_role},
            )
        )

        return Response(
            ProjectMembershipReadSerializer(instance).data, status=status.HTTP_201_CREATED
        )

    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        instance = self.get_object()

        serializer = ProjectMembershipWriteSerializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)

        new_role = serializer.validated_data.get("role")

        # M4 fix: lock the actor's own membership row with SELECT FOR UPDATE inside
        # an atomic block to close the TOCTOU window where a concurrent demotion
        # could allow the actor to assign a role >= their effective role at save time.
        with transaction.atomic():
            try:
                actor_membership = ProjectMembership.objects.select_for_update().get(
                    project=project,
                    user=request.user,
                    is_deleted=False,  # type: ignore[misc]
                )
            except ProjectMembership.DoesNotExist:
                from rest_framework.exceptions import PermissionDenied

                raise PermissionDenied("You are not a member of this project.") from None

            actor_role = actor_membership.role
            if actor_role < Role.OWNER:
                from rest_framework.exceptions import PermissionDenied

                raise PermissionDenied("You do not have permission to perform this action.")

            if new_role is not None:
                # Cannot assign role >= actor's own.
                if new_role >= actor_role:
                    raise drf_serializers.ValidationError(
                        {"role": "You cannot assign a role equal to or higher than your own."}
                    )
                # Last-Owner guard: if demoting an Owner, ensure another Owner exists.
                if instance.role == Role.OWNER and new_role < Role.OWNER:
                    self._check_last_owner_guard(project.pk, exclude_pk=instance.pk)
                # Stamp role_changed_at only on an actual role change (#590) so a
                # no-op PATCH that re-sends the same role does not falsely advance
                # the per-project access-evidence timestamp.
                if new_role != instance.role:
                    serializer.save(role_changed_at=timezone.now())
                else:
                    serializer.save()
            else:
                serializer.save()

        project_id = str(project.pk)
        membership_id = str(instance.pk)
        user_id = str(instance.user_id)
        role_val = instance.role
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id,
                "member_role_changed",
                {"membership_id": membership_id, "user_id": user_id, "role": role_val},
            )
        )

        return Response(ProjectMembershipReadSerializer(instance).data)

    def destroy(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        instance = self.get_object()

        is_self = instance.user == request.user

        if is_self:
            # Any member may remove themselves; require at least Viewer membership.
            actor_role = _membership_role(request, project.pk)
            if actor_role is None:
                from rest_framework.exceptions import PermissionDenied

                raise PermissionDenied("You are not a member of this project.")
        else:
            # Removing another member requires Owner.
            actor_role = self._require_actor_role(request, project.pk, Role.OWNER)
            # Owner may only remove members with a lower role than themselves.
            if instance.role >= actor_role:
                raise drf_serializers.ValidationError(
                    {"detail": "You can only remove members with a role lower than your own."}
                )

        # Last-Owner guard — atomic with select_for_update.
        if instance.role == Role.OWNER:
            with transaction.atomic():
                self._check_last_owner_guard(project.pk, exclude_pk=instance.pk)
                instance.soft_delete()
        else:
            instance.soft_delete()

        project_id = str(project.pk)
        membership_id = str(instance.pk)
        user_id = str(instance.user_id)
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id, "member_removed", {"membership_id": membership_id, "user_id": user_id}
            )
        )

        return Response(status=status.HTTP_204_NO_CONTENT)


class UserDefinedMentionGroupViewSet(
    IdempotencyMixin, viewsets.GenericViewSet[UserDefinedMentionGroup]
):
    """Nested CRUD for user-defined @mention groups (ADR-0212, #515).

    URL: ``/api/v1/projects/{project_pk}/mention-groups/``
         ``/api/v1/projects/{project_pk}/mention-groups/{pk}/``
         ``…/{pk}/add-member/``  ``…/{pk}/remove-member/``
         ``…/{pk}/mute/``  ``…/{pk}/unmute/``

    Permission matrix (ADR-0212 §3):
      list / retrieve            — any project member (Viewer+)
      create / update / destroy  — Project Admin+  (group lifecycle is a PM act)
      add-member / remove-member — Project Scheduler+  (roster curation)
      mute / unmute              — any member (their own subscription only)
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get_serializer_class(self) -> type[BaseSerializer[UserDefinedMentionGroup]]:
        if self.action in ("create", "partial_update", "update"):
            return UserDefinedMentionGroupWriteSerializer
        return UserDefinedMentionGroupReadSerializer

    def get_queryset(self) -> QuerySet[UserDefinedMentionGroup]:
        project_pk = self.kwargs["project_pk"]
        return (
            UserDefinedMentionGroup.objects.filter(project_id=project_pk, is_deleted=False)
            .prefetch_related("members", "muted_by")
            .order_by("name")
        )

    def get_serializer_context(self) -> dict[str, Any]:
        ctx = dict(super().get_serializer_context())
        ctx["project_id"] = self.kwargs["project_pk"]
        return ctx

    def _get_project_or_404(self) -> Project:
        try:
            return Project.objects.get(pk=self.kwargs["project_pk"], is_deleted=False)
        except Project.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound("Project not found.") from err

    def _require_actor_role(self, request: Request, project_id: _PK, minimum: int) -> int:
        role = _membership_role(request, project_id)
        if role is None or role < minimum:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You do not have permission to perform this action.")
        return role

    def _broadcast(self, project_id: str, group_id: str, change: str) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Deferred to on_commit (ADR-0083) so a rolled-back write never notifies
        # open Members tabs; the group is also a VersionedModel, so clients that
        # miss the transient event reconcile via the sync delta.
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id,
                "mention_group_changed",
                {"group_id": group_id, "change": change},
            )
        )

    def _read_response(self, instance: UserDefinedMentionGroup, *, code: int = 200) -> Response:
        # Re-fetch through the prefetching queryset so member/mute counts on the
        # response reflect the write without an N+1.
        fresh = self.get_queryset().get(pk=instance.pk)
        return Response(
            UserDefinedMentionGroupReadSerializer(
                fresh, context=self.get_serializer_context()
            ).data,
            status=code,
        )

    # -- lifecycle (Admin+) --------------------------------------------------

    def list(self, request: Request, **kwargs: object) -> Response:
        self._get_project_or_404()
        serializer = UserDefinedMentionGroupReadSerializer(
            self.get_queryset(), many=True, context=self.get_serializer_context()
        )
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        self._get_project_or_404()
        return self._read_response(self.get_object())

    def create(self, request: Request, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        self._require_actor_role(request, project.pk, Role.ADMIN)
        serializer = UserDefinedMentionGroupWriteSerializer(
            data=request.data, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        instance = serializer.save(project=project, created_by=request.user)
        self._broadcast(str(project.pk), str(instance.pk), "created")
        return self._read_response(instance, code=status.HTTP_201_CREATED)

    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        self._require_actor_role(request, project.pk, Role.ADMIN)
        instance = self.get_object()
        serializer = UserDefinedMentionGroupWriteSerializer(
            instance, data=request.data, partial=True, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        instance = serializer.save()
        self._broadcast(str(project.pk), str(instance.pk), "updated")
        return self._read_response(instance)

    def destroy(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        # IsProjectNotArchived bypasses the archived check for any action named
        # "destroy" (its bypass set is matched by action name, for ProjectViewSet's
        # own delete). This nested viewset also names its delete "destroy", so the
        # archived read-only invariant must be re-asserted explicitly here — every
        # other write action (create/update/add-member/…) is already blocked by the
        # permission because it is not in that bypass set.
        if project.is_archived:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied(
                "This project is archived and cannot be modified. Unarchive it first."
            )
        self._require_actor_role(request, project.pk, Role.ADMIN)
        instance = self.get_object()
        instance.soft_delete()
        self._broadcast(str(project.pk), str(instance.pk), "deleted")
        return Response(status=status.HTTP_204_NO_CONTENT)

    # -- membership (Scheduler+) --------------------------------------------

    def _member_user_or_400(self, project_id: _PK) -> Any:
        """Resolve request.data['user'] to a User that is an active project member."""
        user_id = (self.request.data or {}).get("user")
        if not user_id:
            raise drf_serializers.ValidationError({"user": "This field is required."})
        User = get_user_model()
        try:
            user = User.objects.get(pk=user_id)
        except (User.DoesNotExist, ValueError, TypeError) as err:
            raise drf_serializers.ValidationError({"user": "User not found."}) from err
        # A mention group may only contain current project members — a group
        # member who is not on the project would be filtered out at resolution
        # anyway, so reject the add up front.
        if not ProjectMembership.objects.filter(
            project_id=project_id, user=user, is_deleted=False
        ).exists():
            raise drf_serializers.ValidationError({"user": "User is not a member of this project."})
        return user

    def _mutate_membership(self, request: Request, *, add: bool) -> Response:
        project = self._get_project_or_404()
        self._require_actor_role(request, project.pk, Role.SCHEDULER)
        instance = self.get_object()
        user = self._member_user_or_400(project.pk)
        if add:
            instance.members.add(user)
        else:
            instance.members.remove(user)
        # Bump server_version so the membership change flows through the sync
        # delta (the M2M write alone does not touch the parent row).
        instance.save(update_fields=["server_version"])
        self._broadcast(
            str(project.pk), str(instance.pk), "member_added" if add else "member_removed"
        )
        return self._read_response(instance)

    @action(detail=True, methods=["post"], url_path="add-member")
    def add_member(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_membership(request, add=True)

    @action(detail=True, methods=["post"], url_path="remove-member")
    def remove_member(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_membership(request, add=False)

    # -- mute / unmute (any member, self only) ------------------------------

    def _mutate_mute(self, request: Request, *, mute: bool) -> Response:
        project = self._get_project_or_404()
        # Any project member may mute/unmute a group for THEMSELVES only.
        self._require_actor_role(request, project.pk, Role.VIEWER)
        instance = self.get_object()
        if mute:
            instance.muted_by.add(request.user)  # type: ignore[arg-type]
        else:
            instance.muted_by.remove(request.user)  # type: ignore[arg-type]
        return self._read_response(instance)

    @action(detail=True, methods=["post"], url_path="mute")
    def mute(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_mute(request, mute=True)

    @action(detail=True, methods=["post"], url_path="unmute")
    def unmute(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_mute(request, mute=False)


class ProgramUserDefinedMentionGroupViewSet(
    IdempotencyMixin, viewsets.GenericViewSet[ProgramUserDefinedMentionGroup]
):
    """Nested CRUD for program-scoped user-defined @mention groups (ADR-0248, #516).

    URL: ``/api/v1/programs/{program_pk}/mention-groups/``
         ``/api/v1/programs/{program_pk}/mention-groups/{pk}/``
         ``…/{pk}/add-member/``  ``…/{pk}/remove-member/``
         ``…/{pk}/mute/``  ``…/{pk}/unmute/``

    Permission matrix (ADR-0248 §3):
      list / retrieve            — any program member (Viewer+)
      create / update / destroy  — Program Owner  (group lifecycle is an owner act)
      add-member / remove-member — Program Admin+  (roster curation)
      mute / unmute              — any member (their own subscription only)
    """

    permission_classes = [IsAuthenticated, IsProgramMember, IsProgramNotClosed]

    def get_permissions(self) -> list[BasePermission]:
        """Surface the Owner-only lifecycle gate at the permission layer (#1351).

        The action bodies already enforce ``Role.OWNER`` via ``_require_actor_role``,
        but that in-body check is invisible to DRF-level audits and OpenAPI security
        generation. Adding ``IsProgramOwner`` for the lifecycle actions is
        defense-in-depth over the authoritative in-body checks — mirroring the
        sibling membership viewsets. Membership (add/remove) and mute are Admin+ /
        any-member, so they keep the base classes only.
        """
        perms: list[BasePermission] = [
            IsAuthenticated(),
            IsProgramMember(),
            IsProgramNotClosed(),
        ]
        if self.action in ("create", "partial_update", "destroy"):
            perms.append(IsProgramOwner())
        return perms

    def get_serializer_class(
        self,
    ) -> type[BaseSerializer[ProgramUserDefinedMentionGroup]]:
        if self.action in ("create", "partial_update", "update"):
            return ProgramUserDefinedMentionGroupWriteSerializer
        return ProgramUserDefinedMentionGroupReadSerializer

    def get_queryset(self) -> QuerySet[ProgramUserDefinedMentionGroup]:
        program_pk = self.kwargs["program_pk"]
        return (
            ProgramUserDefinedMentionGroup.objects.filter(program_id=program_pk, is_deleted=False)
            .prefetch_related("members", "muted_by")
            .order_by("name")
        )

    def get_serializer_context(self) -> dict[str, Any]:
        ctx = dict(super().get_serializer_context())
        ctx["program_id"] = self.kwargs["program_pk"]
        return ctx

    def _get_program_or_404(self) -> Program:
        try:
            return Program.objects.get(pk=self.kwargs["program_pk"], is_deleted=False)
        except Program.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound("Program not found.") from err

    def _require_actor_role(self, request: Request, program_id: _PK, minimum: int) -> int:
        role = _program_membership_role(request, program_id)
        if role is None or role < minimum:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You do not have permission to perform this action.")
        return role

    def _broadcast(self, program_id: str, group_id: str, change: str) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # A program isn't board-scoped, so fan the refresh out to every live
        # project in the program — any open Members tab in the program reconciles.
        # Deferred to on_commit (ADR-0083) so a rolled-back write never notifies;
        # the group is also a VersionedModel, so a missed transient event is
        # reconciled via the sync delta.
        project_ids = list(
            Project.objects.filter(program_id=program_id, is_deleted=False).values_list(
                "id", flat=True
            )
        )

        def _emit() -> None:
            for project_id in project_ids:
                broadcast_board_event(
                    str(project_id),
                    "mention_group_changed",
                    {
                        "group_id": group_id,
                        "change": change,
                        "scope": "program",
                        # The web consumer invalidates the program-scoped query key
                        # (['program-mention-groups', program_id]) off this field —
                        # the event rides project channels but targets the program cache.
                        "program_id": program_id,
                    },
                )

        transaction.on_commit(_emit)

    def _read_response(
        self, instance: ProgramUserDefinedMentionGroup, *, code: int = 200
    ) -> Response:
        # Re-fetch through the prefetching queryset so member/mute counts on the
        # response reflect the write without an N+1.
        fresh = self.get_queryset().get(pk=instance.pk)
        return Response(
            ProgramUserDefinedMentionGroupReadSerializer(
                fresh, context=self.get_serializer_context()
            ).data,
            status=code,
        )

    # -- lifecycle (Owner) ---------------------------------------------------

    def list(self, request: Request, **kwargs: object) -> Response:
        self._get_program_or_404()
        serializer = ProgramUserDefinedMentionGroupReadSerializer(
            self.get_queryset(), many=True, context=self.get_serializer_context()
        )
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        self._get_program_or_404()
        return self._read_response(self.get_object())

    def create(self, request: Request, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        self._require_actor_role(request, program.pk, Role.OWNER)
        serializer = ProgramUserDefinedMentionGroupWriteSerializer(
            data=request.data, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        instance = serializer.save(program=program, created_by=request.user)
        self._broadcast(str(program.pk), str(instance.pk), "created")
        return self._read_response(instance, code=status.HTTP_201_CREATED)

    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        self._require_actor_role(request, program.pk, Role.OWNER)
        instance = self.get_object()
        serializer = ProgramUserDefinedMentionGroupWriteSerializer(
            instance, data=request.data, partial=True, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        instance = serializer.save()
        self._broadcast(str(program.pk), str(instance.pk), "updated")
        return self._read_response(instance)

    def destroy(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        # IsProgramNotClosed bypasses the closed check for any action named
        # "destroy" (its bypass set exists so a closed Program can be deleted
        # directly). This nested viewset also names its delete "destroy", so the
        # closed read-only invariant must be re-asserted explicitly here — every
        # other write action (create/update/add-member/…) is already blocked by the
        # permission because it is not in that bypass set. Mirrors the project
        # sibling's archived re-assertion.
        if program.is_closed:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied(
                "This program is closed and cannot be modified. Reopen it first."
            )
        self._require_actor_role(request, program.pk, Role.OWNER)
        instance = self.get_object()
        instance.soft_delete()
        self._broadcast(str(program.pk), str(instance.pk), "deleted")
        return Response(status=status.HTTP_204_NO_CONTENT)

    # -- membership (Admin+) -------------------------------------------------

    def _member_user_or_400(self, program_id: _PK) -> Any:
        """Resolve request.data['user'] to a User who is a member of the program.

        A program group may only contain users who hold a live ``ProjectMembership``
        on *some* project in the program (the ADR-0248 §2 union) — a user with no
        membership anywhere in the program would be filtered out at resolution
        anyway, so reject the add up front.
        """
        user_id = (self.request.data or {}).get("user")
        if not user_id:
            raise drf_serializers.ValidationError({"user": "This field is required."})
        User = get_user_model()
        try:
            user = User.objects.get(pk=user_id)
        except (User.DoesNotExist, ValueError, TypeError) as err:
            raise drf_serializers.ValidationError({"user": "User not found."}) from err
        if not ProjectMembership.objects.filter(
            project__program_id=program_id,
            project__is_deleted=False,
            user=user,
            is_deleted=False,
        ).exists():
            raise drf_serializers.ValidationError(
                {"user": "User is not a member of any project in this program."}
            )
        return user

    def _mutate_membership(self, request: Request, *, add: bool) -> Response:
        program = self._get_program_or_404()
        self._require_actor_role(request, program.pk, Role.ADMIN)
        instance = self.get_object()
        user = self._member_user_or_400(program.pk)
        if add:
            instance.members.add(user)
        else:
            instance.members.remove(user)
        # Bump server_version so the membership change flows through the sync
        # delta (the M2M write alone does not touch the parent row).
        instance.save(update_fields=["server_version"])
        self._broadcast(
            str(program.pk), str(instance.pk), "member_added" if add else "member_removed"
        )
        return self._read_response(instance)

    @action(detail=True, methods=["post"], url_path="add-member")
    def add_member(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_membership(request, add=True)

    @action(detail=True, methods=["post"], url_path="remove-member")
    def remove_member(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_membership(request, add=False)

    # -- mute / unmute (any member, self only) ------------------------------

    def _mutate_mute(self, request: Request, *, mute: bool) -> Response:
        program = self._get_program_or_404()
        # Any program member may mute/unmute a group for THEMSELVES only.
        self._require_actor_role(request, program.pk, Role.VIEWER)
        instance = self.get_object()
        if mute:
            instance.muted_by.add(request.user)  # type: ignore[arg-type]
        else:
            instance.muted_by.remove(request.user)  # type: ignore[arg-type]
        return self._read_response(instance)

    @action(detail=True, methods=["post"], url_path="mute")
    def mute(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_mute(request, mute=True)

    @action(detail=True, methods=["post"], url_path="unmute")
    def unmute(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_mute(request, mute=False)


class ExternalStakeholderViewSet(IdempotencyMixin, viewsets.ModelViewSet[ExternalStakeholder]):
    """Program-scoped CRUD for the external stakeholder registry (#1658, ADR-0264).

    URL: ``/api/v1/programs/{program_pk}/external-stakeholders/``
         ``/api/v1/programs/{program_pk}/external-stakeholders/{pk}/``

    A registry of non-account people (client sponsors, vendor contacts, external
    reviewers) who are included in the ``@program-stakeholders`` mention fan-out
    alongside the program's Viewer-role members. Delivery of email to these
    addresses is **deferred to #1675** — this surface manages the registry only.

    Permission matrix: program **Admin+** (Owner/Admin) for every action, list
    included — managing who is externally pinged is an administrative act, so a
    Scheduler/Member/Viewer/non-member is denied. ``IsProgramAdmin`` is the
    existing program-management gate (Role.ADMIN threshold); reused verbatim rather
    than reinvented. ``IsProgramNotClosed`` blocks writes to a closed program while
    still allowing reads (GET passes it).
    """

    permission_classes = [IsAuthenticated, IsProgramAdmin, IsProgramNotClosed]
    serializer_class = ExternalStakeholderSerializer
    lookup_field = "pk"
    # A program's stakeholder list is small and read whole by the settings UI; a
    # plain array (no pagination envelope) matches the sibling program-group hook.
    pagination_class = None

    def get_queryset(self) -> QuerySet[ExternalStakeholder]:
        # Scope to the URL's program AND live rows only — never trust a body-supplied
        # program id (IDOR-safe). The queryset is the sole authority on which program
        # a stakeholder belongs to, for both list and detail (update/destroy) routes.
        program_pk = self.kwargs["program_pk"]
        return (
            ExternalStakeholder.objects.filter(program_id=program_pk, is_deleted=False)
            .select_related("created_by")
            .order_by("name", "email")
        )

    def get_serializer_context(self) -> dict[str, Any]:
        ctx = dict(super().get_serializer_context())
        # The serializer's per-program email-uniqueness check reads this.
        ctx["program_id"] = self.kwargs["program_pk"]
        return ctx

    def _get_program_or_404(self) -> Program:
        try:
            return Program.objects.get(pk=self.kwargs["program_pk"], is_deleted=False)
        except Program.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound("Program not found.") from err

    def perform_create(self, serializer: BaseSerializer[ExternalStakeholder]) -> None:
        program = self._get_program_or_404()
        # Stamp program from the URL and created_by from the caller — both are
        # server-controlled, never client-supplied.
        serializer.save(program=program, created_by=self.request.user)

    def perform_destroy(self, instance: ExternalStakeholder) -> None:
        # IsProgramNotClosed's bypass set includes "destroy" (so a closed Program can
        # itself be deleted). This nested viewset also names its delete "destroy", so
        # re-assert the closed read-only invariant explicitly — mirroring the sibling
        # ProgramUserDefinedMentionGroupViewSet.destroy. create/update are already
        # blocked (they are not in the bypass set).
        program = self._get_program_or_404()
        if program.is_closed:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied(
                "This program is closed and cannot be modified. Reopen it first."
            )
        # Soft-delete: flip the flag so the email frees up for re-add and the
        # partial-unique constraint stops binding this row.
        instance.is_deleted = True
        instance.save(update_fields=["is_deleted", "updated_at"])


class UserSearchView(APIView):
    """GET /api/v1/users/search/?q=<term> — workspace user typeahead for member invite.

    Returns up to 10 active users matching username or email (case-insensitive).
    The email is matched but never returned (#815, ADR-0061 amended): the previous
    serializer echoed every matched user's email, so a single authenticated account
    could paginate the typeahead to harvest the whole workspace's email list. The
    substantive fix is dropping ``email`` from the payload + a per-user throttle.
    Defense in depth:

    - ``IsWorkspaceMember`` — a deactivated membership (or, once explicit
      memberships/multi-workspace land, a non-member) is denied. In a single-
      workspace OSS deploy every active account is an implicit member, so this is
      the semantically-correct gate rather than an added restriction today; and
    - a per-user 60/min throttle (``user_search`` scope) bounds bulk scraping.

    Returns an empty list when q is fewer than 2 characters.
    """

    permission_classes = [IsWorkspaceMember]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "user_search"

    @extend_schema(responses={200: UserSearchResultSerializer(many=True)})
    def get(self, request: Request) -> Response:
        q = (request.query_params.get("q") or "").strip()
        if len(q) < 2:
            return Response([])
        User = get_user_model()
        qs = User.objects.filter(
            Q(username__icontains=q) | Q(email__icontains=q),
            is_active=True,
        ).order_by("username")[:10]
        return Response(UserSearchResultSerializer(qs, many=True).data)


class MeView(McpReadableViewMixin, APIView):
    """GET /api/v1/auth/me/ — current user identity.

    Returns display name and initials derived from auth.User fields.
    No project context — role is project-scoped and available separately.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: MeSerializer})
    def get(self, request: Request) -> Response:
        return Response(MeSerializer(request.user).data)


class ProgramMembershipViewSet(IdempotencyMixin, viewsets.GenericViewSet[ProgramMembership]):
    """Nested CRUD for program memberships (ADR-0070).

    URL: ``/api/v1/programs/{program_pk}/members/``
         ``/api/v1/programs/{program_pk}/members/{pk}/``

    Permission matrix mirrors :class:`ProjectMembershipViewSet`:
      list/retrieve  — any program member (Viewer+)
      create         — Owner only; cannot assign role >= caller's own
      partial_update — Owner only; cannot assign role >= caller's own; last-Owner guard
      destroy        — Owner only for others; self-remove allowed; last-Owner guard
    """

    permission_classes = [IsAuthenticated, IsProgramMember, IsProgramNotClosed]

    def get_permissions(self) -> list[BasePermission]:
        """Express the Owner-only create gate at the permission layer (#1351).

        ``create`` is Owner-only, so IsProgramOwner is added as defense-in-depth
        over the in-body ``_require_actor_role(OWNER)`` check. ``partial_update``
        is deliberately excluded: a ``role_title``-only PATCH (benign descriptive
        metadata, #565) is permitted at Admin+, and the body already escalates to
        the Owner gate only when ``role``/``user`` change — gating the whole action
        on Owner here would regress that Admin metadata branch. ``destroy`` allows
        self-remove, so it is excluded too.
        """
        perms: list[BasePermission] = [
            IsAuthenticated(),
            IsProgramMember(),
            IsProgramNotClosed(),
        ]
        if self.action == "create":
            perms.append(IsProgramOwner())
        return perms

    def get_queryset(self) -> QuerySet[ProgramMembership]:
        program_pk = self.kwargs["program_pk"]
        return ProgramMembership.objects.select_related("program", "user").filter(
            program_id=program_pk, is_deleted=False
        )

    def get_serializer_class(self) -> type[BaseSerializer[ProgramMembership]]:
        if self.action in ("create", "partial_update", "update"):
            return ProgramMembershipWriteSerializer
        return ProgramMembershipReadSerializer

    def _get_program_or_404(self) -> Program:
        try:
            return Program.objects.get(pk=self.kwargs["program_pk"], is_deleted=False)
        except Program.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound("Program not found.") from err

    def _require_actor_role(self, request: Request, program_id: _PK, minimum: int) -> int:
        """Return the actor's program role, raising 403 if below minimum."""
        role = _program_membership_role(request, program_id)
        if role is None or role < minimum:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You do not have permission to perform this action.")
        return role

    def _check_last_owner_guard(self, program_id: _PK, exclude_pk: _PK | None = None) -> None:
        """Raise 422 if removing/demoting would leave the program with zero Owners."""
        qs = ProgramMembership.objects.filter(
            program_id=program_id, role=Role.OWNER, is_deleted=False
        )
        if exclude_pk:
            qs = qs.exclude(pk=exclude_pk)
        if not qs.select_for_update().exists():
            raise drf_serializers.ValidationError(
                {"detail": "Cannot remove or demote the last Owner of a program."}
            )

    # -----------------------------------------------------------------------
    # Actions
    # -----------------------------------------------------------------------

    def list(self, request: Request, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        # has_permission only checks authentication + membership-at-program-pk
        # for nested routes; the queryset filters by program_id, so an authenticated
        # non-member would see an empty list. Enforce explicitly to return 403.
        if _program_membership_role(request, program.pk) is None:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You must be a member of this program.")
        qs = self.get_queryset()
        # ?self=true: only the caller's own membership row — used by the frontend
        # useCurrentProgramRole() hook for tab-level RBAC.
        if request.query_params.get("self") == "true":
            user_pk = request.user.pk
            assert user_pk is not None
            qs = qs.filter(user_id=user_pk)
        serializer = ProgramMembershipReadSerializer(qs, many=True)
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        self._get_program_or_404()
        instance = self.get_object()
        return Response(ProgramMembershipReadSerializer(instance).data)

    def create(self, request: Request, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        self._require_actor_role(request, program.pk, Role.OWNER)

        serializer = ProgramMembershipWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        actor_role = _program_membership_role(request, program.pk)
        new_role = serializer.validated_data["role"]
        if actor_role is not None and new_role >= actor_role:
            raise drf_serializers.ValidationError(
                {"role": "You cannot assign a role equal to or higher than your own."}
            )

        user = serializer.validated_data["user"]
        if ProgramMembership.objects.filter(program=program, user=user, is_deleted=False).exists():
            return Response(
                {"detail": "User is already a member of this program."},
                status=status.HTTP_409_CONFLICT,
            )

        instance = serializer.save(program=program)
        return Response(
            ProgramMembershipReadSerializer(instance).data, status=status.HTTP_201_CREATED
        )

    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        instance = self.get_object()

        serializer = ProgramMembershipWriteSerializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        new_role = serializer.validated_data.get("role")
        new_user = serializer.validated_data.get("user")

        # Reassigning the access role or the member identity stays Owner-only (the
        # ADR-0070 matrix). The freeform role_title (#565) is benign descriptive
        # metadata — not enforced anywhere — so a role_title-only PATCH is allowed
        # at Admin+. A request that also touches role/user is privileged and falls
        # back to the Owner gate.
        privileged_change = new_role is not None or new_user is not None
        required_role = Role.OWNER if privileged_change else Role.ADMIN

        # Lock the actor's membership row inside an atomic block to close the
        # TOCTOU window where a concurrent demotion could let the actor assign
        # a role >= their effective role at save time.
        with transaction.atomic():
            try:
                actor_membership = ProgramMembership.objects.select_for_update().get(
                    program=program,
                    user=request.user,
                    is_deleted=False,  # type: ignore[misc]
                )
            except ProgramMembership.DoesNotExist:
                from rest_framework.exceptions import PermissionDenied

                raise PermissionDenied("You are not a member of this program.") from None

            actor_role = actor_membership.role
            if actor_role < required_role:
                from rest_framework.exceptions import PermissionDenied

                raise PermissionDenied("You do not have permission to perform this action.")

            if new_role is not None:
                if new_role >= actor_role:
                    raise drf_serializers.ValidationError(
                        {"role": "You cannot assign a role equal to or higher than your own."}
                    )
                if instance.role == Role.OWNER and new_role < Role.OWNER:
                    self._check_last_owner_guard(program.pk, exclude_pk=instance.pk)
                # Stamp role_changed_at only on an actual role change (#878) so a
                # no-op PATCH that re-sends the same role does not falsely advance
                # the per-program access-evidence timestamp.
                if new_role != instance.role:
                    serializer.save(role_changed_at=timezone.now())
                else:
                    serializer.save()
            else:
                serializer.save()

        return Response(ProgramMembershipReadSerializer(instance).data)

    def destroy(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        instance = self.get_object()

        is_self = instance.user == request.user

        if is_self:
            actor_role = _program_membership_role(request, program.pk)
            if actor_role is None:
                from rest_framework.exceptions import PermissionDenied

                raise PermissionDenied("You are not a member of this program.")
        else:
            actor_role = self._require_actor_role(request, program.pk, Role.OWNER)
            if instance.role >= actor_role:
                raise drf_serializers.ValidationError(
                    {"detail": "You can only remove members with a role lower than your own."}
                )

        if instance.role == Role.OWNER:
            with transaction.atomic():
                self._check_last_owner_guard(program.pk, exclude_pk=instance.pk)
                instance.soft_delete()
        else:
            instance.soft_delete()

        return Response(status=status.HTTP_204_NO_CONTENT)
