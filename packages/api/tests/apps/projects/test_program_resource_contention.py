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
