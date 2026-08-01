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

from datetime import date
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
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
    return Resource.objects.create(
        name="Alice",
        email="alice@example.com",
        max_units=Decimal("1.00"),
    )


@pytest.fixture
def task_scheduled(project: Project) -> Task:
    """Task with CPM dates set."""
    return Task.objects.create(
        project=project,
        name="Design",
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
    TaskResource.objects.create(task=task_scheduled, resource=resource, units=Decimal("1.00"))
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
    task = Task.objects.create(project=project, name="T", duration=1, status="NOT_STARTED")
    TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.00"))
    client = _auth_client(Role.SCHEDULER, project)
    # No start/end params — endpoint tries to derive window from CPM dates
    resp = client.get(_url(project))
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_response_shape(project: Project, resource: Resource, task_scheduled: Task) -> None:
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
    TaskResource.objects.create(task=task_scheduled, resource=resource, units=Decimal("1.00"))
    TaskResource.objects.create(task=task_unscheduled, resource=resource, units=Decimal("0.50"))
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
def test_task_outside_window_excluded(project: Project, resource: Resource) -> None:
    """A task that finishes before the window start is excluded."""
    old_task = Task.objects.create(
        project=project,
        name="OldTask",
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
def test_task_partially_overlapping_window_included(project: Project, resource: Resource) -> None:
    """A task that starts before but overlaps the window is included."""
    task = Task.objects.create(
        project=project,
        name="Overlap",
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
    other = Resource.objects.create(
        name="Bob",
        email="bob@example.com",
        max_units=Decimal("1.00"),
    )
    other_task = Task.objects.create(
        project=project,
        name="BobTask",
        duration=2,
        early_start=date(2026, 3, 4),
        early_finish=date(2026, 3, 5),
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
        project=project,
        name="Started",
        duration=2,
        early_start=date(2026, 3, 2),
        early_finish=date(2026, 3, 3),
        status="IN_PROGRESS",
    )
    t2 = Task.objects.create(
        project=project,
        name="Done",
        duration=2,
        early_start=date(2026, 3, 4),
        early_finish=date(2026, 3, 5),
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


# ---------------------------------------------------------------------------
# #2677 / ADR-0752 — the allocation timeline windows/serializes on the task's
# SPAN, not the remaining-work window, so reporting progress does not shrink
# or drop the allocation bar. Mirrors #2623's utilization fix.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestResourceAllocationUsesSpanNotRemainingWindow:
    """Since ADR-0132, ``early_start`` is an in-progress task's *remaining-work*
    window — it shrinks toward ``early_finish`` as ``percent_complete`` rises.
    Windowing/serializing the allocation timeline on it made reporting progress
    look like the bar shrinking or dropping off the timeline. These tests set
    the CPM fields directly to the values the engine would produce at each
    state — they do not run the scheduler — so they isolate the view's
    windowing/serialization logic from engine correctness.
    """

    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="SpanCal", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="SpanProj", start_date=date(2026, 3, 2), calendar=self.cal
        )
        self.resource = Resource.objects.create(name="Ivy", max_units=Decimal("1.00"))
        self.client = _auth_client(Role.SCHEDULER, self.project)

    def _assign(self, task: Task) -> None:
        TaskResource.objects.create(task=task, resource=self.resource, units=Decimal("1.00"))

    def _tasks(self, start: str = "2026-03-02", end: str = "2026-03-05") -> list[dict]:
        resp = self.client.get(_url(self.project), {"start": start, "end": end})
        assert resp.status_code == 200
        resources = resp.json()["resources"]
        return resources[0]["tasks"] if resources else []

    def test_in_progress_task_stays_in_window_and_reports_scheduled_start(self) -> None:
        """A 4-day task at 83% complete has a remaining window (early_start) of
        a single day near early_finish, but its real SPAN (scheduled_start)
        starts on day one. The task must remain in a window covering the full
        span, and the response must carry scheduled_start so the client draws
        the full bar rather than the shrunken remaining window."""
        task = Task.objects.create(
            project=self.project,
            name="AlmostDone",
            duration=4,
            early_start=date(2026, 3, 5),  # remaining window: Thu only
            early_finish=date(2026, 3, 5),
            scheduled_start=date(2026, 3, 2),  # real span: Mon–Thu
            actual_start=date(2026, 3, 2),
            percent_complete=83,
            status=TaskStatus.IN_PROGRESS,
        )
        self._assign(task)

        tasks = self._tasks(start="2026-03-02", end="2026-03-05")
        assert len(tasks) == 1
        assert tasks[0]["name"] == "AlmostDone"
        assert tasks[0]["scheduled_start"] == "2026-03-02"
        assert tasks[0]["early_finish"] == "2026-03-05"

    def test_task_dropped_by_remaining_window_alone_is_retained(self) -> None:
        """Direct repro of the issue: an in-progress task whose remaining window
        (early_start) has moved past the query end must still appear, because
        its SPAN (scheduled_start) still overlaps the window — pre-fix, this
        task would have been excluded entirely."""
        task = Task.objects.create(
            project=self.project,
            name="MostlyDone",
            duration=4,
            early_start=date(2026, 3, 6),  # remaining window: outside 3/2..3/3
            early_finish=date(2026, 3, 6),
            scheduled_start=date(2026, 3, 2),  # real span starts inside the window
            actual_start=date(2026, 3, 2),
            percent_complete=90,
            status=TaskStatus.IN_PROGRESS,
        )
        self._assign(task)

        tasks = self._tasks(start="2026-03-02", end="2026-03-03")
        assert [t["name"] for t in tasks] == ["MostlyDone"]

    def test_missing_scheduled_start_falls_back_to_early_start(self) -> None:
        """A task with no ``scheduled_start`` (not yet recalculated since the
        ADR-0752 migration) must still be windowed correctly, falling back to
        ``early_start`` — the pre-#2622 behavior — rather than being dropped,
        and the response reports scheduled_start as null for the client's own
        fallback."""
        task = Task.objects.create(
            project=self.project,
            name="NotYetRecalculated",
            duration=4,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 5),
            scheduled_start=None,
            percent_complete=0,
            status=TaskStatus.NOT_STARTED,
        )
        self._assign(task)

        tasks = self._tasks()
        assert [t["name"] for t in tasks] == ["NotYetRecalculated"]
        assert tasks[0]["scheduled_start"] is None

    def test_default_window_start_uses_span_not_remaining_window(self) -> None:
        """With no ?start param, the default window start must derive from the
        task's SPAN start, not its narrowed remaining-work start — otherwise an
        in-progress task's own default window would exclude its own early days."""
        task = Task.objects.create(
            project=self.project,
            name="InProgress",
            duration=4,
            early_start=date(2026, 3, 5),  # remaining window narrows to day 4
            early_finish=date(2026, 3, 5),
            scheduled_start=date(2026, 3, 2),  # real span starts on day 1
            actual_start=date(2026, 3, 2),
            percent_complete=83,
            status=TaskStatus.IN_PROGRESS,
        )
        self._assign(task)

        resp = self.client.get(_url(self.project))  # no start/end — defaults resolved
        assert resp.status_code == 200
        assert resp.json()["window_start"] == "2026-03-02"
