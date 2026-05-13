"""Sprint velocity stats and capacity-check helpers."""

from __future__ import annotations

from datetime import date

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.services import (
    capacity_check,
    capacity_summary,
    velocity_summary,
)
from trueppm_api.apps.resources.models import Resource, TaskResource


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _closed_sprint(
    project: Project,
    *,
    name: str,
    points_committed: int,
    points_completed: int,
    counts_committed: int = 10,
    counts_completed: int = 9,
    closed_offset_days: int = 0,
) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.COMPLETED,
        committed_points=points_committed,
        completed_points=points_completed,
        committed_task_count=counts_committed,
        completed_task_count=counts_completed,
        closed_at=timezone.now(),
    )


def test_velocity_returns_empty_when_no_closed_sprints(project: Project) -> None:
    summary = velocity_summary(project.pk)
    assert summary["sprints"] == []
    assert summary["rolling_avg_points"] is None
    assert summary["forecast_range_low"] is None


def test_velocity_truncates_to_8_sprints(project: Project) -> None:
    for i in range(10):
        _closed_sprint(project, name=f"S{i}", points_committed=20, points_completed=18)
    summary = velocity_summary(project.pk)
    assert len(summary["sprints"]) == 8


def test_velocity_avg_and_stdev_roundtrip(project: Project) -> None:
    _closed_sprint(project, name="S1", points_committed=20, points_completed=10)
    _closed_sprint(project, name="S2", points_committed=20, points_completed=20)
    _closed_sprint(project, name="S3", points_committed=20, points_completed=30)
    summary = velocity_summary(project.pk)
    assert summary["rolling_avg_points"] == 20.0
    assert summary["rolling_stdev_points"] is not None
    assert summary["forecast_range_low"] is not None
    assert summary["forecast_range_high"] >= summary["forecast_range_low"]


def test_velocity_single_sprint_has_avg_no_stdev(project: Project) -> None:
    _closed_sprint(project, name="Only", points_committed=20, points_completed=15)
    summary = velocity_summary(project.pk)
    assert summary["rolling_avg_points"] == 15.0
    assert summary["rolling_stdev_points"] is None
    assert summary["forecast_range_low"] is None


# ---------------------------------------------------------------------------
# Capacity check
# ---------------------------------------------------------------------------


def test_capacity_check_no_warnings_when_zero_assignments(project: Project) -> None:
    s = Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        committed_points=10,
    )
    assert capacity_check(s) == []


def test_capacity_check_warns_for_overcommitment(project: Project) -> None:
    s = Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 7),
        state=SprintState.PLANNED,
        committed_points=20,
    )
    res = Resource.objects.create(name="Aisha", max_units=1.0)
    # Two tasks each at 1.0 units → 2x committed against 1x available.
    t1 = Task.objects.create(project=project, name="A", duration=5, sprint=s)
    t2 = Task.objects.create(project=project, name="B", duration=5, sprint=s)
    TaskResource.objects.create(task=t1, resource=res, units=1.0)
    TaskResource.objects.create(task=t2, resource=res, units=1.0)
    warnings = capacity_check(s)
    assert len(warnings) == 1
    w = warnings[0]
    assert w["type"] == "over_capacity"
    assert w["committed_hours"] > w["available_hours"]
    assert w["suggested_commitment_points"] >= 0


@pytest.mark.django_db
def test_capacity_summary_uses_task_duration_overlap_not_sprint_total(
    project: Project,
) -> None:
    """Committed hours must be proportional to how much of the sprint each task covers (#392).

    A 1-day task and a 10-day task both assigned to the same resource at 1.0 units
    must produce different committed_hours — the sprint total must not be used for both.
    """
    # Mon Apr 13 – Fri Apr 24 (10 working days).
    s = Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 13),
        finish_date=date(2026, 4, 24),
        state=SprintState.PLANNED,
    )
    res = Resource.objects.create(name="Dev", max_units=1.0)

    # 1-day task on the first day of the sprint.
    t1 = Task.objects.create(
        project=project,
        name="Short",
        duration=1,
        sprint=s,
        early_start=date(2026, 4, 13),
        early_finish=date(2026, 4, 13),
    )
    # 10-day task spanning the whole sprint.
    t2 = Task.objects.create(
        project=project,
        name="Long",
        duration=10,
        sprint=s,
        early_start=date(2026, 4, 13),
        early_finish=date(2026, 4, 24),
    )
    TaskResource.objects.create(task=t1, resource=res, units=1.0)
    TaskResource.objects.create(task=t2, resource=res, units=1.0)

    summary = capacity_summary(s)
    member = summary["members"][0]
    hours_per_day = summary["hours_per_day"]
    # Short task contributes 1 working day, long task contributes 10.
    # Total committed = (1 + 10) * hours_per_day.
    assert member["committed_hours"] == round(11 * hours_per_day, 2)
    # Available = 10 working days * hours_per_day.
    assert member["available_hours"] == round(10 * hours_per_day, 2)
