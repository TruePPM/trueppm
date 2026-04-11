"""Views for task run progress tracking API."""

from __future__ import annotations

import redis as redis_lib
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.viewsets import GenericViewSet, ReadOnlyModelViewSet

from trueppm_api.apps.access.permissions import IsProjectAdmin, IsProjectMember
from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus
from trueppm_api.apps.taskruns.serializers import TaskRunSerializer


class ProjectTaskRunViewSet(ListModelMixin, RetrieveModelMixin, GenericViewSet):
    """List and retrieve TaskRuns scoped to a project.

    List/retrieve: Viewer+ (IsProjectMember).
    Cancel: Admin+ (IsProjectAdmin).
    """

    serializer_class = TaskRunSerializer

    def get_permissions(self) -> list:
        if self.action == "cancel":
            return [IsAuthenticated(), IsProjectAdmin()]
        return [IsAuthenticated(), IsProjectMember()]

    def get_queryset(self) -> object:
        project_pk = self.kwargs["project_pk"]
        return TaskRun.objects.filter(project_id=project_pk)

    def get_object(self) -> TaskRun:
        obj = super().get_object()
        self.check_object_permissions(self.request, obj.project)
        return obj

    @action(detail=True, methods=["post"], url_path="cancel")
    def cancel(self, request: Request, **kwargs: object) -> Response:
        """Signal cancellation for a running task."""
        task_run = self.get_object()

        if task_run.status not in (TaskRunStatus.PENDING, TaskRunStatus.RUNNING):
            return Response(
                {"detail": "Task run is not active."},
                status=status.HTTP_409_CONFLICT,
            )

        from django.conf import settings

        from trueppm_api.apps.taskruns.tracker import _CANCEL_KEY, _CANCEL_TTL

        try:
            r = redis_lib.from_url(settings.REDIS_URL, decode_responses=True)
            cancel_key = _CANCEL_KEY.format(task_run_id=str(task_run.pk))
            r.set(cancel_key, "1", ex=_CANCEL_TTL)
        except Exception:
            pass  # Best-effort; tracker will also check on next update

        # Also revoke the Celery task to interrupt it if it hasn't started yet.
        if task_run.celery_task_id:
            try:
                from celery import current_app

                current_app.control.revoke(task_run.celery_task_id, terminate=False)
            except Exception:
                pass

        return Response({"detail": "Cancellation requested."}, status=status.HTTP_202_ACCEPTED)


class GlobalTaskRunViewSet(ReadOnlyModelViewSet):
    """Global task run access — detail by UUID and active runs across projects.

    Active runs are scoped to projects where the requesting user is a member.
    This is a personal in-flight view, not a PMO rollup.
    """

    serializer_class = TaskRunSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self) -> object:
        user = self.request.user
        # Scope to projects the user is a member of.
        from trueppm_api.apps.access.models import ProjectMembership

        project_ids = ProjectMembership.objects.filter(user=user).values_list(
            "project_id", flat=True
        )
        return TaskRun.objects.filter(project_id__in=project_ids)

    @action(detail=False, methods=["get"], url_path="active")
    def active(self, request: Request) -> Response:
        """Return PENDING + RUNNING task runs across the user's projects."""
        qs = self.get_queryset().filter(status__in=[TaskRunStatus.PENDING, TaskRunStatus.RUNNING])
        serializer = self.get_serializer(qs, many=True)
        return Response(serializer.data)
