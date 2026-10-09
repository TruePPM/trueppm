"""A real MS-Project-saved SF link with positive lag, checked against the
engine's output (#4327, case 1 of #4322's remaining three).

``tests/fixtures/msproject/task_links_cross_version.py`` documents where
this comes from (MPXJ's generated parser-conformance matrix — 17
independently MS-Project-saved binary files across 8 versions, 98-2019).
All four scenarios agree with MS Project, including ``FEB_START`` — the
Monday-start, weekend-adjacent-anchor case #4333 reported, fixed in !2950.
A fifth, unsaved probe — raising ``FRIDAY_START``'s lag from 2 to 3 — shows
a second, still-open #2534 divergence on a scenario that otherwise agrees:
#4333's fix moved where the calendar-day-lag mismatch starts, it did not
remove the underlying mechanism.

Kept in its own file, next to ``test_msproject_sf_reference.py``, to stay
clear of the large, churning ``test_engine.py``.
"""

from __future__ import annotations

import pytest

from tests.fixtures.msproject.task_links_cross_version import (
    EXPECTED_FINISH,
    EXPECTED_START,
    FEB_START,
    FRIDAY_START,
    MS_PROJECT_FINISH_FRIDAY_LAG3,
    THU_START,
    WEDNESDAY_START,
    build_project,
)
from trueppm_scheduler import schedule


def test_sf_positive_lag_matches_ms_project_no_weekend() -> None:
    """Case 1 (#4327): SF, lag=2 working days, no weekend between the dates.

    Predecessor starts Wednesday 2014-10-29; MS Project (project2000-mpp8/9,
    independently) finished the successor Thursday 2014-10-30 — one working
    day later, since the zero-lag SF anchor (Tuesday 10-28, the working day
    before the predecessor's start) plus a 2-working-day lag lands on
    Thursday without touching a weekend. The engine's calendar-day lag
    (#2534) gives the same date here because no weekend sits in the span.
    """
    result = schedule(build_project(WEDNESDAY_START))
    by_id = {t.id: t for t in result.tasks}

    assert by_id["12"].early_start == EXPECTED_START[WEDNESDAY_START]
    assert by_id["12"].early_finish == EXPECTED_FINISH[WEDNESDAY_START]


def test_sf_positive_lag_matches_ms_project_crossing_weekend() -> None:
    """Case 1 (#4327) composed with a weekend: SF, lag=2 working days.

    Predecessor starts Friday 2014-10-17; MS Project (project98/2003/2007/
    2010/2013-mpp8/9/12/14, nine independently-saved files) finished the
    successor Monday 2014-10-20. The zero-lag SF anchor (Thursday 10-16, the
    working day before the predecessor's Friday start) plus a 2-working-day
    lag crosses Saturday/Sunday to land on Monday.

    This does **not** verify working-day lag semantics in general (#2534
    remains open) — at this lag magnitude, the engine's calendar-day lag
    (2 calendar days from Thursday is Saturday, which snaps forward to
    Monday) lands on the same date a 2-*working*-day lag would. It is real
    evidence that the two units' outputs agree in this alignment, not that
    the engine implements working-day lag. ``test_sf_lag_magnitude_diverges_
    from_ms_project`` below shows the same anchor at lag=3 does not agree.
    """
    result = schedule(build_project(FRIDAY_START))
    by_id = {t.id: t for t in result.tasks}

    assert by_id["12"].early_start == EXPECTED_START[FRIDAY_START]
    assert by_id["12"].early_finish == EXPECTED_FINISH[FRIDAY_START]


def test_sf_positive_lag_matches_ms_project_thursday_start() -> None:
    """A fourth independent alignment: SF, lag=2 working days, Thursday start.

    Predecessor starts Thursday 2018-10-18 (project2019-mpp12/mpp14, per
    #4333's own repro); the zero-lag SF anchor (Wednesday 10-17) plus a
    2-working-day lag lands on Friday 10-19, no weekend touched.
    """
    result = schedule(build_project(THU_START))
    by_id = {t.id: t for t in result.tasks}

    assert by_id["12"].early_start == EXPECTED_START[THU_START]
    assert by_id["12"].early_finish == EXPECTED_FINISH[THU_START]


def test_sf_zero_lag_anchor_before_weekend_matches_ms_project() -> None:
    """The #4333 case (now fixed, !2950): a Monday start's anchor sits before a weekend.

    Predecessor starts Monday 2016-02-08 (project2016-mpp12/mpp14, per
    #4333's own repro). The *zero-lag* SF anchor is Friday 2016-02-05 — the
    working day immediately before the weekend. Before #4333's fix, the
    engine pre-snapped that anchor and let the weekend absorb the whole
    2-day lag, finishing the successor Monday 02-08 instead of MS Project's
    Tuesday 02-09. #4333's fix counts a positive lag from the predecessor's
    start instant itself rather than the pre-snapped anchor, which resolves
    this case: this is the isolated zero-lag weekend-crossing scenario
    #4327 asked for and didn't find in a book or course sample — it turned
    up in the MPXJ matrix instead, and (unlike when this test was first
    written) now agrees with the engine, independently of #4333's own
    hand-built regression test in ``test_sf_from_work.py``.
    """
    result = schedule(build_project(FEB_START))
    by_id = {t.id: t for t in result.tasks}

    assert by_id["12"].early_start == EXPECTED_START[FEB_START]
    assert by_id["12"].early_finish == EXPECTED_FINISH[FEB_START]


@pytest.mark.xfail(
    strict=True,
    reason="#2534: engine counts lag in calendar days, not working days",
)
def test_sf_lag_magnitude_diverges_from_ms_project() -> None:
    """#2534: FRIDAY_START's agreement with MS Project doesn't survive a larger lag.

    Same anchor as ``test_sf_positive_lag_matches_ms_project_crossing_
    weekend`` (Thursday 2014-10-16, the working day before the Friday
    predecessor start) but lag=3 instead of the fixture's saved lag=2.
    MS Project's working-day lag of 3 gives Tuesday 2014-10-21. The
    engine's calendar-day lag adds 3 calendar days to Thursday, lands on
    Sunday 10-19, and snaps forward to Monday 10-20 — the same date as
    lag=2, because the snap absorbs the third day instead of carrying it
    through. This is the discriminating case the lag=2 fixture can't be:
    at lag=2 the two units coincide; at lag=3 they don't.

    #4333's fix (!2950) does not touch this: it changed where the engine
    anchors a positive SF lag, not how the lag itself is counted. The same
    calendar-day-then-single-snap mechanism recurs on every one of this
    fixture's four alignments once their lag reaches a second weekend from
    the anchor — including ``FEB_START`` itself, again, at lag=7.
    """
    result = schedule(build_project(FRIDAY_START, lag_days=3))
    by_id = {t.id: t for t in result.tasks}

    assert by_id["12"].early_finish == MS_PROJECT_FINISH_FRIDAY_LAG3
