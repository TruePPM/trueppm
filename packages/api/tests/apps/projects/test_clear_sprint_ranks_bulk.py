"""#1542 — closing a sprint clears sprint_rank in bulk, not one save() per task."""

from __future__ import annotations

from datetime import date

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from trueppm_api.apps.projects.models import Calendar, Project, Sprint, SprintState, Task
from trueppm_api.apps.projects.tasks import _clear_sprint_ranks


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _sprint_with_ranked_tasks(project: Project, n: int) -> tuple[Sprint, list[Task]]:
    sprint = Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )
    tasks = [
        Task.objects.create(
            project=project, name=f"T{i}", duration=1, sprint=sprint, sprint_rank=i + 1
        )
        for i in range(n)
    ]
    return sprint, tasks


def _clear_query_count(sprint: Sprint) -> int:
    with CaptureQueriesContext(connection) as ctx:
        _clear_sprint_ranks(sprint)
    return len(ctx.captured_queries)


def test_clears_ranks_keeps_history_and_bumps_counters(project: Project) -> None:
    sprint, tasks = _sprint_with_ranked_tasks(project, 3)
    before = {
        t.pk: Task.objects.values_list("server_version", "sync_seq").get(pk=t.pk) for t in tasks
    }
    project.refresh_from_db()
    watermark_before = project.last_sync_version

    _clear_sprint_ranks(sprint)

    project.refresh_from_db()
    assert project.last_sync_version == watermark_before + 1
    for i, t in enumerate(tasks):
        t.refresh_from_db()
        old_version, old_seq = before[t.pk]
        assert t.sprint_rank is None
        assert t.server_version == old_version + 1
        assert t.sync_seq == project.last_sync_version > old_seq
        # The closing rank stays queryable, and the clear wrote a null-rank row.
        assert t.history.filter(sprint_rank=i + 1).exists()
        assert t.history.filter(sprint_rank__isnull=True).exists()


def test_stamps_edited_at_so_closed_tasks_leave_untouched_seeded(project: Project) -> None:
    """The old per-task save() counted as a touch; the bulk path must too (ADR-0786)."""
    sprint, tasks = _sprint_with_ranked_tasks(project, 2)
    Task.objects.filter(pk__in=[t.pk for t in tasks]).update(edited_at=None)
    _clear_sprint_ranks(sprint)
    for t in tasks:
        t.refresh_from_db()
        assert t.edited_at is not None


def test_skips_unranked_and_deleted_tasks(project: Project) -> None:
    sprint, tasks = _sprint_with_ranked_tasks(project, 2)
    Task.objects.filter(pk=tasks[0].pk).update(sprint_rank=None)
    Task.objects.filter(pk=tasks[1].pk).update(is_deleted=True)
    version = Task.objects.get(pk=tasks[1].pk).server_version
    _clear_sprint_ranks(sprint)
    deleted = Task.objects.get(pk=tasks[1].pk)
    assert deleted.sprint_rank == 2
    assert deleted.server_version == version


def test_query_count_does_not_grow_with_task_count(project: Project) -> None:
    small_sprint, _ = _sprint_with_ranked_tasks(project, 2)
    small = _clear_query_count(small_sprint)
    big_sprint, _ = _sprint_with_ranked_tasks(project, 12)
    big = _clear_query_count(big_sprint)
    assert big == small
