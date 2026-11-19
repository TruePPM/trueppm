"""WORKSPACE vs PRIVATE visibility enforcement on the project/program record (ADR-1434, #2066).

WORKSPACE opens the *record* — list + retrieve — read-only to every active workspace
member. PRIVATE keeps it membership-scoped. Neither value reaches child data, writes,
guests, or deactivated accounts.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Program,
    Project,
    ProjectLifecycle,
    Visibility,
)
from trueppm_api.apps.workspace.models import MemberStatus, Workspace, WorkspaceMembership

User = get_user_model()

pytestmark = pytest.mark.django_db


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _rows(data: Any) -> list[dict[str, Any]]:
    return data["results"] if isinstance(data, dict) else data


def _ids(resp: Any) -> list[str]:
    return [str(r["id"]) for r in _rows(resp.data)]


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="vis-owner", password="pw")


@pytest.fixture
def colleague() -> Any:
    """An active workspace member with no membership on anything (no workspace row)."""
    return User.objects.create_user(username="vis-colleague", password="pw")


def _workspace_user(username: str, status: str) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    WorkspaceMembership.objects.create(workspace=Workspace.load(), user=user, status=status)
    return user


@pytest.fixture
def projects(owner: Any) -> dict[str, Project]:
    cal = Calendar.objects.create(name="Std")
    made: dict[str, Project] = {}
    for key, vis, lifecycle in (
        ("workspace", Visibility.WORKSPACE, ProjectLifecycle.ACTIVE),
        ("private", Visibility.PRIVATE, ProjectLifecycle.ACTIVE),
        ("draft", Visibility.WORKSPACE, ProjectLifecycle.DRAFT),
    ):
        p = Project.objects.create(
            name=f"P-{key}",
            start_date=date(2026, 1, 5),
            calendar=cal,
            visibility=vis,
            lifecycle=lifecycle,
        )
        ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
        made[key] = p
    return made


@pytest.fixture
def programs(owner: Any) -> dict[str, Program]:
    made: dict[str, Program] = {}
    for key, vis in (("workspace", Visibility.WORKSPACE), ("private", Visibility.PRIVATE)):
        prog = Program.objects.create(name=f"G-{key}", visibility=vis)
        ProgramMembership.objects.create(program=prog, user=owner, role=Role.OWNER)
        made[key] = prog
    return made


# --- Project record -------------------------------------------------------------------


def test_workspace_member_lists_workspace_project_not_private_or_draft(
    projects: dict[str, Project], colleague: Any
) -> None:
    resp = _client(colleague).get("/api/v1/projects/")
    assert resp.status_code == 200
    ids = _ids(resp)
    assert str(projects["workspace"].pk) in ids
    assert str(projects["private"].pk) not in ids
    assert str(projects["draft"].pk) not in ids  # a draft stays member-only
    row = next(r for r in _rows(resp.data) if r["id"] == str(projects["workspace"].pk))
    assert row["my_role"] is None  # the honest "not a member" signal


def test_workspace_member_retrieves_workspace_project_but_not_private(
    projects: dict[str, Project], colleague: Any
) -> None:
    c = _client(colleague)
    assert c.get(f"/api/v1/projects/{projects['workspace'].pk}/").status_code == 200
    assert c.get(f"/api/v1/projects/{projects['private'].pk}/").status_code == 404


@pytest.mark.parametrize("key", ["workspace", "private"])
def test_non_member_cannot_write_either_visibility(
    projects: dict[str, Project], colleague: Any, key: str
) -> None:
    c = _client(colleague)
    url = f"/api/v1/projects/{projects[key].pk}/"
    assert c.patch(url, {"name": "hijack"}, format="json").status_code in (403, 404)
    assert c.delete(url).status_code in (403, 404)
    projects[key].refresh_from_db()
    assert projects[key].name == f"P-{key}"
    assert projects[key].is_deleted is False


@pytest.mark.parametrize("suffix", ["overview/", "calendars/", "product-backlog/"])
def test_workspace_visibility_does_not_reach_child_reads(
    projects: dict[str, Project], colleague: Any, owner: Any, suffix: str
) -> None:
    url = f"/api/v1/projects/{projects['workspace'].pk}/{suffix}"
    assert _client(owner).get(url).status_code == 200  # the route exists (non-vacuous)
    assert _client(colleague).get(url).status_code in (403, 404)


@pytest.mark.parametrize("status", [MemberStatus.GUEST, MemberStatus.DEACTIVATED])
def test_guest_and_deactivated_see_neither(projects: dict[str, Project], status: str) -> None:
    user = _workspace_user(f"vis-{status}", status)
    c = _client(user)
    resp = c.get("/api/v1/projects/")
    if resp.status_code == 200:
        assert _ids(resp) == []
    for key in ("workspace", "private"):
        assert c.get(f"/api/v1/projects/{projects[key].pk}/").status_code in (403, 404)


def test_anonymous_sees_neither(projects: dict[str, Project]) -> None:
    c = APIClient()
    assert c.get("/api/v1/projects/").status_code == 401
    assert c.get(f"/api/v1/projects/{projects['workspace'].pk}/").status_code == 401


def test_member_list_has_no_duplicates_when_both_arms_match(
    projects: dict[str, Project], owner: Any
) -> None:
    """The owner matches the WORKSPACE project through BOTH membership and visibility;
    the OR must still yield it once (no join fan-out, no `.distinct()` needed)."""
    resp = _client(owner).get("/api/v1/projects/")
    assert resp.status_code == 200
    ids = _ids(resp)
    assert len(ids) == len(set(ids))
    assert set(ids) == {str(p.pk) for p in projects.values()}
    assert resp.data["count"] == 3


def test_list_query_count_does_not_grow_with_workspace_visible_rows(
    owner: Any, colleague: Any, django_assert_max_num_queries: Any
) -> None:
    cal = Calendar.objects.create(name="Std")
    for i in range(6):
        p = Project.objects.create(
            name=f"W{i}", start_date=date(2026, 1, 5), calendar=cal, visibility="WORKSPACE"
        )
        ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    c = _client(colleague)
    c.get("/api/v1/projects/")  # warm per-process caches (workspace singleton)
    with django_assert_max_num_queries(20):
        resp = c.get("/api/v1/projects/")
    assert len(_ids(resp)) == 6


# --- Program record -------------------------------------------------------------------


def test_workspace_member_lists_and_retrieves_workspace_program_only(
    programs: dict[str, Program], colleague: Any
) -> None:
    c = _client(colleague)
    resp = c.get("/api/v1/programs/")
    assert resp.status_code == 200
    ids = _ids(resp)
    assert str(programs["workspace"].pk) in ids
    assert str(programs["private"].pk) not in ids
    assert c.get(f"/api/v1/programs/{programs['workspace'].pk}/").status_code == 200
    assert c.get(f"/api/v1/programs/{programs['private'].pk}/").status_code == 404


def test_program_member_list_has_no_duplicates(programs: dict[str, Program], owner: Any) -> None:
    ids = _ids(_client(owner).get("/api/v1/programs/"))
    assert len(ids) == len(set(ids)) == 2


@pytest.mark.parametrize("key", ["workspace", "private"])
def test_non_member_cannot_write_either_program(
    programs: dict[str, Program], colleague: Any, key: str
) -> None:
    c = _client(colleague)
    url = f"/api/v1/programs/{programs[key].pk}/"
    assert c.patch(url, {"name": "hijack"}, format="json").status_code in (403, 404)
    assert c.delete(url).status_code in (403, 404)
    programs[key].refresh_from_db()
    assert programs[key].name == f"G-{key}"


@pytest.mark.parametrize("suffix", ["projects/", "rollup/"])
def test_workspace_program_child_reads_stay_member_only(
    programs: dict[str, Program], colleague: Any, owner: Any, suffix: str
) -> None:
    url = f"/api/v1/programs/{programs['workspace'].pk}/{suffix}"
    assert _client(owner).get(url).status_code == 200  # the route exists (non-vacuous)
    assert _client(colleague).get(url).status_code in (403, 404)


def test_guest_does_not_see_workspace_program(programs: dict[str, Program]) -> None:
    c = _client(_workspace_user("vis-guest-prog", MemberStatus.GUEST))
    assert str(programs["workspace"].pk) not in _ids(c.get("/api/v1/programs/"))
    assert c.get(f"/api/v1/programs/{programs['workspace'].pk}/").status_code in (403, 404)
