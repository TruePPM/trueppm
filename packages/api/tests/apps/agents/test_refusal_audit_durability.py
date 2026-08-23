"""Every refused agent call leaves a durable audit row (#3017, ADR-0902).

Before this, the agent-action log contained **only successes**. ``ATOMIC_REQUESTS``
wraps every view in a transaction and DRF's ``exception_handler`` calls
``set_rollback()`` for every ``APIException``, so both refusal producers — the MCP
permission guard's 403 and the authenticator's 401 for a revoked token — executed their
INSERT and then had it discarded. An operator reading the log saw a clean record of
permitted reads and no evidence at all that an agent had probed projects that had closed
themselves to it, which is precisely what the log exists to make visible.

Both producers are covered here, at savepoint depth rather than under
``transaction=True``, and that choice is load-bearing in both directions:

* **It still catches the bug.** Measured on the unfixed tree with exactly these
  fixtures: 403 → 0 rows, 401 → 0 rows, 200 → 1 row. ``set_rollback()`` unwinds the
  request's atomic block whether that block is the outermost transaction or a savepoint
  inside the test's, so these tests fail if the write ever moves back inside it. The
  mechanism under test is *which block the write runs in*, not how deep that block is.
* **``transaction=True`` would poison the run.** It truncates every table between tests,
  including the ``AgentActionChainHead`` singleton seeded by the initial data migration,
  and Django's flush does not restore migration-seeded rows. Every later test in the
  session that records an agent action then dies on
  ``AgentActionChainHead.DoesNotExist`` — verified, not theorized. A test that proves a
  durability property by breaking the suite behind it is not worth the marginal
  fidelity.

Also pinned here: the *allowed* path stays inline and fail-closed (it must be atomic
with the read it audits), the refusal path stays best-effort (an audit failure must
never turn a 403 into a 500), and the hash chain stays gap-free across both routes.
"""

from __future__ import annotations

import secrets
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.agents.canonical import canonical_fields, compute_record_hash
from trueppm_api.apps.agents.models import (
    GENESIS_PREV_HASH,
    AgentAction,
    AgentActionChainHead,
    AgentActionRefusalReason,
    AgentActionVerdict,
    RefusalConstraint,
)
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken, Calendar, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _seed() -> tuple[Any, Project]:
    """An OWNER-membered project, so a 403 can only come from the MCP opt-out.

    ``get_or_create`` on the chain head is belt-and-braces: the initial data migration
    seeds it, but a ``transaction=True`` test anywhere in the session truncates it away,
    and the resulting ``DoesNotExist`` surfaces here as a 500 that looks nothing like
    the thing being tested.
    """

    AgentActionChainHead.objects.get_or_create(pk=1)
    owner = User.objects.create_user(username=f"audit_{secrets.token_hex(4)}", password="pw")
    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="AuditProbeProj", start_date=date(2026, 4, 1), calendar=calendar
    )
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    return owner, project


def _mint(owner: Any) -> tuple[ApiToken, str]:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ApiToken.objects.create(
        owner=owner,
        name="agent-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_MCP_READ],
    )
    return token, raw


def _agent_client(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _overview(project: Project) -> str:
    return f"/api/v1/projects/{project.id}/overview/"


# ---------------------------------------------------------------------------
# The two refusal producers, under a real (non-savepoint) request transaction
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_policy_refusal_survives_the_request_rollback() -> None:
    """A 403 from the MCP opt-out guard leaves a ``refused``/``policy`` row.

    The measurement in #3017: this returned 403 and wrote zero rows.
    """

    owner, project = _seed()
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])
    _, raw = _mint(owner)

    response = _agent_client(raw).get(_overview(project))

    assert response.status_code == 403
    row = AgentAction.objects.get()
    assert row.verdict == AgentActionVerdict.REFUSED
    assert row.refusal_reason == AgentActionRefusalReason.POLICY
    assert row.refusal_detail.constraint == RefusalConstraint.CAPABILITY_SCOPE
    assert "refused (403)" in row.summary


@pytest.mark.django_db
def test_identity_refusal_survives_the_request_rollback() -> None:
    """A 401 for a revoked token leaves a ``refused``/``identity`` row.

    Not in #3017's measurement table — the issue tested the two policy guards. This
    path was broken the same way, while ``_audit_identity_refusal``'s docstring
    asserted the opposite ("the transaction still commits and the audit row survives").
    """

    owner, project = _seed()
    token, raw = _mint(owner)
    token.revoked_at = timezone.now()
    token.save(update_fields=["revoked_at"])

    response = _agent_client(raw).get(_overview(project))

    assert response.status_code == 401
    row = AgentAction.objects.get()
    assert row.verdict == AgentActionVerdict.REFUSED
    assert row.refusal_reason == AgentActionRefusalReason.IDENTITY
    assert row.action == "authenticate"
    assert row.refusal_detail.constraint == RefusalConstraint.TOKEN_IDENTITY


@pytest.mark.django_db
def test_replayed_dead_token_is_audited_once_not_once_per_replay() -> None:
    """The replay-flood bound only starts working now that the row persists.

    ``_audit_identity_refusal`` gates its write on
    ``AgentAction.objects.filter(actor_token=…, refusal_reason=IDENTITY).exists()`` so a
    replayed revoked token costs one indexed read instead of re-taking the global chain
    lock. That gate reads *committed* state — and until #3017 the row it looks for was
    always rolled back, so it never fired. Every replay of a revoked token therefore
    took the chain lock and wrote a row that was then discarded, on a path DRF runs
    **before throttling**. Making the row durable is what makes the bound real.
    """

    owner, project = _seed()
    token, raw = _mint(owner)
    token.revoked_at = timezone.now()
    token.save(update_fields=["revoked_at"])
    client = _agent_client(raw)

    assert client.get(_overview(project)).status_code == 401
    assert client.get(_overview(project)).status_code == 401
    assert client.get(_overview(project)).status_code == 401

    assert AgentAction.objects.count() == 1


@pytest.mark.django_db
def test_allowed_read_is_still_audited_exactly_once() -> None:
    """The allowed path is unchanged: one ``allowed`` row, written with the read."""

    owner, project = _seed()
    _, raw = _mint(owner)

    response = _agent_client(raw).get(_overview(project))

    assert response.status_code == 200
    row = AgentAction.objects.get()
    assert row.verdict == AgentActionVerdict.ALLOWED
    assert row.refusal_reason == ""


# ---------------------------------------------------------------------------
# Chain integrity across the two write routes
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_chain_stays_linked_across_inline_and_deferred_writes() -> None:
    """Deferring *when* a row is written must not give the chain a second writer.

    ``record_agent_action`` still serializes on the chain head either way, so an
    allowed read (inline, inside the request transaction) and a refusal (deferred, in
    its own) must interleave into one gap-free, correctly-linked chain. This is the
    property that ruled out the alternatives — a second DB connection or an outbox
    worker would each have introduced a writer that this assertion could not hold for.
    """

    owner, project = _seed()
    _, raw = _mint(owner)
    client = _agent_client(raw)

    assert client.get(_overview(project)).status_code == 200
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])
    assert client.get(_overview(project)).status_code == 403
    project.mcp_enabled = True
    project.save(update_fields=["mcp_enabled"])
    assert client.get(_overview(project)).status_code == 200

    rows = list(AgentAction.objects.order_by("sequence"))
    assert [r.verdict for r in rows] == [
        AgentActionVerdict.ALLOWED,
        AgentActionVerdict.REFUSED,
        AgentActionVerdict.ALLOWED,
    ]
    # The same walk `manage.py audit_verify` performs: gap-free sequence, linked
    # prev_hash, and a record_hash that recomputes.
    expected_prev = GENESIS_PREV_HASH
    for index, row in enumerate(rows, start=1):
        assert row.sequence == index
        assert row.prev_hash == expected_prev
        assert row.record_hash == compute_record_hash(row.prev_hash, canonical_fields(row))
        expected_prev = row.record_hash


# ---------------------------------------------------------------------------
# Best-effort: an audit failure must not escalate a refusal
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_failed_refusal_audit_does_not_turn_a_403_into_a_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refusal is already the safe outcome; losing its audit must not escalate it.

    The inverse of the allowed path, which is fail-closed on purpose.
    """

    owner, project = _seed()
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])
    _, raw = _mint(owner)

    def _boom(**_kwargs: Any) -> None:
        raise RuntimeError("audit substrate unavailable")

    monkeypatch.setattr("trueppm_api.apps.agents.services.record_agent_action", _boom)

    response = _agent_client(raw).get(_overview(project))

    assert response.status_code == 403
    assert AgentAction.objects.count() == 0


# ---------------------------------------------------------------------------
# A server error is not a refusal
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_server_error_is_not_recorded_as_a_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 500 must not become a ``refused``/``policy`` row.

    ``verdict`` was derived from ``status < 400``, so any 5xx resolved to
    refused/policy/capability_scope — "a guard denied you", about a request no guard
    ever ruled on. It was latent while every refusal row was rolled back; the moment
    refusals persist it becomes a false denial in the operator's log.
    """

    owner, project = _seed()
    _, raw = _mint(owner)

    def _explode(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("view blew up")

    monkeypatch.setattr(
        "trueppm_api.apps.access.permissions.McpReadableViewMixin._mcp_audit_target",
        _explode,
    )

    client = _agent_client(raw)
    client.raise_request_exception = False
    response = client.get(_overview(project))

    assert response.status_code == 500
    assert AgentAction.objects.count() == 0


# ---------------------------------------------------------------------------
# The queue itself
# ---------------------------------------------------------------------------


def test_queue_lands_on_the_underlying_http_request() -> None:
    """DRF's ``Request`` proxies reads to ``_request`` but stores writes on itself.

    The middleware only ever sees the Django ``HttpRequest``, so queueing onto the DRF
    wrapper would put the list somewhere the drain can never find it — a failure mode
    that would look exactly like the bug this fixes.
    """

    from django.test import RequestFactory
    from rest_framework.request import Request

    from trueppm_api.apps.agents.deferred import QUEUE_ATTR, queue_agent_action

    http_request = RequestFactory().get("/api/v1/projects/")
    drf_request = Request(http_request)

    queue_agent_action(drf_request, action="probe")

    assert getattr(http_request, QUEUE_ATTR) == [{"action": "probe"}]


@pytest.mark.django_db
def test_drain_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """A second drain must not re-append — a hash chain has no room for a duplicate."""

    from django.test import RequestFactory

    from trueppm_api.apps.agents import deferred

    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "trueppm_api.apps.agents.services.record_agent_action",
        lambda **kwargs: calls.append(kwargs),
    )

    request = RequestFactory().get("/api/v1/projects/")
    deferred.queue_agent_action(request, action="probe")

    assert deferred.drain_agent_actions(request) == 1
    assert deferred.drain_agent_actions(request) == 0
    assert len(calls) == 1


@pytest.mark.django_db
def test_middleware_drains_even_when_the_view_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """The drain is in a ``finally``: an exception below must not strand the queue."""

    from django.test import RequestFactory

    from trueppm_api.apps.agents import deferred
    from trueppm_api.apps.agents.middleware import AgentActionAuditMiddleware

    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "trueppm_api.apps.agents.services.record_agent_action",
        lambda **kwargs: calls.append(kwargs),
    )

    request = RequestFactory().get("/api/v1/projects/")

    def _explode(req: Any) -> Any:
        deferred.queue_agent_action(req, action="probe")
        raise RuntimeError("downstream middleware failed")

    middleware = AgentActionAuditMiddleware(_explode)
    with pytest.raises(RuntimeError):
        middleware(request)

    assert len(calls) == 1
