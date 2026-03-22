"""Views for the scheduling app."""

from __future__ import annotations

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from trueppm_api.apps.access.permissions import IsProjectScheduler
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.scheduling.tasks import recalculate_schedule


@api_view(["POST"])
@permission_classes([IsAuthenticated, IsProjectScheduler])
def trigger_schedule(request: Request, pk: str) -> Response:
    """Manually trigger a CPM recalculation for a project.

    Requires the requesting user to hold at least the Scheduler role on the
    project. The task is enqueued asynchronously; the caller receives the
    Celery task_id for status polling.

    Returns 404 if the project does not exist.
    """
    try:
        project = Project.objects.get(pk=pk)
    except Project.DoesNotExist:
        return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

    # Permission check against the project object.
    if not IsProjectScheduler().has_object_permission(request, None, project):  # type: ignore[arg-type]
        return Response({"detail": "Permission denied."}, status=status.HTTP_403_FORBIDDEN)

    result = recalculate_schedule.delay(str(project.pk))
    return Response({"task_id": result.id}, status=status.HTTP_202_ACCEPTED)
