"""A real MS Project SF (start-to-finish) link, with its own saved dates (#4322).

Every SF rule in ``scheduler-conventions.md`` — the SF anchor (#4145), the
SF-only milestone floor (#4218), SF placement vs the project start (#4220) —
was read from the docs and then calibrated against *our own engine's* output,
because the sample set had no MS-Project-saved schedule containing a real SF
link to check against (see ``tests/oracle/reference_cpm.py``'s module
docstring). This fixture closes that gap for the SF anchor rule, case 1 of
#4322: "SF with zero lag, ordinary work on both ends".

Source
------
``LinkTypes.mpp``, an InfiniteSkills "Microsoft Project 2013" video-course
working file demonstrating all four link types (FS/SS/FF/SF) — not one of the
book's own named sample projects. Nobody on this team opened MS Project to
produce these numbers: the task graph, durations, and the Start/Finish dates
below are MSPDI-equivalent data extracted from the saved ``.mpp`` file via
MPXJ, handed to this fixture already extracted. The "Standard" calendar it
uses is Mon-Fri working, 08:00-12:00 + 13:00-17:00, with zero calendar
exceptions in this file — equivalent to this engine's default
:class:`~trueppm_scheduler.models.Calendar` (``hours_per_day``/``timezone``
are reserved-but-inert here regardless, per #4131; the engine schedules in
whole working days, so the half-day lunch break is not and cannot be modeled).
Project start: 2013-01-01 (a Tuesday).

The task names and the "Furntiture" typo in task 1 are reproduced verbatim
from the source file, not corrected — this is a transcription of what MS
Project saved, not a cleaned-up description of it.

What this fixture proves, and what it does not
------------------------------------------------
Task 5 -> task 6 is an ordinary 1-day task feeding an SF link into another
ordinary 1-day task, zero lag, nowhere near a weekend, a milestone, or the
project start. It is case 1 of #4322 and the only one this sample covers.
Cases 2-4 (SF positive lag, SF crossing a weekend, SF out of a zero-duration
milestone) are NOT covered here — see #4327.

Task 6 also carries a second predecessor, task 4, via an ordinary zero-lag FS
link, so it is additionally a general SF+FS combination case: proof the
engine's predecessor combinator produces the right date when an FS-derived
start bound and an SF-derived finish bound are both in play. Task 6 sits deep
in the chain (Jan 7-8, 2013), nowhere near the project start (Jan 1, 2013), so
this does **not** exercise the #4319 mixed-links project-start floor — do not
read it as settling that question.

The full 7-task graph is reproduced (not just tasks 4-6 in isolation) because
that is what MS Project actually scheduled and saved; the earlier tasks are
what put task 4 and task 5 on the dates the SF link anchors from, and
asserting them too is a free general-conformance check across FS, FF, and SS,
on top of the SF case this fixture exists for.
"""

from __future__ import annotations

from datetime import date, timedelta

from trueppm_scheduler import Calendar, Dependency, DependencyType, Project, Task

# A Tuesday, confirmed against MS Project's own saved task 1 start date.
PROJECT_START = date(2013, 1, 1)

# MS-Project-saved Start/Finish, at day-level (the time-of-day an SF-pinned
# finish carries — the start instant of the next day rather than the close of
# the prior one — is a representational detail of the link type, per
# scheduler-conventions.md's SF anchor row; it is not something this engine's
# day-level Task.early_start/early_finish can or needs to reproduce).
EXPECTED_START: dict[str, date] = {
    "1": date(2013, 1, 1),
    "2": date(2013, 1, 3),
    "3": date(2013, 1, 4),
    "4": date(2013, 1, 4),
    "5": date(2013, 1, 8),
    "6": date(2013, 1, 7),
    "7": date(2013, 1, 8),  # milestone: shown day, not an instant
}
EXPECTED_FINISH: dict[str, date] = {
    "1": date(2013, 1, 3),
    "2": date(2013, 1, 3),
    "3": date(2013, 1, 7),
    "4": date(2013, 1, 4),
    "5": date(2013, 1, 8),
    "6": date(2013, 1, 7),  # last working day; MS Project's own Finish field
    # reads 2013-01-08T08:00 (the SF anchor's instant), one day later than this
    # day-level value by construction (see EXPECTED_START/EXPECTED_FINISH note).
    "7": date(2013, 1, 8),  # milestone: shown day, not an instant
}
# Note on task "7" (the milestone): the engine shows it on 2013-01-07 (the end
# of task 6's finish day, an ordinary FS predecessor) rather than 2013-01-08 as
# MS Project saved it — the same midnight, labeled on opposite sides of it.
# That is the milestone display-day convention (#4079/#4173/#4178), unrelated
# to the SF anchor rule (#4145) this fixture exists to verify; see
# ``test_msproject_sf_reference.py``'s exclusion of task 7 from its
# full-chain assertion for why this value is not checked there.


def build_project() -> Project:
    """The 7-task ``LinkTypes.mpp`` graph, as MS Project 2013 saved it.

    Returns:
        A :class:`Project` ready to pass to
        :func:`trueppm_scheduler.engine.schedule`.
    """
    tasks = [
        Task(id="1", name="Move out old Furntiture", duration=timedelta(days=3)),
        Task(id="2", name="Pull up old Carpet", duration=timedelta(days=1)),
        Task(id="3", name="Take down the Curtains", duration=timedelta(days=2)),
        Task(id="4", name="Remove the Curtain Pole", duration=timedelta(days=1)),
        Task(id="5", name="Measure the Room", duration=timedelta(days=1)),
        Task(id="6", name="Vacuum the cobwebs", duration=timedelta(days=1)),
        Task(id="7", name="Empty Room Milestone", duration=timedelta(0)),
    ]
    dependencies = [
        Dependency("1", "2", dep_type=DependencyType.FF),
        Dependency("2", "3", dep_type=DependencyType.FS),
        Dependency("3", "4", dep_type=DependencyType.SS),
        Dependency("4", "5", dep_type=DependencyType.FS),
        Dependency("3", "5", dep_type=DependencyType.FS),
        Dependency("4", "6", dep_type=DependencyType.FS),
        Dependency("5", "6", dep_type=DependencyType.SF),
        Dependency("6", "7", dep_type=DependencyType.FS),
    ]
    return Project(
        id="link-types-2013",
        name="LinkTypes (InfiniteSkills, MS Project 2013)",
        start_date=PROJECT_START,
        calendar=Calendar(),
        tasks=tasks,
        dependencies=dependencies,
    )
