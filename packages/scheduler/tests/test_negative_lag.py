"""Valid negative-lag (lead / fast-track) scheduling — forward pass (#848).

test_robustness.py covers the *rejection* of an out-of-range negative lag; this
covers the accepted case, where a lead pulls the successor earlier in calendar
time (including back across a weekend) and is floored at the project start.
Kept in its own file to stay clear of the large, churning test_engine.py.
"""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler import Calendar, Dependency, DependencyType, Project, Task, schedule


def _chain(lag_days: int, a_duration: int = 3) -> dict[str, object]:
    """A(a_duration) ─FS(lag)─► B(2), project anchored Monday 2026-03-02."""
    project = Project(
        id="t",
        name="t",
        start_date=date(2026, 3, 2),  # Monday
        calendar=Calendar(),
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=a_duration)),
            Task(id="B", name="B", duration=timedelta(days=2)),
        ],
        dependencies=[
            Dependency("A", "B", dep_type=DependencyType.FS, lag=timedelta(days=lag_days)),
        ],
    )
    return {t.id: t for t in schedule(project).tasks}


def test_negative_lag_pulls_successor_earlier() -> None:
    # A: Mon 2 → Wed 4-Mar. Lag 0 ⇒ B starts Thu 5; a 2-day lead ⇒ Tue 3-Mar,
    # i.e. B overlaps A (fast-track).
    assert _chain(0)["B"].early_start == date(2026, 3, 5)
    assert _chain(-2)["B"].early_start == date(2026, 3, 3)
    assert _chain(-2)["B"].early_start < _chain(0)["B"].early_start


def test_negative_lag_walks_back_across_a_weekend() -> None:
    # A: Mon 2 → Fri 6-Mar. Lag 0 ⇒ B starts Mon 9. A 1-day lead lands on the
    # Sunday and resolves back to the Friday working day, not forward to Monday.
    assert _chain(0, a_duration=5)["B"].early_start == date(2026, 3, 9)
    assert _chain(-1, a_duration=5)["B"].early_start == date(2026, 3, 6)


def test_large_negative_lag_is_floored_at_project_start() -> None:
    # A lead larger than the slack to the project start cannot move B before the
    # project's own start date.
    assert _chain(-10)["B"].early_start == date(2026, 3, 2)
