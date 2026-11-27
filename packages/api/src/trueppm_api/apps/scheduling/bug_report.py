"""Redacted schedule export for engine bug reports (#4689).

``GET /api/v1/projects/<pk>/schedule/bug-report-export/`` returns the project's
engine input — the same ``trueppm_scheduler.Project`` JSON the authoritative CPM pass
schedules, and that ``Project.from_json`` / the ``trueppm-scheduler`` CLI accept —
with every human-readable label stripped, plus the self-check verdict and the engine
version. It is what turns "a date looks wrong" into a fixture a maintainer can run.

**Redaction is the trust boundary.** The file is meant to be attached to a public
issue. The engine input never carries descriptions, notes, assignees or attachments
(the converters do not copy them), so what must be removed is the project and task
``name``. :func:`redact_engine_input` does that, and also blanks any other key that
names a person or holds free text, so a future engine field of that kind cannot leak
through this path unnoticed. Ids stay: they are opaque UUIDs, and the reporter needs
them to point at "this task".
"""

from __future__ import annotations

from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import IsProjectScheduler
from trueppm_api.apps.projects.models import Project

EXPORT_FORMAT_VERSION = 1

REDACTED_PROJECT_NAME = "redacted"
# Keys removed wherever they appear in the engine document. ``name`` is the only one
# today's engine model carries; the rest guard the boundary against a future field.
_TEXT_KEYS = frozenset({"name", "title", "label", "description", "notes", "comment"})
_PERSON_KEYS = frozenset(
    {"assignee", "assignees", "assignments", "owner", "owners", "attachments", "email"}
)


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key in _PERSON_KEYS:
                out[key] = [] if isinstance(item, list) else None
            elif key in _TEXT_KEYS:
                out[key] = "" if isinstance(item, str) else None
            else:
                out[key] = _scrub(item)
        return out
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    return value


def redact_engine_input(document: dict[str, Any]) -> dict[str, Any]:
    """Strip names and person/free-text fields from a ``Project.to_dict()`` document.

    The project is renamed ``redacted`` and each task ``task-<n>`` (in document
    order), because ``Project.from_dict`` requires a string name; every other text or
    person key is blanked. The result still loads with ``Project.from_dict``.
    """
    scrubbed: dict[str, Any] = _scrub(document)
    scrubbed["name"] = REDACTED_PROJECT_NAME
    for n, task in enumerate(scrubbed.get("tasks") or [], start=1):
        if isinstance(task, dict):
            task["name"] = f"task-{n}"
    return scrubbed


class ScheduleBugReportExportView(APIView):
    """Download the redacted engine input and self-check verdict for a bug report.

    Gated to the project's Scheduler role and above, like a manual recompute: the
    file is the whole schedule network, which a Viewer or Member can read piecemeal
    but should not be able to bulk-export for an external tracker. Archived projects
    stay exportable (it is a read). One full ``schedule()`` pass plus the self-check
    per call, so it shares the CPM-on-read throttle and slot pool.
    """

    project_url_kwarg = "pk"
    permission_classes = (IsAuthenticated, IsProjectScheduler)
    throttle_classes = (ScopedRateThrottle,)
    throttle_scope = "cpm_on_read"

    @extend_schema(
        operation_id="project_schedule_bug_report_export",
        summary="Redacted engine input and self-check verdict for a bug report",
        responses={
            200: inline_serializer(
                name="ScheduleBugReportExport",
                fields={
                    "format_version": serializers.IntegerField(),
                    "engine_version": serializers.CharField(),
                    "engine_input": serializers.DictField(
                        help_text=(
                            "trueppm_scheduler.Project JSON with names, descriptions, "
                            "assignees and attachments stripped."
                        )
                    ),
                    "verdict": serializers.DictField(
                        help_text=(
                            "Self-check result: engine_version, task_count, checks "
                            "(name -> pass|fail|skipped|error), violations."
                        )
                    ),
                },
            ),
            400: OpenApiResponse(description="The project's schedule input is invalid."),
            403: OpenApiResponse(description="Caller is not Scheduler or above on the project."),
            404: OpenApiResponse(description="Project not found."),
            503: OpenApiResponse(description="No free CPM slot; retry after Retry-After."),
        },
    )
    def get(self, request: Request, pk: str) -> Response:
        from trueppm_scheduler import SchedulerError, schedule

        from trueppm_api.apps.scheduling.cpm_admission import cpm_busy_response, cpm_slot
        from trueppm_api.apps.scheduling.selfcheck import engine_version, full_verdict
        from trueppm_api.apps.scheduling.views import _build_cpm_sched_inputs

        project = get_object_or_404(
            Project.objects.select_related("calendar", "program__calendar").prefetch_related(
                "calendar__exceptions",
                "calendar_layers__calendar__exceptions",
                "program__calendar__exceptions",
            ),
            pk=pk,
            is_deleted=False,
        )
        self.check_object_permissions(request, project)

        try:
            sched_project = _build_cpm_sched_inputs(project, pk)[0]
            document = sched_project.to_dict()
            with cpm_slot() as admitted:
                if not admitted:
                    return cpm_busy_response()
                result = schedule(sched_project)
                verdict = full_verdict(sched_project, result)
        except (SchedulerError, ValueError):
            return Response({"detail": "The project's schedule input is invalid."}, status=400)

        filename = f"trueppm-schedule-{str(project.pk)[:8]}.json"
        return Response(
            {
                "format_version": EXPORT_FORMAT_VERSION,
                "engine_version": engine_version(),
                "engine_input": redact_engine_input(document),
                "verdict": verdict,
            },
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
