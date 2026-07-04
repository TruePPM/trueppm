"""Integration guard: a real CPM recompute writes TaskActivityEvent rows (ADR-0207).

The builder is unit-tested in ``test_schedule_shift_events.py``; this exercises the
whole emit path through ``_run_schedule`` so the snapshot-before-overwrite ordering
and the in-atomic-block bulk_create are regression-guarded end to end. If the date
snapshot were ever moved below the writeback overwrite, moved-detection would go
silently false and these tests would fail.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Dependency,
    Project,
    Task,
    TaskActivityEvent,
)
from trueppm_api.apps.scheduling.tasks import _run_schedule


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="StdShift")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="ShiftProj", start_date=date(2026, 1, 5), calendar=calendar)


@pytest.fixture
def chain(project: Project) -> tuple[Task, Task, Task]:
    """A → B → C, all FS, duration 2."""
    a = Task.objects.create(project=project, name="A", duration=2)
    b = Task.objects.create(project=project, name="B", duration=2)
    c = Task.objects.create(project=project, name="C", duration=2)
    Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")
    Dependency.objects.create(predecessor=b, successor=c, dep_type="FS")
    return a, b, c


def _run(project: Project) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))


@pytest.mark.django_db
def test_run_schedule_writes_cpm_recalculated_with_null_actor(
    project: Project, chain: tuple[Task, Task, Task]
) -> None:
    a, _, _ = chain
    _run(project)  # first schedule: every task transitions null -> computed

    events = TaskActivityEvent.objects.filter(event_type="cpm_recalculated")
    assert events.count() == 3, "expected one cpm_recalculated per newly-scheduled task"
    # System events carry a null actor and record the from/to date delta.
    ev = events.filter(task=a).first()
    assert ev is not None
    assert ev.actor_id is None
    assert ev.detail["early_start"]["from"] is None
    assert ev.detail["early_start"]["to"] is not None

    # A stable re-run moves nothing, so no new rows are written.
    _run(project)
    assert TaskActivityEvent.objects.filter(event_type="cpm_recalculated").count() == 3

    # Lengthening the head moves A's own finish AND pushes B and C -> three new rows.
    Task.objects.filter(pk=a.pk).update(duration=6)
    _run(project)
    assert TaskActivityEvent.objects.filter(event_type="cpm_recalculated").count() == 6


@pytest.mark.django_db
def test_run_schedule_emits_baseline_drift_only_on_crossing(
    project: Project, chain: tuple[Task, Task, Task]
) -> None:
    a, b, c = chain
    _run(project)  # establish CPM dates

    # Capture an active baseline snapshotting the current (within-plan) finishes.
    baseline = Baseline.objects.create(
        project=project, name="B1", is_active=True, has_cpm_dates=True
    )
    for t in (a, b, c):
        t.refresh_from_db()
        BaselineTask.objects.create(
            baseline=baseline,
            task_id=t.id,
            task_name=t.name,
            start=t.early_start,
            finish=t.early_finish,
            duration=t.duration,
        )

    # A stable re-run: nothing drifts past the baseline it was just captured from.
    _run(project)
    assert not TaskActivityEvent.objects.filter(event_type="baseline_drift_detected").exists()

    # Lengthen the head so downstream finishes slip past the baseline -> crossings.
    Task.objects.filter(pk=a.pk).update(duration=8)
    _run(project)
    drift = TaskActivityEvent.objects.filter(event_type="baseline_drift_detected")
    assert drift.exists(), "expected a baseline_drift_detected crossing after the slip"
    ev = drift.first()
    assert ev is not None
    assert ev.actor_id is None
    assert ev.detail["drift_days"] > 0
    assert ev.detail["baseline_id"] == str(baseline.pk)
