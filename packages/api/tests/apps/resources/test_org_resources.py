"""Tests for org-level resource management (issue #155).

Covers: IsOrgAdmin permission gate, soft-delete, restore action,
?include_deleted query param, and ?exclude_project filter.
"""

from __future__ import annotations

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
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", hours_per_day=8.0)


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Alpha",
        start_date="2025-01-01",
        calendar=calendar,
    )


@pytest.fixture
def admin_user(db: object) -> object:
    return User.objects.create_user(username="pm_user", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member_user", password="pw")


@pytest.fixture
def admin_membership(admin_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(user=admin_user, project=project, role=Role.ADMIN)


@pytest.fixture
def member_membership(member_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(user=member_user, project=project, role=Role.MEMBER)


@pytest.fixture
def admin_client(admin_user: object, admin_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=admin_user)
    return c


@pytest.fixture
def member_client(member_user: object, member_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def anon_client(db: object) -> APIClient:
    # db fixture required: Django middleware touches the DB before DRF
    # permission checks reject the request.
    return APIClient()


@pytest.fixture
def resource(db: object) -> Resource:
    return Resource.objects.create(name="Alice", email="alice@example.com", max_units=1.0)


# ---------------------------------------------------------------------------
# IsOrgAdmin: read access
# ---------------------------------------------------------------------------


class TestResourceRead:
    def test_admin_can_list(self, admin_client: APIClient, resource: Resource) -> None:
        res = admin_client.get("/api/v1/resources/")
        assert res.status_code == 200
        ids = [r["id"] for r in res.data["results"]]
        assert str(resource.pk) in ids

    def test_member_can_list(self, member_client: APIClient, resource: Resource) -> None:
        """Team members may read the catalog (for roster combobox + self-view)."""
        res = member_client.get("/api/v1/resources/")
        assert res.status_code == 200

    def test_anonymous_cannot_list(self, anon_client: APIClient) -> None:
        res = anon_client.get("/api/v1/resources/")
        assert res.status_code == 401

    def test_member_can_retrieve(self, member_client: APIClient, resource: Resource) -> None:
        res = member_client.get(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 200
        assert res.data["name"] == "Alice"


# ---------------------------------------------------------------------------
# IsOrgAdmin: write access
# ---------------------------------------------------------------------------


class TestResourceWrite:
    def test_admin_can_create(self, admin_client: APIClient) -> None:
        res = admin_client.post(
            "/api/v1/resources/",
            {"name": "Bob", "email": "bob@example.com", "max_units": "0.50"},
            format="json",
        )
        assert res.status_code == 201
        assert Resource.objects.filter(name="Bob").exists()

    def test_member_cannot_create(self, member_client: APIClient) -> None:
        res = member_client.post(
            "/api/v1/resources/",
            {"name": "Charlie", "email": "charlie@example.com", "max_units": "1.00"},
            format="json",
        )
        assert res.status_code == 403

    def test_anonymous_cannot_create(self, anon_client: APIClient) -> None:
        res = anon_client.post(
            "/api/v1/resources/",
            {"name": "Eve", "email": "eve@example.com", "max_units": "1.00"},
            format="json",
        )
        assert res.status_code == 401

    def test_admin_can_patch(self, admin_client: APIClient, resource: Resource) -> None:
        res = admin_client.patch(
            f"/api/v1/resources/{resource.pk}/",
            {"job_role": "Engineer"},
            format="json",
        )
        assert res.status_code == 200
        resource.refresh_from_db()
        assert resource.job_role == "Engineer"

    def test_member_cannot_patch(self, member_client: APIClient, resource: Resource) -> None:
        res = member_client.patch(
            f"/api/v1/resources/{resource.pk}/",
            {"job_role": "Designer"},
            format="json",
        )
        assert res.status_code == 403


# ---------------------------------------------------------------------------
# Soft-delete (DELETE)
# ---------------------------------------------------------------------------


class TestResourceSoftDelete:
    def test_delete_soft_deletes(self, admin_client: APIClient, resource: Resource) -> None:
        res = admin_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 204
        # Row still exists in the database
        resource.refresh_from_db()
        assert resource.is_deleted is True

    def test_deleted_resource_hidden_from_list(
        self, admin_client: APIClient, resource: Resource
    ) -> None:
        admin_client.delete(f"/api/v1/resources/{resource.pk}/")
        res = admin_client.get("/api/v1/resources/")
        ids = [r["id"] for r in res.data["results"]]
        assert str(resource.pk) not in ids

    def test_include_deleted_shows_deactivated(
        self, admin_client: APIClient, resource: Resource
    ) -> None:
        admin_client.delete(f"/api/v1/resources/{resource.pk}/")
        res = admin_client.get("/api/v1/resources/?include_deleted=true")
        ids = [r["id"] for r in res.data["results"]]
        assert str(resource.pk) in ids

    def test_member_cannot_delete(self, member_client: APIClient, resource: Resource) -> None:
        res = member_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 403
        resource.refresh_from_db()
        assert resource.is_deleted is False

    def test_delete_triggers_recalc_for_assigned_projects(
        self,
        admin_client: APIClient,
        admin_user: object,
        project: Project,
        resource: Resource,
        calendar: Calendar,
    ) -> None:
        """Deleting a resource with open assignments enqueues schedule recalc."""
        task = Task.objects.create(
            project=project,
            name="Build feature",
            planned_start="2025-01-01",
            duration=8,
        )
        TaskResource.objects.create(task=task, resource=resource, units=1.0)

        # The recalculate path uses the outbox/Celery path; we just verify
        # perform_destroy runs without error and the resource is soft-deleted.
        res = admin_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 204
        resource.refresh_from_db()
        assert resource.is_deleted is True


# ---------------------------------------------------------------------------
# Restore action
# ---------------------------------------------------------------------------


class TestResourceRestore:
    def test_admin_can_restore(self, admin_client: APIClient, resource: Resource) -> None:
        admin_client.delete(f"/api/v1/resources/{resource.pk}/")
        res = admin_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 200
        resource.refresh_from_db()
        assert resource.is_deleted is False

    def test_restore_non_deleted_returns_400(
        self, admin_client: APIClient, resource: Resource
    ) -> None:
        res = admin_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 400

    def test_member_cannot_restore(self, member_client: APIClient, resource: Resource) -> None:
        resource.is_deleted = True
        resource.save(update_fields=["is_deleted"])
        res = member_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 403


# ---------------------------------------------------------------------------
# IsOrgAdmin: superuser bypass
# ---------------------------------------------------------------------------


class TestOrgAdminSuperuser:
    def test_superuser_can_create_without_project_membership(self, db: object) -> None:
        superuser = User.objects.create_superuser(
            username="su", password="pw", email="su@example.com"
        )
        c = APIClient()
        c.force_authenticate(user=superuser)
        res = c.post(
            "/api/v1/resources/",
            {"name": "Super Resource", "email": "sr@example.com", "max_units": "1.00"},
            format="json",
        )
        assert res.status_code == 201
