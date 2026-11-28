"""Redacted schedule export for engine bug reports (#4689).

``GET /api/v1/projects/<pk>/schedule/bug-report-export/`` returns the project's
engine input — the same ``trueppm_scheduler.Project`` JSON the authoritative CPM pass
schedules, and that ``Project.from_json`` / the ``trueppm-scheduler`` CLI accept —
with every human-readable label stripped, plus the self-check verdict and the engine
version. It is what turns "a date looks wrong" into a fixture a maintainer can run.

**Redaction is the trust boundary.** The file is meant to be attached to a public
issue, and it is downloadable by every Scheduler+ member. It must therefore carry only
what reproduces the CPM pass, and nothing a project reader would be refused elsewhere.
That still includes real schedule dates (sprint start dates among them, folded into
``planned_start``), calendar non-working date ranges, progress and three-point
estimates. Only this project's network is exported: cross-project dependencies are not,
so a date set by a program-merged pass may not reproduce from the file.
:func:`redact_engine_input` works from an allow-list: every key that
``Project/Task/Dependency/Calendar/DateRange.to_dict()`` emits is classified in the
``*_FIELDS`` tables below as kept, replaced (a human label) or nulled, and a key the
tables do not name is dropped rather than copied. A new engine field therefore stays
out of the file until someone classifies it, and
``test_every_engine_key_is_classified`` fails until they do.

Nulled: the team's velocity inputs (``velocity_samples``, ``sprint_length_days``) and
each task's ``story_points`` / ``delivery_mode``. Velocity is a team-private signal
under ADR-0104 (the PM band can be refused it), and ``schedule()`` reads none of these
fields, so the exported input schedules to the same dates without them. They feed only
Monte Carlo's velocity sampling. Ids stay: they are opaque UUIDs, and the reporter
needs them to point at "this task".
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
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

logger = logging.getLogger(__name__)

EXPORT_FORMAT_VERSION = 1

REDACTED_PROJECT_NAME = "redacted"

# Field classifications. ``KEEP`` copies the value; ``LABEL`` blanks a human-readable
# label (the project and task names are then replaced with placeholders, because
# ``from_dict`` requires a string); ``NULL`` emits ``None``. A nested table is applied
# to a sub-object (``_One``), to each element of a list (``_Each``) or to each value of
# an id-keyed mapping (``_Map``).
KEEP = "keep"
LABEL = "label"
NULL = "null"


@dataclass(frozen=True)
class _Const:
    value: Any


@dataclass(frozen=True)
class _One:
    fields: Mapping[str, Any]


@dataclass(frozen=True)
class _Each:
    fields: Mapping[str, Any]


@dataclass(frozen=True)
class _Map:
    fields: Mapping[str, Any]


DATE_RANGE_FIELDS: Mapping[str, Any] = {"start": KEEP, "end": KEEP}

CALENDAR_FIELDS: Mapping[str, Any] = {
    "working_days": KEEP,
    "exceptions": _Each(DATE_RANGE_FIELDS),
    # Reserved-but-inert in the engine, and a timezone can place a team: emit the
    # engine's defaults, never the stored values.
    "hours_per_day": _Const(8.0),
    "timezone": _Const("UTC"),
}

DEPENDENCY_FIELDS: Mapping[str, Any] = {
    "predecessor_id": KEEP,
    "successor_id": KEEP,
    "dep_type": KEEP,
    "lag": KEEP,
}

TASK_FIELDS: Mapping[str, Any] = {
    "id": KEEP,
    "name": LABEL,
    # CPM inputs.
    "duration": KEEP,
    "planned_start": KEEP,
    "planned_finish": KEEP,
    "percent_complete": KEEP,
    "actual_start": KEEP,
    "actual_finish": KEEP,
    "calendar_id": KEEP,
    "live_day_end_on": KEEP,
    "zero_remaining": KEEP,
    # Engine outputs (an input value is ignored and recomputed).
    "early_start": KEEP,
    "early_finish": KEEP,
    "late_start": KEEP,
    "late_finish": KEEP,
    "total_float": KEEP,
    "free_float": KEEP,
    "is_critical": KEEP,
    "scheduled_start": KEEP,
    "milestone_at_day_end": KEEP,
    # Per-task estimates; Monte Carlo only, not a team signal.
    "optimistic_duration": KEEP,
    "most_likely_duration": KEEP,
    "pessimistic_duration": KEEP,
    # Velocity-path inputs (Monte Carlo only). Story points on completed tasks are
    # the material the team's velocity series is summed from.
    "delivery_mode": NULL,
    "story_points": NULL,
}

PROJECT_FIELDS: Mapping[str, Any] = {
    "id": KEEP,
    "name": LABEL,
    "start_date": KEEP,
    "status_date": KEEP,
    "tasks": _Each(TASK_FIELDS),
    "dependencies": _Each(DEPENDENCY_FIELDS),
    "calendar": _One(CALENDAR_FIELDS),
    "calendars": _Map(CALENDAR_FIELDS),
    # ADR-0104 team signal: never exported.
    "velocity_samples": NULL,
    "sprint_length_days": NULL,
}


def _apply(value: Any, rule: Any) -> Any:
    if isinstance(rule, _Const):
        return rule.value
    if value is None or rule == KEEP:
        return value
    if rule == NULL:
        return None
    if rule == LABEL:
        return ""
    if isinstance(rule, _One):
        return _filter(value, rule.fields)
    if isinstance(rule, _Each):
        return [_filter(v, rule.fields) for v in value] if isinstance(value, list) else None
    if isinstance(rule, _Map):
        if not isinstance(value, dict):
            return None
        return {k: _filter(v, rule.fields) for k, v in value.items()}
    return None


def _filter(obj: Any, fields: Mapping[str, Any]) -> Any:
    if not isinstance(obj, dict):
        return None
    out: dict[str, Any] = {}
    for key, value in obj.items():
        rule = fields.get(key)
        if rule is None:
            # Fail closed: an unclassified key is not exported. Logged by name only.
            logger.warning("bug-report export dropped unclassified engine key %r", key)
            continue
        out[key] = _apply(value, rule)
    return out


def redact_engine_input(document: dict[str, Any]) -> dict[str, Any]:
    """Reduce a ``Project.to_dict()`` document to its classified, exportable fields.

    Every key is copied, blanked or nulled per ``PROJECT_FIELDS`` and the nested
    tables; any key they do not name is dropped. The project is renamed ``redacted``
    and each task ``task-<n>`` (in document order), because ``Project.from_dict``
    requires a string name. The result still loads with ``Project.from_dict`` and
    schedules to the same dates as the input.
    """
    scrubbed: dict[str, Any] = _filter(document, PROJECT_FIELDS)
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
                            "trueppm_scheduler.Project JSON reduced to an allow-list of "
                            "schedule inputs: names replaced, team velocity inputs and "
                            "story points nulled."
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
        from trueppm_api.apps.scheduling.views import (
            _build_cpm_sched_inputs,
            _mc_lag_delta_kwargs,
        )

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
                verdict = full_verdict(sched_project, result, mc_kwargs=_mc_lag_delta_kwargs())
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
