"""A real MS-Project-saved SF link with positive lag, case 1 of #4327.

#4322/#4327 asked for an MS Project sample file covering three still-unverified
SF cases: positive lag, an anchor that crosses a weekend, and SF out of a
zero-duration milestone. No book-sample or course file found so far (checked:
the O'Reilly "Advanced Analytics" and "Backyard Remodel" project files, an
InfiniteSkills Netflix-recommendation-system student project, and the
InfiniteSkills "Microsoft Project 2013" course's own 16 chapters — see
``link_types_2013.py``) has an SF link with non-zero lag anywhere in it.

This fixture comes from a different kind of source: the MPXJ library's own
*generated* parser-conformance test matrix
(``joniles/mpxj``, ``junit/data/generated/task-links/task-links-project<year>-mpp<format>.mpp``).
MPXJ's maintainers built one small project exercising every relation type and
re-saved it from real MS Project across every version the library supports —
98, 2000, 2003, 2007, 2010, 2013, 2016, and 2019, in whichever binary formats
each version can write (mpp8/9/12/14 as applicable). That gives this fixture
**17 independently-saved binary files across those 8 MS Project versions**,
enumerated per scenario below (the ``project2016``/``project2019`` file names
come from #4333's own repro, which named them while tracking the ``FEB_START``
mismatch — not independently re-verified here beyond that citation).

Task 11 (no predecessor, 1-day duration) has an isolated SF link with a 2
*working*-day lag into task 12 (1-day duration) — nothing else on either
task, which is the isolation #4327 asked for. Confirmed straight from MS
Project's own MSPDI XML (not just MPXJ's parsed object model):
``task-links-project2010-mspdi.xml``'s ``PredecessorLink`` for task 12 reads
``<Type>2</Type>`` (SF) ``<LinkLag>9600</LinkLag>`` with
``<LagFormat>7</LagFormat>`` — MSPDI format code 7 is plain "Days" (a
working-day count against the task's calendar), not format 8 "Elapsed Days"
(a raw 24-hour count) — 9600 tenths-of-a-minute = 16 hours = 2 standard
8-hour working days. MS Project itself, not just MPXJ, treats this lag as 2
*working* days — the engine, per #2534, counts lag in **calendar** days and
then snaps, so the two units only read as equivalent where the alignment
happens not to separate them (see the mismatch table below).

The matrix's project start date differs by MS Project version, which
produces four distinct, independently-corroborated scenarios for the same
isolated SF(lag=2d) link. **All four now agree with MS Project** — including
the Monday-start, weekend-adjacent-anchor case #4333 reported and #4333's
fix (merged in !2950) resolved:

================  ========================  ============  ============  ========
Scenario          Predecessor start (T11)    MS Project    Engine        Agree?
                                              T12 finish    T12 finish
================  ========================  ============  ============  ========
FRIDAY_START      Fri 2014-10-17             Mon 10-20     Mon 10-20     yes
WEDNESDAY_START   Wed 2014-10-29             Thu 10-30     Thu 10-30     yes
THU_START         Thu 2018-10-18             Fri 10-19     Fri 10-19     yes
FEB_START         Mon 2016-02-08             Tue 02-09     Tue 02-09     yes
================  ========================  ============  ============  ========

Corroborating files per scenario (17 total, 8 MS Project versions):
``FRIDAY_START`` — project98-mpp8, project2003-mpp8/mpp9,
project2007-mpp9/mpp12, project2010-mpp9/mpp12/mpp14,
project2013-mpp9/mpp12/mpp14 (11 files, 5 MS Project versions);
``WEDNESDAY_START`` — project2000-mpp8/mpp9 (2 files); ``THU_START`` —
project2019-mpp12/mpp14 (2 files); ``FEB_START`` — project2016-mpp12/mpp14
(2 files; both this pair and the ``THU_START`` pair are named in #4333's own
repro, not independently re-verified here).

Before #4333's fix, ``FEB_START`` was the one scenario that diverged: its
zero-lag anchor (Friday 2016-02-05) sits on the working day immediately
before a weekend, so the engine's calendar-day lag arithmetic
(#2534) pre-snapped that anchor and then let the weekend absorb the whole
2-day lag, landing on Monday 02-08 instead of MS Project's Tuesday 02-09.
#4333's fix (count a positive lag from the predecessor's start instant
itself, not the pre-snapped working day before it) resolved exactly that —
the table above reflects the engine's current, fixed output, and
``test_sf_zero_lag_anchor_before_weekend_matches_ms_project`` below asserts
it against this fixture's external file evidence, independently of
#4333's own hand-built regression test in ``test_sf_from_work.py``.

**A second, separate divergence remains open** ([#2534](https://gitlab.com/trueppm/trueppm/-/issues/2534)):
the engine still counts lag in **calendar** days and snaps forward once, so
once the lag is long enough to reach a *second* weekend from the anchor, the
mismatch recurs — one working day short of MS Project, for the same reason
#4333's bug existed in the first place, just past the point #4333's fix
covers. This shows up on every one of the four scenarios above once their
lag is raised past what the saved files actually used (2 days): confirmed
by hand against real MS Project working-day semantics at
``FRIDAY_START``'s own anchor (not adjacent to a weekend the way
``FEB_START``'s was) and lag=3 — Thursday 10-16 + 3 calendar days is Sunday
10-19, which snaps to Monday 10-20, one working day short of MS Project's
Tuesday 10-21. ``WEDNESDAY_START`` first diverges at lag=5, ``THU_START`` at
lag=4, and ``FEB_START`` itself again at lag=7 (#4333's fix only moved where
the mismatch starts, it did not remove the underlying calendar-day-lag
mechanism). See the lag-magnitude test in
``test_msproject_sf_lag_reference.py``; lag=3 was never a value MPXJ
actually saved, so this is not one of the four MS-Project-saved alignments
above.

Case 3 (SF out of a zero-duration milestone) remains unfound — MPXJ's
generated matrix has no fixture pairing a milestone with any relation type,
and this is the only other category checked. See #4327.
"""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler import Calendar, Dependency, DependencyType, Project, Task

# All four scenarios share the same two-task graph; only the project (and
# therefore task 11's) start date differs.
FRIDAY_START = date(2014, 10, 17)
WEDNESDAY_START = date(2014, 10, 29)
THU_START = date(2018, 10, 18)
FEB_START = date(2016, 2, 8)

# What the engine computes at lag=2d — the lag MPXJ's generated matrix
# actually saved — for each scenario's zero-lag anchor. Since #4333's fix
# (!2950), this matches MS Project for all four scenarios, including
# FEB_START (the weekend-adjacent-anchor case #4333 reported).
EXPECTED_FINISH: dict[date, date] = {
    FRIDAY_START: date(2014, 10, 20),
    WEDNESDAY_START: date(2014, 10, 30),
    THU_START: date(2018, 10, 19),
    FEB_START: date(2016, 2, 9),
}
EXPECTED_START: dict[date, date] = {
    # Both tasks are 1-day, so each scenario's task 12 start equals its finish.
    FRIDAY_START: date(2014, 10, 20),
    WEDNESDAY_START: date(2014, 10, 30),
    THU_START: date(2018, 10, 19),
    FEB_START: date(2016, 2, 9),
}

# Ground truth for the still-open #2534 divergence: raising FRIDAY_START's
# lag from the saved 2d to 3d reaches a second weekend from its anchor
# (Thursday 10-16) that the engine's calendar-day-lag-then-snap still
# can't cross correctly, even though #4333's fix already landed. Not one
# of the four MS-Project-saved alignments above — lag=3 was never a value
# MPXJ actually saved for this fixture.
MS_PROJECT_FINISH_FRIDAY_LAG3 = date(2014, 10, 21)


def build_project(start_date: date, lag_days: int = 2) -> Project:
    """The MPXJ ``task-links`` fixture's isolated SF link.

    Args:
        start_date: Project (and task 11's) start date — one of
            ``FRIDAY_START``, ``WEDNESDAY_START``, ``THU_START`` or
            ``FEB_START``, matching one of the MS-Project-saved scenarios
            this fixture documents.
        lag_days: The SF link's lag, in the engine's calendar-day units
            (#2534). Defaults to 2, the lag MPXJ's generated matrix actually
            saved. A caller passing a different value is deliberately
            probing calendar-day vs. working-day divergence, not
            reproducing a saved file.

    Returns:
        A :class:`Project` ready to pass to
        :func:`trueppm_scheduler.engine.schedule`.
    """
    tasks = [
        Task(id="11", name="Task 1", duration=timedelta(days=1)),
        Task(id="12", name="Task 2", duration=timedelta(days=1)),
    ]
    dependencies = [
        Dependency(
            "11",
            "12",
            dep_type=DependencyType.SF,
            lag=timedelta(days=lag_days),
        ),
    ]
    return Project(
        id="task-links-cross-version",
        name="MPXJ task-links generated fixture (SF)",
        start_date=start_date,
        calendar=Calendar(),
        tasks=tasks,
        dependencies=dependencies,
    )
