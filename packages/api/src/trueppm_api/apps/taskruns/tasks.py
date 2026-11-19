"""Celery tasks for taskruns app."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.db.models.functions import Coalesce
from django.utils import timezone

logger = logging.getLogger(__name__)


def _do_taskrun_purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Business logic for purge_old_task_runs — extracted for testability.

    Deletes terminal (SUCCESS/FAILED/CANCELLED) TaskRun rows older than the window
    resolved by ``resolve_retention`` (operator override → the
    TASK_RUN_RETENTION_DAYS default, ADR-0173); ``None`` disables the purge. Returns
    rows deleted, or the eligible count when ``dry_run``; ``override_value`` forces
    a hypothetical window.
    """
    from trueppm_api.apps.observability.retention import resolve_retention
    from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus

    retention_days = (
        override_value
        if override_value is not None
        else resolve_retention("TASK_RUN_RETENTION_DAYS")
    )
    if retention_days is None:
        return 0

    cutoff = timezone.now() - timedelta(days=retention_days)
    qs = TaskRun.objects.filter(
        status__in=[TaskRunStatus.SUCCESS, TaskRunStatus.FAILED, TaskRunStatus.CANCELLED],
        completed_at__lt=cutoff,
    )
    if dry_run:
        return qs.count()
    deleted, _ = qs.delete()
    logger.info("purge_old_task_runs: deleted %d records", deleted)
    return deleted


@shared_task(name="taskruns.purge_old_records")  # type: ignore[untyped-decorator]
def purge_old_task_runs() -> dict[str, Any]:
    """Delete completed/failed/cancelled TaskRun records older than the window.

    Still dispatchable directly, but no longer on its own Beat schedule — the
    consolidated retention coordinator owns scheduled purging (ADR-0173 §C).
    Controlled by TASK_RUN_RETENTION_DAYS (default 30) plus any operator override;
    a resolved window of None disables auto-purge.
    """
    from trueppm_api.apps.observability.retention import resolve_retention

    if resolve_retention("TASK_RUN_RETENTION_DAYS") is None:
        return {"deleted": 0, "skipped": "retention disabled"}
    return {"deleted": _do_taskrun_purge()}


# TaskRun.task_name (what the tracker records) -> (Celery task name that owns the
# run, error code written on the reaped row). The reap threshold is read from the
# Celery task's own ``time_limit`` so it can never drift from the limit the worker
# is actually killed at. A task_name absent here is never reaped: without a known
# limit there is no honest "this can no longer be running" answer.
_REAPABLE: dict[str, tuple[str, str]] = {
    "scheduling.monte_carlo": ("scheduling.run_monte_carlo_simulation", "simulation_abandoned"),
    # Matched by suffix: that task carries Celery's default dotted-module name, and
    # spelling the module here would be an upward import edge for the layering gate.
    "scheduling.recalculate": (".recalculate_schedule", "task_abandoned"),
    "import.msproject": ("msproject.import_file", "task_abandoned"),
    "import.jira": ("jira.import_file", "task_abandoned"),
    "import.csv": ("csv.import_file", "task_abandoned"),
}

_DEFAULT_REAP_MARGIN_SECONDS = 120


def _reap_message(error: str) -> str:
    if error == "simulation_abandoned":
        return (
            "The Monte Carlo simulation was abandoned: its worker stopped before "
            "finishing. Run it again."
        )
    return "The task was abandoned: its worker stopped before finishing. Run it again."


def _do_reap_stale_task_runs() -> int:
    """Mark PENDING/RUNNING runs older than their task's time limit plus a margin FAILED.

    A worker killed by the hard ``time_limit`` (or lost without redelivery) never
    reaches ``TaskRunTracker.__exit__``, so its row would stay active forever, show in
    ``/task-runs/active/`` and keep the indicator count up. Age is measured from
    ``started_at`` (the last adoption) and falls back to ``created_at`` for a run no
    worker ever adopted. The write is a conditional UPDATE keyed on the row still being
    active, so a worker that finishes between the select and the update wins and the
    sweep leaves its terminal state alone; running the sweep twice is a no-op.
    Returns the number of rows reaped.
    """
    from celery import current_app

    from trueppm_api.apps.taskruns import tracker
    from trueppm_api.apps.taskruns.models import TaskRun, TaskRunStatus
    from trueppm_api.apps.taskruns.tracker import WS_FAILURE_MESSAGE

    margin = int(getattr(settings, "TASK_RUN_REAP_MARGIN_SECONDS", _DEFAULT_REAP_MARGIN_SECONDS))
    now = timezone.now()
    active = [TaskRunStatus.PENDING, TaskRunStatus.RUNNING]
    reaped = 0
    for task_name, (celery_name, error) in _REAPABLE.items():
        task = current_app.tasks.get(celery_name) or next(
            (
                t
                for n, t in current_app.tasks.items()
                if celery_name.startswith(".") and n.endswith(celery_name)
            ),
            None,
        )
        limit = getattr(task, "time_limit", None)
        if not limit:
            continue
        cutoff = now - timedelta(seconds=int(limit) + margin)
        # Indexed on status; only a handful of rows are ever active.
        stale = (
            TaskRun.objects.filter(task_name=task_name, status__in=active)
            .annotate(_since=Coalesce("started_at", "created_at"))
            .filter(_since__lt=cutoff)
            .values_list("pk", "project_id")
        )
        for pk, project_id in list(stale):
            summary = {
                "error": error,
                "message": _reap_message(error),
                "status_code": 503,
            }
            updated = TaskRun.objects.filter(pk=pk, status__in=active).update(
                status=TaskRunStatus.FAILED,
                completed_at=now,
                error_detail=f"{error}: no worker finished this run within {int(limit)}s "
                f"plus a {margin}s margin.",
                result_summary=summary,
            )
            if not updated:
                continue
            reaped += 1
            if project_id is not None:
                payload = {
                    "task_run_id": str(pk),
                    "task_name": task_name,
                    "error_detail": WS_FAILURE_MESSAGE,
                }

                def _emit(pid: str = str(project_id), pl: dict[str, str] = payload) -> None:
                    tracker.broadcast_task_run_failed(pid, pl)

                transaction.on_commit(_emit)
    if reaped:
        logger.warning("reap_stale_task_runs: marked %d stranded run(s) failed", reaped)
    return reaped


@shared_task(  # type: ignore[untyped-decorator]
    name="taskruns.reap_stale_task_runs",
    soft_time_limit=25,
    time_limit=30,
)
def reap_stale_task_runs() -> dict[str, int]:
    """Beat sweep: fail task runs stranded by a lost or hard-killed worker (#5068)."""
    return {"reaped": _do_reap_stale_task_runs()}
