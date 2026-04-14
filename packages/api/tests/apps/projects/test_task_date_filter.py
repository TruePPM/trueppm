"""Tests for the start__gte / finish__lte calendar date-range filter on TaskViewSet.

These filters were added in issue #40 to support the CalendarView and
useCalendarTasks hook.  They filter by CPM output dates (early_start /
early_finish) and return tasks whose schedule window overlaps the requested range.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="caltest", password="pw")


@pytest.fixture
def auth_client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Default")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Date Filter Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def _membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def tasks(project: Project) -> list[Task]:
    """Four tasks covering different parts of January 2026."""
    return [
        Task.objects.create(
            project=project,
            name="Jan 1-5",
            early_start=date(2026, 1, 1),
            early_finish=date(2026, 1, 5),
        ),
        Task.objects.create(
            project=project,
            name="Jan 6-10",
            early_start=date(2026, 1, 6),
            early_finish=date(2026, 1, 10),
        ),
        Task.objects.create(
            project=project,
            name="Jan 11-20",
            early_start=date(2026, 1, 11),
            early_finish=date(2026, 1, 20),
        ),
        Task.objects.create(
            project=project,
            name="Jan 21-31",
            early_start=date(2026, 1, 21),
            early_finish=date(2026, 1, 31),
        ),
    ]


def _names(resp: object) -> list[str]:
    return [t["name"] for t in resp.json()["results"]]


@pytest.mark.django_db
class TestTaskDateRangeFilter:
    def test_start_gte_excludes_tasks_finishing_before(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: list[Task],
        _membership: ProjectMembership,
    ) -> None:
        # Only tasks with early_finish >= 2026-01-11 should be returned.
        resp = auth_client.get(
            "/api/v1/tasks/",
            {"project": str(project.pk), "start__gte": "2026-01-11"},
        )
        assert resp.status_code == 200
        names = _names(resp)
        assert "Jan 1-5" not in names
        assert "Jan 6-10" not in names
        assert "Jan 11-20" in names
        assert "Jan 21-31" in names

    def test_finish_lte_excludes_tasks_starting_after(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: list[Task],
        _membership: ProjectMembership,
    ) -> None:
        # Only tasks with early_start <= 2026-01-10 should be returned.
        resp = auth_client.get(
            "/api/v1/tasks/",
            {"project": str(project.pk), "finish__lte": "2026-01-10"},
        )
        assert resp.status_code == 200
        names = _names(resp)
        assert "Jan 1-5" in names
        assert "Jan 6-10" in names
        assert "Jan 11-20" not in names
        assert "Jan 21-31" not in names

    def test_combined_window_returns_overlapping_tasks(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: list[Task],
        _membership: ProjectMembership,
    ) -> None:
        # Window Jan 6–Jan 10: tasks that started before Jan 10 AND finish after Jan 6.
        resp = auth_client.get(
            "/api/v1/tasks/",
            {
                "project": str(project.pk),
                "start__gte": "2026-01-06",
                "finish__lte": "2026-01-10",
            },
        )
        assert resp.status_code == 200
        names = _names(resp)
        # Only "Jan 6-10" overlaps [6, 10]: early_finish 10 >= 6 AND early_start 6 <= 10.
        assert names == ["Jan 6-10"] or set(names) == {"Jan 6-10"}
        assert "Jan 1-5" not in names  # finishes 5 < 6
        assert "Jan 11-20" not in names  # starts 11 > 10

    def test_no_filter_returns_all_tasks(
        self,
        auth_client: APIClient,
        project: Project,
        tasks: list[Task],
        _membership: ProjectMembership,
    ) -> None:
        resp = auth_client.get("/api/v1/tasks/", {"project": str(project.pk)})
        assert resp.status_code == 200
        assert resp.json()["count"] == 4

    def test_tasks_with_null_early_dates_are_excluded_by_date_filter(
        self, auth_client: APIClient, project: Project, _membership: ProjectMembership
    ) -> None:
        # A task with null early_start/finish should not appear in a date-filtered list
        # because the filter uses early_start__lte and early_finish__gte which evaluate
        # to NULL for unscheduled tasks.
        Task.objects.create(project=project, name="Unscheduled")
        resp = auth_client.get(
            "/api/v1/tasks/",
            {"project": str(project.pk), "start__gte": "2026-01-01"},
        )
        assert resp.status_code == 200
        names = _names(resp)
        assert "Unscheduled" not in names
