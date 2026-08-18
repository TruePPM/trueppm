"""Serializers for MS Project import provenance (#799)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.msproject.models import ImportRequest
from trueppm_api.apps.taskruns.models import TaskRun


class ImportRequestProvenanceSerializer(serializers.ModelSerializer[ImportRequest]):
    """Read-only audit view of an `ImportRequest` for the project history list.

    Marcus (PMO persona) wants the import itself to be part of the project's
    record: who imported, from what file, when, and what was the outcome.
    `ImportRequest` already holds the durable who/what/when/status fields;
    this serializer joins in the linked `TaskRun.result_summary` to surface
    the imported task count alongside the audit fields.

    `ImportRequest` rows are purged after 7 days by the
    ``purge_old_import_requests`` cleanup task, so this surface is
    intentionally an at-a-glance recent-activity view, not a long-lived
    audit log — enterprise overlays consume the `history_record_created`
    signal for compliance-grade retention (out of scope here).
    """

    initiated_by_username = serializers.SerializerMethodField()
    task_count = serializers.SerializerMethodField()
    warnings = serializers.SerializerMethodField()

    class Meta:
        model = ImportRequest
        fields = (
            "id",
            "filename",
            "status",
            "creates_project",
            "requested_at",
            "initiated_by",
            "initiated_by_username",
            "task_count",
            "warnings",
        )
        read_only_fields = fields

    def get_initiated_by_username(self, obj: ImportRequest) -> str | None:
        """Display username; absent when the row's user was deleted."""
        if obj.initiated_by_id is None:
            return None
        return obj.initiated_by.username if obj.initiated_by else None

    def _task_run(self, obj: ImportRequest) -> TaskRun | None:
        """Resolve the linked TaskRun, memoized across the rows of one response.

        Returns ``None`` when the import is still in flight (no TaskRun yet) or
        when the run failed before writing its summary. The TaskRun link is by
        `celery_task_id` — the import view sets it once Celery dispatch succeeds,
        so PENDING / DEAD rows reliably resolve to ``None``.

        Shared by every summary-derived field so a second one cannot double the
        query count: the view pre-seeds a mutable `_taskrun_cache` dict in context
        and we only ever read from `self.context` here (the type is
        `Mapping[str, Any]` under stricter django-stubs builds in CI, so indexed
        assignment is not safe). When invoked outside the list view (e.g.
        single-instance detail use), no cache is present and each row issues its
        own query.
        """
        if not obj.celery_task_id:
            return None
        cache: dict[str, TaskRun | None] | None = self.context.get("_taskrun_cache")
        if cache is not None and obj.celery_task_id in cache:
            return cache[obj.celery_task_id]
        run = TaskRun.objects.filter(celery_task_id=obj.celery_task_id).first()
        if cache is not None:
            cache[obj.celery_task_id] = run
        return run

    def get_task_count(self, obj: ImportRequest) -> int | None:
        """Pull the imported task count from the linked TaskRun summary."""
        run = self._task_run(obj)
        if run is None or not run.result_summary:
            return None
        value: Any = run.result_summary.get("task_count")
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    def get_warnings(self, obj: ImportRequest) -> list[str]:
        """Everything the import did not carry over, in the parser's order (#2891).

        The importer has always written these into ``TaskRun.result_summary``, and
        nothing has ever read them back out — so "the parser warns" was true and
        useless at the same time. Losing an MS Project constraint, deadline or
        baseline is a correctness event, not a log line, and the operator has to be
        able to reach it. This is the API-side half; a wizard surface for it is
        tracked separately (#2714).

        Empty for a queued or dead import, the same contract as ``task_count``.
        """
        run = self._task_run(obj)
        if run is None or not run.result_summary:
            return []
        warnings: Any = run.result_summary.get("warnings")
        if not isinstance(warnings, list):
            return []
        return [str(w) for w in warnings]
