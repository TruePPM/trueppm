"""Monte Carlo percentiles carry their edge-of-day reading (#4204).

A percentile is an order statistic over the runs' working-time finish positions,
shown on a day the way ``ScheduleResult.project_finish`` is. When the finish is a
start-of-day milestone (#4079) the shown day sits past a weekend from the end of the
Friday before it with no difference in working time, so a consumer can only compare
a percentile against the CPM finish correctly if it knows which edge of the day each
one is.
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import networkx as nx
import numpy as np
import pytest
from hypothesis import example, given

from tests.test_contract_fuzz import _plausible_projects
from trueppm_scheduler import (
    Dependency,
    DependencyType,
    MonteCarloResult,
    Project,
    SchedulerError,
    Task,
    engine,
    monte_carlo,
    schedule,
)

MONDAY = date(2026, 8, 3)


def _project(
    lag_days: int,
    *,
    a_days: int = 5,
    a_estimates: tuple[float, float, float] | None = None,
    extra: list[Task] | None = None,
) -> Project:
    a = Task(id="A", name="A", duration=timedelta(days=a_days))
    if a_estimates:
        a = Task(
            id="A",
            name="A",
            duration=timedelta(days=a_days),
            optimistic_duration=timedelta(days=a_estimates[0]),
            most_likely_duration=timedelta(days=a_estimates[1]),
            pessimistic_duration=timedelta(days=a_estimates[2]),
        )
    m = Task(id="M", name="M", duration=timedelta(0))
    link = Dependency(
        predecessor_id="A",
        successor_id="M",
        dep_type=DependencyType.FS,
        lag=timedelta(days=lag_days),
    )
    return Project(
        id="p",
        name="p",
        start_date=MONDAY,
        tasks=[a, m, *(extra or [])],
        dependencies=[link],
    )


def _cpm_reading(project: Project) -> tuple[date, bool]:
    result = schedule(project)
    on_day = [t for t in result.tasks if t.early_finish == result.project_finish]
    at_start = all(t.duration == timedelta(0) and not t.milestone_at_day_end for t in on_day)
    return result.project_finish, at_start


def test_start_of_day_milestone_across_a_weekend_is_read_as_the_start_of_monday() -> None:
    """Known answer: A ends Friday, a 1-day lag lands M at the start of Monday."""
    mc = monte_carlo(_project(1), runs=20, seed=1)
    assert (mc.p50, mc.p80, mc.p95) == (date(2026, 8, 10),) * 3
    assert (mc.p50_at_day_start, mc.p80_at_day_start, mc.p95_at_day_start) == (True,) * 3


def test_end_of_friday_is_read_as_the_end_of_its_day() -> None:
    mc = monte_carlo(_project(0), runs=20, seed=1)
    assert (mc.p50, mc.p80, mc.p95) == (date(2026, 8, 7),) * 3
    assert (mc.p50_at_day_start, mc.p80_at_day_start, mc.p95_at_day_start) == (False,) * 3


@pytest.mark.parametrize("lag_days", [0, 1, 2, 3, 4])
def test_zero_variance_reproduces_the_cpm_finish_and_its_reading(lag_days: int) -> None:
    """A deterministic project's percentiles are the CPM finish, reading included."""
    project = _project(lag_days)
    mc = monte_carlo(project, runs=10, seed=3)
    expected = _cpm_reading(project)
    for day, at_start in (
        (mc.p50, mc.p50_at_day_start),
        (mc.p80, mc.p80_at_day_start),
        (mc.p95, mc.p95_at_day_start),
    ):
        assert (day, at_start) == expected


def test_work_ending_on_the_shown_day_makes_it_the_end_of_that_day() -> None:
    """A task ending Monday evening outranks the start-of-Monday milestone."""
    b = Task(id="B", name="B", duration=timedelta(days=6))
    mc = monte_carlo(_project(1, extra=[b]), runs=10, seed=1)
    assert mc.p80 == date(2026, 8, 10)
    assert mc.p80_at_day_start is False


@pytest.mark.parametrize(
    ("lag_days", "estimates", "p50_at_day_start"),
    [
        # A mostly samples under 5.5 days: the median run shows M at the start of Monday.
        (1, (5.0, 5.0, 6.0), True),
        (1, (5.0, 6.0, 12.0), None),
        (2, (5.0, 6.0, 12.0), None),
        (3, (5.0, 6.0, 12.0), None),
    ],
)
def test_each_uncertain_percentile_is_a_finish_cpm_can_produce(
    lag_days: int, estimates: tuple[float, float, float], p50_at_day_start: bool | None
) -> None:
    """Every percentile, reading included, is the CPM finish of some sampled duration.

    ``A`` samples within its estimate band, so each run's finish is exactly what
    :func:`schedule` gives for ``A`` at that whole-day duration: sometimes the end of
    a day, sometimes (the lag landing on a weekend) the start of a Monday. A
    percentile taken over shown days with no reading could not name which; one taken
    over working-time positions must be one of those CPM finishes.
    """
    mc = monte_carlo(_project(lag_days, a_estimates=estimates), runs=400, seed=7)
    assert mc.p50 <= mc.p80 <= mc.p95
    if p50_at_day_start is not None:
        assert mc.p50_at_day_start is p50_at_day_start
    cpm = {_cpm_reading(_project(lag_days, a_days=n)) for n in range(5, 13)}
    for reading in (
        (mc.p50, mc.p50_at_day_start),
        (mc.p80, mc.p80_at_day_start),
        (mc.p95, mc.p95_at_day_start),
    ):
        assert reading in cpm


def test_to_dict_carries_the_readings_and_defaults_are_end_of_day() -> None:
    mc = monte_carlo(_project(1), runs=5, seed=1)
    out = mc.to_dict()
    assert out["p50_at_day_start"] is True
    assert out["p80_at_day_start"] is True
    assert out["p95_at_day_start"] is True
    legacy = MonteCarloResult(
        project_id="p", runs=1, p50=MONDAY, p80=MONDAY, p95=MONDAY, distribution=[MONDAY]
    )
    assert (legacy.p50_at_day_start, legacy.p80_at_day_start, legacy.p95_at_day_start) == (
        False,
        False,
        False,
    )


# ---------------------------------------------------------------------------
# Properties over random projects: the percentiles stay quantiles of
# ``distribution``, and nothing moves for a project with no start-of-day finish.
# ---------------------------------------------------------------------------

_QUANTILES = ((0.50, "p50"), (0.80, "p80"), (0.95, "p95"))
_PROPERTY_RUNS = 64


def _simulate(project: Project) -> MonteCarloResult | None:
    try:
        return monte_carlo(project, runs=_PROPERTY_RUNS, seed=5, max_runs=None, max_tasks=None)
    except SchedulerError:
        return None


def _mixed_reading_project(most_likely_days: int = 5) -> Project:
    """Runs at one working-time position split between the end of Friday and the start of Monday.

    ``W`` always ends Friday. ``A`` samples 4..5 days: at 4 it ends Thursday and the
    1-day lag lands ``M`` at the end of Friday; at 5 it ends Friday and the lag lands
    ``M`` on Sunday, shown at the start of Monday. Every run finishes at the same
    working-time position. With ``A``'s most-likely at 5 about 96% of runs are shown
    on the Monday; at 4, about 96% on the Friday.
    """
    w = Task(id="W", name="W", duration=timedelta(days=5))
    a = Task(
        id="A",
        name="A",
        duration=timedelta(days=4),
        optimistic_duration=timedelta(days=4),
        most_likely_duration=timedelta(days=most_likely_days),
        pessimistic_duration=timedelta(days=5),
    )
    m = Task(id="M", name="M", duration=timedelta(0))
    link = Dependency(
        predecessor_id="A", successor_id="M", dep_type=DependencyType.FS, lag=timedelta(days=1)
    )
    return Project(id="p", name="p", start_date=MONDAY, tasks=[w, a, m], dependencies=[link])


def test_a_position_shared_by_friday_and_monday_runs_is_shown_on_the_monday() -> None:
    """Showing the Friday put P50 below its own quantile: 4% of runs on or before it."""
    mc = monte_carlo(_mixed_reading_project(), runs=200, seed=1)
    assert set(mc.distribution) == {date(2026, 8, 7), date(2026, 8, 10)}
    for day, at_start in (
        (mc.p50, mc.p50_at_day_start),
        (mc.p80, mc.p80_at_day_start),
        (mc.p95, mc.p95_at_day_start),
    ):
        assert (day, at_start) == (date(2026, 8, 10), True)


def test_a_few_monday_runs_do_not_drag_the_percentiles_onto_the_monday() -> None:
    """Mostly-Friday split: 193 runs end Friday, 7 start Monday; every percentile is Friday.

    Taking the latest reading at the position put P95 on the Monday with 96.5% of
    runs strictly before it.
    """
    mc = monte_carlo(_mixed_reading_project(most_likely_days=4), runs=200, seed=1)
    fri, mon = date(2026, 8, 7), date(2026, 8, 10)
    assert set(mc.distribution) == {fri, mon}
    assert mc.distribution.count(mon) < 0.05 * len(mc.distribution)
    for day, at_start in (
        (mc.p50, mc.p50_at_day_start),
        (mc.p80, mc.p80_at_day_start),
        (mc.p95, mc.p95_at_day_start),
    ):
        assert (day, at_start) == (fri, False)


@example(project=_mixed_reading_project())
@example(project=_mixed_reading_project(most_likely_days=4))
@given(project=_plausible_projects())
def test_each_percentile_is_a_quantile_of_the_distribution(project: Project) -> None:
    """PXX is a two-sided quantile of ``distribution`` (#4204).

    At least XX% of runs are shown on or before it, and fewer than XX% (plus one
    run) strictly before it.

    ``distribution`` places each run on its shown day, and the histogram, the
    confidence curve and the detail panel's P80 highlight all read it. A percentile
    shown on the Friday while the runs at its working-time position show the Monday
    would sit below its own quantile; one shown on the Monday because a handful of
    runs there do would sit above it. The ``1 / runs`` slack is numpy's linear
    interpolation between two ranks, not a tolerance on the rule.
    """
    mc = _simulate(project)
    if mc is None:
        return
    n = len(mc.distribution)
    for q, name in _QUANTILES:
        day = getattr(mc, name)
        share = sum(1 for d in mc.distribution if d <= day) / n
        assert share >= q - 1 / n, f"{name}={day} but only {share:.1%} of runs are on or before it"
        before = sum(1 for d in mc.distribution if d < day) / n
        assert before < q + 1 / n, f"{name}={day} but {before:.1%} of runs are strictly before it"


@given(project=_plausible_projects())
def test_no_start_of_day_finish_reports_the_pre_4204_dates(project: Project) -> None:
    """Without a start-of-day finish, ranking by working time is ranking by shown day.

    Captures the per-run offsets :func:`_mc_percentiles` receives and replays the
    pre-#4204 rule on them — ``numpy.percentile`` over the SHOWN offsets, mapped
    through the same index — so the comparison is against the old algorithm itself,
    not a re-derivation of it.
    """
    captured: list[tuple[np.ndarray, np.ndarray, list[date], date | None]] = []
    real = engine._mc_percentiles

    def spy(
        completion: np.ndarray,
        shown: np.ndarray,
        wd_index: list[date],
        floor: date | None,
        floor_at_start: bool,
    ) -> list[tuple[date, bool]]:
        captured.append((completion, shown, wd_index, floor))
        return real(completion, shown, wd_index, floor, floor_at_start)

    with patch.object(engine, "_mc_percentiles", spy):
        mc = _simulate(project)
    if mc is None:
        return
    completion, shown, wd_index, floor = captured[0]
    if (np.rint(shown) > np.rint(completion)).any() or (
        mc.p50_at_day_start or mc.p80_at_day_start or mc.p95_at_day_start
    ):
        return
    old = [
        engine._offset_to_date(float(o), wd_index, floor)
        for o in np.percentile(shown, [50, 80, 95])
    ]
    assert [mc.p50, mc.p80, mc.p95] == old


_WD = [MONDAY + timedelta(days=i) for i in range(5)]  # Mon..Fri
_WD_ORD = np.array([d.toordinal() for d in _WD], dtype=np.int64)


class TestIndexOverrunIsRefused:
    """An offset past a working-day index end raises; it is never clamped (#4429).

    The clamp onto the last indexed day is what let an undersized index report a
    plausible, silently early finish. The index is now sized to hold every reachable
    offset, so these paths are a backstop that a correct bound never reaches — which
    is why they are pinned directly rather than through ``monte_carlo()``.
    """

    def test_offset_to_date_refuses_past_the_end(self) -> None:
        # Exclusive EF == len is the last indexed day; one past it is off the index.
        assert engine._offset_to_date(5.0, _WD, None) == _WD[-1]
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            engine._offset_to_date(6.0, _WD, None)

    def test_lag_term_refuses_past_the_end(self) -> None:
        delta = np.zeros(5, dtype=np.int32)
        assert engine._lag_term(delta, np.array([4.0])).tolist() == [0.0]
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            engine._lag_term(delta, np.array([1.0, 5.0]))

    def test_reference_offset_refuses_past_the_end(self) -> None:
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            engine._to_reference_offset(np.array([6.0]), _WD_ORD, _WD_ORD)

    def test_index_offset_refuses_a_date_past_the_end(self) -> None:
        offset_of = {d: i for i, d in enumerate(_WD)}
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            engine._index_offset(_WD[-1] + timedelta(days=3), offset_of, _WD)

    def test_milestone_lookups_refuse_past_the_end(self) -> None:
        idx = engine._McIndex([_WD_ORD], [engine.Calendar(working_days=0b0011111)])
        past = np.array([_WD_ORD[-1] + 3], dtype=np.int64)
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            idx.next_wd_offset(0, past)
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            idx.ordinal_at(0, np.array([5.0]))
        assert idx.prev_wd_ordinal(0, _WD_ORD[-1:]).tolist() == [int(_WD_ORD[-1])]
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            idx.prev_wd_ordinal(0, past)

    def test_lag_delta_snap_past_the_successor_index_is_refused(self) -> None:
        # FS +10 from the last cells snaps past a 5-day index: stored as the overrun
        # sentinel, and refused only when a run actually reads that cell.
        k = np.arange(5, dtype=np.float64)
        delta = engine._build_lag_delta(
            DependencyType.FS, timedelta(days=10), _WD_ORD, _WD_ORD, k, 5, 4, 0
        )
        assert (delta == engine._LAG_DELTA_OVERRUN).any()
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            engine._lag_term(delta, np.array([4.0]))

    def test_floor_snaps_refuse_past_the_end(self) -> None:
        offset_of = {d: i for i, d in enumerate(_WD)}
        cal = engine.Calendar(working_days=0b0011111)
        assert engine._snapped_offset(_WD[0], cal, offset_of, 4.0) == 0.0
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            engine._snapped_offset(_WD[-1] + timedelta(days=3), cal, offset_of, 4.0)

    def test_sf_linked_floor_snap_refuses_past_the_end(self) -> None:
        # _mc_es_floors' own snap, taken only by an SF-linked task (#4218).
        cal = engine.Calendar(working_days=0b0011111)
        task = Task(id="B", name="B", duration=timedelta(days=1), planned_start=_WD[-1])
        project = Project(id="p", name="p", start_date=MONDAY, tasks=[task])
        key = id(cal)
        args = (project, {"B": task}, {"B": cal}, {"B": key})
        offset_of = {key: {d: i for i, d in enumerate(_WD)}}
        assert engine._mc_es_floors(*args, offset_of, {key: _WD}, frozenset({"B"}))["B"] == 4.0
        late = Task(
            id="B", name="B", duration=timedelta(days=1), planned_start=_WD[-1] + timedelta(days=3)
        )
        with pytest.raises(engine.InvalidScheduleInput, match="engine bug"):
            engine._mc_es_floors(
                project,
                {"B": late},
                {"B": cal},
                {"B": key},
                offset_of,
                {key: _WD},
                frozenset({"B"}),
            )


def _horizon(project: Project) -> date:
    """``engine._mc_horizon`` for a single-calendar ``project``."""
    g = engine._build_graph(project)
    topo = list(nx.lexicographical_topological_sort(g, key=str))
    return engine._mc_horizon(
        project, {t.id: t for t in project.tasks}, g, topo, {t: project.calendar for t in topo}
    )


def _chain(**b_fields: object) -> Project:
    """``A`` (5d) -FS-> ``B`` (5d) on a Mon-Fri week starting ``MONDAY``.

    ``lag``, ``dep_type`` and ``status_date`` go to the link / project; every other
    keyword is a field of ``B``.
    """
    lag = b_fields.pop("lag", timedelta(0))
    dep_type = b_fields.pop("dep_type", DependencyType.FS)
    status_date = b_fields.pop("status_date", None)
    return Project(
        id="p",
        name="p",
        start_date=MONDAY,
        tasks=[
            Task(id="A", name="A", duration=timedelta(days=5)),
            Task(id="B", name="B", duration=timedelta(days=5), **b_fields),  # type: ignore[arg-type]
        ],
        dependencies=[Dependency("A", "B", dep_type=dep_type, lag=lag)],  # type: ignore[arg-type]
        status_date=status_date,  # type: ignore[arg-type]
    )


class TestMcHorizon:
    """Direct checks of the calendar-date bound the Monte Carlo index is sized to (#4429).

    Each input that can push a finish later — a positive lag, an SNET pin, the data
    date, a far-future recorded actual — must move the horizon on its own, and the
    horizon must never precede what ``schedule()`` computes for the same project.
    """

    def test_baseline_covers_the_deterministic_finish(self) -> None:
        project = _chain()
        assert _horizon(project) >= schedule(project).project_finish

    def test_positive_lag_extends_the_horizon(self) -> None:
        lagged = _chain(lag=timedelta(days=40))
        a_finish = next(t for t in schedule(lagged).tasks if t.id == "A").early_finish
        assert a_finish is not None
        # B cannot start until 40 calendar days after A finishes.
        assert _horizon(lagged) >= a_finish + timedelta(days=40)
        assert _horizon(lagged) > _horizon(_chain())
        assert _horizon(lagged) >= schedule(lagged).project_finish

    def test_snet_pin_extends_the_horizon(self) -> None:
        pin = MONDAY + timedelta(days=200)
        pinned = _chain(planned_start=pin)
        # Five working days laid out from the pin: at least four calendar days later.
        assert _horizon(pinned) >= pin + timedelta(days=4)
        assert _horizon(pinned) >= schedule(pinned).project_finish

    def test_status_date_extends_the_horizon(self) -> None:
        status = MONDAY + timedelta(days=150)
        floored = _chain(status_date=status)
        assert _horizon(floored) >= status + timedelta(days=4)
        assert _horizon(floored) >= schedule(floored).project_finish

    def test_far_future_actual_finish_extends_the_horizon(self) -> None:
        finish = MONDAY + timedelta(days=400)
        done = _chain(actual_start=MONDAY + timedelta(days=7), actual_finish=finish)
        assert _horizon(done) >= finish
        assert _horizon(done) >= schedule(done).project_finish


class TestMcIndexSize:
    """``_mc_index_size`` counts the DENSEST calendar's working days to the horizon."""

    def test_sized_by_the_densest_calendar(self) -> None:
        horizon = MONDAY + timedelta(days=69)  # ten full weeks
        mondays = engine.Calendar(working_days=0b0000001)
        seven = engine.Calendar(working_days=0b1111111)
        assert engine._mc_index_size(horizon, MONDAY, [mondays], 0) == 10 + 30
        assert engine._mc_index_size(horizon, MONDAY, [mondays, seven], 0) == 70 + 30
        assert engine._mc_index_size(horizon, MONDAY, [seven], 3) == 70 + 3 + 30

    def test_every_calendar_index_reaches_the_horizon(self) -> None:
        horizon = MONDAY + timedelta(days=69)
        cals = [
            engine.Calendar(working_days=0b0000001),
            engine.Calendar(working_days=0b0001111),
            engine.Calendar(working_days=0b1111111),
        ]
        size = engine._mc_index_size(horizon, MONDAY, cals, 0)
        for cal in cals:
            assert engine._build_working_day_index(MONDAY, cal, size)[-1] >= horizon


class TestUndersizedIndexRaisesEndToEnd:
    """Force an undersized index through ``monte_carlo()``: it must raise, never report.

    The pre-#4429 failure was exactly this — a bound too small for the project — and
    it surfaced as a plausible early date. With the bound patched down, every input
    that reaches past the index (an SNET floor, a far-future actual, a long chain)
    has to hit a backstop instead of a clamp.
    """

    @pytest.mark.parametrize(
        "b_fields",
        [
            {"planned_start": MONDAY + timedelta(days=200)},
            {"status_date": MONDAY + timedelta(days=200)},
            {
                "actual_start": MONDAY + timedelta(days=7),
                "actual_finish": MONDAY + timedelta(days=200),
            },
            {"lag": timedelta(days=200)},
            # An SF-linked task floors through _mc_es_floors' own snap (#4218 path).
            {"dep_type": DependencyType.SF, "planned_start": MONDAY + timedelta(days=200)},
        ],
        ids=["snet", "status-date", "actual-finish", "lag", "sf-snet"],
    )
    def test_patched_small_bound_raises(self, b_fields: dict[str, object]) -> None:
        project = _chain(**b_fields)
        with (
            patch.object(engine, "_mc_index_size", return_value=20),
            pytest.raises(engine.InvalidScheduleInput, match="engine bug"),
        ):
            monte_carlo(project, runs=4, seed=1)
