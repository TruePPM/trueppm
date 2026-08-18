"""Duration unit is a presentation fact, never a storage or scheduling change (#2975).

The whole point of the field is that ``Task.duration`` keeps meaning integer
working days — the engine, the WASM conformance fixtures, MS Project export and
the duration audit all read it that way. These tests pin that: the unit
round-trips through the API, and setting it does not touch the number the
scheduling engine reads.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, DurationUnit, Project, Task


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="duruser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.mark.django_db
class TestDurationUnit:
    def test_defaults_to_days(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Every existing task reads as days without a data migration."""
        task = Task.objects.create(project=project, name="Pour", duration=5, wbs_path="1")
        r = client.get(f"/api/v1/tasks/{task.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["duration_unit"] == DurationUnit.DAYS

    def test_unit_round_trips(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        task = Task.objects.create(project=project, name="Bench", duration=1, wbs_path="1")
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"duration_unit": "hours", "project": str(project.id)},
            format="json",
        )
        assert r.status_code == 200
        assert r.data["duration_unit"] == "hours"

    def test_changing_the_unit_does_not_rescale_the_stored_duration(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """The engine invariant.

        If switching to hours rescaled the stored number, every CPM date on the
        project would move on a display preference — which is precisely what this
        field is designed not to do.
        """
        task = Task.objects.create(project=project, name="Cable pull", duration=4, wbs_path="1")
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"duration_unit": "hours", "project": str(project.id)},
            format="json",
        )
        assert r.status_code == 200
        assert r.data["duration"] == 4
        task.refresh_from_db()
        assert task.duration == 4

    def test_rejects_an_unknown_unit(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        task = Task.objects.create(project=project, name="Survey", duration=2, wbs_path="1")
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"duration_unit": "fortnights", "project": str(project.id)},
            format="json",
        )
        assert r.status_code == 400
