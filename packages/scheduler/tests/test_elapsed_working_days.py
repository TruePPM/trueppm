"""The elapsed-days rule on fractional percents is exact (#5034, #5015).

``_elapsed_working_days`` takes ``x = duration * P / 100`` with ``P`` the decimal the
percentage prints as, snaps ``x`` to its nearest integer when within 1e-9 days of it
and floors it otherwise, then caps it at ``duration - 1`` below 100%. These tests hold
it against :func:`_spec`, a ``Fraction`` statement of that rule written with
``round``/``abs`` rather than the helper's ``divmod`` (and, where the input is drawn as
``m / 10**k``, never through ``repr``), pin the cases the audit found, and check that
every consumer of the rule (the deterministic passes, Monte Carlo and the what-if
shift) reads the same elapsed count.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from fractions import Fraction

import pytest
from hypothesis import given
from hypothesis import strategies as st

from trueppm_scheduler import Project, Task, monte_carlo, perturb_task_duration, schedule
from trueppm_scheduler.engine.calendar_math import (
    _effective_duration_days,
    _elapsed_working_days,
)

START = date(2026, 3, 2)  # a Monday
_TOLERANCE = Fraction(1, 10**9)


def _spec(days: int, exact: Fraction) -> int:
    """The rule over an exact percent ``exact`` in ``[0, 100]``."""
    x = days * exact / 100
    nearest = round(x)
    elapsed = nearest if abs(x - nearest) <= _TOLERANCE else math.floor(x)
    return min(elapsed, days - 1) if exact < 100 and days > 0 else elapsed


def _one_task_project(days: int, pct: float) -> Project:
    return Project(
        id="p",
        name="p",
        start_date=START,
        tasks=[Task(id="A", name="A", duration=timedelta(days=days), percent_complete=pct)],
        dependencies=[],
    )


def test_the_375_day_task_at_18_4_percent_has_69_elapsed_days() -> None:
    """Float math gave ``int(375 * 18.4 / 100.0) == 68``; the decimal means 69."""
    assert int(375 * 18.4 / 100.0) == 68  # the defect this pins, still true of floats
    assert _elapsed_working_days(375, 18.4) == 69
    result = schedule(_one_task_project(375, 18.4))
    # 306 remaining Mon-Fri working days from Monday 2026-03-02.
    assert result.project_finish == date(2027, 5, 3)


@pytest.mark.parametrize("pct", [18.4, 32.8, 36.8, 40.8, 65.6, 69.6, 73.6, 77.6])
def test_every_audited_375_day_percent_is_the_exact_decimal(pct: float) -> None:
    tenths = round(pct * 10)
    assert _elapsed_working_days(375, pct) == 375 * tenths // 1000


@pytest.mark.parametrize(
    ("days", "pct", "elapsed"),
    [
        (39, 12.820512820512821, 5),  # 2e-16 above a whole day
        (39, 12.82051282051282, 5),  # 1.6e-15 below: within the tolerance, snaps up
        (43, 11.627906976744185, 5),  # 4.5e-16 below a whole day: snaps up
        (9, 11.11111111111111, 1),  # 100*1/9: a bare floor gave 0
        (6, 83.33333333333333, 5),  # 100*5/6: a bare floor gave 4
        (2, 49.99999995, 1),  # exactly 1e-9 below a day: the boundary snaps
        (2, 49.999999951, 1),  # 9.8e-10 below: snaps
        (2, 49.99999994, 0),  # 1.2e-9 below: floors
        (5, 99.99999999999999, 4),  # below 100 always leaves a remaining day
        (1, 99.9999999, 0),  # snaps to the whole duration, capped back to leave one
        (5, 100.0, 5),
        (5, 150.0, 5),  # clamped
        (10, 5e-324, 0),  # subnormal
        (0, 50.0, 0),
        (10, 0.0, 0),
        (10, -3.0, 0),
    ],
)
def test_boundary_cases(days: int, pct: float, elapsed: int) -> None:
    assert _elapsed_working_days(days, pct) == elapsed


def test_an_int_percent_is_accepted() -> None:
    """``int`` has no ``is_integer`` before Python 3.12; the helper must not need it."""
    assert _elapsed_working_days(10, 40) == 4


_durations = st.integers(min_value=0, max_value=400)


@pytest.mark.fuzz
@given(
    days=_durations,
    digits=st.integers(min_value=1, max_value=10**9),
    places=st.integers(min_value=0, max_value=7),
)
def test_a_decimal_percent_follows_the_rule_exactly(days: int, digits: int, places: int) -> None:
    """Against ``Fraction(m, 10**k)``, which never goes through ``repr`` or a float."""
    exact = Fraction(digits, 10**places)
    if exact > 100:
        return
    pct = float(exact)  # <= 10 significant digits, so repr(pct) is this decimal
    assert _elapsed_working_days(days, pct) == _spec(days, exact)


@pytest.mark.fuzz
@given(days=st.integers(min_value=1, max_value=400), data=st.data())
def test_a_day_boundary_percent_counts_whole_days(days: int, data: st.DataObject) -> None:
    """``100*k/n`` and its neighbors one ULP away count exactly ``k`` days (capped).

    Where float math, and a bare exact floor, were one day off.
    """
    k = data.draw(st.integers(min_value=0, max_value=days))
    pct = 100 * k / days
    pct = data.draw(st.sampled_from([pct, math.nextafter(pct, 0.0), math.nextafter(pct, 100.0)]))
    pct = min(pct, 100.0)
    expected = k if k < days or pct >= 100 else days - 1
    assert _elapsed_working_days(days, pct) == expected
    assert _elapsed_working_days(days, pct) == _spec(days, Fraction(repr(pct)))


@pytest.mark.fuzz
@given(days=st.integers(min_value=1, max_value=400), pct=st.floats(0.0, 100.0))
def test_any_float_percent_keeps_the_rule_invariants(days: int, pct: float) -> None:
    elapsed = _elapsed_working_days(days, pct)
    assert elapsed == _spec(days, Fraction(repr(pct)))
    assert 0 <= elapsed <= days
    # Never more than a tolerance's snap above the exact floor.
    assert elapsed - math.floor(days * Fraction(repr(pct)) / 100) in (0, 1)
    if pct < 100:
        # An open task always has work left (``_shift_remaining_work`` relies on it).
        assert elapsed < days


@pytest.mark.fuzz
@given(days=_durations, pct=st.integers(min_value=0, max_value=100))
def test_integer_percents_are_unchanged_from_the_float_rule(days: int, pct: int) -> None:
    assert _elapsed_working_days(days, float(pct)) == int(days * float(pct) / 100.0)


def test_monte_carlo_holds_the_same_elapsed_days_as_the_cpm_pass() -> None:
    """A deterministic in-progress task simulates to exactly its CPM finish."""
    project = _one_task_project(375, 18.4)
    assert monte_carlo(project, runs=20, seed=1).p50 == schedule(project).project_finish


def test_the_what_if_shift_holds_the_exact_elapsed_days() -> None:
    project = _one_task_project(375, 18.4)
    shifted = perturb_task_duration(project, "A", 5)
    task = shifted.tasks[0]
    assert task.duration.days - _effective_duration_days(task) == 69
    assert _effective_duration_days(task) == 306 + 5


@pytest.mark.parametrize(
    ("days", "pct", "remaining"), [(9, 11.11111111111111, 8), (6, 83.33333333333333, 1)]
)
def test_a_k_of_n_percent_schedules_the_remaining_n_minus_k_days(
    days: int, pct: float, remaining: int
) -> None:
    project = _one_task_project(days, pct)
    assert _effective_duration_days(project.tasks[0]) == remaining
