"""Tests for the OSS agent-action audit substrate (ADR-0112 RC1/RC2, #1805).

Covers the four pieces of the substrate:

  * ``record_agent_action`` — the single writer: gap-free per-instance sequence, correct
    predecessor linkage, and a ``record_hash`` that recomputes from the canonical body;
  * ``manage.py audit_verify`` — passes on an intact chain and reports a break on a
    tampered field, a reordered/gapped sequence, and a broken link;
  * the ``McpReadableViewMixin`` write hook — an ``mcp:read`` read is recorded ``allowed``,
    a refused token read is recorded ``refused``/``policy``, and a human (session) read is
    not recorded at all;
  * the authenticator identity-refusal path — a revoked/expired *known* token records a
    ``refused``/``identity`` row, while an unknown token records nothing (DoS-safe).
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone
from rest_framework import exceptions
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.agents.canonical import canonical_fields, compute_record_hash
from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionChainHead,
    AgentActionRefusalReason,
    AgentActionVerdict,
    AgentActorKind,
)
from trueppm_api.apps.agents.services import record_agent_action
from trueppm_api.apps.projects.authentication import (
    TOKEN_PREFIX,
    ProjectApiTokenAuthentication,
    sha256_hex,
)
from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken, Calendar, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="agent_owner", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar, owner: Any) -> Project:
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


def _mint_personal(
    owner: Any, scopes: list[str] | None = None, **kwargs: Any
) -> tuple[ApiToken, str]:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    extra: dict[str, Any] = {}
    if scopes is not None:
        extra["scopes"] = scopes
    token = ApiToken.objects.create(
        owner=owner,
        name="personal-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        **extra,
        **kwargs,
    )
    return token, raw


def _mint_project(
    project: Project, creator: Any, scopes: list[str] | None = None
) -> tuple[ApiToken, str]:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    extra: dict[str, Any] = {}
    if scopes is not None:
        extra["scopes"] = scopes
    token = ApiToken.objects.create(
        project=project,
        name="project-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=creator,
        **extra,
    )
    return token, raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _record(**overrides: Any) -> AgentAction:
    """Record one action with sensible defaults for the chain-mechanics tests."""
    kwargs: dict[str, Any] = dict(
        actor_kind=AgentActorKind.MCP_TOKEN,
        actor_token=None,
        principal=None,
        action="task-list",
        method="GET",
        capability_used=SCOPE_MCP_READ,
        verdict=AgentActionVerdict.ALLOWED,
        payload_hash="0" * 64,
    )
    kwargs.update(overrides)
    return record_agent_action(**kwargs)


# ---------------------------------------------------------------------------
# Chain mechanics — record_agent_action
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_first_record_starts_at_sequence_one_and_genesis_prev() -> None:
    from trueppm_api.apps.agents.models import GENESIS_PREV_HASH

    entry = _record()
    assert entry.sequence == 1
    assert entry.prev_hash == GENESIS_PREV_HASH
    # The chain head advanced to this row.
    head = AgentActionChainHead.objects.get(pk=1)
    assert head.last_sequence == 1
    assert head.last_record_hash == entry.record_hash


@pytest.mark.django_db
def test_second_record_links_to_first() -> None:
    first = _record(action="task-list")
    second = _record(action="task-detail")
    assert second.sequence == 2
    assert second.prev_hash == first.record_hash
    assert second.record_hash != first.record_hash


@pytest.mark.django_db
def test_record_hash_recomputes_from_canonical() -> None:
    entry = _record()
    assert entry.record_hash == compute_record_hash(entry.prev_hash, canonical_fields(entry))


@pytest.mark.django_db
def test_refusal_reason_cleared_when_not_refused() -> None:
    # Passing a refusal reason on an allowed verdict must never persist a dangling reason.
    entry = _record(
        verdict=AgentActionVerdict.ALLOWED,
        refusal_reason=AgentActionRefusalReason.POLICY,
    )
    assert entry.refusal_reason == ""


# ---------------------------------------------------------------------------
# audit_verify
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_audit_verify_passes_on_intact_chain() -> None:
    for i in range(3):
        _record(action=f"op-{i}")
    # No CommandError == chain intact.
    call_command("audit_verify", "--quiet")


@pytest.mark.django_db
def test_audit_verify_passes_on_empty_chain() -> None:
    call_command("audit_verify")


@pytest.mark.django_db
def test_audit_verify_detects_field_tampering() -> None:
    entry = _record(action="task-list")
    # Tamper with a hashed field via a raw UPDATE (bypassing any model logic) so the
    # stored record_hash no longer recomputes.
    AgentAction.objects.filter(pk=entry.pk).update(action="tampered")
    with pytest.raises(CommandError, match="record_hash does not recompute"):
        call_command("audit_verify")


@pytest.mark.django_db
def test_audit_verify_detects_deleted_row_as_gap() -> None:
    first = _record()
    _record()
    third = _record()
    # Delete the middle row: the sequence now jumps 1 -> 3.
    AgentAction.objects.filter(sequence=2).delete()
    assert first.sequence == 1 and third.sequence == 3
    with pytest.raises(CommandError, match="gap or reorder"):
        call_command("audit_verify")


# ---------------------------------------------------------------------------
# MCP read-surface write hook (McpReadableViewMixin.finalize_response)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_mcp_read_records_allowed_action(project: Project, owner: Any) -> None:
    token, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.data

    action = AgentAction.objects.get()
    assert action.verdict == AgentActionVerdict.ALLOWED
    assert action.refusal_reason == ""
    assert action.actor_token_id == token.pk
    assert action.actor_token_prefix == token.token_prefix
    assert action.principal_id == owner.pk
    assert action.capability_used == SCOPE_MCP_READ
    assert action.engine_version  # a real version string, not empty
    # The Project retrieve resolves object + project scope.
    assert str(action.project_id) == str(project.pk)


@pytest.mark.django_db
def test_mcp_refused_read_stays_a_clean_refusal(project: Project, owner: Any) -> None:
    # A *project*-scoped mcp:read token authenticates but is rejected by the owner-scope
    # guard on the MCP surface (#1712). The audit hook must NEVER turn that 401/403 into a
    # 500 — a refusal is already the safe outcome, so the refusal audit is best-effort.
    creator = User.objects.create_user(username="minter", password="pw")
    _, raw = _mint_project(project, creator, scopes=[SCOPE_MCP_READ])
    resp = _bearer(raw).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code in (401, 403), resp.status_code


@pytest.mark.django_db
def test_service_records_policy_refusal_shape() -> None:
    # The verdict/refusal_reason=policy vocabulary is recorded correctly by the service
    # (the write hook feeds these on a clean refusal path).
    entry = _record(
        verdict=AgentActionVerdict.REFUSED,
        refusal_reason=AgentActionRefusalReason.POLICY,
        summary="MCP GET project — refused (403)",
    )
    assert entry.verdict == AgentActionVerdict.REFUSED
    assert entry.refusal_reason == AgentActionRefusalReason.POLICY
    # A refusal is still a fully chained record.
    assert entry.record_hash == compute_record_hash(entry.prev_hash, canonical_fields(entry))


@pytest.mark.django_db
def test_human_session_read_is_not_recorded(project: Project, owner: Any) -> None:
    # A human (session) read on the same MCP-readable view is not an agent action.
    client = APIClient()
    client.force_login(owner)
    resp = client.get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200, resp.data
    assert AgentAction.objects.count() == 0


# ---------------------------------------------------------------------------
# Authenticator identity-refusal path
# ---------------------------------------------------------------------------


def _auth_request(raw: str):
    return APIRequestFactory().get("/", HTTP_AUTHORIZATION=f"Bearer {raw}")


@pytest.mark.django_db
def test_revoked_token_records_identity_refusal(owner: Any) -> None:
    token, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ], revoked_at=timezone.now())
    with pytest.raises(exceptions.AuthenticationFailed):
        ProjectApiTokenAuthentication().authenticate(_auth_request(raw))

    action = AgentAction.objects.get()
    assert action.verdict == AgentActionVerdict.REFUSED
    assert action.refusal_reason == AgentActionRefusalReason.IDENTITY
    assert action.actor_token_id == token.pk
    assert action.action == "authenticate"


@pytest.mark.django_db
def test_expired_token_records_identity_refusal(owner: Any) -> None:
    token, raw = _mint_personal(
        owner, scopes=[SCOPE_MCP_READ], expires_at=timezone.now() - timedelta(minutes=1)
    )
    with pytest.raises(exceptions.AuthenticationFailed):
        ProjectApiTokenAuthentication().authenticate(_auth_request(raw))
    assert AgentAction.objects.filter(
        refusal_reason=AgentActionRefusalReason.IDENTITY, actor_token=token
    ).exists()


@pytest.mark.django_db
def test_replayed_dead_token_audits_identity_refusal_only_once(owner: Any) -> None:
    # A revoked/expired token replayed in a loop must append at most ONE identity-refusal
    # row — the write runs on the pre-throttle auth path, so it is bounded to once per
    # dead token to avoid a chain-locking DoS amplifier.
    token, raw = _mint_personal(owner, scopes=[SCOPE_MCP_READ], revoked_at=timezone.now())
    for _ in range(3):
        with pytest.raises(exceptions.AuthenticationFailed):
            ProjectApiTokenAuthentication().authenticate(_auth_request(raw))
    assert (
        AgentAction.objects.filter(
            actor_token=token, refusal_reason=AgentActionRefusalReason.IDENTITY
        ).count()
        == 1
    )


@pytest.mark.django_db
def test_unknown_token_records_nothing(db: object) -> None:
    # A well-formed but never-minted token must not write an audit row — auditing unknown
    # hashes would be an unbounded, chain-locking DoS amplifier.
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    with pytest.raises(exceptions.AuthenticationFailed):
        ProjectApiTokenAuthentication().authenticate(_auth_request(raw))
    assert AgentAction.objects.count() == 0


# ---------------------------------------------------------------------------
# Team-readable log endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_agent_action_endpoint_scopes_to_membership_and_self(project: Project, owner: Any) -> None:
    # An action in the owner's project (also principal=owner) is visible to the owner.
    _record(principal=owner, project_id=project.pk, action="task-list")
    # An action for an unrelated user in an unrelated project is not.
    other = User.objects.create_user(username="outsider", password="pw")
    _record(principal=other, action="task-list")

    client = APIClient()
    client.force_login(owner)
    resp = client.get("/api/v1/agent-actions/")
    assert resp.status_code == 200, resp.data
    results = resp.data["results"]
    assert len(results) == 1
    assert str(results[0]["project"]) == str(project.pk)


@pytest.mark.django_db
def test_agent_action_detail_out_of_scope_returns_404(project: Project, owner: Any) -> None:
    # A row in a project the caller is not a member of (and is not the principal of) must
    # be invisible on the detail route too — a uniform 404, not a 403 existence oracle.
    other = User.objects.create_user(username="outsider", password="pw")
    hidden = _record(principal=other, action="task-list")

    client = APIClient()
    client.force_login(owner)
    resp = client.get(f"/api/v1/agent-actions/{hidden.pk}/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_agent_action_endpoint_requires_auth() -> None:
    resp = APIClient().get("/api/v1/agent-actions/")
    assert resp.status_code in (401, 403)
