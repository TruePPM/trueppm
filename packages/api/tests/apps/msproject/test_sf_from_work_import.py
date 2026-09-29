"""Confirm the SF-from-work anchor (#4145) against real MS Project exports (#4155).

#4145 changed the Start-to-Finish anchor for ordinary (non-milestone) work to the
MS Project / Primavera P6 reading — an SF link anchors on the last working day
*before* the predecessor's start day — on the maintainer's decision, without first
confirming it against a genuine MS Project export. That confirmation is this file's
job. Both fixtures are real files MS Project itself wrote (see
``fixtures/README.md``'s "Real-export SF-from-work fixtures" section for full
provenance/attribution), imported and scheduled through the real pipeline — unlike
``TestImportBroadcast``/``TestImportRedispatchIdempotency`` in ``test_msproject.py``,
which mock ``enqueue_recalculate`` because they are testing dispatch, not dates.

Two distinct, unrelated limitations surfaced while building these tests and are
documented rather than silently worked around:

1. ``sf_from_work_zero_lag.xml``'s SF successor tasks are ``<Manual>1</Manual>`` in
   the source (MS Project manual-scheduling mode) — their ``<Start>``/``<Finish>``
   are whatever the file's author typed, never computed by MS Project's own CPM
   engine, so they cannot serve as the oracle. See
   ``test_sf_zero_lag_from_a_real_export_matches_the_4145_rule`` for how this is
   handled.
2. ``sf_from_work_lagged.xml``'s round trip surfaced an engine gap, fixed in #4218:
   the project-start floor silently suppressed an SF link's anchor whenever the
   anchor fell before the project's nominal start date, which is common because SF
   is the one dependency type that can legitimately require the successor to be
   scheduled *before* an early predecessor. **Through this import path the fix is
   not observable**, though: the importer turns every task's ``<Start>`` into a
   ``planned_start`` (SNET) and pulls the project start back to the earliest one
   (#2891/#867), so the SF successor is placed by its own imported SNET on
   2026-10-02 with or without the engine fix. See
   ``test_sf_successor_lands_on_ms_projects_date_through_the_import``; the engine
   fix itself is proven through the API by
   ``tests/apps/scheduling/test_sf_before_project_start.py``.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from unittest.mock import patch

import pytest

from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.msproject.parser import parse_xml
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.tasks import _run_schedule

_FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _import_and_schedule(project: Project, fixture_name: str) -> dict[str, Task]:
    content = (_FIXTURES_DIR / fixture_name).read_bytes()
    import_project(str(project.pk), parse_xml(content))
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))
    return {t.name: t for t in Task.objects.filter(project=project)}


# ---------------------------------------------------------------------------
# sf_from_work_zero_lag.xml — genuine MS Project 2010 export, Type=2, LinkLag=0
# ---------------------------------------------------------------------------


@pytest.fixture
def zero_lag_project(db: object) -> Project:
    # Set well before the fixture's own Aug 2014 dates so the project-start floor
    # never dominates the SF anchor (the #4155 finding this file also documents —
    # see test_sf_anchor_before_project_start_is_suppressed_by_the_floor below).
    return Project.objects.create(
        name="SF zero-lag real export",
        start_date=date(2014, 8, 4),
        status_date=date(2014, 8, 4),
        calendar=Calendar.objects.create(name="Standard"),
    )


@pytest.mark.django_db
def test_sf_zero_lag_from_a_real_export_matches_the_4145_rule(
    zero_lag_project: Project,
) -> None:
    """UID 15 "task9" --SF(lag=0)--> UID 16 "task10", read from a real export.

    "task9" is auto-scheduled (``<Manual>0</Manual>``) and MSO-pinned to Monday
    2014-08-18 in the source file — the importer reproduces that pin exactly.
    "task10" is the SF successor. Its own ``<Start>``/``<Finish>`` in the file
    (2014-08-11, a full week *before* task9's pin) are **not** usable as the oracle:
    task10 is ``<Manual>1</Manual>`` in the source, so MS Project never computed
    that date via CPM — it is whatever the file's author typed, and TruePPM's
    importer does not read ``<Manual>`` at all (every task is scheduled through the
    network on import, matching how MS Project itself still treats even a manually
    scheduled task's *link* for critical-path purposes).

    The oracle here is therefore the #4145 rule itself: zero lag means task10's
    finish is the last working day before task9's Monday start, i.e. Friday
    2014-08-15. This test's value is confirming the full pipeline — a real
    MS-Project-authored ``Type=2`` link and a real zero ``LinkLag`` — reproduces
    that rule, not that the file's own (manually overridden) dates match.
    """
    by_name = _import_and_schedule(zero_lag_project, "sf_from_work_zero_lag.xml")

    task9 = by_name["task9"]
    assert task9.early_start == date(2014, 8, 18)  # Monday, MSO-pinned per the file
    assert task9.early_finish == date(2014, 8, 18)

    task10 = by_name["task10"]
    assert task10.early_finish == date(2014, 8, 15)  # Friday — the day BEFORE task9
    assert task10.early_start == date(2014, 8, 15)  # 1-day task (PT8H0M0S)
    assert task10.early_finish < task9.early_start


@pytest.mark.django_db
def test_sf_zero_lag_second_pair_from_the_same_export_agrees(
    zero_lag_project: Project,
) -> None:
    """UID 47 "task24" --SF(lag=0)--> UID 45 "task22": an independent link in the
    same file, corroborating the previous test is not a fluke of one pair.

    Same caveat as above: "task22" is ``<Manual>1</Manual>`` in the source, so its
    file date is not the oracle; the #4145 rule's predicted value is.
    """
    by_name = _import_and_schedule(zero_lag_project, "sf_from_work_zero_lag.xml")

    task24 = by_name["task24"]
    assert task24.early_start == date(2014, 8, 18)  # Monday, MSO-pinned

    task22 = by_name["task22"]
    assert task22.early_finish == date(2014, 8, 15)  # Friday — the day before task24
    assert task22.early_start == date(2014, 8, 15)


# ---------------------------------------------------------------------------
# sf_from_work_lagged.xml — genuine Microsoft Project export, Type=2, 2h lag
# ---------------------------------------------------------------------------


@pytest.fixture
def lagged_project(db: object) -> Project:
    # The fixture's own top-level <StartDate> is 2026-10-05T08:00:00, matching
    # "Design"'s own (unconstrained, ASAP) start — deliberately kept identical
    # here rather than moved earlier, because moving it earlier would dodge
    # exactly the real-world case (a predecessor sitting on the project's first
    # working day) that this file exercises.
    #
    # The status date is the file's own <CurrentDate> (2026-09-10): the file has no
    # <StatusDate>, and MS Project computed its dates as of that day. It is set
    # explicitly because the data date floors an SF-only task where the project
    # start no longer does (#4218) — a status date on the project start (as this
    # fixture had before) holds "Dependency SF" there regardless, which
    # test_the_data_date_still_floors_the_sf_successor pins; and leaving it null
    # would resolve to today's date and make the result depend on the clock.
    return Project.objects.create(
        name="SF lagged real export",
        start_date=date(2026, 10, 5),
        status_date=date(2026, 9, 10),
        calendar=Calendar.objects.create(name="Standard"),
    )


@pytest.mark.django_db
def test_design_predecessor_matches_the_file(lagged_project: Project) -> None:
    """Sanity baseline: the predecessor has no link driving it, so its dates are a
    plain ASAP-from-project-start computation and should match the file exactly."""
    by_name = _import_and_schedule(lagged_project, "sf_from_work_lagged.xml")
    design = by_name["Design"]
    assert design.early_start == date(2026, 10, 5)  # Monday
    assert design.early_finish == date(2026, 10, 7)  # Wednesday (PT24H0M0S = 3 days)


@pytest.mark.django_db
def test_dependency_sf_lag_is_truncated_to_zero_days_on_import(
    lagged_project: Project,
) -> None:
    """The file's real 2-hour SF lag (``LinkLag=1200``, ``LagFormat=5``) is stored
    as ``lag=0`` after import — a real-export corroboration of the already-tested,
    already-accepted #2290 "MSPDI lag unit seam" (``_parse_lag_to_days("2400") ==
    0`` in ``test_msproject.py``): TruePPM schedules in whole working days, so any
    lag under one working day (4800 tenths-of-a-minute = 8h) truncates to zero.
    This is unrelated to the #4145 SF-anchor rule and is not something this issue
    is about fixing — recorded here so the next test's discrepancy is not
    mistakenly attributed to lag precision instead of its real cause.
    """
    by_name = _import_and_schedule(lagged_project, "sf_from_work_lagged.xml")
    sf_task = by_name["Dependency SF"]
    dep = Dependency.objects.get(successor=sf_task, predecessor__name="Design")
    assert dep.dep_type == "SF"
    assert dep.lag == 0


@pytest.mark.django_db
def test_sf_successor_lands_on_ms_projects_date_through_the_import(
    lagged_project: Project,
) -> None:
    """The round trip reproduces MS Project's Fri 2026-10-02 for "Dependency SF".

    "Design" is unconstrained and sits on Mon 2026-10-05. "Dependency SF"'s SF
    anchor is Fri 2026-10-02, the Start MS Project itself computed for it
    (2026-10-02T10:00:00; the hour and its Finish day reflect the real 2-hour lag
    #2290 truncates on import).

    This does NOT discriminate the #4218 engine fix, and says so rather than
    claiming it: the importer stores that same ``<Start>`` as the task's
    ``planned_start`` and pulls the project start back to it, so the SNET alone
    places the task on 10-02 on the unfixed engine too. The discriminating test
    builds the same shape without an SNET
    (``tests/apps/scheduling/test_sf_before_project_start.py``).
    """
    by_name = _import_and_schedule(lagged_project, "sf_from_work_lagged.xml")
    lagged_project.refresh_from_db()
    assert by_name["Design"].early_start == date(2026, 10, 5)
    sf_task = by_name["Dependency SF"]
    assert sf_task.early_start == date(2026, 10, 2)
    # Why the import cannot tell the fix apart: the SNET and the shifted project
    # start both already sit on the answer.
    assert sf_task.planned_start == date(2026, 10, 2)
    assert lagged_project.start_date == date(2026, 10, 2)


@pytest.mark.django_db
def test_the_data_date_still_floors_the_sf_successor(lagged_project: Project) -> None:
    """The data date holds remaining work at "as of now", SNET or SF anchor aside.

    With the status date on Mon 2026-10-05, "Dependency SF" (SF anchor and
    imported SNET both Fri 10-02) is held on 10-05: remaining work is never
    forecast into the past (#4218's design split between the two floors).
    """
    lagged_project.status_date = date(2026, 10, 5)
    lagged_project.save(update_fields=["status_date"])
    by_name = _import_and_schedule(lagged_project, "sf_from_work_lagged.xml")
    assert by_name["Dependency SF"].early_start == date(2026, 10, 5)
