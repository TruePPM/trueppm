"""Celery tasks for offline Jira import (mirrors msproject.tasks)."""

from __future__ import annotations

import base64
import logging
from collections.abc import Generator
from contextlib import contextmanager
from datetime import timedelta
from typing import Any

from celery import shared_task

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

# A Jira import running longer than this is considered orphaned by the drain
# (slightly longer than the 9-minute soft limit so the task can record its own
# failure before the drain resets the row).
_IMPORT_ORPHAN_MINUTES = 15


class _NoOpTracker:
    """Fallback when TaskRunTracker is not available."""

    task_run_id = None

    def update(self, pct: int, msg: str = "") -> None:
        logger.info("import.jira progress: %d%% -- %s", pct, msg)

    def set_result(self, result: dict[str, Any]) -> None:
        logger.info("import.jira result: %s", result)


@contextmanager
def _get_tracker(
    celery_task: Any,
    project_id: str,
    initiated_by_id: int | None,
) -> Generator[Any, None, None]:
    """Try to use TaskRunTracker; fall back to no-op if not available."""
    try:
        from trueppm_api.apps.taskruns.tracker import TaskRunTracker

        with TaskRunTracker(
            celery_task,
            project_id=project_id,
            task_name="import.jira",
            initiated_by_id=initiated_by_id,
        ) as tracker:
            yield tracker
    except ImportError:
        yield _NoOpTracker()


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    name="jira.import_file",
    soft_time_limit=540,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
)
def import_jira(
    self: Any,
    project_id: str,
    file_content_b64: str,
    filename: str,
    initiated_by_id: int | None = None,
    import_request_id: str | None = None,
) -> dict[str, Any]:
    """Parse an uploaded Jira XML export and import it as a CPM-schedulable network.

    Parses offline (no network), validates the derived dependency graph with the
    shared guard (#1665) **before** persisting anything, then reuses the MS
    Project importer to bulk-create the Task + FS Dependency network and triggers
    a CPM recalculation via the scheduling outbox.

    A deterministic failure — an unparseable file or a cyclic / infeasible graph
    — marks the outbox row DEAD so the drain stops re-dispatching it forever.
    """
    from trueppm_api.apps.jiraimport.parser import JiraImportError, parse_jira_xml

    with _get_tracker(self, project_id, initiated_by_id) as tracker:
        file_content = base64.b64decode(file_content_b64)
        tracker.update(5, f"Parsing {filename}...")

        try:
            project_data = parse_jira_xml(file_content)
        except JiraImportError:
            # Unparseable input is deterministic: retrying the same bytes always
            # fails. Mark the row DEAD (terminal) so the orphan drain stops.
            if import_request_id:
                _mark_import_dead(import_request_id)
            raise

        # Validate the derived dependency graph BEFORE any write (#1665, ADR-0259).
        # A prospect's messy export (cyclic links) must never persist an
        # infeasible network that then crashes the CPM / what-if engine live.
        # Validate in uid space — a relabeling of the eventual PKs — so nothing
        # is created if the graph is bad. The parser already quarantined
        # self-loops and dangling edges; a genuine cycle is rejected here.
        from trueppm_api.apps.scheduling.graph_guard import (
            InfeasibleGraphError,
            validate_task_graph,
        )

        edges = [
            (str(link.predecessor_uid), str(task.uid))
            for task in project_data.tasks
            for link in task.predecessor_links
        ]
        tracker.update(20, "Validating dependency graph...")
        try:
            validate_task_graph(edges)
        except InfeasibleGraphError:
            # Deterministic: the same export always produces the same cycle.
            if import_request_id:
                _mark_import_dead(import_request_id)
            raise

        from trueppm_api.apps.msproject.importer import import_project

        summary = import_project(project_id, project_data, tracker=tracker)
        tracker.set_result(summary)

        if summary["tasks_created"] > 0:
            # Trigger CPM via the outbox (survives a broker outage at this point)
            # and emit tasks_restructured so live clients render the imported tree
            # immediately, ahead of the async recalc's cpm_complete (mirrors the
            # MS Project importer, #1359). Deferred via on_commit for the same
            # reason the MSP path is.
            from django.db import transaction

            from trueppm_api.apps.scheduling.services import enqueue_recalculate
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            enqueue_recalculate(project_id)
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_restructured", {})
            )

    if import_request_id:
        _mark_import_done(import_request_id)

    return summary


def _mark_import_done(import_request_id: str) -> None:
    """Flip the row to DONE and clear the payload (only needed for retry)."""
    from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus

    JiraImportRequest.objects.filter(
        id=import_request_id, status=JiraImportStatus.DISPATCHED
    ).update(status=JiraImportStatus.DONE, file_content_b64="")


def _mark_import_dead(import_request_id: str) -> None:
    """Flip the row to DEAD after a terminal failure and clear the payload.

    DEAD is excluded from orphan-drain recovery, so a deterministically bad file
    (unparseable, or a cyclic graph) is not re-dispatched forever.
    """
    from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus

    JiraImportRequest.objects.filter(id=import_request_id).exclude(
        status=JiraImportStatus.DONE
    ).update(status=JiraImportStatus.DEAD, file_content_b64="")


@idempotent_task(
    lock_key_template="drain_jira_import_queue",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="jira.drain_import_queue",
)
def drain_jira_import_queue(self: object) -> None:
    """Dispatch pending JiraImportRequest rows; recover orphaned dispatched rows.

    Runs every 30 seconds via Celery Beat. Recovers dispatched rows older than
    ``_IMPORT_ORPHAN_MINUTES`` (worker died mid-import).
    """
    _do_jira_import_drain()


def _do_jira_import_drain() -> None:
    """Business logic for drain_jira_import_queue — extracted for testability."""
    from django.utils import timezone

    from trueppm_api.apps.jiraimport.models import JiraImportRequest, JiraImportStatus

    now = timezone.now()
    orphan_cutoff = now - timedelta(minutes=_IMPORT_ORPHAN_MINUTES)

    recovered = JiraImportRequest.objects.filter(
        status=JiraImportStatus.DISPATCHED,
        dispatched_at__lt=orphan_cutoff,
    ).update(status=JiraImportStatus.PENDING, celery_task_id="")
    if recovered:
        logger.warning("drain_jira_import_queue: recovered %d orphaned row(s)", recovered)

    pending = list(JiraImportRequest.objects.filter(status=JiraImportStatus.PENDING))
    dispatched = 0
    for req in pending:
        try:
            result = import_jira.delay(
                project_id=str(req.project_id),
                file_content_b64=req.file_content_b64,
                filename=req.filename,
                initiated_by_id=req.initiated_by_id,
                import_request_id=str(req.id),
            )
        except Exception:
            logger.warning(
                "drain_jira_import_queue: broker unavailable — JiraImportRequest %s stays pending",
                req.id,
            )
            continue
        JiraImportRequest.objects.filter(id=req.id, status=JiraImportStatus.PENDING).update(
            status=JiraImportStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=now,
        )
        dispatched += 1

    if dispatched or recovered:
        logger.info("drain_jira_import_queue: dispatched=%d recovered=%d", dispatched, recovered)
