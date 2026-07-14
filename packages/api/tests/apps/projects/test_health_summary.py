"""Tests for GET /api/v1/projects/health-summary/ (ADR-0401, #1941).

The endpoint returns one row per project the caller is a member of (archived
excluded), each with a derived ``health_band`` plus the same at-risk / critical
task counts the single-project status-summary uses. Scope is the caller's OWN
member projects — never all projects org-wide.
"""

from __future__ import annotations

import datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Health, Project, Task, TaskStatus

User = get_user_model()

URL = "/api/v1/projects/health-summary/"


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


def _make_project(
    name: str,
    member: object,
    calendar: Calendar,
    *,
    health: str = Health.AUTO,
    is_archived: bool = False,
) -> Project:
    p = Project.objects.create(
        name=name,
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
        health=health,
        is_archived=is_archived,
    )
    ProjectMembership.objects.create(project=p, user=member, role=Role.OWNER)
    return p


def _critical_task(project: Project, wbs: str) -> Task:
    return Task.objects.create(
        project=project,
        name=f"Critical {wbs}",
        wbs_path=wbs,
        duration=5,
        is_critical=True,
        total_float=0,
        status=TaskStatus.IN_PROGRESS,
    )


def _at_risk_task(project: Project, wbs: str) -> Task:
    return Task.objects.create(
        project=project,
        name=f"At risk {wbs}",
        wbs_path=wbs,
        duration=5,
        is_critical=False,
        total_float=3,
        status=TaskStatus.IN_PROGRESS,
    )


def _safe_task(project: Project, wbs: str) -> Task:
    return Task.objects.create(
        project=project,
        name=f"Safe {wbs}",
        wbs_path=wbs,
        duration=5,
        is_critical=False,
        total_float=20,
        status=TaskStatus.NOT_STARTED,
    )


class TestHealthSummary:
    def test_requires_authentication(self, calendar: Calendar) -> None:
        resp = APIClient().get(URL)
        assert resp.status_code in (401, 403)

    def test_scoped_to_own_member_projects(
        self, client: APIClient, user: object, other_user: object, calendar: Calendar
    ) -> None:
        mine = _make_project("Mine", user, calendar)
        _make_project("Theirs", other_user, calendar)  # caller is NOT a member
        resp = client.get(URL)
        assert resp.status_code == 200
        names = {row["name"] for row in resp.json()}
        assert names == {"Mine"}
        assert str(mine.pk) in {row["id"] for row in resp.json()}

    def test_counts_reuse_status_summary_semantics(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        p = _make_project("Counts", user, calendar)
        _critical_task(p, "1")
        _at_risk_task(p, "2")
        _safe_task(p, "3")
        # A COMPLETE critical task must be excluded from both counts.
        Task.objects.create(
            project=p,
            name="Done",
            wbs_path="4",
            duration=3,
            is_critical=True,
            total_float=0,
            status=TaskStatus.COMPLETE,
        )
        row = next(r for r in client.get(URL).json() if r["name"] == "Counts")
        # critical: the one incomplete is_critical task (COMPLETE excluded)
        assert row["critical_count"] == 1
        # at-risk: total_float <= 5 and incomplete = critical A (float 0) + at-risk B (float 3)
        assert row["at_risk_count"] == 2

    def test_band_counts_first_when_health_is_auto(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        crit = _make_project("Crit", user, calendar)
        _critical_task(crit, "1")
        _at_risk_task(crit, "2")
        risk = _make_project("Risk", user, calendar)
        _at_risk_task(risk, "1")
        ok = _make_project("OK", user, calendar)
        _safe_task(ok, "1")

        by_name = {r["name"]: r["health_band"] for r in client.get(URL).json()}
        assert by_name["Crit"] == "critical"  # critical_count > 0 wins over at-risk
        assert by_name["Risk"] == "at_risk"
        assert by_name["OK"] == "on_track"

    def test_manual_health_override_wins(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        # An on-track override must win even though the project has critical tasks.
        p = _make_project("Override", user, calendar, health=Health.ON_TRACK)
        _critical_task(p, "1")
        row = next(r for r in client.get(URL).json() if r["name"] == "Override")
        assert row["health_band"] == "on_track"
        # counts are still reported truthfully alongside the override
        assert row["critical_count"] == 1

    def test_archived_projects_excluded(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        _make_project("Active", user, calendar)
        _make_project("Archived", user, calendar, is_archived=True)
        names = {r["name"] for r in client.get(URL).json()}
        assert names == {"Active"}

    def test_empty_when_no_projects(self, client: APIClient) -> None:
        resp = client.get(URL)
        assert resp.status_code == 200
        assert resp.json() == []
