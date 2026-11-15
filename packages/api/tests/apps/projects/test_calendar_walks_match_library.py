"""The API's hand-rolled working-day walks equal ``trueppm_scheduler.calendar`` (#5009).

Characterization for the move: each API walk is pinned, input for input, to the
public library helper that will replace it. The API cannot call those helpers yet
— ``api:wheel-install-probe`` resolves ``trueppm-scheduler`` from PyPI, and 0.4.0
does not have them (the #4976 constraint) — so this file is what proves the swap
is behavior-preserving once 0.5 publishes, and what catches either side drifting
until then. Test modules sit outside the installed package, so the probe does not
read this file's imports.

Pure functions over a scheduler ``Calendar``: no database.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest
from trueppm_scheduler import Calendar, DateRange
from trueppm_scheduler.calendar import (
    next_working_day,
    nth_working_day,
    previous_working_day,
    working_day_count,
)

from trueppm_api.apps.projects import sprint_cadence
from trueppm_api.apps.projects.services import _layered_working_days, _working_days
from trueppm_api.apps.scheduling.finish_reading import working_time_end_day

_BASE = date(2026, 1, 5)


def _calendar(seed: int) -> Calendar:
    rng = random.Random(seed)
    exceptions = []
    for _ in range(rng.randint(0, 5)):
        lo = _BASE + timedelta(days=rng.randint(0, 150))
        exceptions.append(DateRange(lo, lo + timedelta(days=rng.randint(0, 15))))
    return Calendar(working_days=rng.randint(1, 127), exceptions=exceptions)


def _span(seed: int) -> tuple[date, date, int]:
    rng = random.Random(seed * 7919 + 1)
    start = _BASE + timedelta(days=rng.randint(-5, 160))
    return start, start + timedelta(days=rng.randint(-2, 120)), rng.randint(1, 30)


SEEDS = range(150)


@pytest.mark.parametrize("seed", SEEDS)
def test_layered_working_days_is_the_library_count(seed: int) -> None:
    cal = _calendar(seed)
    start, finish, _ = _span(seed)
    assert _layered_working_days(cal, start, finish) == working_day_count(start, finish, cal)


@pytest.mark.parametrize("seed", SEEDS)
def test_mask_only_working_days_is_the_library_count_on_a_bare_calendar(seed: int) -> None:
    start, finish, _ = _span(seed)
    assert _working_days(start, finish) == working_day_count(start, finish, Calendar())


@pytest.mark.parametrize("seed", SEEDS)
def test_cadence_walks_are_the_library_walks(seed: int) -> None:
    cal = _calendar(seed)
    start, finish, length = _span(seed)

    first = sprint_cadence._next_working_day(cal, start)
    assert first == next_working_day(start, cal, inclusive=True)

    window_finish, skipped = sprint_cadence._window_from_start(cal, first, length)
    assert window_finish == nth_working_day(first, length, cal)
    assert skipped == (window_finish - first).days + 1 - length

    if finish > start:
        working, non_working = sprint_cadence.working_days_in_window(cal, start, finish)
        assert working == working_day_count(start, finish, cal)
        assert working + non_working == (finish - start).days + 1


@pytest.mark.parametrize("seed", SEEDS)
def test_working_time_end_day_is_the_library_previous_working_day(seed: int) -> None:
    cal = _calendar(seed)
    start, _, _ = _span(seed)
    assert working_time_end_day((start, True), cal) == previous_working_day(start, cal)
    assert working_time_end_day((start, False), cal) == start
