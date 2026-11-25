"""The CPM write-back persists only the rows a pass actually changed (#4096).

A recalc recomputes every scheduled task, but rewriting rows whose values did not
change takes a row lock and leaves a dead tuple on each one. These tests count the
rows the write-back UPDATE touches, and hold the invariant the narrowing rests on:
every persisted column is part of the changed-row comparison.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import date
from itertools import pairwise
from typing import Any

import pytest
from django.db import connection

from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling import tasks as sched_tasks

MONDAY = date(2026, 1, 5)


@contextmanager
def _writeback_rows() -> Iterator[list[int]]:
    """Collect the rowcount of every CPM ``bulk_update`` of ``projects_task``."""
    counts: list[int] = []

    def _wrapper(
        execute: Callable[..., Any], sql: str, params: Any, many: bool, context: dict[str, Any]
    ) -> Any:
        result = execute(sql, params, many, context)
        if (
            sql.startswith('UPDATE "projects_task" SET')
            and '"milestone_at_day_end" = ' in sql
            and "CASE WHEN" in sql
        ):
            counts.append(context["cursor"].rowcount)
        return result

    with connection.execute_wrapper(_wrapper):
        yield counts


def _chain(length: int) -> tuple[Project, list[Task]]:
    """A project holding one FS chain, plus one short unconnected side task."""
    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="Chain", start_date=MONDAY, status_date=MONDAY, calendar=calendar
    )
    tasks = [
        Task.objects.create(project=project, name=f"T{i}", duration=2, wbs_path=str(i + 1))
        for i in range(length)
    ]
    for pred, succ in pairwise(tasks):
        Dependency.objects.create(predecessor=pred, successor=succ)
    tasks.append(
        Task.objects.create(project=project, name="Side", duration=1, wbs_path=str(length + 1))
    )
    return project, tasks


def test_every_write_field_is_snapshotted() -> None:
    """A write column missing from the comparison would never be persisted on its own."""
    assert set(sched_tasks._CPM_WRITE_FIELDS) <= set(sched_tasks._CPM_DELTA_FIELDS)
    assert "duration" in sched_tasks._CPM_DELTA_FIELDS  # summary duration (#3530)


@pytest.mark.django_db
def test_rename_writes_no_cpm_rows() -> None:
    project, tasks = _chain(5)
    with _writeback_rows() as first:
        sched_tasks._run_schedule(str(project.pk))
    assert sum(first) == len(tasks), "fixture premise: the first pass writes every row"

    tasks[0].refresh_from_db()
    tasks[0].name = "Renamed"
    tasks[0].save()
    with _writeback_rows() as second:
        sched_tasks._run_schedule(str(project.pk))

    assert sum(second) == 0


@pytest.mark.django_db
def test_duration_change_writes_only_the_affected_rows() -> None:
    """Lengthening the last chain task moves it and re-floats only the side task."""
    project, tasks = _chain(5)
    sched_tasks._run_schedule(str(project.pk))
    before = {t.pk: _cpm_values(t.pk) for t in tasks}

    tail = Task.objects.get(pk=tasks[4].pk)
    tail.duration = 4
    tail.save()
    with _writeback_rows() as counts:
        sched_tasks._run_schedule(str(project.pk))

    changed = {pk for pk, values in before.items() if _cpm_values(pk) != values}
    # The upstream chain tasks keep their dates and zero float.
    assert changed == {tasks[4].pk, tasks[5].pk}
    assert sum(counts) == len(changed)


@pytest.mark.django_db
def test_summary_duration_still_persists() -> None:
    """A summary row whose rolled-up duration changes is written (#3530)."""
    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="WBS", start_date=MONDAY, status_date=MONDAY, calendar=calendar
    )
    phase = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
    leaf = Task.objects.create(project=project, name="Leaf", duration=2, wbs_path="1.1")
    sched_tasks._run_schedule(str(project.pk))

    leaf.refresh_from_db()
    leaf.duration = 7
    leaf.save()
    sched_tasks._run_schedule(str(project.pk))

    phase.refresh_from_db()
    assert phase.duration == 7


def _cpm_values(pk: Any) -> tuple[Any, ...]:
    return Task.objects.values_list(*sched_tasks._CPM_WRITE_FIELDS).get(pk=pk)
