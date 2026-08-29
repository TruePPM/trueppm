"""Tests for RBAC permission classes and ProjectScopedViewSet."""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from typing import Any, ClassVar
from unittest.mock import MagicMock

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    CanAssignResource,
    CanLogTime,
    IsOrgAdmin,
    IsOrgScheduler,
    IsProgramAdmin,
    IsProgramEditor,
    IsProgramMember,
    IsProgramNotClosed,
    IsProgramOwner,
    IsProgramScheduler,
    IsProjectAdmin,
    IsProjectBacklogManager,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectMemberWriteOrOwn,
    IsProjectNotArchived,
    IsProjectOwner,
    IsProjectScheduler,
    IsProjectScopeManager,
    IsTaskScopeManager,
    IsTokenForProject,
    IsWorkspaceOperator,
    ProjectScopedViewSet,
    TokenHasScope,
    _get_program_id_from_obj,
    _get_project_id_from_obj,
    _mcp_client_ip,
    _set_agent_span_attributes,
    can_manage_backlog,
    can_manage_backlog_with_facet,
    can_manage_scope_with_facet,
    can_user_edit_task,
    can_user_log_time,
    effective_program_role,
    effective_project_role,
)
from trueppm_api.apps.projects.models import Calendar, Dependency, Program, Project, Task
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

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
    # Model the real attribute (#2745). A bare MagicMock SYNTHESIZES
    # `project_url_kwarg`, so `_project_pk_from_view` would read a Mock instead of a
    # kwarg name, miss every key, and fail open — making these role-matrix tests pass
    # against a permission class that enforced nothing. The resolver now ignores a
    # non-string, but pin the interface here too: a mock that does not model the
    # object it stands in for is the thing being tested, not a detail of the mock.
    view.project_url_kwarg = "project_pk"
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
# CanAssignResource (#1006: SCHEDULER floor is now declarative on nested routes)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCanAssignResource:
    """has_permission now enforces the SCHEDULER floor for unsafe methods when the
    route exposes ``project_pk`` (nested/detail routes). Flat list-create routes that
    carry the project in the body fall through to True — perform_create enforces there."""

    def test_member_below_scheduler_denied_on_nested_write(
        self, user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.MEMBER)
        perm = CanAssignResource()
        req = _make_request(user, method="POST")
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is False

    def test_scheduler_allowed_on_nested_write(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.SCHEDULER)
        perm = CanAssignResource()
        req = _make_request(user, method="POST")
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is True

    def test_safe_method_allowed_for_member(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.MEMBER)
        perm = CanAssignResource()
        req = _make_request(user, method="GET")
        assert perm.has_permission(req, _make_view(project_pk=project.pk)) is True

    def test_flat_route_defers_to_perform_create(self, user: object, project: Project) -> None:
        """No project_pk in the URL (body-project route): has_permission cannot resolve
        the role here, so it returns True and perform_create enforces the floor."""
        _add_member(user, project, Role.MEMBER)
        perm = CanAssignResource()
        req = _make_request(user, method="POST")
        assert perm.has_permission(req, _make_view()) is True

    def test_unauthenticated_denied(self) -> None:
        anon = MagicMock()
        anon.is_authenticated = False
        perm = CanAssignResource()
        req = _make_request(anon, method="POST")
        assert perm.has_permission(req, _make_view()) is False


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
# #2745: the five task-authoring routes are gated by has_permission, not only
# by the compensating in-body object check
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskAuthoringRoutesGateInHasPermission:
    """`has_permission` must deny a Viewer on `projects/<pk>/tasks/…` routes.

    These routes are declared `projects/<pk>/…`, not `projects/<project_pk>/…`, so
    `_project_pk_from_view` used to resolve nothing and every project-scoped class
    fell through to `return True`. The route still *read* as gated — the class was
    right there in `permission_classes` — while enforcement rested entirely on a
    hand-written `check_object_permissions` line in the view body. Three issues
    shared that shape (#2508, #2551, #2745).

    The views now declare `project_url_kwarg = "pk"`. These assertions go at the
    permission class directly rather than through the client on purpose: a request
    test would be satisfied by the in-body check and would therefore pass just as
    well with the declaration deleted, which is precisely the thing that went
    unnoticed for three issues. The in-body call is still there and still tested —
    see `DEFENSE_IN_DEPTH_ROUTES` in `test_route_table_invariants.py`.
    """

    # (view class, the permission class that must refuse a Viewer)
    AUTHORING_VIEWS: ClassVar[list[tuple[str, type]]] = [
        ("TaskBulkView", IsProjectMemberWrite),
        ("TaskReorderView", IsProjectMemberWrite),
        ("TaskIndentView", IsProjectMemberWrite),
        ("TaskOutdentView", IsProjectMemberWrite),
        ("TaskReparentView", IsProjectMemberWrite),
    ]

    @staticmethod
    def _view_for(name: str) -> Any:
        from trueppm_api.apps.projects import views as project_views

        return getattr(project_views, name)

    @pytest.mark.parametrize("view_name,_perm", AUTHORING_VIEWS)
    def test_view_declares_the_project_kwarg(self, view_name: str, _perm: Any) -> None:
        """Without the declaration the resolver reads `project_pk`, which is absent."""
        assert self._view_for(view_name).project_url_kwarg == "pk"

    @pytest.mark.parametrize("view_name,perm_class", AUTHORING_VIEWS)
    def test_viewer_denied_by_has_permission(
        self, view_name: str, perm_class: Any, user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.VIEWER)
        view = self._view_for(view_name)()
        view.kwargs = {"pk": str(project.pk)}
        assert perm_class().has_permission(_make_request(user, "POST"), view) is False

    @pytest.mark.parametrize("view_name,perm_class", AUTHORING_VIEWS)
    def test_member_allowed_by_has_permission(
        self, view_name: str, perm_class: Any, user: object, project: Project
    ) -> None:
        """The control — otherwise a resolver that denied everyone would pass above.

        This is the assertion that would have caught a naive "also try `pk`" fix:
        aliasing `pk` globally would hand a task/dependency id to `_membership_role`
        on other routes and deny legitimate callers there. Here the id IS the
        project, so a Member must pass.
        """
        _add_member(user, project, Role.MEMBER)
        view = self._view_for(view_name)()
        view.kwargs = {"pk": str(project.pk)}
        assert perm_class().has_permission(_make_request(user, "POST"), view) is True

    def test_a_non_string_declaration_does_not_reopen_the_gate(
        self, user: object, project: Project
    ) -> None:
        """An unusable declaration must fall back, never silently fail open.

        `getattr` on an object that synthesizes attributes returns a truthy
        non-string; indexing `kwargs` with it misses every key and yields None,
        which every caller reads as "not project-scoped". That is this issue's own
        defect, reachable through its fix.
        """
        view = MagicMock()
        view.kwargs = {"project_pk": str(project.pk)}
        # A bare MagicMock synthesizes `project_url_kwarg` as a Mock.
        assert not isinstance(view.project_url_kwarg, str)
        _add_member(user, project, Role.VIEWER)
        assert IsProjectMemberWrite().has_permission(_make_request(user, "POST"), view) is False


# ---------------------------------------------------------------------------
# #3053: the dependency band is not the task-content band
#
# Two different rules, neither a superset of the other:
#
#   task content   IsProjectPlanAuthor   role >= MEMBER minus the 200-299 band
#   dependencies   IsProjectScheduler    role >= SCHEDULER
#
# The web Designer fronted both on ONE boolean, which is therefore wrong for one
# band whichever way it resolves. Splitting it (`canAuthorDependencies` in
# `packages/web/src/lib/roles.ts`) needs the server contract stated rather than
# assumed, and stating it is not as simple as reading the permission_classes:
#
#   POST /api/v1/dependencies/ is a FLAT route with no project_pk, so
#   IsProjectScheduler.has_permission takes its `return True` fail-open branch
#   (the open #2745 class) and has_object_permission never runs on a create.
#
# The Scheduler floor survives one layer down, in
# DependencySerializer._authorize_same_project_edge, which calls
# check_object_permissions on BOTH endpoint tasks. These tests assert the
# OUTCOME at the band boundary, so they keep holding if #2745 moves the
# enforcement back up to the view where you would expect to find it.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDependencyAuthoringBand:
    """The band boundary for `POST /dependencies/` is SCHEDULER, not MEMBER."""

    @staticmethod
    def _post_edge(actor: object, project: Project) -> Any:
        t1 = Task.objects.create(project=project, name="A", duration=1)
        t2 = Task.objects.create(project=project, name="B", duration=1)
        c = APIClient()
        c.force_authenticate(user=actor)
        return c.post(
            "/api/v1/dependencies/",
            {"predecessor": str(t1.pk), "successor": str(t2.pk), "dep_type": "FS"},
        )

    def test_member_cannot_create_dependency(self, user: object, project: Project) -> None:
        """A Member authors task CONTENT and is refused EDGES.

        This is the half the client used to offer: `can_author` is true for this
        band, so a gate derived from it alone paints a link handle the server
        answers 403.
        """
        _add_member(user, project, Role.MEMBER)
        assert self._post_edge(user, project).status_code == 403

    def test_scheduler_can_create_dependency(self, user: object, project: Project) -> None:
        """A Scheduler is refused task content and MAY author edges.

        The ruling recorded on #3053 (2026-08-25) and the capability
        the published RBAC matrix already promises the role. `DependencyViewSet`
        is deliberately NOT narrowed to match the task-content gate — that would be
        a breaking permission change for anyone who staffed the role as documented.
        """
        _add_member(user, project, Role.SCHEDULER)
        assert self._post_edge(user, project).status_code == 201

    def test_admin_can_create_dependency(self, user: object, project: Project) -> None:
        """Above the floor is unaffected — the split narrows nothing at the top."""
        _add_member(user, project, Role.ADMIN)
        assert self._post_edge(user, project).status_code == 201

    def test_viewer_cannot_create_dependency(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.VIEWER)
        assert self._post_edge(user, project).status_code == 403

    # The other half of the pair, asserted as a PAIR so the two cannot drift.
    #
    # A Scheduler being allowed edges and refused rows is precisely why one client
    # boolean could not front both. The two tests below share a task the actor is
    # ASSIGNED to, which is what makes the Scheduler refusal discriminating: on an
    # UNASSIGNED task `can_user_edit_task` refuses a Member too
    # (`role == Role.MEMBER` → `assignee_id == request.user.pk`), so a 403 there
    # would prove nothing about the band and would still pass with the
    # `if role == Role.SCHEDULER: return False` branch deleted.

    def test_member_may_edit_a_task_assigned_to_them(self, user: object, project: Project) -> None:
        """The control. Same task, same write, one rung down — allowed."""
        _add_member(user, project, Role.MEMBER)
        task = Task.objects.create(project=project, name="Mine", duration=1, assignee=user)
        c = APIClient()
        c.force_authenticate(user=user)
        resp = c.patch(f"/api/v1/tasks/{task.pk}/", {"name": "Renamed"}, format="json")
        assert resp.status_code == 200

    def test_scheduler_is_still_refused_task_content(self, user: object, project: Project) -> None:
        """A Scheduler is refused the write the Member above was granted.

        Ordinally ABOVE Member and refused anyway — the band exclusion, isolated.
        If a future change makes this 2xx, the client split has lost its reason to
        exist and should be revisited rather than left as a second, silently-wrong
        rule.
        """
        _add_member(user, project, Role.SCHEDULER)
        task = Task.objects.create(project=project, name="Mine", duration=1, assignee=user)
        c = APIClient()
        c.force_authenticate(user=user)
        resp = c.patch(f"/api/v1/tasks/{task.pk}/", {"name": "Renamed"}, format="json")
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


def _plain_request(who: object, method: str = "GET") -> SimpleNamespace:
    """A request stub whose per-request caches behave like real dicts.

    ``_make_request`` returns a ``MagicMock``, and a MagicMock auto-creates
    ``__getitem__``/``__contains__`` — so the permission layer's per-request caches
    (``_project_archive_cache``, ``_program_close_cache``, ``_rbac_role_cache``)
    read back a truthy mock instead of the value that was stored. Any assertion on
    a cached lookup therefore needs a plain object, so the cache dict is created
    and read for real.
    """
    return SimpleNamespace(user=who, method=method)


@pytest.fixture
def program(db: object, user: object) -> Program:
    """A program whose ``user`` fixture is deliberately NOT a member.

    Membership is added per-test so each role's decision is asserted explicitly.
    """
    return Program.objects.create(name="Prog")


def _grant_facet(
    project: Project,
    who: object,
    *,
    is_scrum_master: bool = False,
    is_product_owner: bool = False,
) -> None:
    """Give ``who`` a facet on the project's default team.

    Mirrors the production invariant (one default team per project; facets live on
    the TeamMembership row) without depending on the on_commit mirror signal, which
    does not fire inside the test transaction.
    """
    team, _ = Team.objects.get_or_create(
        project=project,
        is_default=True,
        defaults={"name": "Default Team", "short_id": "T01"},
    )
    TeamMembership.objects.create(
        team=team,
        user=who,
        role=TeamRole.MEMBER,
        is_scrum_master=is_scrum_master,
        is_product_owner=is_product_owner,
    )


# ---------------------------------------------------------------------------
# _get_project_id_from_obj / _get_program_id_from_obj — resolution fallbacks
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProjectIdResolution:
    def test_project_instance_resolves_to_its_own_pk(self, project: Project) -> None:
        assert _get_project_id_from_obj(project) == project.pk

    def test_task_resolves_through_project_fk(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        assert _get_project_id_from_obj(task) == project.pk

    def test_dependency_resolves_through_predecessor(self, project: Project) -> None:
        """Dependency has no ``project`` FK — the project comes via the predecessor."""
        a = Task.objects.create(project=project, name="A", duration=1)
        b = Task.objects.create(project=project, name="B", duration=1)
        dep = Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")
        assert _get_project_id_from_obj(dep) == project.pk

    def test_detached_predecessor_yields_none(self) -> None:
        """A dependency-shaped object with no loadable predecessor fails closed."""
        obj = SimpleNamespace(predecessor_id=None, predecessor=None)
        assert _get_project_id_from_obj(obj) is None

    def test_unrelated_object_yields_none(self) -> None:
        assert _get_project_id_from_obj(SimpleNamespace()) is None

    def test_org_level_object_yields_none(self, calendar: Calendar) -> None:
        """Calendars are org-level — no project to scope against."""
        assert _get_project_id_from_obj(calendar) is None


@pytest.mark.django_db
class TestProgramIdResolution:
    def test_program_instance_resolves_to_its_own_pk(self, program: Program) -> None:
        assert _get_program_id_from_obj(program) == program.pk

    def test_object_with_program_fk_resolves(self, program: Program, user: object) -> None:
        membership = ProgramMembership.objects.create(program=program, user=user, role=Role.OWNER)
        assert _get_program_id_from_obj(membership) == program.pk

    def test_unrelated_object_yields_none(self) -> None:
        assert _get_program_id_from_obj(SimpleNamespace()) is None


# ---------------------------------------------------------------------------
# Full five-role matrices — the decision, per role, for each project gate
# ---------------------------------------------------------------------------


_WRITE_MATRIX = [
    (Role.VIEWER, False),
    (Role.MEMBER, True),
    (Role.SCHEDULER, True),
    (Role.ADMIN, True),
    (Role.OWNER, True),
]
_SCHEDULER_MATRIX = [
    (Role.VIEWER, False),
    (Role.MEMBER, False),
    (Role.SCHEDULER, True),
    (Role.ADMIN, True),
    (Role.OWNER, True),
]
_ADMIN_MATRIX = [
    (Role.VIEWER, False),
    (Role.MEMBER, False),
    (Role.SCHEDULER, False),
    (Role.ADMIN, True),
    (Role.OWNER, True),
]
_OWNER_MATRIX = [
    (Role.VIEWER, False),
    (Role.MEMBER, False),
    (Role.SCHEDULER, False),
    (Role.ADMIN, False),
    (Role.OWNER, True),
]


@pytest.mark.django_db
@pytest.mark.parametrize(("role", "expected"), _WRITE_MATRIX)
def test_member_write_nested_route_role_matrix(
    user: object, project: Project, role: int, expected: bool
) -> None:
    _add_member(user, project, role)
    req = _make_request(user, method="POST")
    assert IsProjectMemberWrite().has_permission(req, _make_view(project_pk=project.pk)) is expected


@pytest.mark.django_db
@pytest.mark.parametrize(("role", "expected"), _SCHEDULER_MATRIX)
def test_project_scheduler_nested_route_role_matrix(
    user: object, project: Project, role: int, expected: bool
) -> None:
    _add_member(user, project, role)
    req = _make_request(user, method="POST")
    assert IsProjectScheduler().has_permission(req, _make_view(project_pk=project.pk)) is expected


@pytest.mark.django_db
@pytest.mark.parametrize(("role", "expected"), _ADMIN_MATRIX)
def test_project_admin_object_role_matrix(
    user: object, project: Project, role: int, expected: bool
) -> None:
    _add_member(user, project, role)
    req = _make_request(user, method="PATCH")
    assert IsProjectAdmin().has_object_permission(req, _make_view(), project) is expected


@pytest.mark.django_db
@pytest.mark.parametrize(("role", "expected"), _OWNER_MATRIX)
def test_project_owner_object_role_matrix(
    user: object, project: Project, role: int, expected: bool
) -> None:
    _add_member(user, project, role)
    req = _make_request(user, method="DELETE")
    assert IsProjectOwner().has_object_permission(req, _make_view(), project) is expected


@pytest.mark.django_db
@pytest.mark.parametrize(("role", "expected"), _SCHEDULER_MATRIX)
def test_can_assign_resource_object_role_matrix(
    user: object, project: Project, role: int, expected: bool
) -> None:
    _add_member(user, project, role)
    req = _make_request(user, method="PATCH")
    assert CanAssignResource().has_object_permission(req, _make_view(), project) is expected


@pytest.mark.django_db
class TestTopLevelRouteFallthrough:
    """Without ``project_pk`` the gate defers to the per-object check (returns True)."""

    def test_scheduler_class_defers(self, user: object) -> None:
        assert IsProjectScheduler().has_permission(_make_request(user), _make_view()) is True

    def test_admin_class_defers(self, user: object) -> None:
        assert IsProjectAdmin().has_permission(_make_request(user), _make_view()) is True

    def test_owner_class_defers(self, user: object) -> None:
        assert IsProjectOwner().has_permission(_make_request(user), _make_view()) is True

    def test_member_write_class_defers(self, user: object) -> None:
        req = _make_request(user, method="POST")
        assert IsProjectMemberWrite().has_permission(req, _make_view()) is True


@pytest.mark.django_db
class TestUnauthenticatedIsAlwaysDenied:
    """Every project gate fails closed for an anonymous caller."""

    @pytest.mark.parametrize(
        "perm_class",
        [
            IsProjectMember,
            IsProjectMemberWrite,
            IsProjectScheduler,
            IsProjectAdmin,
            IsProjectOwner,
            IsProgramMember,
            IsProgramScheduler,
            IsProgramEditor,
            IsProgramAdmin,
            IsProgramOwner,
            IsOrgAdmin,
            IsOrgScheduler,
            IsWorkspaceOperator,
        ],
    )
    def test_anonymous_denied(self, perm_class: type) -> None:
        anon = MagicMock()
        anon.is_authenticated = False
        req = _make_request(anon, method="POST")
        assert perm_class().has_permission(req, _make_view()) is False


@pytest.mark.django_db
class TestObjectChecksFailClosedWithoutProject:
    """An object that resolves to no project is denied by the role gates."""

    @pytest.mark.parametrize(
        "perm_class",
        [
            IsProjectMemberWrite,
            IsProjectMemberWriteOrOwn,
            IsProjectScheduler,
            IsProjectAdmin,
            IsProjectOwner,
            CanAssignResource,
        ],
    )
    def test_unresolvable_object_denied(self, user: object, perm_class: type) -> None:
        req = _make_request(user, method="PATCH")
        assert perm_class().has_object_permission(req, _make_view(), SimpleNamespace()) is False

    def test_member_read_allows_org_level_object(self, user: object, calendar: Calendar) -> None:
        """IsProjectMember is the exception — an org-level Calendar only needs auth."""
        req = _make_request(user)
        assert IsProjectMember().has_object_permission(req, _make_view(), calendar) is True


# ---------------------------------------------------------------------------
# IsProjectMemberWriteOrOwn — the restore action gates like DELETE
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRestoreGatesLikeDelete:
    def test_product_owner_may_edit_story_but_not_restore_it(
        self, user: object, project: Project
    ) -> None:
        """Un-deleting is a delete-class act — the PO grooming facet must not grant it."""
        from trueppm_api.apps.projects.models import TaskType

        story = Task.objects.create(
            project=project, name="S", duration=1, type=TaskType.STORY, assignee=None
        )
        _add_member(user, project, Role.MEMBER)
        _grant_facet(project, user, is_product_owner=True)

        perm = IsProjectMemberWriteOrOwn()
        edit_view = _make_view()
        edit_view.action = "partial_update"
        assert perm.has_object_permission(_make_request(user, "PATCH"), edit_view, story) is True

        restore_view = _make_view()
        restore_view.action = "restore"
        # restore arrives as a POST but must be judged with DELETE semantics.
        assert perm.has_object_permission(_make_request(user, "POST"), restore_view, story) is False

    def test_admin_may_restore(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, Role.ADMIN)
        view = _make_view()
        view.action = "restore"
        assert (
            IsProjectMemberWriteOrOwn().has_object_permission(
                _make_request(user, "POST"), view, task
            )
            is True
        )

    def test_non_member_denied_before_the_write_predicate(
        self, user: object, other_user: object, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=other_user)
        _add_member(user, project, Role.ADMIN)
        assert (
            IsProjectMemberWriteOrOwn().has_object_permission(
                _make_request(other_user, "PATCH"), _make_view(), task
            )
            is False
        )


# ---------------------------------------------------------------------------
# CanLogTime / can_user_log_time — Member+ on the task's project (ADR-0185 §3)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(("role", "expected"), _WRITE_MATRIX)
def test_can_user_log_time_role_matrix(
    user: object, project: Project, role: int, expected: bool
) -> None:
    """A Viewer may not log time; every role from Team Member up may."""
    task = Task.objects.create(project=project, name="T", duration=1)
    _add_member(user, project, role)
    assert can_user_log_time(_make_request(user, "POST"), task) is expected


@pytest.mark.django_db
class TestCanLogTime:
    def test_non_member_denied(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        assert can_user_log_time(_make_request(user, "POST"), task) is False

    def test_unauthenticated_denied(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        anon = MagicMock()
        anon.is_authenticated = False
        assert can_user_log_time(_make_request(anon, "POST"), task) is False

    def test_object_without_project_denied(self, user: object) -> None:
        assert can_user_log_time(_make_request(user, "POST"), SimpleNamespace()) is False

    def test_permission_resolves_task_through_entry_fk(
        self, user: object, project: Project
    ) -> None:
        """A TimeEntry-shaped object is resolved via its ``task`` FK."""
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, Role.MEMBER)
        entry = SimpleNamespace(task=task)
        assert (
            CanLogTime().has_object_permission(_make_request(user, "POST"), _make_view(), entry)
            is True
        )

    def test_permission_denies_object_with_no_task(self, user: object) -> None:
        assert (
            CanLogTime().has_object_permission(
                _make_request(user, "POST"), _make_view(), SimpleNamespace()
            )
            is False
        )

    def test_viewer_may_read_but_not_write(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, Role.VIEWER)
        perm = CanLogTime()
        assert perm.has_object_permission(_make_request(user, "GET"), _make_view(), task) is True
        assert perm.has_object_permission(_make_request(user, "POST"), _make_view(), task) is False

    def test_non_member_denied_on_read(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        perm = CanLogTime()
        assert perm.has_object_permission(_make_request(user, "GET"), _make_view(), task) is False

    def test_has_permission_only_checks_authentication(self, user: object) -> None:
        """The role decision is deliberately object-level so a non-member 404s, not 403s."""
        assert CanLogTime().has_permission(_make_request(user), _make_view()) is True
        anon = MagicMock()
        anon.is_authenticated = False
        assert CanLogTime().has_permission(_make_request(anon), _make_view()) is False


# ---------------------------------------------------------------------------
# IsTaskScopeManager — Admin+ OR the SM / PO facet, resolved through obj.task
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsTaskScopeManager:
    def test_has_permission_requires_only_authentication(self, user: object) -> None:
        assert IsTaskScopeManager().has_permission(_make_request(user), _make_view()) is True

    def test_has_permission_denies_anonymous(self) -> None:
        anon = MagicMock()
        anon.is_authenticated = False
        assert IsTaskScopeManager().has_permission(_make_request(anon), _make_view()) is False

    def test_object_without_task_denied(self, user: object) -> None:
        assert (
            IsTaskScopeManager().has_object_permission(
                _make_request(user, "POST"), _make_view(), SimpleNamespace(task=None)
            )
            is False
        )

    @pytest.mark.parametrize(("role", "expected"), _ADMIN_MATRIX)
    def test_role_matrix_through_task_fk(
        self, user: object, project: Project, role: int, expected: bool
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, role)
        conflict = SimpleNamespace(task=task)
        assert (
            IsTaskScopeManager().has_object_permission(
                _make_request(user, "POST"), _make_view(), conflict
            )
            is expected
        )

    @pytest.mark.parametrize("facet", ["is_scrum_master", "is_product_owner"])
    def test_facet_grants_without_admin_role(
        self, user: object, project: Project, facet: str
    ) -> None:
        """Both ceremony facets widen the gate without an Admin role bump (ADR-0123 §3)."""
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, Role.MEMBER)
        _grant_facet(project, user, **{facet: True})
        assert (
            IsTaskScopeManager().has_object_permission(
                _make_request(user, "POST"), _make_view(), SimpleNamespace(task=task)
            )
            is True
        )

    def test_facet_on_another_project_does_not_grant(
        self, user: object, project: Project, calendar: Calendar
    ) -> None:
        """The facet is project-scoped — holding it elsewhere grants nothing here."""
        other = Project.objects.create(name="Other", start_date=date(2026, 1, 1), calendar=calendar)
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, Role.MEMBER)
        _grant_facet(other, user, is_product_owner=True)
        assert (
            IsTaskScopeManager().has_object_permission(
                _make_request(user, "POST"), _make_view(), SimpleNamespace(task=task)
            )
            is False
        )


# ---------------------------------------------------------------------------
# Program gates (ADR-0070) — five-role matrices
# ---------------------------------------------------------------------------


def _add_program_member(who: object, program: Program, role: int) -> ProgramMembership:
    return ProgramMembership.objects.create(program=program, user=who, role=role)


def _program_view(program_pk: object | None = None) -> MagicMock:
    view = MagicMock()
    view.kwargs = {"program_pk": str(program_pk)} if program_pk is not None else {}
    return view


@pytest.mark.django_db
class TestProgramGates:
    def test_member_gate_admits_viewer(self, user: object, program: Program) -> None:
        _add_program_member(user, program, Role.VIEWER)
        req = _make_request(user)
        assert IsProgramMember().has_permission(req, _program_view(program.pk)) is True
        assert IsProgramMember().has_object_permission(req, _program_view(), program) is True

    def test_member_gate_denies_non_member(
        self, user: object, other_user: object, program: Program
    ) -> None:
        _add_program_member(user, program, Role.OWNER)
        req = _make_request(other_user)
        assert IsProgramMember().has_permission(req, _program_view(program.pk)) is False
        assert IsProgramMember().has_object_permission(req, _program_view(), program) is False

    def test_member_gate_defers_on_top_level_route(self, user: object) -> None:
        assert IsProgramMember().has_permission(_make_request(user), _program_view()) is True

    @pytest.mark.parametrize(("role", "expected"), _SCHEDULER_MATRIX)
    def test_scheduler_gate_matrix_on_reads(
        self, user: object, program: Program, role: int, expected: bool
    ) -> None:
        """Program scheduler data is Scheduler+ even on GET — a Viewer is denied."""
        _add_program_member(user, program, role)
        req = _make_request(user, method="GET")
        assert IsProgramScheduler().has_permission(req, _program_view(program.pk)) is expected
        assert IsProgramScheduler().has_object_permission(req, _program_view(), program) is expected

    @pytest.mark.parametrize(("role", "expected"), _WRITE_MATRIX)
    def test_editor_gate_matrix_on_writes(
        self, user: object, program: Program, role: int, expected: bool
    ) -> None:
        _add_program_member(user, program, role)
        req = _make_request(user, method="POST")
        assert IsProgramEditor().has_permission(req, _program_view(program.pk)) is expected
        assert IsProgramEditor().has_object_permission(req, _program_view(), program) is expected

    def test_editor_gate_opens_reads_to_viewer(self, user: object, program: Program) -> None:
        _add_program_member(user, program, Role.VIEWER)
        req = _make_request(user, method="GET")
        assert IsProgramEditor().has_permission(req, _program_view(program.pk)) is True
        assert IsProgramEditor().has_object_permission(req, _program_view(), program) is True

    def test_editor_gate_denies_non_member(self, user: object, program: Program) -> None:
        req = _make_request(user, method="GET")
        assert IsProgramEditor().has_permission(req, _program_view(program.pk)) is False
        assert IsProgramEditor().has_object_permission(req, _program_view(), program) is False

    @pytest.mark.parametrize(("role", "expected"), _ADMIN_MATRIX)
    def test_admin_gate_matrix(
        self, user: object, program: Program, role: int, expected: bool
    ) -> None:
        _add_program_member(user, program, role)
        req = _make_request(user, method="PATCH")
        assert IsProgramAdmin().has_permission(req, _program_view(program.pk)) is expected
        assert IsProgramAdmin().has_object_permission(req, _program_view(), program) is expected

    @pytest.mark.parametrize(("role", "expected"), _OWNER_MATRIX)
    def test_owner_gate_matrix(
        self, user: object, program: Program, role: int, expected: bool
    ) -> None:
        _add_program_member(user, program, role)
        req = _make_request(user, method="DELETE")
        assert IsProgramOwner().has_permission(req, _program_view(program.pk)) is expected
        assert IsProgramOwner().has_object_permission(req, _program_view(), program) is expected

    @pytest.mark.parametrize(
        "perm_class", [IsProgramScheduler, IsProgramEditor, IsProgramAdmin, IsProgramOwner]
    )
    def test_object_without_program_denied(self, user: object, perm_class: type) -> None:
        req = _make_request(user, method="POST")
        assert perm_class().has_object_permission(req, _program_view(), SimpleNamespace()) is False

    @pytest.mark.parametrize(
        "perm_class", [IsProgramScheduler, IsProgramEditor, IsProgramAdmin, IsProgramOwner]
    )
    def test_top_level_route_defers(self, user: object, perm_class: type) -> None:
        req = _make_request(user, method="POST")
        assert perm_class().has_permission(req, _program_view()) is True

    def test_soft_deleted_program_membership_grants_nothing(
        self, user: object, program: Program
    ) -> None:
        membership = _add_program_member(user, program, Role.OWNER)
        membership.soft_delete()
        req = _make_request(user)
        assert IsProgramMember().has_object_permission(req, _program_view(), program) is False


# ---------------------------------------------------------------------------
# effective_project_role / effective_program_role — the public lookups
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestEffectiveRoleLookups:
    def test_project_role_returned_for_member(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.SCHEDULER)
        assert effective_project_role(_make_request(user), project.pk) == Role.SCHEDULER

    def test_project_role_none_for_non_member(self, user: object, project: Project) -> None:
        assert effective_project_role(_make_request(user), project.pk) is None

    def test_program_role_returned_for_member(self, user: object, program: Program) -> None:
        _add_program_member(user, program, Role.ADMIN)
        assert effective_program_role(_make_request(user), program.pk) == Role.ADMIN

    def test_program_role_none_for_non_member(self, user: object, program: Program) -> None:
        assert effective_program_role(_make_request(user), program.pk) is None

    def test_program_role_none_for_anonymous(self, program: Program) -> None:
        anon = MagicMock()
        anon.is_authenticated = False
        assert effective_program_role(_make_request(anon), program.pk) is None

    def test_role_is_cached_on_the_request(self, user: object, project: Project) -> None:
        """The second lookup is served from the per-request cache, not the DB."""
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        _add_member(user, project, Role.ADMIN)
        req = _plain_request(user)
        assert effective_project_role(req, project.pk) == Role.ADMIN
        with CaptureQueriesContext(connection) as ctx:
            assert effective_project_role(req, project.pk) == Role.ADMIN
        assert len(ctx.captured_queries) == 0


# ---------------------------------------------------------------------------
# Lifecycle gates — archived projects and closed programs are read-only (#530)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsProjectNotArchived:
    def test_read_always_allowed(self, user: object, project: Project) -> None:
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        perm = IsProjectNotArchived()
        req = _plain_request(user, method="GET")
        view = _make_view(project_pk=project.pk)
        view.action = "list"
        assert perm.has_permission(req, view) is True
        assert perm.has_object_permission(req, view, project) is True

    def test_write_blocked_on_nested_route_of_archived_project(
        self, user: object, project: Project
    ) -> None:
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        view = _make_view(project_pk=project.pk)
        view.action = "create"
        assert IsProjectNotArchived().has_permission(_plain_request(user, "POST"), view) is False

    def test_write_allowed_on_nested_route_of_live_project(
        self, user: object, project: Project
    ) -> None:
        view = _make_view(project_pk=project.pk)
        view.action = "create"
        assert IsProjectNotArchived().has_permission(_plain_request(user, "POST"), view) is True

    @pytest.mark.parametrize("action", ["unarchive", "destroy", "archive", "restore"])
    def test_bypass_actions_pass_even_when_archived(
        self, user: object, project: Project, action: str
    ) -> None:
        """Without the bypass an Owner could never unarchive — a catch-22."""
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        view = _make_view(project_pk=project.pk)
        view.action = action
        perm = IsProjectNotArchived()
        req = _plain_request(user, method="POST")
        assert perm.has_permission(req, view) is True
        assert perm.has_object_permission(req, view, project) is True

    def test_top_level_route_defers_to_object_check(self, user: object) -> None:
        view = _make_view()
        view.action = "create"
        assert IsProjectNotArchived().has_permission(_plain_request(user, "POST"), view) is True

    def test_object_check_reads_the_in_memory_project_flag(
        self, user: object, project: Project
    ) -> None:
        """A direct Project object is judged on its own flag, not a re-query."""
        view = _make_view()
        view.action = "partial_update"
        req = _plain_request(user, method="PATCH")
        perm = IsProjectNotArchived()
        assert perm.has_object_permission(req, view, project) is True
        project.is_archived = True
        assert perm.has_object_permission(req, view, project) is False

    def test_object_check_on_child_row_of_archived_project(
        self, user: object, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        project.is_archived = True
        project.save(update_fields=["is_archived"])
        view = _make_view()
        view.action = "partial_update"
        assert (
            IsProjectNotArchived().has_object_permission(_plain_request(user, "PATCH"), view, task)
            is False
        )

    def test_object_with_no_project_is_not_lifecycle_gated(self, user: object) -> None:
        view = _make_view()
        view.action = "partial_update"
        assert (
            IsProjectNotArchived().has_object_permission(
                _plain_request(user, "PATCH"), view, SimpleNamespace()
            )
            is True
        )


@pytest.mark.django_db
class TestIsProgramNotClosed:
    def test_read_always_allowed(self, user: object, program: Program) -> None:
        program.is_closed = True
        program.save(update_fields=["is_closed"])
        view = _program_view(program.pk)
        view.action = "list"
        perm = IsProgramNotClosed()
        req = _plain_request(user, method="GET")
        assert perm.has_permission(req, view) is True
        assert perm.has_object_permission(req, view, program) is True

    def test_write_blocked_on_nested_route_of_closed_program(
        self, user: object, program: Program
    ) -> None:
        program.is_closed = True
        program.save(update_fields=["is_closed"])
        view = _program_view(program.pk)
        view.action = "create"
        assert IsProgramNotClosed().has_permission(_plain_request(user, "POST"), view) is False

    def test_write_allowed_on_nested_route_of_open_program(
        self, user: object, program: Program
    ) -> None:
        view = _program_view(program.pk)
        view.action = "create"
        assert IsProgramNotClosed().has_permission(_plain_request(user, "POST"), view) is True

    @pytest.mark.parametrize("action", ["reopen", "destroy", "close", "remove_sample"])
    def test_bypass_actions_pass_even_when_closed(
        self, user: object, program: Program, action: str
    ) -> None:
        program.is_closed = True
        program.save(update_fields=["is_closed"])
        view = _program_view(program.pk)
        view.action = action
        perm = IsProgramNotClosed()
        req = _plain_request(user, method="POST")
        assert perm.has_permission(req, view) is True
        assert perm.has_object_permission(req, view, program) is True

    def test_top_level_route_defers(self, user: object) -> None:
        view = _program_view()
        view.action = "create"
        assert IsProgramNotClosed().has_permission(_plain_request(user, "POST"), view) is True

    def test_object_check_reads_the_in_memory_program_flag(
        self, user: object, program: Program
    ) -> None:
        view = _program_view()
        view.action = "partial_update"
        req = _plain_request(user, method="PATCH")
        perm = IsProgramNotClosed()
        assert perm.has_object_permission(req, view, program) is True
        program.is_closed = True
        assert perm.has_object_permission(req, view, program) is False

    def test_object_check_on_child_row_of_closed_program(
        self, user: object, program: Program, calendar: Calendar
    ) -> None:
        program.is_closed = True
        program.save(update_fields=["is_closed"])
        child = Project.objects.create(
            name="Child", start_date=date(2026, 1, 1), calendar=calendar, program=program
        )
        view = _program_view()
        view.action = "partial_update"
        assert (
            IsProgramNotClosed().has_object_permission(_plain_request(user, "PATCH"), view, child)
            is False
        )

    def test_object_with_no_program_is_not_lifecycle_gated(self, user: object) -> None:
        view = _program_view()
        view.action = "partial_update"
        assert (
            IsProgramNotClosed().has_object_permission(
                _plain_request(user, "PATCH"), view, SimpleNamespace()
            )
            is True
        )


# ---------------------------------------------------------------------------
# Org-level gates — authority derived from project membership
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestOrgGates:
    @pytest.mark.parametrize(("role", "expected"), _SCHEDULER_MATRIX)
    def test_org_scheduler_matrix(
        self, user: object, project: Project, role: int, expected: bool
    ) -> None:
        _add_member(user, project, role)
        assert (
            IsOrgScheduler().has_permission(_make_request(user, "POST"), _make_view()) is expected
        )

    @pytest.mark.parametrize(("role", "expected"), _ADMIN_MATRIX)
    def test_org_admin_matrix(
        self, user: object, project: Project, role: int, expected: bool
    ) -> None:
        _add_member(user, project, role)
        assert IsOrgAdmin().has_permission(_make_request(user, "POST"), _make_view()) is expected

    def test_org_gates_ignore_soft_deleted_membership(self, user: object, project: Project) -> None:
        membership = _add_member(user, project, Role.OWNER)
        membership.soft_delete()
        req = _make_request(user, method="POST")
        assert IsOrgAdmin().has_permission(req, _make_view()) is False
        assert IsOrgScheduler().has_permission(req, _make_view()) is False

    def test_superuser_bypasses_membership(self, db: object) -> None:
        root = User.objects.create_superuser(username="root", password="pw")
        req = _make_request(root, method="POST")
        assert IsOrgAdmin().has_permission(req, _make_view()) is True
        assert IsOrgScheduler().has_permission(req, _make_view()) is True

    def test_workspace_operator_requires_superuser(
        self, user: object, project: Project, db: object
    ) -> None:
        """An Owner on every project is still not the install operator (ADR-0213 C1)."""
        _add_member(user, project, Role.OWNER)
        assert IsWorkspaceOperator().has_permission(_make_request(user), _make_view()) is False
        root = User.objects.create_superuser(username="operator", password="pw")
        assert IsWorkspaceOperator().has_permission(_make_request(root), _make_view()) is True


# ---------------------------------------------------------------------------
# API-token scope factory
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTokenHasScope:
    def _token(self, user: object, project: Project, scopes: list[str]) -> object:
        import secrets

        from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
        from trueppm_api.apps.projects.models import ProjectApiToken

        raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
        return ProjectApiToken.objects.create(
            project=project,
            name="t",
            token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
            token_hash=sha256_hex(raw),
            created_by=user,
            scopes=scopes,
        )

    def test_non_token_auth_passes(self, user: object) -> None:
        req = _make_request(user)
        req.auth = None
        assert TokenHasScope("mcp:read")().has_permission(req, _make_view()) is True

    def test_token_with_the_scope_passes(self, user: object, project: Project) -> None:
        req = _make_request(user)
        req.auth = self._token(user, project, ["mcp:read"])
        assert TokenHasScope("mcp:read")().has_permission(req, _make_view()) is True

    def test_token_without_the_scope_denied(self, user: object, project: Project) -> None:
        req = _make_request(user)
        req.auth = self._token(user, project, ["something:else"])
        assert TokenHasScope("mcp:read")().has_permission(req, _make_view()) is False

    def test_legacy_full_satisfies_a_read_scope(self, user: object, project: Project) -> None:
        from trueppm_api.apps.projects.models import SCOPE_LEGACY_FULL

        req = _make_request(user)
        req.auth = self._token(user, project, [SCOPE_LEGACY_FULL])
        assert TokenHasScope("mcp:read")().has_permission(req, _make_view()) is True

    def test_legacy_full_does_not_satisfy_itself_by_substitution(
        self, user: object, project: Project
    ) -> None:
        """When ``legacy:full`` is the *required* scope it must be listed explicitly."""
        from trueppm_api.apps.projects.models import SCOPE_LEGACY_FULL

        req = _make_request(user)
        req.auth = self._token(user, project, ["mcp:read"])
        assert TokenHasScope(SCOPE_LEGACY_FULL)().has_permission(req, _make_view()) is False

    def test_factory_names_the_generated_class(self) -> None:
        assert TokenHasScope("mcp:read").__name__ == "TokenHasScope[mcp:read]"


# ---------------------------------------------------------------------------
# MCP audit helpers
# ---------------------------------------------------------------------------


class TestMcpClientIp:
    def test_prefers_leftmost_forwarded_hop(self) -> None:
        req = SimpleNamespace(
            META={"HTTP_X_FORWARDED_FOR": "203.0.113.9, 10.0.0.1", "REMOTE_ADDR": "10.0.0.1"}
        )
        assert _mcp_client_ip(req) == "203.0.113.9"

    def test_falls_back_to_remote_addr(self) -> None:
        req = SimpleNamespace(META={"REMOTE_ADDR": "198.51.100.4"})
        assert _mcp_client_ip(req) == "198.51.100.4"

    def test_none_when_no_source_is_available(self) -> None:
        assert _mcp_client_ip(SimpleNamespace(META={})) is None

    def test_blank_forwarded_hop_yields_none(self) -> None:
        req = SimpleNamespace(META={"HTTP_X_FORWARDED_FOR": " , 10.0.0.1"})
        assert _mcp_client_ip(req) is None


class TestAgentSpanAttributes:
    def test_records_the_agent_facets_on_the_current_span(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from opentelemetry import trace

        from trueppm_api.apps.observability.otel import attributes as attrs

        recorded: dict[str, object] = {}

        class _Span:
            def set_attribute(self, key: str, value: object) -> None:
                recorded[key] = value

        monkeypatch.setattr(trace, "get_current_span", lambda: _Span())
        _set_agent_span_attributes(SimpleNamespace(token_prefix="tppm_abc"), "allowed")
        assert recorded[attrs.AGENT_TOKEN_PREFIX] == "tppm_abc"
        assert recorded[attrs.AGENT_CAPABILITY] == "mcp:read"
        assert recorded[attrs.AGENT_ACTOR_KIND] == "mcp_token"
        assert recorded[attrs.AGENT_VERDICT] == "allowed"

    def test_exporter_failure_never_breaks_the_read(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Telemetry is best-effort — a raising span is swallowed, not propagated."""
        from opentelemetry import trace

        class _BrokenSpan:
            def set_attribute(self, key: str, value: object) -> None:
                raise RuntimeError("exporter down")

        monkeypatch.setattr(trace, "get_current_span", lambda: _BrokenSpan())
        assert (
            _set_agent_span_attributes(SimpleNamespace(token_prefix="tppm_abc"), "refused") is None
        )

    def test_missing_span_is_a_no_op(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from opentelemetry import trace

        monkeypatch.setattr(trace, "get_current_span", lambda: None)
        assert _set_agent_span_attributes(SimpleNamespace(token_prefix="x"), "allowed") is None


# ---------------------------------------------------------------------------
# ProjectScopedViewSet.get_queryset — the IDOR floor
# ---------------------------------------------------------------------------


def _scoped_viewset(model_queryset: object, request: object) -> ProjectScopedViewSet:
    class _Scoped(ProjectScopedViewSet):
        queryset = model_queryset

    view = _Scoped()
    view.request = request  # type: ignore[assignment]
    return view


@pytest.mark.django_db
class TestProjectScopedViewSet:
    def test_anonymous_sees_nothing(self, project: Project) -> None:
        Task.objects.create(project=project, name="T", duration=1)
        anon = MagicMock()
        anon.is_authenticated = False
        view = _scoped_viewset(Task.objects.all(), SimpleNamespace(user=anon))
        assert view.get_queryset().count() == 0

    def test_missing_user_sees_nothing(self, project: Project) -> None:
        Task.objects.create(project=project, name="T", duration=1)
        view = _scoped_viewset(Task.objects.all(), SimpleNamespace(user=None))
        assert view.get_queryset().count() == 0

    def test_tasks_are_scoped_to_member_projects(
        self, user: object, other_user: object, project: Project, calendar: Calendar
    ) -> None:
        mine = Task.objects.create(project=project, name="Mine", duration=1)
        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 1, 1), calendar=calendar
        )
        Task.objects.create(project=other_project, name="Theirs", duration=1)
        _add_member(user, project, Role.VIEWER)
        _add_member(other_user, other_project, Role.OWNER)

        view = _scoped_viewset(Task.objects.all(), SimpleNamespace(user=user))
        assert list(view.get_queryset().values_list("pk", flat=True)) == [mine.pk]

    def test_dependencies_are_scoped_through_the_predecessor(
        self, user: object, project: Project, calendar: Calendar
    ) -> None:
        a = Task.objects.create(project=project, name="A", duration=1)
        b = Task.objects.create(project=project, name="B", duration=1)
        mine = Dependency.objects.create(predecessor=a, successor=b, dep_type="FS")

        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 1, 1), calendar=calendar
        )
        c = Task.objects.create(project=other_project, name="C", duration=1)
        d = Task.objects.create(project=other_project, name="D", duration=1)
        Dependency.objects.create(predecessor=c, successor=d, dep_type="FS")

        _add_member(user, project, Role.VIEWER)
        view = _scoped_viewset(Dependency.objects.all(), SimpleNamespace(user=user))
        assert list(view.get_queryset().values_list("pk", flat=True)) == [mine.pk]

    def test_projects_are_scoped_by_pk_and_exclude_soft_deleted(
        self, user: object, project: Project, calendar: Calendar
    ) -> None:
        """A soft-deleted project must not stay reachable via a surviving membership."""
        gone = Project.objects.create(name="Gone", start_date=date(2026, 1, 1), calendar=calendar)
        _add_member(user, project, Role.OWNER)
        _add_member(user, gone, Role.OWNER)
        gone.soft_delete()

        view = _scoped_viewset(Project.objects.all(), SimpleNamespace(user=user))
        assert list(view.get_queryset().values_list("pk", flat=True)) == [project.pk]

    def test_soft_deleted_membership_removes_access(self, user: object, project: Project) -> None:
        Task.objects.create(project=project, name="T", duration=1)
        membership = _add_member(user, project, Role.OWNER)
        membership.soft_delete()
        view = _scoped_viewset(Task.objects.all(), SimpleNamespace(user=user))
        assert view.get_queryset().count() == 0

    def test_org_level_model_falls_through_unfiltered(
        self, user: object, calendar: Calendar
    ) -> None:
        """Calendars are org-shared — scoping them is documented as intentional (M2)."""
        view = _scoped_viewset(Calendar.objects.all(), SimpleNamespace(user=user))
        assert calendar.pk in set(view.get_queryset().values_list("pk", flat=True))


# ---------------------------------------------------------------------------
# Role / facet lookups — anonymous callers and the per-request caches
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRoleLookupInternals:
    def test_project_role_is_none_for_anonymous(self, project: Project) -> None:
        anon = MagicMock()
        anon.is_authenticated = False
        assert effective_project_role(_plain_request(anon), project.pk) is None

    def test_project_role_is_none_without_a_user(self, project: Project) -> None:
        assert effective_project_role(_plain_request(None), project.pk) is None

    def test_program_role_lookup_is_request_cached(self, user: object, program: Program) -> None:
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        _add_program_member(user, program, Role.SCHEDULER)
        req = _plain_request(user)
        assert effective_program_role(req, program.pk) == Role.SCHEDULER
        with CaptureQueriesContext(connection) as ctx:
            assert effective_program_role(req, program.pk) == Role.SCHEDULER
        assert ctx.captured_queries == []

    def test_product_owner_facet_lookup_is_request_cached(
        self, user: object, project: Project
    ) -> None:
        """A PO grooming a large backlog must not pay one facet query per row."""
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from trueppm_api.apps.projects.models import TaskType

        story = Task.objects.create(
            project=project, name="S", duration=1, type=TaskType.STORY, assignee=None
        )
        _add_member(user, project, Role.MEMBER)
        _grant_facet(project, user, is_product_owner=True)

        req = _plain_request(user, "PATCH")
        assert can_user_edit_task(req, story, method="PATCH") is True
        with CaptureQueriesContext(connection) as ctx:
            assert can_user_edit_task(req, story, method="PATCH") is True
        assert ctx.captured_queries == []


# ---------------------------------------------------------------------------
# can_user_edit_task — the fail-closed guards ahead of the role matrix
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCanUserEditTaskGuards:
    def test_anonymous_denied(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        anon = MagicMock()
        anon.is_authenticated = False
        assert can_user_edit_task(_make_request(anon, "PATCH"), task) is False

    def test_object_without_project_denied(self, user: object) -> None:
        assert can_user_edit_task(_make_request(user, "PATCH"), SimpleNamespace()) is False

    def test_non_member_denied(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=user)
        assert can_user_edit_task(_make_request(user, "PATCH"), task) is False


# ---------------------------------------------------------------------------
# Remaining has_permission branches
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMiscHasPermissionBranches:
    def test_member_write_allows_safe_method_for_viewer_on_nested_route(
        self, user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.VIEWER)
        req = _make_request(user, method="GET")
        assert IsProjectMemberWrite().has_permission(req, _make_view(project_pk=project.pk)) is True

    def test_write_or_own_has_permission_only_checks_authentication(self, user: object) -> None:
        """The assignee decision is object-level; the view gate is auth-only."""
        assert (
            IsProjectMemberWriteOrOwn().has_permission(_make_request(user, "PATCH"), _make_view())
            is True
        )
        anon = MagicMock()
        anon.is_authenticated = False
        assert (
            IsProjectMemberWriteOrOwn().has_permission(_make_request(anon, "PATCH"), _make_view())
            is False
        )

    def test_program_member_object_check_denies_unresolvable_object(self, user: object) -> None:
        assert (
            IsProgramMember().has_object_permission(
                _make_request(user), _program_view(), SimpleNamespace()
            )
            is False
        )


# ---------------------------------------------------------------------------
# Backlog management — Admin+ OR the Product Owner facet (ADR-0105 / ADR-0078)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBacklogGate:
    @pytest.mark.parametrize(("role", "expected"), _ADMIN_MATRIX)
    def test_role_half_of_the_gate(self, role: int, expected: bool) -> None:
        assert can_manage_backlog(role) is expected

    def test_role_half_denies_non_member(self) -> None:
        assert can_manage_backlog(None) is False

    def test_facet_grants_without_admin_role(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.MEMBER)
        _grant_facet(project, user, is_product_owner=True)
        assert can_manage_backlog_with_facet(user, project.pk, Role.MEMBER) is True

    def test_scrum_master_facet_does_not_grant_backlog(
        self, user: object, project: Project
    ) -> None:
        """Only the Product Owner facet widens the backlog gate — not the SM facet."""
        _add_member(user, project, Role.MEMBER)
        _grant_facet(project, user, is_scrum_master=True)
        assert can_manage_backlog_with_facet(user, project.pk, Role.MEMBER) is False

    def test_admin_grants_without_any_facet(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.ADMIN)
        assert can_manage_backlog_with_facet(user, project.pk, Role.ADMIN) is True

    @pytest.mark.parametrize(("role", "expected"), _ADMIN_MATRIX)
    def test_permission_class_nested_route_matrix(
        self, user: object, project: Project, role: int, expected: bool
    ) -> None:
        _add_member(user, project, role)
        req = _make_request(user, method="POST")
        assert (
            IsProjectBacklogManager().has_permission(req, _make_view(project_pk=project.pk))
            is expected
        )

    def test_permission_class_admits_the_facet_holder(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.MEMBER)
        _grant_facet(project, user, is_product_owner=True)
        req = _make_request(user, method="POST")
        assert (
            IsProjectBacklogManager().has_permission(req, _make_view(project_pk=project.pk)) is True
        )

    def test_permission_class_defers_on_top_level_route(self, user: object) -> None:
        req = _make_request(user, method="POST")
        assert IsProjectBacklogManager().has_permission(req, _make_view()) is True

    def test_permission_class_denies_anonymous(self) -> None:
        anon = MagicMock()
        anon.is_authenticated = False
        assert (
            IsProjectBacklogManager().has_permission(_make_request(anon, "POST"), _make_view())
            is False
        )

    def test_object_check_matrix(self, user: object, project: Project) -> None:
        req = _make_request(user, method="POST")
        perm = IsProjectBacklogManager()
        assert perm.has_object_permission(req, _make_view(), SimpleNamespace()) is False
        _add_member(user, project, Role.ADMIN)
        assert perm.has_object_permission(req, _make_view(), project) is True

    def test_object_check_denies_plain_member(self, user: object, project: Project) -> None:
        _add_member(user, project, Role.MEMBER)
        assert (
            IsProjectBacklogManager().has_object_permission(
                _make_request(user, "POST"), _make_view(), project
            )
            is False
        )


# ---------------------------------------------------------------------------
# Sprint scope gate — Admin+ OR the Scrum Master / Product Owner facet
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestScopeGate:
    @pytest.mark.parametrize(("role", "expected"), _ADMIN_MATRIX)
    def test_role_half_of_the_gate(
        self, user: object, project: Project, role: int, expected: bool
    ) -> None:
        _add_member(user, project, role)
        assert can_manage_scope_with_facet(user, project.pk, role) is expected

    @pytest.mark.parametrize("facet", ["is_scrum_master", "is_product_owner"])
    def test_either_ceremony_facet_grants(self, user: object, project: Project, facet: str) -> None:
        _add_member(user, project, Role.MEMBER)
        _grant_facet(project, user, **{facet: True})
        assert can_manage_scope_with_facet(user, project.pk, Role.MEMBER) is True

    def test_org_principal_without_membership_or_facet_denied(
        self, user: object, project: Project
    ) -> None:
        """The ADR-0102 §3 back door stays shut: no project membership, no facet, no gate."""
        assert can_manage_scope_with_facet(user, project.pk, None) is False

    @pytest.mark.parametrize(("role", "expected"), _ADMIN_MATRIX)
    def test_permission_class_nested_route_matrix(
        self, user: object, project: Project, role: int, expected: bool
    ) -> None:
        _add_member(user, project, role)
        req = _make_request(user, method="POST")
        assert (
            IsProjectScopeManager().has_permission(req, _make_view(project_pk=project.pk))
            is expected
        )

    def test_permission_class_defers_on_top_level_route(self, user: object) -> None:
        assert (
            IsProjectScopeManager().has_permission(_make_request(user, "POST"), _make_view())
            is True
        )

    def test_permission_class_denies_anonymous(self) -> None:
        anon = MagicMock()
        anon.is_authenticated = False
        assert (
            IsProjectScopeManager().has_permission(_make_request(anon, "POST"), _make_view())
            is False
        )

    def test_object_check_denies_unresolvable_object(self, user: object) -> None:
        assert (
            IsProjectScopeManager().has_object_permission(
                _make_request(user, "POST"), _make_view(), SimpleNamespace()
            )
            is False
        )

    def test_object_check_admits_admin_and_denies_member(
        self, user: object, other_user: object, project: Project
    ) -> None:
        _add_member(user, project, Role.ADMIN)
        _add_member(other_user, project, Role.MEMBER)
        perm = IsProjectScopeManager()
        assert (
            perm.has_object_permission(_make_request(user, "POST"), _make_view(), project) is True
        )
        assert (
            perm.has_object_permission(_make_request(other_user, "POST"), _make_view(), project)
            is False
        )


# ---------------------------------------------------------------------------
# IsTokenForProject — scoped-token authorization
# ---------------------------------------------------------------------------


def _mint_token(user: object, **kwargs: Any) -> Any:
    import secrets

    from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
    from trueppm_api.apps.projects.models import ProjectApiToken

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    return ProjectApiToken.objects.create(
        name="t",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=user,
        **kwargs,
    )


@pytest.mark.django_db
class TestIsTokenForProjectScopes:
    def test_project_token_authorizes_its_own_project(self, user: object, project: Project) -> None:
        req = _make_request(user, method="POST")
        req.auth = _mint_token(user, project=project)
        view = MagicMock()
        view.kwargs = {"pk": str(project.pk)}
        assert IsTokenForProject().has_permission(req, view) is True

    def test_project_token_rejects_another_project(
        self, user: object, project: Project, calendar: Calendar
    ) -> None:
        from rest_framework.exceptions import AuthenticationFailed

        other = Project.objects.create(name="Other", start_date=date(2026, 1, 1), calendar=calendar)
        req = _make_request(user, method="POST")
        req.auth = _mint_token(user, project=project)
        view = MagicMock()
        view.kwargs = {"pk": str(other.pk)}
        with pytest.raises(AuthenticationFailed):
            IsTokenForProject().has_permission(req, view)

    def test_program_token_authorizes_a_member_project(
        self, user: object, program: Program, calendar: Calendar
    ) -> None:
        member_project = Project.objects.create(
            name="In program",
            start_date=date(2026, 1, 1),
            calendar=calendar,
            program=program,
        )
        req = _make_request(user, method="POST")
        req.auth = _mint_token(user, program=program)
        view = MagicMock()
        view.kwargs = {"project_pk": str(member_project.pk)}
        assert IsTokenForProject().has_permission(req, view) is True

    def test_program_token_rejects_a_project_outside_the_program(
        self, user: object, program: Program, project: Project
    ) -> None:
        from rest_framework.exceptions import AuthenticationFailed

        req = _make_request(user, method="POST")
        req.auth = _mint_token(user, program=program)
        view = MagicMock()
        view.kwargs = {"project_pk": str(project.pk)}
        with pytest.raises(AuthenticationFailed):
            IsTokenForProject().has_permission(req, view)

    def test_program_token_rejects_a_soft_deleted_member_project(
        self, user: object, program: Program, calendar: Calendar
    ) -> None:
        """Removing a project from the program must revoke the token's reach."""
        from rest_framework.exceptions import AuthenticationFailed

        gone = Project.objects.create(
            name="Removed", start_date=date(2026, 1, 1), calendar=calendar, program=program
        )
        gone.soft_delete()
        req = _make_request(user, method="POST")
        req.auth = _mint_token(user, program=program)
        view = MagicMock()
        view.kwargs = {"project_pk": str(gone.pk)}
        with pytest.raises(AuthenticationFailed):
            IsTokenForProject().has_permission(req, view)

    def test_unscoped_personal_token_is_rejected_on_the_write_path(
        self, user: object, project: Project
    ) -> None:
        """A personal token carries no project/program scope — it cannot write here."""
        from rest_framework.exceptions import AuthenticationFailed

        req = _make_request(user, method="POST")
        req.auth = _mint_token(user, owner=user)
        view = MagicMock()
        view.kwargs = {"pk": str(project.pk)}
        with pytest.raises(AuthenticationFailed):
            IsTokenForProject().has_permission(req, view)


# ---------------------------------------------------------------------------
# MCP token guards — read-only methods and owner-scoped tokens
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMcpTokenGuards:
    def test_read_only_methods_pass_for_a_token(self, user: object, project: Project) -> None:
        from trueppm_api.apps.access.permissions import TokenReadOnlyMethods

        req = _make_request(user, method="GET")
        req.auth = _mint_token(user, project=project)
        assert TokenReadOnlyMethods().has_permission(req, _make_view()) is True

    def test_write_methods_are_blocked_for_an_agent_token(
        self, user: object, project: Project
    ) -> None:
        from trueppm_api.apps.access.permissions import TokenReadOnlyMethods
        from trueppm_api.apps.projects.models import SCOPE_MCP_READ

        req = _make_request(user, method="POST")
        req.auth = _mint_token(user, project=project, scopes=[SCOPE_MCP_READ])
        assert TokenReadOnlyMethods().has_permission(req, _make_view()) is False

    def test_write_methods_pass_for_a_full_access_token(
        self, user: object, project: Project
    ) -> None:
        """#2877: a ``legacy:full`` token is the owner's own credential, not an agent.

        ``_mint_token`` takes the model default (``[legacy:full]``), which is what this
        assertion turns on — the guard used to refuse it purely for being an
        ``ApiToken``, which 403'd every PAT write across the core CRUD API. The view's
        RBAC classes, not this guard, are what bound it now.
        """
        from trueppm_api.apps.access.permissions import TokenReadOnlyMethods

        req = _make_request(user, method="POST")
        req.auth = _mint_token(user, project=project)
        assert TokenReadOnlyMethods().has_permission(req, _make_view()) is True

    def test_human_write_is_unaffected(self, user: object) -> None:
        from trueppm_api.apps.access.permissions import TokenReadOnlyMethods

        req = _make_request(user, method="POST")
        req.auth = None
        assert TokenReadOnlyMethods().has_permission(req, _make_view()) is True

    def test_owner_scoped_token_reaches_the_mcp_surface(self, user: object) -> None:
        from trueppm_api.apps.access.permissions import TokenIsOwnerScoped

        req = _make_request(user, method="GET")
        req.auth = _mint_token(user, owner=user)
        assert TokenIsOwnerScoped().has_permission(req, _make_view()) is True

    def test_project_scoped_token_is_rejected_with_401(
        self, user: object, project: Project
    ) -> None:
        """The confused-deputy guard (#1712): a scoped token has nothing to check
        against on the collection tools, so it is refused rather than over-returning."""
        from rest_framework.exceptions import AuthenticationFailed

        from trueppm_api.apps.access.permissions import TokenIsOwnerScoped

        req = _make_request(user, method="GET")
        req.auth = _mint_token(user, project=project)
        with pytest.raises(AuthenticationFailed):
            TokenIsOwnerScoped().has_permission(req, _make_view())

    def test_human_caller_passes_the_owner_scope_guard(self, user: object) -> None:
        from trueppm_api.apps.access.permissions import TokenIsOwnerScoped

        req = _make_request(user, method="GET")
        req.auth = None
        assert TokenIsOwnerScoped().has_permission(req, _make_view()) is True
