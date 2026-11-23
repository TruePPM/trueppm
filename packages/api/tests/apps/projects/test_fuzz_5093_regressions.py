"""Regressions for the real 500s the first untruncated ``api:fuzz`` nightly reported (#5093).

Each case is the minimal deterministic reproduction of an operation Schemathesis drove
into an unhandled server error: a bad ``parent_path`` reaching an ltree cast, a root
number allocated from a live-root count (collides on gapped numbering), and label and
workspace-group routes answering a verb their handler cannot take.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Label,
    Project,
    Sprint,
    SprintState,
    Task,
)

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="Fuzz", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="Std")
    )


@pytest.fixture
def client(project: Project) -> APIClient:
    user = User.objects.create_user(username="fuzz-owner", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
@pytest.mark.parametrize("bad", ["\x1b", "a.b", "1..2", "1.", "1 2", "-1", "1.x"])
def test_reorder_rejects_a_non_ltree_parent_path_with_400(
    client: APIClient, project: Project, bad: str
) -> None:
    task = Task.objects.create(project=project, name="T", duration=1, wbs_path="1")
    resp = client.post(
        f"/api/v1/projects/{project.pk}/tasks/reorder/",
        {"parent_path": bad, "ordered_ids": [str(task.pk)]},
        format="json",
    )
    assert resp.status_code == 400
    assert "parent_path" in resp.data


@pytest.mark.django_db
def test_phase_create_numbers_past_a_gap_in_root_numbering(
    client: APIClient, project: Project
) -> None:
    # Roots 1 and 3 are live: a live-root count (2) would hand out "3" onto a live row.
    Task.objects.create(project=project, name="A", duration=1, wbs_path="1")
    Task.objects.create(project=project, name="C", duration=1, wbs_path="3")
    resp = client.post(
        f"/api/v1/projects/{project.pk}/phases/", {"name": "New phase"}, format="json"
    )
    assert resp.status_code == 201, resp.data
    assert Task.objects.get(pk=resp.data["id"]).wbs_path == "4"


@pytest.mark.django_db
def test_promote_to_milestone_numbers_past_a_gap_in_root_numbering(
    client: APIClient, project: Project
) -> None:
    Task.objects.create(project=project, name="A", duration=1, wbs_path="1")
    Task.objects.create(project=project, name="C", duration=1, wbs_path="3")
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        goal="Goal",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
    )
    resp = client.post(f"/api/v1/sprints/{sprint.pk}/promote-to-milestone/", {}, format="json")
    assert resp.status_code == 201, resp.data
    sprint.refresh_from_db()
    assert Task.objects.get(pk=sprint.target_milestone_id).wbs_path == "4"


@pytest.mark.django_db
def test_label_routes_refuse_the_verb_their_handler_cannot_take(
    client: APIClient, project: Project
) -> None:
    task = Task.objects.create(project=project, name="T", duration=1, wbs_path="1")
    label = Label.objects.create(project=project, name="L")
    base = f"/api/v1/projects/{project.pk}/tasks/{task.pk}/labels/"
    # Each used to raise TypeError (500): the handler signature lacked / required `label_id`.
    assert client.post(f"{base}{label.pk}/", {}, format="json").status_code == 405
    assert client.delete(base).status_code == 405
    # The supported verbs still work.
    assert client.post(base, {"label_id": str(label.pk)}, format="json").status_code == 200
    assert client.delete(f"{base}{label.pk}/").status_code == 204


@pytest.mark.django_db
def test_group_routes_refuse_the_verb_their_handler_cannot_take(project: Project) -> None:
    from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

    admin = User.objects.create_user(username="fuzz-ws-owner", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.OWNER
    )
    member = User.objects.create_user(username="fuzz-ws-member", password="pw")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=member, role=WorkspaceRole.MEMBER
    )
    c = APIClient()
    c.force_authenticate(user=admin)
    gid = c.post("/api/v1/workspace/groups/", {"name": "G"}, format="json").data["id"]
    members = f"/api/v1/workspace/groups/{gid}/members/"
    projects = f"/api/v1/workspace/groups/{gid}/projects/"
    # Each used to raise TypeError (500): the handler signature lacked / required the id.
    assert c.delete(members).status_code == 405
    assert c.post(f"{members}{member.pk}/", {}, format="json").status_code == 405
    assert c.delete(projects).status_code == 405
    assert c.post(f"{projects}{project.pk}/", {}, format="json").status_code == 405
    # The supported verbs still work.
    assert c.post(members, {"user": member.pk}, format="json").status_code == 201
    assert c.delete(f"{members}{member.pk}/").status_code == 204
    resp = c.post(projects, {"project": str(project.pk), "role": Role.MEMBER}, format="json")
    assert resp.status_code == 201, resp.data
    assert c.delete(f"{projects}{project.pk}/").status_code == 204


@pytest.mark.django_db
def test_phase_create_counts_the_cap_only_after_taking_the_project_lock(
    client: APIClient, project: Project
) -> None:
    """The PHASE_MAX count (and the priority_rank derived from it) must follow the
    Project ``FOR UPDATE``: an aggregate cannot carry the lock itself, so a count taken
    first let two concurrent creates at PHASE_MAX-1 both pass the cap."""
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    Task.objects.create(project=project, name="A", duration=1, wbs_path="1")
    with CaptureQueriesContext(connection) as ctx:
        resp = client.post(
            f"/api/v1/projects/{project.pk}/phases/", {"name": "New phase"}, format="json"
        )
    assert resp.status_code == 201, resp.data
    sqls = [q["sql"] for q in ctx.captured_queries]
    lock = next(
        i for i, q in enumerate(sqls) if 'FROM "projects_project"' in q and "FOR UPDATE" in q
    )
    count = next(i for i, q in enumerate(sqls) if "COUNT(*)" in q and 'FROM "projects_task"' in q)
    assert lock < count, (lock, count)
    assert Task.objects.get(pk=resp.data["id"]).priority_rank == 20


@pytest.mark.django_db
def test_phase_create_refuses_past_phase_max(
    client: APIClient, project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.projects import views as project_views

    monkeypatch.setattr(project_views, "PHASE_MAX", 2)
    Task.objects.create(project=project, name="A", duration=1, wbs_path="1")
    url = f"/api/v1/projects/{project.pk}/phases/"
    assert client.post(url, {"name": "B"}, format="json").status_code == 201
    resp = client.post(url, {"name": "C"}, format="json")
    assert resp.status_code == 400
    assert Task.objects.filter(project=project, is_deleted=False).count() == 2
