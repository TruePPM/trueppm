"""Celery queue topology: which tasks run on the ``heavy`` queue (#2276).

Every task used to share Celery's single default queue, so a multi-minute MS
Project import or workspace export sat in front of the 30-second outbox drains
and notification email behind it. Routing the long-running, memory-hungry tasks
to their own queue lets an operator give them their own worker (and scale it on
queue depth) without a burst of imports starving the latency-sensitive work.

Pure constants, no Django import: ``settings/base.py`` reads this at settings
load, long before the app registry exists.
"""

from __future__ import annotations

#: Celery's built-in default queue name, kept explicit so a worker started with
#: no ``-Q`` flag still consumes exactly what it did before the split.
DEFAULT_QUEUE = "celery"

#: Default name of the heavy queue. Override with ``TRUEPPM_CELERY_HEAVY_QUEUE``;
#: setting it to :data:`DEFAULT_QUEUE` collapses routing back to a single queue
#: (the escape hatch for a worker fleet you cannot give ``-Q heavy``).
DEFAULT_HEAVY_QUEUE = "heavy"

#: Tasks that run for minutes or hold large buffers. Light tasks (outbox
#: drains, notification/invite email, webhook delivery, the small per-table
#: periodic sweeps such as ``scheduling.purge_old_schedule_requests``, WebSocket
#: fan-out) are deliberately absent: an unrouted task lands on the default
#: queue, which is also where enterprise-registered tasks go.
#:
#: Heavy by the same test (a multi-minute ``soft_time_limit`` whose length
#: grows with project size, and no user waiting on it within seconds):
#: the program-wide merged CPM pass, the soft-delete child cascade (every task,
#: edge, sprint, risk and baseline of a project) and the nightly retention
#: coordinator, which hard-deletes trashed projects across six tables.
#:
#: Per-edit CPM (``recalculate_schedule``) is heavy too, and that is a trade-off
#: rather than a free win: with a dedicated heavy worker, a recalc queued behind
#: a multi-minute import waits for it, so the head-of-line delay moves from
#: email to schedule freshness. It stays here because a 10,000-task recalc
#: holds a worker child for tens of seconds — on the light queue a burst of them
#: (a bulk edit across projects) would occupy the few children the 30-second
#: outbox drains and email need — and because
#: the program pass it escalates to must share its queue, or a project with
#: cross-program edges would refresh on a different clock from one without.
#: The operator-side mitigation (heavy-worker headroom, KEDA) is in the sizing
#: guide, "Worker topology and queue-depth autoscaling".
HEAVY_TASKS: tuple[str, ...] = (
    "msproject.import_file",
    "jira.import_file",
    "csv.import_file",
    "projects.run_project_export",
    "projects.run_program_export",
    "projects.run_program_import",
    "workspace.run_workspace_export",
    "scheduling.run_monte_carlo_simulation",
    "templates.apply",
    # layering-ok: a Celery task NAME (this task has no short name=), not an import
    "trueppm_api.apps.scheduling.tasks.recalculate_schedule",
    # layering-ok: a Celery task NAME (this task has no short name=), not an import
    "trueppm_api.apps.scheduling.tasks.recalculate_program_schedule",
    "projects.cascade_project_soft_delete",
    "retention.run_purge",
)


def build_task_routes(heavy_queue: str) -> dict[str, dict[str, str]]:
    """Return a ``CELERY_TASK_ROUTES`` mapping sending :data:`HEAVY_TASKS` to ``heavy_queue``.

    Args:
        heavy_queue: Queue name for heavy tasks. Equal to :data:`DEFAULT_QUEUE`
            means "do not split": the routes still name the queue explicitly,
            so the topology is visible in ``celery inspect`` output.

    Returns:
        A routes dict keyed by task name.
    """
    return {name: {"queue": heavy_queue} for name in HEAVY_TASKS}
