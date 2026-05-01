"""Sprint burndown — signal-driven UPSERT + scope change tracking."""

from __future__ import annotations

from datetime import date

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintBurnSnapshot,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import upsert_burndown_for_sprint


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=10,
        committed_task_count=2,
    )


def test_upsert_creates_first_row(project: Project) -> None:
    s = _active_sprint(project)
    Task.objects.create(project=project, name="A", duration=1, sprint=s, story_points=4)
    Task.objects.create(project=project, name="B", duration=1, sprint=s, story_points=6)
    upsert_burndown_for_sprint(s, snapshot_date=date(2026, 4, 5))
    snap = SprintBurnSnapshot.objects.get(sprint=s, snapshot_date=date(2026, 4, 5))
    assert snap.remaining_points == 10
    assert snap.completed_points == 0


def test_upsert_overwrites_same_day(project: Project) -> None:
    s = _active_sprint(project)
    t1 = Task.objects.create(project=project, name="A", duration=1, sprint=s, story_points=4)
    Task.objects.create(project=project, name="B", duration=1, sprint=s, story_points=6)
    upsert_burndown_for_sprint(s, snapshot_date=date(2026, 4, 5))
    # Mark one complete and re-upsert
    t1.status = TaskStatus.COMPLETE
    t1.save()
    upsert_burndown_for_sprint(s, snapshot_date=date(2026, 4, 5))
    snap = SprintBurnSnapshot.objects.get(sprint=s, snapshot_date=date(2026, 4, 5))
    assert snap.completed_points == 4
    assert snap.remaining_points == 6


def test_upsert_tracks_positive_scope_change(project: Project) -> None:
    s = _active_sprint(project)
    Task.objects.create(project=project, name="A", duration=1, sprint=s, story_points=4)
    Task.objects.create(project=project, name="B", duration=1, sprint=s, story_points=6)
    Task.objects.create(project=project, name="C", duration=1, sprint=s, story_points=5)  # added!
    upsert_burndown_for_sprint(s, snapshot_date=date(2026, 4, 5))
    snap = SprintBurnSnapshot.objects.get(sprint=s, snapshot_date=date(2026, 4, 5))
    # committed=10, current=15 → scope_change=+5
    assert snap.scope_change_points == 5
    assert snap.scope_change_task_count == 1  # 3 current - 2 committed


def test_upsert_tracks_negative_scope_change(project: Project) -> None:
    s = _active_sprint(project)
    Task.objects.create(project=project, name="A", duration=1, sprint=s, story_points=4)
    upsert_burndown_for_sprint(s, snapshot_date=date(2026, 4, 5))
    snap = SprintBurnSnapshot.objects.get(sprint=s, snapshot_date=date(2026, 4, 5))
    # committed=10, current=4 → scope_change=-6
    assert snap.scope_change_points == -6
    assert snap.scope_change_task_count == -1


def test_signal_fires_on_active_sprint_status_change(project: Project) -> None:
    s = _active_sprint(project)
    today = timezone.localdate()
    t = Task.objects.create(project=project, name="X", duration=1, sprint=s, story_points=3)
    # The INSERT also writes a snapshot since the signal fires on creation —
    # at that point completed_points is 0 because the status is NOT_STARTED.
    pre = SprintBurnSnapshot.objects.get(sprint=s, snapshot_date=today)
    assert pre.completed_points == 0
    t.status = TaskStatus.COMPLETE
    t.save()
    snap = SprintBurnSnapshot.objects.get(sprint=s, snapshot_date=today)
    assert snap.completed_points == 3


def test_signal_no_op_for_non_active_sprint(project: Project) -> None:
    s = Sprint.objects.create(
        project=project,
        name="P",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
        state=SprintState.PLANNED,
    )
    today = timezone.localdate()
    t = Task.objects.create(project=project, name="X", duration=1, sprint=s, story_points=3)
    t.status = TaskStatus.COMPLETE
    t.save()
    assert SprintBurnSnapshot.objects.filter(sprint=s, snapshot_date=today).count() == 0


def test_signal_no_op_for_sprint_less_task(project: Project) -> None:
    today = timezone.localdate()
    t = Task.objects.create(project=project, name="X", duration=1, story_points=3)
    t.status = TaskStatus.COMPLETE
    t.save()
    assert SprintBurnSnapshot.objects.filter(snapshot_date=today).count() == 0
