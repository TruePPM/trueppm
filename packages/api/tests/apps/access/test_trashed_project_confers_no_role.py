"""A trashed project confers no role, before or after its child cascade (#4577).

Trashing a project soft-deletes the project row and offloads the child cascade
(``cascade_project_soft_delete``) to Celery. Memberships are deliberately left live.
Until that cascade lands — or indefinitely, while the broker is down — every gate
built on ``_membership_role`` still resolved the members' roles, the
``ProjectScopedViewSet`` queryset still served the children, and ``_project_exists``
read the trashed row as "unknown", so the declared-``<pk>`` permission layer stood
down for it on reads and writes alike.

Every test below builds the **uncascaded** state directly — the project row
tombstoned, its children still ``is_deleted=False`` — because that window is the
whole defect. Running the cascade first would make each assertion pass on the
unfixed code for the wrong reason (the child rows would be filtered by their own
flags).
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from asgiref.sync import async_to_sync
from django.contrib.auth import get_user_model
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.test import APIClient, APIRequestFactory
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import (
    CanAssignResource,
    IsProjectAdmin,
    IsProjectBacklogManager,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectOwner,
    IsProjectPlanAuthor,
    IsProjectScheduler,
    IsProjectScopeManager,
    IsTrashedProjectOwner,
    ProjectRowState,
    ScopeResolution,
    _membership_role,
    _project_row_state,
    _resolve_project_scope,
    _trashed_project_role,
    _unresolved_scope_allows,
    live_member_project_ids,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole
from trueppm_api.apps.teams.services import has_team_facet

User = get_user_model()

pytestmark = pytest.mark.django_db

MISSING_PK = "00000000-0000-0000-0000-000000000000"

#: Same family ``test_unresolvable_scope_fails_closed.py`` lists — every class that
#: consults ``_resolve_project_scope``.
PROJECT_FAMILY = [
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectPlanAuthor,
    IsProjectScheduler,
    IsProjectAdmin,
    IsProjectBacklogManager,
    IsProjectScopeManager,
    IsProjectOwner,
    CanAssignResource,
]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="trash-owner", password="pw")


@pytest.fixture
def admin_member(db: object) -> Any:
    return User.objects.create_user(username="trash-admin", password="pw")


@pytest.fixture
def project(owner: Any, admin_member: Any, calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Trashed", code="TRSH", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=p, user=admin_member, role=Role.ADMIN)
    return p


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Child", duration=1)


def _trash_without_cascade(project: Project) -> None:
    """Tombstone the project row only — the state between delete and cascade."""
    Project.objects.filter(pk=project.pk).update(is_deleted=True)


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _request(method: str, user: Any) -> Request:
    drf_request = Request(APIRequestFactory().generic(method, "/"))
    drf_request.user = user
    return drf_request


class _DeclaringView(APIView):
    """A ``projects/<pk>/…`` view that declares its kwarg, like the ~30 real ones."""

    project_url_kwarg = "pk"


def _declaring_view(pk: Any) -> APIView:
    view = _DeclaringView()
    view.kwargs = {"pk": str(pk)}
    return view


# ---------------------------------------------------------------------------
# The resolvers
# ---------------------------------------------------------------------------


def test_row_state_distinguishes_live_trashed_and_missing(project: Project) -> None:
    assert _project_row_state(project.pk) is ProjectRowState.LIVE
    _trash_without_cascade(project)
    assert _project_row_state(project.pk) is ProjectRowState.TRASHED
    assert _project_row_state(MISSING_PK) is ProjectRowState.MISSING


def test_membership_role_is_none_on_a_trashed_project(project: Project, owner: Any) -> None:
    assert _membership_role(_request("GET", owner), project.pk) == Role.OWNER
    _trash_without_cascade(project)
    # Fresh request: the role cache is per-request.
    assert _membership_role(_request("GET", owner), project.pk) is None


def test_trashed_project_role_answers_only_for_a_trashed_project(
    project: Project, owner: Any
) -> None:
    """The Restore-only reader must never become a second path to a LIVE role."""
    assert _trashed_project_role(_request("POST", owner), project.pk) is None
    _trash_without_cascade(project)
    assert _trashed_project_role(_request("POST", owner), project.pk) == Role.OWNER


def test_live_member_project_ids_excludes_a_trashed_project(project: Project, owner: Any) -> None:
    assert live_member_project_ids(owner, [project.pk]) == {project.pk}
    _trash_without_cascade(project)
    assert live_member_project_ids(owner, [project.pk]) == set()


def test_a_missing_project_still_stands_down_but_a_trashed_one_does_not(
    project: Project, owner: Any
) -> None:
    """Missing → UNKNOWN_ID (stand down, view 404s). Trashed → refused outright.

    The pre-#4577 resolver folded both into UNKNOWN_ID, and ``_unresolved_scope_allows``
    answers True to UNKNOWN_ID on every method for every class.
    """
    pk, state = _resolve_project_scope(_declaring_view(MISSING_PK))
    assert (pk, state) == (None, ScopeResolution.UNKNOWN_ID)
    assert _unresolved_scope_allows(_request("POST", owner), _declaring_view(MISSING_PK), state)

    _trash_without_cascade(project)
    with pytest.raises(NotFound):
        _resolve_project_scope(_declaring_view(project.pk))


@pytest.mark.parametrize("permission_class", PROJECT_FAMILY, ids=lambda c: c.__name__)
def test_every_family_class_refuses_a_trashed_project_on_a_write(
    permission_class: type, project: Project, owner: Any
) -> None:
    """The Owner — who passes every class on a live project — is refused once trashed."""
    view = _declaring_view(project.pk)
    assert permission_class().has_permission(_request("POST", owner), view) is True
    _trash_without_cascade(project)
    with pytest.raises(NotFound):
        permission_class().has_permission(_request("POST", owner), view)


@pytest.mark.parametrize(
    "permission_class",
    [c for c in PROJECT_FAMILY if c is not IsProjectPlanAuthor],
    ids=lambda c: c.__name__,
)
def test_every_reading_family_class_refuses_a_trashed_project_on_a_read(
    permission_class: type, project: Project, owner: Any
) -> None:
    """Reads too. ``IsProjectPlanAuthor`` is excluded: it admits GET before resolving."""
    view = _declaring_view(project.pk)
    _trash_without_cascade(project)
    with pytest.raises(NotFound):
        permission_class().has_permission(_request("GET", owner), view)


def test_object_checks_refuse_every_role_on_a_trashed_project(
    project: Project, owner: Any, admin_member: Any
) -> None:
    """The in-body ``check_object_permissions(project)`` path, used by #4008's sites."""
    _trash_without_cascade(project)
    project.refresh_from_db()
    for user in (owner, admin_member):
        req = _request("POST", user)
        assert IsProjectMember().has_object_permission(req, APIView(), project) is False
        assert IsProjectScheduler().has_object_permission(req, APIView(), project) is False
        assert IsProjectOwner().has_object_permission(req, APIView(), project) is False


def test_trashed_owner_gate_admits_only_the_owner_of_a_trashed_project(
    project: Project, owner: Any, admin_member: Any
) -> None:
    gate = IsTrashedProjectOwner()
    # Live project: never a stand-in for IsProjectOwner.
    assert gate.has_object_permission(_request("POST", owner), APIView(), project) is False
    _trash_without_cascade(project)
    project.refresh_from_db()
    assert gate.has_object_permission(_request("POST", owner), APIView(), project) is True
    assert gate.has_object_permission(_request("POST", admin_member), APIView(), project) is False


def test_product_owner_facet_does_not_outlive_the_project(project: Project) -> None:
    """The facet arm runs exactly when the role is None — so it needs the floor too."""
    po = User.objects.create_user(username="trash-po", password="pw")
    ProjectMembership.objects.create(project=project, user=po, role=Role.MEMBER)
    team = Team.objects.create(
        project=project, name="Default Team", short_id="T01", is_default=True, server_version=1
    )
    TeamMembership.objects.create(team=team, user=po, role=TeamRole.MEMBER, is_product_owner=True)
    assert has_team_facet(po, project.pk, "is_product_owner") is True
    _trash_without_cascade(project)
    assert has_team_facet(po, project.pk, "is_product_owner") is False


@pytest.mark.django_db(transaction=True)
def test_websocket_role_is_none_on_a_trashed_project(project: Project, owner: Any) -> None:
    from trueppm_api.apps.sync.consumers import ProjectConsumer

    get_role = async_to_sync(ProjectConsumer()._get_role)
    assert get_role(owner, str(project.pk)) == Role.OWNER
    _trash_without_cascade(project)
    assert get_role(owner, str(project.pk)) is None


# ---------------------------------------------------------------------------
# End to end — the issue's named child resources
# ---------------------------------------------------------------------------


def test_task_write_is_refused_for_every_role_once_trashed(
    project: Project, task: Task, owner: Any, admin_member: Any
) -> None:
    # Control: both can edit the task while the project is live.
    for user in (owner, admin_member):
        resp = _client(user).patch(f"/api/v1/tasks/{task.pk}/", {"name": "x"}, format="json")
        assert resp.status_code == 200, resp.content

    _trash_without_cascade(project)
    for user in (owner, admin_member):
        resp = _client(user).patch(f"/api/v1/tasks/{task.pk}/", {"name": "y"}, format="json")
        assert resp.status_code == 404, resp.content
    task.refresh_from_db()
    assert task.name == "x"


def test_task_list_hides_a_trashed_projects_children(
    project: Project, task: Task, owner: Any
) -> None:
    def listed() -> set[str]:
        resp = _client(owner).get(f"/api/v1/tasks/?project={project.pk}")
        assert resp.status_code == 200, resp.content
        body = resp.json()
        rows = body["results"] if isinstance(body, dict) else body
        return {row["id"] for row in rows}

    assert str(task.pk) in listed()
    _trash_without_cascade(project)
    assert str(task.pk) not in listed()


def test_board_column_config_is_refused_once_trashed(project: Project, owner: Any) -> None:
    url = f"/api/v1/projects/{project.pk}/board-config/"
    assert _client(owner).get(url).status_code == 200
    _trash_without_cascade(project)
    assert _client(owner).get(url).status_code == 404
    resp = _client(owner).put(url, {"columns": []}, format="json")
    assert resp.status_code == 404, resp.content


def test_trigger_schedule_is_refused_once_trashed(project: Project, owner: Any) -> None:
    _trash_without_cascade(project)
    resp = _client(owner).post(f"/api/v1/projects/{project.pk}/schedule/")
    assert resp.status_code == 404, resp.content


def test_nested_project_route_is_refused_once_trashed(project: Project, owner: Any) -> None:
    """A ``project_pk`` route resolves the role directly — 403, as for an unknown id."""
    url = f"/api/v1/projects/{project.pk}/members/"
    assert _client(owner).get(url).status_code == 200
    _trash_without_cascade(project)
    assert _client(owner).get(url).status_code == 403


def test_declared_pk_route_is_refused_once_trashed(project: Project, owner: Any) -> None:
    url = f"/api/v1/projects/{project.pk}/my-tasks/"
    assert _client(owner).get(url).status_code == 200
    _trash_without_cascade(project)
    assert _client(owner).get(url).status_code == 404


# ---------------------------------------------------------------------------
# The surfaces that MUST keep working on a trashed project
# ---------------------------------------------------------------------------


def test_owner_can_still_restore_and_regains_their_role(
    project: Project, task: Task, owner: Any
) -> None:
    client = _client(owner)
    assert client.delete(f"/api/v1/projects/{project.pk}/").status_code == 204

    trash = client.get("/api/v1/projects/trash/")
    assert trash.status_code == 200
    row = next(r for r in trash.json() if r["id"] == str(project.pk))
    assert row["can_restore"] is True
    assert row["my_role"] == Role.OWNER

    resp = client.post(f"/api/v1/projects/{project.pk}/restore/")
    assert resp.status_code == 200, resp.content

    resp = client.patch(f"/api/v1/tasks/{task.pk}/", {"name": "after"}, format="json")
    assert resp.status_code == 200, resp.content


def test_non_owner_member_still_cannot_restore(project: Project, admin_member: Any) -> None:
    _trash_without_cascade(project)
    resp = _client(admin_member).post(f"/api/v1/projects/{project.pk}/restore/")
    assert resp.status_code == 403, resp.content
