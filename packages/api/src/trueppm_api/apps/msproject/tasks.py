"""Celery tasks for MS Project import."""

from __future__ import annotations

import base64
import logging
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

from celery import shared_task

logger = logging.getLogger(__name__)


class _NoOpTracker:
    """Fallback when TaskRunTracker is not available."""

    task_run_id = None

    def update(self, pct: int, msg: str = "") -> None:
        logger.info("import.msproject progress: %d%% -- %s", pct, msg)

    def set_result(self, result: dict[str, Any]) -> None:
        logger.info("import.msproject result: %s", result)


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
            task_name="import.msproject",
            initiated_by_id=initiated_by_id,
        ) as tracker:
            yield tracker
    except ImportError:
        yield _NoOpTracker()


@shared_task(bind=True, name="msproject.import_file")  # type: ignore[untyped-decorator]
def import_msproject(
    self: Any,
    project_id: str,
    file_content_b64: str,
    filename: str,
    initiated_by_id: int | None = None,
) -> dict[str, Any]:
    """Import an MS Project file (.mpp or .xml) into an existing project.

    The file content is passed as base64-encoded string to avoid binary
    issues with the Celery/Redis message broker.

    After import, triggers a CPM recalculation.
    """
    with _get_tracker(self, project_id, initiated_by_id) as tracker:
        file_content = base64.b64decode(file_content_b64)
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

        tracker.update(5, f"Parsing {filename}...")

        if ext == "mpp":
            from trueppm_api.apps.msproject.parser import parse_mpp

            project_data = parse_mpp(file_content)
        elif ext == "xml":
            from trueppm_api.apps.msproject.parser import parse_xml

            project_data = parse_xml(file_content)
        else:
            raise ValueError(f"Unsupported file format: .{ext}. Expected .mpp or .xml")

        from trueppm_api.apps.msproject.importer import import_project

        summary = import_project(project_id, project_data, tracker=tracker)
        tracker.set_result(summary)

        if summary["tasks_created"] > 0:
            # Use the outbox service rather than a direct .delay() call so that
            # a broker outage at import-completion time does not silently drop
            # the recalculation.  The Celery task context has no ambient
            # transaction, so enqueue_recalculate opens its own atomic() block.
            from trueppm_api.apps.scheduling.services import enqueue_recalculate

            enqueue_recalculate(project_id)

    return summary
