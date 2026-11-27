"""Every path that revokes an agent token appends an ``agent.revoke`` chain row (#5109).

Before #5109 only the Agents page (``agents/control.revoke``) recorded a revoke in the
AgentAction hash chain. An agent revoked from token settings, by a password reset or
off-boarding sweep, or by ``revoke_api_tokens`` left a chain that showed the agent
acting and then going quiet, with nothing proving who stopped it. Each test here drives
one path and asserts the row names the actor and the reason, commits with the revoke,
and keeps the chain verifiable. A full-scope token (the owner's own script, whose calls
the chain never records) gets no row on any path.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from io import StringIO
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import transaction
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import revoke_all_personal_access_tokens
from trueppm_api.apps.agents.models import AgentAction, AgentActionChainHead, AgentActorKind
from trueppm_api.apps.agents.services import verify_chain
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_API_FULL,
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Program,
    Project,
)

User = get_user_model()


def _user(name: str) -> Any:
    return User.objects.create_user(
        username=f"{name}_{secrets.token_hex(3)}", password="pw", first_name=name
    )


def _mint(scopes: list[str] | None = None, **scope: Any) -> ApiToken:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    return ApiToken.objects.create(
        name="Claude",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        scopes=scopes or [SCOPE_MCP_READ],
        expires_at=timezone.now() + timedelta(days=30),
        **scope,
    )


def _as(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _revoke_rows(token: ApiToken) -> list[AgentAction]:
    return list(
        AgentAction.objects.filter(
            actor_kind=AgentActorKind.PERSON, action="agent.revoke", actor_token=token
        ).order_by("sequence")
    )


@pytest.fixture
def chain(db: object) -> None:
    AgentActionChainHead.objects.get_or_create(pk=1)


@pytest.fixture
def project() -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.mark.django_db
def test_personal_token_settings_revoke_is_chained(chain: None) -> None:
    alice = _user("Alice")
    token = _mint(owner=alice, created_by=alice)

    resp = _as(alice).delete(f"/api/v1/me/api-tokens/{token.pk}/")
    assert resp.status_code == 204

    [row] = _revoke_rows(token)
    assert row.principal_id == alice.pk
    assert row.method == "DELETE"
    assert f"revoked by Alice (user {alice.pk}) via personal token settings." in row.summary
    assert verify_chain().ok

    # Idempotent: a second DELETE revokes nothing and so records nothing.
    assert _as(alice).delete(f"/api/v1/me/api-tokens/{token.pk}/").status_code == 204
    assert len(_revoke_rows(token)) == 1


@pytest.mark.django_db
def test_project_token_settings_revoke_is_chained_into_the_project_log(
    chain: None, project: Project
) -> None:
    admin = _user("Dana")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    token = _mint(project=project, created_by=admin)

    resp = _as(admin).delete(f"/api/v1/projects/{project.pk}/api-tokens/{token.pk}/")
    assert resp.status_code == 204

    [row] = _revoke_rows(token)
    # A project token has no owner: the row has no principal and carries the project,
    # so it sits in that project's agent log beside the token's own calls.
    assert row.principal_id is None
    assert row.project_id == project.pk
    assert f"revoked by Dana (user {admin.pk}) via project token settings." in row.summary
    assert verify_chain().ok


@pytest.mark.django_db
def test_program_token_settings_revoke_is_chained(chain: None) -> None:
    admin = _user("Eli")
    program = Program.objects.create(name="Atlas")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)
    token = _mint(program=program, created_by=admin)

    resp = _as(admin).delete(f"/api/v1/programs/{program.pk}/api-tokens/{token.pk}/")
    assert resp.status_code == 204

    [row] = _revoke_rows(token)
    assert row.principal_id is None
    assert row.project_id is None
    assert "via program token settings." in row.summary
    assert verify_chain().ok


@pytest.mark.django_db
@pytest.mark.parametrize("reason", ["password_reset", "offboarding"])
def test_account_wide_sweep_chains_each_agent_token_with_actor_and_reason(
    chain: None, reason: str
) -> None:
    """Password reset and off-boarding share this service; both are chained through it."""
    alice = _user("Alice")
    admin = _user("Admin")
    agent = _mint(owner=alice, created_by=alice)
    script = _mint(scopes=[SCOPE_API_FULL], owner=alice, created_by=alice)

    with transaction.atomic():
        assert (
            revoke_all_personal_access_tokens(
                alice, actor=admin, reason=reason, source_ip="203.0.113.9"
            )
            == 2
        )

    [row] = _revoke_rows(agent)
    assert row.principal_id == alice.pk
    assert row.method == ""
    assert str(row.source_ip) == "203.0.113.9"
    assert f"revoked by Admin (user {admin.pk}) via an account-wide revoke." in row.summary
    assert row.summary.endswith(f"Reason: {reason}")
    # The owner's full-scope script is not an agent: revoked and audited, never chained.
    assert _revoke_rows(script) == []
    assert verify_chain().ok


@pytest.mark.django_db
def test_chain_row_rolls_back_with_the_revoke(chain: None) -> None:
    """Same transaction: a sweep that rolls back leaves neither the revoke nor its row."""
    alice = _user("Alice")
    agent = _mint(owner=alice, created_by=alice)

    with pytest.raises(RuntimeError), transaction.atomic():
        revoke_all_personal_access_tokens(alice, actor=alice, reason="password_reset")
        raise RuntimeError("roll back")

    agent.refresh_from_db()
    assert agent.revoked_at is None
    assert _revoke_rows(agent) == []


@pytest.mark.django_db
@pytest.mark.parametrize("scope_args", [["--all-personal"], ["--all"]])
def test_revoke_api_tokens_command_bulk_path_is_chained(
    chain: None, project: Project, scope_args: list[str]
) -> None:
    alice = _user("Alice")
    agent = _mint(owner=alice, created_by=alice)
    project_agent = _mint(project=project, created_by=alice)

    call_command("revoke_api_tokens", *scope_args, "--commit", "--yes", stdout=StringIO())

    [row] = _revoke_rows(agent)
    assert row.principal_id == alice.pk
    assert (
        "revoked by a server operator (no user account) via the revoke_api_tokens command."
        in row.summary
    )
    assert row.summary.endswith("Reason: operator_bulk_revoke")
    if scope_args == ["--all"]:
        [project_row] = _revoke_rows(project_agent)
        assert project_row.project_id == project.pk
    else:
        assert _revoke_rows(project_agent) == []
    assert verify_chain().ok


@pytest.mark.django_db
def test_revoke_api_tokens_command_user_path_is_chained(chain: None) -> None:
    """``--user`` delegates to the account-wide sweep, which writes the row."""
    alice = _user("Alice")
    agent = _mint(owner=alice, created_by=alice)

    call_command(
        "revoke_api_tokens", "--user", alice.username, "--commit", "--yes", stdout=StringIO()
    )

    [row] = _revoke_rows(agent)
    assert "a server operator (no user account) via an account-wide revoke." in row.summary
    assert row.summary.endswith("Reason: operator_bulk_revoke")
    assert verify_chain().ok


@pytest.mark.django_db
def test_agents_page_revoke_still_writes_exactly_one_row(chain: None) -> None:
    """The Agents page now shares the writer; its row and summary are unchanged."""
    alice = _user("Alice")
    agent = _mint(owner=alice, created_by=alice)

    resp = _as(alice).post(f"/api/v1/agents/{agent.pk}/revoke/", {"reason": "done"}, format="json")
    assert resp.status_code == 200

    [row] = _revoke_rows(agent)
    assert row.summary == (
        f"Agent Claude (tppm_{agent.token_prefix}) token revoked by Alice (user {alice.pk})."
        " Reason: done"
    )
    assert row.method == "POST"
    assert verify_chain().ok
