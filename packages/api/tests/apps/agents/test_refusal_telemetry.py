"""Tests for the refusal-telemetry side-car (ADR-0421, #1850).

The side-car (``AgentActionRefusalDetail``) records *which constraint fired* and the
*projected impact* of a refusal, non-hashed and 1:1 with its ``AgentAction``. Coverage:

  * ``record_agent_action`` — a refusal with a constraint gets a side-car; a non-refusal
    or a constraint-less refusal does not; ``projected_impact`` round-trips;
  * the side-car is **outside** the hash chain — ``audit_verify`` still passes and the
    ``record_hash`` recomputes without it (proving it is not part of ``canonical_fields``);
  * the live identity producer writes the ``token_identity`` constraint end-to-end (the
    MCP-scope *policy* producer records best-effort — a denied request taints its
    transaction so the write is skipped, exactly as the pre-existing ``refusal_reason``
    policy audit is; its constraint wiring is covered at the service level above);
  * the read endpoint nests ``refusal_detail`` (null when absent) and supports the
    ``?constraint=`` triage filter, still membership-scoped.
"""

from __future__ import annotations

import secrets
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.utils import timezone
from rest_framework import exceptions
from rest_framework.test import APIClient, APIRequestFactory

from trueppm_api.apps.agents.canonical import canonical_fields, compute_record_hash
from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionRefusalDetail,
    AgentActionRefusalReason,
    AgentActionVerdict,
    AgentActorKind,
    RefusalConstraint,
)
from trueppm_api.apps.agents.services import record_agent_action
from trueppm_api.apps.projects.authentication import (
    TOKEN_PREFIX,
    ProjectApiTokenAuthentication,
    sha256_hex,
)
from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="agent_owner", password="pw")


def _mint_personal(owner: Any, **kwargs: Any) -> tuple[ApiToken, str]:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ApiToken.objects.create(
        owner=owner,
        name="personal-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_MCP_READ],
        **kwargs,
    )
    return token, raw


def _record(**overrides: Any) -> AgentAction:
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
# Service — side-car creation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_refusal_with_constraint_creates_sidecar() -> None:
    entry = _record(
        verdict=AgentActionVerdict.REFUSED,
        refusal_reason=AgentActionRefusalReason.POLICY,
        refusal_constraint=RefusalConstraint.CAPABILITY_SCOPE,
    )
    detail = AgentActionRefusalDetail.objects.get(action=entry)
    assert detail.constraint == RefusalConstraint.CAPABILITY_SCOPE
    # No producer populates impact yet — an honest empty, not a fabricated impact.
    assert detail.projected_impact == {}
    # The reverse OneToOne is reachable from the row.
    assert entry.refusal_detail.constraint == RefusalConstraint.CAPABILITY_SCOPE


@pytest.mark.django_db
def test_projected_impact_round_trips() -> None:
    impact = {"affected_task_count": 3, "slip_days": 4.5, "critical_path_delta_days": 2}
    entry = _record(
        verdict=AgentActionVerdict.REFUSED,
        refusal_reason=AgentActionRefusalReason.POLICY,
        refusal_constraint=RefusalConstraint.GRAPH_VALIDATION,
        projected_impact=impact,
    )
    assert entry.refusal_detail.projected_impact == impact


@pytest.mark.django_db
def test_non_refusal_verdict_drops_constraint_and_sidecar() -> None:
    # A constraint passed on an allowed verdict must never persist a dangling side-car
    # (mirrors how refusal_reason is cleared on a non-refusal).
    entry = _record(
        verdict=AgentActionVerdict.ALLOWED,
        refusal_constraint=RefusalConstraint.CAPABILITY_SCOPE,
    )
    assert not AgentActionRefusalDetail.objects.filter(action=entry).exists()


@pytest.mark.django_db
def test_refusal_without_constraint_has_no_sidecar() -> None:
    # A bare refusal (no constraint given) is still a valid chain row with no side-car —
    # backward-compatible with pre-#1850 refusal callers.
    entry = _record(
        verdict=AgentActionVerdict.REFUSED,
        refusal_reason=AgentActionRefusalReason.POLICY,
    )
    assert not AgentActionRefusalDetail.objects.filter(action=entry).exists()


# ---------------------------------------------------------------------------
# Side-car is NOT part of the hashed chain
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sidecar_is_not_hashed_and_chain_still_verifies() -> None:
    entry = _record(
        verdict=AgentActionVerdict.REFUSED,
        refusal_reason=AgentActionRefusalReason.POLICY,
        refusal_constraint=RefusalConstraint.CAPABILITY_SCOPE,
        projected_impact={"affected_task_count": 9},
    )
    # canonical_fields (the hashed body) contains no constraint/impact key.
    body = canonical_fields(entry)
    assert "constraint" not in body
    assert "projected_impact" not in body
    # The record_hash recomputes from the body alone — the side-car does not enter it.
    assert entry.record_hash == compute_record_hash(entry.prev_hash, body)
    # And audit_verify passes end-to-end with a side-car present.
    call_command("audit_verify")


# ---------------------------------------------------------------------------
# Producers — the two live refusal paths write the right constraint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_identity_refusal_records_token_identity_constraint(owner: Any) -> None:
    token, raw = _mint_personal(owner, revoked_at=timezone.now())
    request = APIRequestFactory().get("/", HTTP_AUTHORIZATION=f"Bearer {raw}")
    with pytest.raises(exceptions.AuthenticationFailed):
        ProjectApiTokenAuthentication().authenticate(request)

    action = AgentAction.objects.get(actor_token=token)
    assert action.refusal_reason == AgentActionRefusalReason.IDENTITY
    assert action.refusal_detail.constraint == RefusalConstraint.TOKEN_IDENTITY
    assert action.refusal_detail.projected_impact == {}


# ---------------------------------------------------------------------------
# Read endpoint — nested detail + ?constraint= filter
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_endpoint_nests_refusal_detail(owner: Any) -> None:
    _record(
        principal=owner,
        verdict=AgentActionVerdict.REFUSED,
        refusal_reason=AgentActionRefusalReason.POLICY,
        refusal_constraint=RefusalConstraint.CAPABILITY_SCOPE,
    )
    client = APIClient()
    client.force_login(owner)
    resp = client.get("/api/v1/agent-actions/?verdict=refused")
    assert resp.status_code == 200, resp.data
    row = resp.data["results"][0]
    assert row["refusal_detail"] == {
        "constraint": RefusalConstraint.CAPABILITY_SCOPE,
        "projected_impact": {},
    }


@pytest.mark.django_db
def test_endpoint_allowed_action_has_null_refusal_detail(owner: Any) -> None:
    _record(principal=owner, verdict=AgentActionVerdict.ALLOWED)
    client = APIClient()
    client.force_login(owner)
    resp = client.get("/api/v1/agent-actions/")
    assert resp.status_code == 200, resp.data
    assert resp.data["results"][0]["refusal_detail"] is None


@pytest.mark.django_db
def test_endpoint_constraint_filter(owner: Any) -> None:
    _record(
        principal=owner,
        action="a",
        verdict=AgentActionVerdict.REFUSED,
        refusal_reason=AgentActionRefusalReason.IDENTITY,
        refusal_constraint=RefusalConstraint.TOKEN_IDENTITY,
    )
    _record(
        principal=owner,
        action="b",
        verdict=AgentActionVerdict.REFUSED,
        refusal_reason=AgentActionRefusalReason.POLICY,
        refusal_constraint=RefusalConstraint.CAPABILITY_SCOPE,
    )
    _record(principal=owner, action="c", verdict=AgentActionVerdict.ALLOWED)

    client = APIClient()
    client.force_login(owner)
    resp = client.get("/api/v1/agent-actions/?constraint=token_identity")
    assert resp.status_code == 200, resp.data
    results = resp.data["results"]
    assert len(results) == 1
    assert results[0]["refusal_detail"]["constraint"] == RefusalConstraint.TOKEN_IDENTITY
