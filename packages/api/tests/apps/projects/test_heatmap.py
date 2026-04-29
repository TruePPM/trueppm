"""Tests for the resources/heatmap and resources/summary endpoints (ADR-0042).

Covers:
  - Permission gate: VIEWER/MEMBER denied, SCHEDULER+ allowed
  - 409 when no CPM dates exist
  - Correct weekly util values at 50%, 100%, 130%
  - Over-allocated detection in summary
  - Weeks param validation (4, 8, 12, 16 only)
  - ?self filter on /members/ endpoint
"""

from __future__ import annotations

from datetime import date, timedelta

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
    # Start on a Monday so week boundaries are predictable.
    return Project.objects.create(name="P", start_date=date(2026, 4, 27), calendar=cal)


def _auth_client(role: int, project: Project) -> APIClient:
    u = User.objects.create_user(username=f"u_hm_{role}", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=role)
    c = APIClient()
    c.force_authenticate(user=u)
    return c


def _heatmap_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/resources/heatmap/"


def _summary_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/resources/summary/"


def _members_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/members/"


def _make_task(project: Project, start: date, duration: int) -> Task:
    finish = start + timedelta(days=duration - 1)
    return Task.objects.create(
        project=project,
        name="T",
        duration=duration,
        early_start=start,
        early_finish=finish,
        status="NOT_STARTED",
        wbs_path="1",
    )


def _assign(task: Task, resource: Resource, units: float) -> TaskResource:
    return TaskResource.objects.create(task=task, resource=resource, units=units)


# ---------------------------------------------------------------------------
# Permission gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestHeatmapPermissions:
    def test_viewer_denied(self, project: Project) -> None:
        assert _auth_client(Role.VIEWER, project).get(_heatmap_url(project)).status_code == 403

    def test_member_denied(self, project: Project) -> None:
        assert _auth_client(Role.MEMBER, project).get(_heatmap_url(project)).status_code == 403

    def test_scheduler_allowed(self, project: Project) -> None:
        resp = _auth_client(Role.SCHEDULER, project).get(_heatmap_url(project))
        # No CPM dates → 409; auth succeeded.
        assert resp.status_code in (200, 409)

    def test_summary_viewer_denied(self, project: Project) -> None:
        assert _auth_client(Role.VIEWER, project).get(_summary_url(project)).status_code == 403


# ---------------------------------------------------------------------------
# 409 when scheduler not run
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_heatmap_409_when_no_cpm(project: Project) -> None:
    c = _auth_client(Role.SCHEDULER, project)
    Task.objects.create(project=project, name="T", duration=5, status="NOT_STARTED", wbs_path="1")
    assert c.get(_heatmap_url(project)).status_code == 409


@pytest.mark.django_db
def test_summary_409_when_no_cpm(project: Project) -> None:
    c = _auth_client(Role.SCHEDULER, project)
    Task.objects.create(project=project, name="T", duration=5, status="NOT_STARTED", wbs_path="1")
    assert c.get(_summary_url(project)).status_code == 409


# ---------------------------------------------------------------------------
# Weeks param validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_heatmap_invalid_weeks(project: Project, cal: Calendar) -> None:
    c = _auth_client(Role.SCHEDULER, project)
    resource = Resource.objects.create(name="Anna", calendar=cal, max_units=1.0)
    task = _make_task(project, date(2026, 4, 27), 5)
    _assign(task, resource, 1.0)

    resp = c.get(_heatmap_url(project), {"weeks": "7", "start": "2026-04-27"})
    assert resp.status_code == 400

    resp = c.get(_heatmap_url(project), {"weeks": "abc", "start": "2026-04-27"})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Util values
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestHeatmapUtilValues:
    """
    Scaffold: 1 resource, 1 task spanning exactly 1 week (Mon–Fri).
    We request a 4-week window starting that Monday.
    Week 0 should show the specified utilization percent; weeks 1–3 should be 0.
    """

    def _setup(self, project: Project, cal: Calendar, units: float) -> tuple[APIClient, Resource]:
        resource = Resource.objects.create(name="Anna K", calendar=cal, max_units=1.0)
        # Task from Mon 2026-04-27 to Fri 2026-05-01 (5 working days)
        task = _make_task(project, date(2026, 4, 27), 5)
        _assign(task, resource, units)
        c = _auth_client(Role.SCHEDULER, project)
        return c, resource

    def test_50_percent(self, project: Project, cal: Calendar) -> None:
        c, _ = self._setup(project, cal, 0.5)
        resp = c.get(_heatmap_url(project), {"weeks": "4", "start": "2026-04-27"})
        assert resp.status_code == 200
        resources = resp.data["resources"]
        assert len(resources) == 1
        util = resources[0]["util"]
        # 0.5 units × 8 h/day × 5 days = 20 h actual; capacity = 1.0 × 8 × 5 = 40 h → 50%
        assert util[0] == 50
        assert util[1] == 0  # weeks 1-3 have no assignments

    def test_100_percent(self, project: Project, cal: Calendar) -> None:
        c, _ = self._setup(project, cal, 1.0)
        resp = c.get(_heatmap_url(project), {"weeks": "4", "start": "2026-04-27"})
        assert resp.status_code == 200
        util = resp.data["resources"][0]["util"]
        assert util[0] == 100

    def test_130_percent(self, project: Project, cal: Calendar) -> None:
        c, _ = self._setup(project, cal, 1.3)
        resp = c.get(_heatmap_url(project), {"weeks": "4", "start": "2026-04-27"})
        assert resp.status_code == 200
        util = resp.data["resources"][0]["util"]
        assert util[0] == 130

    def test_response_shape(self, project: Project, cal: Calendar) -> None:
        c, _resource = self._setup(project, cal, 1.0)
        resp = c.get(_heatmap_url(project), {"weeks": "4", "start": "2026-04-27"})
        assert resp.status_code == 200
        data = resp.data
        assert "weeks" in data and len(data["weeks"]) == 4
        r = data["resources"][0]
        assert "id" in r
        assert "name" in r
        assert "initials" in r
        assert "color" in r
        assert "util" in r and len(r["util"]) == 4


# ---------------------------------------------------------------------------
# Summary stats
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_summary_over_allocated_count(project: Project, cal: Calendar) -> None:
    # Create a resource at 130% for the current week so summary picks it up.
    resource = Resource.objects.create(name="Jordan M", calendar=cal, max_units=1.0)
    # Task spans current week Mon–Fri
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    task = _make_task(project, monday, 5)
    _assign(task, resource, 1.3)

    c = _auth_client(Role.SCHEDULER, project)
    resp = c.get(_summary_url(project))
    assert resp.status_code == 200
    data = resp.data
    assert data["over_allocated_count"] >= 1
    assert data["headcount"] >= 0
    assert "avg_utilization_pct" in data


# ---------------------------------------------------------------------------
# ?self filter on /members/ endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_members_self_filter_returns_own_row(project: Project) -> None:
    user = User.objects.create_user(username="self_test_user", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)

    resp = c.get(_members_url(project), {"self": "true"})
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["role"] == Role.SCHEDULER


@pytest.mark.django_db
def test_members_self_filter_does_not_expose_other_members(project: Project) -> None:
    # Add a second member; ?self=true should return only the requester.
    u1 = User.objects.create_user(username="self_u1", password="pw")
    u2 = User.objects.create_user(username="self_u2", password="pw")
    ProjectMembership.objects.create(project=project, user=u1, role=Role.SCHEDULER)
    ProjectMembership.objects.create(project=project, user=u2, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=u1)

    resp = c.get(_members_url(project), {"self": "true"})
    assert resp.status_code == 200
    assert len(resp.data) == 1
    assert resp.data[0]["role"] == Role.SCHEDULER
