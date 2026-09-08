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
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

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


# ---------------------------------------------------------------------------
# #2907 — group_by must not be accepted-then-silently-ignored
# ---------------------------------------------------------------------------
#
# The endpoint validates group_by against {role, project, none} and then implements
# only "role". "project" was accepted with a 200 and had no effect, so a consumer
# asking for it read an alphabetical payload as project-grouped with nothing to
# contradict them — the 400 it would have received was the only signal there was.
#
# "project" cannot simply be rejected: it is a documented enum value in the published
# OpenAPI schema, and removing an enum value is a Breaking change under
# api/stability.md, requiring a deprecation window. So the response now names the
# grouping it actually applied, which is additive and closes the silence.


@pytest.mark.django_db
class TestHeatmapGroupByEcho:
    def _heatmap(self, project: Project, **params: str) -> object:
        r = Resource.objects.create(name="Zoe", email="zoe@example.com", max_units=1.0)
        _assign(_make_task(project, date(2026, 6, 1), 5), r, 1.0)
        return _auth_client(Role.SCHEDULER, project).get(_heatmap_url(project), params)

    def test_default_reports_none(self, project: Project) -> None:
        resp = self._heatmap(project)
        assert resp.status_code == 200  # type: ignore[attr-defined]
        assert resp.data["group_by"] == "none"  # type: ignore[attr-defined]

    def test_role_reports_role(self, project: Project) -> None:
        resp = self._heatmap(project, group_by="role")
        assert resp.status_code == 200  # type: ignore[attr-defined]
        assert resp.data["group_by"] == "role"  # type: ignore[attr-defined]

    def test_project_is_still_accepted(self, project: Project) -> None:
        """The deprecation window: it must keep working, not start 400ing."""
        resp = self._heatmap(project, group_by="project")
        assert resp.status_code == 200  # type: ignore[attr-defined]

    def test_project_reports_none_not_project(self, project: Project) -> None:
        """The defect, stated directly: the caller can now see it was not applied."""
        resp = self._heatmap(project, group_by="project")
        assert resp.data["group_by"] == "none"  # type: ignore[attr-defined]
        assert resp.data["group_by"] != "project"  # type: ignore[attr-defined]

    def test_project_and_none_are_byte_identical(self, project: Project) -> None:
        """'project' is served as 'none' — pin that, so a future impl must be deliberate.

        One client and one dataset: ``_auth_client`` mints a fixed username, so
        building the fixture twice in a single test collides on the unique index.
        """
        r = Resource.objects.create(name="Zoe", email="zoe@example.com", max_units=1.0)
        _assign(_make_task(project, date(2026, 6, 1), 5), r, 1.0)
        client = _auth_client(Role.SCHEDULER, project)

        as_project = client.get(_heatmap_url(project), {"group_by": "project"})
        as_none = client.get(_heatmap_url(project), {"group_by": "none"})
        assert as_project.status_code == 200
        assert as_project.data == as_none.data

    def test_an_unsupported_value_is_still_rejected(self, project: Project) -> None:
        """The 400 path stays intact for values that were never in the enum."""
        resp = self._heatmap(project, group_by="team")
        assert resp.status_code == 400  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# #3574 — the heat map and resources/summary inherit the daily engine's
# per-project capacity, so they cannot disagree with the Overview card about
# the same person. Before this, a 0.5-rostered person assigned 0.5 read 100%
# on the card and 50% here.
# ---------------------------------------------------------------------------


def _roster(
    project: Project,
    resource: Resource,
    units_override: str | None,
    *,
    is_deleted: bool = False,
) -> ProjectResource:
    return ProjectResource.objects.create(
        project=project,
        resource=resource,
        units_override=Decimal(units_override) if units_override is not None else None,
        is_deleted=is_deleted,
    )


@pytest.mark.django_db
class TestHeatmapHonorsUnitsOverride:
    def _week(
        self, project: Project, cal: Calendar, override: str | None, units: float
    ) -> list[int]:
        resource = Resource.objects.create(name="Ada L", calendar=cal, max_units=Decimal("1.0"))
        _roster(project, resource, override)
        _assign(_make_task(project, date(2026, 4, 27), 5), resource, units)
        resp = _auth_client(Role.SCHEDULER, project).get(
            _heatmap_url(project), {"weeks": "4", "start": "2026-04-27"}
        )
        assert resp.status_code == 200
        return list(resp.data["resources"][0]["util"])

    def test_half_time_roster_reads_100_not_50(self, project: Project, cal: Calendar) -> None:
        """The reported defect: 0.5 units against a 0.5 roster slot is a full week."""
        assert self._week(project, cal, "0.5", 0.5)[0] == 100

    def test_no_override_is_unchanged(self, project: Project, cal: Calendar) -> None:
        """Negative control — the pre-existing 50% reading must survive."""
        assert self._week(project, cal, None, 0.5)[0] == 50

    def test_half_time_roster_over_capacity(self, project: Project, cal: Calendar) -> None:
        assert self._week(project, cal, "0.5", 0.6)[0] == 120

    def test_zero_override_is_not_read_as_unset(self, project: Project, cal: Calendar) -> None:
        """A 0 override zeroes the denominator, which the guard reports as 0 — the
        point is that it is NOT the 50% a truthiness fallback to max_units gives."""
        assert self._week(project, cal, "0", 0.5)[0] == 0

    def test_soft_deleted_roster_row_is_ignored(self, project: Project, cal: Calendar) -> None:
        resource = Resource.objects.create(name="Gone", calendar=cal, max_units=Decimal("1.0"))
        _roster(project, resource, "0.5", is_deleted=True)
        _assign(_make_task(project, date(2026, 4, 27), 5), resource, 0.5)
        resp = _auth_client(Role.SCHEDULER, project).get(
            _heatmap_url(project), {"weeks": "4", "start": "2026-04-27"}
        )
        assert resp.status_code == 200
        assert resp.data["resources"][0]["util"][0] == 50


@pytest.mark.django_db
class TestSummaryHonorsUnitsOverride:
    def _summary(self, project: Project, cal: Calendar, override: str | None, units: float) -> dict:
        resource = Resource.objects.create(name="Jo B", calendar=cal, max_units=Decimal("1.0"))
        _roster(project, resource, override)
        today = date.today()
        monday = today - timedelta(days=today.weekday())
        _assign(_make_task(project, monday, 5), resource, units)
        resp = _auth_client(Role.SCHEDULER, project).get(_summary_url(project))
        assert resp.status_code == 200
        return dict(resp.data)

    def test_over_allocated_against_the_override(self, project: Project, cal: Calendar) -> None:
        """0.6 units is under a 1.0 default and over a 0.5 roster slot. The summary
        must read the slot, or it contradicts the heat map it summarizes."""
        data = self._summary(project, cal, "0.5", 0.6)
        assert data["over_allocated_count"] == 1
        assert data["avg_utilization_pct"] == 120

    def test_same_load_is_not_over_allocated_without_the_override(
        self, project: Project, cal: Calendar
    ) -> None:
        """The negative control that makes the assertion above non-vacuous."""
        data = self._summary(project, cal, None, 0.6)
        assert data["over_allocated_count"] == 0
        assert data["avg_utilization_pct"] == 60
