"""Serializers for the sync pull endpoint.

Sync serializers always include server_version and is_deleted so mobile
clients can track changes precisely. They are intentionally separate from
the CRUD serializers — their contract is with the mobile offline store,
not the REST API consumer.
"""

from __future__ import annotations

from rest_framework import serializers

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership
from trueppm_api.apps.integrations.models import TaskLink
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Program,
    Project,
    RetroActionItem,
    Risk,
    Sprint,
    SprintRetro,
    Task,
    TaskRecurrenceRule,
    TaskSuggestedAssignee,
)
from trueppm_api.apps.projects.serializers import CalendarExceptionSerializer
from trueppm_api.apps.timetracking.models import TimeEntry


class SyncCalendarSerializer(serializers.ModelSerializer[Calendar]):
    """Sync payload for Calendar. Exceptions ride the aggregate root (ADR-0193).

    Exceptions are nested read-only rather than given their own sync collection:
    they have no server_version of their own, and every exception write bumps the
    parent Calendar.server_version, so a client that pulls the changed calendar
    delta receives the full, current exception set inline. Critical-path math is
    therefore holiday-aware offline.
    """

    exceptions = CalendarExceptionSerializer(many=True, read_only=True)

    class Meta:
        model = Calendar
        fields = [
            "id",
            "server_version",
            "name",
            "working_days",
            "hours_per_day",
            "timezone",
            "exceptions",
        ]


class SyncProjectSerializer(serializers.ModelSerializer[Project]):
    """Sync payload for Project — minimal shape consumed by the WatermelonDB Project table.

    ``program`` (ADR-0070) is included so mobile can render the program badge
    on project rows offline. Program and ProgramMembership tables themselves
    are not yet wired into mobile sync — the existing endpoint is project-scoped
    and cannot reach user-scoped Program rows. Mobile-side Program sync is
    tracked as a follow-up; for now mobile uses the REST endpoints online and
    falls back to the cached project rows (with their ``program`` FK) offline.
    """

    class Meta:
        model = Project
        fields = [
            "id",
            "server_version",
            "name",
            "description",
            "start_date",
            "calendar",
            "program",
        ]


class SyncTaskSerializer(serializers.ModelSerializer[Task]):
    """Sync payload for Task — full CPM and baseline fields for offline scheduling previews."""

    class Meta:
        model = Task
        fields = [
            "id",
            "server_version",
            "short_id",
            "project",
            "name",
            "wbs_path",
            "status",
            "duration",
            "percent_complete",
            "notes",
            "planned_start",
            "early_start",
            "early_finish",
            "late_start",
            "late_finish",
            "total_float",
            "free_float",
            "is_critical",
            "is_milestone",
            "actual_start",
            "actual_finish",
            "optimistic_duration",
            "most_likely_duration",
            "pessimistic_duration",
            "is_subtask",
            "sprint",
            "assignee",
        ]


class SyncDependencySerializer(serializers.ModelSerializer[Dependency]):
    """Sync payload for Dependency links — includes server_version for delta tracking."""

    class Meta:
        model = Dependency
        fields = ["id", "server_version", "predecessor", "successor", "dep_type", "lag"]


class SyncMembershipSerializer(serializers.ModelSerializer[ProjectMembership]):
    """Sync payload for ProjectMembership — lets mobile clients enforce offline RBAC."""

    class Meta:
        model = ProjectMembership
        fields = ["id", "server_version", "project", "user", "role"]


class SyncProgramSerializer(serializers.ModelSerializer[Program]):
    """Sync payload for Program (ADR-0070 §Sync, #561).

    Minimal shape the offline store needs to render the program list card and
    header when the device has no signal: name/description/code/methodology plus
    the display accents (health, color, target_date, lead). Rollup KPIs, sharing
    overrides, and ceremony config are intentionally excluded — they are online-
    only surfaces. Delivered by the user-scoped :class:`UserProgramSyncView`, the
    endpoint ADR-0070 §Sync flagged as the 0.4 follow-up.
    """

    class Meta:
        model = Program
        fields = [
            "id",
            "server_version",
            "name",
            "description",
            "code",
            "methodology",
            "health",
            "color",
            "target_date",
            "lead",
        ]


class SyncProgramMembershipSerializer(serializers.ModelSerializer[ProgramMembership]):
    """Sync payload for ProgramMembership — lets clients enforce offline program RBAC.

    Mirrors :class:`SyncMembershipSerializer` (project membership) exactly: only
    ``(program, user, role)`` plus the sync bookkeeping fields. The User table is
    not synced, so ``user`` is the FK id — the client resolves display names from
    its own cached roster, identical to the project-membership sync behaviour.
    """

    class Meta:
        model = ProgramMembership
        fields = ["id", "server_version", "program", "user", "role"]


class SyncSprintSerializer(serializers.ModelSerializer[Sprint]):
    """Sync payload for Sprint — enables offline sprint context for retros (ADR-0071)."""

    class Meta:
        model = Sprint
        fields = [
            "id",
            "server_version",
            "short_id",
            "project",
            "name",
            "goal",
            "start_date",
            "finish_date",
            "state",
        ]


class SyncSprintRetroSerializer(serializers.ModelSerializer[SprintRetro]):
    """Sync payload for SprintRetro (ADR-0071).

    Mobile receives the raw notes only when the caller's role meets the
    retro's team_visibility threshold; the sync view is responsible for
    filtering retros the caller cannot see. WatermelonDB stores what it
    receives — the server-side visibility gate is the only check.
    """

    class Meta:
        model = SprintRetro
        fields = [
            "id",
            "server_version",
            "sprint",
            "notes",
            "team_visibility",
            "created_by",
            "created_at",
            "updated_at",
        ]


class SyncRetroActionItemSerializer(serializers.ModelSerializer[RetroActionItem]):
    """Sync payload for RetroActionItem (ADR-0071)."""

    class Meta:
        model = RetroActionItem
        fields = [
            "id",
            "server_version",
            "retro",
            "text",
            "assignee",
            "story_points",
            "promoted_task_id",
            "created_at",
        ]


class SyncTaskSuggestedAssigneeSerializer(serializers.ModelSerializer[TaskSuggestedAssignee]):
    """Sync payload for TaskSuggestedAssignee (ADR-0071 §5)."""

    class Meta:
        model = TaskSuggestedAssignee
        fields = [
            "id",
            "server_version",
            "task",
            "suggested_user",
            "suggested_by",
            "reason",
            "source",
            "state",
            "created_at",
            "accepted_at",
            "declined_at",
        ]


class SyncTaskLinkSerializer(serializers.ModelSerializer[TaskLink]):
    """Sync payload for TaskLink (ADR-0049 §3, #637) — links on a task.

    Carries the cloud-file preview cache (#571, ADR-0163) so the preview card
    renders offline on the mobile client straight from the sync delta.
    """

    class Meta:
        model = TaskLink
        fields = [
            "id",
            "server_version",
            "task",
            "url",
            "provider",
            "title",
            "custom_title",
            "labels",
            "status",
            "fetched_at",
            "description",
            "thumbnail_url",
            "preview_type",
            "display_order",
        ]


class SyncTaskRecurrenceRuleSerializer(serializers.ModelSerializer[TaskRecurrenceRule]):
    """Sync payload for TaskRecurrenceRule (ADR-0090).

    Omits the internal ``generated_through`` cursor — mobile clients recompute the
    occurrence preview from the rule fields and never need the server-side cursor.
    """

    class Meta:
        model = TaskRecurrenceRule
        fields = [
            "id",
            "server_version",
            "task",
            "frequency",
            "interval",
            "weekdays",
            "day_of_month",
            "time_of_day",
            "timezone",
            "end_type",
            "end_date",
            "end_count",
            "inherit_assignee",
            "inherit_subtasks",
            "inherit_attachments",
            "inherit_morning_notification",
        ]


class SyncRiskSerializer(serializers.ModelSerializer[Risk]):
    """Sync serializer for the Risk model.

    task_ids is serialized as a flat list of task UUIDs (string) rather than
    a nested M2M sync table. Expected cardinality is 1–10 tasks per risk, so
    a JSON column on the WatermelonDB Risk record is simpler and sufficient.
    The queryset in ProjectSyncView prefetches tasks to avoid N+1.
    """

    task_ids = serializers.SerializerMethodField()

    def get_task_ids(self, obj: Risk) -> list[str]:
        # Iterate the prefetched cache; values_list() bypasses it and fires an extra SELECT.
        return [str(t.pk) for t in obj.tasks.all()]

    class Meta:
        model = Risk
        fields = [
            "id",
            "server_version",
            "short_id",
            "project",
            "title",
            "description",
            "status",
            "probability",
            "impact",
            "owner",
            "task_ids",
        ]


class SyncTimeEntrySerializer(serializers.ModelSerializer[TimeEntry]):
    """Sync payload for TimeEntry (ADR-0185 §6).

    The per-project delta is filtered to ``user=request.user`` in ``ProjectSyncView``,
    so a client only ever receives its **own** entries — the same non-surveillance
    discipline as the REST surface (a Member never pulls a colleague's entries). Soft-
    deleted rows ride the standard tombstone path. ``ActiveTimer`` is deliberately not
    synced (transient/derived; recovered via ``GET /me/timer/``).
    """

    class Meta:
        model = TimeEntry
        fields = [
            "id",
            "server_version",
            "task",
            "user",
            "minutes",
            "entry_date",
            "note",
            "source",
            "created_at",
        ]


# ---------------------------------------------------------------------------
# Pull (GET) response envelope — documents the paginated delta shape (#1013).
# ---------------------------------------------------------------------------


class SyncPullResponseSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Response envelope for the paginated delta pull (#1013).

    ``next_cursor``/``has_more`` are added for cursor pagination; the pre-existing
    ``changes`` and ``timestamp`` fields are unchanged, so an older client that
    ignores the cursor still gets a valid (first) page. The client loops while
    ``has_more`` is true, sending the previous ``next_cursor`` back and keeping
    ``since`` constant, then adopts ``timestamp`` as the next ``since``.
    """

    changes = serializers.DictField(
        help_text="Per-collection WatermelonDB buckets (created/updated/deleted).",
    )
    timestamp = serializers.IntegerField(
        help_text=(
            "High-water mark to adopt as `since` once the delta is fully drained "
            "(after the last page)."
        ),
    )
    next_cursor = serializers.CharField(
        allow_null=True,
        help_text=(
            "Opaque continuation token. Pass it as the `cursor` query param on the "
            "next request; `null` when the delta is exhausted."
        ),
    )
    has_more = serializers.BooleanField(
        help_text="True while more pages remain for this `since` session.",
    )


# ---------------------------------------------------------------------------
# Upload (push) serializer — mobile offline → server (ADR-0082, issue #667)
#
# Validates only the batch envelope. Per-row task validation reuses the REST
# TaskSerializer (in sync.upload) so mobile writes inherit identical field
# rules and business logic — see ADR-0082 §E.
# ---------------------------------------------------------------------------


class SyncUploadCollectionSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """WatermelonDB per-collection change buckets — created / updated / deleted.

    Mirrors the shape WatermelonDB's ``synchronize()`` pushes for one collection:
    ``created`` and ``updated`` are lists of full row objects, ``deleted`` is a
    list of record ids (UUID strings). Row objects are deliberately free-form
    (``DictField``) rather than a typed row serializer: per-field task validation
    is delegated to ``TaskSerializer`` inside ``sync.upload`` so mobile writes
    inherit identical field rules and business logic (ADR-0082 §E). All three
    buckets are optional; an absent bucket means "no changes of that kind".
    """

    created = serializers.ListField(child=serializers.DictField(), required=False)
    updated = serializers.ListField(child=serializers.DictField(), required=False)
    deleted = serializers.ListField(child=serializers.CharField(), required=False)


class SyncUploadChangesSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """The ``changes`` map of an upload envelope, keyed by collection name.

    v1 exposes only the writable ``tasks`` collection (ADR-0082 §B); every other
    collection is pull-only. Unsupported collection keys are **not** rejected
    here — ``apply_task_changes`` is the single authority for the writable-
    collection whitelist and rejects them with an explicit 400 (rather than
    silently dropping them). This serializer therefore documents the writable
    shape in the OpenAPI schema without masking that guard; the view feeds the
    raw ``changes`` map to ``apply_task_changes`` so behavior stays identical.
    """

    tasks = SyncUploadCollectionSerializer(required=False)


class SyncUploadRequestSerializer(serializers.Serializer):  # type: ignore[type-arg]
    """Validate the envelope of a mobile upload batch (ADR-0082 §A).

    ``changes`` is a typed nested map (per-collection created/updated/deleted
    lists) so the WatermelonDB upload shape is explicit in the OpenAPI schema and
    the generated web types, instead of the opaque object it was before (#786).
    Per-collection row validation still happens in ``sync.upload`` so an
    unsupported collection can be rejected with an explicit 400 rather than
    silently dropped. ``last_pulled_at`` is the client's last-pull high-water mark
    and is the default per-row base version for the field-level conflict guard
    (#1718): a stale edit that overlaps a concurrent writer is reported in the
    response ``conflicts`` collection instead of silently clobbering. Omit it (and
    any per-row ``base_version``) to keep plain last-writer-wins.
    """

    client_batch_id = serializers.UUIDField()
    last_pulled_at = serializers.IntegerField(required=False, min_value=0)
    changes = SyncUploadChangesSerializer()
