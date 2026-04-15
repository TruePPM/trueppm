"""Tests for GET /api/v1/projects/{id}/resource-allocation/ (issue #85, ADR-0031).

Covers:
  - Permission gate: VIEWER/MEMBER denied, SCHEDULER+ allowed
  - 409 when no CPM dates exist on the project
  - Response shape: project_id, window_start, window_end, resources list
  - Resource row: id, name, email, max_units, tasks list
  - Task entry: assignment_id, id, name, early_start, early_finish, units, status
  - Null early_start/early_finish tasks included (unscheduled section)
  - Date window filtering (?start=, ?end=)
  - Resource ID filter (?resource=)
  - Status filter (?status=)
  - Tasks fully outside the window are excluded
  - Tasks partially overlapping the window are included
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def cal(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def project(cal: Calendar) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 3, 2), calendar=cal)


@pytest.fixture
def resource(project: Project) -> Resource:
    user = User.objects.create_user(username="ruser", password="pw")
    return Resource.objects.create(
        project=project, name="Alice", email="alice@example.com", max_units=Decimal("1.00"), user=user
    )


@pytest.fixture
def task_scheduled(project: Project) -> Task:
    """Task with CPM dates set."""
    return Task.objects.create(
        project=project,
        name="Design",
        wbs="1",
        duration=5,
        early_start=date(2026, 3, 2),
        early_finish=date(2026, 3, 6),
        status="NOT_STARTED",
    )


@pytest.fixture
def task_unscheduled(project: Project) -> Task:
    """Task with no CPM dates (unscheduled)."""
    return Task.objects.create(
        project=project,
        name="Unplanned",
        wbs="2",
        duration=3,
        status="NOT_STARTED",
    )


def _auth_client(role: int, project: Project) -> APIClient:
    username = f"u{role}_{project.pk}"
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/resource-allocation/"


# ---------------------------------------------------------------------------
# Permission gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_permission_denied_below_scheduler(role: int, project: Project) -> None:
    client = _auth_client(role, project)
    resp = client.get(_url(project))
    assert resp.status_code == 403


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.SCHEDULER, Role.OWNER])
def test_permission_allowed_scheduler_and_above(
    role: int, project: Project, resource: Resource, task_scheduled: Task
) -> None:
    TaskResource.objects.create(
        task=task_scheduled, resource=resource, units=Decimal("1.00")
    )
    client = _auth_client(role, project)
    resp = client.get(
        _url(project),
        {"start": "2026-03-02", "end": "2026-03-08"},
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# 409 when schedule not run
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_409_when_no_cpm_dates(project: Project, resource: Resource) -> None:
    """If no tasks have CPM dates, the endpoint returns 409."""
    task = Task.objects.create(
        project=project, name="T", wbs="1", duration=1, status="NOT_STARTED"
    )
    TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.00"))
    client = _auth_client(Role.SCHEDULER, project)
    # No start/end params — endpoint tries to derive window from CPM dates
    resp = client.get(_url(project))
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_response_shape(
    project: Project, resource: Resource, task_scheduled: Task
) -> None:
    assignment = TaskResource.objects.create(
        task=task_scheduled, resource=resource, units=Decimal("0.50")
    )
    client = _auth_client(Role.SCHEDULER, project)
    resp = client.get(
        _url(project),
        {"start": "2026-03-02", "end": "2026-03-08"},
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["project_id"] == str(project.pk)
    assert data["window_start"] == "2026-03-02"
    assert data["window_end"] == "2026-03-08"
    assert isinstance(data["resources"], list)
    assert len(data["resources"]) == 1

    r = data["resources"][0]
    assert r["id"] == str(resource.pk)
    assert r["name"] == "Alice"
    assert r["email"] == "alice@example.com"
    assert r["max_units"] == "1.00"

    assert len(r["tasks"]) == 1
    t = r["tasks"][0]
    assert t["assignment_id"] == str(assignment.pk)
    assert t["id"] == str(task_scheduled.pk)
    assert t["name"] == "Design"
    assert t["early_start"] == "2026-03-02"
    assert t["early_finish"] == "2026-03-06"
    assert t["units"] == "0.50"
    assert t["status"] == "NOT_STARTED"


# ---------------------------------------------------------------------------
# Unscheduled tasks are included with null dates
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_unscheduled_tasks_included(
    project: Project,
    resource: Resource,
    task_scheduled: Task,
    task_unscheduled: Task,
) -> None:
    TaskResource.objects.create(
        task=task_scheduled, resource=resource, units=Decimal("1.00")
    )
    TaskResource.objects.create(
        task=task_unscheduled, resource=resource, units=Decimal("0.50")
    )
    client = _auth_client(Role.SCHEDULER, project)
    resp = client.get(
        _url(project),
        {"start": "2026-03-02", "end": "2026-03-08"},
    )
    assert resp.status_code == 200
    tasks = resp.json()["resources"][0]["tasks"]
    task_names = {t["name"] for t in tasks}
    assert "Design" in task_names
    assert "Unplanned" in task_names

    unscheduled = next(t for t in tasks if t["name"] == "Unplanned")
    assert unscheduled["early_start"] is None
    assert unscheduled["early_finish"] is None


# ---------------------------------------------------------------------------
# Window filtering
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_outside_window_excluded(
    project: Project, resource: Resource
) -> None:
    """A task that finishes before the window start is excluded."""
    old_task = Task.objects.create(
        project=project,
        name="OldTask",
        wbs="1",
        duration=3,
        early_start=date(2026, 1, 5),
        early_finish=date(2026, 1, 7),
        status="COMPLETE",
    )
    TaskResource.objects.create(task=old_task, resource=resource, units=Decimal("1.00"))
    client = _auth_client(Role.SCHEDULER, project)
    resp = client.get(
        _url(project),
        {"start": "2026-03-02", "end": "2026-03-08"},
    )
    assert resp.status_code == 200
    # Resource row should be absent (no tasks in window)
    assert len(resp.json()["resources"]) == 0


@pytest.mark.django_db
def test_task_partially_overlapping_window_included(
    project: Project, resource: Resource
) -> None:
    """A task that starts before but overlaps the window is included."""
    task = Task.objects.create(
        project=project,
        name="Overlap",
        wbs="1",
        duration=5,
        early_start=date(2026, 2, 27),
        early_finish=date(2026, 3, 3),
        status="IN_PROGRESS",
    )
    TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.00"))
    client = _auth_client(Role.SCHEDULER, project)
    resp = client.get(
        _url(project),
        {"start": "2026-03-02", "end": "2026-03-08"},
    )
    assert resp.status_code == 200
    task_names = [t["name"] for t in resp.json()["resources"][0]["tasks"]]
    assert "Overlap" in task_names


# ---------------------------------------------------------------------------
# Resource filter
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resource_filter(project: Project, resource: Resource, task_scheduled: Task) -> None:
    other_user = User.objects.create_user(username="bob_res", password="pw")
    other = Resource.objects.create(
        project=project, name="Bob", email="bob@example.com",
        max_units=Decimal("1.00"), user=other_user
    )
    other_task = Task.objects.create(
        project=project, name="BobTask", wbs="2", duration=2,
        early_start=date(2026, 3, 4), early_finish=date(2026, 3, 5),
        status="NOT_STARTED",
    )
    TaskResource.objects.create(task=task_scheduled, resource=resource, units=Decimal("1.00"))
    TaskResource.objects.create(task=other_task, resource=other, units=Decimal("1.00"))

    client = _auth_client(Role.SCHEDULER, project)
    resp = client.get(
        _url(project),
        {"start": "2026-03-02", "end": "2026-03-08", "resource": str(resource.pk)},
    )
    assert resp.status_code == 200
    names = [r["name"] for r in resp.json()["resources"]]
    assert names == ["Alice"]
    assert "Bob" not in names


# ---------------------------------------------------------------------------
# Status filter
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_status_filter(project: Project, resource: Resource) -> None:
    t1 = Task.objects.create(
        project=project, name="Started", wbs="1", duration=2,
        early_start=date(2026, 3, 2), early_finish=date(2026, 3, 3),
        status="IN_PROGRESS",
    )
    t2 = Task.objects.create(
        project=project, name="Done", wbs="2", duration=2,
        early_start=date(2026, 3, 4), early_finish=date(2026, 3, 5),
        status="COMPLETE",
    )
    TaskResource.objects.create(task=t1, resource=resource, units=Decimal("1.00"))
    TaskResource.objects.create(task=t2, resource=resource, units=Decimal("1.00"))

    client = _auth_client(Role.SCHEDULER, project)
    resp = client.get(
        _url(project),
        {"start": "2026-03-02", "end": "2026-03-08", "status": "IN_PROGRESS"},
    )
    assert resp.status_code == 200
    task_names = [t["name"] for t in resp.json()["resources"][0]["tasks"]]
    assert "Started" in task_names
    assert "Done" not in task_names
