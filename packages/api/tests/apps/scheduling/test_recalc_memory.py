"""Memory held by a full CPM recalculation stays bounded per task (#3831).

The Celery worker's memory limit, not time, is what caps the largest project or
program a recalculation can schedule, so a regression here is an OOM kill in
production rather than a slow test. The figures behind the bounds are in the
commit that added this file and in ``administration/sizing.md``.

Both checks use ``tracemalloc`` (Python allocations), not RSS: RSS depends on the
allocator, the host and whatever ran earlier in the process, and would make the
bound flaky. Traced peak is deterministic enough to hold a generous bound.
"""

from __future__ import annotations

import tracemalloc
from datetime import date
from typing import Any

import pytest

from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Task,
    bulk_create_tasks,
)
from trueppm_api.apps.scheduling import tasks as sched_tasks

MONDAY = date(2026, 1, 5)

_N_TASKS = 2000
"""Big enough that the write-back runs four full batches, small enough to stay fast."""

_PEAK_KIB_PER_TASK = 18
"""Traced peak of a first-ever pass, per task. Measured at 2,000 tasks: 21.1 KiB
before #3831 (Django building every batch's ``CASE WHEN`` tree up front), 14.1 KiB
after. The bound sits between them, about 25% above the fixed figure, so unrelated
growth has room and the old shape still fails. Per-task cost falls as the project
grows (fixed overhead amortizes): 11.0 KiB at 4,000 and 9.3 KiB at 8,000."""


class _RecordingManager:
    def __init__(self) -> None:
        self.calls: list[tuple[list[Any], list[str], int | None]] = []

    def bulk_update(self, objs: Any, fields: Any, batch_size: int | None = None) -> int:
        self.calls.append((list(objs), list(fields), batch_size))
        return len(objs)


def test_bulk_update_in_batches_hands_django_one_batch_per_call() -> None:
    """Each ``bulk_update`` call gets at most one batch, so Django never holds more.

    Passing ``batch_size`` alone is not enough: Django's ``bulk_update`` builds the
    expression tree for every batch before it executes the first one.
    """
    size = sched_tasks._WRITEBACK_BATCH_SIZE
    objs = list(range(2 * size + 7))
    manager = _RecordingManager()

    sched_tasks._bulk_update_in_batches(manager, objs, ("early_start", "is_critical"))

    assert [len(o) for o, _, _ in manager.calls] == [size, size, 7]
    assert [x for o, _, _ in manager.calls for x in o] == objs, "rows dropped or reordered"
    assert all(f == ["early_start", "is_critical"] for _, f, _ in manager.calls)
    assert all(bs == size for _, _, bs in manager.calls)


def test_bulk_update_in_batches_with_no_rows_issues_no_call() -> None:
    manager = _RecordingManager()
    sched_tasks._bulk_update_in_batches(manager, [], ["is_driving"])
    assert manager.calls == []


def _flat_chain_project(n: int) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="Memory", start_date=MONDAY, status_date=MONDAY, calendar=calendar
    )
    rows = bulk_create_tasks(
        [
            Task(
                project=project,
                name=f"T{i}",
                short_id=f"{i + 1:08X}",
                wbs_path=str(i + 1),
                duration=1 + i % 7,
            )
            for i in range(n)
        ],
        batch_size=1000,
    )
    Project.objects.filter(pk=project.pk).update(object_sequence=n)
    edges = [
        Dependency(predecessor=rows[i - 1], successor=rows[i], server_version=1)
        for i in range(1, n)
    ]
    # A side link every tenth row so the network is not a bare chain.
    edges += [
        Dependency(predecessor=rows[i - 5], successor=rows[i], dep_type="SS", server_version=1)
        for i in range(10, n, 10)
    ]
    Dependency.objects.bulk_create(edges, batch_size=1000)
    return project


def _traced_peak_bytes(project_id: str) -> int:
    tracemalloc.start()
    try:
        base, _ = tracemalloc.get_traced_memory()
        sched_tasks._run_schedule(project_id)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    return peak - base


@pytest.mark.django_db
def test_first_pass_recalc_peak_per_task_is_bounded() -> None:
    """A first-ever pass moves every row, the write-back's worst case."""
    project = _flat_chain_project(_N_TASKS)
    assert Task.objects.filter(project=project, early_start__isnull=False).count() == 0

    peak = _traced_peak_bytes(str(project.pk))

    written = Task.objects.filter(project=project, early_start__isnull=False).count()
    assert written == _N_TASKS, "fixture premise: the pass writes every row"
    per_task_kib = peak / _N_TASKS / 1024
    assert per_task_kib < _PEAK_KIB_PER_TASK, (
        f"full recalc traced peak is {per_task_kib:.1f} KiB/task at {_N_TASKS} tasks; "
        f"bound is {_PEAK_KIB_PER_TASK}. Something on the recalc path now holds O(N) "
        "memory it did not before — see #3831 for how to profile it."
    )
