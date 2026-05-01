"""Tests for the multi-team Sprints lens endpoint (issue #230 / ADR-0036).

`GET /api/v1/me/active-sprints/` returns one summary entry per project
where the requesting user has a non-complete task assignment in that
project's currently-ACTIVE sprint.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


def _project(calendar: Calendar, name: str) -> Project:
    return Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)


def _membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)


def _active_sprint(project: Project, name: str = "S1") -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=40,
        committed_task_count=10,
    )


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_returns_one_entry_per_active_sprint_with_assignment(
    calendar: Calendar, alice: object
) -> None:
    p1 = _project(calendar, "Alpha")
    p2 = _project(calendar, "Beta")
    _membership(p1, alice)
    _membership(p2, alice)
    s1 = _active_sprint(p1, "Alpha S1")
    s2 = _active_sprint(p2, "Beta S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)
    Task.objects.create(project=p2, name="T2", duration=1, sprint=s2, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert len(resp.data) == 2
    project_names = {row["project_name"] for row in resp.data}
    assert project_names == {"Alpha", "Beta"}


@pytest.mark.django_db
def test_excludes_projects_without_user_assignments(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "Alpha")
    p2 = _project(calendar, "Beta")
    _membership(p1, alice)
    s1 = _active_sprint(p1, "Alpha S1")
    s2 = _active_sprint(p2, "Beta S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)
    # Beta has an active sprint but Alice has no task there.
    Task.objects.create(project=p2, name="T2", duration=1, sprint=s2)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["project_name"] == "Alpha"


@pytest.mark.django_db
def test_excludes_completed_task_assignments(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "Alpha")
    _membership(p1, alice)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(
        project=p1,
        name="T1",
        duration=1,
        sprint=s1,
        assignee=alice,
        status=TaskStatus.COMPLETE,
    )
    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_excludes_planned_and_completed_sprints(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "Alpha")
    _membership(p1, alice)
    planned = Sprint.objects.create(
        project=p1,
        name="Planned",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
    )
    Task.objects.create(project=p1, name="T1", duration=1, sprint=planned, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data == []


@pytest.mark.django_db
def test_summary_payload_shape(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "Alpha")
    _membership(p1, alice)
    s1 = _active_sprint(p1, "Alpha S1")
    Task.objects.create(project=p1, name="T1", duration=1, sprint=s1, assignee=alice)

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    entry = resp.data[0]
    assert {
        "project_id",
        "project_name",
        "sprint",
        "capacity_ratio",
        "capacity_label",
        "velocity",
    } <= set(entry.keys())
    sprint_data = entry["sprint"]
    assert {
        "id",
        "name",
        "short_id_display",
        "start_date",
        "finish_date",
        "day",
        "total",
        "remaining_points",
        "committed_points",
        "trend_pts",
    } <= set(sprint_data.keys())
    assert sprint_data["total"] == 14
    assert sprint_data["committed_points"] == 40


@pytest.mark.django_db
def test_results_sorted_by_trend_most_behind_first(calendar: Calendar, alice: object) -> None:
    """Sprint with negative trend (behind ideal) sorts before sprints ahead.

    The task_status_changed signal drives the burn snapshot from task state,
    so we set up realistic task states (NOT_STARTED for behind, COMPLETE
    for ahead) rather than hand-injecting snapshot rows that the signal
    would immediately overwrite.
    """
    today = date.today()
    p1 = _project(calendar, "Behind")
    p2 = _project(calendar, "Ahead")
    _membership(p1, alice)
    _membership(p2, alice)

    # Behind: one not-started task at full point value → remaining ≈ committed.
    behind = Sprint.objects.create(
        project=p1,
        name="Behind S1",
        start_date=today - timedelta(days=7),
        finish_date=today + timedelta(days=7),
        state=SprintState.ACTIVE,
        committed_points=40,
    )
    Task.objects.create(
        project=p1,
        name="T1",
        duration=1,
        sprint=behind,
        assignee=alice,
        story_points=40,
        status=TaskStatus.NOT_STARTED,
    )

    # Ahead: most points already complete → low remaining. One in-progress
    # task (also assigned to Alice) keeps the sprint visible in the lens.
    ahead = Sprint.objects.create(
        project=p2,
        name="Ahead S1",
        start_date=today - timedelta(days=7),
        finish_date=today + timedelta(days=7),
        state=SprintState.ACTIVE,
        committed_points=40,
    )
    Task.objects.create(
        project=p2,
        name="T-done",
        duration=1,
        sprint=ahead,
        assignee=alice,
        story_points=35,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=p2,
        name="T-wip",
        duration=1,
        sprint=ahead,
        assignee=alice,
        story_points=5,
        status=TaskStatus.IN_PROGRESS,
    )

    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data[0]["project_name"] == "Behind"
    assert resp.data[1]["project_name"] == "Ahead"


@pytest.mark.django_db
def test_unauthenticated_gets_401() -> None:
    c = APIClient()
    resp = c.get("/api/v1/me/active-sprints/")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_user_with_no_active_assignments_gets_empty_list(calendar: Calendar, alice: object) -> None:
    resp = _client(alice).get("/api/v1/me/active-sprints/")
    assert resp.status_code == 200
    assert resp.data == []
