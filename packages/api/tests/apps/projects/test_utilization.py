"""Tests for the resource utilization endpoint (issue #22).

Covers:
  - Permission gate: VIEWER/MEMBER denied, SCHEDULER+ allowed
  - 409 when no CPM dates exist
  - Correct daily load computation (including units fraction)
  - Calendar-aware working-day exclusion (weekends, exceptions)
  - calendar_differs_from_project flag
  - unassigned_task_count
  - Date window filtering (?start=, ?end=, bad dates, start > end)
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    CalendarException,
    Project,
    Task,
    TaskStatus,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def cal(db: object) -> Calendar:
    """Standard Mon–Fri, 8 h/day calendar."""
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def project(cal: Calendar) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 3, 2), calendar=cal)


def _auth_client(role: int, project: Project) -> APIClient:
    user = User.objects.create_user(username=f"u{role}", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/utilization/"


# ---------------------------------------------------------------------------
# Permission gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationPermissions:
    def test_viewer_denied(self, project: Project) -> None:
        c = _auth_client(Role.VIEWER, project)
        assert c.get(_url(project)).status_code == 403

    def test_member_denied(self, project: Project) -> None:
        c = _auth_client(Role.MEMBER, project)
        assert c.get(_url(project)).status_code == 403

    def test_scheduler_allowed(self, project: Project) -> None:
        c = _auth_client(Role.SCHEDULER, project)
        # No tasks → 409 (schedule not run), but auth succeeded
        resp = c.get(_url(project))
        assert resp.status_code in (200, 409)

    def test_admin_allowed(self, project: Project) -> None:
        c = _auth_client(Role.ADMIN, project)
        resp = c.get(_url(project))
        assert resp.status_code in (200, 409)

    def test_unauthenticated_denied(self, project: Project) -> None:
        assert APIClient().get(_url(project)).status_code in (401, 403)

    def test_non_member_denied(self, project: Project) -> None:
        other = User.objects.create_user(username="nobody", password="pw")
        c = APIClient()
        c.force_authenticate(user=other)
        assert c.get(_url(project)).status_code in (403, 404)


# ---------------------------------------------------------------------------
# 409 — schedule not computed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_409_when_no_cpm_dates(project: Project) -> None:
    Task.objects.create(project=project, name="T1", duration=5)
    c = _auth_client(Role.SCHEDULER, project)
    resp = c.get(_url(project))
    assert resp.status_code == 409
    assert "scheduler" in resp.data["detail"].lower()


# ---------------------------------------------------------------------------
# Core computation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationComputation:
    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="Std", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="P", start_date=date(2026, 3, 2), calendar=self.cal
        )

    def _client(self, role: int = Role.SCHEDULER) -> APIClient:
        return _auth_client(role, self.project)

    def test_single_resource_single_task(self) -> None:
        """Mon–Fri task: 5 working days × 8 h/day × 1.0 units = 8 h/day each."""
        resource = Resource.objects.create(name="Alice", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=5,
            early_start=date(2026, 3, 2),  # Monday
            early_finish=date(2026, 3, 6),  # Friday
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.status_code == 200

        data = resp.data
        assert data["project_id"] == str(self.project.pk)
        resources = data["resources"]
        assert len(resources) == 1

        alice = resources[0]
        assert alice["resource_name"] == "Alice"
        assert alice["max_units"] == "1.00"
        days = alice["days"]
        # Mon–Fri should all be present; weekend excluded
        assert len(days) == 5
        for iso_date in ("2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"):
            assert iso_date in days
            assert days[iso_date]["hours"] == pytest.approx(8.0)

    def test_fractional_units(self) -> None:
        """0.5 units → 4 h/day."""
        resource = Resource.objects.create(name="Bob", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="0.5")

        resp = self._client().get(_url(self.project))
        days = resp.data["resources"][0]["days"]
        assert days["2026-03-02"]["hours"] == pytest.approx(4.0)

    def test_weekend_excluded(self) -> None:
        """Task spanning Mon–Sun: only Mon–Fri get load (working_days=31)."""
        resource = Resource.objects.create(name="Carol", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=5,
            early_start=date(2026, 3, 2),  # Monday
            early_finish=date(2026, 3, 8),  # Sunday
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        days = resp.data["resources"][0]["days"]
        assert "2026-03-07" not in days  # Saturday
        assert "2026-03-08" not in days  # Sunday
        assert len(days) == 5

    def test_calendar_exception_excluded(self) -> None:
        """A day in a CalendarException range is not a working day."""
        # Tuesday 2026-03-03 is a holiday
        CalendarException.objects.create(
            calendar=self.cal,
            exc_start=date(2026, 3, 3),
            exc_end=date(2026, 3, 3),
            description="Holiday",
        )
        resource = Resource.objects.create(name="Dave", max_units="1.0")
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=5,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 6),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        days = resp.data["resources"][0]["days"]
        assert "2026-03-03" not in days  # exception day excluded
        assert len(days) == 4  # Mon + Wed–Fri

    def test_resource_own_calendar(self) -> None:
        """Resource with its own calendar (Mon–Fri, 6 h/day) → 6 h/day."""
        res_cal = Calendar.objects.create(name="Part-time", working_days=31, hours_per_day=6.0)
        resource = Resource.objects.create(name="Eve", max_units="1.0", calendar=res_cal)
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        resources = resp.data["resources"]
        assert resources[0]["days"]["2026-03-02"]["hours"] == pytest.approx(6.0)

    def test_calendar_differs_flag(self) -> None:
        """Flag is true when resource.calendar differs from project.calendar."""
        res_cal = Calendar.objects.create(name="Other", working_days=31, hours_per_day=8.0)
        resource = Resource.objects.create(name="Frank", max_units="1.0", calendar=res_cal)
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["calendar_differs_from_project"] is True

    def test_calendar_differs_false_when_same(self) -> None:
        """Flag is false when resource.calendar is the same as project.calendar."""
        resource = Resource.objects.create(name="Grace", max_units="1.0", calendar=self.cal)
        task = Task.objects.create(
            project=self.project,
            name="T",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["calendar_differs_from_project"] is False

    def test_unassigned_task_count(self) -> None:
        """Tasks with CPM dates but no TaskResource are counted as unassigned."""
        Task.objects.create(
            project=self.project,
            name="Unassigned",
            duration=1,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 2),
        )
        resp = self._client().get(_url(self.project))
        assert resp.data["unassigned_task_count"] == 1
        assert resp.data["resources"] == []

    def test_two_tasks_same_resource_accumulates(self) -> None:
        """Two overlapping tasks for the same resource add up on shared days."""
        resource = Resource.objects.create(name="Hank", max_units="2.0")
        for name in ("T1", "T2"):
            task = Task.objects.create(
                project=self.project,
                name=name,
                duration=1,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 2),
            )
            TaskResource.objects.create(task=task, resource=resource, units="1.0")

        resp = self._client().get(_url(self.project))
        assert resp.data["resources"][0]["days"]["2026-03-02"]["hours"] == pytest.approx(16.0)
        assert len(resp.data["resources"][0]["days"]["2026-03-02"]["tasks"]) == 2


# ---------------------------------------------------------------------------
# #2623 / ADR-0752 — utilization windows on the task's SPAN, not the
# remaining-work window, so reporting progress does not delete a person's
# allocated load from the heat map.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationUsesSpanNotRemainingWindow:
    """Since ADR-0132, ``early_start`` is an in-progress task's *remaining-work*
    window — it shrinks toward ``early_finish`` as ``percent_complete`` rises.
    Windowing utilization on it made reporting progress look like shedding
    allocation. ADR-0752's ``scheduled_start`` (paired with ``early_finish``,
    which is always ``scheduled_finish``) carries the task's real span and must
    be what utilization windows on instead. These tests set the CPM fields
    directly to the values the engine would produce at each state — they do
    not run the scheduler — so they isolate ``utilization.py``'s windowing
    logic from engine correctness (covered separately by scheduler-engine
    tests).
    """

    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="SpanCal", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="SpanProj", start_date=date(2026, 3, 2), calendar=self.cal
        )
        self.resource = Resource.objects.create(name="Ivy", max_units="1.0")
        self.client = _auth_client(Role.SCHEDULER, self.project)

    def _assign(self, task: Task) -> None:
        TaskResource.objects.create(task=task, resource=self.resource, units="1.0")

    def _total_hours(self, start: str = "2026-03-02", end: str = "2026-03-05") -> float:
        resp = self.client.get(_url(self.project), {"start": start, "end": end})
        assert resp.status_code == 200
        resources = resp.data["resources"]
        if not resources:
            return 0.0
        return sum(day["hours"] for day in resources[0]["days"].values())

    def test_load_stable_across_0_50_100_percent(self) -> None:
        """Same 4-working-day (Mon–Thu) assignment at 0%, 50%, and 100% complete
        must contribute the same total load — the core #2623 regression.

        Pre-fix, this task would contribute 32h at 0%, 16h at 50% (early_start
        shrunk to the last two days), and ~0h at 100% (early_start == early_finish).
        """
        full_span = (date(2026, 3, 2), date(2026, 3, 5))  # Mon–Thu

        # 0% — not started: early_start/early_finish/scheduled_start all equal
        # the full span (ADR-0752 table: not-started windows coincide).
        task = Task.objects.create(
            project=self.project,
            name="NotStarted",
            duration=4,
            early_start=full_span[0],
            early_finish=full_span[1],
            scheduled_start=full_span[0],
            percent_complete=0,
            status=TaskStatus.NOT_STARTED,
        )
        self._assign(task)
        hours_0pct = self._total_hours()
        assert hours_0pct == pytest.approx(32.0)  # 4 days × 8h × 1.0 units
        task.delete()

        # 50% — in progress, actual_start recorded: early_start has shrunk to
        # the remaining-work window (Wed–Thu per ADR-0132), but scheduled_start
        # still records the real span start (== actual_start, ADR-0752 §2).
        task = Task.objects.create(
            project=self.project,
            name="InProgress50",
            duration=4,
            early_start=date(2026, 3, 4),
            early_finish=full_span[1],
            scheduled_start=full_span[0],
            actual_start=full_span[0],
            percent_complete=50,
            status=TaskStatus.IN_PROGRESS,
        )
        self._assign(task)
        hours_50pct = self._total_hours()
        task.delete()

        # 100% — complete: ADR-0136 already pins early_start back to the full
        # span for completed tasks, so scheduled_start == early_start here too.
        task = Task.objects.create(
            project=self.project,
            name="Complete",
            duration=4,
            early_start=full_span[0],
            early_finish=full_span[1],
            scheduled_start=full_span[0],
            actual_start=full_span[0],
            actual_finish=full_span[1],
            percent_complete=100,
            status=TaskStatus.COMPLETE,
        )
        self._assign(task)
        hours_100pct = self._total_hours()
        task.delete()

        assert hours_50pct == pytest.approx(hours_0pct)
        assert hours_100pct == pytest.approx(hours_0pct)

    def test_in_progress_task_reproduces_bug_on_early_start_alone(self) -> None:
        """Direct repro: an in-progress task whose remaining window (early_start)
        has shrunk to a single day must still report its full elapsed+remaining
        span (4 days), not the 1 remaining day. This is the exact shape from the
        issue: a 4-day task at ~83% complete contributing 1 day instead of 4.
        """
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

        hours = self._total_hours()

        assert hours == pytest.approx(32.0)  # 4 days, not 1
        resp = self.client.get(_url(self.project), {"start": "2026-03-02", "end": "2026-03-05"})
        days = resp.data["resources"][0]["days"]
        assert set(days) == {"2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"}

    def test_window_intersection_elapsed_load_still_counts(self) -> None:
        """A task whose remaining window has moved past the query range entirely
        must still contribute the elapsed portion of its load that falls inside
        that range — the span, not the remaining window, decides inclusion.
        """
        # Remaining window (early_start..early_finish) is Fri 3/6 only — outside
        # the Mon 3/2..Tue 3/3 query window below. The real span (scheduled_start)
        # starts Mon 3/2, so the elapsed Mon/Tue portion must still be counted.
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

        hours = self._total_hours(start="2026-03-02", end="2026-03-03")

        # Mon + Tue elapsed portion, clamped to the query window: 2 days × 8h.
        assert hours == pytest.approx(16.0)

    def test_unassigned_task_count_uses_span_too(self) -> None:
        """The unassigned-task counter windows on the same span, not the
        remaining-work window, so an unassigned in-progress task is not dropped
        from the count once its remaining window narrows past the query end.
        """
        Task.objects.create(
            project=self.project,
            name="UnassignedInProgress",
            duration=4,
            early_start=date(2026, 3, 6),  # remaining window outside the window below
            early_finish=date(2026, 3, 6),
            scheduled_start=date(2026, 3, 2),
            actual_start=date(2026, 3, 2),
            percent_complete=90,
            status=TaskStatus.IN_PROGRESS,
        )
        resp = self.client.get(_url(self.project), {"start": "2026-03-02", "end": "2026-03-03"})
        assert resp.status_code == 200
        assert resp.data["unassigned_task_count"] == 1

    def test_missing_scheduled_start_falls_back_to_early_start(self) -> None:
        """A task with no ``scheduled_start`` (e.g. not yet recalculated since the
        ADR-0752 migration) must still be windowed correctly, falling back to
        ``early_start`` — the pre-#2622 behavior — rather than being dropped."""
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

        hours = self._total_hours()
        assert hours == pytest.approx(32.0)


# ---------------------------------------------------------------------------
# Date window filtering
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationWindow:
    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="Std2", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="WP", start_date=date(2026, 3, 2), calendar=self.cal
        )
        self.resource = Resource.objects.create(name="Ida", max_units="1.0")
        # Task: Mon Mar 2 – Fri Mar 13 (10 working days)
        self.task = Task.objects.create(
            project=self.project,
            name="T",
            duration=10,
            early_start=date(2026, 3, 2),
            early_finish=date(2026, 3, 13),
        )
        TaskResource.objects.create(task=self.task, resource=self.resource, units="1.0")
        self.client = _auth_client(Role.SCHEDULER, self.project)

    def test_default_window_covers_full_task(self) -> None:
        resp = self.client.get(_url(self.project))
        assert resp.status_code == 200
        days = resp.data["resources"][0]["days"]
        assert "2026-03-02" in days
        assert "2026-03-13" in days

    def test_explicit_start_trims_early_days(self) -> None:
        resp = self.client.get(_url(self.project), {"start": "2026-03-09"})
        days = resp.data["resources"][0]["days"]
        assert "2026-03-02" not in days
        assert "2026-03-09" in days

    def test_explicit_end_trims_late_days(self) -> None:
        resp = self.client.get(_url(self.project), {"end": "2026-03-06"})
        days = resp.data["resources"][0]["days"]
        assert "2026-03-13" not in days
        assert "2026-03-06" in days

    def test_invalid_start_date_returns_400(self) -> None:
        resp = self.client.get(_url(self.project), {"start": "not-a-date"})
        assert resp.status_code == 400

    def test_start_after_end_returns_400(self) -> None:
        resp = self.client.get(_url(self.project), {"start": "2026-03-13", "end": "2026-03-02"})
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# #989 — server-owned per-day load% + band + overallocation verdict
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationLoadVerdict:
    """The server returns the same load%/band/overallocated verdict the heatmap's
    ``u > 100`` check and resourceUtils.loadColor (web rule 91) produced, so a
    headless/MCP client reads it instead of re-deriving from raw hours (#989)."""

    def setup_method(self) -> None:
        self.cal = Calendar.objects.create(name="StdV", working_days=31, hours_per_day=8.0)
        self.project = Project.objects.create(
            name="PV", start_date=date(2026, 3, 2), calendar=self.cal
        )

    def _day(self, units: str, max_units: str = "1.0", n_tasks: int = 1) -> dict:
        resource = Resource.objects.create(name="R", max_units=max_units)
        for i in range(n_tasks):
            task = Task.objects.create(
                project=self.project,
                name=f"T{i}",
                duration=1,
                early_start=date(2026, 3, 2),
                early_finish=date(2026, 3, 2),
            )
            TaskResource.objects.create(task=task, resource=resource, units=units)
        resp = _auth_client(Role.SCHEDULER, self.project).get(_url(self.project))
        assert resp.status_code == 200
        return resp.data["resources"][0]

    def test_below_85_is_on_track(self) -> None:
        """0.5 units → 4h / 8h = 50% → on-track, not overallocated."""
        res = self._day(units="0.5")
        day = res["days"]["2026-03-02"]
        assert day["load_pct"] == pytest.approx(50.0)
        assert day["load_band"] == "on-track"
        assert day["overallocated"] is False
        assert res["overallocated"] is False

    def test_full_allocation_is_at_risk_not_overallocated(self) -> None:
        """Exactly 100% load is at-risk; >100 (not ==100) is the overallocation line."""
        res = self._day(units="1.0")
        day = res["days"]["2026-03-02"]
        assert day["load_pct"] == pytest.approx(100.0)
        assert day["load_band"] == "at-risk"
        assert day["overallocated"] is False
        assert res["overallocated"] is False

    def test_over_100_is_critical_and_overallocated(self) -> None:
        """Two 1.0-unit tasks on a 1.0-unit resource → 200% → critical + overallocated,
        and the resource-level overallocated flag flips true."""
        res = self._day(units="1.0", n_tasks=2)
        day = res["days"]["2026-03-02"]
        assert day["load_pct"] == pytest.approx(200.0)
        assert day["load_band"] == "critical"
        assert day["overallocated"] is True
        assert res["overallocated"] is True
