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
    # The status date is set explicitly before the SF anchor: the API resolves a
    # null one to today, and the data date still floors an SF-only task, so an
    # unset value would make the result depend on the clock.
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
def test_a_data_date_after_the_anchor_still_holds_the_successor(project: Project) -> None:
    project.status_date = PROJECT_START
    project.save(update_fields=["status_date"])
    design = Task.objects.create(project=project, name="Design", duration=3)
    sf_task = Task.objects.create(project=project, name="Dependency SF", duration=2)
    Dependency.objects.create(predecessor=design, successor=sf_task, dep_type="SF", lag=0)

    assert _schedule(project)["Dependency SF"].early_start == PROJECT_START
