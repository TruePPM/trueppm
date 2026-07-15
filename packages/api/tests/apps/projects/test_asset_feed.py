"""API + service tests for the unified Assets feed (ADR-0215, #971).

Covers: both sources aggregated (file + link) for a project; each filter
(kind / label / provider / q) subsets correctly across BOTH sources; keyset
pagination returns every asset once across pages (no dupes, no drops); the
program endpoint narrows to the caller's readable member projects; RBAC (403 for
non-members, empty list for a program member with no readable projects); and no
N+1 as the asset count grows.
"""

from __future__ import annotations

import datetime
import uuid
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.integrations.models import TaskLink
from trueppm_api.apps.projects.models import (
    Calendar,
    Program,
    Project,
    Task,
    TaskAttachment,
)

User = get_user_model()

pytestmark = pytest.mark.django_db

BASE = datetime.datetime(2026, 3, 1, 12, 0, 0, tzinfo=datetime.UTC)


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _at(minutes: int) -> datetime.datetime:
    """A distinct, deterministic created_at for merge/pagination ordering."""
    return BASE + datetime.timedelta(minutes=minutes)


def _make_file(task: Task, *, name: str, uploader: Any, when: datetime.datetime) -> TaskAttachment:
    att = TaskAttachment.objects.create(
        task=task, file=f"attachments/{task.pk}/{name}", file_name=name, uploaded_by=uploader
    )
    # created_at is auto_now_add — pin it for deterministic ordering.
    TaskAttachment.objects.filter(pk=att.pk).update(created_at=when)
    att.refresh_from_db()
    return att


def _make_external(task: Task, *, title: str, url: str, when: datetime.datetime) -> TaskAttachment:
    att = TaskAttachment.objects.create(task=task, external_url=url, external_title=title)
    TaskAttachment.objects.filter(pk=att.pk).update(created_at=when)
    att.refresh_from_db()
    return att


def _make_link(
    task: Task,
    *,
    url: str,
    provider: str = "github",
    title: str = "",
    custom_title: str = "",
    labels: list[str] | None = None,
    status: str = "open",
    when: datetime.datetime,
) -> TaskLink:
    # created_at has default=timezone.now, so it can be set at create time.
    return TaskLink.objects.create(
        task=task,
        url=url,
        provider=provider,
        title=title,
        custom_title=custom_title,
        labels=labels or [],
        status=status,
        created_at=when,
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program() -> Program:
    return Program.objects.create(name="GA Launch")


@pytest.fixture
def project(calendar: Calendar, program: Program) -> Project:
    return Project.objects.create(
        name="Alpha", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=1)


@pytest.fixture
def member() -> Any:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def outsider() -> Any:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def project_membership(project: Project, member: Any) -> None:
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)


def _project_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/assets/"


def _program_url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/assets/"


WORKSPACE_URL = "/api/v1/assets/"


# ---------------------------------------------------------------------------
# Aggregation — both sources
# ---------------------------------------------------------------------------


def test_project_assets_returns_both_a_file_and_a_link(
    project: Project, task: Task, member: Any, project_membership: None
) -> None:
    """The feed unifies a TaskAttachment (file) and a TaskLink for one task."""
    _make_file(task, name="spec.pdf", uploader=member, when=_at(1))
    _make_link(task, url="https://github.com/acme/api/pull/7", custom_title="PR 7", when=_at(2))

    resp = _client(member).get(_project_url(project))
    assert resp.status_code == 200, resp.data
    results = resp.data["results"]
    assert {r["kind"] for r in results} == {"file", "link"}

    file_row = next(r for r in results if r["kind"] == "file")
    assert file_row["title"] == "spec.pdf"
    assert file_row["url"] is None
    # A stored file exposes the signed-url action target, never the raw path.
    assert file_row["download_url"] is not None
    assert "/signed-url/" in file_row["download_url"]
    assert file_row["labels"] == []
    assert file_row["provider"] is None
    assert file_row["added_by"]["display_name"]  # uploader captured
    assert file_row["task"] == {"id": str(task.pk), "name": "Foundation"}

    link_row = next(r for r in results if r["kind"] == "link")
    assert link_row["title"] == "PR 7"
    assert link_row["url"] == "https://github.com/acme/api/pull/7"
    assert link_row["download_url"] is None
    assert link_row["provider"] == "github"
    assert link_row["added_by"] is None  # TaskLink has no uploader


def test_external_url_attachment_surfaces_url_not_download(
    project: Project, task: Task, member: Any, project_membership: None
) -> None:
    """A file-less (external_url) attachment exposes its URL and no download target."""
    _make_external(task, title="Figma", url="https://figma.com/file/abc", when=_at(1))
    resp = _client(member).get(_project_url(project))
    row = resp.data["results"][0]
    assert row["kind"] == "file"
    assert row["url"] == "https://figma.com/file/abc"
    assert row["download_url"] is None


# ---------------------------------------------------------------------------
# Filters — each subsets correctly across both sources
# ---------------------------------------------------------------------------


def test_kind_filter_isolates_a_single_source(
    project: Project, task: Task, member: Any, project_membership: None
) -> None:
    _make_file(task, name="a.pdf", uploader=member, when=_at(1))
    _make_link(task, url="https://github.com/x/y/pull/1", when=_at(2))

    files = _client(member).get(_project_url(project), {"kind": "file"}).data["results"]
    assert [r["kind"] for r in files] == ["file"]
    links = _client(member).get(_project_url(project), {"kind": "link"}).data["results"]
    assert [r["kind"] for r in links] == ["link"]


def test_label_filter_matches_links_only(
    project: Project, task: Task, member: Any, project_membership: None
) -> None:
    """`label` is link-only — a file (no labels) is never a match, the labeled link is."""
    _make_file(task, name="spec.pdf", uploader=member, when=_at(1))
    _make_link(task, url="https://github.com/x/y/pull/1", labels=["spec", "design"], when=_at(2))
    _make_link(task, url="https://github.com/x/y/pull/2", labels=["chore"], when=_at(3))

    rows = _client(member).get(_project_url(project), {"label": "spec"}).data["results"]
    assert len(rows) == 1
    assert rows[0]["kind"] == "link"
    assert "spec" in rows[0]["labels"]


def test_provider_filter_matches_links_only(
    project: Project, task: Task, member: Any, project_membership: None
) -> None:
    _make_file(task, name="spec.pdf", uploader=member, when=_at(1))
    _make_link(task, url="https://github.com/x/y/pull/1", provider="github", when=_at(2))
    _make_link(
        task, url="https://gitlab.com/x/y/-/merge_requests/1", provider="gitlab", when=_at(3)
    )

    rows = _client(member).get(_project_url(project), {"provider": "gitlab"}).data["results"]
    assert len(rows) == 1
    assert rows[0]["provider"] == "gitlab"


def test_q_filter_matches_both_sources(
    project: Project, task: Task, member: Any, project_membership: None
) -> None:
    """`q` is applied to BOTH sources, so a shared term matches a file and a link."""
    _make_file(task, name="payments-spec.pdf", uploader=member, when=_at(1))
    _make_link(
        task, url="https://github.com/x/payments/pull/9", custom_title="Payments PR", when=_at(2)
    )
    # A non-matching link that must be excluded.
    _make_link(task, url="https://github.com/x/y/pull/1", custom_title="Unrelated", when=_at(3))

    rows = _client(member).get(_project_url(project), {"q": "payments"}).data["results"]
    kinds = sorted(r["kind"] for r in rows)
    assert kinds == ["file", "link"]  # one of each matched, the unrelated link dropped


# ---------------------------------------------------------------------------
# Pagination — no dupes, no drops across pages
# ---------------------------------------------------------------------------


def test_keyset_pagination_returns_every_asset_once(
    project: Project, task: Task, member: Any, project_membership: None
) -> None:
    """Walk the cursor to exhaustion; the union of pages is every asset, no dupes."""
    expected_ids: set[str] = set()
    # Interleave files and links across time so pages straddle both sources.
    for i in range(10):
        f = _make_file(task, name=f"f{i}.pdf", uploader=member, when=_at(2 * i))
        link = _make_link(task, url=f"https://github.com/x/y/pull/{i}", when=_at(2 * i + 1))
        expected_ids.add(str(f.pk))
        expected_ids.add(str(link.pk))

    seen: list[str] = []
    url = _project_url(project)
    params: dict[str, Any] = {"page_size": 3}
    for _ in range(50):  # generous bound; loop exits on exhaustion
        resp = _client(member).get(url, params)
        assert resp.status_code == 200
        page = resp.data["results"]
        assert len(page) <= 3
        seen.extend(r["id"] for r in page)
        cursor = resp.data["next_cursor"]
        if cursor is None:
            break
        params = {"page_size": 3, "cursor": cursor}

    assert len(seen) == len(expected_ids), "no drops and no over-fetch"
    assert set(seen) == expected_ids, "every asset returned exactly once"
    assert len(seen) == len(set(seen)), "no duplicates across pages"


def test_feed_is_newest_first(
    project: Project, task: Task, member: Any, project_membership: None
) -> None:
    old = _make_file(task, name="old.pdf", uploader=member, when=_at(1))
    new = _make_link(task, url="https://github.com/x/y/pull/1", when=_at(99))
    rows = _client(member).get(_project_url(project)).data["results"]
    assert [r["id"] for r in rows] == [str(new.pk), str(old.pk)]


# ---------------------------------------------------------------------------
# Program scope + RBAC
# ---------------------------------------------------------------------------


def test_program_feed_narrows_to_readable_projects(calendar: Calendar, program: Program) -> None:
    """A user who is a member of project A (not B) in the same program sees only A."""
    proj_a = Project.objects.create(
        name="A", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )
    proj_b = Project.objects.create(
        name="B", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )
    task_a = Task.objects.create(project=proj_a, name="TA", duration=1)
    task_b = Task.objects.create(project=proj_b, name="TB", duration=1)

    user = User.objects.create_user(username="pm", password="pw")
    # Program member, but only project A is readable.
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.VIEWER)

    a_link = _make_link(task_a, url="https://github.com/a/x/pull/1", when=_at(1))
    _make_link(task_b, url="https://github.com/b/x/pull/1", when=_at(2))  # project B — hidden
    _make_file(task_b, name="b-secret.pdf", uploader=user, when=_at(3))  # project B — hidden

    resp = _client(user).get(_program_url(program))
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.data["results"]}
    assert ids == {str(a_link.pk)}, "only the readable project's assets appear"


def test_program_member_with_no_readable_projects_gets_empty_list(
    calendar: Calendar, program: Program
) -> None:
    """A program member with no child-project membership gets [] — never a 403 leak."""
    proj = Project.objects.create(
        name="A", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )
    task = Task.objects.create(project=proj, name="TA", duration=1)
    _make_link(task, url="https://github.com/a/x/pull/1", when=_at(1))

    user = User.objects.create_user(username="prog-only", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.VIEWER)

    resp = _client(user).get(_program_url(program))
    assert resp.status_code == 200
    assert resp.data["results"] == []
    assert resp.data["next_cursor"] is None


def test_project_non_member_gets_403(project: Project, task: Task, outsider: Any) -> None:
    _make_link(task, url="https://github.com/x/y/pull/1", when=_at(1))
    resp = _client(outsider).get(_project_url(project))
    assert resp.status_code == 403


def test_program_non_member_gets_403(program: Program, outsider: Any) -> None:
    resp = _client(outsider).get(_program_url(program))
    assert resp.status_code == 403


def test_assets_require_authentication(project: Project) -> None:
    resp = APIClient().get(_project_url(project))
    assert resp.status_code in (401, 403)


def test_bad_kind_is_400(project: Project, member: Any, project_membership: None) -> None:
    resp = _client(member).get(_project_url(project), {"kind": "bogus"})
    assert resp.status_code == 400


def test_malformed_cursor_is_400(project: Project, member: Any, project_membership: None) -> None:
    resp = _client(member).get(_project_url(project), {"cursor": "not-a-valid-cursor!!"})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Workspace scope (ADR-0428) — cross-program, RBAC-narrowed, mine/program filters
# ---------------------------------------------------------------------------


def test_workspace_feed_aggregates_across_readable_projects_in_different_programs(
    calendar: Calendar,
) -> None:
    """`GET /api/v1/assets/` merges every project the caller can read, across programs."""
    prog_1 = Program.objects.create(name="P1")
    prog_2 = Program.objects.create(name="P2")
    proj_1 = Project.objects.create(
        name="One", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=prog_1
    )
    proj_2 = Project.objects.create(
        name="Two", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=prog_2
    )
    task_1 = Task.objects.create(project=proj_1, name="T1", duration=1)
    task_2 = Task.objects.create(project=proj_2, name="T2", duration=1)

    user = User.objects.create_user(username="multi-pm", password="pw")
    ProjectMembership.objects.create(project=proj_1, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_2, user=user, role=Role.VIEWER)

    link_1 = _make_link(task_1, url="https://github.com/1/x/pull/1", when=_at(1))
    file_2 = _make_file(task_2, name="two.pdf", uploader=user, when=_at(2))

    resp = _client(user).get(WORKSPACE_URL)
    assert resp.status_code == 200, resp.data
    ids = {r["id"] for r in resp.data["results"]}
    assert ids == {str(link_1.pk), str(file_2.pk)}, "both programs' readable assets merge"


def test_workspace_feed_narrows_to_readable_projects(calendar: Calendar) -> None:
    """The workspace feed never surfaces an asset from a project the caller can't read."""
    program = Program.objects.create(name="Prog")
    readable = Project.objects.create(
        name="R", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )
    hidden = Project.objects.create(
        name="H", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )
    task_r = Task.objects.create(project=readable, name="TR", duration=1)
    task_h = Task.objects.create(project=hidden, name="TH", duration=1)

    user = User.objects.create_user(username="scoped", password="pw")
    ProjectMembership.objects.create(project=readable, user=user, role=Role.MEMBER)

    r_link = _make_link(task_r, url="https://github.com/r/x/pull/1", when=_at(1))
    _make_link(task_h, url="https://github.com/h/x/pull/1", when=_at(2))  # hidden
    _make_file(task_h, name="secret.pdf", uploader=user, when=_at(3))  # hidden

    resp = _client(user).get(WORKSPACE_URL)
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.data["results"]}
    assert ids == {str(r_link.pk)}, "only the readable project's assets appear"


def test_workspace_feed_empty_for_user_with_no_projects(calendar: Calendar) -> None:
    """A user who belongs to no project gets [] — never a 403, never a leak."""
    program = Program.objects.create(name="Prog")
    proj = Project.objects.create(
        name="P", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )
    task = Task.objects.create(project=proj, name="T", duration=1)
    _make_link(task, url="https://github.com/x/y/pull/1", when=_at(1))

    loner = User.objects.create_user(username="loner", password="pw")
    resp = _client(loner).get(WORKSPACE_URL)
    assert resp.status_code == 200
    assert resp.data["results"] == []
    assert resp.data["next_cursor"] is None


def test_workspace_mine_filter_scopes_to_the_callers_assigned_tasks(calendar: Calendar) -> None:
    """`mine=true` returns only assets on tasks assigned to the requesting user."""
    program = Program.objects.create(name="Prog")
    proj = Project.objects.create(
        name="P", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )
    user = User.objects.create_user(username="me", password="pw")
    teammate = User.objects.create_user(username="teammate", password="pw")
    ProjectMembership.objects.create(project=proj, user=user, role=Role.MEMBER)

    my_task = Task.objects.create(project=proj, name="Mine", duration=1, assignee=user)
    their_task = Task.objects.create(project=proj, name="Theirs", duration=1, assignee=teammate)

    mine_link = _make_link(my_task, url="https://github.com/x/y/pull/1", when=_at(1))
    _make_file(my_task, name="mine.pdf", uploader=user, when=_at(2))
    _make_link(their_task, url="https://github.com/x/y/pull/2", when=_at(3))  # not mine

    # Both file and link on my task are mine; the teammate's link is excluded.
    rows = _client(user).get(WORKSPACE_URL, {"mine": "true"}).data["results"]
    kinds = sorted(r["kind"] for r in rows)
    assert kinds == ["file", "link"]
    assert any(r["id"] == str(mine_link.pk) for r in rows)
    task_names = {r["task"]["name"] for r in rows}
    assert task_names == {"Mine"}, "only the caller's assigned-task assets"

    # Default (no mine) still returns everything readable, including the teammate's.
    all_rows = _client(user).get(WORKSPACE_URL).data["results"]
    assert len(all_rows) == 3


def test_workspace_mine_has_no_user_escape_hatch(calendar: Calendar) -> None:
    """An admin/PM caller cannot read a *teammate's* assets — mine binds to request.user.

    Morgan's surveillance boundary: there is no ?user= parameter, and mine=true is
    always the caller. A ?user= is simply ignored (unknown param), so the admin sees
    only their own assigned-task assets.
    """
    program = Program.objects.create(name="Prog")
    proj = Project.objects.create(
        name="P", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )
    admin = User.objects.create_user(username="admin", password="pw")
    worker = User.objects.create_user(username="worker", password="pw")
    ProjectMembership.objects.create(project=proj, user=admin, role=Role.ADMIN)

    worker_task = Task.objects.create(project=proj, name="WorkerTask", duration=1, assignee=worker)
    _make_link(worker_task, url="https://github.com/x/y/pull/9", when=_at(1))

    # Admin asks for mine=true and tries to spoof ?user=<worker> — gets nothing (no own tasks).
    rows = (
        _client(admin).get(WORKSPACE_URL, {"mine": "true", "user": str(worker.pk)}).data["results"]
    )
    assert rows == [], "mine is always the caller; no ?user= surveillance hatch"


def test_workspace_program_filter_narrows_to_one_program(calendar: Calendar) -> None:
    prog_a = Program.objects.create(name="A")
    prog_b = Program.objects.create(name="B")
    proj_a = Project.objects.create(
        name="PA", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=prog_a
    )
    proj_b = Project.objects.create(
        name="PB", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=prog_b
    )
    task_a = Task.objects.create(project=proj_a, name="TA", duration=1)
    task_b = Task.objects.create(project=proj_b, name="TB", duration=1)

    user = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=proj_a, user=user, role=Role.MEMBER)
    ProjectMembership.objects.create(project=proj_b, user=user, role=Role.MEMBER)

    a_link = _make_link(task_a, url="https://github.com/a/x/pull/1", when=_at(1))
    _make_link(task_b, url="https://github.com/b/x/pull/1", when=_at(2))

    rows = _client(user).get(WORKSPACE_URL, {"program": str(prog_a.pk)}).data["results"]
    assert {r["id"] for r in rows} == {str(a_link.pk)}


def test_workspace_unknown_program_yields_empty_not_403(calendar: Calendar, member: Any) -> None:
    """A well-formed but unreadable/unknown program UUID narrows to empty, never 403."""
    resp = _client(member).get(WORKSPACE_URL, {"program": str(uuid.uuid4())})
    assert resp.status_code == 200
    assert resp.data["results"] == []


def test_workspace_bad_mine_is_400(member: Any) -> None:
    resp = _client(member).get(WORKSPACE_URL, {"mine": "maybe"})
    assert resp.status_code == 400


def test_workspace_bad_program_is_400(member: Any) -> None:
    resp = _client(member).get(WORKSPACE_URL, {"program": "not-a-uuid"})
    assert resp.status_code == 400


def test_workspace_requires_authentication() -> None:
    resp = APIClient().get(WORKSPACE_URL)
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Performance — no N+1
# ---------------------------------------------------------------------------


def test_no_n_plus_one_as_assets_grow(
    project: Project,
    task: Task,
    member: Any,
    project_membership: None,
    django_assert_max_num_queries: Any,
) -> None:
    """Query count stays bounded regardless of asset count (select_related covers
    task / project / uploader)."""
    for i in range(8):
        _make_file(task, name=f"f{i}.pdf", uploader=member, when=_at(2 * i))
        _make_link(task, url=f"https://github.com/x/y/pull/{i}", when=_at(2 * i + 1))

    with django_assert_max_num_queries(8):
        resp = _client(member).get(_project_url(project), {"page_size": 50})
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 16


def test_workspace_mine_no_n_plus_one_across_projects(
    calendar: Calendar, django_assert_max_num_queries: Any
) -> None:
    """The workspace `mine` path stays query-bounded as assets/projects grow.

    The `mine` filter adds a predicate on ``task`` (already select_related'd), so it
    must not introduce a per-row query. Locks the bound in against a future change to
    the source querysets that forgets to keep the join covered.
    """
    program = Program.objects.create(name="Prog")
    user = User.objects.create_user(username="me", password="pw")
    projects = []
    for p in range(2):
        proj = Project.objects.create(
            name=f"P{p}", start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
        )
        ProjectMembership.objects.create(project=proj, user=user, role=Role.MEMBER)
        my_task = Task.objects.create(project=proj, name=f"Mine{p}", duration=1, assignee=user)
        for i in range(4):
            _make_file(my_task, name=f"p{p}-f{i}.pdf", uploader=user, when=_at(10 * p + 2 * i))
            _make_link(
                my_task, url=f"https://github.com/{p}/x/pull/{i}", when=_at(10 * p + 2 * i + 1)
            )
        projects.append(proj)

    # Membership resolution + two source queries — bounded regardless of asset count.
    with django_assert_max_num_queries(8):
        resp = _client(user).get(WORKSPACE_URL, {"mine": "true", "page_size": 50})
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 16
