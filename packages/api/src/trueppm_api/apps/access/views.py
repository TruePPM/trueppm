"""ViewSets for the access app."""

from __future__ import annotations

import uuid

from django.db import transaction
from django.db.models import QuerySet
from rest_framework import serializers as drf_serializers
from rest_framework import status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import IsProjectMember, _membership_role
from trueppm_api.apps.access.serializers import (
    ProjectMembershipReadSerializer,
    ProjectMembershipWriteSerializer,
)
from trueppm_api.apps.projects.models import Project

_PK = str | uuid.UUID


class ProjectMembershipViewSet(viewsets.GenericViewSet[ProjectMembership]):
    """Nested CRUD for project memberships.

    URL: /api/v1/projects/{project_pk}/members/
         /api/v1/projects/{project_pk}/members/{pk}/

    Permission matrix:
      list/retrieve  — any project member (Viewer+)
      create         — Owner only (role=4)
      partial_update — Owner only; caller may not assign role >= their own
      destroy        — Owner only for others; any member may self-remove
                       (last-Owner guard prevents stranding a project)
    """

    permission_classes = [IsAuthenticated, IsProjectMember]

    def get_queryset(self) -> QuerySet[ProjectMembership]:
        project_pk = self.kwargs["project_pk"]
        return ProjectMembership.objects.select_related("project", "user").filter(
            project_id=project_pk, is_deleted=False
        )

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
            qs = qs.filter(user=request.user)
        serializer = ProjectMembershipReadSerializer(qs, many=True)
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        self._get_project_or_404()
        instance = self.get_object()
        return Response(ProjectMembershipReadSerializer(instance).data)

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
