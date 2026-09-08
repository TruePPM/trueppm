"""Tests for GET /api/v1/programs/{id}/resource-contention/ (issue #1149).

The program-scoped counterpart to the per-project resource-allocation endpoint
(#85, ADR-0031). Covers:
  - Permission gate: VIEWER/MEMBER on the program denied, SCHEDULER+ allowed
  - 409 when no member project has CPM dates
  - Response shape: program_id, window_start, window_end, resources list
  - Cross-project aggregation: one resource's spans from two member projects are
    merged under one resource row, each span tagged with its source project
  - The contention scenario (>100% across sibling projects in an overlapping window)
  - Projects of OTHER programs are excluded from the scope
  - Resource + status filters; explicit window
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project, Task, TaskStatus
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def cal(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="GA Launch", code="GALA")


@pytest.fixture
def project_a(program: Program, cal: Calendar) -> Project:
    return Project.objects.create(
        name="Security", start_date=date(2026, 7, 6), calendar=cal, program=program
    )


@pytest.fixture
def project_b(program: Program, cal: Calendar) -> Project:
    return Project.objects.create(
        name="SOC2", start_date=date(2026, 7, 6), calendar=cal, program=program
    )


@pytest.fixture
def janus(db: object) -> Resource:
    """A person spanning two projects of the program (the contention persona)."""
    return Resource.objects.create(
        name="Janus", email="janus@trueppm.demo", max_units=Decimal("1.00")
    )


def _scheduled_task(project: Project, name: str, start: date, finish: date) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=5,
        early_start=start,
        early_finish=finish,
        status="NOT_STARTED",
    )


def _auth_client(role: int, program: Program) -> APIClient:
    user = User.objects.create_user(username=f"u{role}_{program.pk}", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/resource-contention/"


# ---------------------------------------------------------------------------
# Permission gate — Scheduler+ even on read (web-rule 94)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_permission_denied_below_scheduler(role: int, program: Program) -> None:
    client = _auth_client(role, program)
    resp = client.get(_url(program))
    assert resp.status_code == 403


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.SCHEDULER, Role.ADMIN, Role.OWNER])
def test_permission_allowed_scheduler_and_above(
    role: int, program: Program, project_a: Project, janus: Resource
) -> None:
    task = _scheduled_task(project_a, "Pen test", date(2026, 7, 6), date(2026, 7, 10))
    TaskResource.objects.create(task=task, resource=janus, units=Decimal("1.00"))
    client = _auth_client(role, program)
    resp = client.get(_url(program), {"start": "2026-07-06", "end": "2026-07-31"})
    assert resp.status_code == 200


@pytest.mark.django_db
def test_non_member_gets_404_not_403(program: Program) -> None:
    """A non-member sees a uniform 404, not 403 — get_queryset scopes to the
    caller's programs, so get_object() hides the program's existence (no
    object-existence leak via 403-vs-404)."""
    user = User.objects.create_user(username="outsider", password="pw")
    c = APIClient()
    c.force_authenticate(user=user)
    resp = c.get(_url(program))
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 409 when nothing is scheduled
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_409_when_no_member_project_has_cpm_dates(program: Program, project_a: Project) -> None:
    # Project exists but its task carries no CPM dates.
    Task.objects.create(project=project_a, name="Unplanned", duration=3, status="NOT_STARTED")
    client = _auth_client(Role.SCHEDULER, program)
    resp = client.get(_url(program))
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Cross-project aggregation + contention
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_aggregates_one_resource_across_two_projects(
    program: Program, project_a: Project, project_b: Project, janus: Resource
) -> None:
    """Janus on Security (1.0) AND SOC2 (0.5) in the same window → one row, two
    spans, each tagged with its project — the data that surfaces >100% contention."""
    t_sec = _scheduled_task(project_a, "Remediate criticals", date(2026, 7, 13), date(2026, 7, 21))
    t_soc = _scheduled_task(project_b, "Evidence collection", date(2026, 7, 13), date(2026, 7, 20))
    TaskResource.objects.create(task=t_sec, resource=janus, units=Decimal("1.00"))
    TaskResource.objects.create(task=t_soc, resource=janus, units=Decimal("0.50"))

    client = _auth_client(Role.SCHEDULER, program)
    resp = client.get(_url(program), {"start": "2026-07-06", "end": "2026-07-31"})
    assert resp.status_code == 200
    body = resp.json()

    assert body["program_id"] == str(program.id)
    assert len(body["resources"]) == 1
    row = body["resources"][0]
    assert row["name"] == "Janus"
    assert row["max_units"] == "1.00"
    assert len(row["tasks"]) == 2

    by_project = {t["project_name"]: t for t in row["tasks"]}
    assert set(by_project) == {"Security", "SOC2"}
    assert by_project["Security"]["units"] == "1.00"
    assert by_project["SOC2"]["units"] == "0.50"
    # Project attribution is present so the client can render the per-project breakdown.
    assert by_project["Security"]["project_id"] == str(project_a.id)
    # Overlapping window → the sum of overlapping units (1.5) exceeds max_units (1.0).
    # Detection stays client-side (ADR-0031); the endpoint ships the spans for it.


@pytest.mark.django_db
def test_excludes_projects_of_other_programs(
    program: Program, project_a: Project, janus: Resource
) -> None:
    other = Program.objects.create(name="Other", code="OTH")
    other_project = Project.objects.create(
        name="Unrelated", start_date=date(2026, 7, 6), program=other
    )
    t_in = _scheduled_task(project_a, "In scope", date(2026, 7, 6), date(2026, 7, 10))
    t_out = _scheduled_task(other_project, "Out of scope", date(2026, 7, 6), date(2026, 7, 10))
    TaskResource.objects.create(task=t_in, resource=janus, units=Decimal("1.00"))
    TaskResource.objects.create(task=t_out, resource=janus, units=Decimal("1.00"))

    client = _auth_client(Role.SCHEDULER, program)
    resp = client.get(_url(program), {"start": "2026-07-06", "end": "2026-07-31"})
    assert resp.status_code == 200
    tasks = resp.json()["resources"][0]["tasks"]
    names = {t["name"] for t in tasks}
    assert names == {"In scope"}  # the other program's assignment is excluded


@pytest.mark.django_db
def test_resource_and_status_filters(program: Program, project_a: Project, janus: Resource) -> None:
    other_resource = Resource.objects.create(name="Malcolm", max_units=Decimal("1.00"))
    t1 = _scheduled_task(project_a, "T1", date(2026, 7, 6), date(2026, 7, 10))
    t2 = _scheduled_task(project_a, "T2", date(2026, 7, 6), date(2026, 7, 10))
    TaskResource.objects.create(task=t1, resource=janus, units=Decimal("1.00"))
    TaskResource.objects.create(task=t2, resource=other_resource, units=Decimal("1.00"))

    client = _auth_client(Role.SCHEDULER, program)
    resp = client.get(
        _url(program),
        {"start": "2026-07-06", "end": "2026-07-31", "resource": str(janus.id)},
    )
    assert resp.status_code == 200
    rows = resp.json()["resources"]
    assert len(rows) == 1 and rows[0]["name"] == "Janus"


# ---------------------------------------------------------------------------
# #2677 / ADR-0752 — cross-project contention windows/serializes on the task's
# SPAN, not the remaining-work window, mirroring the per-project allocation
# fix and #2623's utilization fix.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestResourceContentionUsesSpanNotRemainingWindow:
    """Since ADR-0132, ``early_start`` is an in-progress task's *remaining-work*
    window — it shrinks toward ``early_finish`` as ``percent_complete`` rises.
    Windowing/serializing cross-project contention on it made reporting
    progress on one member project misreport who is over-allocated across
    sibling projects. These tests set the CPM fields directly to the values
    the engine would produce at each state — they do not run the scheduler.
    """

    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="SpanCal", working_days=31, hours_per_day=8.0)
        self.program = Program.objects.create(name="Span Program", code="SPAN")
        self.project = Project.objects.create(
            name="SpanProj", start_date=date(2026, 3, 2), calendar=self.cal, program=self.program
        )
        self.resource = Resource.objects.create(name="Ivy", max_units=Decimal("1.00"))
        self.client = _auth_client(Role.SCHEDULER, self.program)

    def _assign(self, task: Task) -> None:
        TaskResource.objects.create(task=task, resource=self.resource, units=Decimal("1.00"))

    def _tasks(self, start: str = "2026-03-02", end: str = "2026-03-05") -> list[dict]:
        resp = self.client.get(_url(self.program), {"start": start, "end": end})
        assert resp.status_code == 200
        resources = resp.json()["resources"]
        return resources[0]["tasks"] if resources else []

    def test_in_progress_task_stays_in_window_and_reports_scheduled_start(self) -> None:
        """A 4-day task at 83% complete has a remaining window (early_start) of
        a single day near early_finish, but its real SPAN (scheduled_start)
        starts on day one. The task must remain in a window covering the full
        span, and the response must carry scheduled_start."""
        task = Task.objects.create(
            project=self.project,
            name="AlmostDone",
            duration=4,
            early_start=date(2026, 3, 5),
            early_finish=date(2026, 3, 5),
            scheduled_start=date(2026, 3, 2),
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
        """An in-progress task whose remaining window (early_start) has moved
        past the query end must still appear, because its SPAN (scheduled_start)
        still overlaps the window — pre-fix, this task would have been dropped
        from the cross-project contention read entirely."""
        task = Task.objects.create(
            project=self.project,
            name="MostlyDone",
            duration=4,
            early_start=date(2026, 3, 6),
            early_finish=date(2026, 3, 6),
            scheduled_start=date(2026, 3, 2),
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
        ``early_start``, and reports scheduled_start as null."""
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
        task's SPAN start across member projects, not the narrowed
        remaining-work start."""
        task = Task.objects.create(
            project=self.project,
            name="InProgress",
            duration=4,
            early_start=date(2026, 3, 5),
            early_finish=date(2026, 3, 5),
            scheduled_start=date(2026, 3, 2),
            actual_start=date(2026, 3, 2),
            percent_complete=83,
            status=TaskStatus.IN_PROGRESS,
        )
        self._assign(task)

        resp = self.client.get(_url(self.program))
        assert resp.status_code == 200
        assert resp.json()["window_start"] == "2026-03-02"


# ---------------------------------------------------------------------------
# Perf contract (#3576 / ADR-1118) — mirrors the per-project endpoint
# ---------------------------------------------------------------------------


def _seed_contention(project: Project, count: int, per_resource: int = 2, offset: int = 0) -> None:
    """Create ``count`` resources on ``project``, each with ``per_resource`` spans."""
    for r in range(offset, offset + count):
        resource = Resource.objects.create(
            name=f"C{r:03d}", email=f"c{r:03d}@example.com", max_units=Decimal("1.00")
        )
        for t in range(per_resource):
            task = _scheduled_task(project, f"T{r:03d}-{t}", date(2026, 7, 6), date(2026, 7, 10))
            TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.50"))


@pytest.mark.django_db
class TestResourceContentionQueryBudget:
    """Contention aggregates across every member project — the row count is the
    product of projects and assignments, so an unbounded read is worse here than
    on the per-project endpoint, not better."""

    def test_query_count_is_flat_in_the_number_of_resources(
        self, program: Program, project_a: Project, project_b: Project
    ) -> None:
        client = _auth_client(Role.SCHEDULER, program)

        _seed_contention(project_a, count=1)
        assert client.get(_url(program)).status_code == 200  # warm caches

        with CaptureQueriesContext(connection) as small:
            small_body = client.get(_url(program)).json()

        _seed_contention(project_a, count=5, offset=1)
        _seed_contention(project_b, count=5, offset=6)
        with CaptureQueriesContext(connection) as large:
            large_body = client.get(_url(program)).json()

        assert len(small_body["resources"]) == 1
        assert len(large_body["resources"]) == 11
        assert sum(len(r["tasks"]) for r in large_body["resources"]) == 22

        assert len(large.captured_queries) == len(small.captured_queries), (
            f"{len(small.captured_queries)} → {len(large.captured_queries)}"
        )

    def test_the_assignment_read_is_bounded_and_sorted_on_local_columns(
        self, program: Program, project_a: Project
    ) -> None:
        client = _auth_client(Role.SCHEDULER, program)
        _seed_contention(project_a, count=3)

        with CaptureQueriesContext(connection) as ctx:
            body = client.get(_url(program)).json()

        row_read = next(
            q["sql"]
            for q in ctx.captured_queries
            if "resources_task_resource" in q["sql"] and "ORDER BY" in q["sql"]
        )
        assert "LIMIT" in row_read
        order_clause = row_read.split("ORDER BY", 1)[1]
        # Neither the resource name nor the project name — both are joins away.
        assert "resources_resource" not in order_clause, order_clause
        assert "projects_project" not in order_clause, order_clause

        names = [r["name"] for r in body["resources"]]
        assert names == sorted(names)

    def test_spans_stay_ordered_by_source_project_name(
        self, program: Program, project_a: Project, project_b: Project, janus: Resource
    ) -> None:
        """The Python sort must reproduce the by-project-name span ordering the
        SQL used to do — SOC2 before Security, regardless of insert order."""
        client = _auth_client(Role.SCHEDULER, program)
        for project, name in ((project_a, "SecurityWork"), (project_b, "SOC2Work")):
            task = _scheduled_task(project, name, date(2026, 7, 6), date(2026, 7, 10))
            TaskResource.objects.create(task=task, resource=janus, units=Decimal("0.50"))

        body = client.get(_url(program)).json()
        (row,) = body["resources"]
        assert [t["project_name"] for t in row["tasks"]] == ["SOC2", "Security"]


@pytest.mark.django_db
class TestResourceContentionCap:
    def test_untruncated_response_reports_its_own_resource_count(
        self, program: Program, project_a: Project
    ) -> None:
        client = _auth_client(Role.SCHEDULER, program)
        _seed_contention(project_a, count=4)

        body = client.get(_url(program)).json()
        assert body["truncated"] is False
        assert body["resource_count"] == 4

    def test_cap_drops_whole_resources_and_says_so(
        self, program: Program, project_a: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Same boundary rule as the per-project endpoint: a resource returned
        with only part of its cross-project spans would under-report exactly the
        contention this endpoint exists to surface."""
        from trueppm_api.apps.projects import program_views

        client = _auth_client(Role.SCHEDULER, program)
        _seed_contention(project_a, count=4, per_resource=3)

        monkeypatch.setattr(program_views, "_ALLOCATION_ASSIGNMENT_LIMIT", 7)
        body = client.get(_url(program)).json()

        assert body["truncated"] is True
        assert body["resource_count"] == 4
        assert len(body["resources"]) == 2
        for resource in body["resources"]:
            assert len(resource["tasks"]) == 3

    def test_cap_exactly_on_a_boundary_keeps_every_whole_resource(
        self, program: Program, project_a: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The overflow row belongs to the NEXT resource, so nothing is over-trimmed.

        Asserted here and not only on the per-project endpoint because this call
        site orders on an extra column (``task__project_id``). If that ever moved
        ahead of ``resource_id`` a resource's rows would stop being contiguous,
        the boundary rewind would silently keep a partial resource, and no test in
        the sibling file would notice.
        """
        from trueppm_api.apps.projects import program_views

        client = _auth_client(Role.SCHEDULER, program)
        _seed_contention(project_a, count=3, per_resource=2)  # 6 rows, 3 resources

        monkeypatch.setattr(program_views, "_ALLOCATION_ASSIGNMENT_LIMIT", 4)
        body = client.get(_url(program)).json()

        assert body["truncated"] is True
        assert len(body["resources"]) == 2
        assert all(len(r["tasks"]) == 2 for r in body["resources"])

    def test_a_single_resource_overflowing_the_cap_yields_no_resources_at_all(
        self, program: Program, project_a: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Every fetched row belongs to one resource, so the rewind keeps nothing.

        An empty list with ``truncated: true`` is the honest answer: a resource
        returned with part of its cross-project spans would under-report exactly
        the contention this endpoint exists to surface.
        """
        from trueppm_api.apps.projects import program_views

        client = _auth_client(Role.SCHEDULER, program)
        _seed_contention(project_a, count=1, per_resource=5)

        monkeypatch.setattr(program_views, "_ALLOCATION_ASSIGNMENT_LIMIT", 3)
        body = client.get(_url(program)).json()

        assert body["truncated"] is True
        assert body["resources"] == []
        assert body["resource_count"] == 1

    def test_spans_stay_contiguous_per_resource_across_projects(
        self, program: Program, project_a: Project, project_b: Project, janus: Resource
    ) -> None:
        """The SQL must group a resource's rows together, whatever project they came from.

        Contiguity is the precondition the boundary rewind rests on. Ordering by
        ``task__project_id`` first would interleave two resources' rows and make
        the cap cut mid-resource without any error.
        """
        client = _auth_client(Role.SCHEDULER, program)
        other = Resource.objects.create(
            name="Aaron", email="aaron@trueppm.demo", max_units=Decimal("1.00")
        )
        for project in (project_a, project_b):
            for resource in (janus, other):
                task = _scheduled_task(
                    project, f"{resource.name}-{project.name}", date(2026, 7, 6), date(2026, 7, 10)
                )
                TaskResource.objects.create(task=task, resource=resource, units=Decimal("0.50"))

        body = client.get(_url(program)).json()

        # Each person appears exactly once, holding both of their projects' spans.
        assert [r["name"] for r in body["resources"]] == ["Aaron", "Janus"]
        for row in body["resources"]:
            assert sorted(t["project_name"] for t in row["tasks"]) == ["SOC2", "Security"]
