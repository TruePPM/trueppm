"""The API's summary rollup equals ``trueppm_scheduler.roll_up_summary`` (#5010).

Characterization for the move into the library. The API keeps
``_rollup_one_summary`` until trueppm-scheduler 0.5 is on PyPI, because
``api:wheel-install-probe`` checks every API import against the published package
(the #4976 constraint). This file proves the two agree field for field, including
``total_float`` (the tightest float over the incomplete leaves, #5183) and the
``None`` result, so the later swap is behavior-preserving. No database: both sides
are pure functions.
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from trueppm_scheduler import Task, roll_up_summary

from trueppm_api.apps.scheduling.services import _rollup_one_summary

_FIELDS = (
    "id",
    "name",
    "duration",
    "early_start",
    "early_finish",
    "late_start",
    "late_finish",
    "scheduled_start",
    "total_float",
    "free_float",
    "is_critical",
)


def _maybe_date(rng: random.Random) -> date | None:
    return None if rng.random() < 0.2 else date(2026, 1, 1) + timedelta(days=rng.randint(0, 90))


def _leaves(seed: int) -> list[Task]:
    rng = random.Random(seed)
    rows = []
    for i in range(rng.randint(0, 6)):
        task = Task(id=f"t{i}", name=f"t{i}", duration=timedelta(days=rng.randint(0, 9)))
        task.early_start = _maybe_date(rng)
        task.early_finish = _maybe_date(rng)
        task.late_start = _maybe_date(rng)
        task.late_finish = _maybe_date(rng)
        task.scheduled_start = _maybe_date(rng)
        task.total_float = timedelta(days=rng.randint(-3, 12))
        task.free_float = timedelta(days=rng.randint(0, 5))
        task.is_critical = rng.random() < 0.3
        # Completed leaves, both ways the engine reads completion (#5183): the two
        # rollups must leave them out of total_float and is_critical alike.
        done = rng.random()
        if done < 0.15:
            task.actual_finish = date(2026, 1, 1) + timedelta(days=rng.randint(0, 90))
        elif done < 0.3:
            task.percent_complete = 100.0
        elif done < 0.4:
            task.percent_complete = float(rng.randint(1, 99))
        rows.append(task)
    return rows


@pytest.mark.parametrize("seed", range(300))
def test_api_rollup_is_the_library_rollup(seed: int) -> None:
    leaves = _leaves(seed)
    named = seed % 2 == 0
    db_task_by_id = {"sum": SimpleNamespace(name="Phase")} if named else {}

    api_row = _rollup_one_summary("sum", leaves, db_task_by_id)
    lib_row = roll_up_summary("sum", leaves, name="Phase" if named else None)

    if api_row is None:
        assert lib_row is None
        return
    assert lib_row is not None
    assert {f: getattr(api_row, f) for f in _FIELDS} == {f: getattr(lib_row, f) for f in _FIELDS}


def test_both_rollups_leave_finished_work_out_of_float() -> None:
    """#5183: a finished leaf's zero float must not mask the open leaf's slack."""
    mon = date(2026, 3, 2)
    done = Task(id="a", name="a", duration=timedelta(days=2))
    done.early_start, done.early_finish = mon, mon + timedelta(days=1)
    done.actual_finish = mon + timedelta(days=1)
    done.total_float = timedelta(0)
    open_leaf = Task(id="b", name="b", duration=timedelta(days=2))
    open_leaf.early_start, open_leaf.early_finish = mon, mon + timedelta(days=1)
    open_leaf.total_float = timedelta(days=8)

    for row in (
        _rollup_one_summary("sum", [done, open_leaf], {}),
        roll_up_summary("sum", [done, open_leaf]),
    ):
        assert row is not None
        assert row.total_float == timedelta(days=8)
        assert row.is_critical is False

    for row in (_rollup_one_summary("sum", [done], {}), roll_up_summary("sum", [done])):
        assert row is not None
        assert row.total_float == timedelta(0)
        assert row.is_critical is False
