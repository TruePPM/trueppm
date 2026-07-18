"""Tests for org-level resource management (issue #155).

Covers: IsOrgAdmin permission gate, soft-delete, restore action,
?include_deleted query param, ?exclude_project filter, and transaction
atomicity on perform_destroy (perf-check R3).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.resources.views import ResourceViewSet

User = get_user_model()

BROADCAST_PATH = "trueppm_api.apps.sync.broadcast.broadcast_board_event"


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

    def test_member_include_deleted_param_ignored(
        self, member_client: APIClient, resource: Resource
    ) -> None:
        """#1374: ``?include_deleted=true`` is honored only for org admins. A
        non-admin passing it must still get the deactivated record filtered out —
        the param is silently ignored, not an enumeration backdoor onto the
        soft-deleted pool."""
        resource.is_deleted = True
        resource.save(update_fields=["is_deleted"])
        res = member_client.get("/api/v1/resources/?include_deleted=true")
        ids = [r["id"] for r in res.data["results"]]
        assert str(resource.pk) not in ids

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

    def test_delete_broadcasts_roster_changed_to_assigned_projects(
        self,
        admin_client: APIClient,
        project: Project,
        resource: Resource,
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        """Soft-delete fans roster_changed out to every project the resource is on (#1359)."""
        task = Task.objects.create(
            project=project, name="Build feature", planned_start="2025-01-01", duration=8
        )
        TaskResource.objects.create(task=task, resource=resource, units=1.0)

        events: list[tuple[str, str, dict]] = []
        with (
            patch(
                BROADCAST_PATH,
                side_effect=lambda pid, et, payload: events.append((pid, et, payload)),
            ),
            django_capture_on_commit_callbacks(execute=True),
        ):
            res = admin_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 204
        assert (str(project.pk), "roster_changed", {"resource_id": str(resource.pk)}) in events


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

    def test_restore_broadcasts_roster_changed_to_assigned_projects(
        self,
        admin_client: APIClient,
        project: Project,
        resource: Resource,
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        """Reactivation puts the resource back on its rosters → roster_changed (#1359)."""
        task = Task.objects.create(
            project=project, name="Build feature", planned_start="2025-01-01", duration=8
        )
        TaskResource.objects.create(task=task, resource=resource, units=1.0)
        admin_client.delete(f"/api/v1/resources/{resource.pk}/")

        events: list[tuple[str, str, dict]] = []
        with (
            patch(
                BROADCAST_PATH,
                side_effect=lambda pid, et, payload: events.append((pid, et, payload)),
            ),
            django_capture_on_commit_callbacks(execute=True),
        ):
            res = admin_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 200
        assert (str(project.pk), "roster_changed", {"resource_id": str(resource.pk)}) in events

    def test_member_cannot_restore(self, member_client: APIClient, resource: Resource) -> None:
        resource.is_deleted = True
        resource.save(update_fields=["is_deleted"])
        res = member_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 403

    def test_restore_unknown_resource_returns_404(self, admin_client: APIClient) -> None:
        res = admin_client.post(f"/api/v1/resources/{uuid4()}/restore/")
        assert res.status_code == 404

    def test_restore_without_pk_returns_404(self, db: object) -> None:
        """The defensive pk-None guard short-circuits before any DB lookup."""
        request = APIRequestFactory().post("/api/v1/resources/restore/")
        res = ResourceViewSet().restore(request, pk=None)
        assert res.status_code == 404


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


# ---------------------------------------------------------------------------
# Email exposure gate (#891 — org-wide email harvest, mirrors #815)
# ---------------------------------------------------------------------------


class TestResourceEmailGate:
    """A low-privilege caller must not receive other resources' emails.

    The catalog is readable by any authenticated user, so echoing email on every
    row let one account paginate it to harvest the org's email list. Email is now
    gated on org-admin in to_representation; the resource's own user still sees
    their email via the is_me self-view path.
    """

    def test_member_list_omits_email(self, member_client: APIClient, resource: Resource) -> None:
        res = member_client.get("/api/v1/resources/")
        assert res.status_code == 200
        row = next(r for r in res.data["results"] if r["id"] == str(resource.pk))
        # email dropped entirely (not just nulled) for non-admin callers.
        assert "email" not in row

    def test_member_retrieve_omits_email(
        self, member_client: APIClient, resource: Resource
    ) -> None:
        """Detail endpoint is gated the same way as list (same serializer)."""
        res = member_client.get(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 200
        assert "email" not in res.data

    def test_admin_list_includes_email(self, admin_client: APIClient, resource: Resource) -> None:
        res = admin_client.get("/api/v1/resources/")
        assert res.status_code == 200
        row = next(r for r in res.data["results"] if r["id"] == str(resource.pk))
        assert row["email"] == "alice@example.com"

    def test_member_sees_own_email_via_self_view(
        self, member_user: object, member_membership: ProjectMembership, calendar: Calendar
    ) -> None:
        """is_me self-view: a member still sees the email on their own resource."""
        own = Resource.objects.create(
            name="Member Self",
            email="member_self@example.com",
            max_units=1.0,
            user=member_user,
        )
        c = APIClient()
        c.force_authenticate(user=member_user)
        res = c.get(f"/api/v1/resources/{own.pk}/")
        assert res.status_code == 200
        assert res.data["is_me"] is True
        assert res.data["email"] == "member_self@example.com"

    # --- #892: email search must be gated on org-admin -----------------------

    def test_member_search_by_email_finds_nothing(
        self, member_client: APIClient, resource: Resource
    ) -> None:
        """A non-admin cannot probe email existence via ?search= (#892).

        Searching the catalog by an email substring must not match — otherwise a
        hit narrows the candidate set and leaks email existence even though the
        value is stripped from the payload. Non-admins search by name only.
        """
        res = member_client.get("/api/v1/resources/?search=alice@example.com")
        assert res.status_code == 200
        assert res.data["results"] == []

    def test_member_search_by_name_still_works(
        self, member_client: APIClient, resource: Resource
    ) -> None:
        """The email-search gate must not break legitimate name search for non-admins."""
        res = member_client.get("/api/v1/resources/?search=Alice")
        assert res.status_code == 200
        assert any(r["id"] == str(resource.pk) for r in res.data["results"])

    def test_admin_search_by_email_works(self, admin_client: APIClient, resource: Resource) -> None:
        """Org admins retain email search — the gate only narrows it for non-admins (#892)."""
        res = admin_client.get("/api/v1/resources/?search=alice@example.com")
        assert res.status_code == 200
        assert any(r["id"] == str(resource.pk) for r in res.data["results"])


# ---------------------------------------------------------------------------
# Atomicity regression tests for ResourceViewSet.perform_destroy (R3)
# ---------------------------------------------------------------------------


class TestResourceSoftDeleteAtomicity:
    """ResourceViewSet.perform_destroy must wrap the soft-delete save and the
    per-project recalculation fan-out in a single transaction so that a failure
    after the save() but before all enqueue calls cannot leave the resource
    deactivated without its CPM recalcs firing (perf-check finding R3)."""

    def test_soft_delete_and_enqueue_are_atomic(
        self,
        admin_client: APIClient,
        project: Project,
        resource: Resource,
        calendar: Calendar,
    ) -> None:
        """A successful soft-delete must mark is_deleted=True AND not raise; the
        transaction commits cleanly when no errors occur."""
        from trueppm_api.apps.resources.models import TaskResource

        task = Task.objects.create(
            project=project,
            name="Build feature",
            planned_start="2025-01-01",
            duration=8,
        )
        TaskResource.objects.create(task=task, resource=resource, units=1.0)

        res = admin_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 204
        resource.refresh_from_db()
        assert resource.is_deleted is True

    def test_soft_delete_rolls_back_on_enqueue_error(
        self,
        admin_client: APIClient,
        project: Project,
        resource: Resource,
        calendar: Calendar,
    ) -> None:
        """If _enqueue_recalculate raises inside perform_destroy, the entire
        transaction must roll back — the resource must remain active."""
        import contextlib
        from unittest.mock import patch

        from trueppm_api.apps.resources.models import TaskResource

        task = Task.objects.create(
            project=project,
            name="Work item",
            planned_start="2025-01-01",
            duration=3,
        )
        TaskResource.objects.create(task=task, resource=resource, units=1.0)

        with (
            patch(
                "trueppm_api.apps.resources.views._enqueue_recalculate",
                side_effect=RuntimeError("broker down"),
            ),
            contextlib.suppress(RuntimeError),
        ):
            admin_client.delete(f"/api/v1/resources/{resource.pk}/")

        # With atomic(), the is_deleted flag must have been rolled back.
        resource.refresh_from_db()
        assert resource.is_deleted is False
