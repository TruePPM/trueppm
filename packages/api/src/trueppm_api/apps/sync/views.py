"""REST views for the sync app — offline delta pull endpoint."""

from __future__ import annotations

from functools import partial
from typing import TYPE_CHECKING, Any, cast

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle, ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import _membership_role
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.integrations.models import TaskLink
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
    TaskRecurrenceRule,
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
    SyncTaskLinkSerializer,
    SyncTaskRecurrenceRuleSerializer,
    SyncTaskSerializer,
    SyncTaskSuggestedAssigneeSerializer,
    SyncTimeEntrySerializer,
    SyncUploadRequestSerializer,
)
from trueppm_api.apps.sync.ws_auth import TICKET_TTL_SECONDS, issue_ticket
from trueppm_api.apps.timetracking.models import TimeEntry

if TYPE_CHECKING:
    from django.contrib.auth.models import User as _User


class WebSocketTicketView(IdempotencyMixin, APIView):
    """Mint a short-lived, single-use ticket for the WebSocket handshake (ADR-0141).

    Browsers cannot set an ``Authorization`` header on a WebSocket upgrade, so the
    credential must ride in the URL. A raw JWT there leaks into every access log
    (#818); a ticket that is single-use and expires in
    :data:`~trueppm_api.apps.sync.ws_auth.TICKET_TTL_SECONDS` seconds is useless
    once logged. The client POSTs here, then opens the socket with ``?ticket=``.

    Authentication only — authorization (project membership/role) is enforced by
    the consumer on connect. No project scope is required to mint a ticket.
    """

    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "ws_ticket"
    # Stateless mint — the generic Idempotency-Key path adds nothing.
    idempotency_exempt = True

    @extend_schema(
        responses={
            200: OpenApiTypes.OBJECT,
        },
        description="Issue a single-use WebSocket connection ticket (ADR-0141).",
    )
    def post(self, request: Request) -> Response:
        ticket = issue_ticket(str(request.user.pk))
        return Response({"ticket": ticket, "expires_in": TICKET_TTL_SECONDS})


class ProjectSyncView(IdempotencyMixin, APIView):
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

    # Exempt from the generic Idempotency-Key path (ADR-0170): the upload POST is already
    # idempotent by client_batch_id (SyncBatch dedup, ADR-0082); the generic header would
    # be redundant and the sync protocol uses its own batch id.
    idempotency_exempt = True
    permission_classes = [IsAuthenticated]

    @extend_schema(
        summary="Pull the offline sync delta for a project",
        parameters=[
            OpenApiParameter(
                name="since",
                type=OpenApiTypes.INT,
                location=OpenApiParameter.QUERY,
                required=False,
                default=0,
                description=(
                    "WatermelonDB high-water mark. Returns only rows whose "
                    "`server_version` is strictly greater than this value. Omit "
                    "(or pass `0`) for a full initial sync; passing the previous "
                    "response's `timestamp` fetches just the delta since then. "
                    "Omitting it silently triggers a full re-sync."
                ),
            ),
        ],
    )
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
        timestamp = self._watermark(project)

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
                # Same-project edges only. Cross-project edges (ADR-0120) are
                # deliberately excluded from the single-project offline delta:
                # their successor task lives in a project this client may not have
                # synced, and the offline WASM recompute is single-project. Offline
                # cross-project scheduling arrives with the program-sync slice
                # (D3/D4); until then the sync payload stays byte-identical to the
                # pre-cross-project behaviour.
                Dependency.objects.filter(
                    predecessor__project=project,
                    successor__project=project,
                    server_version__gt=since,
                ).select_related("predecessor"),
                SyncDependencySerializer,
            ),
            "calendars": self._collect(
                # prefetch_related("exceptions") feeds the nested read-only
                # exceptions array on SyncCalendarSerializer (ADR-0193) without a
                # per-calendar lazy load — parity with CalendarViewSet and
                # N+1-safe for the future program-sync multi-calendar slice.
                Calendar.objects.filter(
                    pk=project.calendar_id, server_version__gt=since
                ).prefetch_related("exceptions")
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
            "task_links": self._collect(
                TaskLink.objects.filter(task__project=project, server_version__gt=since),
                SyncTaskLinkSerializer,
            ),
            "task_recurrence_rules": self._collect(
                TaskRecurrenceRule.objects.filter(
                    task__project=project, server_version__gt=since
                ).select_related("task"),
                SyncTaskRecurrenceRuleSerializer,
            ),
            # Time entries are scoped to the CALLER's own rows (ADR-0185 §6): the
            # per-project delta never leaks a colleague's entries, mirroring the
            # /me/ REST surface's non-surveillance discipline. A soft-deleted entry
            # yields a tombstone through the standard _collect path.
            "time_entries": self._collect(
                TimeEntry.objects.filter(
                    task__project=project,
                    user=cast("_User", request.user),
                    server_version__gt=since,
                ).select_related("task"),
                SyncTimeEntrySerializer,
            ),
        }

        return Response({"changes": changes, "timestamp": timestamp})

    def get_throttles(self) -> list[BaseThrottle]:
        """Throttle the write (POST) path only; pull (GET) stays unthrottled."""
        if self.request.method == "POST":
            from trueppm_api.apps.sync.throttles import SyncUploadThrottle

            return [SyncUploadThrottle()]
        return []

    @extend_schema(
        request=SyncUploadRequestSerializer,
        responses={
            200: OpenApiTypes.OBJECT,
            409: OpenApiTypes.OBJECT,
        },
        description=(
            "Upload a WatermelonDB delta batch. Carries a client_batch_id for "
            "all-or-nothing, idempotent replay (ADR-0082)."
        ),
    )
    def post(self, request: Request, pk: str) -> Response:
        """Upload a WatermelonDB delta batch with transactional atomicity (ADR-0082).

        The batch carries a client-generated ``client_batch_id``. The first
        request to win the unique-constraint race applies the delta and records
        the batch + its response in one atomic transaction (all-or-nothing); a
        retry carrying the same id within the freshness window replays the stored
        response without re-applying. See ADR-0082 §D for the full algorithm.
        """
        from trueppm_api.apps.access.models import Role
        from trueppm_api.apps.sync.models import SyncBatch, SyncBatchStatus

        envelope = SyncUploadRequestSerializer(data=request.data)
        envelope.is_valid(raise_exception=True)
        client_batch_id = envelope.validated_data["client_batch_id"]
        changes = envelope.validated_data["changes"]

        try:
            project = Project.objects.get(pk=pk, is_deleted=False)
        except Project.DoesNotExist as err:
            raise NotFound("Project not found.") from err

        # RBAC: only project members with a write role may push. Per-row
        # ownership (Member edits own tasks; Scheduler cannot edit content) is
        # enforced inside apply_task_changes, mirroring IsProjectMemberWriteOrOwn.
        role = _membership_role(request, project.pk)
        if role is None:
            raise PermissionDenied("You must be a member of this project.")
        if role < Role.MEMBER:
            raise PermissionDenied("You need at least Team Member role to upload changes.")

        # Archived projects are hard read-only (#530) — mirror IsProjectNotArchived,
        # which gates every REST write. Without this, the upload path would be a
        # back-channel to mutate an archived project.
        if project.is_archived:
            raise PermissionDenied(
                "This project is archived and cannot be modified. Unarchive it first."
            )

        ttl = getattr(settings, "TRUEPPM_SYNC_BATCH_RETENTION_HOURS", 24)

        # Fast path: a fresh, completed duplicate replays its stored response.
        # Scoped to (project, actor) so a member can never replay another
        # project's — or another *user's* — batch by reusing its client_batch_id.
        # The stored response carries that actor's task ids, server_versions, and
        # watermark; cross-actor replay would leak it (#894, #887 IDOR guard).
        existing = SyncBatch.objects.filter(  # type: ignore[misc]
            project=project, actor_user=request.user, client_batch_id=client_batch_id
        ).first()
        if (
            existing is not None
            and existing.status == SyncBatchStatus.COMPLETED
            and existing.is_fresh(ttl_hours=ttl)
        ):
            return Response(existing.response_body, status=existing.response_status)

        try:
            return self._apply_and_record(request, project, role, client_batch_id, changes)
        except IntegrityError:
            # A concurrent duplicate committed between our check and create, or a
            # stale row exists. Re-fetch (project + actor-scoped) and resolve.
            existing = SyncBatch.objects.filter(  # type: ignore[misc]
                project=project, actor_user=request.user, client_batch_id=client_batch_id
            ).first()
            if existing is None:
                raise  # genuinely unexpected — surface it
            if existing.is_fresh(ttl_hours=ttl):
                if existing.status == SyncBatchStatus.COMPLETED:
                    return Response(existing.response_body, status=existing.response_status)
                # Fresh but still pending: a true concurrent race whose winner has
                # not committed yet. Ask the client to retry — the next attempt
                # hits the fast-path replay.
                return Response(
                    {"detail": "This batch is already being processed; retry shortly."},
                    status=status.HTTP_409_CONFLICT,
                )
            # Expired row is blocking a re-run: drop it and apply once more. After
            # the freshness window the same client_batch_id is allowed to re-run.
            existing.delete()
            return self._apply_and_record(request, project, role, client_batch_id, changes)

    def _apply_and_record(
        self,
        request: Request,
        project: Project,
        role: int,
        client_batch_id: Any,
        changes: dict[str, Any],
    ) -> Response:
        """Apply the delta and snapshot the response inside one atomic batch.

        The SyncBatch row is the **first** write so the unique constraint
        serializes concurrent duplicates. Any failure (RBAC, validation, DB)
        rolls back the row writes *and* the batch row together — nothing commits,
        and the client re-uploads the whole batch under the same id.
        """
        from trueppm_api.apps.scheduling.services import enqueue_recalculate
        from trueppm_api.apps.sync.broadcast import broadcast_board_event
        from trueppm_api.apps.sync.models import SyncBatch, SyncBatchStatus
        from trueppm_api.apps.sync.upload import apply_task_changes

        with transaction.atomic():
            batch = SyncBatch.objects.create(
                client_batch_id=client_batch_id,
                project=project,
                actor_user=request.user,  # type: ignore[misc]
                status=SyncBatchStatus.PENDING,
            )
            applied = apply_task_changes(
                project=project, request=request, role=role, changes=changes
            )
            body = {
                "client_batch_id": str(client_batch_id),
                "applied": {
                    "tasks": {
                        "created": applied.created,
                        "updated": applied.updated,
                        "deleted": applied.deleted,
                    }
                },
                "timestamp": applied.max_version,
            }
            batch.status = SyncBatchStatus.COMPLETED
            batch.response_body = body
            batch.response_status = status.HTTP_200_OK
            batch.save(update_fields=["status", "response_body", "response_status"])

            # Side effects on commit, mirroring single-row writes (inbound_sync):
            # one coalesced CPM recalc + one coalesced board event, so web clients
            # react and a rolled-back batch broadcasts nothing.
            #
            # A delta batch can carry up to TRUEPPM_SYNC_BATCH_MAX_ROWS (500) rows.
            # Emitting one broadcast per applied row (the previous behavior) issued
            # up to 500 async_to_sync(group_send) round-trips at commit on a single
            # upload — under a reconnect storm this overflowed the channel-layer
            # inbox and dropped presence/CPM events (#809). Coalesce into a single
            # tasks_bulk_mutated event (same pattern as sprint-close carry-over,
            # projects/tasks.py); the web handler invalidates the whole task query
            # on it, so per-row granularity is not needed.
            project_id = str(project.pk)
            if applied.changed:
                transaction.on_commit(partial(enqueue_recalculate, project_id))
            mutated_ids = [task_id for _event_type, task_id in applied.events]
            if mutated_ids:
                # default-arg binding (not closure capture) so a future branch
                # can't late-bind the ids — matches the carry-over pattern.
                def _broadcast_bulk(pid: str = project_id, ids: list[str] = mutated_ids) -> None:
                    broadcast_board_event(pid, "tasks_bulk_mutated", {"task_ids": ids})

                transaction.on_commit(_broadcast_bulk)

        return Response(body, status=status.HTTP_200_OK)

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

    @classmethod
    def _watermark(cls, project: Project) -> int:
        """Return the sync high-water mark for ``project`` (ADR-0142, #822).

        Reads the denormalized ``Project.last_sync_version`` column, maintained by
        the watermark receivers (``apps/sync/receivers.py``) to equal
        :meth:`_snapshot_max_version`. The 13-table union is kept as a one-release
        fallback behind ``settings.SYNC_WATERMARK_USE_COLUMN`` (default ``True``)
        in case a drift bug is found in production; a conformance test asserts the
        two agree.
        """
        if settings.SYNC_WATERMARK_USE_COLUMN:
            return int(project.last_sync_version)
        return cls._snapshot_max_version(project)

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
                    UNION ALL
                    SELECT MAX(tl.server_version)
                      FROM integrations_tasklink tl
                      JOIN projects_task t ON tl.task_id = t.id
                     WHERE t.project_id = %s
                    UNION ALL
                    SELECT MAX(rr.server_version)
                      FROM projects_taskrecurrencerule rr
                      JOIN projects_task t ON rr.task_id = t.id
                     WHERE t.project_id = %s
                    UNION ALL
                    SELECT MAX(te.server_version)
                      FROM timetracking_time_entry te
                      JOIN projects_task t ON te.task_id = t.id
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
                    project_pk,
                    project_pk,
                    project_pk,
                ],
            )
            result = cursor.fetchone()
        return int(result[0]) if result and result[0] is not None else 0
