"""Sprint model invariants — short_id, constraints, history (ADR-0037)."""

from __future__ import annotations

from datetime import date

import pytest
from django.db import IntegrityError

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintBurnSnapshot,
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintState,
)


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=cal)


def _make_sprint(project: Project, *, name: str = "Sprint 1", **kwargs: object) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=kwargs.pop("start_date", date(2026, 4, 1)),
        finish_date=kwargs.pop("finish_date", date(2026, 4, 14)),
        **kwargs,
    )


def test_short_id_assigned_on_create(project: Project) -> None:
    sprint = _make_sprint(project)
    assert sprint.short_id, "short_id should be allocated on create"
    assert len(sprint.short_id) == 8


def test_short_id_unique_per_project(project: Project) -> None:
    s1 = _make_sprint(project, name="Sprint 1")
    s2 = _make_sprint(project, name="Sprint 2")
    assert s1.short_id != s2.short_id


def test_finish_must_be_after_start(project: Project) -> None:
    with pytest.raises(IntegrityError):
        _make_sprint(
            project,
            name="Bad",
            start_date=date(2026, 4, 10),
            finish_date=date(2026, 4, 1),
        )


def test_default_state_is_planned(project: Project) -> None:
    sprint = _make_sprint(project)
    assert sprint.state == SprintState.PLANNED


def test_state_choices_exposed() -> None:
    assert {s.value for s in SprintState} == {
        "PLANNED",
        "ACTIVE",
        "COMPLETED",
        "CANCELLED",
    }


def test_burn_snapshot_unique_per_day(project: Project) -> None:
    sprint = _make_sprint(project)
    SprintBurnSnapshot.objects.create(
        sprint=sprint,
        snapshot_date=date(2026, 4, 5),
        remaining_points=10,
        remaining_task_count=5,
        completed_points=0,
        completed_task_count=0,
    )
    with pytest.raises(IntegrityError):
        SprintBurnSnapshot.objects.create(
            sprint=sprint,
            snapshot_date=date(2026, 4, 5),
            remaining_points=8,
            remaining_task_count=4,
            completed_points=2,
            completed_task_count=1,
        )


def test_close_request_default_status(project: Project) -> None:
    sprint = _make_sprint(project)
    req = SprintCloseRequest.objects.create(sprint=sprint)
    assert req.status == SprintCloseRequestStatus.PENDING
    assert req.carry_over_to == "backlog"


def test_close_request_status_choices() -> None:
    assert {s.value for s in SprintCloseRequestStatus} == {
        "pending",
        "in_flight",
        "completed",
        "failed",
    }


def test_sprint_history_records_changes(project: Project) -> None:
    sprint = _make_sprint(project)
    initial_count = sprint.history.count()
    sprint.goal = "Ship M1"
    sprint.save()
    assert sprint.history.count() == initial_count + 1
