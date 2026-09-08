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
from django.db import connection
from django.test.utils import CaptureQueriesContext
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


# ---------------------------------------------------------------------------
# Perf contract (#3576 / ADR-1118): bounded query count, no literal NOT IN,
# and a cap that falls on a resource boundary
# ---------------------------------------------------------------------------


def _seed_resources(project: Project, count: int, per_resource: int = 2, offset: int = 0) -> None:
    """Create ``count`` resources, each holding ``per_resource`` assignments.

    Rows, not page size, are the variable the N+1 guard below moves: two requests
    at different ``?page_size=`` values are the *same* request and prove nothing.
    ``offset`` keeps names unique when a test seeds a second, larger cohort.
    """
    for r in range(offset, offset + count):
        resource = Resource.objects.create(
            name=f"R{r:03d}",
            email=f"r{r:03d}@example.com",
            max_units=Decimal("1.00"),
        )
        for t in range(per_resource):
            task = Task.objects.create(
                project=project,
                name=f"T{r:03d}-{t}",
                duration=5,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 6),
                status=TaskStatus.NOT_STARTED,
            )
            TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.50"))


@pytest.mark.django_db
class TestResourceAllocationQueryBudget:
    """The read cost must not grow with the number of assignment rows."""

    def test_query_count_is_flat_in_the_number_of_resources(self, project: Project) -> None:
        client = _auth_client(Role.SCHEDULER, project)

        _seed_resources(project, count=1)
        # Warm per-process caches (content types, permissions) so the first
        # measured request is not charged for them.
        assert client.get(_url(project)).status_code == 200

        with CaptureQueriesContext(connection) as small:
            small_body = client.get(_url(project)).json()

        _seed_resources(project, count=10, offset=1)
        with CaptureQueriesContext(connection) as large:
            large_body = client.get(_url(project)).json()

        # Not vacuous: the second request really did serve ten times the rows.
        assert len(small_body["resources"]) == 1
        assert len(large_body["resources"]) == 11
        assert sum(len(r["tasks"]) for r in large_body["resources"]) == 22

        assert len(large.captured_queries) == len(small.captured_queries), (
            "allocation query count grew with the row count: "
            f"{len(small.captured_queries)} → {len(large.captured_queries)}"
        )

    def test_the_assignment_read_is_bounded_by_a_limit(self, project: Project) -> None:
        """The row-fetching statement must carry a LIMIT.

        Be precise about what this buys: the plan is `Sort → Limit`, so Postgres
        still reads the whole filtered join — the LIMIT lets it keep a bounded
        top-N heap instead of materializing and ordering every row, and it caps
        what crosses the wire. It does not let the scan stop early. Asserted on
        the compiled SQL rather than on timing.
        """
        client = _auth_client(Role.SCHEDULER, project)
        _seed_resources(project, count=3)

        with CaptureQueriesContext(connection) as ctx:
            assert client.get(_url(project)).status_code == 200

        assignment_reads = [
            q["sql"] for q in ctx.captured_queries if "resources_task_resource" in q["sql"]
        ]
        assert assignment_reads, "no statement read the assignment table"
        assert all("LIMIT" in sql for sql in assignment_reads)

    def test_resources_are_not_sorted_on_the_joined_resource_name(self, project: Project) -> None:
        """ORDER BY must not reach into resources_resource.name (ADR-1118).

        The by-name ordering the response promises is restored in Python; the
        SQL sorts on a local column so a LIMIT can stop the scan early.
        """
        client = _auth_client(Role.SCHEDULER, project)
        _seed_resources(project, count=3)

        with CaptureQueriesContext(connection) as ctx:
            body = client.get(_url(project)).json()

        row_read = next(
            q["sql"]
            for q in ctx.captured_queries
            if "resources_task_resource" in q["sql"] and "ORDER BY" in q["sql"]
        )
        order_clause = row_read.split("ORDER BY", 1)[1]
        assert "resources_resource" not in order_clause, order_clause

        # The promise the Python sort has to keep.
        names = [r["name"] for r in body["resources"]]
        assert names == sorted(names)


@pytest.mark.django_db
class TestResourceAllocationCap:
    """The cap is disclosed, and it never returns half a resource (ADR-1118)."""

    def test_untruncated_response_reports_its_own_resource_count(self, project: Project) -> None:
        client = _auth_client(Role.SCHEDULER, project)
        _seed_resources(project, count=4)

        body = client.get(_url(project)).json()
        assert body["truncated"] is False
        assert body["resource_count"] == 4
        assert len(body["resources"]) == 4

    def test_cap_drops_whole_resources_and_says_so(
        self, project: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A resource is returned entire or not at all.

        ADR-0031 sums a resource's spans client-side, so a resource returned with
        only some of its spans would report a *wrong* load, not an incomplete one.
        The cap therefore rewinds to the last complete resource.
        """
        from trueppm_api.apps.projects import views as project_views

        client = _auth_client(Role.SCHEDULER, project)
        _seed_resources(project, count=4, per_resource=3)  # 12 assignment rows

        # A cap of 7 lands mid-way through the third resource's three rows.
        monkeypatch.setattr(project_views, "_ALLOCATION_ASSIGNMENT_LIMIT", 7)
        body = client.get(_url(project)).json()

        assert body["truncated"] is True
        assert body["resource_count"] == 4, "the count reports the full scope, not the page"
        assert len(body["resources"]) == 2, "the half-fetched third resource was dropped"
        for resource in body["resources"]:
            assert len(resource["tasks"]) == 3, "a returned resource is missing spans"

    def test_cap_exactly_on_a_boundary_keeps_every_whole_resource(
        self, project: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A cap that coincides with a resource boundary must not over-trim.

        The overflow row belongs to the *next* resource, so the boundary rewind
        has nothing to drop — the off-by-one that would silently lose a complete
        resource here is exactly what the +1 probe row exists to avoid.
        """
        from trueppm_api.apps.projects import views as project_views

        client = _auth_client(Role.SCHEDULER, project)
        _seed_resources(project, count=3, per_resource=2)  # 6 rows, 3 resources

        monkeypatch.setattr(project_views, "_ALLOCATION_ASSIGNMENT_LIMIT", 4)
        body = client.get(_url(project)).json()

        assert body["truncated"] is True
        assert len(body["resources"]) == 2
        assert all(len(r["tasks"]) == 2 for r in body["resources"])
