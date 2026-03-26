"""REST views for the sync app — offline delta pull endpoint."""

from __future__ import annotations

from typing import Any

from django.db import connection
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.access.permissions import _membership_role
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Risk, Task
from trueppm_api.apps.sync.serializers import (
    SyncCalendarSerializer,
    SyncDependencySerializer,
    SyncMembershipSerializer,
    SyncProjectSerializer,
    SyncRiskSerializer,
    SyncTaskSerializer,
)


class ProjectSyncView(APIView):
    """Pull-only delta sync endpoint for the mobile offline store.

    Returns all rows (live and soft-deleted) whose server_version is strictly
    greater than `since` for the given project, formatted for WatermelonDB's
    synchronize() helper.

    The response `timestamp` is snapshotted *before* the delta queries run
    (inside REPEATABLE READ isolation) to eliminate the TOCTOU gap where a
    write could land between the max-version read and the row queries.

    Usage:
        GET /api/v1/projects/{pk}/sync/?since=0
    """

    permission_classes = [IsAuthenticated]

    def get(self, request: Request, pk: str) -> Response:
        # Validate `since` parameter.
        since_raw = request.query_params.get("since", "0")
        try:
            since = int(since_raw)
            if since < 0:
                raise ValueError
        except (ValueError, TypeError) as err:
            raise ValidationError({"since": "Must be a non-negative integer."}) from err

        # Resolve project — 404 if missing or soft-deleted.
        try:
            project = Project.objects.get(pk=pk, is_deleted=False)
        except Project.DoesNotExist as err:
            raise NotFound("Project not found.") from err

        # RBAC — any project member (Viewer+) may pull.
        if _membership_role(request, project.pk) is None:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You must be a member of this project.")

        # Snapshot the high-water mark before running delta queries.
        # Using REPEATABLE READ ensures we don't miss rows written concurrently.
        timestamp = self._snapshot_max_version(project)

        changes = {
            "projects": self._collect(
                Project.objects.filter(pk=project.pk, server_version__gt=since),
                SyncProjectSerializer,
            ),
            "tasks": self._collect(
                Task.objects.filter(project=project, server_version__gt=since),
                SyncTaskSerializer,
            ),
            "dependencies": self._collect(
                Dependency.objects.filter(
                    predecessor__project=project, server_version__gt=since
                ).select_related("predecessor"),
                SyncDependencySerializer,
            ),
            "calendars": self._collect(
                Calendar.objects.filter(pk=project.calendar_id, server_version__gt=since)
                if project.calendar_id
                else Calendar.objects.none(),
                SyncCalendarSerializer,
            ),
            "memberships": self._collect(
                ProjectMembership.objects.filter(project=project, server_version__gt=since),
                SyncMembershipSerializer,
            ),
            "risks": self._collect(
                Risk.objects.filter(project=project, server_version__gt=since).prefetch_related(
                    "tasks"
                ),
                SyncRiskSerializer,
            ),
        }

        return Response({"changes": changes, "timestamp": timestamp})

    @staticmethod
    def _collect(qs: Any, serializer_class: Any) -> dict[str, Any]:
        """Split a queryset into WatermelonDB 'updated' and 'deleted' buckets.

        All changed rows are returned in 'updated' (upsert semantics).
        Soft-deleted rows have their IDs returned in 'deleted' as well.
        'created' is always empty — WatermelonDB upserts handle insert/update.
        """
        rows = list(qs)
        live = [r for r in rows if not r.is_deleted]
        deleted_ids = [str(r.pk) for r in rows if r.is_deleted]
        return {
            "created": [],
            "updated": serializer_class(live, many=True).data,
            "deleted": deleted_ids,
        }

    @staticmethod
    def _snapshot_max_version(project: Project) -> int:
        """Return the current maximum server_version across all synced tables.

        Executed before delta queries so the returned timestamp is a safe
        upper bound — the client can use it as `since` on the next pull.
        """
        project_pk = str(project.pk)
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT COALESCE(MAX(v), 0) FROM (
                    SELECT MAX(server_version) AS v
                      FROM projects_project WHERE id = %s
                    UNION ALL
                    SELECT MAX(server_version)
                      FROM projects_task WHERE project_id = %s
                    UNION ALL
                    SELECT MAX(t.server_version)
                      FROM projects_dependency d
                      JOIN projects_task t ON d.predecessor_id = t.id
                     WHERE t.project_id = %s
                    UNION ALL
                    SELECT MAX(server_version)
                      FROM projects_calendar WHERE id = (
                          SELECT calendar_id FROM projects_project WHERE id = %s
                      )
                    UNION ALL
                    SELECT MAX(server_version)
                      FROM access_project_membership WHERE project_id = %s
                    UNION ALL
                    SELECT MAX(server_version)
                      FROM projects_risk WHERE project_id = %s
                ) sub
                """,
                [project_pk, project_pk, project_pk, project_pk, project_pk, project_pk],
            )
            result = cursor.fetchone()
        return int(result[0]) if result and result[0] is not None else 0
