"""Serializers for TaskRun API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.taskruns.models import TaskRun


class _ErrorDetailAdminOnlyMixin:
    """Blanks ``error_detail`` unless the caller is an Admin+ on the run's project.

    ``error_detail`` is the raw exception text from the Celery worker and can carry
    tracebacks, file paths and internal identifiers. Both task-run endpoints are
    readable by any project member (Viewer+), so the field is redacted per row at
    serialization time. The role is resolved against each row's own project because
    ``GlobalTaskRunViewSet`` spans projects; ``_membership_role`` caches per request,
    so a list costs one lookup per distinct project. With no request in context the
    field is blanked (fail closed) — the opposite of ``ApiTokenAuditEntrySerializer``,
    where the redacted value is an IP rather than diagnostic text.
    """

    context: dict[str, Any]

    def to_representation(self, instance: TaskRun) -> dict[str, Any]:
        data: dict[str, Any] = super().to_representation(instance)  # type: ignore[misc]
        if not data.get("error_detail"):
            return data
        # layering-ok: the redaction decision is the project RBAC role, which only
        # access owns; same upward edge the views already take for IsProjectAdmin.
        from trueppm_api.apps.access.models import Role

        # layering-ok: _membership_role is the per-request role cache this must share.
        from trueppm_api.apps.access.permissions import _membership_role

        request = self.context.get("request")
        role = _membership_role(request, instance.project_id) if request is not None else None
        if role is None or role < Role.ADMIN:
            data["error_detail"] = ""
        return data


class TaskRunSerializer(_ErrorDetailAdminOnlyMixin, serializers.ModelSerializer[TaskRun]):
    """Read-only serializer for TaskRun progress records.

    Exposes all fields needed to drive a progress indicator: status,
    progress_pct, progress_msg, and timing fields for duration display.
    All fields are read-only — TaskRun records are created and updated
    by the Celery worker, never directly via the API.

    ``initiated_by`` is exposed as a username string, not the raw auth.User
    integer PK, so a Viewer-tier member cannot harvest user ids. ``error_detail``
    is blank for callers below the Admin role.
    """

    initiated_by_username = serializers.SerializerMethodField()

    class Meta:
        model = TaskRun
        fields = [
            "id",
            "task_name",
            "celery_task_id",
            "project",
            "initiated_by_username",
            "status",
            "progress_pct",
            "progress_msg",
            "result_summary",
            "error_detail",
            "created_at",
            "started_at",
            "completed_at",
        ]
        read_only_fields = fields

    def get_initiated_by_username(self, obj: TaskRun) -> str | None:
        user = obj.initiated_by
        if user is None:
            return None
        return getattr(user, "username", None) or getattr(user, "email", None)


class SchedulerRunResultSummarySerializer(serializers.Serializer[Any]):
    """Typed view over TaskRun.result_summary when task_name='scheduling.recalculate'.

    The tracker writes ``{"project_finish": "YYYY-MM-DD", "critical_path": [uuid, ...],
    "status_date": "YYYY-MM-DD"}`` from ``_run_schedule``. Fields are optional
    because failed runs may never reach ``set_result()``.
    """

    project_finish = serializers.DateField(required=False, allow_null=True)
    critical_path = serializers.ListField(
        child=serializers.CharField(), required=False, allow_null=True
    )
    # The data date this run was actually computed against (ADR-0752 §4) — a
    # REST fallback for a client that missed the live cpm_complete/
    # task_run_completed broadcast, mirroring the MC status_date provenance
    # convention (#2638). Always present on a successful run; absent on a
    # dateless-but-settled result (``_settle_empty``), which never resolves one.
    status_date = serializers.DateField(required=False, allow_null=True)


class SchedulerRunSerializer(_ErrorDetailAdminOnlyMixin, serializers.ModelSerializer[TaskRun]):
    """Typed view over TaskRun records for scheduler recalculation runs.

    Exposes ``initiated_by`` as a username string rather than a user UUID —
    observability audit readers (Marcus/SOC 2) want a human-readable name, and
    this avoids leaking user PKs to non-admin project members.
    """

    initiated_by_username = serializers.SerializerMethodField()
    result_summary = SchedulerRunResultSummarySerializer(allow_null=True, required=False)

    class Meta:
        model = TaskRun
        fields = [
            "id",
            "status",
            "progress_pct",
            "progress_msg",
            "result_summary",
            "error_detail",
            "initiated_by_username",
            "created_at",
            "started_at",
            "completed_at",
        ]
        read_only_fields = fields

    def get_initiated_by_username(self, obj: TaskRun) -> str | None:
        user = obj.initiated_by
        if user is None:
            return None
        return getattr(user, "username", None) or getattr(user, "email", None)
