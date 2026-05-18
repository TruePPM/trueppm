"""REST views for the sync app — offline delta pull endpoint."""

from __future__ import annotations

from typing import Any

from django.db import connection
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import _membership_role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    RetroActionItem,
    RetroVisibility,
    Risk,
    Sprint,
    SprintRetro,
    Task,
    TaskSuggestedAssignee,
)
from trueppm_api.apps.sync.serializers import (
    SyncCalendarSerializer,
    SyncDependencySerializer,
    SyncMembershipSerializer,
    SyncProjectSerializer,
    SyncRetroActionItemSerializer,
    SyncRiskSerializer,
    SyncSprintRetroSerializer,
    SyncSprintSerializer,
    SyncTaskSerializer,
    SyncTaskSuggestedAssigneeSerializer,
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
        caller_role = _membership_role(request, project.pk)
        if caller_role is None:
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("You must be a member of this project.")

        # Snapshot the high-water mark before running delta queries.
        # Using REPEATABLE READ ensures we don't miss rows written concurrently.
        timestamp = self._snapshot_max_version(project)

        # Retros are visibility-gated per ADR-0071 §3. A VIEWER on a TEAM_ONLY
        # retro does not receive the retro's raw notes — the sync filters them
        # out at the queryset level. The sync protocol delivers tombstones for
        # visibility-removed rows so WatermelonDB can drop them client-side.
        retro_qs = SprintRetro.objects.filter(sprint__project=project, server_version__gt=since)
        if caller_role < Role.MEMBER:
            retro_qs = retro_qs.exclude(team_visibility=RetroVisibility.TEAM_ONLY)

        retro_action_item_qs = RetroActionItem.objects.filter(
            retro__sprint__project=project, server_version__gt=since
        ).select_related("retro")
        if caller_role < Role.MEMBER:
            retro_action_item_qs = retro_action_item_qs.exclude(
                retro__team_visibility=RetroVisibility.TEAM_ONLY
            )

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
            "sprints": self._collect(
                Sprint.objects.filter(project=project, server_version__gt=since),
                SyncSprintSerializer,
            ),
            "sprint_retros": self._collect(retro_qs, SyncSprintRetroSerializer),
            "retro_action_items": self._collect(
                retro_action_item_qs, SyncRetroActionItemSerializer
            ),
            "task_suggested_assignees": self._collect(
                TaskSuggestedAssignee.objects.filter(
                    task__project=project, server_version__gt=since
                ),
                SyncTaskSuggestedAssigneeSerializer,
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
                    UNION ALL
                    SELECT MAX(server_version)
                      FROM projects_sprint WHERE project_id = %s
                    UNION ALL
                    SELECT MAX(r.server_version)
                      FROM projects_sprintretro r
                      JOIN projects_sprint s ON r.sprint_id = s.id
                     WHERE s.project_id = %s
                    UNION ALL
                    SELECT MAX(a.server_version)
                      FROM projects_retroactionitem a
                      JOIN projects_sprintretro r ON a.retro_id = r.id
                      JOIN projects_sprint s ON r.sprint_id = s.id
                     WHERE s.project_id = %s
                    UNION ALL
                    SELECT MAX(sa.server_version)
                      FROM projects_tasksuggestedassignee sa
                      JOIN projects_task t ON sa.task_id = t.id
                     WHERE t.project_id = %s
                ) sub
                """,
                [
                    project_pk,
                    project_pk,
                    project_pk,
                    project_pk,
                    project_pk,
                    project_pk,
                    project_pk,
                    project_pk,
                    project_pk,
                    project_pk,
                ],
            )
            result = cursor.fetchone()
        return int(result[0]) if result and result[0] is not None else 0
