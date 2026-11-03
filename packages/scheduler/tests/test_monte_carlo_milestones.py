"""A zero-duration task with a three-point estimate in Monte Carlo (#4698).

Such a task is taken off the milestone path because some run samples work, and every
run was then floored at a full working day: a ``(0, 0, 1)`` estimate, mean 1/6 day and
mode 0, cost a day in 100% of runs. Removing only the floor is not the fix. The offset
ruler cannot say which midnight a start sits on, so a draw that rounds away would read
as work ending the working day *before* its start, and that network finishes before
its CPM date whenever a lag or a floor is involved (373 of 1,728 networks measured) or
after it when an SS link reads the next working day (102). A run whose draw rounds away
therefore has to be the instant ``schedule()`` places. A larger draw is ordinary work:
with no recorded start, the same as a task of that length with the same link.

The class is ``CELLS``: M state (3) x link into M (4) x link out of M (4) x calendar
scope (3), 144 cells, each run over the five lag/hold variants in ``VARIANTS``, so 720
networks. ``test_instant_runs_match_a_real_milestone`` then generalizes it to random
networks.

Most cases draw an exact zero so they say nothing about how a fractional finish rounds.

An FF or SF link into the task back-solves a work-sized draw, as it does for any task, so
some links out of it can read ahead of the instant (#4822). "Never before CPM" is scoped
accordingly: see ``_BACK_SOLVES_AHEAD``.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import date, timedelta
from itertools import product
from typing import Any, ClassVar
from unittest.mock import patch

import numpy as np
import pytest

from trueppm_scheduler import (
    Calendar,
    DeliveryMode,
    Dependency,
    DependencyType,
    MonteCarloResult,
    Project,
    Task,
    engine,
    monte_carlo,
    schedule,
)

# 2026-03-02 is a Monday; 03-07/03-08 and 03-14/03-15 are weekends.
START = date(2026, 3, 2)
WEEKDAYS = 0b0011111
SIX_DAY = 0b0111111
HELD_TO_A_MONDAY = date(2026, 3, 16)
VELOCITY_FF_P50 = date(2026, 4, 3)

STATES = ("live", "started", "predecessor_in_progress")
LINKS = (DependencyType.FS, DependencyType.SS, DependencyType.FF, DependencyType.SF)
SCOPES = ("project", "per_task", "only_m")
CELLS = list(product(STATES, LINKS, LINKS, SCOPES))
# (lag into M, lag out of M, M's SNET)
VARIANTS = (
    (0, 0, None),
    (1, 3, None),
    (3, 1, None),
    (0, 0, HELD_TO_A_MONDAY),
    (1, 3, HELD_TO_A_MONDAY),
)


# Link into M, link out of M: on ``VARIANTS``, a work-sized draw can finish before CPM
# (#4822). SF in, SF out belongs to the same class but needs lags ``VARIANTS`` lacks:
# see ``test_sf_in_sf_out_back_solves_ahead_only_with_longer_lags``.
_BACK_SOLVES_AHEAD = [
    (DependencyType.FF, DependencyType.SS),
    (DependencyType.FF, DependencyType.SF),
    (DependencyType.SF, DependencyType.SS),
]


def _days(n: int) -> timedelta:
    return timedelta(days=n)


def _estimate(opt: int = 0, ml: int = 0, pess: int = 1) -> dict[str, timedelta]:
    return {
        "optimistic_duration": _days(opt),
        "most_likely_duration": _days(ml),
        "pessimistic_duration": _days(pess),
    }


def _project(tasks: list[Task], deps: list[Dependency], **kw: Any) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=START,
        tasks=tasks,
        dependencies=deps,
        calendar=Calendar(working_days=WEEKDAYS),
        **kw,
    )


def _link(
    pred: str, succ: str, dep_type: DependencyType = DependencyType.FS, lag: int = 0
) -> Dependency:
    return Dependency(predecessor_id=pred, successor_id=succ, dep_type=dep_type, lag=_days(lag))


def _cell(
    state: str,
    link_in: DependencyType,
    link_out: DependencyType,
    scope: str,
    variant: tuple[int, int, date | None] = (0, 0, None),
) -> Project:
    """``A(5d) -> M(0d) -> B(5d)`` for one cell of the class."""
    lag_in, lag_out, held_to = variant
    a: dict[str, Any] = {"id": "A", "name": "A", "duration": _days(5)}
    m: dict[str, Any] = {"id": "M", "name": "M", "duration": _days(0), **_estimate()}
    b: dict[str, Any] = {"id": "B", "name": "B", "duration": _days(5)}
    kw: dict[str, Any] = {}
    if state == "started":
        m["actual_start"] = date(2026, 3, 6)
        kw["status_date"] = date(2026, 3, 6)
    elif state == "predecessor_in_progress":
        a["actual_start"] = START
        a["percent_complete"] = 40.0
        kw["status_date"] = date(2026, 3, 4)
    if held_to is not None:
        m["planned_start"] = held_to
    if scope != "project":
        kw["calendars"] = {"six": Calendar(working_days=SIX_DAY)}
        m["calendar_id"] = "six"
        if scope == "per_task":
            a["calendar_id"] = b["calendar_id"] = "six"
    return _project(
        [Task(**a), Task(**m), Task(**b)],
        [_link("A", "M", link_in, lag_in), _link("M", "B", link_out, lag_out)],
        **kw,
    )


@contextmanager
def _draws(fill: Callable[[int], np.ndarray]) -> Iterator[None]:
    """Replace every PERT column with ``fill(runs)``."""
    with patch.object(engine, "_sample_pert", lambda _o, _m, _p, n, _rng: fill(n)):
        yield


def _exact_zeros(n: int) -> np.ndarray:
    """Exact-zero draws, but for a tiny one that keeps the column off the milestone path."""
    out = np.zeros(n)
    out[-1] = 1e-9
    return out


def _constant(value: float) -> Callable[[int], np.ndarray]:
    return lambda n: np.full(n, value)


def _run(project: Project, runs: int = 64) -> MonteCarloResult:
    return monte_carlo(project, runs=runs, seed=1)


class TestReportedRepro:
    def _repro(self) -> Project:
        return _cell("live", DependencyType.FS, DependencyType.FS, "project")

    def test_a_small_estimate_does_not_cost_a_day(self) -> None:
        """#4698's acceptance criterion: a (0, 0, 1) estimate leaves P50 and P80 on CPM.

        Its Beta draws are never exactly zero, so this holds only because a zero-base
        draw under half a day rounds away whole and hands no fraction on. Without
        that, B's five days would end part-way into Monday in every run, since a
        finish is read by the day it falls in (#4697).
        """
        project = self._repro()
        cpm = schedule(project).project_finish
        assert cpm == date(2026, 3, 13)
        mc = monte_carlo(project, runs=5000, seed=1)
        assert mc.p50 == cpm
        assert mc.p80 == cpm
        # Only the draws of half a day or more are work, about 5% of runs.
        late = sum(1 for d in mc.distribution if d > cpm) / len(mc.distribution)
        assert 0.02 < late < 0.1

    def test_the_estimate_still_reaches_the_tail(self) -> None:
        project = _cell("live", DependencyType.FS, DependencyType.FS, "project")
        mc = monte_carlo(project, runs=5000, seed=1)
        assert max(mc.distribution) > schedule(project).project_finish


class TestSensitivity:
    def test_a_driving_task_is_credited_with_its_variance(self) -> None:
        """M alone moves the finish, but only by its draws of half a day or more.

        Draws below that round away (#4697), so the rank correlation is partial,
        not the 1.0 a fraction handed on to B produced.
        """
        project = _cell("live", DependencyType.FS, DependencyType.FS, "project")
        mc = monte_carlo(project, runs=2000, seed=1)
        indexes = {s.task_id: s.index for s in mc.sensitivity}
        assert set(indexes) == {"M"}
        assert 0.3 < indexes["M"] < 0.5

    def test_it_shares_the_finish_with_other_uncertain_work(self) -> None:
        project = _project(
            [
                Task(id="A", name="A", duration=_days(5), **_estimate(5, 5, 9)),
                Task(id="M", name="M", duration=_days(0), **_estimate()),
                Task(id="B", name="B", duration=_days(5)),
            ],
            [_link("A", "M"), _link("M", "B")],
        )
        indexes = {s.task_id: s.index for s in monte_carlo(project, runs=5000, seed=1).sensitivity}
        # M's draws under half a day round away (#4697), so its share is small.
        assert indexes["A"] > indexes["M"] > 0.05

    def test_a_task_off_the_driving_path_moves_nothing(self) -> None:
        project = _project(
            [
                Task(id="L", name="L", duration=_days(30)),
                Task(id="M", name="M", duration=_days(0), **_estimate()),
            ],
            [],
        )
        assert monte_carlo(project, runs=2000, seed=1).sensitivity == []


@pytest.mark.parametrize(("state", "link_in", "link_out", "scope"), CELLS)
class TestTheClass:
    def test_runs_that_draw_zero_finish_on_the_cpm_date(
        self, state: str, link_in: DependencyType, link_out: DependencyType, scope: str
    ) -> None:
        for variant in VARIANTS:
            project = _cell(state, link_in, link_out, scope, variant)
            cpm = schedule(project).project_finish
            with _draws(_exact_zeros):
                mc = _run(project)
            assert (mc.p50, min(mc.distribution)) == (cpm, cpm), variant

    def test_no_round_away_draw_finishes_before_the_cpm_date(
        self, state: str, link_in: DependencyType, link_out: DependencyType, scope: str
    ) -> None:
        for variant in VARIANTS:
            project = _cell(state, link_in, link_out, scope, variant)
            cpm = schedule(project).project_finish
            with _draws(_constant(0.3)):
                mc = _run(project)
            assert min(mc.distribution) >= cpm, variant

    def test_no_real_draw_finishes_before_the_cpm_date(
        self, state: str, link_in: DependencyType, link_out: DependencyType, scope: str
    ) -> None:
        if (link_in, link_out) in _BACK_SOLVES_AHEAD:
            pytest.skip("a work-sized draw can back-solve ahead of CPM here (#4822)")
        for variant in VARIANTS:
            project = _cell(state, link_in, link_out, scope, variant)
            cpm = schedule(project).project_finish
            mc = _run(project, runs=500)
            assert min(mc.distribution) >= cpm, variant

    def test_crossing_into_work_does_not_finish_earlier(
        self, state: str, link_in: DependencyType, link_out: DependencyType, scope: str
    ) -> None:
        if (link_in, link_out) in _BACK_SOLVES_AHEAD:
            pytest.skip("this is the backward step #4822 tracks")
        for variant in VARIANTS:
            project = _cell(state, link_in, link_out, scope, variant)
            with _draws(_constant(0.49)):
                rounds_away = _run(project)
            with _draws(_constant(0.51)):
                work = _run(project)
            assert work.p50 >= rounds_away.p50, variant


class TestWhatARunIs:
    def test_a_held_task_is_shown_on_the_day_it_is_held_to(self) -> None:
        """Read as work it would end the Friday before the Monday it cannot precede."""
        project = _project(
            [
                Task(
                    id="M",
                    name="M",
                    duration=_days(0),
                    planned_start=HELD_TO_A_MONDAY,
                    **_estimate(),
                )
            ],
            [],
        )
        with _draws(_exact_zeros):
            mc = _run(project)
        assert mc.p50 == HELD_TO_A_MONDAY
        assert mc.p50_at_day_start is True

    def test_a_lag_counts_from_the_instant(self) -> None:
        """M is held to Monday 00:00, so +3d is Thursday's start, not Friday + 1 + 3."""
        project = _project(
            [
                Task(
                    id="M",
                    name="M",
                    duration=_days(0),
                    planned_start=HELD_TO_A_MONDAY,
                    **_estimate(),
                ),
                Task(id="B", name="B", duration=_days(1)),
            ],
            [_link("M", "B", lag=3)],
        )
        with _draws(_exact_zeros):
            mc = _run(project)
        assert mc.p50 == schedule(project).project_finish == date(2026, 3, 19)

    def test_an_ss_link_counts_from_the_instant(self) -> None:
        """M closes Friday, so SS+1d lands on Sunday and snaps to Monday, not Tuesday."""
        project = _cell("live", DependencyType.FS, DependencyType.SS, "project", (0, 1, None))
        with _draws(_exact_zeros):
            mc = _run(project)
        assert mc.p50 == schedule(project).project_finish == date(2026, 3, 13)

    def test_a_chain_of_small_draws_each_rounds_away(self) -> None:
        """Three 0.2-day draws are three instants, so B stays on CPM (#4697).

        Before #4697 each handed its 0.2 on and the chain read 0.6 of a day of work.
        Under the day-it-falls-in reading a handed-on fraction costs any whole-day
        successor a day, so a draw that rounds away now hands nothing on.
        """
        project = _project(
            [
                *(
                    Task(id=f"M{i}", name=f"M{i}", duration=_days(0), **_estimate())
                    for i in range(3)
                ),
                Task(id="B", name="B", duration=_days(5)),
            ],
            [_link("M0", "M1"), _link("M1", "M2"), _link("M2", "B")],
        )
        assert schedule(project).project_finish == date(2026, 3, 6)
        with _draws(_constant(0.2)):
            assert _run(project).p50 == date(2026, 3, 6)
        with _draws(_constant(0.6)):
            # 1.8 days of work: B's five days end part-way into Tuesday 03-10.
            assert _run(project).p50 == date(2026, 3, 10)

    def test_a_whole_day_draw_is_a_day_of_work(self) -> None:
        project = _cell("live", DependencyType.FS, DependencyType.FS, "project")
        with _draws(_constant(1.0)):
            assert _run(project).p50 == date(2026, 3, 16)
        with _draws(_constant(2.0)):
            assert _run(project).p50 == date(2026, 3, 17)

    def test_a_task_with_work_keeps_its_one_day_floor(self) -> None:
        tasks = [
            Task(id="A", name="A", duration=_days(1), **_estimate()),
            Task(id="B", name="B", duration=_days(5)),
        ]
        project = _project(tasks, [_link("A", "B")])
        with _draws(_constant(0.2)):
            assert _run(project).p50 == date(2026, 3, 9) == schedule(project).project_finish
        assert engine._mc_effective_duration(np.array([0.2]), "A", {}).tolist() == [1.0]


def _work_network(
    link_in: DependencyType,
    link_out: DependencyType,
    m_days: int,
    **m_fields: Any,
) -> Project:
    return _project(
        [
            Task(id="A", name="A", duration=_days(5)),
            Task(id="M", name="M", duration=_days(m_days), **m_fields),
            Task(id="B", name="B", duration=_days(5)),
        ],
        [_link("A", "M", link_in), _link("M", "B", link_out)],
    )


def _same_result(left: MonteCarloResult, right: MonteCarloResult) -> None:
    assert (left.p50, left.p80, left.p95) == (right.p50, right.p80, right.p95)
    assert left.distribution == right.distribution


def _with_m(project: Project, **fields: Any) -> Project:
    return replace(
        project, tasks=[replace(t, **fields) if t.id == "M" else t for t in project.tasks]
    )


class TestAWorkSizedDrawIsOrdinaryWork:
    """A draw of a day or more back-solves over FF/SF like a real task of that length.

    With a recorded start the two can differ, on main as here: see
    ``test_a_started_task_is_not_a_real_task_of_that_length``.
    """

    @pytest.mark.parametrize(
        ("estimate", "link_in", "p50"),
        [
            # Half the draws exceed 5 days, so B's work ends part-way into Monday (#4697).
            ((3, 5, 8), DependencyType.FF, date(2026, 3, 16)),
            ((3, 5, 8), DependencyType.SF, date(2026, 3, 6)),
            ((1, 1, 1), DependencyType.FF, date(2026, 3, 13)),
            ((1, 1, 1), DependencyType.SF, date(2026, 3, 6)),
        ],
    )
    def test_pinned_to_main(
        self, estimate: tuple[int, int, int], link_in: DependencyType, p50: date
    ) -> None:
        project = _work_network(link_in, DependencyType.FS, 0, **_estimate(*estimate))
        assert monte_carlo(project, runs=2000, seed=1).p50 == p50

    @pytest.mark.parametrize("link_in", [DependencyType.FF, DependencyType.SF])
    @pytest.mark.parametrize("link_out", LINKS)
    @pytest.mark.parametrize("estimate", [(1, 1, 1), (2, 2, 2), (3, 5, 8)])
    def test_equal_to_a_real_task_of_that_length(
        self, estimate: tuple[int, int, int], link_in: DependencyType, link_out: DependencyType
    ) -> None:
        fields = _estimate(*estimate)
        zero_base = _work_network(link_in, link_out, 0, **fields)
        real = _work_network(link_in, link_out, estimate[0], **fields)
        _same_result(
            monte_carlo(zero_base, runs=500, seed=1),
            monte_carlo(real, runs=500, seed=1),
        )

    @pytest.mark.parametrize(
        ("state", "link_in", "link_out", "scope"),
        [cell for cell in CELLS if cell[0] != "started"],
    )
    def test_equal_across_the_class_without_a_recorded_start(
        self, state: str, link_in: DependencyType, link_out: DependencyType, scope: str
    ) -> None:
        for variant in VARIANTS:
            cell = _cell(state, link_in, link_out, scope, variant)
            for estimate in ((1, 1, 1), (3, 5, 8)):
                fields = _estimate(*estimate)
                _same_result(
                    monte_carlo(_with_m(cell, **fields), runs=64, seed=1),
                    monte_carlo(
                        _with_m(cell, duration=_days(estimate[0]), **fields), runs=64, seed=1
                    ),
                )

    def test_sf_in_sf_out_back_solves_ahead_only_with_longer_lags(self) -> None:
        """It takes a whole-day draw to back-solve M's start into an earlier day.

        A sub-day draw back-solves M's start only part-way into the day before its
        finish, and the SF link out of it reads that start in the day it falls in
        (#4697), which keeps B on the CPM date. Before #4697 a 0.51 draw was
        enough, because its start was read as the nearest day.
        """
        project = _cell("live", DependencyType.SF, DependencyType.SF, "project", (3, 3, None))
        assert schedule(project).project_finish == date(2026, 3, 9)
        with _draws(_constant(0.9)):
            assert _run(project).p50 == date(2026, 3, 9)
        with _draws(_constant(1.0)):
            assert _run(project).p50 == date(2026, 3, 6)

    def test_a_started_task_is_not_a_real_task_of_that_length(self) -> None:
        cell = _cell("started", DependencyType.FS, DependencyType.SS, "project")
        fields = _estimate(1, 1, 1)
        assert monte_carlo(_with_m(cell, **fields), runs=64, seed=1).p50 == date(2026, 3, 19)
        real = _with_m(cell, duration=_days(1), **fields)
        assert monte_carlo(real, runs=64, seed=1).p50 == date(2026, 3, 13)


class TestTheFractionFollowsTheLinkAnchor:
    """An instant hands on what its link measures from, as work does.

    An SS or SF link measures from the start, so it never sees a draw. B has its own
    estimate here because a whole-day B rounds the fraction away and hides the carry.
    """

    def _network(
        self,
        out: DependencyType,
        *,
        into: DependencyType = DependencyType.FS,
        m_estimate: bool = True,
        b_estimate: tuple[int, int, int] = (5, 5, 9),
    ) -> Project:
        return _project(
            [
                Task(id="A", name="A", duration=_days(5)),
                Task(id="M", name="M", duration=_days(0), **(_estimate() if m_estimate else {})),
                Task(id="B", name="B", duration=_days(5), **_estimate(*b_estimate)),
            ],
            [_link("A", "M", into), _link("M", "B", out)],
        )

    @contextmanager
    def _m_draws(self, value: float, b_fixed: float | None = None) -> Iterator[None]:
        """M, whose pessimistic is 1, draws ``value``; B draws ``b_fixed`` or for real."""
        real = engine._sample_pert

        def sample(opt: float, ml: float, pess: float, n: int, rng: Any) -> np.ndarray:
            if pess <= 1:
                return np.full(n, value)
            return np.full(n, b_fixed) if b_fixed is not None else real(opt, ml, pess, n, rng)

        with patch.object(engine, "_sample_pert", sample):
            yield

    def test_the_reported_ss_network_stays_on_main(self) -> None:
        """B's own draws over 5 days end part-way into Monday, so P50 is 03-16 (#4697).

        Before #4697 they were read as the nearest day: (03-13, 03-16, 03-17).
        """
        mc = monte_carlo(self._network(DependencyType.SS), runs=5000, seed=1)
        assert (mc.p50, mc.p80, mc.p95) == (date(2026, 3, 16), date(2026, 3, 17), date(2026, 3, 18))

    @pytest.mark.parametrize("out", [DependencyType.SS, DependencyType.SF])
    @pytest.mark.parametrize("into", [DependencyType.FS, DependencyType.SS])
    def test_a_start_anchored_link_never_sees_the_draw(
        self, into: DependencyType, out: DependencyType
    ) -> None:
        with self._m_draws(0.4):
            drawn = monte_carlo(self._network(out, into=into), runs=2000, seed=1)
            milestone = monte_carlo(
                self._network(out, into=into, m_estimate=False), runs=2000, seed=1
            )
        _same_result(drawn, milestone)

    def test_a_finish_anchored_link_carries_only_work(self) -> None:
        """A 0.4 draw rounds away and hands FS nothing; a 0.6 draw is work it carries.

        B's 5.45 days alone end part-way into Monday 03-16 on FS and SS alike. M's
        0.6 adds to that on FS, into Tuesday. Before #4697 a 0.4 draw handed its
        fraction on too; under the day-it-falls-in reading that would cost a whole-day
        successor a day for a draw that rounds away.
        """
        with self._m_draws(0.4, b_fixed=5.45):
            on_fs = monte_carlo(self._network(DependencyType.FS), runs=8, seed=1)
            on_ss = monte_carlo(self._network(DependencyType.SS), runs=8, seed=1)
        assert (on_fs.p50, on_ss.p50) == (date(2026, 3, 16), date(2026, 3, 16))
        with self._m_draws(0.6, b_fixed=5.45):
            on_fs = monte_carlo(self._network(DependencyType.FS), runs=8, seed=1)
            on_ss = monte_carlo(self._network(DependencyType.SS), runs=8, seed=1)
        assert (on_fs.p50, on_ss.p50) == (date(2026, 3, 17), date(2026, 3, 16))

    @pytest.mark.parametrize("into", [DependencyType.FS, DependencyType.SS, DependencyType.FF])
    def test_crossing_into_work_does_not_finish_earlier_over_ss(self, into: DependencyType) -> None:
        """A fractional B: the 0.49 draw used to finish 03-16 and the 0.51 draw 03-13."""
        for b_fixed in (5.1, 5.2, 5.3, 5.4, 5.45, 5.6, 5.8):
            project = self._network(DependencyType.SS, into=into)
            with self._m_draws(0.49, b_fixed):
                rounds_away = monte_carlo(project, runs=8, seed=1)
            with self._m_draws(0.51, b_fixed):
                work = monte_carlo(project, runs=8, seed=1)
            assert work.p50 >= rounds_away.p50, b_fixed


class TestVelocityPath:
    """A 0-day SCRUM task with story points samples work, with no PERT fields at all."""

    SCRUM: ClassVar[dict[str, Any]] = {"delivery_mode": DeliveryMode.SCRUM, "story_points": 20}

    def _network(self, link_in: DependencyType, m_days: int) -> Project:
        base = _work_network(link_in, DependencyType.FS, m_days, **self.SCRUM)
        return replace(base, velocity_samples=[8.0, 10.0, 12.0], sprint_length_days=10)

    @pytest.mark.parametrize("link_in", LINKS)
    def test_equal_to_a_real_task_with_the_same_points(self, link_in: DependencyType) -> None:
        _same_result(
            monte_carlo(self._network(link_in, 0), runs=500, seed=1),
            monte_carlo(self._network(link_in, 1), runs=500, seed=1),
        )

    def test_ff_in_is_pinned_to_main(self) -> None:
        project = self._network(DependencyType.FF, 0)
        assert monte_carlo(project, runs=2000, seed=1).p50 == VELOCITY_FF_P50


def _random_network(seed: int, *, estimates: bool) -> Project:
    """A network mixing work and zero-duration tasks; floors, progress, calendars, all links."""
    r = random.Random(seed)
    n = r.randint(2, 8)
    per_task = r.random() < 0.3
    tasks: list[Task] = []
    deps: list[Dependency] = []
    kw: dict[str, Any] = {}
    if per_task:
        kw["calendars"] = {
            "six": Calendar(working_days=SIX_DAY),
            "four": Calendar(working_days=0b0001111),
        }
    if r.random() < 0.3:
        kw["status_date"] = START + _days(r.randint(0, 12))
    for i in range(n):
        days = r.choice([0, 0, 0, 1, 2, 5])
        spec: dict[str, Any] = {"id": f"T{i}", "name": f"T{i}", "duration": _days(days)}
        if per_task and r.random() < 0.5:
            spec["calendar_id"] = r.choice(["six", "four"])
        if r.random() < 0.2:
            spec["planned_start"] = START + _days(r.randint(-3, 20))
        if days and r.random() < 0.25:
            spec["actual_start"] = START + _days(r.randint(0, 5))
            spec["percent_complete"] = r.choice([20.0, 50.0])
        elif not days and r.random() < 0.15:
            spec["actual_start"] = START + _days(r.randint(0, 8))
        if not days and estimates:
            spec.update(_estimate())
        tasks.append(Task(**spec))
    for j in range(1, n):
        for i in r.sample(range(j), min(j, r.randint(0, 2))):
            deps.append(
                _link(f"T{i}", f"T{j}", r.choice(LINKS), r.choice([-3, -1, 0, 0, 0, 1, 2, 3, 7]))
            )
    return _project(tasks, deps, **kw)


def test_instant_runs_match_a_real_milestone() -> None:
    """Zero draws must solve exactly as the same network with no estimates on its 0-day tasks."""
    for seed in range(400):
        milestones = monte_carlo(_random_network(seed, estimates=False), runs=8, seed=3)
        with _draws(_exact_zeros):
            zero_draws = monte_carlo(_random_network(seed, estimates=True), runs=8, seed=3)
        assert (zero_draws.p50, zero_draws.p80) == (milestones.p50, milestones.p80), seed
        assert (zero_draws.p50_at_day_start, zero_draws.p80_at_day_start) == (
            milestones.p50_at_day_start,
            milestones.p80_at_day_start,
        ), seed
        assert zero_draws.distribution[:-1] == milestones.distribution[:-1], seed
