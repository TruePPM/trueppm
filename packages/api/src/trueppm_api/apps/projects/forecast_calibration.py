"""Forecast-vs-actual capture and the calibration export contract (ADR-1511, #4747).

Instrumentation only: this module records what was forecast at each baseline or
replan and emits it, joined to the actual finish, in a versioned format. It does
no calibration analysis — that is #2299.

Consent (ADR-0104): capture and export are per project and opt-in
(``Project.forecast_calibration_capture``). The rows are aggregate schedule facts
— dates, UUIDs, a milestone bit — and never carry a user, an assignee, a name or
free text.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterator
from datetime import date, datetime
from typing import Any

from django.db import transaction
from django.db.models import Count, Max, Q
from django.utils import timezone

from .models import (
    Baseline,
    ForecastCalibrationKind,
    ForecastCalibrationRecord,
    ForecastCalibrationScope,
    Project,
    Task,
)

logger = logging.getLogger(__name__)

EXPORT_SCHEMA = "trueppm.forecast-calibration"
EXPORT_SCHEMA_VERSION = 1


def _project_finish(rows: list[dict[str, Any]]) -> tuple[date | None, bool | None]:
    """The latest finish over ``rows`` and whether it is the start of its day.

    Mirrors ``ProjectForecastSnapshot.cpm_finish_at_day_start`` (#4178): the
    project finish is the start of its day only when every row finishing on it is.
    """
    from trueppm_api.apps.scheduling.finish_reading import values_finish_at_day_start

    finishes = [r for r in rows if r["early_finish"] is not None]
    if not finishes:
        return None, None
    latest = max(r["early_finish"] for r in finishes)
    edges = [values_finish_at_day_start(r) for r in finishes if r["early_finish"] == latest]
    return latest, all(edges)


def record_capture(
    baseline: Baseline,
    rows: list[dict[str, Any]],
    *,
    kind: str = ForecastCalibrationKind.BASELINE,
) -> int:
    """Record the forecast a baseline froze, when the project opted in.

    Called from the one baseline snapshot (``baselines.snapshot_tasks``) inside the
    capture transaction. Returns the number of rows written (0 when the project
    has not opted in). Best-effort: the write runs in a savepoint and a failure is
    logged, never raised — instrumentation must not be able to block a baseline.

    Only the committed set (``Task.committed``, the CPM domain) is recorded: a
    backlog or epic row carries no forecast to calibrate.
    """
    project = baseline.project
    if not project.forecast_calibration_capture:
        return 0
    try:
        with transaction.atomic():
            return _write_capture(project, baseline, rows, kind)
    except Exception:
        logger.exception(
            "forecast calibration capture failed for project %s baseline %s",
            project.pk,
            baseline.pk,
        )
        return 0


def _write_capture(
    project: Project, baseline: Baseline, rows: list[dict[str, Any]], kind: str
) -> int:
    from trueppm_api.apps.scheduling.models import MonteCarloRun

    committed_ids = set(Task.committed.filter(project_id=project.pk).values_list("id", flat=True))
    committed = [r for r in rows if r["id"] in committed_ids]
    if not committed:
        return 0

    from trueppm_api.apps.scheduling.finish_reading import values_finish_at_day_start

    capture_id = uuid.uuid4()
    now = timezone.now()
    run = (
        MonteCarloRun.objects.filter(project_id=project.pk)
        .order_by("-taken_at")
        .only("p50", "p80", "p95", "taken_at", "n_simulations")
        .first()
    )
    finish, at_day_start = _project_finish(committed)
    common = {
        "project": project,
        "baseline": baseline,
        "capture_id": capture_id,
        "captured_at": now,
        "kind": kind,
    }
    records = [
        ForecastCalibrationRecord(
            **common,
            scope=ForecastCalibrationScope.PROJECT,
            task_id=None,
            deterministic_finish=finish,
            deterministic_finish_at_day_start=at_day_start,
            p50=run.p50 if run else None,
            p80=run.p80 if run else None,
            p95=run.p95 if run else None,
            distribution_computed_at=run.taken_at if run else None,
            mc_iterations=run.n_simulations if run else None,
        )
    ]
    records.extend(
        ForecastCalibrationRecord(
            **common,
            scope=ForecastCalibrationScope.TASK,
            task_id=r["id"],
            is_milestone=bool(r["is_milestone"]),
            deterministic_finish=r["early_finish"],
            deterministic_finish_at_day_start=(
                values_finish_at_day_start(r) if r["early_finish"] is not None else None
            ),
        )
        for r in committed
    )
    # Plain models.Model (no server_version): bulk_create is safe here.
    ForecastCalibrationRecord.objects.bulk_create(records)
    return len(records)


def _iso(value: date | datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def export_records(project_ids: list[Any] | None = None) -> Iterator[dict[str, Any]]:
    """Yield the export, header first, then one dict per record (ADR-1511 §Export).

    Only projects whose ``forecast_calibration_capture`` is on *now* are emitted:
    withdrawing consent removes a project from every later export without deleting
    its rows. The actual finish is joined here, at read time, from the live task.
    """
    projects = Project.objects.filter(forecast_calibration_capture=True)
    if project_ids:
        projects = projects.filter(pk__in=project_ids)
    consenting = list(projects.values_list("pk", flat=True))

    yield {
        "record": "header",
        "schema": EXPORT_SCHEMA,
        "version": EXPORT_SCHEMA_VERSION,
        "exported_at": timezone.now().isoformat(),
        "project_count": len(consenting),
    }

    for project_id in consenting:
        # One query for every task the project's records name, deleted or not.
        task_ids = (
            ForecastCalibrationRecord.objects.filter(project_id=project_id, task_id__isnull=False)
            .values_list("task_id", flat=True)
            .distinct()
        )
        actuals = {
            row["id"]: row
            for row in Task.objects.filter(project_id=project_id, id__in=task_ids).values(
                "id", "actual_finish", "is_deleted"
            )
        }
        project_actual = Task.committed.filter(project_id=project_id).aggregate(
            total=Count("id"),
            open=Count("id", filter=Q(actual_finish__isnull=True)),
            latest=Max("actual_finish"),
        )
        project_done = bool(project_actual["total"]) and project_actual["open"] == 0

        for rec in ForecastCalibrationRecord.objects.filter(project_id=project_id).iterator():
            if rec.scope == ForecastCalibrationScope.PROJECT:
                actual = project_actual["latest"] if project_done else None
                outcome = "finished" if project_done else "open"
            else:
                task = actuals.get(rec.task_id) if rec.task_id else None
                if task is None or task["is_deleted"]:
                    actual, outcome = None, "deleted"
                elif task["actual_finish"] is not None:
                    actual, outcome = task["actual_finish"], "finished"
                else:
                    actual, outcome = None, "open"
            yield {
                "record": "forecast",
                "project_id": str(rec.project_id),
                "capture_id": str(rec.capture_id),
                "captured_at": _iso(rec.captured_at),
                "forecast_kind": rec.kind,
                "scope": rec.scope,
                "task_id": str(rec.task_id) if rec.task_id else None,
                "is_milestone": rec.is_milestone,
                "deterministic_finish": _iso(rec.deterministic_finish),
                "deterministic_finish_at_day_start": rec.deterministic_finish_at_day_start,
                "p50": _iso(rec.p50),
                "p80": _iso(rec.p80),
                "p95": _iso(rec.p95),
                "distribution_computed_at": _iso(rec.distribution_computed_at),
                "mc_iterations": rec.mc_iterations,
                "actual_finish": _iso(actual),
                "outcome": outcome,
            }
