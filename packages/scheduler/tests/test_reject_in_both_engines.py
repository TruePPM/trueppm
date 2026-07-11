"""Reject-in-both-engines validation parity (#1817, #1818).

Two inputs used to be *accepted* by both engines but scheduled *differently*, a
silent Python↔Rust divergence: duplicate ``(predecessor, successor)`` edges (Python's
DiGraph keeps the last, Rust's petgraph applies all) and sub-day durations/lags
(Python floors ``timedelta.days``, Rust rounds ``seconds/86400``). Rather than pick a
shared rounding/merge rule, both engines now *reject* these up front, so they can
never disagree. The cross-engine rejection is asserted by the shared fixtures under
``fixtures/invalid/`` (``duplicate_edge``, ``fractional_duration``, ``fractional_lag``,
plus the #1826 Rust-catch-up cases); these tests pin the Python side and, crucially,
the good paths — that a whole-day project (including a whole-day negative lead lag) is
*not* over-rejected.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    Dependency,
    DependencyType,
    InvalidScheduleInput,
    Project,
    Task,
    schedule,
)


def _project(tasks: list[Task], deps: list[Dependency]) -> Project:
    return Project(id="p", name="p", start_date=date(2026, 4, 1), tasks=tasks, dependencies=deps)


def _task(tid: str, td: timedelta, **kw: object) -> Task:
    return Task(id=tid, name=tid, duration=td, **kw)  # type: ignore[arg-type]


# --- #1817: duplicate edges -------------------------------------------------


def test_duplicate_pred_succ_edge_rejected() -> None:
    deps = [
        Dependency("A", "B", dep_type=DependencyType.FS),
        Dependency("A", "B", dep_type=DependencyType.SS, lag=timedelta(days=1)),
    ]
    with pytest.raises(InvalidScheduleInput, match="Duplicate dependency"):
        schedule(_project([_task("A", timedelta(days=5)), _task("B", timedelta(days=3))], deps))


def test_reverse_pair_is_not_a_duplicate_but_forms_a_cycle() -> None:
    """A->B and B->A are distinct edges (keyed on the ordered pair), so the duplicate
    guard does not fire; they form a cycle, which is rejected as such."""
    from trueppm_scheduler import CyclicDependencyError

    deps = [
        Dependency("A", "B", dep_type=DependencyType.FS),
        Dependency("B", "A", dep_type=DependencyType.FS),
    ]
    with pytest.raises(CyclicDependencyError):
        schedule(_project([_task("A", timedelta(days=2)), _task("B", timedelta(days=2))], deps))


# --- #1818: fractional durations / lags -------------------------------------


@pytest.mark.parametrize(
    "bad",
    [timedelta(days=1, hours=12), timedelta(hours=36), timedelta(hours=-10), timedelta(minutes=90)],
)
def test_fractional_duration_rejected(bad: timedelta) -> None:
    with pytest.raises(InvalidScheduleInput, match="whole number of days"):
        schedule(_project([_task("A", bad)], []))


def test_fractional_pert_estimate_rejected() -> None:
    t = _task(
        "A",
        timedelta(days=3),
        optimistic_duration=timedelta(days=1, hours=6),
        most_likely_duration=timedelta(days=3),
        pessimistic_duration=timedelta(days=5),
    )
    with pytest.raises(InvalidScheduleInput, match="whole number of days"):
        schedule(_project([t], []))


def test_fractional_lag_rejected() -> None:
    deps = [Dependency("A", "B", dep_type=DependencyType.SS, lag=timedelta(hours=12))]
    with pytest.raises(InvalidScheduleInput, match="whole number of days"):
        schedule(_project([_task("A", timedelta(days=2)), _task("B", timedelta(days=2))], deps))


# --- good paths must NOT be over-rejected -----------------------------------


def test_whole_day_project_still_schedules() -> None:
    deps = [Dependency("A", "B", dep_type=DependencyType.FS, lag=timedelta(days=2))]
    result = schedule(
        _project([_task("A", timedelta(days=5)), _task("B", timedelta(days=3))], deps)
    )
    assert result.project_finish == date(2026, 4, 14)


def test_whole_day_negative_lead_lag_still_allowed() -> None:
    """A negative *whole-day* lag is a valid lead, not a fractional value; it must
    still schedule (only sub-day lags are rejected)."""
    deps = [Dependency("A", "B", dep_type=DependencyType.FS, lag=timedelta(days=-2))]
    result = schedule(
        _project([_task("A", timedelta(days=5)), _task("B", timedelta(days=3))], deps)
    )
    assert result.project_finish == date(2026, 4, 8)


def test_zero_lag_and_zero_duration_milestone_still_allowed() -> None:
    deps = [Dependency("A", "B", dep_type=DependencyType.FS)]
    result = schedule(_project([_task("A", timedelta(days=4)), _task("B", timedelta(0))], deps))
    assert result.project_finish is not None
