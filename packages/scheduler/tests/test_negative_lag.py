"""Valid negative-lag (lead / fast-track) scheduling — forward pass (#848).

test_robustness.py covers the *rejection* of an out-of-range negative lag; this
covers the accepted case, where a lead pulls the successor earlier in calendar
time (including back across a weekend) and is floored at the project start.
Kept in its own file to stay clear of the large, churning test_engine.py.
"""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler import Calendar, Dependency, DependencyType, Project, Task, schedule


def _chain(
    lag_days: int,
    a_duration: int = 3,
    dep_type: DependencyType = DependencyType.FS,
    a_planned_start: date | None = None,
) -> dict[str, object]:
    """A(a_duration) ─dep(lag)─► B(2), project anchored Monday 2026-03-02.

    ``a_planned_start`` pins A later than the project start so a lead on the edge
    has slack to pull B back through (without it, A sits on the project-start floor
    and every lead is immediately re-floored, hiding the snap direction).
    """
    project = Project(
        id="t",
        name="t",
        start_date=date(2026, 3, 2),  # Monday
        calendar=Calendar(),
        tasks=[
            Task(
                id="A",
                name="A",
                duration=timedelta(days=a_duration),
                planned_start=a_planned_start,
            ),
            Task(id="B", name="B", duration=timedelta(days=2)),
        ],
        dependencies=[
            Dependency("A", "B", dep_type=dep_type, lag=timedelta(days=lag_days)),
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


# ---------------------------------------------------------------------------
# Leads on SS / FF / SF edges (not just FS). The MC==CPM parity fuzzes cover
# these only jointly, so a shared wrong convention would pass both; these pin
# the exact date against the DOCUMENTED forward-snap rule (ADR-0114: "date
# offsets that land on a non-working day snap *forward* to the next working
# day"). ``A`` is pinned to Mon 2026-03-09 so a lead has room to pull B back.
# ---------------------------------------------------------------------------

PS = date(2026, 3, 9)  # Monday — A's planned start, one clear week past the project start


def test_ss_lead_pulls_successor_back_across_the_weekend() -> None:
    # SS anchors B.ES on A.ES (Mon 3-09). A 3-day lead lands on Fri 3-06 (a working
    # day, crossing Sat/Sun) → B starts Fri 3-06; lag 0 keeps B on Mon 3-09.
    assert _chain(0, dep_type=DependencyType.SS, a_planned_start=PS)["B"].early_start == date(
        2026, 3, 9
    )
    assert _chain(-3, dep_type=DependencyType.SS, a_planned_start=PS)["B"].early_start == date(
        2026, 3, 6
    )


def test_ss_lead_landing_on_a_weekend_snaps_forward_not_back() -> None:
    # A 2-day lead from Mon 3-09 lands on Sat 3-07. The documented convention snaps
    # *forward* to the next working day (Mon 3-09), so this 2-day lead is fully
    # absorbed by the weekend — B stays on Mon 3-09, identical to lag 0. A backward
    # snap would (wrongly) give Fri 3-06; pinning Mon 3-09 fixes the direction.
    assert _chain(-2, dep_type=DependencyType.SS, a_planned_start=PS)["B"].early_start == date(
        2026, 3, 9
    )


def test_ss_lead_is_floored_at_project_start() -> None:
    # With A on the project-start floor (Mon 3-02) and no planned start, a 5-day SS
    # lead points at Wed 2-25 but B can never precede the project's own start.
    assert _chain(-5, dep_type=DependencyType.SS)["B"].early_start == date(2026, 3, 2)


def test_ff_lead_snaps_the_finish_constraint_forward() -> None:
    # FF anchors B.EF on A.EF. A: Mon 3-09 → Wed 3-11. A 3-day lead on the finish
    # lands on Sun 3-08 and snaps *forward* to Mon 3-09, so B must finish Mon 3-09;
    # B is 2 days ⇒ starts Fri 3-06 (Fri, Mon).
    by = _chain(-3, dep_type=DependencyType.FF, a_planned_start=PS)
    assert by["B"].early_finish == date(2026, 3, 9)  # Mon (forward-snapped from Sun 3-08)
    assert by["B"].early_start == date(2026, 3, 6)  # Fri


def test_sf_lead_landing_on_a_weekend_snaps_forward_not_back() -> None:
    # SF anchors B.EF on A.ES (Mon 3-09). A 2-day lead lands on Sat 3-07 and snaps
    # forward to Mon 3-09 — identical to lag 0 (the lead is absorbed by the
    # weekend). B is 2 days ⇒ finishes Mon 3-09, starts Fri 3-06. Backward snapping
    # would (wrongly) finish Fri 3-06; pinning Mon 3-09 fixes the direction.
    lag0 = _chain(0, dep_type=DependencyType.SF, a_planned_start=PS)
    lead = _chain(-2, dep_type=DependencyType.SF, a_planned_start=PS)
    assert lag0["B"].early_finish == date(2026, 3, 9)  # Mon
    assert lag0["B"].early_start == date(2026, 3, 6)  # Fri
    assert lead["B"].early_finish == lag0["B"].early_finish  # lead absorbed by the weekend
    assert lead["B"].early_start == lag0["B"].early_start
