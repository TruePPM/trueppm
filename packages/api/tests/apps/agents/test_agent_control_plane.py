"""Agent control plane: pause, capability scope, revoke, visibility (#4814, #4757).

Folds in the threat-model requirements on #4814:

* the control plane refuses agent-authenticated requests (every endpoint);
* effective scope = grant ∩ the principal's *current* permissions, per call;
* ``write`` is not grantable in 0.5, enforced on the server;
* scope edits, pauses, resumes and revokes are recorded in the same hash chain;
* revoke and pause take effect on the very next call;
* the agent is told only a generic reason, never who paused it;
* the Agents list is filtered server-side by the viewer's project membership;
* refusal Inbox items are coalesced per (agent, constraint).
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionChainHead,
    AgentActionVerdict,
    AgentActorKind,
    RefusalConstraint,
)
from trueppm_api.apps.agents.services import record_agent_action, verify_chain
from trueppm_api.apps.notifications.models import Notification
from trueppm_api.apps.projects import agent_scope
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_API_FULL,
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Program,
    Project,
)
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

User = get_user_model()

CONTROL_ROUTES = [
    ("get", "/api/v1/agents/", None),
    ("get", "/api/v1/agents/audit-verify/", None),
    ("get", "/api/v1/agents/{id}/", None),
    ("post", "/api/v1/agents/{id}/pause/", {}),
    ("post", "/api/v1/agents/{id}/resume/", {}),
    ("patch", "/api/v1/agents/{id}/scope/", {"scope": {"schedule": "none"}}),
    ("post", "/api/v1/agents/{id}/revoke/", {}),
]


def _user(name: str) -> Any:
    return User.objects.create_user(username=f"{name}_{secrets.token_hex(3)}", password="pw")


def _project(name: str = "P", program: Program | None = None) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(
        name=name, start_date=date(2026, 4, 1), calendar=calendar, program=program
    )


def _mint(
    owner: Any, scopes: list[str] | None = None, name: str = "Claude"
) -> tuple[ApiToken, str]:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ApiToken.objects.create(
        owner=owner,
        name=name,
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=scopes or [SCOPE_MCP_READ],
    )
    return token, raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _as(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _overview(project: Project) -> str:
    return f"/api/v1/projects/{project.id}/overview/"


def _project_detail(project: Project) -> str:
    """A read the audit attributes to the project (the overview view carries no FK)."""
    return f"/api/v1/projects/{project.id}/"


@pytest.fixture
def world(db: object) -> dict[str, Any]:
    AgentActionChainHead.objects.get_or_create(pk=1)
    principal = _user("principal")
    program = Program.objects.create(name="Atlas")
    project = _project("Atlas A", program)
    ProjectMembership.objects.create(project=project, user=principal, role=Role.ADMIN)
    token, raw = _mint(principal)
    return {
        "principal": principal,
        "project": project,
        "program": program,
        "token": token,
        "raw": raw,
    }


# ---------------------------------------------------------------------------
# Control plane refuses agents
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(("method", "path", "body"), CONTROL_ROUTES)
def test_agent_token_is_refused_on_every_control_endpoint(
    world: dict[str, Any], method: str, path: str, body: Any
) -> None:
    """A ``tppm_`` bearer never reaches a control view: it is not a JWT."""
    client = _bearer(world["raw"])
    response = getattr(client, method)(path.format(id=world["token"].pk), body, format="json")
    assert response.status_code == 401
    world["token"].refresh_from_db()
    assert world["token"].agent_paused_at is None
    assert world["token"].revoked_at is None


@pytest.mark.django_db
@pytest.mark.parametrize(("method", "path", "body"), CONTROL_ROUTES)
def test_full_scope_personal_token_is_refused_too(
    world: dict[str, Any], method: str, path: str, body: Any
) -> None:
    """Keyed on the credential, not on 'is it an agent': no token manages agents."""
    full, _ = _mint(world["principal"], scopes=[SCOPE_API_FULL], name="ci")
    client = APIClient()
    client.force_authenticate(user=world["principal"], token=full)
    response = getattr(client, method)(path.format(id=world["token"].pk), body, format="json")
    assert response.status_code == 403
    world["token"].refresh_from_db()
    assert world["token"].agent_paused_at is None


# ---------------------------------------------------------------------------
# Pause
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pause_refuses_next_call_with_generic_reason_and_resume_restores(
    world: dict[str, Any],
) -> None:
    agent = _bearer(world["raw"])
    assert agent.get(_overview(world["project"])).status_code == 200

    admin = _user("diego")
    admin.first_name, admin.last_name = "Diego", "Alvarez"
    admin.save()
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )

    resp = _as(admin).post(
        f"/api/v1/agents/{world['token'].pk}/pause/", {"reason": "looping"}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["paused"]["paused_by"]["name"] == "Diego Alvarez"

    refused = agent.get(_overview(world["project"]))
    assert refused.status_code == 403
    assert refused.data["refusal"]["constraint"] == RefusalConstraint.AGENT_PAUSED
    # Generic for the agent: never the person's name.
    assert "Diego" not in str(refused.data)
    assert "paused" in str(refused.data["detail"]).lower()

    row = AgentAction.objects.filter(verdict=AgentActionVerdict.REFUSED).latest("sequence")
    assert row.refusal_detail.constraint == RefusalConstraint.AGENT_PAUSED

    resp = _as(world["principal"]).post(
        f"/api/v1/agents/{world['token'].pk}/resume/", {}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["paused"] is None
    assert agent.get(_overview(world["project"])).status_code == 200


@pytest.mark.django_db
def test_control_events_are_hash_chained_and_chain_verifies(world: dict[str, Any]) -> None:
    client = _as(world["principal"])
    pk = world["token"].pk
    client.post(f"/api/v1/agents/{pk}/pause/", {"reason": "r1"}, format="json")
    client.post(f"/api/v1/agents/{pk}/pause/", {}, format="json")  # idempotent: no row
    client.post(f"/api/v1/agents/{pk}/resume/", {}, format="json")
    client.patch(f"/api/v1/agents/{pk}/scope/", {"scope": {"resources": "none"}}, format="json")
    client.post(f"/api/v1/agents/{pk}/revoke/", {}, format="json")

    rows = list(AgentAction.objects.filter(actor_kind=AgentActorKind.PERSON).order_by("sequence"))
    assert [r.action for r in rows] == [
        "agent.pause",
        "agent.resume",
        "agent.scope_edit",
        "agent.revoke",
    ]
    assert all(r.principal_id == world["principal"].pk for r in rows)
    assert all(r.actor_token_id == pk for r in rows)
    assert "r1" in rows[0].summary
    assert '"resources": ["read", "none"]' in rows[2].summary
    assert verify_chain().ok


# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_out_of_scope_read_is_refused_server_side(world: dict[str, Any]) -> None:
    resp = _as(world["principal"]).patch(
        f"/api/v1/agents/{world['token'].pk}/scope/", {"scope": {"schedule": "none"}}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["scope"]["schedule"] == "none"
    refused = _bearer(world["raw"]).get(_overview(world["project"]))
    assert refused.status_code == 403
    assert refused.data["refusal"]["constraint"] == RefusalConstraint.CAPABILITY_SCOPE


@pytest.mark.django_db
def test_write_is_not_grantable(world: dict[str, Any]) -> None:
    resp = _as(world["principal"]).patch(
        f"/api/v1/agents/{world['token'].pk}/scope/",
        {"scope": {"schedule": "write"}},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "write_not_grantable"
    world["token"].refresh_from_db()
    assert world["token"].agent_scope is None


@pytest.mark.django_db
def test_admin_cannot_grant_above_the_principal(world: dict[str, Any]) -> None:
    viewer_principal = _user("viewer")
    ProjectMembership.objects.create(
        project=world["project"], user=viewer_principal, role=Role.VIEWER
    )
    token, _ = _mint(viewer_principal)
    admin = _user("admin")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )

    resp = _as(admin).patch(
        f"/api/v1/agents/{token.pk}/scope/", {"scope": {"schedule": "propose"}}, format="json"
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "above_principal"


@pytest.mark.django_db
def test_agent_never_exceeds_principal_and_demotion_shrinks_it(world: dict[str, Any]) -> None:
    """Effective scope is recomputed from live roles on every read."""
    client = _as(world["principal"])
    pk = world["token"].pk
    resp = client.patch(
        f"/api/v1/agents/{pk}/scope/", {"scope": {"dependencies": "propose"}}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["effective_scope"]["dependencies"] == "propose"

    ProjectMembership.objects.filter(user=world["principal"]).update(role=Role.MEMBER)
    detail = client.get(f"/api/v1/agents/{pk}/").data
    assert detail["scope"]["dependencies"] == "propose"  # the grant is unchanged ...
    assert detail["effective_scope"]["dependencies"] == "read"  # ... but capped now
    for area in agent_scope.AGENT_AREAS:
        assert agent_scope.level_rank(detail["effective_scope"][area]) <= agent_scope.level_rank(
            agent_scope.principal_ceiling(world["principal"])[area]
        )


@pytest.mark.django_db
def test_removing_the_principal_from_a_project_shrinks_agent_reads(world: dict[str, Any]) -> None:
    agent = _bearer(world["raw"])
    assert agent.get(_overview(world["project"])).status_code == 200
    ProjectMembership.objects.filter(user=world["principal"]).delete()
    assert agent.get(_overview(world["project"])).status_code in (403, 404)


def test_area_for_view_mapping() -> None:
    def view(model_name: str | None, **attrs: Any) -> Any:
        model = type(model_name, (), {}) if model_name else None
        qs = type("QS", (), {"model": model})() if model else None
        return type("V", (), {"queryset": qs, **attrs})()

    assert agent_scope.area_for_view(view("Dependency")) == "dependencies"
    assert agent_scope.area_for_view(view("TaskResource")) == "resources"
    assert agent_scope.area_for_view(view("Baseline")) == "baselines"
    assert agent_scope.area_for_view(view("Task")) == "schedule"
    assert agent_scope.area_for_view(view(None)) == "schedule"
    assert agent_scope.area_for_view(view(None, mcp_scope="none")) is None
    assert agent_scope.area_for_view(view("Task", agent_area="resources")) == "resources"


def test_agent_paused_constraint_single_source() -> None:
    assert RefusalConstraint.AGENT_PAUSED == agent_scope.AGENT_PAUSED_CONSTRAINT


# ---------------------------------------------------------------------------
# Revoke
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_revoke_is_immediate(world: dict[str, Any]) -> None:
    agent = _bearer(world["raw"])
    assert agent.get(_overview(world["project"])).status_code == 200
    resp = _as(world["principal"]).post(
        f"/api/v1/agents/{world['token'].pk}/revoke/", {}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["revoked_at"] is not None
    assert agent.get(_overview(world["project"])).status_code == 401


# ---------------------------------------------------------------------------
# Visibility (#4757) and management
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_is_filtered_by_project_membership(world: dict[str, Any]) -> None:
    assert _bearer(world["raw"]).get(_project_detail(world["project"])).status_code == 200

    teammate = _user("teammate")
    ProjectMembership.objects.create(project=world["project"], user=teammate, role=Role.MEMBER)
    stranger = _user("stranger")
    admin = _user("admin")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )

    ids = lambda c: [r["id"] for r in c.get("/api/v1/agents/").data["agents"]]  # noqa: E731
    assert ids(_as(world["principal"])) == [str(world["token"].pk)]
    assert ids(_as(teammate)) == [str(world["token"].pk)]
    assert ids(_as(admin)) == [str(world["token"].pk)]
    assert ids(_as(stranger)) == []

    row = _as(teammate).get("/api/v1/agents/").data["agents"][0]
    assert row["can_manage"] is False
    assert row["programs"] == [{"id": str(world["program"].pk), "name": "Atlas"}]
    assert _as(stranger).get(f"/api/v1/agents/{world['token'].pk}/").status_code == 404
    assert (
        _as(teammate)
        .post(f"/api/v1/agents/{world['token'].pk}/pause/", {}, format="json")
        .status_code
        == 403
    )


@pytest.mark.django_db
def test_last_action_is_redacted_by_project_membership(world: dict[str, Any]) -> None:
    other = _project("Secret")
    ProjectMembership.objects.create(project=other, user=world["principal"], role=Role.MEMBER)
    teammate = _user("teammate")
    ProjectMembership.objects.create(project=world["project"], user=teammate, role=Role.MEMBER)
    agent = _bearer(world["raw"])
    agent.get(_project_detail(world["project"]))
    # The latest action is in a project the teammate cannot read.
    assert agent.get(_project_detail(other)).status_code == 200

    row = _as(teammate).get("/api/v1/agents/").data["agents"][0]
    assert row["last_action"]["redacted"] is True
    assert row["last_action"]["summary"] == ""
    mine = _as(world["principal"]).get("/api/v1/agents/").data["agents"][0]
    assert mine["last_action"]["redacted"] is False


@pytest.mark.django_db
def test_full_scope_tokens_are_not_listed_as_agents(world: dict[str, Any]) -> None:
    _mint(world["principal"], scopes=[SCOPE_API_FULL], name="ci")
    names = [r["name"] for r in _as(world["principal"]).get("/api/v1/agents/").data["agents"]]
    assert names == ["Claude"]


@pytest.mark.django_db
def test_audit_verify_line(world: dict[str, Any]) -> None:
    _bearer(world["raw"]).get(_overview(world["project"]))
    data = _as(world["principal"]).get("/api/v1/agents/audit-verify/").data
    assert data["ok"] is True
    assert data["record_count"] == AgentAction.objects.count()
    assert data["checked_at"]


# ---------------------------------------------------------------------------
# Inbox item
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_refusal_inbox_item_is_coalesced(world: dict[str, Any]) -> None:
    from django.utils import timezone

    world["token"].agent_paused_at = timezone.now()
    world["token"].save(update_fields=["agent_paused_at"])
    payload = {
        "actor_token": world["token"],
        "principal": world["principal"],
        "action": "projects:project-overview",
        "method": "GET",
        "capability_used": SCOPE_MCP_READ,
        "verdict": AgentActionVerdict.REFUSED,
        "refusal_reason": "policy",
        "refusal_constraint": RefusalConstraint.AGENT_PAUSED,
        "payload_hash": "0" * 64,
    }
    from trueppm_api.apps.agents.control import notify_refusal

    for _ in range(3):
        notify_refusal(record_agent_action(**payload))

    items = Notification.objects.filter(recipient=world["principal"], event_type="agent.refused")
    assert items.count() == 1
    item = items.get()
    assert item.subject.startswith("Refused:")
    assert "paused" in item.subject
    assert "3 times" in item.body
    assert item.body.rstrip().endswith("Nothing changed in the schedule.")


@pytest.mark.django_db
def test_live_pause_refusal_reaches_the_inbox(
    world: dict[str, Any], django_capture_on_commit_callbacks: Any
) -> None:
    from django.utils import timezone

    world["token"].agent_paused_at = timezone.now()
    world["token"].save(update_fields=["agent_paused_at"])
    with django_capture_on_commit_callbacks(execute=True):
        _bearer(world["raw"]).get(_overview(world["project"]))
    assert Notification.objects.filter(
        recipient=world["principal"], event_type="agent.refused"
    ).exists()
