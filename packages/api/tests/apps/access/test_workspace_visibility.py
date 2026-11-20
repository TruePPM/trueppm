"""WORKSPACE vs PRIVATE visibility enforcement on the project/program record (ADR-1434, #2066).

WORKSPACE opens the *record* — list + retrieve — read-only to every active workspace
member. PRIVATE keeps it membership-scoped. Neither value reaches child data, writes,
guests, or deactivated accounts.
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_API_FULL,
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Program,
    Project,
    ProjectLifecycle,
    Visibility,
)
from trueppm_api.apps.projects.program_views import ProgramViewSet
from trueppm_api.apps.projects.views import ProjectViewSet
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
    assert c.put(url, {"name": "hijack"}, format="json").status_code in (403, 404)
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


def test_non_member_list_query_count_is_flat_in_row_count(colleague: Any, owner: Any) -> None:
    """``can_author`` / ``can_undo_batch_operations`` / ``can_subscribe_live`` must treat an
    annotated NULL ``_my_role`` as final: no per-row membership fallback query."""
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    cal = Calendar.objects.create(name="Std")

    def _add(n: int, tag: str) -> None:
        for i in range(n):
            p = Project.objects.create(
                name=f"{tag}{i}", start_date=date(2026, 1, 5), calendar=cal, visibility="WORKSPACE"
            )
            ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)

    c = _client(colleague)
    _add(2, "a")
    c.get("/api/v1/projects/")  # warm per-process caches
    with CaptureQueriesContext(connection) as few:
        assert len(_ids(c.get("/api/v1/projects/"))) == 2
    _add(6, "b")
    with CaptureQueriesContext(connection) as many:
        assert len(_ids(c.get("/api/v1/projects/"))) == 8
    assert len(many) == len(few)


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
    assert c.put(url, {"name": "hijack"}, format="json").status_code in (403, 404)
    assert c.delete(url).status_code in (403, 404)
    programs[key].refresh_from_db()
    assert programs[key].name == f"G-{key}"
    assert Program.objects.filter(pk=programs[key].pk).exists()


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


# --- Write and action paths on a WORKSPACE row (non-member) ---------------------------


def _unsafe_detail_actions(viewset: Any) -> list[tuple[str, str]]:
    """Every (url_path, method) unsafe detail action the viewset declares.

    Enumerated from the viewset itself, so an action added later is covered without
    editing this test — the class of bug is "a write reachable through the widened
    record", not any one action.
    """
    found: list[tuple[str, str]] = []
    for act in viewset.get_extra_actions():
        if not act.detail:
            continue
        for method in act.mapping:
            if method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
                found.append((act.url_path, method))
    return found


def test_unsafe_action_enumeration_is_not_vacuous() -> None:
    project_paths = {p for p, _ in _unsafe_detail_actions(ProjectViewSet)}
    program_paths = {p for p, _ in _unsafe_detail_actions(ProgramViewSet)}
    assert {"archive", "transfer", "pin", "visit", "export", "restore"} <= project_paths
    assert {"close", "split", "bulk-project-fields", "restore", "pin"} <= program_paths


def test_non_member_reaches_no_project_write_or_action(
    projects: dict[str, Project], colleague: Any
) -> None:
    project = projects["workspace"]
    c = _client(colleague)
    before = Project.objects.filter(pk=project.pk).values().get()
    url = f"/api/v1/projects/{project.pk}/"
    assert c.put(url, {"name": "hijack"}, format="json").status_code in (403, 404)
    for path, method in _unsafe_detail_actions(ProjectViewSet):
        resp = getattr(c, method)(f"{url}{path}/", {}, format="json")
        assert resp.status_code in (403, 404), (path, method, resp.status_code)
    assert Project.objects.filter(pk=project.pk).values().get() == before
    assert not ProjectMembership.objects.filter(user=colleague).exists()


def test_non_member_reaches_no_program_write_or_action(
    programs: dict[str, Program], colleague: Any
) -> None:
    program = programs["workspace"]
    c = _client(colleague)
    before = Program.objects.filter(pk=program.pk).values().get()
    url = f"/api/v1/programs/{program.pk}/"
    assert c.put(url, {"name": "hijack"}, format="json").status_code in (403, 404)
    for path, method in _unsafe_detail_actions(ProgramViewSet):
        resp = getattr(c, method)(f"{url}{path}/", {}, format="json")
        assert resp.status_code in (403, 404), (path, method, resp.status_code)
    assert Program.objects.filter(pk=program.pk).values().get() == before
    assert not ProgramMembership.objects.filter(user=colleague).exists()


# --- The summary record a non-member receives (ADR-1434 §6) ---------------------------

_PROJECT_MEMBER_ONLY = {
    "budget",
    "open_task_count",
    "member_count",
    "percent_complete",
    "unresolved_assignee_count",
    "retired_key_count",
    "lead",
    "lead_detail",
    "public_sharing",
    "allow_guests",
    "mcp_enabled",
    "effective_public_sharing",
    "inherited_public_sharing",
    "effective_allow_guests",
    "inherited_allow_guests",
    "effective_mcp_enabled",
    "inherited_mcp_enabled",
    "scheduling_calendar",
}

_PROGRAM_MEMBER_ONLY = {
    "member_count",
    "project_count",
    "rollup_enabled_kpis",
    "risk_slip_propagation",
    "created_by",
    "lead_detail",
    "public_sharing",
    "allow_guests",
    "mcp_enabled",
    "effective_mcp_enabled",
    "retired_key_count",
}


def test_non_member_retrieve_is_the_summary_record(
    projects: dict[str, Project], colleague: Any, owner: Any
) -> None:
    url = f"/api/v1/projects/{projects['workspace'].pk}/"
    data = _client(colleague).get(url).data
    assert data["my_role"] is None
    assert data["name"] == "P-workspace"
    assert {"id", "visibility", "start_date", "effective_methodology"} <= set(data)
    assert not _PROJECT_MEMBER_ONLY & set(data), _PROJECT_MEMBER_ONLY & set(data)
    # Positive control: the owner still receives every one of them.
    owner_data = _client(owner).get(url).data
    assert {"budget", "unresolved_assignee_count", "lead_detail", "mcp_enabled"} <= set(owner_data)


def test_non_member_list_rows_are_summary_records(
    projects: dict[str, Project], colleague: Any, owner: Any
) -> None:
    for query in ("", "?program__isnull=true"):
        rows = _rows(_client(colleague).get(f"/api/v1/projects/{query}").data)
        row = next(r for r in rows if r["id"] == str(projects["workspace"].pk))
        assert not _PROJECT_MEMBER_ONLY & set(row), (query, _PROJECT_MEMBER_ONLY & set(row))
    owner_rows = _rows(_client(owner).get("/api/v1/projects/?program__isnull=true").data)
    assert "member_count" in owner_rows[0]
    assert "open_task_count" in owner_rows[0]


def test_non_member_program_record_is_the_summary_record(
    programs: dict[str, Program], colleague: Any, owner: Any
) -> None:
    pk = str(programs["workspace"].pk)
    detail = _client(colleague).get(f"/api/v1/programs/{pk}/").data
    row = next(r for r in _rows(_client(colleague).get("/api/v1/programs/").data) if r["id"] == pk)
    for data in (detail, row):
        assert data["my_role"] is None
        assert data["name"] == "G-workspace"
        assert not _PROGRAM_MEMBER_ONLY & set(data), _PROGRAM_MEMBER_ONLY & set(data)
    owner_data = _client(owner).get(f"/api/v1/programs/{pk}/").data
    assert {"member_count", "project_count", "created_by"} <= set(owner_data)


@pytest.mark.parametrize("program_vis", [Visibility.PRIVATE, Visibility.WORKSPACE])
def test_private_program_name_does_not_leak_through_workspace_project(
    projects: dict[str, Project], colleague: Any, owner: Any, program_vis: str
) -> None:
    project = projects["workspace"]
    program = Program.objects.create(name="Secret program", visibility=program_vis)
    ProgramMembership.objects.create(program=program, user=owner, role=Role.OWNER)
    project.program = program
    project.save(update_fields=["program"])
    url = f"/api/v1/projects/{project.pk}/"
    detail = _client(colleague).get(url).data["program_detail"]
    if program_vis == Visibility.PRIVATE:
        assert detail is None
        # A program member who is not a project member still sees the name.
        ProgramMembership.objects.create(program=program, user=colleague, role=Role.VIEWER)
        assert _client(colleague).get(url).data["program_detail"]["name"] == "Secret program"
    else:
        assert detail["name"] == "Secret program"
    assert _client(owner).get(url).data["program_detail"]["name"] == "Secret program"


# --- Token callers read as their user ------------------------------------------------


def _token_client(user: Any, scopes: list[str]) -> APIClient:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=user,
        name="vis",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=user,
        scopes=scopes,
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


@pytest.mark.parametrize("scopes", [[SCOPE_API_FULL], [SCOPE_MCP_READ]], ids=["pat", "mcp-read"])
def test_token_reads_workspace_record_but_not_private_or_children(
    projects: dict[str, Project], colleague: Any, scopes: list[str]
) -> None:
    c = _token_client(colleague, scopes)
    ws = projects["workspace"]
    assert str(ws.pk) in _ids(c.get("/api/v1/projects/"))
    detail = c.get(f"/api/v1/projects/{ws.pk}/")
    assert detail.status_code == 200
    assert detail.data["my_role"] is None
    assert "budget" not in detail.data
    assert c.get(f"/api/v1/projects/{projects['private'].pk}/").status_code == 404
    assert c.get(f"/api/v1/projects/{ws.pk}/overview/").status_code in (403, 404)
    assert c.patch(f"/api/v1/projects/{ws.pk}/", {"name": "x"}, format="json").status_code in (
        403,
        404,
    )
