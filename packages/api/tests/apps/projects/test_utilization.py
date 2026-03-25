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
from trueppm_api.apps.projects.models import Calendar, CalendarException, Project, Task
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
