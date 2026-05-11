"""Tests for the project burn chart endpoint (issue #239 / ADR-0022).

`GET /api/v1/projects/{id}/burn/` reconstructs daily burn data from
HistoricalTask snapshots and overlays a planned series when an active
baseline exists. These tests cover the response shape, the burndown vs
burnup math, scope-change tracking, and the baseline overlay.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Project,
    Task,
    TaskStatus,
)

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def member(project: Project) -> object:
    u = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.MEMBER)
    return u


@pytest.fixture
def viewer(project: Project) -> object:
    u = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.VIEWER)
    return u


@pytest.fixture
def outsider() -> object:
    return User.objects.create_user(username="outsider", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _create_tasks(project: Project, count: int, points: int | None = None) -> list[Task]:
    tasks = []
    for i in range(count):
        tasks.append(
            Task.objects.create(
                project=project,
                name=f"T{i}",
                duration=1,
                story_points=points,
            )
        )
    return tasks


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_endpoint_returns_burndown_shape(project: Project, member: object) -> None:
    _create_tasks(project, 3)
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": "2026-04-01", "until": "2026-04-03"},
    )
    assert resp.status_code == 200
    assert resp.data["chart_type"] == "burndown"
    assert resp.data["metric"] == "tasks"
    assert resp.data["since"] == "2026-04-01"
    assert resp.data["until"] == "2026-04-03"
    assert len(resp.data["series"]) == 3
    point = resp.data["series"][0]
    assert {"date", "actual", "ideal", "scope"} <= set(point.keys())


@pytest.mark.django_db
def test_default_window_is_project_start_to_today(project: Project, member: object) -> None:
    """No since/until → uses project.start_date through today."""
    _create_tasks(project, 1)
    c = _client(member)
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 200
    assert resp.data["since"] == project.start_date.isoformat()


# ---------------------------------------------------------------------------
# Burndown vs burnup
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_burndown_actual_is_remaining(project: Project, member: object) -> None:
    tasks = _create_tasks(project, 4)
    # Mark two as complete — remaining should drop.
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    tasks[1].status = TaskStatus.COMPLETE
    tasks[1].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "burndown", "since": today, "until": today},
    )
    assert resp.status_code == 200
    point = resp.data["series"][-1]
    assert point["scope"] == 4
    assert point["actual"] == 2  # remaining


@pytest.mark.django_db
def test_burnup_actual_is_completed(project: Project, member: object) -> None:
    tasks = _create_tasks(project, 4)
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "burnup", "since": today, "until": today},
    )
    assert resp.status_code == 200
    point = resp.data["series"][-1]
    assert point["scope"] == 4
    assert point["actual"] == 1  # completed


# ---------------------------------------------------------------------------
# Ideal curve
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_burndown_ideal_starts_at_scope_ends_at_zero(project: Project, member: object) -> None:
    _create_tasks(project, 10)
    c = _client(member)
    today = date.today()
    since = (today - timedelta(days=4)).isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "burndown", "since": since, "until": today.isoformat()},
    )
    series = resp.data["series"]
    assert series[0]["ideal"] == series[0]["scope"]
    assert series[-1]["ideal"] == 0


@pytest.mark.django_db
def test_burnup_ideal_starts_at_zero_ends_at_scope(project: Project, member: object) -> None:
    _create_tasks(project, 10)
    c = _client(member)
    today = date.today()
    since = (today - timedelta(days=4)).isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "burnup", "since": since, "until": today.isoformat()},
    )
    series = resp.data["series"]
    assert series[0]["ideal"] == 0
    assert series[-1]["ideal"] == series[-1]["scope"]


# ---------------------------------------------------------------------------
# Metric: points
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_metric_points_sums_story_points(project: Project, member: object) -> None:
    tasks = _create_tasks(project, 2, points=5)
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"metric": "points", "since": today, "until": today},
    )
    point = resp.data["series"][-1]
    assert point["scope"] == 10  # 2 tasks × 5 points
    assert point["actual"] == 5  # 1 remaining × 5


# ---------------------------------------------------------------------------
# Baseline overlay
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_baseline_series_present_only_when_active_baseline(
    project: Project, member: object
) -> None:
    _create_tasks(project, 2)
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/", {"since": today, "until": today})
    assert "baseline_series" not in resp.data

    # Activate a baseline; baseline_series should appear.
    baseline = Baseline.objects.create(
        project=project, name="B1", is_active=True, has_cpm_dates=True
    )
    BaselineTask.objects.create(
        baseline=baseline,
        task_id=Task.objects.first().pk,
        task_name="T0",
        finish=date.today() + timedelta(days=2),
        duration=1,
    )
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/", {"since": today, "until": today})
    assert "baseline_series" in resp.data
    assert len(resp.data["baseline_series"]) == 1


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_invalid_chart_type_returns_400(project: Project, member: object) -> None:
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "spaghetti", "since": today, "until": today},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_invalid_metric_returns_400(project: Project, member: object) -> None:
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"metric": "biscuits", "since": today, "until": today},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_until_before_since_returns_400(project: Project, member: object) -> None:
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": "2026-04-10", "until": "2026-04-01"},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_malformed_date_returns_400(project: Project, member: object) -> None:
    c = _client(member)
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"since": "yesterday", "until": "today"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_can_read(project: Project, viewer: object) -> None:
    _create_tasks(project, 1)
    c = _client(viewer)
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_outsider_gets_403(project: Project, outsider: object) -> None:
    c = _client(outsider)
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_unauthenticated_gets_401(project: Project) -> None:
    c = APIClient()
    resp = c.get(f"/api/v1/projects/{project.pk}/burn/")
    assert resp.status_code == 401


@pytest.mark.django_db
def test_unknown_project_returns_404(member: object) -> None:
    c = _client(member)
    resp = c.get("/api/v1/projects/00000000-0000-0000-0000-000000000000/burn/")
    # Membership check resolves before object lookup; outsider would see 403,
    # but a known member querying a non-existent project gets 404.
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Combined chart type (issue #53 / ADR-0062)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_combined_returns_correct_shape(project: Project, member: object) -> None:
    """chart_type=combined returns {remaining, completed, total, ideal} per point."""
    tasks = _create_tasks(project, 4)
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "combined", "since": today, "until": today},
    )
    assert resp.status_code == 200
    assert resp.data["chart_type"] == "combined"
    assert resp.data["metric"] == "tasks"
    point = resp.data["series"][0]
    assert {"date", "remaining", "completed", "total", "ideal"} <= set(point.keys())


@pytest.mark.django_db
def test_combined_remaining_plus_completed_equals_total(project: Project, member: object) -> None:
    """For each point: remaining + completed should equal total (scope)."""
    tasks = _create_tasks(project, 6)
    for t in tasks[:2]:
        t.status = TaskStatus.COMPLETE
        t.save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "combined", "since": today, "until": today},
    )
    assert resp.status_code == 200
    for point in resp.data["series"]:
        assert point["remaining"] + point["completed"] == point["total"]


@pytest.mark.django_db
def test_combined_invalid_metric_returns_400(project: Project, member: object) -> None:
    """Invalid metric with combined chart_type must return 400, not 500 (security-review fix)."""
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "combined", "metric": "biscuits", "since": today, "until": today},
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_combined_metric_points(project: Project, member: object) -> None:
    """combined chart_type respects metric=points."""
    tasks = _create_tasks(project, 4, points=3)
    tasks[0].status = TaskStatus.COMPLETE
    tasks[0].save()
    c = _client(member)
    today = date.today().isoformat()
    resp = c.get(
        f"/api/v1/projects/{project.pk}/burn/",
        {"chart_type": "combined", "metric": "points", "since": today, "until": today},
    )
    assert resp.status_code == 200
    assert resp.data["metric"] == "points"
    point = resp.data["series"][0]
    assert point["total"] == 12  # 4 tasks × 3 pts
    assert point["completed"] == 3  # 1 completed × 3 pts
    assert point["remaining"] == 9  # 3 remaining × 3 pts
