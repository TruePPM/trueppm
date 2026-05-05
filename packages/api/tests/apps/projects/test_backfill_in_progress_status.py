"""Tests for the backfill_in_progress_status management command (#336)."""

from __future__ import annotations

from datetime import date, timedelta
from io import StringIO

import pytest
from django.core.management import call_command
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Project, Task


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _run(*args: str) -> str:
    out = StringIO()
    call_command("backfill_in_progress_status", *args, stdout=out)
    return out.getvalue()


@pytest.mark.django_db
def test_backfills_not_started_with_today_planned_start(project: Project) -> None:
    today = timezone.localdate()
    t = Task.objects.create(
        project=project,
        name="Stale",
        duration=3,
        status="NOT_STARTED",
        planned_start=today,
    )
    output = _run()
    t.refresh_from_db()
    assert t.status == "IN_PROGRESS"
    assert t.actual_start == today
    assert "Backfilled 1 task" in output


@pytest.mark.django_db
def test_backfills_not_started_with_past_planned_start(project: Project) -> None:
    past = timezone.localdate() - timedelta(days=10)
    t = Task.objects.create(
        project=project,
        name="Older",
        duration=3,
        status="NOT_STARTED",
        planned_start=past,
    )
    _run()
    t.refresh_from_db()
    assert t.status == "IN_PROGRESS"
    assert t.actual_start == past  # historical date preserved


@pytest.mark.django_db
def test_does_not_touch_future_planned_start(project: Project) -> None:
    future = timezone.localdate() + timedelta(days=10)
    t = Task.objects.create(
        project=project,
        name="Later",
        duration=3,
        status="NOT_STARTED",
        planned_start=future,
    )
    output = _run()
    t.refresh_from_db()
    assert t.status == "NOT_STARTED"
    assert t.actual_start is None
    assert "No tasks to backfill" in output


@pytest.mark.django_db
def test_does_not_touch_backlog_or_in_progress_or_complete(project: Project) -> None:
    today = timezone.localdate()
    backlog = Task.objects.create(
        project=project,
        name="B",
        duration=2,
        status="BACKLOG",
        planned_start=today,
    )
    in_prog = Task.objects.create(
        project=project,
        name="I",
        duration=2,
        status="IN_PROGRESS",
        planned_start=today,
        actual_start=today,
    )
    complete = Task.objects.create(
        project=project,
        name="C",
        duration=2,
        status="COMPLETE",
        planned_start=today,
    )

    _run()

    backlog.refresh_from_db()
    in_prog.refresh_from_db()
    complete.refresh_from_db()
    assert backlog.status == "BACKLOG"
    assert in_prog.status == "IN_PROGRESS"
    assert complete.status == "COMPLETE"


@pytest.mark.django_db
def test_does_not_touch_not_started_with_null_planned_start(project: Project) -> None:
    t = Task.objects.create(
        project=project,
        name="Unscheduled",
        duration=3,
        status="NOT_STARTED",
        planned_start=None,
    )
    _run()
    t.refresh_from_db()
    assert t.status == "NOT_STARTED"
    assert t.actual_start is None


@pytest.mark.django_db
def test_preserves_existing_actual_start(project: Project) -> None:
    """A row with an existing actual_start (e.g. set by a prior buggy migration)
    must not be overwritten."""
    historical = timezone.localdate() - timedelta(days=30)
    t = Task.objects.create(
        project=project,
        name="Half-fixed",
        duration=3,
        status="NOT_STARTED",
        planned_start=timezone.localdate(),
        actual_start=historical,
    )
    _run()
    t.refresh_from_db()
    assert t.status == "IN_PROGRESS"
    assert t.actual_start == historical  # not overwritten


@pytest.mark.django_db
def test_dry_run_writes_nothing(project: Project) -> None:
    today = timezone.localdate()
    t = Task.objects.create(
        project=project,
        name="Stale",
        duration=3,
        status="NOT_STARTED",
        planned_start=today,
    )
    output = _run("--dry-run")
    t.refresh_from_db()
    assert t.status == "NOT_STARTED"
    assert "no changes written" in output


@pytest.mark.django_db
def test_idempotent_second_run_is_a_noop(project: Project) -> None:
    today = timezone.localdate()
    Task.objects.create(
        project=project,
        name="Stale",
        duration=3,
        status="NOT_STARTED",
        planned_start=today,
    )
    first = _run()
    second = _run()
    assert "Backfilled 1 task" in first
    assert "No tasks to backfill" in second
