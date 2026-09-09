"""Tests for org-level resource management (issue #155).

Covers: the IsOrgAdmin permission gate on ordinary catalog writes, the
IsWorkspaceOperator floor on the deactivation lifecycle and email exposure
(#3569), soft-delete, restore action, ?include_deleted query param,
?exclude_project filter, and transaction atomicity on perform_destroy
(perf-check R3).

**Which principal owns which surface (#3569).** ``admin_client`` holds ADMIN on a
live project and is the *ordinary* catalog writer: create and update. It is NOT
sufficient for DELETE, restore, ``?include_deleted=true``, ``email`` exposure or
``email`` search — those reach every project in the install and take
``operator_client`` (a superuser). Before #3569 they all shared the org-admin
derivation, which any account self-grants by creating a throwaway project; the
``TestOrgAuthorityIsNotSelfGrantable`` and ``TestOrgAuthorityIgnoresDeadProjects``
classes at the bottom of this file are the regression tests for that.
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
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

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


def _grant_workspace_role(user: object, role: int) -> WorkspaceMembership:
    """Give ``user`` an explicit stored workspace role.

    Workspace is a singleton (unique ``singleton_key``), so reuse any seeded row.
    """
    ws = Workspace.objects.first() or Workspace.objects.create()
    return WorkspaceMembership.objects.create(workspace=ws, user=user, role=role)


@pytest.fixture
def operator_user(db: object) -> object:
    """A Django superuser carrying **no** WorkspaceMembership row.

    Kept after #3569 re-gated these surfaces onto the stored workspace role,
    because this is precisely the implicit-OWNER bootstrap path in
    ``workspace_role_for_user`` (ADR-0087 §6): a fresh install has no membership
    rows at all, and the first admin must still be able to administer it. If that
    bootstrap ever regresses, every test using this fixture fails.
    """
    return User.objects.create_superuser(username="operator_user", password="pw")


@pytest.fixture
def operator_client(operator_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=operator_user)
    return c


@pytest.fixture
def workspace_admin_user(db: object) -> object:
    """The principal #3569 actually targets: an explicit, stored workspace ADMIN.

    Deliberately **not** a superuser and **not** a member of any project — the whole
    point is that this authority is granted in-app by an existing workspace admin (or
    by SSO provisioning) and cannot be self-granted by creating a project.
    """
    user = User.objects.create_user(username="workspace_admin", password="pw")
    _grant_workspace_role(user, WorkspaceRole.ADMIN)
    return user


@pytest.fixture
def workspace_admin_client(workspace_admin_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=workspace_admin_user)
    return c


@pytest.fixture
def admin_and_workspace_admin_client(
    admin_user: object, admin_membership: ProjectMembership
) -> APIClient:
    """A caller with BOTH project ADMIN (passes the base ``IsOrgAdmin`` catalog-write
    gate) and stored workspace ADMIN (passes the #3625 ``email`` write floor).

    ``workspace_admin_user`` deliberately holds no project membership (it exists to
    prove the stored role is not self-grantable), so it cannot reach ordinary
    catalog create/update at all — it 403s on the base gate before the email check
    is ever reached. This fixture is the realistic shape of a caller who can
    actually exercise the #3625 gate on a write: an org admin whom a workspace
    owner has *also* promoted to workspace ADMIN.
    """
    _grant_workspace_role(admin_user, WorkspaceRole.ADMIN)
    c = APIClient()
    c.force_authenticate(user=admin_user)
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
        # No ``email`` here: an org-admin-derived caller (project ADMIN, not
        # workspace ADMIN) is below the #3625 write floor for that field — see
        # TestResourceEmailWriteGate for that behavior. This test covers ordinary
        # catalog creation.
        res = admin_client.post(
            "/api/v1/resources/",
            {"name": "Bob", "max_units": "0.50"},
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

    def test_operator_can_create_with_blank_email(self, operator_client: APIClient) -> None:
        """A blank email is accepted and serialized as "" (#2127 conformance fix)."""
        res = operator_client.post(
            "/api/v1/resources/",
            {"name": "Bench Saw", "email": "", "max_units": "1.00"},
            format="json",
        )
        assert res.status_code == 201
        assert res.data["email"] == ""

    def test_malformed_email_is_rejected(self, admin_client: APIClient) -> None:
        """Non-blank input is still validated as an email (#2127 preserves validation)."""
        res = admin_client.post(
            "/api/v1/resources/",
            {"name": "Bad", "email": "not-an-email", "max_units": "1.00"},
            format="json",
        )
        assert res.status_code == 400
        assert "email" in res.data

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
    def test_operator_delete_soft_deletes(
        self, operator_client: APIClient, resource: Resource
    ) -> None:
        res = operator_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 204
        # Row still exists in the database
        resource.refresh_from_db()
        assert resource.is_deleted is True

    def test_deleted_resource_hidden_from_list(
        self, operator_client: APIClient, resource: Resource
    ) -> None:
        operator_client.delete(f"/api/v1/resources/{resource.pk}/")
        res = operator_client.get("/api/v1/resources/")
        ids = [r["id"] for r in res.data["results"]]
        assert str(resource.pk) not in ids

    def test_include_deleted_shows_deactivated(
        self, operator_client: APIClient, resource: Resource
    ) -> None:
        operator_client.delete(f"/api/v1/resources/{resource.pk}/")
        res = operator_client.get("/api/v1/resources/?include_deleted=true")
        ids = [r["id"] for r in res.data["results"]]
        assert str(resource.pk) in ids

    def test_member_include_deleted_param_ignored(
        self, member_client: APIClient, resource: Resource
    ) -> None:
        """#1374: ``?include_deleted=true`` is honored only for workspace operators
        (#3569). Anyone else passing it must still get the deactivated record
        filtered out — the param is silently ignored, not an enumeration backdoor
        onto the soft-deleted pool."""
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
        operator_client: APIClient,
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
        res = operator_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 204
        resource.refresh_from_db()
        assert resource.is_deleted is True

    def test_delete_broadcasts_roster_changed_to_assigned_projects(
        self,
        operator_client: APIClient,
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
            res = operator_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 204
        assert (str(project.pk), "roster_changed", {"resource_id": str(resource.pk)}) in events


# ---------------------------------------------------------------------------
# Restore action
# ---------------------------------------------------------------------------


class TestResourceRestore:
    def test_operator_can_restore(self, operator_client: APIClient, resource: Resource) -> None:
        operator_client.delete(f"/api/v1/resources/{resource.pk}/")
        res = operator_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 200
        resource.refresh_from_db()
        assert resource.is_deleted is False

    def test_restore_non_deleted_returns_400(
        self, operator_client: APIClient, resource: Resource
    ) -> None:
        res = operator_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 400

    def test_restore_broadcasts_roster_changed_to_assigned_projects(
        self,
        operator_client: APIClient,
        project: Project,
        resource: Resource,
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        """Reactivation puts the resource back on its rosters → roster_changed (#1359)."""
        task = Task.objects.create(
            project=project, name="Build feature", planned_start="2025-01-01", duration=8
        )
        TaskResource.objects.create(task=task, resource=resource, units=1.0)
        operator_client.delete(f"/api/v1/resources/{resource.pk}/")

        events: list[tuple[str, str, dict]] = []
        with (
            patch(
                BROADCAST_PATH,
                side_effect=lambda pid, et, payload: events.append((pid, et, payload)),
            ),
            django_capture_on_commit_callbacks(execute=True),
        ):
            res = operator_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 200
        assert (str(project.pk), "roster_changed", {"resource_id": str(resource.pk)}) in events

    def test_member_cannot_restore(self, member_client: APIClient, resource: Resource) -> None:
        resource.is_deleted = True
        resource.save(update_fields=["is_deleted"])
        res = member_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert res.status_code == 403

    def test_restore_unknown_resource_returns_404(self, operator_client: APIClient) -> None:
        res = operator_client.post(f"/api/v1/resources/{uuid4()}/restore/")
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
    row let one account paginate it to harvest the org's email list. Email is
    gated in ``to_representation`` on the workspace operator (#3569 — the org-admin
    check it used to run was self-grantable, so the control admitted everyone); the
    resource's own user still sees their email via the is_me self-view path.
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

    def test_operator_list_includes_email(
        self, operator_client: APIClient, resource: Resource
    ) -> None:
        res = operator_client.get("/api/v1/resources/")
        assert res.status_code == 200
        row = next(r for r in res.data["results"] if r["id"] == str(resource.pk))
        assert row["email"] == "alice@example.com"

    def test_org_admin_list_omits_email(self, admin_client: APIClient, resource: Resource) -> None:
        """#3569: ADMIN on a project is no longer enough to read the catalog's emails."""
        res = admin_client.get("/api/v1/resources/")
        assert res.status_code == 200
        row = next(r for r in res.data["results"] if r["id"] == str(resource.pk))
        assert "email" not in row

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

    def test_operator_search_by_email_works(
        self, operator_client: APIClient, resource: Resource
    ) -> None:
        """Operators retain email search — the gate only narrows it for everyone else (#892)."""
        res = operator_client.get("/api/v1/resources/?search=alice@example.com")
        assert res.status_code == 200
        assert any(r["id"] == str(resource.pk) for r in res.data["results"])

    def test_org_admin_search_by_email_finds_nothing(
        self, admin_client: APIClient, resource: Resource
    ) -> None:
        """#3569: the #892 probe is closed for org admins too, not just members.

        Asserting the *negative* here is only meaningful because
        ``test_org_admin_search_by_name_still_works`` below proves the same client
        can still find the same row by name — otherwise an empty result would be
        indistinguishable from a broken search.
        """
        res = admin_client.get("/api/v1/resources/?search=alice@example.com")
        assert res.status_code == 200
        assert res.data["results"] == []

    def test_org_admin_search_by_name_still_works(
        self, admin_client: APIClient, resource: Resource
    ) -> None:
        """The raised email gate must not break an org admin's ordinary name search."""
        res = admin_client.get("/api/v1/resources/?search=Alice")
        assert res.status_code == 200
        assert any(r["id"] == str(resource.pk) for r in res.data["results"])


# ---------------------------------------------------------------------------
# Email write gate (#3625) — writing email must not be easier than reading it
# ---------------------------------------------------------------------------


class TestResourceEmailWriteGate:
    """A caller below workspace ADMIN must not be able to *write* ``email`` either.

    #3569 raised the read floor for ``email`` to the stored workspace ADMIN role,
    but left writing it on ``IsOrgAdmin`` (self-grantable — see
    ``TestOrgAuthorityIsNotSelfGrantable`` for the exploit path). A fresh account
    could overwrite any catalog row's email in two requests while being unable to
    read the value it replaced. ``ResourceSerializer.validate`` closes that: it
    rejects any write that includes ``email`` from a caller below workspace ADMIN,
    mirroring ``to_representation``'s read-side strip via the same
    ``_caller_is_workspace_admin`` check.
    """

    def test_admin_cannot_set_email_on_create(self, admin_client: APIClient) -> None:
        """Project ADMIN (org-admin derivation) is below the write floor for email."""
        res = admin_client.post(
            "/api/v1/resources/",
            {"name": "Mallory", "email": "mallory@example.com", "max_units": "1.00"},
            format="json",
        )
        assert res.status_code == 400
        assert "email" in res.data
        assert not Resource.objects.filter(name="Mallory").exists()

    def test_admin_cannot_patch_email(self, admin_client: APIClient, resource: Resource) -> None:
        """Same floor on update: an existing row's email cannot be overwritten either."""
        res = admin_client.patch(
            f"/api/v1/resources/{resource.pk}/",
            {"email": "attacker@example.com"},
            format="json",
        )
        assert res.status_code == 400
        assert "email" in res.data
        resource.refresh_from_db()
        assert resource.email == "alice@example.com"

    def test_member_cannot_set_email_on_create(self, member_client: APIClient) -> None:
        """A plain member is refused at the view permission layer before the
        serializer is even reached (IsOrgAdmin gates create at all) — the write
        floor for email is strictly narrower than the ordinary create floor, so
        this must fail too, just earlier."""
        res = member_client.post(
            "/api/v1/resources/",
            {"name": "Trent", "email": "trent@example.com", "max_units": "1.00"},
            format="json",
        )
        assert res.status_code == 403
        assert not Resource.objects.filter(name="Trent").exists()

    def test_admin_can_still_patch_other_fields(
        self, admin_client: APIClient, resource: Resource
    ) -> None:
        """The write gate is scoped to ``email`` alone — ordinary catalog curation
        (name, job role, capacity, calendar) stays on the project-derived gate
        (ADR-0034), per the issue's stated scope."""
        res = admin_client.patch(
            f"/api/v1/resources/{resource.pk}/",
            {"job_role": "Carpenter", "max_units": "0.75"},
            format="json",
        )
        assert res.status_code == 200
        resource.refresh_from_db()
        assert resource.job_role == "Carpenter"
        assert resource.email == "alice@example.com"

    def test_workspace_admin_can_set_email_on_create(
        self, admin_and_workspace_admin_client: APIClient
    ) -> None:
        """The stored workspace ADMIN role — the read floor's own principal — may
        still set email on create."""
        res = admin_and_workspace_admin_client.post(
            "/api/v1/resources/",
            {"name": "Alice Two", "email": "alice2@example.com", "max_units": "1.00"},
            format="json",
        )
        assert res.status_code == 201
        assert Resource.objects.get(name="Alice Two").email == "alice2@example.com"

    def test_workspace_admin_can_patch_email(
        self, admin_and_workspace_admin_client: APIClient, resource: Resource
    ) -> None:
        res = admin_and_workspace_admin_client.patch(
            f"/api/v1/resources/{resource.pk}/",
            {"email": "alice_new@example.com"},
            format="json",
        )
        assert res.status_code == 200
        resource.refresh_from_db()
        assert resource.email == "alice_new@example.com"

    def test_operator_can_patch_email(self, operator_client: APIClient, resource: Resource) -> None:
        """Superuser bootstrap (#3569's implicit OWNER path) also clears the write floor."""
        res = operator_client.patch(
            f"/api/v1/resources/{resource.pk}/",
            {"email": "alice_ops@example.com"},
            format="json",
        )
        assert res.status_code == 200
        resource.refresh_from_db()
        assert resource.email == "alice_ops@example.com"


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
        operator_client: APIClient,
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

        res = operator_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 204
        resource.refresh_from_db()
        assert resource.is_deleted is True

    def test_soft_delete_rolls_back_on_enqueue_error(
        self,
        operator_client: APIClient,
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
            operator_client.delete(f"/api/v1/resources/{resource.pk}/")

        # With atomic(), the is_deleted flag must have been rolled back.
        resource.refresh_from_db()
        assert resource.is_deleted is False


# ---------------------------------------------------------------------------
# #3569 — org authority is self-grantable; the raised surfaces must not care
# ---------------------------------------------------------------------------


class TestOrgAuthorityIsNotSelfGrantable:
    """A fresh account that creates its own project must not reach the raised surfaces.

    This is the exploit the issue describes, end to end: nothing gates
    ``POST /api/v1/projects/`` and ``ProjectViewSet.perform_create`` makes the
    caller ``Role.OWNER``, so two requests bought ``IsOrgAdmin`` — and with it the
    catalog's emails, the deactivated pool, cross-project assignment names, and
    resource deletion.

    Gating project creation was considered and rejected (it is the adoption tax the
    SSO/HA carve-outs exist to prevent), so ``test_the_exploit_precondition_still_holds``
    asserts the *first* half of the chain is deliberately still open. Every other
    test here asserts the second half is now closed. If the precondition test ever
    starts failing, the rest of this class has gone vacuous and must be re-read.
    """

    @pytest.fixture
    def fresh_owner_client(self, db: object, calendar: Calendar) -> APIClient:
        """An account whose only authority is the project it just created for itself."""
        user = User.objects.create_user(username="fresh_signup", password="pw")
        c = APIClient()
        c.force_authenticate(user=user)
        res = c.post(
            "/api/v1/projects/",
            {"name": "Throwaway", "start_date": "2026-01-01", "calendar": str(calendar.pk)},
            format="json",
        )
        assert res.status_code == 201, res.data
        return c

    def test_the_exploit_precondition_still_holds(self, db: object, calendar: Calendar) -> None:
        """Creating a project still makes you its Owner — deliberately unchanged.

        Without this the four refusals below would pass for the wrong reason (the
        caller never gained ADMIN at all), and the regression they guard would be
        untested.
        """
        user = User.objects.create_user(username="precondition_user", password="pw")
        c = APIClient()
        c.force_authenticate(user=user)
        res = c.post(
            "/api/v1/projects/",
            {"name": "Precondition", "start_date": "2026-01-01", "calendar": str(calendar.pk)},
            format="json",
        )
        assert res.status_code == 201
        assert ProjectMembership.objects.filter(
            user=user, project_id=res.data["id"], role=Role.OWNER
        ).exists()

    def test_refused_on_assignments(
        self, fresh_owner_client: APIClient, resource: Resource
    ) -> None:
        res = fresh_owner_client.get(f"/api/v1/resources/{resource.pk}/assignments/")
        assert res.status_code == 403

    def test_refused_catalog_email(self, fresh_owner_client: APIClient, resource: Resource) -> None:
        res = fresh_owner_client.get(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 200
        assert "email" not in res.data

    def test_refused_email_search(self, fresh_owner_client: APIClient, resource: Resource) -> None:
        res = fresh_owner_client.get("/api/v1/resources/?search=alice@example.com")
        assert res.status_code == 200
        assert res.data["results"] == []
        # Not vacuous: the same client finds the same row by name.
        by_name = fresh_owner_client.get("/api/v1/resources/?search=Alice")
        assert any(r["id"] == str(resource.pk) for r in by_name.data["results"])

    def test_refused_include_deleted(
        self, fresh_owner_client: APIClient, resource: Resource
    ) -> None:
        resource.is_deleted = True
        resource.save(update_fields=["is_deleted"])
        res = fresh_owner_client.get("/api/v1/resources/?include_deleted=true")
        assert res.status_code == 200
        assert str(resource.pk) not in [r["id"] for r in res.data["results"]]

    def test_refused_resource_delete(
        self, fresh_owner_client: APIClient, resource: Resource
    ) -> None:
        res = fresh_owner_client.delete(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 403
        resource.refresh_from_db()
        assert resource.is_deleted is False


class TestWorkspaceAdminReachesTheRaisedSurfaces:
    """The positive half of #3569: a stored workspace ADMIN **passes** all four.

    Without this the refusal tests elsewhere in this file would be satisfied by a
    gate that refuses *everyone* — a permission fix that locks the feature out is
    not a fix. Each test here is paired with a refusal of the same surface by the
    self-granting project creator in
    :class:`TestOrgAuthorityIsNotSelfGrantable`, so the pair pins the boundary from
    both sides.

    The principal is deliberately an explicit ``WorkspaceMembership`` at ADMIN, with
    **no** superuser flag and **no** project membership at all. That combination is
    the whole argument for the re-gate: it is authority that exists only because
    somebody granted it in-app, and it is unreachable from ``POST /projects/``.
    """

    def test_admin_reads_catalog_email(
        self, workspace_admin_client: APIClient, resource: Resource
    ) -> None:
        res = workspace_admin_client.get(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 200
        assert res.data["email"] == "alice@example.com"

    def test_admin_searches_by_email(
        self, workspace_admin_client: APIClient, resource: Resource
    ) -> None:
        res = workspace_admin_client.get("/api/v1/resources/?search=alice@example.com")
        assert res.status_code == 200
        assert any(r["id"] == str(resource.pk) for r in res.data["results"])

    def test_admin_lists_the_deactivated_pool(
        self, workspace_admin_client: APIClient, resource: Resource
    ) -> None:
        resource.is_deleted = True
        resource.save(update_fields=["is_deleted"])
        res = workspace_admin_client.get("/api/v1/resources/?include_deleted=true")
        assert res.status_code == 200
        assert str(resource.pk) in [r["id"] for r in res.data["results"]]

    def test_admin_reads_assignments(
        self, workspace_admin_client: APIClient, resource: Resource, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="Design", duration=5)
        TaskResource.objects.create(task=task, resource=resource, units=1.0)
        res = workspace_admin_client.get(f"/api/v1/resources/{resource.pk}/assignments/")
        assert res.status_code == 200

    def test_admin_deactivates_and_restores(
        self, workspace_admin_client: APIClient, resource: Resource
    ) -> None:
        assert workspace_admin_client.delete(f"/api/v1/resources/{resource.pk}/").status_code == 204
        resource.refresh_from_db()
        assert resource.is_deleted is True

        restored = workspace_admin_client.post(f"/api/v1/resources/{resource.pk}/restore/")
        assert restored.status_code == 200
        resource.refresh_from_db()
        assert resource.is_deleted is False

    def test_workspace_member_is_refused(self, db: object, resource: Resource) -> None:
        """An explicit MEMBER row is below the floor — the tier is real, not decorative.

        Every authenticated user resolves to implicit MEMBER anyway, so without this
        the ADMIN tests above would pass equally well against a gate that only
        checked "has any workspace row at all".
        """
        user = User.objects.create_user(username="ws_member", password="pw")
        _grant_workspace_role(user, WorkspaceRole.MEMBER)
        c = APIClient()
        c.force_authenticate(user=user)

        assert c.get(f"/api/v1/resources/{resource.pk}/assignments/").status_code == 403
        assert c.delete(f"/api/v1/resources/{resource.pk}/").status_code == 403
        assert "email" not in c.get(f"/api/v1/resources/{resource.pk}/").data

    def test_deactivated_admin_row_revokes_access(self, db: object, resource: Resource) -> None:
        """A deactivated row resolves to None, not to the implicit MEMBER default.

        Pins the one branch of ``workspace_role_for_user`` that an ``is_superuser``
        check could never have expressed, and which a naive ``role >= ADMIN`` on a
        raw queryset would get wrong.
        """
        from trueppm_api.apps.workspace.models import MemberStatus

        user = User.objects.create_user(username="ws_admin_off", password="pw")
        membership = _grant_workspace_role(user, WorkspaceRole.ADMIN)
        membership.status = MemberStatus.DEACTIVATED
        membership.save(update_fields=["status"])
        c = APIClient()
        c.force_authenticate(user=user)

        assert c.get(f"/api/v1/resources/{resource.pk}/assignments/").status_code == 403
        assert c.delete(f"/api/v1/resources/{resource.pk}/").status_code == 403

    def test_superuser_with_an_explicit_member_row_is_refused(
        self, db: object, resource: Resource
    ) -> None:
        """The stored row wins over the superuser flag — an intentional behavior change.

        Under the previous ``IsWorkspaceOperator`` gate this caller passed on
        ``is_superuser`` alone. ``workspace_role_for_user`` consults the explicit row
        first and only falls back to implicit OWNER when there is none, so a superuser
        who has been explicitly recorded as a plain member is now refused. Recorded as
        a test because it is the one place the re-gate is *narrower* than superuser.
        """
        user = User.objects.create_superuser(username="su_downgraded", password="pw")
        _grant_workspace_role(user, WorkspaceRole.MEMBER)
        c = APIClient()
        c.force_authenticate(user=user)

        assert c.get(f"/api/v1/resources/{resource.pk}/assignments/").status_code == 403


class TestOrgAuthorityIgnoresDeadProjects:
    """A membership on an archived or soft-deleted project confers no org authority.

    The historical filter was ``ProjectMembership.objects.filter(user=…,
    role__gte=…, is_deleted=False)`` — that flag is the *membership's*, so the
    project's own ``is_deleted`` / ``is_archived`` were never read and a project
    deleted years ago still handed out live org-wide authority.

    Both gates are covered: ``IsOrgAdmin`` via ``POST /resources/`` and
    ``IsOrgScheduler`` via ``POST /skills/``. Each dead-project case is paired with
    the same request on a live project, so a 403 can never be mistaken for a
    generally broken endpoint.
    """

    @staticmethod
    def _client_with_admin_on(user_name: str, project: Project) -> tuple[APIClient, object]:
        user = User.objects.create_user(username=user_name, password="pw")
        ProjectMembership.objects.create(user=user, project=project, role=Role.ADMIN)
        c = APIClient()
        c.force_authenticate(user=user)
        return c, user

    @staticmethod
    def _create_resource(client: APIClient, name: str) -> Any:
        # No ``email`` in the payload: this helper exercises the org-admin
        # *catalog-write* derivation itself (#3569), not the narrower #3625
        # ``email`` write floor — a project-derived admin is below that floor
        # regardless of live/archived/dead project status, so including it here
        # would make every 201 assertion below fail on an unrelated gate.
        return client.post(
            "/api/v1/resources/",
            {"name": name, "max_units": "1.00"},
            format="json",
        )

    @staticmethod
    def _create_skill(client: APIClient, name: str) -> Any:
        return client.post("/api/v1/skills/", {"name": name}, format="json")

    def test_live_project_admin_is_the_control(self, project: Project) -> None:
        """Positive control: the same setup on a live project passes both gates."""
        c, _ = self._client_with_admin_on("live_admin", project)
        assert self._create_resource(c, "Live").status_code == 201
        assert self._create_skill(c, "live-skill").status_code in (200, 201)

    def test_archived_project_admin_is_refused(self, project: Project) -> None:
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        c, _ = self._client_with_admin_on("archived_admin", project)
        assert self._create_resource(c, "Archived").status_code == 403
        assert self._create_skill(c, "archived-skill").status_code == 403

    def test_soft_deleted_project_admin_is_refused(self, project: Project) -> None:
        project.is_deleted = True
        project.save(update_fields=["is_deleted"])
        c, _ = self._client_with_admin_on("deleted_admin", project)
        assert self._create_resource(c, "Deleted").status_code == 403
        assert self._create_skill(c, "deleted-skill").status_code == 403

    def test_dead_project_admin_does_not_see_catalog_email(
        self, project: Project, resource: Resource
    ) -> None:
        """The derivation is shared with the serializer mirror, so fix both or neither."""
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        c, _ = self._client_with_admin_on("archived_reader", project)
        res = c.get(f"/api/v1/resources/{resource.pk}/")
        assert res.status_code == 200
        assert "email" not in res.data

    def test_live_membership_elsewhere_still_counts(self, project: Project) -> None:
        """One archived project must not mask a live one — the filter is per-row."""
        c, user = self._client_with_admin_on("mixed_admin", project)
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        live = Project.objects.create(name="Live", start_date="2026-01-01")
        ProjectMembership.objects.create(user=user, project=live, role=Role.ADMIN)
        assert self._create_resource(c, "Mixed").status_code == 201
