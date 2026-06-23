"""Roll-up filter params on the blocked endpoints (ADR-0165, #1157).

``GET /projects/{id}/blocked/`` and ``GET /sprints/{id}/blocked/`` accept two
optional filters on the *team-shareable* structured signal — ``blocker_type`` and
``min_age_days`` (age via ``blocked_since``). These tests prove the filters work,
combine with AND, validate strictly (→ 400), and — critically — that filtering
never opens a path to the private ``blocked_reason`` (the Morgan boundary,
ADR-0124 §4).
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, Task

User = get_user_model()

REASON = "SECRET: vendor escalation, blocked on legal sign-off"


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def pm(db: object) -> Any:
    return User.objects.create_user(username="pm", password="pw", email="pm@x.io")


@pytest.fixture
def member(project: Project, pm: Any) -> Any:
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)
    return pm


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _blocked_task(project: Project, name: str, blocker_type: str, days_ago: int) -> Task:
    """Create a flagged-blocked task and back-date its blocked_since by ``days_ago``."""
    task = Task.objects.create(
        project=project,
        name=name,
        duration=1,
        blocked_reason=REASON,
        blocker_type=blocker_type,
    )
    # blocked_since is stamped by save(); back-date it directly to control age.
    Task.objects.filter(pk=task.pk).update(blocked_since=timezone.now() - timedelta(days=days_ago))
    return task


@pytest.mark.django_db
def test_filter_by_blocker_type(project: Project, member: Any) -> None:
    _blocked_task(project, "Vendor wait", "vendor", days_ago=1)
    _blocked_task(project, "Decision wait", "decision", days_ago=1)

    resp = _client(member).get(f"/api/v1/projects/{project.pk}/blocked/?blocker_type=vendor")
    assert resp.status_code == 200, resp.data
    assert resp.data["count"] == 1
    assert resp.data["blocked"][0]["blocker_type"] == "vendor"
    # Reason never leaks through a filtered response.
    assert REASON not in str(resp.data)


@pytest.mark.django_db
def test_filter_by_min_age_days(project: Project, member: Any) -> None:
    _blocked_task(project, "Old", "vendor", days_ago=5)
    _blocked_task(project, "Fresh", "vendor", days_ago=0)

    resp = _client(member).get(f"/api/v1/projects/{project.pk}/blocked/?min_age_days=3")
    assert resp.status_code == 200, resp.data
    assert resp.data["count"] == 1
    assert resp.data["blocked"][0]["title"] == "Old"


@pytest.mark.django_db
def test_filters_combine_with_and(project: Project, member: Any) -> None:
    _blocked_task(project, "Old vendor", "vendor", days_ago=5)
    _blocked_task(project, "Old decision", "decision", days_ago=5)
    _blocked_task(project, "Fresh vendor", "vendor", days_ago=0)

    resp = _client(member).get(
        f"/api/v1/projects/{project.pk}/blocked/?blocker_type=vendor&min_age_days=3"
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["count"] == 1
    assert resp.data["blocked"][0]["title"] == "Old vendor"


@pytest.mark.django_db
def test_min_age_zero_is_noop(project: Project, member: Any) -> None:
    _blocked_task(project, "A", "vendor", days_ago=0)
    _blocked_task(project, "B", "vendor", days_ago=2)
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/blocked/?min_age_days=0")
    assert resp.status_code == 200, resp.data
    assert resp.data["count"] == 2


@pytest.mark.django_db
def test_no_params_preserves_unfiltered_behavior(project: Project, member: Any) -> None:
    _blocked_task(project, "A", "vendor", days_ago=1)
    _blocked_task(project, "B", "decision", days_ago=1)
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/blocked/")
    assert resp.status_code == 200, resp.data
    assert resp.data["count"] == 2


@pytest.mark.django_db
def test_unknown_blocker_type_is_400(project: Project, member: Any) -> None:
    _blocked_task(project, "A", "vendor", days_ago=1)
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/blocked/?blocker_type=bogus")
    assert resp.status_code == 400
    assert "blocker_type" in resp.data


@pytest.mark.django_db
def test_negative_min_age_is_400(project: Project, member: Any) -> None:
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/blocked/?min_age_days=-1")
    assert resp.status_code == 400
    assert "min_age_days" in resp.data


@pytest.mark.django_db
def test_non_integer_min_age_is_400(project: Project, member: Any) -> None:
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/blocked/?min_age_days=abc")
    assert resp.status_code == 400
    assert "min_age_days" in resp.data


@pytest.mark.django_db
def test_absurdly_large_min_age_is_400_not_500(project: Project, member: Any) -> None:
    """An out-of-range age fails loud as 400 rather than overflowing timedelta → 500."""
    resp = _client(member).get(f"/api/v1/projects/{project.pk}/blocked/?min_age_days=999999999999")
    assert resp.status_code == 400
    assert "min_age_days" in resp.data


@pytest.mark.django_db
def test_sprint_rollup_filters_too(project: Project, member: Any) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
    )
    for name, btype in (("Vendor", "vendor"), ("Decision", "decision")):
        t = _blocked_task(project, name, btype, days_ago=1)
        Task.objects.filter(pk=t.pk).update(sprint=sprint)

    resp = _client(member).get(f"/api/v1/sprints/{sprint.pk}/blocked/?blocker_type=decision")
    assert resp.status_code == 200, resp.data
    assert resp.data["count"] == 1
    assert resp.data["blocked"][0]["blocker_type"] == "decision"
    assert REASON not in str(resp.data)
