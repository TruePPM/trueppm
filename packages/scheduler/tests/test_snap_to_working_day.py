"""``_snap_to_working_day`` fails fast, and by property name, when its direction breaks (#4546).

It is the most-called helper in the engine: every dependency edge snaps once per pass.
A reversed ``step`` used to be killed only by stacked 10 s hang guards over a dozen
minutes of Hypothesis cases. These checks are millisecond unit assertions plus a small,
bounded property, and each failure message names the property that broke.

The snap calls run under a short SIGALRM watchdog because a reversed step does not
just return the wrong date: from a weekend that follows a long closure it oscillates
between the closure and the weekend forever. The watchdog turns that spin into the same
named failure rather than a hang.
"""

from __future__ import annotations

import signal
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, timedelta
from types import FrameType

import pytest
from hypothesis import Phase, given, settings
from hypothesis import strategies as st

from trueppm_scheduler import Calendar
from trueppm_scheduler.engine import _snap_to_working_day
from trueppm_scheduler.models import DateRange

_MONDAY = date(2026, 3, 2)
_WATCHDOG_SECONDS = 0.3


@contextmanager
def _watchdog(label: str) -> Iterator[None]:
    """Fail with ``label`` if the body spins past ``_WATCHDOG_SECONDS`` (Unix only)."""
    if not hasattr(signal, "SIGALRM"):
        yield
        return

    def _spin(_signum: int, _frame: FrameType | None) -> None:
        raise AssertionError(f"{label}: snap did not terminate (direction reversed?)")

    old = signal.signal(signal.SIGALRM, _spin)
    signal.setitimer(signal.ITIMER_REAL, _WATCHDOG_SECONDS)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def _snap(d: date, cal: Calendar, *, forward: bool, label: str) -> date:
    with _watchdog(label):
        return _snap_to_working_day(d, cal, forward=forward)


def _closed(start: date, days: int) -> DateRange:
    return DateRange(start, start + timedelta(days=days - 1))


class TestSnapDirection:
    """Mon-Fri calendar, no exceptions: the weekend is the only gap."""

    def test_forward_from_saturday_lands_on_the_following_monday(self) -> None:
        saturday = _MONDAY + timedelta(days=5)
        got = _snap(saturday, Calendar(), forward=True, label="forward never returns earlier")
        assert got == _MONDAY + timedelta(days=7)

    def test_backward_from_sunday_lands_on_the_preceding_friday(self) -> None:
        sunday = _MONDAY + timedelta(days=6)
        got = _snap(sunday, Calendar(), forward=False, label="backward never returns later")
        assert got == _MONDAY + timedelta(days=4)

    @pytest.mark.parametrize("forward", [True, False])
    @pytest.mark.parametrize("offset", range(5))
    def test_a_working_day_is_returned_unchanged(self, offset: int, forward: bool) -> None:
        d = _MONDAY + timedelta(days=offset)
        assert _snap(d, Calendar(), forward=forward, label="identity on a working day") == d

    def test_a_long_exception_run_is_crossed_in_the_requested_direction(self) -> None:
        # 301 days closed from Monday; the weekday after it is a working day.
        cal = Calendar(exceptions=[_closed(_MONDAY, 301)])
        inside = _MONDAY + timedelta(days=150)
        after = _snap(inside, cal, forward=True, label="forward across a long run")
        before = _snap(inside, cal, forward=False, label="backward across a long run")
        assert after == _MONDAY + timedelta(days=301)
        assert after > inside
        assert before == _MONDAY - timedelta(days=3)  # Friday before the run
        assert before < inside
        assert cal.is_working_day(after)
        assert cal.is_working_day(before)

    def test_a_weekend_straight_after_a_long_run_is_stepped_forward_not_back(self) -> None:
        # Run ends on a Friday, so the snap leaves it onto a Saturday and must keep going
        # forward to Monday. Stepping back would re-enter the run and never terminate.
        run = _closed(_MONDAY, 5 + 7 * 40)  # Monday .. Friday, 40 weeks on
        cal = Calendar(exceptions=[run])
        got = _snap(_MONDAY, cal, forward=True, label="forward past a run ending on a Friday")
        assert got == run.end + timedelta(days=3)


@st.composite
def _calendars(draw: st.DrawFn) -> Calendar:
    """A calendar with at least one working weekday and a few long closure runs."""
    mask = draw(st.integers(min_value=1, max_value=0b111_1111))
    runs = draw(
        st.lists(
            st.tuples(st.integers(-200, 200), st.integers(1, 120)),
            max_size=4,
        )
    )
    exceptions = [_closed(_MONDAY + timedelta(days=offset), length) for offset, length in runs]
    return Calendar(working_days=mask, exceptions=exceptions)


def _nothing_working_between(cal: Calendar, lo: date, hi: date) -> bool:
    """No working day strictly inside ``(lo, hi)`` — i.e. the snap found the *nearest* one."""
    return not any(cal.is_working_day(lo + timedelta(days=i)) for i in range(1, (hi - lo).days))


@pytest.mark.fuzz
@settings(
    max_examples=100,
    deadline=2000,
    # No shrink phase: a broken direction spins on every example, and shrinking would
    # spend the watchdog budget again on each candidate to minimise a failure that is
    # already named by its message.
    phases=[Phase.explicit, Phase.generate],
)
@given(cal=_calendars(), offset=st.integers(-300, 300), forward=st.booleans())
def test_snap_returns_the_nearest_working_day_in_its_direction(
    cal: Calendar, offset: int, forward: bool
) -> None:
    d = _MONDAY + timedelta(days=offset)
    got = _snap(d, cal, forward=forward, label="snap lands on a working day")

    assert cal.is_working_day(got), "snap lands on a working day"
    if cal.is_working_day(d):
        assert got == d, "identity on a working day"
    elif forward:
        assert got > d, "forward never returns earlier"
        assert _nothing_working_between(cal, d, got), "forward returns the nearest working day"
    else:
        assert got < d, "backward never returns later"
        assert _nothing_working_between(cal, got, d), "backward returns the nearest working day"
