"""#1544 — the program-rollup KPI counts have partial indexes to read."""

from __future__ import annotations

from django.db import connection

from trueppm_api.apps.projects.models import Task


def test_task_meta_declares_rollup_kpi_partial_indexes() -> None:
    by_name = {i.name: i for i in Task._meta.indexes}
    assert by_name["task_proj_critical_idx"].fields == ["project"]
    assert by_name["task_proj_float_idx"].fields == ["project", "total_float"]
    for name in ("task_proj_critical_idx", "task_proj_float_idx"):
        assert by_name[name].condition is not None


def test_rollup_kpi_indexes_exist_in_database(db: object) -> None:
    with connection.cursor() as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'projects_task' "
            "AND indexname IN ('task_proj_critical_idx', 'task_proj_float_idx')"
        )
        assert {r[0] for r in cur.fetchall()} == {"task_proj_critical_idx", "task_proj_float_idx"}
