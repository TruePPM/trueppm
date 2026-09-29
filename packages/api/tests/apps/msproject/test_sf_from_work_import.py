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
2. ``sf_from_work_lagged.xml``'s round trip surfaced a genuine engine gap — the
   project-start floor silently suppresses an SF link's anchor whenever the anchor
   would fall before the project's nominal start date, which is common because SF is
   the one dependency type that can legitimately require the successor to be
   scheduled *before* an early predecessor. See
   ``test_sf_anchor_before_project_start_is_suppressed_by_the_floor``.
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
    return Project.objects.create(
        name="SF lagged real export",
        start_date=date(2026, 10, 5),
        status_date=date(2026, 10, 5),
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
@pytest.mark.xfail(
    strict=True,
    reason=(
        "#4155 finding: the project-start floor silently suppresses an SF link's "
        "anchor whenever the anchor falls before the project's nominal start date. "
        "'Design' (the predecessor) is unconstrained and floats to the project's "
        "very first working day (Monday 2026-10-05, matching the file's own "
        "<StartDate>) — a common, entirely ordinary real-world shape (many real "
        "plans start task 1 on day 1), not a contrived edge case. The SF anchor for "
        "'Dependency SF' is therefore the last working day *before* the project "
        "opens (Friday 2026-10-02), which the file's own MS-Project-computed Start "
        "date confirms (2026-10-02T10:00:00 — day matches at the date granularity "
        "this engine schedules in; the file's hour and its Finish day additionally "
        "reflect the real 2-hour lag that #2290 truncates to zero on import, a "
        "separate and already-tracked limitation, not this bug). "
        "Root cause (reproduces in the pure trueppm_scheduler package, no Django "
        "involved): packages/scheduler/src/trueppm_scheduler/engine.py's "
        "_early_start_floors() unconditionally seeds es_constraints with the "
        "project-start floor for every task, and _forward_pass()'s FF/SF branch "
        "('if min_ef > task.early_finish') only ever pulls a date LATER than what "
        "the floor already implies, never earlier. So when a task's only real "
        "constraint is an SF link whose anchor is before the floor, that anchor "
        "loses to the floor and is treated as non-binding — the task simply floats "
        "to the project-start floor like an unconstrained task would. This is "
        "exactly the degenerate case packages/scheduler/tests/test_sf_from_work.py's "
        "_sf() helper's own docstring calls out and deliberately avoids testing: "
        "'Without [an SNET], A sits on the first working day and its SF anchor "
        "falls before the project opens, where the bound is dominated by B's own "
        "duration and nothing is tested.' It is not a disagreement with the #4145 "
        "anchor FORMULA (confirmed correct in isolation by that same file) — it is "
        "an interaction between the anchor and the project-start floor that #4145 "
        "never exercised. Needs a fresh cross-engine design decision (Python + Rust "
        "+ web), out of scope for this issue per its own instructions; tracked as a "
        "follow-up to #4145."
    ),
)
def test_sf_anchor_before_project_start_is_suppressed_by_the_floor(
    lagged_project: Project,
) -> None:
    by_name = _import_and_schedule(lagged_project, "sf_from_work_lagged.xml")
    sf_task = by_name["Dependency SF"]
    # Currently computed as 2026-10-05 (floored to the project start, same day as
    # "Design") instead of 2026-10-02 (the day before "Design" starts).
    assert sf_task.early_start == date(2026, 10, 2)
