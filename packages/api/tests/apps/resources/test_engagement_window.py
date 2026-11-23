"""ADR-0190 Phase 1 — engagement window + availability profile on ProjectResource (#3840)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.resources.models import ProjectResource, RampState, Resource

User = get_user_model()
URL = "/api/v1/project-resources/"


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard", hours_per_day=8.0)
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=cal)


@pytest.fixture
def resource(db: object) -> Resource:
    return Resource.objects.create(name="Maria", email="m@example.com", max_units=Decimal("1.0"))


@pytest.fixture
def scheduler_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="eng_sched", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def viewer_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="eng_view", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
class TestEngagementWindow:
    def test_defaults_are_open_ended_full_availability(
        self, scheduler_client: APIClient, project: Project, resource: Resource
    ) -> None:
        res = scheduler_client.post(
            URL, {"project": str(project.pk), "resource": str(resource.pk)}, format="json"
        )
        assert res.status_code == 201
        assert res.data["engaged_from"] is None
        assert res.data["engaged_to"] is None
        assert res.data["availability_percent"] == 100
        assert res.data["ramp_state"] == RampState.FULL

    def test_create_with_window_round_trips(
        self, scheduler_client: APIClient, project: Project, resource: Resource
    ) -> None:
        res = scheduler_client.post(
            URL,
            {
                "project": str(project.pk),
                "resource": str(resource.pk),
                "engaged_from": "2026-05-01",
                "engaged_to": "2026-08-31",
                "availability_percent": 60,
                "ramp_state": "winding_down",
            },
            format="json",
        )
        assert res.status_code == 201
        row = ProjectResource.objects.get(pk=res.data["id"])
        assert row.engaged_from == date(2026, 5, 1)
        assert row.engaged_to == date(2026, 8, 31)
        assert row.availability_percent == 60
        assert row.ramp_state == "winding_down"

    def test_from_after_to_rejected(
        self, scheduler_client: APIClient, project: Project, resource: Resource
    ) -> None:
        res = scheduler_client.post(
            URL,
            {
                "project": str(project.pk),
                "resource": str(resource.pk),
                "engaged_from": "2026-09-01",
                "engaged_to": "2026-08-31",
            },
            format="json",
        )
        assert res.status_code == 400
        assert "engaged_to" in res.data

    def test_equal_bounds_allowed(
        self, scheduler_client: APIClient, project: Project, resource: Resource
    ) -> None:
        res = scheduler_client.post(
            URL,
            {
                "project": str(project.pk),
                "resource": str(resource.pk),
                "engaged_from": "2026-09-01",
                "engaged_to": "2026-09-01",
            },
            format="json",
        )
        assert res.status_code == 201

    def test_patch_one_bound_validated_against_stored_other(
        self, scheduler_client: APIClient, project: Project, resource: Resource
    ) -> None:
        pr = ProjectResource.objects.create(
            project=project, resource=resource, engaged_from=date(2026, 6, 1)
        )
        bad = scheduler_client.patch(f"{URL}{pr.pk}/", {"engaged_to": "2026-05-01"}, format="json")
        assert bad.status_code == 400
        ok = scheduler_client.patch(f"{URL}{pr.pk}/", {"engaged_to": "2026-07-01"}, format="json")
        assert ok.status_code == 200
        assert ok.data["engaged_to"] == "2026-07-01"

    def test_clearing_window_with_null(
        self, scheduler_client: APIClient, project: Project, resource: Resource
    ) -> None:
        pr = ProjectResource.objects.create(
            project=project, resource=resource, engaged_to=date(2026, 7, 1)
        )
        res = scheduler_client.patch(f"{URL}{pr.pk}/", {"engaged_to": None}, format="json")
        assert res.status_code == 200
        pr.refresh_from_db()
        assert pr.engaged_to is None

    @pytest.mark.parametrize("value", [-1, 101])
    def test_availability_out_of_range_rejected(
        self, scheduler_client: APIClient, project: Project, resource: Resource, value: int
    ) -> None:
        res = scheduler_client.post(
            URL,
            {
                "project": str(project.pk),
                "resource": str(resource.pk),
                "availability_percent": value,
            },
            format="json",
        )
        assert res.status_code == 400
        assert "availability_percent" in res.data

    def test_zero_availability_allowed(
        self, scheduler_client: APIClient, project: Project, resource: Resource
    ) -> None:
        res = scheduler_client.post(
            URL,
            {"project": str(project.pk), "resource": str(resource.pk), "availability_percent": 0},
            format="json",
        )
        assert res.status_code == 201

    def test_invalid_ramp_state_rejected(
        self, scheduler_client: APIClient, project: Project, resource: Resource
    ) -> None:
        res = scheduler_client.post(
            URL,
            {"project": str(project.pk), "resource": str(resource.pk), "ramp_state": "bogus"},
            format="json",
        )
        assert res.status_code == 400

    def test_viewer_cannot_write_window(
        self, viewer_client: APIClient, project: Project, resource: Resource
    ) -> None:
        pr = ProjectResource.objects.create(project=project, resource=resource)
        res = viewer_client.patch(f"{URL}{pr.pk}/", {"engaged_to": "2026-07-01"}, format="json")
        assert res.status_code == 403
        pr.refresh_from_db()
        assert pr.engaged_to is None

    def test_partial_index_declared(self) -> None:
        idx = {i.name: i for i in ProjectResource._meta.indexes}["projres_engaged_to_idx"]
        assert list(idx.fields) == ["project", "engaged_to"]
        assert idx.condition is not None


@pytest.mark.django_db
def test_new_columns_keep_a_database_default() -> None:
    """Rolling-update safety (migration rule 8): an old pod's INSERT omits the new columns.

    AddField drops the column default unless ``db_default`` is set, so the old pod's
    INSERT would hit NOT NULL. Assert the DB itself carries the defaults.
    """
    from django.db import connection

    with connection.cursor() as cur:
        cur.execute(
            "SELECT column_name, column_default FROM information_schema.columns "
            "WHERE table_name = %s AND column_name IN ('availability_percent', 'ramp_state')",
            [ProjectResource._meta.db_table],
        )
        defaults = dict(cur.fetchall())
    assert defaults["availability_percent"] is not None
    assert defaults["availability_percent"].startswith("100")
    assert defaults["ramp_state"] is not None
    assert "full" in defaults["ramp_state"]
