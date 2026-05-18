"""Tests for RBAC permission classes and ProjectScopedViewSet."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectMemberWriteOrOwn,
    IsProjectOwner,
    IsProjectScheduler,
    IsTokenForProject,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def client_for(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _make_request(user: object, method: str = "GET") -> MagicMock:
    req = MagicMock()
    req.user = user
    req.method = method
    return req


def _make_view(project_pk: object | None = None) -> MagicMock:
    """Build a view mock with explicit kwargs.

    Top-level routes pass ``project_pk=None`` (kwargs is empty) so the
    permission classes treat the route as not project-scoped. Nested routes
    pass the project's UUID under the ``project_pk`` kwarg, mirroring DRF's
    URL resolution for ``/projects/<project_pk>/...`` patterns.
    """
    view = MagicMock()
    view.kwargs = {"project_pk": str(project_pk)} if project_pk is not None else {}
    return view


def _add_member(user: object, project: Project, role: int) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


# ---------------------------------------------------------------------------
# IsProjectMember
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsProjectMember:
    def test_unauthenticated_denied(self, project: Project) -> None:
        perm = IsProjectMember()
        req = _make_request(MagicMock(is_authenticated=False))
        assert perm.has_permission(req, _make_view()) is False

    def test_authenticated_allowed(self, user: object) -> None:
        perm = IsProjectMember()
        req = _make_request(user)
        assert perm.has_permission(req, _make_view()) is True

    def test_non_member_denied_on_object(
        self, user: object, other_user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.OWNER)
        perm = IsProjectMember()
        req = _make_request(other_user)
        assert perm.has_object_permission(req, _make_view(), project) is False

    def test_viewer_allowed_on_object(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.VIEWER)
        perm = IsProjectMember()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is True


# ---------------------------------------------------------------------------
# IsProjectMemberWrite
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsProjectMemberWrite:
    def test_viewer_cannot_write(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.VIEWER)
        perm = IsProjectMemberWrite()
        req = _make_request(user, method="POST")
        assert perm.has_object_permission(req, _make_view(), project) is False

    def test_member_can_write(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.MEMBER)
        perm = IsProjectMemberWrite()
        req = _make_request(user, method="POST")
        assert perm.has_object_permission(req, _make_view(), project) is True

    def test_viewer_can_read(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.VIEWER)
        perm = IsProjectMemberWrite()
        req = _make_request(user, method="GET")
        assert perm.has_object_permission(req, _make_view(), project) is True

    def test_non_member_denied(self, user: object, project: Project) -> None:
        perm = IsProjectMemberWrite()
        req = _make_request(user, method="POST")
        assert perm.has_object_permission(req, _make_view(), project) is False


# ---------------------------------------------------------------------------
# IsProjectScheduler
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsProjectScheduler:
    def test_member_below_threshold_denied(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.MEMBER)
        perm = IsProjectScheduler()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is False

    def test_scheduler_allowed(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.SCHEDULER)
        perm = IsProjectScheduler()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is True

    def test_admin_allowed(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.ADMIN)
        perm = IsProjectScheduler()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is True


# ---------------------------------------------------------------------------
# IsProjectAdmin
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsProjectAdmin:
    def test_scheduler_denied(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.SCHEDULER)
        perm = IsProjectAdmin()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is False

    def test_admin_allowed(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.ADMIN)
        perm = IsProjectAdmin()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is True

    def test_owner_allowed(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.OWNER)
        perm = IsProjectAdmin()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is True


# ---------------------------------------------------------------------------
# IsProjectOwner
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsProjectOwner:
    def test_admin_denied(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.ADMIN)
        perm = IsProjectOwner()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is False

    def test_owner_allowed(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.OWNER)
        perm = IsProjectOwner()
        req = _make_request(user)
        assert perm.has_object_permission(req, _make_view(), project) is True


# ---------------------------------------------------------------------------
# ProjectViewSet auto-Owner assignment
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectCreateAutoOwner:
    def test_creator_gets_owner_membership(self, user: object, calendar: Calendar) -> None:
        c = APIClient()
        c.force_authenticate(user=user)
        resp = c.post(
            "/api/v1/projects/",
            {"name": "New Proj", "start_date": "2026-06-01", "calendar": str(calendar.pk)},
        )
        assert resp.status_code == 201
        project_id = resp.data["id"]
        membership = ProjectMembership.objects.get(project_id=project_id, user=user)
        assert membership.role == Role.OWNER

    def test_non_member_cannot_see_other_project(
        self, user: object, other_user: object, calendar: Calendar
    ) -> None:
        """A user who is not a member gets an empty project list."""
        proj = Project.objects.create(name="Hidden", start_date=date(2026, 1, 1))
        ProjectMembership.objects.create(project=proj, user=user, role=Role.OWNER)
        # other_user is not a member — they should see 0 projects.
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.get("/api/v1/projects/")
        assert resp.status_code == 200
        assert not any(p["name"] == "Hidden" for p in resp.data["results"])


# ---------------------------------------------------------------------------
# IsProjectMemberWriteOrOwn
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsProjectMemberWriteOrOwn:
    def test_viewer_cannot_write(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, Role.VIEWER)
        perm = IsProjectMemberWriteOrOwn()
        req = _make_request(user, method="PATCH")
        assert perm.has_object_permission(req, _make_view(), task) is False

    def test_member_can_edit_own_task(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=user)
        _add_member(user, project, Role.MEMBER)
        perm = IsProjectMemberWriteOrOwn()
        req = _make_request(user, method="PATCH")
        assert perm.has_object_permission(req, _make_view(), task) is True

    def test_member_cannot_edit_others_task(
        self, user: object, other_user: object, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=other_user)
        _add_member(user, project, Role.MEMBER)
        perm = IsProjectMemberWriteOrOwn()
        req = _make_request(user, method="PATCH")
        assert perm.has_object_permission(req, _make_view(), task) is False

    def test_member_cannot_edit_unassigned_task(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=None)
        _add_member(user, project, Role.MEMBER)
        perm = IsProjectMemberWriteOrOwn()
        req = _make_request(user, method="PATCH")
        assert perm.has_object_permission(req, _make_view(), task) is False

    def test_scheduler_cannot_edit_task_content(self, user: object, project: Project) -> None:
        """Resource Manager cannot edit task content — read-only for task fields."""
        task = Task.objects.create(project=project, name="T", duration=1, assignee=user)
        _add_member(user, project, Role.SCHEDULER)
        perm = IsProjectMemberWriteOrOwn()
        req = _make_request(user, method="PATCH")
        assert perm.has_object_permission(req, _make_view(), task) is False

    def test_admin_can_edit_any_task(
        self, user: object, other_user: object, project: Project
    ) -> None:
        """Project Manager can edit any task regardless of assignee."""
        task = Task.objects.create(project=project, name="T", duration=1, assignee=other_user)
        _add_member(user, project, Role.ADMIN)
        perm = IsProjectMemberWriteOrOwn()
        req = _make_request(user, method="PATCH")
        assert perm.has_object_permission(req, _make_view(), task) is True

    def test_any_member_can_read(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=None)
        _add_member(user, project, Role.VIEWER)
        perm = IsProjectMemberWriteOrOwn()
        req = _make_request(user, method="GET")
        assert perm.has_object_permission(req, _make_view(), task) is True


# ---------------------------------------------------------------------------
# M1: soft-deleted membership not honored
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSoftDeletedMembershipExcluded:
    def test_soft_deleted_membership_denied(self, user: object, project: Project) -> None:
        """A soft-deleted membership must not grant any access."""
        m = _add_member(user, project, Role.OWNER)
        m.soft_delete()
        perm = IsProjectMember()
        req = _make_request(user)
        # has_object_permission queries is_deleted=False — soft-deleted must be excluded.
        assert perm.has_object_permission(req, _make_view(), project) is False


# ---------------------------------------------------------------------------
# ProjectViewSet.destroy — Owner only
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectDestroyPermission:
    def test_non_owner_cannot_delete(
        self, user: object, project: Project, calendar: Calendar
    ) -> None:
        _add_member(user, project, Role.ADMIN)
        c = APIClient()
        c.force_authenticate(user=user)
        resp = c.delete(f"/api/v1/projects/{project.pk}/")
        assert resp.status_code == 403

    def test_owner_can_delete(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.OWNER)
        c = APIClient()
        c.force_authenticate(user=user)
        resp = c.delete(f"/api/v1/projects/{project.pk}/")
        assert resp.status_code == 204


# ---------------------------------------------------------------------------
# H1: non-member cannot create tasks or dependencies
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestH1NonMemberCannotCreate:
    def test_non_member_cannot_create_task(
        self, user: object, project: Project, other_user: object
    ) -> None:
        """H1: a user with no membership must receive 403 on task create, not 201."""
        ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
        # other_user has no membership
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "Sneaky", "duration": 1},
        )
        assert resp.status_code == 403

    def test_non_member_cannot_create_dependency(
        self, user: object, project: Project, other_user: object
    ) -> None:
        """H1: a user with no membership must receive 403 on dependency create."""
        ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
        t1 = Task.objects.create(project=project, name="A", duration=1)
        t2 = Task.objects.create(project=project, name="B", duration=1)
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.post(
            "/api/v1/dependencies/",
            {"predecessor": str(t1.pk), "successor": str(t2.pk), "dep_type": "FS"},
        )
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# #254: IDOR protection on project-nested list/create routes
# IsProjectMember.has_permission must enforce membership when project_pk is
# present in URL kwargs, not only on object endpoints. List/create actions
# never trigger has_object_permission so the gate must close earlier.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectNestedRouteMembership:
    """has_permission must reject non-members on project-nested routes."""

    def test_member_allowed_on_nested_route(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.VIEWER)
        perm = IsProjectMember()
        req = _make_request(user)
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is True

    def test_non_member_denied_on_nested_route(
        self, user: object, other_user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.OWNER)
        perm = IsProjectMember()
        req = _make_request(other_user)
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is False

    def test_writer_non_member_denied(
        self, user: object, other_user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.OWNER)
        perm = IsProjectMemberWrite()
        req = _make_request(other_user, method="POST")
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is False

    def test_scheduler_non_member_denied(
        self, user: object, other_user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.OWNER)
        perm = IsProjectScheduler()
        req = _make_request(other_user)
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is False

    def test_admin_below_threshold_denied(self, user: object, project: Project) -> None:
        """A scheduler-role member should not pass IsProjectAdmin on nested route."""
        _add_member(user, project, Role.SCHEDULER)
        perm = IsProjectAdmin()
        req = _make_request(user)
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is False

    def test_owner_role_required_for_owner_class(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.ADMIN)
        perm = IsProjectOwner()
        req = _make_request(user)
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is False


@pytest.mark.django_db
class TestNestedListIDOR:
    """End-to-end: GET /projects/<other-project>/scheduler-runs/ must not leak."""

    def test_non_member_gets_403_on_scheduler_runs_list(
        self, user: object, other_user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.OWNER)
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.get(f"/api/v1/projects/{project.pk}/scheduler-runs/")
        assert resp.status_code == 403

    def test_non_member_gets_403_on_task_runs_list(
        self, user: object, other_user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.OWNER)
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.get(f"/api/v1/projects/{project.pk}/task-runs/")
        assert resp.status_code == 403

    def test_non_member_gets_403_on_webhooks_list(
        self, user: object, other_user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.OWNER)
        c = APIClient()
        c.force_authenticate(user=other_user)
        resp = c.get(f"/api/v1/projects/{project.pk}/webhooks/")
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# IsTokenForProject — direct unit tests for the non-token / malformed-URL paths
# (the matching-token and mismatched-token paths are covered end-to-end by
# tests/apps/projects/test_inbound_task_sync.py)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsTokenForProject:
    def test_non_token_auth_returns_true(self, user: object) -> None:
        """JWT/Session auth (request.auth is not a ProjectApiToken) is a no-op.

        Keeps the permission class safely composable on views that mix auth
        backends — other permission classes are responsible for enforcing
        access on those code paths.
        """
        perm = IsTokenForProject()
        req = _make_request(user)
        req.auth = None
        assert perm.has_permission(req, _make_view()) is True

    def test_non_token_auth_with_arbitrary_object_returns_true(self, user: object) -> None:
        perm = IsTokenForProject()
        req = _make_request(user)
        req.auth = object()  # not a ProjectApiToken
        assert perm.has_permission(req, _make_view()) is True

    def test_invalid_uuid_in_url_raises_401(self, user: object, project: Project) -> None:
        """Malformed project id in URL → AuthenticationFailed (401), not 500.

        Mirrors the IDOR-defense pattern: an invalid pk must not leak whether
        the project exists.
        """
        from rest_framework.exceptions import AuthenticationFailed

        from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
        from trueppm_api.apps.projects.models import ProjectApiToken

        raw = f"{TOKEN_PREFIX}{'a' * 64}"
        token = ProjectApiToken.objects.create(
            project=project,
            name="t",
            token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
            token_hash=sha256_hex(raw),
            created_by=user,
        )
        perm = IsTokenForProject()
        req = _make_request(user)
        req.auth = token
        view = MagicMock()
        view.kwargs = {"pk": "not-a-uuid"}
        with pytest.raises(AuthenticationFailed):
            perm.has_permission(req, view)

    def test_missing_pk_in_url_raises_401(self, user: object, project: Project) -> None:
        """No pk kwarg at all → AuthenticationFailed (TypeError path on str(None))."""
        from rest_framework.exceptions import AuthenticationFailed

        from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
        from trueppm_api.apps.projects.models import ProjectApiToken

        raw = f"{TOKEN_PREFIX}{'b' * 64}"
        token = ProjectApiToken.objects.create(
            project=project,
            name="t",
            token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
            token_hash=sha256_hex(raw),
            created_by=user,
        )
        perm = IsTokenForProject()
        req = _make_request(user)
        req.auth = token
        view = MagicMock()
        view.kwargs = {}  # neither "pk" nor "project_pk"
        with pytest.raises(AuthenticationFailed):
            perm.has_permission(req, view)
