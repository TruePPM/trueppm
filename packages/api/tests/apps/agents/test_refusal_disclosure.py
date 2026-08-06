"""The refusal taxonomy on the wire, not only in the database (ADR-0809, #2689).

The API modelled a two-axis refusal taxonomy, recorded it, and hash-chained it —
and never told the caller that triggered it. An agent operator saw DRF's constant
``PermissionDenied.default_detail`` and had to make a second, separate call to
``GET /agent-actions/?constraint=…`` to learn why. These assert the contract that
closes that.

The contract has three parts, and each is a separate failure mode:

1. a refused **token** call carries ``refusal`` — verdict, reason, and constraint;
2. a refused **human** call does not (this is the regression that would break the
   web client, and the reason the envelope is scoped to token callers);
3. only **disclosable** constraints are named (the allow-list), so wiring the four
   reserved schedule constraints in 0.6 cannot leak plan structure by default.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.agents.models import (
    AgentActionRefusalReason,
    AgentActionVerdict,
    RefusalConstraint,
)
from trueppm_api.apps.agents.refusal import (
    DISCLOSABLE_CONSTRAINTS,
    build_refusal_payload,
    mark_refusal,
    refusal_marks,
)
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# The disclosure allow-list, unit level
# ---------------------------------------------------------------------------


class TestDisclosureAllowList:
    """The allow-list is the security decision in this change; test it directly."""

    def test_live_producers_are_disclosable(self) -> None:
        """Both constraints with a producer today describe the caller's own token."""

        assert RefusalConstraint.TOKEN_IDENTITY in DISCLOSABLE_CONSTRAINTS
        assert RefusalConstraint.CAPABILITY_SCOPE in DISCLOSABLE_CONSTRAINTS

    @pytest.mark.parametrize(
        "constraint",
        [
            RefusalConstraint.GRAPH_VALIDATION,
            RefusalConstraint.SPRINT_SOVEREIGNTY,
            RefusalConstraint.ROLLUP_LOCK,
            RefusalConstraint.ENGINE_REFEREE,
        ],
    )
    def test_schedule_constraints_are_withheld(self, constraint: str) -> None:
        """The four reserved codes describe the plan, not the credential.

        They have no producer today. When 0.6 wires them, this test fails and
        forces the disclosure question to be answered per constraint — a code
        naming a sprint the caller cannot read is an information leak, and the
        default must be silence rather than disclosure.
        """

        assert constraint not in DISCLOSABLE_CONSTRAINTS
        payload = build_refusal_payload(AgentActionRefusalReason.POLICY, constraint)
        assert "constraint" not in payload, (
            f"{constraint} was serialized to the caller. If that is now intended, add it to "
            "DISCLOSABLE_CONSTRAINTS deliberately and say what it may reveal."
        )
        # The refusal is still explained at the coarse axis — withholding the
        # constraint must not degrade to withholding everything.
        assert payload["reason"] == AgentActionRefusalReason.POLICY
        assert payload["verdict"] == AgentActionVerdict.REFUSED

    def test_payload_always_carries_verdict_and_reason(self) -> None:
        payload = build_refusal_payload(AgentActionRefusalReason.IDENTITY, "")
        assert payload == {
            "verdict": AgentActionVerdict.REFUSED,
            "reason": AgentActionRefusalReason.IDENTITY,
        }

    def test_first_mark_wins(self) -> None:
        """Guards are ANDed in order, so the first to deny is the one that decided."""

        class _Req:
            pass

        request = _Req()
        mark_refusal(request, AgentActionRefusalReason.IDENTITY, RefusalConstraint.TOKEN_IDENTITY)
        mark_refusal(request, AgentActionRefusalReason.POLICY, RefusalConstraint.CAPABILITY_SCOPE)

        assert refusal_marks(request) == (
            AgentActionRefusalReason.IDENTITY,
            RefusalConstraint.TOKEN_IDENTITY,
        )


# ---------------------------------------------------------------------------
# Over HTTP
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="agent_owner", password="pw")


def _mcp_token(owner: Any, **kwargs: Any) -> tuple[ApiToken, str]:
    """Mint an owner-scoped mcp:read token; mirrors test_agent_action_audit's helper."""

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


@pytest.mark.django_db
class TestIdentityRefusalOnTheWire:
    def test_revoked_token_401_explains_itself(self, owner: Any) -> None:
        """The case the issue was filed about: a dead token gets a reason, not a status.

        This is also why the envelope cannot key off ``request.auth``: an identity
        refusal is raised by the *authenticator*, so at that moment there is no
        authenticated token to inspect.
        """

        token, raw = _mcp_token(owner)
        token.revoked_at = timezone.now()
        token.save(update_fields=["revoked_at"])

        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
        response = client.get("/api/v1/projects/")

        assert response.status_code == 401
        assert response.json()["refusal"] == {
            "verdict": AgentActionVerdict.REFUSED,
            "reason": AgentActionRefusalReason.IDENTITY,
            "constraint": RefusalConstraint.TOKEN_IDENTITY,
        }

    def test_every_replay_is_explained_not_only_the_first(self, owner: Any) -> None:
        """The audit row is written once per dead token; the explanation is not.

        ``_audit_identity_refusal`` is bounded to one chain-locking write ever, as
        a replay-flood guard. If the *marking* inherited that bound, a caller
        retrying a revoked token would get an explanation once and bare 401s
        after — which reads as a bug in the caller rather than in us.
        """

        token, raw = _mcp_token(owner)
        token.revoked_at = timezone.now()
        token.save(update_fields=["revoked_at"])

        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")

        first = client.get("/api/v1/projects/")
        second = client.get("/api/v1/projects/")

        assert first.status_code == second.status_code == 401
        assert first.json()["refusal"] == second.json()["refusal"]
        assert first.json()["refusal"]["constraint"] == RefusalConstraint.TOKEN_IDENTITY

    def test_expired_token_is_not_distinguishable_from_revoked(self, owner: Any) -> None:
        """Enumeration resistance is preserved: the *detail* string is unchanged.

        The envelope says "identity", which the caller already knows from the 401.
        It must not leak *which* identity failure — revoked, expired, or never
        existed.
        """

        revoked, revoked_raw = _mcp_token(owner)
        revoked.revoked_at = timezone.now()
        revoked.save(update_fields=["revoked_at"])

        expired, expired_raw = _mcp_token(owner)
        expired.expires_at = timezone.now() - timedelta(days=1)
        expired.save(update_fields=["expires_at"])

        client = APIClient()
        bodies = []
        for raw in (revoked_raw, expired_raw):
            client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
            bodies.append(client.get("/api/v1/projects/").json())

        assert bodies[0] == bodies[1]


@pytest.mark.django_db
class TestPolicyRefusalOnTheWire:
    def test_instance_kill_switch_403_names_capability_scope(
        self, owner: Any, settings: Any
    ) -> None:
        settings.TRUEPPM_MCP_ENABLED = False  # type: ignore[attr-defined]
        _, raw = _mcp_token(owner)

        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
        response = client.get("/api/v1/projects/")

        assert response.status_code == 403
        assert response.json()["refusal"] == {
            "verdict": AgentActionVerdict.REFUSED,
            "reason": AgentActionRefusalReason.POLICY,
            "constraint": RefusalConstraint.CAPABILITY_SCOPE,
        }

    def test_audit_and_wire_read_the_same_marks(self) -> None:
        """The response body and the hash-chained record cannot disagree.

        Before this change the audit hardcoded ``capability_scope`` for any 4xx.
        Now both sides resolve from ``refusal_marks(request)``, so a refusal
        explained to the caller as ``token_identity`` is recorded as
        ``token_identity`` too.

        Asserted structurally rather than by reading a row back over HTTP: the
        audit write is best-effort by design — a refusal must never become a 500,
        and it is skipped when the denied request has already tainted its
        transaction — so an end-to-end comparison would be skipped exactly when it
        matters. What can be pinned is that the wiring is present; deleting it is
        the regression, and it is a one-line deletion.
        """

        import inspect

        from trueppm_api.apps.access.permissions import McpReadableViewMixin

        source = inspect.getsource(McpReadableViewMixin._record_mcp_agent_action)
        assert "refusal_marks" in source, (
            "the MCP audit hook no longer reads the refusal marks, so the row it "
            "writes can disagree with what the caller was told (#2689)"
        )


@pytest.mark.django_db
class TestHumanCallersAreUnaffected:
    """The envelope is scoped to the agent surface — this is the regression guard."""

    def test_human_403_carries_no_refusal_envelope(self, owner: Any) -> None:
        """A non-member's 403 on someone else's project is unchanged.

        The web client parses these bodies. Adding a key to every human 403 would
        be a contract change for it, and would put an agent-governance concept in
        front of a person who is not an agent.
        """

        stranger = User.objects.create_user(username="stranger", password="pw")
        project = Project.objects.create(name="Private", start_date=date(2026, 4, 1))

        client = APIClient()
        client.force_authenticate(user=stranger)
        response = client.get(f"/api/v1/projects/{project.pk}/")

        assert response.status_code in (403, 404)
        assert "refusal" not in response.json()

    def test_anonymous_401_carries_no_refusal_envelope(self) -> None:
        response = APIClient().get("/api/v1/projects/")

        assert response.status_code == 401
        assert "refusal" not in response.json()

    def test_garbage_bearer_token_carries_no_envelope(self) -> None:
        """An unknown hash is someone guessing — deliberately not audited, and not
        explained either. Explaining it would hand an attacker a probe oracle."""

        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION="Bearer not-a-real-token")
        response = client.get("/api/v1/projects/")

        assert response.status_code == 401
        assert "refusal" not in response.json()
