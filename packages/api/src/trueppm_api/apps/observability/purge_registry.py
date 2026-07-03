"""Binds each retention key to its purge callable and physical tables (ADR-0173).

This is the *coordinator-side* binding: it imports the domain apps' purge
functions and models, so it is imported only on the admin/coordinator path — never
by the app tasks themselves (which import the pure ``retention`` resolver). All
imports are local to keep module load order-safe under Celery autodiscovery and
to avoid any chance of an app-registry-not-ready import.

Row counts and byte sizes are PostgreSQL **estimates** (``pg_class.reltuples`` and
``pg_total_relation_size``) — fast and index-free on large tables, but approximate.
Bytes freed by a purge is derived as ``avg_row_bytes × rows`` and is best-effort
by design (ADR-0173 Consequences).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class PurgeSpec:
    """One operational table's purge callable and its physical tables.

    ``purge(*, dry_run, override_value) -> int`` returns rows deleted (or, when
    ``dry_run``, rows eligible). ``db_tables`` are the relation names summed for the
    size/byte estimates.
    """

    key: str
    purge: Callable[..., int]
    db_tables: tuple[str, ...]


def get_purge_specs() -> list[PurgeSpec]:
    """Build the ordered purge specs (display order matches RETENTION_SPECS).

    Rebuilt per call (cheap) so this stays free of module-load side effects.
    """
    from trueppm_api.apps.history.tasks import _do_history_purge
    from trueppm_api.apps.msproject.models import ImportRequest
    from trueppm_api.apps.msproject.tasks import _do_import_purge
    from trueppm_api.apps.projects.models import Dependency, Project, Task
    from trueppm_api.apps.projects.tasks import _do_project_purge
    from trueppm_api.apps.sync.models import SyncBatch
    from trueppm_api.apps.sync.tasks import _do_purge as _do_sync_purge
    from trueppm_api.apps.taskruns.models import TaskRun
    from trueppm_api.apps.taskruns.tasks import _do_taskrun_purge
    from trueppm_api.apps.webhooks.models import WebhookDelivery
    from trueppm_api.apps.webhooks.tasks import _do_webhook_purge

    return [
        PurgeSpec(
            "HISTORY_RETENTION_DAYS",
            _do_history_purge,
            (
                Project.history.model._meta.db_table,
                Task.history.model._meta.db_table,
                Dependency.history.model._meta.db_table,
            ),
        ),
        PurgeSpec("TASK_RUN_RETENTION_DAYS", _do_taskrun_purge, (TaskRun._meta.db_table,)),
        PurgeSpec(
            "TRUEPPM_WEBHOOK_RETENTION_DAYS", _do_webhook_purge, (WebhookDelivery._meta.db_table,)
        ),
        PurgeSpec(
            "TRUEPPM_IMPORT_RETENTION_DAYS", _do_import_purge, (ImportRequest._meta.db_table,)
        ),
        PurgeSpec(
            "TRUEPPM_SYNC_BATCH_RETENTION_HOURS", _do_sync_purge, (SyncBatch._meta.db_table,)
        ),
        PurgeSpec(
            "TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS",
            _do_project_purge,
            (Project._meta.db_table,),
        ),
    ]


def spec_purge_for(key: str) -> PurgeSpec:
    """Return the PurgeSpec for ``key`` (raises StopIteration if unknown)."""
    return next(spec for spec in get_purge_specs() if spec.key == key)


def estimate_table_stats(db_tables: tuple[str, ...]) -> tuple[int, int]:
    """Return ``(estimated_rows, total_bytes)`` summed across the given tables.

    Uses planner statistics, so it is O(1) regardless of table size. ``reltuples``
    can be ``-1`` before a table's first ANALYZE — clamped to 0.
    """
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COALESCE(SUM(GREATEST(c.reltuples, 0)), 0)::bigint AS est_rows,
                   COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint AS total_bytes
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = ANY(%s) AND n.nspname = 'public'
            """,
            [list(db_tables)],
        )
        row = cursor.fetchone()
    if row is None:
        return 0, 0
    return int(row[0]), int(row[1])


def estimate_freed_bytes(db_tables: tuple[str, ...], rows: int) -> int | None:
    """Best-effort bytes freed by purging ``rows`` from ``db_tables``.

    ``avg_row_bytes × rows``, where ``avg_row_bytes`` is total relation size over
    the estimated row count. Returns ``None`` when statistics are unavailable
    (never analyzed / empty table) so callers can render "—" rather than a fake 0.
    """
    if rows <= 0:
        return 0
    est_rows, total_bytes = estimate_table_stats(db_tables)
    if est_rows <= 0 or total_bytes <= 0:
        return None
    return int((total_bytes / est_rows) * rows)
