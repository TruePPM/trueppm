"""The elapsed-days rule on fractional percents is exact (#5034, #5015).

``_elapsed_working_days`` is ``floor(duration * P / 100)`` with ``P`` the decimal the
percentage prints as. These tests hold it against ``Fraction`` arithmetic built
independently of ``repr`` (a decimal drawn as ``m / 10**k``), pin the cases the audit
found, and check that every consumer of the rule (the deterministic passes, Monte Carlo
and the what-if shift) reads the same elapsed count.
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
def test_every_audited_375_day_percent_is_the_exact_floor(pct: float) -> None:
    tenths = round(pct * 10)
    assert _elapsed_working_days(375, pct) == 375 * tenths // 1000


@pytest.mark.parametrize(
    ("days", "pct", "elapsed"),
    [
        (39, 12.820512820512821, 5),  # 2e-16 above a whole day
        (39, 12.82051282051282, 4),  # the double serde_json used to read, just below
        (43, 11.627906976744185, 4),  # 1e-17 below a whole day
        (5, 99.99999999999999, 4),  # below 100 always leaves a remaining day
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
def test_a_decimal_percent_floors_exactly(days: int, digits: int, places: int) -> None:
    """Against ``Fraction(m, 10**k)``, which never goes through ``repr`` or a float."""
    exact = Fraction(digits, 10**places)
    if exact > 100:
        return
    pct = float(exact)  # <= 10 significant digits, so repr(pct) is this decimal
    assert _elapsed_working_days(days, pct) == math.floor(days * exact / 100)


@pytest.mark.fuzz
@given(days=st.integers(min_value=1, max_value=400), data=st.data())
def test_a_day_boundary_percent_floors_exactly(days: int, data: st.DataObject) -> None:
    """``100*k/n`` and its neighbors one ULP away: where float math was one day off."""
    k = data.draw(st.integers(min_value=0, max_value=days))
    pct = 100 * k / days
    pct = data.draw(st.sampled_from([pct, math.nextafter(pct, 0.0), math.nextafter(pct, 100.0)]))
    pct = min(pct, 100.0)
    expected = math.floor(days * Fraction(repr(pct)) / 100)
    assert _elapsed_working_days(days, pct) == expected


@pytest.mark.fuzz
@given(days=st.integers(min_value=1, max_value=400), pct=st.floats(0.0, 100.0))
def test_any_float_percent_keeps_the_rule_invariants(days: int, pct: float) -> None:
    elapsed = _elapsed_working_days(days, pct)
    assert elapsed == math.floor(days * Fraction(repr(pct)) / 100)
    assert 0 <= elapsed <= days
    if pct < 100:
        # An open task always has work left: the reason for exact over rounded.
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
