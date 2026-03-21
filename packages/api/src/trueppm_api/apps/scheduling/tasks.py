"""Celery tasks for the scheduling app."""

from __future__ import annotations

from trueppm_api.celery import app


@app.task
def recalculate_schedule(project_id: str) -> None:
    """Rerun the CPM engine for a project and persist the updated output fields.

    Triggered by transaction.on_commit() after any Task or Dependency write so
    the schedule stays consistent without blocking the HTTP response.

    Phase 1 stub — CPM integration with the trueppm_scheduler engine will be
    wired in Phase 2 once the scheduling engine API is stabilised.
    """
    # TODO(phase-2): load project tasks and dependencies, run
    # trueppm_scheduler.engine.schedule(), and write CPM output fields back to
    # Task rows via a bulk_update.
    pass
