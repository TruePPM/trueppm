"""Commitment-slip gate (ADR-1485 D1, D10).

A date write that moves a committed ACTIVE-sprint task's finish past the sprint end
applies only for an accept-authority holder (with a reason). Anyone else, and every
API token, gets the write deferred: a PENDING ``slip`` row and a conflict carrying
``commitment_slip_requires_acceptance``, on every date-write path.
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.agents.models import AgentAction, AgentActionVerdict
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    ApiToken,
    Calendar,
    Project,
    ScopeChangeKind,
    ScopeChangeStatus,
    Sprint,
    SprintScopeChange,
    SprintState,
    Task,
    TaskNote,
)
from trueppm_api.apps.projects.services import (
    COMMITMENT_SLIP_CODE,
    accept_scope_change,
    reject_scope_change,
)
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()

SPRINT_START = date(2026, 1, 5)  # Monday
SPRINT_END = date(2026, 1, 16)  # Friday


@pytest.fixture(autouse=True)
def _no_broker() -> Any:
    with (
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
    ):
        yield


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Slip", start_date=date(2026, 1, 1), calendar=cal)


def _user(project: Project, name: str, role: int) -> Any:
    user = User.objects.create_user(username=name, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


@pytest.fixture
def admin(project: Project) -> Any:
    return _user(project, "slip_admin", Role.ADMIN)


@pytest.fixture
def member(project: Project) -> Any:
    # A Member edits the tasks assigned to them and is below the accept authority.
    return _user(project, "slip_member", Role.MEMBER)


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 4",
        start_date=SPRINT_START,
        finish_date=SPRINT_END,
        state=SprintState.ACTIVE,
    )


def _committed(project: Project, sprint: Sprint, name: str = "Committed") -> Task:
    # Assigned to the Member (when that fixture is in play) so they may edit it.
    return Task.objects.create(
        project=project,
        name=name,
        planned_start=SPRINT_START,
        duration=3,
        sprint=sprint,
        assignee=User.objects.filter(username="slip_member").first(),
    )


def _client(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _patch(client: APIClient, task: Task, body: dict[str, Any]) -> Any:
    return client.patch(f"/api/v1/tasks/{task.pk}/", body, format="json")


def _personal_token(owner: Any) -> str:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="slip-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
    )
    return raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


# --------------------------------------------------------------------------- #
# PATCH
# --------------------------------------------------------------------------- #


def test_member_slip_is_not_applied_and_records_pending(
    project: Project, sprint: Sprint, member: Any
) -> None:
    task = _committed(project, sprint)
    res = _patch(_client(member), task, {"duration": 15})
    assert res.status_code == 409, res.data
    assert res.data["code"] == COMMITMENT_SLIP_CODE
    assert res.data["sprint_name"] == "Sprint 4"
    task.refresh_from_db()
    assert task.duration == 3
    row = SprintScopeChange.objects.get(pk=res.data["scope_change_id"])
    assert row.kind == ScopeChangeKind.SLIP
    assert row.status == ScopeChangeStatus.PENDING
    assert row.proposed_duration == 15
    assert row.proposed_finish is not None and row.proposed_finish > SPRINT_END
    assert row.added_by == member
    # A slip is a date decision, not a membership change.
    assert task.sprint_pending is False


def test_planned_finish_input_is_guarded(project: Project, sprint: Sprint, member: Any) -> None:
    task = _committed(project, sprint)
    res = _patch(_client(member), task, {"planned_finish": "2026-01-23"})
    assert res.status_code == 409, res.data
    assert SprintScopeChange.objects.get(pk=res.data["scope_change_id"]).proposed_finish == date(
        2026, 1, 23
    )


def test_a_move_inside_the_sprint_is_not_a_slip(
    project: Project, sprint: Sprint, member: Any
) -> None:
    task = _committed(project, sprint)
    res = _patch(_client(member), task, {"duration": 5})
    assert res.status_code == 200, res.data
    assert not SprintScopeChange.objects.filter(kind=ScopeChangeKind.SLIP).exists()


def test_uncommitted_pending_task_is_not_guarded(
    project: Project, sprint: Sprint, member: Any
) -> None:
    task = _committed(project, sprint)
    Task.objects.filter(pk=task.pk).update(sprint_pending=True)
    res = _patch(_client(member), task, {"duration": 15})
    assert res.status_code == 200, res.data


def test_admin_slip_needs_a_reason(project: Project, sprint: Sprint, admin: Any) -> None:
    task = _committed(project, sprint)
    res = _patch(_client(admin), task, {"duration": 15})
    assert res.status_code == 400, res.data
    assert "slip_reason" in res.data
    task.refresh_from_db()
    assert task.duration == 3


def test_admin_slip_with_reason_applies_and_records_accepted(
    project: Project, sprint: Sprint, admin: Any
) -> None:
    task = _committed(project, sprint)
    res = _patch(_client(admin), task, {"duration": 15, "slip_reason": "Vendor late"})
    assert res.status_code == 200, res.data
    task.refresh_from_db()
    assert task.duration == 15
    row = SprintScopeChange.objects.get(task=task, kind=ScopeChangeKind.SLIP)
    assert row.status == ScopeChangeStatus.ACCEPTED
    assert row.reason == "Vendor late"
    assert row.decided_by == admin


# --------------------------------------------------------------------------- #
# Bulk edit and sync push
# --------------------------------------------------------------------------- #


def test_bulk_slips_share_one_batch_and_are_not_applied(
    project: Project, sprint: Sprint, member: Any
) -> None:
    a = _committed(project, sprint, "A")
    b = _committed(project, sprint, "B")
    ops = [{"op": "update", "id": str(t.pk), "data": {"duration": 20}} for t in (a, b)]
    res = _client(member).post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/", {"operations": ops}, format="json"
    )
    assert res.status_code in (200, 207), res.data
    codes = {r["code"] for r in res.data["rejected"]}
    assert codes == {COMMITMENT_SLIP_CODE}
    rows = SprintScopeChange.objects.filter(kind=ScopeChangeKind.SLIP)
    assert rows.count() == 2
    assert len({r.batch_id for r in rows}) == 1
    a.refresh_from_db()
    assert a.duration == 3


def test_sync_push_returns_a_conflict_with_the_code(
    project: Project, sprint: Sprint, member: Any
) -> None:
    task = _committed(project, sprint)
    payload = {
        "client_batch_id": "6f1c9a52-6c55-4f0e-9d0b-2f5f9a1d3c01",
        "changes": {
            "tasks": {
                "created": [],
                "updated": [{"id": str(task.pk), "duration": 20}],
                "deleted": [],
            }
        },
    }
    res = _client(member).post(f"/api/v1/projects/{project.pk}/sync/", payload, format="json")
    assert res.status_code == 200, res.data
    conflicts = res.data["conflicts"]["tasks"]
    assert conflicts and conflicts[0]["code"] == COMMITMENT_SLIP_CODE
    task.refresh_from_db()
    assert task.duration == 3


# --------------------------------------------------------------------------- #
# Decisions
# --------------------------------------------------------------------------- #


def _pending_slip(project: Project, sprint: Sprint, member: Any) -> tuple[Task, SprintScopeChange]:
    task = _committed(project, sprint)
    res = _patch(_client(member), task, {"duration": 15})
    assert res.status_code == 409
    return task, SprintScopeChange.objects.get(pk=res.data["scope_change_id"])


def test_accept_applies_the_stored_dates_and_double_accept_is_a_noop(
    project: Project, sprint: Sprint, member: Any, admin: Any
) -> None:
    task, row = _pending_slip(project, sprint, member)
    accept_scope_change(row, admin, reason="OK, it slips")
    task.refresh_from_db()
    assert task.duration == 15
    row.refresh_from_db()
    assert row.status == ScopeChangeStatus.ACCEPTED
    assert row.decision_reason == "OK, it slips"
    # Second accept: no-op, dates untouched.
    Task.objects.filter(pk=task.pk).update(duration=7)
    res = _client(admin).post(f"/api/v1/scope-changes/{row.pk}/accept/", {}, format="json")
    assert res.status_code == 200
    task.refresh_from_db()
    assert task.duration == 7


def test_reject_discards_the_dates_and_keeps_the_task_in_the_sprint(
    project: Project, sprint: Sprint, member: Any, admin: Any
) -> None:
    task, row = _pending_slip(project, sprint, member)
    reject_scope_change(row, admin, reason="Hold the date")
    task.refresh_from_db()
    assert task.duration == 3
    assert task.sprint_id == sprint.pk
    row.refresh_from_db()
    assert row.status == ScopeChangeStatus.REJECTED
    assert row.decision_reason == "Hold the date"


def test_member_cannot_accept_a_slip(project: Project, sprint: Sprint, member: Any) -> None:
    _task, row = _pending_slip(project, sprint, member)
    res = _client(member).post(f"/api/v1/scope-changes/{row.pk}/accept/", {}, format="json")
    assert res.status_code == 403


def test_batch_accept_by_batch_id(
    project: Project, sprint: Sprint, member: Any, admin: Any
) -> None:
    a = _committed(project, sprint, "A")
    b = _committed(project, sprint, "B")
    ops = [{"op": "update", "id": str(t.pk), "data": {"duration": 20}} for t in (a, b)]
    _client(member).post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/", {"operations": ops}, format="json"
    )
    batch_id = SprintScopeChange.objects.filter(kind=ScopeChangeKind.SLIP).first().batch_id
    res = _client(admin).post(
        f"/api/v1/sprints/{sprint.pk}/scope-changes/accept/",
        {"batch_id": str(batch_id), "reason": "Both slip"},
        format="json",
    )
    assert res.status_code == 200, res.data
    assert len(res.data["accepted"]) == 2
    a.refresh_from_db()
    b.refresh_from_db()
    assert a.duration == 20 and b.duration == 20


def test_batch_reject_by_batch_id(
    project: Project, sprint: Sprint, member: Any, admin: Any
) -> None:
    a = _committed(project, sprint, "A")
    ops = [{"op": "update", "id": str(a.pk), "data": {"duration": 20}}]
    _client(member).post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/", {"operations": ops}, format="json"
    )
    batch_id = SprintScopeChange.objects.get(kind=ScopeChangeKind.SLIP).batch_id
    res = _client(admin).post(
        f"/api/v1/sprints/{sprint.pk}/scope-changes/reject/",
        {"batch_id": str(batch_id)},
        format="json",
    )
    assert res.status_code == 200, res.data
    assert len(res.data["rejected"]) == 1
    a.refresh_from_db()
    assert a.duration == 3


# --------------------------------------------------------------------------- #
# Tokens (D1 human-only decisions, D10 audit)
# --------------------------------------------------------------------------- #


def test_token_slip_is_deferred_even_for_an_admin_owner(
    project: Project, sprint: Sprint, admin: Any
) -> None:
    task = _committed(project, sprint)
    raw = _personal_token(admin)
    res = _patch(_bearer(raw), task, {"duration": 15, "slip_reason": "bot says so"})
    assert res.status_code == 409, res.data
    task.refresh_from_db()
    assert task.duration == 3
    assert AgentAction.objects.filter(verdict=AgentActionVerdict.REQUIRES_APPROVAL).exists()


@pytest.mark.parametrize("verb", ["accept", "reject"])
def test_token_cannot_decide_a_single_row(
    project: Project, sprint: Sprint, member: Any, admin: Any, verb: str
) -> None:
    _task, row = _pending_slip(project, sprint, member)
    raw = _personal_token(admin)
    res = _bearer(raw).post(f"/api/v1/scope-changes/{row.pk}/{verb}/", {}, format="json")
    assert res.status_code == 403
    row.refresh_from_db()
    assert row.status == ScopeChangeStatus.PENDING
    refused = AgentAction.objects.filter(verdict=AgentActionVerdict.REFUSED)
    assert refused.filter(refusal_reason="identity").exists()


@pytest.mark.parametrize("verb", ["accept", "reject"])
def test_token_cannot_decide_a_batch(
    project: Project, sprint: Sprint, member: Any, admin: Any, verb: str
) -> None:
    _task, row = _pending_slip(project, sprint, member)
    raw = _personal_token(admin)
    res = _bearer(raw).post(f"/api/v1/sprints/{sprint.pk}/scope-changes/{verb}/", {}, format="json")
    assert res.status_code == 403
    row.refresh_from_db()
    assert row.status == ScopeChangeStatus.PENDING
    refused = AgentAction.objects.filter(verdict=AgentActionVerdict.REFUSED)
    assert refused.filter(refusal_reason="identity").exists()


# --------------------------------------------------------------------------- #
# Authority includes the SM/PO facet (ADR-1485 D1 amendment, #1140)
# --------------------------------------------------------------------------- #


def _product_owner(project: Project) -> Any:
    po = _user(project, "slip_po", Role.MEMBER)
    team = Team.objects.create(
        project=project, is_default=True, name="Default Team", short_id="T01", server_version=1
    )
    TeamMembership.objects.create(team=team, user=po, role=TeamRole.MEMBER, is_product_owner=True)
    return po


def test_product_owner_below_admin_can_apply_a_slip(project: Project, sprint: Sprint) -> None:
    po = _product_owner(project)
    task = Task.objects.create(
        project=project,
        name="PO task",
        planned_start=SPRINT_START,
        duration=3,
        sprint=sprint,
        assignee=po,
    )
    res = _patch(_client(po), task, {"duration": 15, "slip_reason": "Scope trade-off"})
    assert res.status_code == 200, res.data
    row = SprintScopeChange.objects.get(task=task, kind=ScopeChangeKind.SLIP)
    assert row.status == ScopeChangeStatus.ACCEPTED


def test_product_owner_below_admin_can_decide_a_slip(
    project: Project, sprint: Sprint, member: Any
) -> None:
    po = _product_owner(project)
    task, row = _pending_slip(project, sprint, member)
    res = _client(po).post(
        f"/api/v1/scope-changes/{row.pk}/accept/", {"reason": "PO accepts"}, format="json"
    )
    assert res.status_code == 200, res.data
    task.refresh_from_db()
    assert task.duration == 15


# --------------------------------------------------------------------------- #
# D10: reasons feed the Decisions view (ADR-0167)
# --------------------------------------------------------------------------- #


def test_decision_reasons_become_decision_notes(
    project: Project, sprint: Sprint, member: Any, admin: Any
) -> None:
    from trueppm_api.apps.projects.decisions_services import decision_notes_queryset

    _task, row = _pending_slip(project, sprint, member)
    reject_scope_change(row, admin, reason="Hold the date")
    notes = list(decision_notes_queryset(project.pk))
    assert [n.body for n in notes] == ["Commitment slip rejected for Sprint 4: Hold the date"]
    assert notes[0].author == admin


def test_a_decision_without_a_reason_adds_no_note(
    project: Project, sprint: Sprint, member: Any, admin: Any
) -> None:
    _task, row = _pending_slip(project, sprint, member)
    accept_scope_change(row, admin)
    assert not TaskNote.objects.filter(decision=True).exists()


# --------------------------------------------------------------------------- #
# Every date-write route answers a non-authority slip with the code
# --------------------------------------------------------------------------- #


def _via_patch(client: APIClient, project: Project, task: Task) -> str:
    res = _patch(client, task, {"duration": 15})
    assert res.status_code == 409, res.data
    return str(res.data["code"])


def _via_bulk(client: APIClient, project: Project, task: Task) -> str:
    ops = [{"op": "update", "id": str(task.pk), "data": {"duration": 15}}]
    res = client.post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/", {"operations": ops}, format="json"
    )
    return str(res.data["rejected"][0]["code"])


def _via_sync(client: APIClient, project: Project, task: Task) -> str:
    payload = {
        "client_batch_id": "6f1c9a52-6c55-4f0e-9d0b-2f5f9a1d3c02",
        "changes": {
            "tasks": {
                "created": [],
                "updated": [{"id": str(task.pk), "duration": 15}],
                "deleted": [],
            }
        },
    }
    res = client.post(f"/api/v1/projects/{project.pk}/sync/", payload, format="json")
    return str(res.data["conflicts"]["tasks"][0]["code"])


@pytest.mark.parametrize(
    "route",
    [_via_patch, _via_bulk, _via_sync],
    ids=["PATCH tasks/{id}/", "POST projects/{id}/tasks/bulk/", "POST projects/{id}/sync/"],
)
def test_every_date_write_route_defers_a_non_authority_slip(
    project: Project, sprint: Sprint, member: Any, route: Any
) -> None:
    """The date-write route table (ADR-1485 D1). Token and agent writes reach these
    same routes; "Schedule selected…" placement (D5) does not exist yet."""
    task = _committed(project, sprint)
    assert route(_client(member), project, task) == COMMITMENT_SLIP_CODE
    task.refresh_from_db()
    assert task.duration == 3
    assert SprintScopeChange.objects.filter(
        task=task, kind=ScopeChangeKind.SLIP, status=ScopeChangeStatus.PENDING
    ).exists()
