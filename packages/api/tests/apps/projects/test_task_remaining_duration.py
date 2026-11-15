"""``TaskSerializer.remaining_duration`` is the engine's remaining-work rule (#5034).

The served value and the engine's early dates must name the same window (ADR-0752
§2): the web rebuilds ``early_start`` from ``remaining_duration``. The serializer
therefore calls the scheduler's ``_elapsed_working_days`` rather than restating it,
and these tests pin the cases where a float restatement drifted from the engine.
Unsaved ``Task`` instances: the method reads two fields and touches no database.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from trueppm_scheduler import Task as EngineTask
from trueppm_scheduler.engine import _effective_duration_days

from trueppm_api.apps.projects.models import Task
from trueppm_api.apps.projects.serializers import TaskSerializer


def _remaining(duration: int | None, pct: float | None) -> int:
    return TaskSerializer().get_remaining_duration(
        Task(duration=duration, percent_complete=pct)  # type: ignore[misc]
    )


@pytest.mark.parametrize(
    ("duration", "pct", "remaining"),
    [
        (375, 18.4, 306),  # float math gave 307: int(375 * 18.4 / 100.0) == 68
        (9, 11.11111111111111, 8),  # 1 of 9 days done (100 * 1 / 9)
        (6, 83.33333333333333, 1),  # 5 of 6 days done (100 * 5 / 6)
        (10, 45.0, 6),  # whole percents unchanged: floor(4.5) elapsed
        (10, 0.0, 10),
        (10, None, 10),
        (None, 50.0, 0),
        (10, 100.0, 0),
        (10, 150.0, 0),  # clamped, never negative
    ],
)
def test_remaining_duration_follows_the_engine_rule(
    duration: int | None, pct: float | None, remaining: int
) -> None:
    assert _remaining(duration, pct) == remaining


@pytest.mark.parametrize(("duration", "pct"), [(5, 99.99999999999999), (1, 99.9999999), (2, 99.5)])
def test_an_open_task_keeps_at_least_one_remaining_day(duration: int, pct: float) -> None:
    """Below 100% a task with work is open, so it has a day left (ADR-0132)."""
    assert _remaining(duration, pct) >= 1


def test_the_served_value_is_the_engine_value_on_every_k_of_n_percent() -> None:
    """One implementation: the serializer agrees with the engine wherever they could drift."""
    for n in range(1, 60):
        for k in range(n + 1):
            pct = 100 * k / n
            engine_task = EngineTask(
                id="t", name="t", duration=timedelta(days=n), percent_complete=pct
            )
            assert _remaining(n, pct) == _effective_duration_days(engine_task), (n, k)
            assert _remaining(n, pct) == n - k
