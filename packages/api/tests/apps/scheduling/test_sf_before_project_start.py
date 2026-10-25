"""An SF-only task is placed before the project start through the real pipeline (#4218).

The MS Project import test for the same shape
(``tests/apps/msproject/test_sf_from_work_import.py``) cannot discriminate the fix,
because the importer gives the SF successor an SNET on the very date the fix
produces. These tests build the network through the ORM with **no**
``planned_start`` anywhere, so the only thing that can put the successor before the
project start is the engine honoring its SF link. Both fail on the pre-#4218
scheduler, which held the successor on the project's first working day.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.tasks import _run_schedule

PROJECT_START = date(2026, 10, 5)  # Monday


def _schedule(project: Project) -> dict[str, Task]:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))
    return {t.name: t for t in Task.objects.filter(project=project)}


@pytest.fixture
def project(db: object) -> Project:
    # The status date is set explicitly before the project start: the API resolves a
    # null one to today, and a data date after the start still floors an SF-only
    # task, so an unset value would make the result depend on the clock.
    return Project.objects.create(
        name="SF before project start",
        start_date=PROJECT_START,
        status_date=date(2026, 9, 10),
        calendar=Calendar.objects.create(name="Standard"),
    )


@pytest.mark.django_db
def test_sf_only_successor_is_scheduled_before_the_project_start(project: Project) -> None:
    design = Task.objects.create(project=project, name="Design", duration=3)
    sf_task = Task.objects.create(project=project, name="Dependency SF", duration=2)
    Dependency.objects.create(predecessor=design, successor=sf_task, dep_type="SF", lag=0)

    by_name = _schedule(project)
    project.refresh_from_db()

    assert by_name["Design"].early_start == PROJECT_START
    # Anchor Fri 10-02, the working day before Design; 2d back from it is Thu 10-01.
    assert by_name["Dependency SF"].early_finish == date(2026, 10, 2)
    assert by_name["Dependency SF"].early_start == date(2026, 10, 1)
    assert by_name["Dependency SF"].planned_start is None
    # The project boundary does not move: only the computed dates sit ahead of it.
    assert project.start_date == PROJECT_START


@pytest.mark.django_db
def test_a_data_date_after_the_start_still_holds_the_successor(project: Project) -> None:
    held = date(2026, 10, 6)
    project.status_date = held
    project.save(update_fields=["status_date"])
    design = Task.objects.create(project=project, name="Design", duration=3)
    sf_task = Task.objects.create(project=project, name="Dependency SF", duration=2)
    Dependency.objects.create(predecessor=design, successor=sf_task, dep_type="SF", lag=0)

    assert _schedule(project)["Dependency SF"].early_start == held


@pytest.mark.django_db
def test_a_data_date_on_the_start_does_not_hold_the_successor(project: Project) -> None:
    """A data date on the project start is the project-start floor (#4635, "clamp SF too").

    An SF-only task does not take that floor (#4218), so it keeps its SF placement.
    """
    project.status_date = PROJECT_START
    project.save(update_fields=["status_date"])
    design = Task.objects.create(project=project, name="Design", duration=3)
    sf_task = Task.objects.create(project=project, name="Dependency SF", duration=2)
    Dependency.objects.create(predecessor=design, successor=sf_task, dep_type="SF", lag=0)

    assert _schedule(project)["Dependency SF"].early_start == date(2026, 10, 1)


def _cpm_dates(project: Project) -> dict[str, tuple[object, ...]]:
    return {
        name: (t.early_start, t.early_finish, t.late_start, t.late_finish, t.total_float)
        for name, t in _schedule(project).items()
    }


@pytest.mark.django_db
@pytest.mark.parametrize("dep_type", ["FS", "SS", "FF", "SF"])
def test_a_future_start_with_no_status_date_keeps_every_lag(dep_type: str) -> None:
    """A null status date on a future-start project schedules like one on the start (#4635).

    ``resolve_cpm_status_date`` turns a null status date into today, which on a
    project that starts in the future is a date before the start. The engine used to
    measure a free milestone's outgoing lag from that earlier day, so ``Kickoff
    -X(+10cd)-> Build`` finished Build up to (start - today) days early. Today is
    pinned well before the start so the result does not depend on the clock.
    """
    project = Project.objects.create(
        name="Future start",
        start_date=PROJECT_START,
        status_date=None,
        calendar=Calendar.objects.create(name="Standard"),
    )
    kickoff = Task.objects.create(project=project, name="Kickoff", duration=0)
    build = Task.objects.create(project=project, name="Build", duration=5)
    Dependency.objects.create(predecessor=kickoff, successor=build, dep_type=dep_type, lag=10)

    with patch(
        "trueppm_api.apps.scheduling.services.timezone.localdate",
        return_value=date(2026, 8, 3),
    ):
        null_status = _cpm_dates(project)
    project.status_date = PROJECT_START
    project.save(update_fields=["status_date"])
    on_start = _cpm_dates(project)

    assert null_status == on_start
    # Kickoff on Mon 10-05 plus ten calendar days: FS/SS start Build on Thu 10-15;
    # FF/SF bound its finish at the end of Wed 10-14.
    expected_finish = date(2026, 10, 21) if dep_type in ("FS", "SS") else date(2026, 10, 14)
    assert null_status["Build"][1] == expected_finish
