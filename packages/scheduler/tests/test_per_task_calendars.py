"""Per-task calendars (ADR-0120 D3) — the substrate for the program-scoped CPM pass.

A task may opt into its own working week via ``Task.calendar_id`` + a
``Project.calendars`` registry. Duration arithmetic uses the task's own calendar;
lag on an edge is consumed on the *successor's* calendar. The whole feature is
additive: a project with no ``calendars`` registry schedules byte-for-byte as it
did before, which the broader suite already proves — these tests pin the *new*
behavior and the convention's edges.

All scenarios anchor on Mon 2026-01-05 (so Sat 2026-01-10 / Sun 2026-01-11 are the
first weekend) and use two calendars: the default Mon-Fri week, and an all-seven-day
week registered as ``"seven"``.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from trueppm_scheduler.engine import InvalidScheduleInput, monte_carlo, schedule
from trueppm_scheduler.models import Calendar, Dependency, DependencyType, Project, Task

MON = date(2026, 1, 5)  # Monday — project anchor for every scenario
SEVEN = Calendar(working_days=0b111_1111)  # every weekday is a working day


def _task(tid: str, days: int, calendar_id: str | None = None, **kw: object) -> Task:
    return Task(id=tid, name=tid, duration=timedelta(days=days), calendar_id=calendar_id, **kw)


def _result(project: Project) -> dict[str, Task]:
    return {t.id: t for t in schedule(project).tasks}


def _cpm_fields(project: Project) -> dict[str, object]:
    """Project the schedule down to its *computed* fields only.

    Two projects can schedule to identical dates while differing on an input field
    like ``calendar_id``; comparing the full ``to_dict`` would flag that input
    difference. This keeps only the CPM outputs that must match.
    """
    res = schedule(project)
    return {
        "project_start": res.project_start,
        "project_finish": res.project_finish,
        "critical_path": res.critical_path,
        "tasks": {
            t.id: (
                t.early_start,
                t.early_finish,
                t.late_start,
                t.late_finish,
                t.total_float,
                t.free_float,
                t.is_critical,
            )
            for t in res.tasks
        },
    }


# ---------------------------------------------------------------------------
# Backward compatibility — the fast path must stay identical
# ---------------------------------------------------------------------------


def test_calendars_none_is_unchanged() -> None:
    """A project that declares no per-task calendars schedules exactly as before."""
    tasks = [_task("a", 6), _task("b", 3)]
    deps = [Dependency("a", "b")]
    base = schedule(Project(id="p", name="p", start_date=MON, tasks=tasks, dependencies=deps))
    # Explicit None registry — the resolver returns None and the fast path runs.
    withfield = schedule(
        Project(
            id="p",
            name="p",
            start_date=MON,
            tasks=[_task("a", 6), _task("b", 3)],
            dependencies=[Dependency("a", "b")],
            calendars=None,
        )
    )
    assert base.to_dict() == withfield.to_dict()


def test_registry_calendar_equal_to_default_matches_fast_path() -> None:
    """Opting every task into a calendar *equal to* the default reproduces the fast path.

    This is the strongest single check that the per-task code path computes the
    same numbers as the single-calendar path when the calendars happen to match —
    duration, lag snapping, and float all included, across all four dep types.
    """

    def build(*, use_registry: bool) -> Project:
        tasks = [
            _task("a", 5, "wk" if use_registry else None),
            _task("b", 3, "wk" if use_registry else None),
            _task("c", 4, "wk" if use_registry else None),
            _task("d", 2, "wk" if use_registry else None),
        ]
        deps = [
            Dependency("a", "b", DependencyType.FS, timedelta(days=2)),
            Dependency("a", "c", DependencyType.SS),
            Dependency("b", "d", DependencyType.FF, timedelta(days=1)),
            Dependency("c", "d", DependencyType.SF),
        ]
        return Project(
            id="p",
            name="p",
            start_date=MON,
            tasks=tasks,
            dependencies=deps,
            calendars={"wk": Calendar()} if use_registry else None,
        )

    assert _cpm_fields(build(use_registry=True)) == _cpm_fields(build(use_registry=False))


# ---------------------------------------------------------------------------
# Duration arithmetic uses the task's own calendar
# ---------------------------------------------------------------------------


def test_duration_spans_own_calendar() -> None:
    """A 6-day task on the 7-day week finishes before the same task on Mon-Fri.

    6 working days from Mon 01-05: Mon-Fri uses 01-05..01-09 then skips the weekend
    to finish 01-12; the 7-day week uses 01-05..01-10 and finishes on Sat 01-10.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("five", 6), _task("seven", 6, "seven")],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    assert r["five"].early_finish == date(2026, 1, 12)  # Mon-Fri skips the weekend
    assert r["seven"].early_finish == date(2026, 1, 10)  # Sat is a working day here


def test_unknown_calendar_id_falls_back_to_default() -> None:
    """A calendar_id naming no registry entry uses the pass-level calendar (no error)."""
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("ghost", 6, "does-not-exist")],
        calendars={"seven": SEVEN},
    )
    # Mon-Fri behavior (the default), not the 7-day one.
    assert _result(project)["ghost"].early_finish == date(2026, 1, 12)


# ---------------------------------------------------------------------------
# Cross-calendar FS handoff + lag-on-successor convention
# ---------------------------------------------------------------------------


def test_fs_successor_starts_on_its_own_calendar() -> None:
    """An FS successor on the 7-day week may start on a Saturday its predecessor can't.

    Pred (Mon-Fri) finishes Fri 01-09; the successor on the 7-day week starts the
    very next day, Sat 01-10 — proving the start snap uses the *successor's* week.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("pred", 5), _task("succ", 3, "seven")],
        dependencies=[Dependency("pred", "succ")],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    assert r["pred"].early_finish == date(2026, 1, 9)  # Fri
    assert r["succ"].early_start == date(2026, 1, 10)  # Sat — successor's calendar


def test_lag_is_counted_on_successor_calendar() -> None:
    """FS lag snaps on the successor's calendar, not the predecessor's.

    Pred on the 7-day week finishes Fri 01-09. With +1 day past finish and +1 day
    lag the raw date is Sun 01-11; the Mon-Fri successor snaps it forward to Mon
    01-12. If the snap used the predecessor's 7-day week it would land on Sun 01-11.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("pred", 5, "seven"), _task("succ", 2)],
        dependencies=[Dependency("pred", "succ", DependencyType.FS, timedelta(days=1))],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    assert r["pred"].early_finish == date(2026, 1, 9)  # Fri (7-day week)
    assert r["succ"].early_start == date(2026, 1, 12)  # Mon — successor's Mon-Fri snap


# ---------------------------------------------------------------------------
# The "lag on the successor's calendar" convention holds for SS / FF / SF too,
# not only FS. Each case is built so the lag lands on a Saturday: on the 7-day
# calendar Sat is a working day (the date stands); on Mon-Fri it snaps forward
# to Monday. Flipping which task carries the 7-day calendar therefore moves the
# result — proving the *successor's* calendar governs the snap.
# ---------------------------------------------------------------------------


def _xcal(dep_type: DependencyType, lag_days: int, *, succ_seven: bool) -> dict[str, Task]:
    """pred(5) ─dep(lag)─► succ(2). One task on the 7-day week, the other Mon-Fri."""
    pred_cal = None if succ_seven else "seven"
    succ_cal = "seven" if succ_seven else None
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("pred", 5, pred_cal), _task("succ", 2, succ_cal)],
        dependencies=[Dependency("pred", "succ", dep_type, timedelta(days=lag_days))],
        calendars={"seven": SEVEN},
    )
    return _result(project)


def test_ss_lag_snaps_on_successor_calendar() -> None:
    # SS: succ.ES = pred.ES (Mon 01-05) + 5 cal days = Sat 01-10.
    # Successor on 7-day week ⇒ Sat is a working day ⇒ starts Sat 01-10.
    # Successor on Mon-Fri ⇒ Sat snaps forward to Mon 01-12.
    assert _xcal(DependencyType.SS, 5, succ_seven=True)["succ"].early_start == date(2026, 1, 10)
    assert _xcal(DependencyType.SS, 5, succ_seven=False)["succ"].early_start == date(2026, 1, 12)


def test_ff_lag_snaps_on_successor_calendar() -> None:
    # FF: succ.EF = pred.EF (Fri 01-09) + 1 cal day = Sat 01-10.
    # 7-day successor finishes Sat 01-10; Mon-Fri successor snaps to Mon 01-12.
    assert _xcal(DependencyType.FF, 1, succ_seven=True)["succ"].early_finish == date(2026, 1, 10)
    assert _xcal(DependencyType.FF, 1, succ_seven=False)["succ"].early_finish == date(2026, 1, 12)


def test_sf_lag_snaps_on_successor_calendar() -> None:
    # SF: succ.EF = pred.ES (Mon 01-05) + 5 cal days = Sat 01-10.
    # 7-day successor finishes Sat 01-10; Mon-Fri successor snaps to Mon 01-12.
    assert _xcal(DependencyType.SF, 5, succ_seven=True)["succ"].early_finish == date(2026, 1, 10)
    assert _xcal(DependencyType.SF, 5, succ_seven=False)["succ"].early_finish == date(2026, 1, 12)


# ---------------------------------------------------------------------------
# Backward pass snaps against the task's OWN calendar (issue #1490)
# ---------------------------------------------------------------------------


def test_backward_pass_snaps_predecessor_late_dates_on_its_own_calendar() -> None:
    """A predecessor's late_finish/late_start must snap on ITS OWN calendar.

    ``pred`` (7-day week, dur 2) starting Fri 01-02 works through the weekend and
    finishes Sat 01-03 — a day its Mon-Fri ``succ`` cannot act on, so ``succ`` still
    starts Mon 01-05 regardless. The FS constraint the backward pass derives for
    ``pred``'s own late_finish must therefore snap to a working day on ``pred``'s
    7-day calendar, not ``succ``'s Mon-Fri calendar: the raw constraint (succ's
    late_start minus 1 day) is Sun 01-04, which is a working day on the 7-day
    calendar (so it stands) but is *not* a working day on Mon-Fri (where it would
    wrongly snap backward to Fri 01-02 — a date before ``pred.early_finish``,
    violating the CPM invariant ``late_finish >= early_finish``).

    Regression for #1490: the bug used the successor's calendar to snap the
    predecessor's own late date, producing ``late_finish == 2026-01-02 <
    early_finish == 2026-01-03``. The fix restores the correct value, Sun 01-04,
    which gives ``pred`` one day of genuine float — real slack it has because its
    calendar includes a day the successor's calendar treats as non-working.
    """
    FRI = date(2026, 1, 2)
    project = Project(
        id="p",
        name="p",
        start_date=FRI,
        tasks=[_task("pred", 2, "seven"), _task("succ", 1)],
        dependencies=[Dependency("pred", "succ")],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    pred, succ = r["pred"], r["succ"]

    # The CPM invariant that was violated: late_finish can never precede
    # early_finish (nor late_start precede early_start) for any task.
    for t in r.values():
        assert t.late_finish >= t.early_finish
        assert t.late_start >= t.early_start

    assert pred.early_start == date(2026, 1, 2)  # Fri
    assert pred.early_finish == date(2026, 1, 3)  # Sat (7-day week works weekends)
    assert pred.late_finish == date(2026, 1, 4)  # Sun — pred's OWN calendar, not succ's
    assert pred.late_start == date(2026, 1, 3)  # Sat
    assert pred.total_float == timedelta(days=1)  # genuine slack from the calendar mismatch

    assert succ.early_start == date(2026, 1, 5)  # Mon — succ's Mon-Fri calendar, unaffected
    assert succ.late_start == succ.early_start
    assert succ.total_float == timedelta(days=0)
    assert succ.is_critical


# ---------------------------------------------------------------------------
# Criticality stays program-true across a calendar boundary
# ---------------------------------------------------------------------------


def test_cross_calendar_chain_is_critical() -> None:
    """A single FS chain across two calendars carries zero total float end-to-end.

    The whole point of ADR-0120: the cross-calendar critical path is honest. A
    lone chain has no slack anywhere, so every task must be critical regardless of
    which calendar it sits on.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4), _task("b", 3, "seven"), _task("c", 2)],
        dependencies=[Dependency("a", "b"), Dependency("b", "c")],
        calendars={"seven": SEVEN},
    )
    result = schedule(project)
    r = {t.id: t for t in result.tasks}
    assert r["a"].is_critical and r["b"].is_critical and r["c"].is_critical
    assert result.critical_path == ["a", "b", "c"]
    for t in result.tasks:
        assert t.total_float >= timedelta(0)
        assert t.free_float >= timedelta(0)


def test_slack_task_off_critical_path_has_float() -> None:
    """A short parallel branch on a different calendar reports positive total float."""
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("start", 1), _task("long", 10), _task("short", 2, "seven"), _task("end", 1)],
        dependencies=[
            Dependency("start", "long"),
            Dependency("start", "short"),
            Dependency("long", "end"),
            Dependency("short", "end"),
        ],
        calendars={"seven": SEVEN},
    )
    r = _result(project)
    assert r["long"].is_critical
    assert not r["short"].is_critical
    assert r["short"].total_float > timedelta(0)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_registry_calendar_with_empty_mask_is_rejected() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 2, "broken")],
        calendars={"broken": Calendar(working_days=0)},
    )
    with pytest.raises(InvalidScheduleInput, match="broken"):
        schedule(project)


def test_non_string_calendar_id_is_rejected() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 2, 123)],  # type: ignore[arg-type]
        calendars={"seven": SEVEN},
    )
    with pytest.raises(InvalidScheduleInput, match="calendar_id"):
        schedule(project)


# ---------------------------------------------------------------------------
# Monte Carlo honors per-task calendars (#1385)
# ---------------------------------------------------------------------------
#
# The load-bearing assertion in this section is the documented contract that a
# FULLY DETERMINISTIC project — no three-point estimates, no velocity signal —
# simulates to precisely the CPM finish date. That makes schedule() an
# independent oracle for monte_carlo() on exactly the arithmetic per-task
# calendars change: if the simulation snapped any date on the wrong calendar, the
# two would disagree. Before #1385 this pass refused a per-task-calendar project
# outright (#1566), so a program-scoped plan had a deterministic date and no
# probabilistic band at all.


@pytest.mark.parametrize("dep_type", list(DependencyType))
@pytest.mark.parametrize("lag_days", [0, 2, -1])
def test_monte_carlo_matches_cpm_across_calendars(dep_type: DependencyType, lag_days: int) -> None:
    """A deterministic cross-calendar edge simulates to exactly the CPM finish.

    Covers every dependency type at zero, positive, and negative lag. Zero lag is
    the case that would regress first: within one calendar a lag-free FS/SS/FF edge
    takes a "no adjustment" short-circuit, and reusing that across two calendars
    would propagate a predecessor offset into a working-day space where it means a
    different date.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4), _task("b", 3, "seven")],
        dependencies=[Dependency("a", "b", dep_type, timedelta(days=lag_days))],
        calendars={"seven": SEVEN},
    )
    expected = schedule(project).project_finish
    res = monte_carlo(project, runs=64, seed=7)
    assert res.p50 == expected
    assert res.p80 == expected
    assert res.p95 == expected


def test_monte_carlo_matches_cpm_both_edge_directions() -> None:
    """The conversion is directional: seven-day → Mon-Fri must work too.

    The predecessor's offset is read in its own space and the snap lands in the
    successor's. A conversion that silently used one calendar for both would still
    pass the Mon-Fri → seven-day case for some inputs, so pin the reverse.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4, "seven"), _task("b", 3), _task("c", 2, "seven")],
        dependencies=[
            Dependency("a", "b", DependencyType.FS, timedelta(days=1)),
            Dependency("b", "c", DependencyType.FS, timedelta(days=1)),
        ],
        calendars={"seven": SEVEN},
    )
    expected = schedule(project).project_finish
    res = monte_carlo(project, runs=64, seed=3)
    assert res.p50 == expected == res.p95


def test_monte_carlo_off_calendar_task_can_own_the_finish() -> None:
    """The project maximum is taken in a shared space, not on raw offsets.

    Two parallel tasks on different calendars reach the same offset at different
    dates. Taking ``max`` on unconverted offsets would pick whichever column held
    the larger *number* rather than the later *date* — here the Mon-Fri task holds
    the later date at the smaller offset.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("slow", 11), _task("fast", 13, "seven")],
        calendars={"seven": SEVEN},
    )
    det = schedule(project)
    # Pin the premise: the seven-day task holds the LARGER working-day offset (13
    # vs 11) but the EARLIER finish date, so a max over raw offsets picks the wrong
    # column and reports the project finishing two days early.
    tasks = {t.id: t for t in det.tasks}
    assert tasks["slow"].early_finish > tasks["fast"].early_finish
    res = monte_carlo(project, runs=64, seed=11)
    assert res.p50 == det.project_finish


def test_monte_carlo_honors_snet_and_status_date_per_calendar() -> None:
    """A SNET pin and the data date snap on the pinned task's OWN calendar.

    Both floors land on a Saturday, which the seven-day calendar honors verbatim
    and the Mon-Fri calendar pushes to the following Monday. A single project-wide
    floor would move both tasks to the same offset.
    """
    saturday = date(2026, 1, 10)
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        status_date=saturday,
        tasks=[_task("weekday", 3, planned_start=saturday), _task("weekend", 3, "seven")],
        calendars={"seven": SEVEN},
    )
    det = schedule(project)
    tasks = {t.id: t for t in det.tasks}
    assert tasks["weekend"].early_start == saturday
    assert tasks["weekday"].early_start == date(2026, 1, 12)  # snapped to Monday
    assert monte_carlo(project, runs=32, seed=5).p50 == det.project_finish


def test_monte_carlo_keeps_verbatim_actual_finish_on_off_calendar_task() -> None:
    """A completed task's recorded finish is truth, even on its own non-working day.

    ADR-0136: schedule() keeps ``actual_finish`` verbatim. The working-day index
    cannot represent a non-working day, so the raw date is carried separately —
    and with per-task calendars "non-working" is a per-calendar question.
    """
    sunday = date(2026, 1, 11)
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("done", 4, percent_complete=100.0, actual_finish=sunday)],
        calendars={"seven": SEVEN},
    )
    det = schedule(project)
    assert det.project_finish == sunday
    assert monte_carlo(project, runs=16, seed=1).p50 == sunday


@pytest.mark.parametrize("dep_type", list(DependencyType))
def test_monte_carlo_completed_predecessor_constrains_across_calendars(
    dep_type: DependencyType,
) -> None:
    """A completed task's constraint on a successor snaps on the SUCCESSOR's calendar.

    The intersection of #2461 and #1385: a completed predecessor's dates cross the
    edge as verbatim ``date``s (they must — a non-working actual has no offset), and
    the snap that turns them into the successor's constraint therefore has to happen
    on the successor's calendar, the same rule ``_forward_pass`` applies to a live
    predecessor. Here ``a``'s recorded finish is a Sunday that its own Mon-Fri
    calendar does not work, while ``b`` runs a seven-day week and *can* start on it —
    so resolving the snap on the predecessor's (or the project's) calendar pushes
    ``b`` to the Monday and the two passes disagree.
    """
    sunday = date(2026, 1, 11)
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[
            _task("a", 4, percent_complete=100.0, actual_finish=sunday),
            _task("b", 3, "seven"),
        ],
        dependencies=[Dependency("a", "b", dep_type, timedelta(days=1))],
        calendars={"seven": SEVEN},
    )
    det = schedule(project)
    res = monte_carlo(project, runs=64, seed=13)
    assert res.p50 == det.project_finish
    assert res.p95 == det.project_finish


def test_monte_carlo_completed_predecessor_on_seven_day_week_drives_weekday_successor() -> None:
    """The reverse direction: completed on the seven-day week, live successor Mon-Fri.

    ``a`` finishes verbatim on a Saturday it legitimately worked; ``b`` cannot start
    until the Monday. Reading the constraint in ``a``'s space and forgetting to
    convert would land ``b`` a working day early.
    """
    saturday = date(2026, 1, 10)
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[
            _task("a", 5, "seven", percent_complete=100.0, actual_finish=saturday),
            _task("b", 3),
        ],
        dependencies=[Dependency("a", "b", DependencyType.FS, timedelta(days=0))],
        calendars={"seven": SEVEN},
    )
    det = schedule(project)
    tasks = {t.id: t for t in det.tasks}
    # Pin the premise: the completed finish really is a non-working day for the
    # successor, so the snap is observable rather than a no-op.
    assert tasks["a"].early_finish == saturday
    assert tasks["b"].early_start == date(2026, 1, 12)  # Monday
    res = monte_carlo(project, runs=64, seed=17)
    assert res.p50 == det.project_finish
    assert res.p95 == det.project_finish


def test_monte_carlo_completed_task_floor_survives_the_reference_conversion() -> None:
    """The verbatim-finish floor is a date, so the union-index remap cannot move it.

    A completed task holding the project finish on its own non-working day, in a
    project that *also* has a live task on another calendar — so the multi-calendar
    reference conversion runs. The floor is applied after that conversion and in
    date space, which is what keeps it immune to the remap.
    """
    sunday = date(2026, 1, 25)
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[
            _task("done", 4, percent_complete=100.0, actual_finish=sunday),
            _task("live", 3, "seven"),
        ],
        calendars={"seven": SEVEN},
    )
    det = schedule(project)
    assert det.project_finish == sunday
    res = monte_carlo(project, runs=64, seed=23)
    assert res.p50 == sunday
    assert res.p95 == sunday


def test_monte_carlo_per_task_calendars_are_seed_reproducible() -> None:
    """A fixed seed still pins P50/P80/P95 once calendars vary per task."""
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[
            _task(
                "a",
                4,
                optimistic_duration=timedelta(days=2),
                pessimistic_duration=timedelta(days=9),
                most_likely_duration=timedelta(days=4),
            ),
            _task("b", 3, "seven"),
        ],
        dependencies=[Dependency("a", "b")],
        calendars={"seven": SEVEN},
    )
    first = monte_carlo(project, runs=256, seed=42)
    second = monte_carlo(project, runs=256, seed=42)
    assert (first.p50, first.p80, first.p95) == (second.p50, second.p80, second.p95)
    assert first.distribution == second.distribution


def test_monte_carlo_stochastic_band_brackets_the_cpm_finish() -> None:
    """With estimates in play the band is ordered and sits at or past the CPM date.

    The deterministic pass is the optimistic single date; the distribution it sits
    in cannot start before it.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[
            _task(
                "a",
                5,
                optimistic_duration=timedelta(days=3),
                most_likely_duration=timedelta(days=5),
                pessimistic_duration=timedelta(days=15),
            ),
            _task("b", 4, "seven"),
        ],
        dependencies=[Dependency("a", "b")],
        calendars={"seven": SEVEN},
    )
    cpm_finish = schedule(project).project_finish
    res = monte_carlo(project, runs=2000, seed=9)
    assert res.p50 <= res.p80 <= res.p95
    assert res.p50 >= cpm_finish


def test_monte_carlo_registry_resolving_to_one_calendar_is_unchanged() -> None:
    """A registry every task ignores must simulate identically to no registry.

    ``Project.calendars`` being non-empty is not by itself a mixed-calendar
    project; the fast path keys on the resolved calendars, not the declaration.
    """
    tasks = [_task("a", 4), _task("b", 3)]
    deps = [Dependency("a", "b", DependencyType.FS, timedelta(days=2))]
    bare = Project(id="p", name="p", start_date=MON, tasks=tasks, dependencies=deps)
    with_registry = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4), _task("b", 3)],
        dependencies=[Dependency("a", "b", DependencyType.FS, timedelta(days=2))],
        calendars={"seven": SEVEN},  # declared, but no task opts in
    )
    a = monte_carlo(bare, runs=128, seed=17)
    b = monte_carlo(with_registry, runs=128, seed=17)
    assert (a.p50, a.p80, a.p95) == (b.p50, b.p80, b.p95)
    assert a.distribution == b.distribution


def test_monte_carlo_unknown_calendar_id_falls_back_like_schedule() -> None:
    """A stray ``calendar_id`` falls back to the pass-level calendar, never errors.

    ``_resolve_task_calendars`` treats an unknown id as a fall-back rather than a
    validation failure; the simulation must agree with the deterministic pass.
    """
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4, "nope"), _task("b", 3, "seven")],
        dependencies=[Dependency("a", "b")],
        calendars={"seven": SEVEN},
    )
    assert monte_carlo(project, runs=32, seed=2).p50 == schedule(project).project_finish


# ---------------------------------------------------------------------------
# Serialization round-trip
# ---------------------------------------------------------------------------


def test_round_trip_preserves_per_task_calendars() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4), _task("b", 3, "seven")],
        dependencies=[Dependency("a", "b")],
        calendars={"seven": SEVEN},
    )
    restored = Project.from_dict(project.to_dict())
    assert restored.calendars is not None
    assert restored.calendars["seven"].working_days == 0b111_1111
    assert restored.tasks[1].calendar_id == "seven"
    # The restored project schedules to the same dates as the original.
    assert schedule(restored).to_dict() == schedule(project).to_dict()


def test_json_round_trip_with_calendars() -> None:
    project = Project(
        id="p",
        name="p",
        start_date=MON,
        tasks=[_task("a", 4, "seven")],
        calendars={"seven": SEVEN},
    )
    restored = Project.from_json(project.to_json())
    assert restored.calendars is not None and "seven" in restored.calendars
    assert restored.tasks[0].calendar_id == "seven"


def test_to_dict_omits_calendars_when_absent() -> None:
    """The serialized form carries an explicit null when no registry is set."""
    project = Project(id="p", name="p", start_date=MON, tasks=[_task("a", 2)])
    assert project.to_dict()["calendars"] is None
