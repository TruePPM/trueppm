"""The API's summary rollup equals ``trueppm_scheduler.roll_up_summary`` (#5010).

Characterization for the move into the library. The API keeps
``_rollup_one_summary`` until trueppm-scheduler 0.5 is on PyPI, because
``api:wheel-install-probe`` checks every API import against the published package
(the #4976 constraint). This file proves the two agree field for field, including
``total_float`` (the tightest leaf float) and the ``None`` result, so the later swap
is behavior-preserving. No database: both sides are pure functions.
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
