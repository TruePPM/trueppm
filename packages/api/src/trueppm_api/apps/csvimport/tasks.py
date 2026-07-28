"""Celery tasks for CSV / Excel import (mirrors jiraimport.tasks)."""

from __future__ import annotations

import base64
import logging
from collections.abc import Generator
from contextlib import contextmanager
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from celery import shared_task

from trueppm_api.core.idempotent import idempotent_task

if TYPE_CHECKING:
    # Type-only: the runtime import stays inside the task, where the rest of
    # this module's Django/app imports are deferred for app-loading order.
    from trueppm_api.apps.scheduling.graph_guard import InfeasibleGraphError

logger = logging.getLogger(__name__)

# A CSV import running longer than this is considered orphaned by the drain
# (slightly longer than the 9-minute soft limit so the task can record its own
# failure before the drain resets the row).
_IMPORT_ORPHAN_MINUTES = 15

# Rows inside an open transaction.on_commit() callback are invisible until the
# commit lands, so the drain skips rows younger than this to avoid racing an
# in-flight upload it would otherwise double-dispatch.
_DRAIN_MIN_AGE_MINUTES = 10


class _NoOpTracker:
    """Fallback when TaskRunTracker is not available."""

    task_run_id = None

    def update(self, pct: int, msg: str = "") -> None:
        logger.info("import.csv progress: %d%% -- %s", pct, msg)

    def set_result(self, result: dict[str, Any]) -> None:
        logger.info("import.csv result: %s", result)


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
            task_name="import.csv",
            initiated_by_id=initiated_by_id,
        ) as tracker:
            yield tracker
    except ImportError:
        yield _NoOpTracker()


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    name="csv.import_file",
    soft_time_limit=540,
    time_limit=600,
    acks_late=True,
    reject_on_worker_lost=True,
)
def import_csv(
    self: Any,
    project_id: str,
    file_content_b64: str,
    filename: str,
    column_map: dict[str, str] | None = None,
    initiated_by_id: int | None = None,
    import_request_id: str | None = None,
) -> dict[str, Any]:
    """Parse an uploaded spreadsheet and import it into an existing project.

    Parses offline, validates the derived dependency graph with the shared guard
    **before** persisting anything, then reuses ``msproject.importer`` to
    bulk-create the Task + Dependency network and triggers a CPM recalculation
    through the scheduling outbox (ADR-0632).

    A deterministic failure — an unreadable file, or a spreadsheet whose
    predecessor column encodes a cycle — marks the outbox row DEAD so the drain
    stops re-dispatching it forever. Row-level problems (a bad date, an unknown
    predecessor) are **not** failures: those rows import without the offending
    field and the errors ride back in the summary.
    """
    from django.conf import settings

    from trueppm_api.apps.csvimport.parser import CsvImportError, parse_spreadsheet

    with _get_tracker(self, project_id, initiated_by_id) as tracker:
        file_content = base64.b64decode(file_content_b64)
        tracker.update(5, f"Parsing {filename}...")

        try:
            parsed = parse_spreadsheet(
                file_content,
                filename,
                column_map=column_map or None,
                max_rows=settings.CSV_IMPORT_MAX_ROWS,
                max_uncompressed_bytes=settings.CSV_IMPORT_MAX_UNCOMPRESSED_MB * 1024 * 1024,
            )
        except CsvImportError as exc:
            # Unparseable input is deterministic: retrying the same bytes always
            # fails. Mark the row DEAD (terminal) so the orphan drain stops, and
            # record why so the launching Schedule can show it (#2151).
            if import_request_id:
                _mark_import_dead(import_request_id, str(exc))
            raise

        # Validate the derived dependency graph BEFORE any write. A spreadsheet's
        # predecessor column is hand-maintained and routinely cyclic; persisting
        # an infeasible network would crash the CPM engine on the next recalc.
        # Validate in uid space — a relabeling of the eventual PKs — so nothing
        # is created if the graph is bad.
        from trueppm_api.apps.scheduling.graph_guard import (
            InfeasibleGraphError,
            validate_task_graph,
        )

        edges = [
            (str(link.predecessor_uid), str(task.uid))
            for task in parsed.project_data.tasks
            for link in task.predecessor_links
        ]
        tracker.update(20, "Validating dependency graph...")
        try:
            validate_task_graph(edges)
        except InfeasibleGraphError as exc:
            if import_request_id:
                _mark_import_dead(import_request_id, _describe_bad_graph(exc))
            raise

        from django.db import transaction

        from trueppm_api.apps.msproject.importer import import_project

        # Make the additive CSV import idempotent under re-dispatch. import_project
        # defaults to wipe_existing=False, so a second delivery would bulk-create
        # the whole network again. The outbox row is the idempotency token: claim
        # it (DISPATCHED -> DONE) and run the bulk_create in ONE transaction. A
        # duplicate delivery — a drain re-dispatch after a worker-death window, or
        # an acks_late / reject_on_worker_lost redelivery of an already completed
        # message — finds no DISPATCHED row to claim and skips the import. The
        # claim's row lock serializes any concurrent delivery; because claim and
        # import share the transaction, a mid-import failure rolls the claim back
        # too, returning the row to DISPATCHED for a clean retry.
        summary: dict[str, Any]
        with transaction.atomic():
            if import_request_id and not _claim_import(import_request_id):
                logger.info(
                    "import.csv: request %s already completed — skipping duplicate delivery",
                    import_request_id,
                )
                return {"skipped": True, "tasks_created": 0}
            summary = import_project(project_id, parsed.project_data, tracker=tracker)

        summary["row_errors"] = [e.as_dict() for e in parsed.row_errors]
        summary["row_error_count"] = len(parsed.row_errors)
        summary["error_count"] = parsed.error_count
        summary["warning_count"] = parsed.warning_count
        summary["rows_read"] = parsed.total_rows
        summary["rows_skipped"] = parsed.truncated_rows
        summary["warnings"] = list(parsed.warnings)
        summary["filename"] = filename

        if import_request_id:
            _record_summary(import_request_id, summary)
        tracker.set_result(summary)

        if summary.get("tasks_created", 0) > 0:
            # Trigger CPM via the outbox (survives a broker outage at this point)
            # and emit tasks_restructured so live clients render the imported tree
            # immediately, ahead of the async recalc's cpm_complete. Both run just
            # after the import's atomic() has committed (no ambient transaction
            # remains -> on_commit fires immediately), so peers never see the
            # event for a rolled-back import.
            from trueppm_api.apps.scheduling.services import enqueue_recalculate
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            enqueue_recalculate(project_id)
            transaction.on_commit(
                lambda: broadcast_board_event(project_id, "tasks_restructured", {})
            )

    return summary


def _claim_import(import_request_id: str) -> bool:
    """Atomically claim a DISPATCHED CsvImportRequest, flipping it to DONE.

    The conditional ``UPDATE ... WHERE status=DISPATCHED`` is the exactly-once
    idempotency token for the import: run inside the same transaction as the
    bulk_create, the row transitions to DONE atomically with the imported
    network. Returns ``True`` when this delivery won the claim (import),
    ``False`` when the row was already terminal — a duplicate delivery whose
    import must be skipped so the additive path does not create the network
    twice. Clears the payload (only needed for pre-terminal retry).
    """
    from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus

    claimed = CsvImportRequest.objects.filter(
        id=import_request_id, status=CsvImportStatus.DISPATCHED
    ).update(status=CsvImportStatus.DONE, file_content_b64="")
    return bool(claimed)


def _uid_to_row(uid: str) -> str:
    """Render a parser task uid as the spreadsheet row the uploader can open.

    ``parse_spreadsheet`` numbers tasks ``uid = data_row_index + 1``, and the
    header occupies row 1, so the row a person sees in Excel is ``uid + 1``.
    Reporting the uid instead would be off by one against the file on their
    screen. Non-numeric uids cannot arise from this parser, but the fallback
    keeps a malformed id from turning a diagnostic into a crash.
    """
    try:
        return f"row {int(uid) + 1}"
    except (TypeError, ValueError):
        return f"task {uid}"


def _describe_bad_graph(exc: InfeasibleGraphError) -> str:
    """Explain a rejected dependency graph in terms of the uploaded file.

    Built from ``exc.reason``/``exc.offending`` rather than ``str(exc)``: the
    exception's own message is a domain signal ("Infeasible task graph
    (cyclic_dependency): ['2', '5', '2']") carrying an internal reason code and
    a list repr in uid space. The uploader needs the rows of their spreadsheet,
    and needs the two reasons distinguished — a self-referencing row is a
    different edit from a multi-row loop.
    """
    rows = [_uid_to_row(uid) for uid in exc.offending]
    if exc.reason == "self_reference" and rows:
        return f"The Predecessors column on {rows[0]} lists that same row as its own predecessor."
    if rows:
        return (
            "The Predecessors column forms a circular dependency: "
            f"{' -> '.join(rows)}. Break the loop and re-upload."
        )
    return "The Predecessors column forms a circular dependency. Break the loop and re-upload."


def _record_summary(import_request_id: str, summary: dict[str, Any]) -> None:
    """Persist the terminal summary the launching Schedule polls for."""
    from trueppm_api.apps.csvimport.models import CsvImportRequest

    CsvImportRequest.objects.filter(id=import_request_id).update(result_summary=summary)


def _mark_import_dead(import_request_id: str, detail: str = "") -> None:
    """Flip the row to DEAD after a terminal failure and clear the payload.

    DEAD is excluded from orphan-drain recovery, so a deterministically bad file
    (unreadable, or a cyclic predecessor column) is not re-dispatched forever.
    The detail is persisted rather than only logged: an async import failure has
    to be visible on the Schedule that launched it (#2151), and the summary is
    the only surface that outlives the worker.
    """
    from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus

    CsvImportRequest.objects.filter(id=import_request_id).exclude(
        status=CsvImportStatus.DONE
    ).update(
        status=CsvImportStatus.DEAD,
        file_content_b64="",
        result_summary={"error": detail or "The file could not be imported."},
    )


@idempotent_task(
    lock_key_template="drain_csv_import_queue",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="csv.drain_import_queue",
)
def drain_csv_import_queue(self: object) -> None:
    """Dispatch pending CsvImportRequest rows; recover orphaned dispatched rows.

    Runs every 30 seconds via Celery Beat. Recovers dispatched rows older than
    ``_IMPORT_ORPHAN_MINUTES`` (worker died mid-import).
    """
    _do_csv_import_drain()


def _do_csv_import_drain() -> None:
    """Business logic for drain_csv_import_queue — extracted for testability."""
    from django.utils import timezone

    from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus

    now = timezone.now()
    orphan_cutoff = now - timedelta(minutes=_IMPORT_ORPHAN_MINUTES)
    pending_cutoff = now - timedelta(minutes=_DRAIN_MIN_AGE_MINUTES)

    recovered = CsvImportRequest.objects.filter(
        status=CsvImportStatus.DISPATCHED,
        dispatched_at__lt=orphan_cutoff,
    ).update(status=CsvImportStatus.PENDING, celery_task_id="")
    if recovered:
        logger.warning("drain_csv_import_queue: recovered %d orphaned row(s)", recovered)

    pending = list(
        CsvImportRequest.objects.filter(
            status=CsvImportStatus.PENDING,
            requested_at__lt=pending_cutoff,
        )
    )
    dispatched = 0
    for req in pending:
        try:
            result = import_csv.delay(
                project_id=str(req.project_id),
                file_content_b64=req.file_content_b64,
                filename=req.filename,
                column_map=req.column_map,
                initiated_by_id=req.initiated_by_id,
                import_request_id=str(req.id),
            )
        except Exception:
            logger.warning(
                "drain_csv_import_queue: broker unavailable — CsvImportRequest %s stays pending",
                req.id,
            )
            continue
        CsvImportRequest.objects.filter(id=req.id, status=CsvImportStatus.PENDING).update(
            status=CsvImportStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=now,
        )
        dispatched += 1

    if dispatched or recovered:
        logger.info("drain_csv_import_queue: dispatched=%d recovered=%d", dispatched, recovered)
