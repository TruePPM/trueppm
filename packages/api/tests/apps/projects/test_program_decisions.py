"""Tests for the program decision log (ADR-1310, #4772).

Covers:
- The 5-role RBAC matrix: Viewer reads, Team Member+ writes, Program Manager+
  deletes, non-members get 403, closed programs refuse writes.
- Happy path create / list / patch, with the server-stamped ``decided_at``.
- The status machine, including the refused made → withdrawn shortcut.
- Cross-program refusal for owner, linked task and linked risk.
- Link disclosure: a program member outside the linked project sees the link,
  not its name.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Program,
    ProgramDecision,
    ProgramDecisionStatus,
    Project,
    Risk,
    Task,
)

User = get_user_model()


def _client(user: object) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _url(program: Program, pk: object | None = None) -> str:
    base = f"/api/v1/programs/{program.id}/decisions/"
    return f"{base}{pk}/" if pk else base


@pytest.fixture
def users(db: object) -> dict[str, Any]:
    names = ["owner", "admin", "scheduler", "member", "viewer", "stranger"]
    return {n: User.objects.create_user(username=n, password="pw") for n in names}


@pytest.fixture
def program(users: dict[str, Any]) -> Program:
    program = Program.objects.create(name="Apollo", code="APOLLO")
    for name, role in [
        ("owner", Role.OWNER),
        ("admin", Role.ADMIN),
        ("scheduler", Role.SCHEDULER),
        ("member", Role.MEMBER),
        ("viewer", Role.VIEWER),
    ]:
        ProgramMembership.objects.create(program=program, user=users[name], role=role)
    return program


@pytest.fixture
def project(program: Program, users: dict[str, Any]) -> Project:
    project = Project.objects.create(
        name="Ares", code="ARES", start_date="2026-01-05", program=program
    )
    ProjectMembership.objects.create(project=project, user=users["member"], role=Role.MEMBER)
    return project


@pytest.fixture
def decision(program: Program, users: dict[str, Any]) -> ProgramDecision:
    return ProgramDecision.objects.create(
        program=program, title="Pick a vendor", owner=users["member"]
    )


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("name", ["owner", "admin", "scheduler", "member", "viewer"])
def test_every_program_role_can_read(
    name: str, program: Program, users: dict[str, Any], decision: ProgramDecision
) -> None:
    client = _client(users[name])
    assert client.get(_url(program)).status_code == 200
    assert client.get(_url(program, decision.id)).status_code == 200


@pytest.mark.django_db
def test_non_member_is_refused_every_action(
    program: Program, users: dict[str, Any], decision: ProgramDecision
) -> None:
    client = _client(users["stranger"])
    assert client.get(_url(program)).status_code == 403
    assert client.get(_url(program, decision.id)).status_code == 403
    assert client.post(_url(program), {"title": "x"}, format="json").status_code == 403
    assert (
        client.patch(_url(program, decision.id), {"title": "x"}, format="json").status_code == 403
    )
    assert client.delete(_url(program, decision.id)).status_code == 403


@pytest.mark.django_db
def test_unauthenticated_is_refused(program: Program) -> None:
    assert APIClient().get(_url(program)).status_code == 401


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("name", "expected"),
    [("owner", 201), ("admin", 201), ("scheduler", 201), ("member", 201), ("viewer", 403)],
)
def test_create_requires_team_member(
    name: str, expected: int, program: Program, users: dict[str, Any]
) -> None:
    response = _client(users[name]).post(_url(program), {"title": "Go/no-go"}, format="json")
    assert response.status_code == expected


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("name", "expected"),
    [("owner", 200), ("admin", 200), ("scheduler", 200), ("member", 200), ("viewer", 403)],
)
def test_update_requires_team_member(
    name: str, expected: int, program: Program, users: dict[str, Any], decision: ProgramDecision
) -> None:
    response = _client(users[name]).patch(
        _url(program, decision.id), {"title": "Renamed"}, format="json"
    )
    assert response.status_code == expected


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("name", "expected"),
    [("owner", 204), ("admin", 204), ("scheduler", 403), ("member", 403), ("viewer", 403)],
)
def test_delete_requires_program_manager(
    name: str, expected: int, program: Program, users: dict[str, Any], decision: ProgramDecision
) -> None:
    response = _client(users[name]).delete(_url(program, decision.id))
    assert response.status_code == expected
    decision.refresh_from_db()
    assert decision.is_deleted is (expected == 204)


@pytest.mark.django_db
def test_closed_program_refuses_writes_but_allows_reads(
    program: Program, users: dict[str, Any], decision: ProgramDecision
) -> None:
    Program.objects.filter(pk=program.pk).update(is_closed=True)
    client = _client(users["owner"])
    assert client.get(_url(program)).status_code == 200
    assert client.post(_url(program), {"title": "x"}, format="json").status_code == 403
    assert (
        client.patch(_url(program, decision.id), {"title": "x"}, format="json").status_code == 403
    )
    assert client.delete(_url(program, decision.id)).status_code == 403


@pytest.mark.django_db
def test_decision_in_another_program_is_not_reachable(
    program: Program, users: dict[str, Any]
) -> None:
    other = Program.objects.create(name="Other", code="OTHER")
    foreign = ProgramDecision.objects.create(program=other, title="Theirs")
    client = _client(users["owner"])
    assert client.get(_url(program, foreign.id)).status_code == 404
    assert client.patch(_url(program, foreign.id), {"title": "x"}, format="json").status_code == 404
    assert [r["id"] for r in client.get(_url(program)).json()["results"]] == []


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_binds_program_and_creator(program: Program, users: dict[str, Any]) -> None:
    other = Program.objects.create(name="Other", code="OTHER")
    response = _client(users["member"]).post(
        _url(program),
        {
            "title": "  Choose cloud region  ",
            "owner": users["admin"].id,
            "due_date": "2026-11-20",
            "impact_note": "recovers 2 days",
            "program": str(other.id),
        },
        format="json",
    )
    assert response.status_code == 201, response.json()
    body = response.json()
    assert body["program"] == str(program.id)
    assert body["title"] == "Choose cloud region"
    assert body["status"] == "awaiting"
    assert body["decided_at"] is None
    assert body["owner_detail"]["username"] == "admin"
    assert body["impact_note"] == "recovers 2 days"
    assert body["link"] is None
    assert body["created_by"] == users["member"].id


@pytest.mark.django_db
def test_blank_title_is_refused(program: Program, users: dict[str, Any]) -> None:
    response = _client(users["member"]).post(_url(program), {"title": "   "}, format="json")
    assert response.status_code == 400
    assert "title" in response.json()


@pytest.mark.django_db
def test_list_filters_by_status_and_orders(program: Program, users: dict[str, Any]) -> None:
    late = ProgramDecision.objects.create(program=program, title="late", due_date="2026-12-01")
    undated = ProgramDecision.objects.create(program=program, title="undated")
    soon = ProgramDecision.objects.create(program=program, title="soon", due_date="2026-11-01")
    ProgramDecision.objects.create(program=program, title="made", status="made")
    ProgramDecision.objects.create(program=program, title="gone", is_deleted=True)

    client = _client(users["viewer"])
    awaiting = client.get(_url(program), {"status": "awaiting"}).json()["results"]
    assert [r["id"] for r in awaiting] == [str(soon.id), str(late.id), str(undated.id)]
    made = client.get(_url(program), {"status": "made"}).json()["results"]
    assert [r["title"] for r in made] == ["made"]
    assert client.get(_url(program)).json()["count"] == 4


@pytest.mark.django_db
def test_unknown_status_filter_is_refused(program: Program, users: dict[str, Any]) -> None:
    response = _client(users["viewer"]).get(_url(program), {"status": "maybe"})
    assert response.status_code == 400


@pytest.mark.django_db
def test_list_query_count_is_flat(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    """Owner, link and the link-disclosure set must not cost a query per row.

    The rows added between the two reads are LINKED (one task, one risk), each with a
    distinct owner: an unlinked extra row could not reveal a per-link lookup.
    """
    for i in range(3):
        task = Task.objects.create(project=project, name=f"t{i}", wbs_path=f"1.{i + 1}")
        ProgramDecision.objects.create(
            program=program, title=f"d{i}", owner=users["member"], linked_task=task
        )
    risk = Risk.objects.create(project=project, title="r0", probability=3, impact=3)
    ProgramDecision.objects.create(program=program, title="r", linked_risk=risk)
    client = _client(users["member"])
    with CaptureQueriesContext(connection) as few:
        client.get(_url(program))
    extra_task = Task.objects.create(project=project, name="extra", wbs_path="2.1")
    extra_risk = Risk.objects.create(project=project, title="r1", probability=3, impact=3)
    ProgramDecision.objects.create(
        program=program, title="extra-t", owner=users["admin"], linked_task=extra_task
    )
    ProgramDecision.objects.create(
        program=program, title="extra-r", owner=users["owner"], linked_risk=extra_risk
    )
    with CaptureQueriesContext(connection) as more:
        response = client.get(_url(program))
    assert response.json()["count"] == 6
    assert len(more.captured_queries) == len(few.captured_queries)


# ---------------------------------------------------------------------------
# Status transitions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_mark_made_stamps_decided_at_and_reopen_clears_it(
    program: Program, users: dict[str, Any], decision: ProgramDecision
) -> None:
    client = _client(users["member"])
    made = client.patch(_url(program, decision.id), {"status": "made"}, format="json")
    assert made.status_code == 200
    assert made.json()["decided_at"] is not None

    reopened = client.patch(_url(program, decision.id), {"status": "awaiting"}, format="json")
    assert reopened.status_code == 200
    assert reopened.json()["decided_at"] is None


@pytest.mark.django_db
def test_decided_at_is_not_client_writable(
    program: Program, users: dict[str, Any], decision: ProgramDecision
) -> None:
    response = _client(users["member"]).patch(
        _url(program, decision.id), {"decided_at": "2020-01-01T00:00:00Z"}, format="json"
    )
    assert response.status_code == 200
    assert response.json()["decided_at"] is None


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("start", "target", "ok"),
    [
        ("awaiting", "made", True),
        ("awaiting", "withdrawn", True),
        ("made", "awaiting", True),
        ("withdrawn", "awaiting", True),
        ("made", "withdrawn", False),
        ("withdrawn", "made", False),
        ("made", "made", True),
    ],
)
def test_status_transition_matrix(
    start: str, target: str, ok: bool, program: Program, users: dict[str, Any]
) -> None:
    decision = ProgramDecision.objects.create(program=program, title="t", status=start)
    response = _client(users["member"]).patch(
        _url(program, decision.id), {"status": target}, format="json"
    )
    assert (response.status_code == 200) is ok, response.json()
    decision.refresh_from_db()
    assert decision.status == (target if ok else start)


@pytest.mark.django_db
def test_create_as_made_is_allowed_but_not_withdrawn(
    program: Program, users: dict[str, Any]
) -> None:
    client = _client(users["member"])
    made = client.post(_url(program), {"title": "Done", "status": "made"}, format="json")
    assert made.status_code == 201
    assert made.json()["decided_at"] is not None
    withdrawn = client.post(_url(program), {"title": "x", "status": "withdrawn"}, format="json")
    assert withdrawn.status_code == 400


# ---------------------------------------------------------------------------
# Links and owner — cross-program refusal and disclosure
# ---------------------------------------------------------------------------


@pytest.fixture
def foreign_project(users: dict[str, Any]) -> Project:
    other = Program.objects.create(name="Other", code="OTHER")
    project = Project.objects.create(
        name="Elsewhere", code="ELSE", start_date="2026-01-05", program=other
    )
    # The writer IS a member of the foreign project: the refusal must come from
    # the program boundary, not from missing project access.
    ProjectMembership.objects.create(project=project, user=users["member"], role=Role.OWNER)
    return project


@pytest.mark.django_db
def test_task_in_another_program_is_refused(
    program: Program, users: dict[str, Any], foreign_project: Project
) -> None:
    task = Task.objects.create(project=foreign_project, name="Foreign", wbs_path="1.1")
    response = _client(users["member"]).post(
        _url(program), {"title": "x", "linked_task": str(task.id)}, format="json"
    )
    assert response.status_code == 400
    assert "linked_task" in response.json()


@pytest.mark.django_db
def test_risk_in_another_program_is_refused(
    program: Program, users: dict[str, Any], foreign_project: Project
) -> None:
    risk = Risk.objects.create(project=foreign_project, title="R", probability=3, impact=3)
    response = _client(users["member"]).post(
        _url(program), {"title": "x", "linked_risk": str(risk.id)}, format="json"
    )
    assert response.status_code == 400
    assert "linked_risk" in response.json()


@pytest.mark.django_db
def test_owner_outside_the_program_is_refused(program: Program, users: dict[str, Any]) -> None:
    response = _client(users["member"]).post(
        _url(program), {"title": "x", "owner": users["stranger"].id}, format="json"
    )
    assert response.status_code == 400
    assert "owner" in response.json()


@pytest.mark.django_db
def test_task_and_risk_together_is_refused(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    task = Task.objects.create(project=project, name="T", wbs_path="1.1")
    risk = Risk.objects.create(project=project, title="R", probability=3, impact=3)
    response = _client(users["member"]).post(
        _url(program),
        {"title": "x", "linked_task": str(task.id), "linked_risk": str(risk.id)},
        format="json",
    )
    assert response.status_code == 400


@pytest.mark.django_db
def test_link_in_own_program_is_accepted_and_titled(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    risk = Risk.objects.create(project=project, title="Vendor slip", probability=3, impact=3)
    response = _client(users["member"]).post(
        _url(program), {"title": "x", "linked_risk": str(risk.id)}, format="json"
    )
    assert response.status_code == 201, response.json()
    link = response.json()["link"]
    assert link["kind"] == "risk"
    assert link["title"] == "Vendor slip"
    assert link["project_id"] == str(project.id)
    # The display reference the risk's own page shows, not the stored decimal.
    assert risk.short_id.isdigit()
    assert link["short_id"] == f"R-{int(risk.short_id):03d}"


@pytest.mark.django_db
def test_task_link_short_id_is_the_display_form(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    """A task's stored short_id is 8-char hex; the link must read ``T-<n>``."""
    tasks = [
        Task.objects.create(project=project, name=f"t{i}", wbs_path=f"1.{i + 1}") for i in range(10)
    ]
    tenth = tasks[-1]
    assert len(tenth.short_id) == 8  # e.g. 0000000A: the raw form must never surface
    decision = ProgramDecision.objects.create(program=program, title="x", linked_task=tenth)
    link = _client(users["member"]).get(_url(program, decision.id)).json()["link"]
    assert link["short_id"] == f"T-{int(tenth.short_id, 16)}"
    assert link["short_id"] != tenth.short_id


@pytest.mark.django_db
def test_linking_work_in_a_project_the_writer_cannot_read_is_refused(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    """`admin` is a Program Manager but not a member of the project."""
    task = Task.objects.create(project=project, name="Hidden", wbs_path="1.1")
    response = _client(users["admin"]).post(
        _url(program), {"title": "x", "linked_task": str(task.id)}, format="json"
    )
    assert response.status_code == 400
    assert "linked_task" in response.json()


@pytest.mark.django_db
def test_link_name_is_withheld_from_non_project_member(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    task = Task.objects.create(project=project, name="Hidden name", wbs_path="1.1")
    decision = ProgramDecision.objects.create(program=program, title="x", linked_task=task)

    hidden = _client(users["viewer"]).get(_url(program, decision.id)).json()["link"]
    assert hidden["id"] == str(task.id)
    assert hidden["title"] is None
    assert hidden["short_id"] is None

    shown = _client(users["member"]).get(_url(program, decision.id)).json()["link"]
    assert shown["title"] == "Hidden name"


@pytest.mark.django_db
def test_editing_title_does_not_recheck_an_existing_link(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    """A Program Manager outside the linked project can still edit the decision."""
    task = Task.objects.create(project=project, name="T", wbs_path="1.1")
    decision = ProgramDecision.objects.create(program=program, title="x", linked_task=task)
    response = _client(users["admin"]).patch(
        _url(program, decision.id), {"title": "renamed"}, format="json"
    )
    assert response.status_code == 200, response.json()


@pytest.mark.django_db
def test_soft_deleted_task_cannot_be_linked(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    task = Task.objects.create(project=project, name="Gone", wbs_path="1.1")
    task.soft_delete()
    response = _client(users["member"]).post(
        _url(program), {"title": "x", "linked_task": str(task.id)}, format="json"
    )
    assert response.status_code == 400
    assert "linked_task" in response.json()


@pytest.mark.django_db
def test_task_in_a_soft_deleted_project_cannot_be_linked(
    program: Program, users: dict[str, Any], project: Project
) -> None:
    task = Task.objects.create(project=project, name="T", wbs_path="1.1")
    risk = Risk.objects.create(project=project, title="R", probability=3, impact=3)
    Project.objects.filter(pk=project.pk).update(is_deleted=True)
    client = _client(users["member"])
    by_task = client.post(_url(program), {"title": "x", "linked_task": str(task.id)}, format="json")
    assert by_task.status_code == 400
    assert "linked_task" in by_task.json()
    by_risk = client.post(_url(program), {"title": "x", "linked_risk": str(risk.id)}, format="json")
    assert by_risk.status_code == 400
    assert "linked_risk" in by_risk.json()


@pytest.mark.django_db
def test_workspace_archive_includes_the_decision_log(
    program: Program, users: dict[str, Any], decision: ProgramDecision
) -> None:
    """The admin backup must not silently drop the program decision log."""
    import io
    import json
    import tarfile

    from django.core.files.storage import default_storage

    from trueppm_api.apps.workspace.export import build_and_store_archive

    path, _size = build_and_store_archive("program-decisions-test")
    try:
        with default_storage.open(path, "rb") as fh:
            raw = fh.read()
    finally:
        default_storage.delete(path)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        member = tar.extractfile("programs/decisions.json")
        assert member is not None
        rows = json.loads(member.read())
    (row,) = [r for r in rows if r["id"] == str(decision.id)]
    assert row["title"] == "Pick a vendor"
    assert row["program_id"] == str(program.id)
    assert row["status"] == "awaiting"


@pytest.mark.django_db
def test_status_choices_are_the_documented_three() -> None:
    assert set(ProgramDecisionStatus.values) == {"awaiting", "made", "withdrawn"}
