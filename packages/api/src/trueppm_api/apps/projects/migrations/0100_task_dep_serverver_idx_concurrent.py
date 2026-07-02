"""Concurrent (non-locking) build for the two hot-table sync indexes.

``task_proj_serverver_idx`` (``projects_task``) and ``dep_pred_serverver_idx``
(``projects_dependency``) were added in 0053 with a plain ``AddIndex``, which
compiles to ``CREATE INDEX`` and holds a ShareLock that blocks writes
(``INSERT``/``UPDATE``/``DELETE``) for the whole build. On the two largest tables
that is imperceptible at 0.3 alpha scale but user-visible on a 0.4 rolling
deploy against a populated database, where the old pod keeps serving writes
(#1015, the 0.4-scoped child of the #785 zero-downtime pass).

This migration re-declares the DB-side build for those two indexes as
``CREATE INDEX CONCURRENTLY``, which never blocks writes. It is intentionally
**DB-only with no ``state_operations``**: 0053 already owns both indexes in
Django's migration state, so re-adding them here would make
``makemigrations --check`` demand a ``RemoveIndex``. ``IF NOT EXISTS`` keeps the
forward build idempotent, so on any database that already applied 0053 (every
existing dev/CI/prod DB) this is a verified no-op — the indexes are never
dropped or rebuilt — while any environment that provisions these indexes fresh
against a non-empty table (restore-then-migrate, or a future squashed baseline
that routes these two builds through this migration) gets a non-locking build.

Teardown stays with 0053: the reverse is a **no-op** rather than a
``DROP INDEX``, because 0053's ``AddIndex`` still owns the state and will drop
each index when it is itself reversed. A ``DROP`` here would desync state from
the schema on a partial rollback.

``CREATE INDEX CONCURRENTLY`` cannot run inside a transaction, so
``atomic = False`` (mirrors 0090, the repo's first concurrent-index migration).
"""

from __future__ import annotations

from django.db import migrations

_TASK_IDX = "task_proj_serverver_idx"
_DEP_IDX = "dep_pred_serverver_idx"


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("projects", "0099_apitoken_scopes"),
    ]

    operations = [
        migrations.RunSQL(
            sql=(
                f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {_TASK_IDX} "
                "ON projects_task (project_id, server_version);"
            ),
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(
            sql=(
                f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {_DEP_IDX} "
                "ON projects_dependency (predecessor_id, server_version);"
            ),
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
