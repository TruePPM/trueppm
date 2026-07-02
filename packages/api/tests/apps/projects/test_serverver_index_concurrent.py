"""The two hot-table sync indexes exist after migrations (#1015).

Migration 0100 rebuilds ``task_proj_serverver_idx`` and ``dep_pred_serverver_idx``
with ``CREATE INDEX CONCURRENTLY`` so a 0.4 rolling deploy never takes a
write-blocking ShareLock. We assert the *outcome* — both composite indexes are
present on their tables after the full migration run — rather than importing the
migration module (CLAUDE.md migration rule 3: never couple a test to a migration
file name, which a squash deletes).
"""

from __future__ import annotations

import pytest
from django.db import connection

pytestmark = pytest.mark.django_db


def _index_def(name: str) -> str | None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT indexdef FROM pg_indexes WHERE indexname = %s", [name])
        row = cursor.fetchone()
    return row[0] if row else None


def test_task_serverver_index_present_and_composite() -> None:
    ddl = _index_def("task_proj_serverver_idx")
    assert ddl is not None, "task_proj_serverver_idx missing after migrate"
    assert "projects_task" in ddl
    assert "project_id" in ddl and "server_version" in ddl


def test_dependency_serverver_index_present_and_composite() -> None:
    ddl = _index_def("dep_pred_serverver_idx")
    assert ddl is not None, "dep_pred_serverver_idx missing after migrate"
    assert "projects_dependency" in ddl
    assert "predecessor_id" in ddl and "server_version" in ddl
