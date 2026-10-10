"""Shared helper for the repo's ``CREATE INDEX CONCURRENTLY`` migrations (#4357).

``CREATE INDEX CONCURRENTLY`` does not roll back on failure the way an ordinary
DDL statement does: if the build is interrupted partway through, PostgreSQL
leaves the index present but marked ``INVALID`` (the planner ignores it, but
every write still pays to maintain it). Under `migrate_locked` at
``replicaCount >= 2`` (the shipped default), every pod's init container races
an advisory lock for the one migration run; if the lock-holding pod dies
mid-build (OOM, eviction, node drain), the next pod to win the lock reruns the
*same* migration. The `IF NOT EXISTS` guard on the `CREATE INDEX CONCURRENTLY`
sees an index of that name already present, skips it, and the migration is
recorded applied — so the index is permanently INVALID and unused by the
planner, with nothing surfacing an error.

This module extracts the repair as a function so a test can call it directly
without importing a migration module by name, which a squash would delete
(CLAUDE.md migration rule 3) — the same pattern `projects.backfill` uses for
0148's repair step.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations


def repair_invalid_concurrent_index(connection: Any, index_name: str) -> None:
    """Drop ``index_name`` with ``DROP INDEX CONCURRENTLY`` if it is INVALID.

    No-op when the index does not exist, or exists and is valid — safe to run
    ahead of every ``CREATE INDEX CONCURRENTLY IF NOT EXISTS`` build of the same
    name, on every migrate, not just a crash-recovery run.

    ``DROP INDEX CONCURRENTLY`` cannot run inside a transaction block or a
    ``DO`` block (PostgreSQL executes a ``DO`` body as a single implicit
    transaction), so this takes a bare connection and issues the statement
    directly over a cursor — the caller must be a ``RunPython`` operation in an
    ``atomic = False`` migration, matching the forward build it precedes.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM pg_class c "
            "JOIN pg_index i ON i.indexrelid = c.oid "
            "WHERE c.relname = %s AND NOT i.indisvalid",
            [index_name],
        )
        if cursor.fetchone() is not None:
            # `index_name` is always a hardcoded module-level constant from the
            # calling migration (see repair_invalid_concurrent_index_op below),
            # never request- or user-derived input — DDL identifiers can't be
            # bound as query parameters, so quoting is the only option anyway.
            # nosemgrep: formatted-sql-query,sqlalchemy-execute-raw-query
            cursor.execute(f'DROP INDEX CONCURRENTLY IF EXISTS "{index_name}";')


def repair_invalid_concurrent_index_op(index_name: str) -> migrations.RunPython:
    """Build the ``RunPython`` migration operation wrapping the repair above.

    Place this immediately before the existing
    ``CREATE INDEX CONCURRENTLY IF NOT EXISTS`` ``RunSQL`` operation for the
    same index name. The reverse is a no-op: tearing an INVALID index back down
    is not meaningful on a rollback, and the forward build that follows this
    operation already makes the index valid again on the next `migrate`.

    ``atomic=False`` is passed explicitly (on top of the migration's own
    ``atomic = False``) so Django's executor never wraps this operation in an
    implicit transaction on a backend where that would otherwise happen — see
    ``Migration.apply()``'s ``atomic_operation`` check.
    """

    def _forward(apps: Any, schema_editor: Any) -> None:
        repair_invalid_concurrent_index(schema_editor.connection, index_name)

    return migrations.RunPython(_forward, migrations.RunPython.noop, atomic=False)
