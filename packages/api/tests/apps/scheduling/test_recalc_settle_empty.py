"""Recalc paths that produce no schedule must still settle the task-run result (#1976).

Several successful ``_run_schedule`` paths return before the CPM write — most
commonly a project with no schedulable tasks (empty, or all BACKLOG/EPIC/deleted).
Before #1976 these returned without calling ``tracker.set_result(...)``, so the
``task_run_completed`` broadcast carried ``result_summary=None`` and the web
client's "Recalculating…" badge spun forever. ``_settle_empty`` records a
dateless-but-settled result on those paths so the client can stop the spinner.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import Mock

import pytest

from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.tasks import _run_schedule

START = date(2026, 3, 2)  # a Monday


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.mark.django_db
def test_empty_project_settles_dateless_result(calendar: Calendar) -> None:
    """A project with zero tasks records a settled, dateless result."""
    project = Project.objects.create(name="Empty", start_date=START, calendar=calendar)
    tracker = Mock()

    _run_schedule(str(project.pk), tracker)

    tracker.set_result.assert_called_once_with({"project_finish": None, "critical_path": []})


@pytest.mark.django_db
def test_only_backlog_tasks_settles_dateless_result(calendar: Calendar) -> None:
    """A project whose only tasks are non-schedulable (BACKLOG) has no CPM feed,
    but the run must still settle so the badge clears."""
    project = Project.objects.create(name="Ideas", start_date=START, calendar=calendar)
    Task.objects.create(project=project, name="Someday", duration=3, status="BACKLOG")
    tracker = Mock()

    _run_schedule(str(project.pk), tracker)

    tracker.set_result.assert_called_once_with({"project_finish": None, "critical_path": []})


@pytest.mark.django_db
def test_missing_project_settles_dateless_result(calendar: Calendar) -> None:
    """A recalc dispatched for a since-deleted project still settles its run."""
    missing_pk = "00000000-0000-0000-0000-000000000000"
    tracker = Mock()

    _run_schedule(missing_pk, tracker)

    tracker.set_result.assert_called_once_with({"project_finish": None, "critical_path": []})
