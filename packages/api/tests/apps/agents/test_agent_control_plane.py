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
import uuid
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
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
    SCOPE_WEBHOOKS_MANAGE,
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
    full, raw = _mint(world["principal"], scopes=[SCOPE_API_FULL], name="ci")
    # Through the real authenticator: a `tppm_` bearer is not a JWT, so it never
    # authenticates on a control route at all.
    real = getattr(_bearer(raw), method)(path.format(id=world["token"].pk), body, format="json")
    assert real.status_code == 401
    # And if one ever did authenticate (a future authenticator change), the view's own
    # credential check still refuses it.
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

    assert agent_scope.areas_for_view(view("Dependency")) == ("dependencies",)
    assert agent_scope.areas_for_view(view("TaskResource")) == ("resources",)
    assert agent_scope.areas_for_view(view("Baseline")) == ("baselines",)
    assert agent_scope.areas_for_view(view("Task")) == ("schedule",)
    assert agent_scope.areas_for_view(view(None)) == ("schedule",)
    assert agent_scope.areas_for_view(view(None, mcp_scope="none")) is None
    assert agent_scope.areas_for_view(view("Task", agent_area="resources")) == ("resources",)
    by_action = {"export": agent_scope.ALL_AREAS, "contention": "resources"}
    assert (
        agent_scope.areas_for_view(view("Task", agent_action_areas=by_action, action="export"))
        == agent_scope.AGENT_AREAS
    )
    assert agent_scope.areas_for_view(
        view("Task", agent_action_areas=by_action, action="contention")
    ) == ("resources",)
    # An unknown area in the map never narrows the check: it falls back to the view.
    bad = {"export": ("schedule", "nope")}
    assert agent_scope.areas_for_view(view("Task", agent_action_areas=bad, action="export")) == (
        "schedule",
    )


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


def _ws_admin(name: str = "wsadmin") -> Any:
    admin = _user(name)
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )
    return admin


@pytest.mark.django_db
def test_audit_verify_line(world: dict[str, Any]) -> None:
    _bearer(world["raw"]).get(_overview(world["project"]))
    data = _as(_ws_admin()).get("/api/v1/agents/audit-verify/").data
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


# ---------------------------------------------------------------------------
# Completeness-check fix round: key resolution, agent set, preference, cache, cap
# ---------------------------------------------------------------------------


def _key_routes(project: Project) -> list[str]:
    return [
        f"/api/v1/resolve/?kind=project&ref={project.id}",
        "/api/v1/keys/?kind=project&name=Platform",
    ]


@pytest.mark.django_db
def test_paused_agent_is_refused_and_recorded_on_key_resolution(world: dict[str, Any]) -> None:
    """The key resolver and key suggestion admit owner-scoped tokens, so they bind pause."""
    from django.utils import timezone

    agent = _bearer(world["raw"])
    for path in _key_routes(world["project"]):
        assert agent.get(path).status_code == 200, path

    world["token"].agent_paused_at = timezone.now()
    world["token"].save(update_fields=["agent_paused_at"])
    for path in _key_routes(world["project"]):
        refused = agent.get(path)
        assert refused.status_code == 403, path
        assert refused.data["refusal"]["constraint"] == RefusalConstraint.AGENT_PAUSED

    rows = AgentAction.objects.filter(
        actor_token=world["token"], verdict=AgentActionVerdict.REFUSED
    ).order_by("sequence")
    assert [r.action for r in rows] == ["resolve", "keys"]
    assert all(r.refusal_detail.constraint == RefusalConstraint.AGENT_PAUSED for r in rows)
    assert all(r.principal_id == world["principal"].pk for r in rows)
    assert verify_chain().ok


@pytest.mark.django_db
def test_out_of_scope_agent_is_refused_on_key_resolution(world: dict[str, Any]) -> None:
    world["token"].agent_scope = {**agent_scope.DEFAULT_GRANT, "schedule": "none"}
    world["token"].save(update_fields=["agent_scope"])
    refused = _bearer(world["raw"]).get(f"/api/v1/resolve/?kind=project&ref={world['project'].id}")
    assert refused.status_code == 403
    assert refused.data["refusal"]["constraint"] == RefusalConstraint.CAPABILITY_SCOPE


@pytest.mark.django_db
def test_key_resolution_is_unchanged_for_a_person(world: dict[str, Any]) -> None:
    resp = _as(world["principal"]).get(f"/api/v1/resolve/?kind=project&ref={world['project'].id}")
    assert resp.status_code == 200
    assert not AgentAction.objects.filter(verdict=AgentActionVerdict.REFUSED).exists()


@pytest.mark.django_db
def test_webhooks_token_is_not_listed_or_governed_as_an_agent(world: dict[str, Any]) -> None:
    """Only `mcp:read` tokens get a Pause control, because only they are bound by it."""
    hooks, _ = _mint(world["principal"], scopes=[SCOPE_WEBHOOKS_MANAGE], name="hooks")
    names = [r["name"] for r in _as(world["principal"]).get("/api/v1/agents/").data["agents"]]
    assert names == ["Claude"]
    assert not agent_scope.is_controlled_agent(hooks)
    assert agent_scope.is_controlled_agent(world["token"])
    resp = _as(world["principal"]).post(f"/api/v1/agents/{hooks.pk}/pause/", {}, format="json")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_admin_control_row_belongs_to_the_agents_principal(world: dict[str, Any]) -> None:
    admin = _user("diego")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=admin, role=WorkspaceRole.ADMIN
    )
    pk = world["token"].pk
    assert _as(admin).post(f"/api/v1/agents/{pk}/pause/", {}, format="json").status_code == 200

    row = AgentAction.objects.get(actor_kind=AgentActorKind.PERSON, action="agent.pause")
    assert row.principal_id == world["principal"].pk
    assert f"(user {admin.pk})" in row.summary
    # It is in the principal's own action log, and not in the Admin's.
    mine = _as(world["principal"]).get("/api/v1/agent-actions/").data
    mine_rows = mine["results"] if isinstance(mine, dict) else mine
    assert str(row.pk) in {str(r["id"]) for r in mine_rows}
    assert verify_chain().ok


def _refusal_payload(world: dict[str, Any]) -> dict[str, Any]:
    return {
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


@pytest.mark.django_db
def test_refusal_inbox_item_honors_the_preference(world: dict[str, Any]) -> None:
    from trueppm_api.apps.agents.control import notify_refusal
    from trueppm_api.apps.notifications.models import NotificationPreference

    notify_refusal(record_agent_action(**_refusal_payload(world)))
    item = Notification.objects.get(recipient=world["principal"], event_type="agent.refused")
    item.is_read = True
    item.save(update_fields=["is_read"])

    NotificationPreference.objects.update_or_create(
        user=world["principal"],
        event_type="agent.refused",
        channel="in_app",
        defaults={"enabled": False},
    )
    notify_refusal(record_agent_action(**_refusal_payload(world)))
    item.refresh_from_db()
    assert item.is_read is True  # the coalesced row was not refreshed either
    assert Notification.objects.filter(event_type="agent.refused").count() == 1

    Notification.objects.all().delete()
    notify_refusal(record_agent_action(**_refusal_payload(world)))
    assert not Notification.objects.filter(event_type="agent.refused").exists()


@pytest.mark.django_db
def test_audit_verify_is_reused_across_new_agent_calls(
    world: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    from django.core.cache import cache

    from trueppm_api.apps.agents import agent_views

    cache.delete(agent_views.AUDIT_VERIFY_CACHE_KEY)
    calls = []
    real = agent_views.verify_chain

    def counting() -> Any:
        calls.append(1)
        return real()

    monkeypatch.setattr(agent_views, "verify_chain", counting)
    client = _as(_ws_admin())
    first = client.get("/api/v1/agents/audit-verify/").data
    _bearer(world["raw"]).get(_overview(world["project"]))  # advances the chain head
    second = client.get("/api/v1/agents/audit-verify/").data
    assert len(calls) == 1
    assert second["record_count"] == first["record_count"]
    cache.delete(agent_views.AUDIT_VERIFY_CACHE_KEY)


@pytest.mark.django_db
def test_agent_list_is_capped(world: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    from trueppm_api.apps.agents import agent_views

    _mint(world["principal"], name="Zed")
    client = _as(world["principal"])
    data = client.get("/api/v1/agents/").data
    assert data["truncated"] is False
    assert len(data["agents"]) == 2

    monkeypatch.setattr(agent_views, "MAX_AGENTS_LISTED", 1)
    data = client.get("/api/v1/agents/").data
    assert data["truncated"] is True
    assert [r["name"] for r in data["agents"]] == ["Claude"]


# ---------------------------------------------------------------------------
# Round 2: every area governs real endpoints; coalescing key; narrowing; verify gate
# ---------------------------------------------------------------------------


def _routed_mcp_view_areas() -> dict[str, set[str]]:
    """Area -> routes, from the REAL URL resolver (every routed MCP view and action)."""
    from django.urls import get_resolver

    from trueppm_api.apps.access.permissions import McpReadableViewMixin

    out: dict[str, set[str]] = {}

    def walk(patterns: Any, prefix: str = "") -> None:
        for p in patterns:
            if hasattr(p, "url_patterns"):
                walk(p.url_patterns, prefix + str(p.pattern))
                continue
            cls = getattr(p.callback, "cls", None) or getattr(p.callback, "view_class", None)
            if cls is None or not issubclass(cls, McpReadableViewMixin):
                continue
            actions = getattr(p.callback, "actions", None) or {"get": None}
            for method, act in actions.items():
                if method != "get":
                    continue
                view = cls()
                view.action = act
                for area in agent_scope.areas_for_view(view) or ():
                    out.setdefault(area, set()).add(f"{prefix}{p.pattern} [{act}]")

    walk(get_resolver().url_patterns)
    return out


def test_every_area_governs_a_routed_mcp_view() -> None:
    """A scope area that governs no routed view is a toggle that refuses nothing."""
    areas = _routed_mcp_view_areas()
    for area in agent_scope.AGENT_AREAS:
        assert areas.get(area), f"no routed MCP view is governed by {area!r}"
    joined = {a: " ".join(sorted(r)) for a, r in areas.items()}
    assert "cost/" in joined["resources"]
    assert "[resource_allocation]" in joined["resources"]
    assert "[heatmap]" in joined["resources"]
    assert "[utilization]" in joined["resources"]
    assert "schedule/driving-chain/" in joined["dependencies"]
    assert "schedule/derivation/" in joined["dependencies"]
    assert "baselines/" in joined["baselines"]
    assert "[resource_contention]" in joined["resources"]
    # The exports carry every area in one response, so every area governs them.
    for area in agent_scope.AGENT_AREAS:
        assert "[export]" in joined[area], area
        assert "[export_job_download]" in joined[area], area
    assert set(agent_scope.AGENT_AREA_COVERS) == set(agent_scope.AGENT_AREAS)


def _set_scope(world: dict[str, Any], **levels: str) -> None:
    resp = _as(world["principal"]).patch(
        f"/api/v1/agents/{world['token'].pk}/scope/", {"scope": levels}, format="json"
    )
    assert resp.status_code == 200, resp.data


@pytest.mark.django_db
def test_resources_none_refuses_cost_and_resource_reads(world: dict[str, Any]) -> None:
    agent = _bearer(world["raw"])
    pk = world["project"].id
    cost = f"/api/v1/projects/{pk}/cost/"
    assert agent.get(cost).status_code == 200

    _set_scope(world, resources="none")
    for path in (
        cost,
        f"/api/v1/projects/{pk}/utilization/",
        f"/api/v1/projects/{pk}/resource-allocation/",
        f"/api/v1/projects/{pk}/resources/heatmap/",
        f"/api/v1/projects/{pk}/resources/summary/",
        f"/api/v1/programs/{world['program'].id}/resource-contention/",
    ):
        refused = agent.get(path)
        assert refused.status_code == 403, path
        assert refused.data["refusal"]["constraint"] == RefusalConstraint.CAPABILITY_SCOPE
        assert "resources" in str(refused.data["detail"]).lower()
    # The rest of the project stays readable: Schedule is still granted.
    assert agent.get(_overview(world["project"])).status_code == 200


@pytest.mark.django_db
def test_dependencies_none_refuses_driving_chain_and_derivation(world: dict[str, Any]) -> None:
    agent = _bearer(world["raw"])
    pk = world["project"].id
    _set_scope(world, dependencies="none")
    for path in (
        f"/api/v1/projects/{pk}/schedule/driving-chain/",
        f"/api/v1/projects/{pk}/schedule/derivation/",
        f"/api/v1/dependencies/?project={pk}",
    ):
        refused = agent.get(path)
        assert refused.status_code == 403, path
        assert refused.data["refusal"]["constraint"] == RefusalConstraint.CAPABILITY_SCOPE


@pytest.mark.django_db
def test_task_assignments_follow_the_resources_area(world: dict[str, Any]) -> None:
    from decimal import Decimal

    from trueppm_api.apps.projects.models import Task
    from trueppm_api.apps.resources.models import Resource, TaskResource

    task = Task.objects.create(project=world["project"], name="Wire", duration=1)
    TaskResource.objects.create(
        task=task, resource=Resource.objects.create(name="Ana"), units=Decimal("1.00")
    )
    agent = _bearer(world["raw"])
    path = f"/api/v1/tasks/{task.id}/"

    at_read = agent.get(path)
    assert at_read.status_code == 200
    assert at_read.data["assignments"][0]["resource_name"] == "Ana"
    assert "assignee_is_overallocated" in at_read.data

    _set_scope(world, resources="none")
    stripped = agent.get(path)
    assert stripped.status_code == 200
    for field in agent_scope.RESOURCE_TASK_FIELDS:
        assert field not in stripped.data
    assert stripped.data["name"] == "Wire"
    listed = agent.get(f"/api/v1/tasks/?project={world['project'].id}")
    rows = listed.data["results"] if isinstance(listed.data, dict) else listed.data
    assert rows and all("assignments" not in r for r in rows)

    # A person is never affected by an agent's scope.
    assert "assignments" in _as(world["principal"]).get(path).data


@pytest.mark.django_db
def test_two_same_name_agents_get_separate_inbox_items(world: dict[str, Any]) -> None:
    from django.utils import timezone

    from trueppm_api.apps.agents.control import notify_refusal

    other, _ = _mint(world["principal"], name="Claude")
    for token in (world["token"], other):
        token.agent_paused_at = timezone.now()
        token.save(update_fields=["agent_paused_at"])
    notify_refusal(record_agent_action(**_refusal_payload(world)))
    notify_refusal(record_agent_action(**_refusal_payload(world)))
    notify_refusal(record_agent_action(**{**_refusal_payload(world), "actor_token": other}))

    items = Notification.objects.filter(recipient=world["principal"], event_type="agent.refused")
    assert items.count() == 2
    by_prefix = {
        t.token_prefix: items.get(subject__contains=f"tppm_{t.token_prefix}")
        for t in (world["token"], other)
    }
    assert "2 times" in by_prefix[world["token"].token_prefix].body
    assert "once" in by_prefix[other.token_prefix].body


@pytest.mark.django_db
def test_narrowing_is_allowed_after_the_principal_is_demoted(world: dict[str, Any]) -> None:
    client = _as(world["principal"])
    url = f"/api/v1/agents/{world['token'].pk}/scope/"
    assert (
        client.patch(url, {"scope": {"dependencies": "propose"}}, format="json").status_code == 200
    )
    ProjectMembership.objects.filter(user=world["principal"]).update(role=Role.MEMBER)

    # Narrowing another area while Dependencies sits above the new ceiling: allowed.
    resp = client.patch(url, {"scope": {"schedule": "none"}}, format="json")
    assert resp.status_code == 200, resp.data
    assert resp.data["scope"]["dependencies"] == "propose"  # stored, untouched
    # The UI sends the whole draft; an unchanged above-ceiling area is not a raise.
    full = {"schedule": "none", "dependencies": "propose", "resources": "read", "baselines": "read"}
    assert client.patch(url, {"scope": full}, format="json").status_code == 200
    # Lowering the above-ceiling area itself: allowed.
    resp = client.patch(url, {"scope": {"dependencies": "read"}}, format="json")
    assert resp.status_code == 200
    assert resp.data["scope"]["dependencies"] == "read"
    # Raising it back above the ceiling: refused.
    resp = client.patch(url, {"scope": {"dependencies": "propose"}}, format="json")
    assert resp.status_code == 400
    assert resp.data["code"] == "above_principal"


@pytest.mark.django_db
def test_audit_verify_is_workspace_admin_only(world: dict[str, Any]) -> None:
    person = _as(world["principal"])
    assert person.get("/api/v1/agents/audit-verify/").status_code == 403
    assert person.get("/api/v1/agents/").data["can_verify_log"] is False
    admin = _as(_ws_admin())
    assert admin.get("/api/v1/agents/").data["can_verify_log"] is True
    assert admin.get("/api/v1/agents/audit-verify/").status_code == 200
    areas = person.get("/api/v1/agents/").data["areas"]
    assert all(a["covers"] for a in areas)


@pytest.mark.django_db
def test_audit_verify_miss_is_single_flight(
    world: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A request that loses the lock waits for the winner instead of walking the chain."""
    from django.core.cache import cache

    from trueppm_api.apps.agents import agent_views

    cache.delete(agent_views.AUDIT_VERIFY_CACHE_KEY)
    calls: list[int] = []
    monkeypatch.setattr(agent_views, "verify_chain", lambda: calls.append(1))
    monkeypatch.setattr(agent_views, "AUDIT_VERIFY_WAIT_SECONDS", 0.3)
    cache.add(agent_views.AUDIT_VERIFY_LOCK_KEY, "1", 60)  # another request is walking
    try:
        resp = _as(_ws_admin()).get("/api/v1/agents/audit-verify/")
        assert resp.status_code == 503
        assert resp["Retry-After"] == "5"
        assert calls == []
    finally:
        cache.delete(agent_views.AUDIT_VERIFY_LOCK_KEY)
        cache.delete(agent_views.AUDIT_VERIFY_CACHE_KEY)


# ---------------------------------------------------------------------------
# Exports carry every area at once, so a controlled agent needs read on all four
# ---------------------------------------------------------------------------


def _export_paths(world: dict[str, Any]) -> list[str]:
    project_id = world["project"].id
    program_id = world["program"].id
    job = uuid.uuid4()
    return [
        f"/api/v1/projects/{project_id}/export/",
        f"/api/v1/projects/{project_id}/export/jobs/{job}/download/",
        f"/api/v1/programs/{program_id}/export/",
        f"/api/v1/programs/{program_id}/export/jobs/{job}/download/",
    ]


@pytest.fixture
def export_world(world: dict[str, Any]) -> dict[str, Any]:
    # Program export is Program Admin+ before the agent guard is consulted.
    ProgramMembership.objects.create(
        program=world["program"], user=world["principal"], role=Role.ADMIN
    )
    return world


@pytest.mark.django_db
@pytest.mark.parametrize("missing", ["resources", "dependencies", "baselines"])
def test_export_refused_without_every_area(export_world: dict[str, Any], missing: str) -> None:
    _set_scope(export_world, **{missing: "none"})
    agent = _bearer(export_world["raw"])
    for path in _export_paths(export_world):
        refused = agent.get(path)
        assert refused.status_code == 403, path
        assert refused.data["refusal"]["constraint"] == RefusalConstraint.CAPABILITY_SCOPE
        assert missing in str(refused.data["detail"]).lower(), path
    # The project's Schedule reads stay open: only the all-areas exports close.
    assert agent.get(_overview(export_world["project"])).status_code == 200


@pytest.mark.django_db
def test_export_served_with_every_area(export_world: dict[str, Any]) -> None:
    agent = _bearer(export_world["raw"])
    sync_project, project_dl, sync_program, program_dl = _export_paths(export_world)
    assert agent.get(sync_project).status_code == 200
    assert agent.get(sync_program).status_code == 200
    # Past the guard, an unknown job is the view's own 404 rather than a refusal.
    assert agent.get(project_dl).status_code == 404
    assert agent.get(program_dl).status_code == 404


@pytest.mark.django_db
def test_export_unaffected_for_a_person(export_world: dict[str, Any]) -> None:
    _set_scope(export_world, resources="none", dependencies="none", baselines="none")
    person = _as(export_world["principal"])
    sync_project, _, sync_program, _ = _export_paths(export_world)
    assert person.get(sync_project).status_code == 200
    assert person.get(sync_program).status_code == 200
