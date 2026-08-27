"""Last-pull outcome on an external-source connection (#2925, ADR-0097 §4/§5).

Before this, a connection reported ``status`` + ``last_synced_at`` and nothing
about the pull, so "Connected, last synced 5 minutes ago" read identically
whether the pull stored 200 items, zero, or failed — and a contributor with more
assigned issues than the source's page size got a silently partial My Work.

Four things are asserted here, in the order they matter:

1. A successful pull records what it did (``fetched`` / ``stored`` /
   ``total_available``) onto ``config["last_sync"]``.
2. Truncation is *detected* on each of its three independent routes: the
   provider's own total exceeding what we stored, the cache cap biting, and the
   full-page fallback for a source that reports no total.
3. Every failure path records an outcome with a **closed-vocabulary** reason —
   never an exception string, because ``config`` is owner-readable and the
   exception text on these paths can carry the request URL or provider PII.
4. The two read surfaces (``GET /me/connections/{source}/`` and the My Work
   ``external_sources`` block) expose it, projected field-by-field rather than
   echoing the schemaless stored ``config``.

Outbound HTTP is mocked at ``integrations.http.get`` — the single egress
chokepoint the Jira source routes through — so no test touches the network.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AbstractBaseUser
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http, tasks
from trueppm_api.apps.integrations.connections import last_sync_summary
from trueppm_api.apps.integrations.encryption import encrypt_secret
from trueppm_api.apps.integrations.external_sources import (
    ExternalFetchResult,
    ExternalTaskSource,
    ExternalWorkItemDTO,
)
from trueppm_api.apps.integrations.me_work import external_source_summaries
from trueppm_api.apps.integrations.models import (
    ExternalSyncRequest,
    ExternalSyncRequestStatus,
    IntegrationCredential,
)

User = get_user_model()

pytestmark = pytest.mark.django_db

_JIRA_BASE = "https://acme.atlassian.net"


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------


class _FakeResult:
    id = "fake-task-id"


@pytest.fixture(autouse=True)
def _no_broker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tasks.external_sync, "delay", lambda *a, **k: _FakeResult())


@pytest.fixture
def user() -> AbstractBaseUser:
    return User.objects.create_user(username="outcome_user", password="pw")


@pytest.fixture
def client(user: AbstractBaseUser) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _connect(user: AbstractBaseUser, **config: Any) -> IntegrationCredential:
    cfg: dict[str, Any] = {"account_email": "priya@acme.io", "jql": "", "status": "connected"}
    cfg.update(config)
    return IntegrationCredential.objects.create(
        user=user,
        provider="jira",
        secret_ciphertext=encrypt_secret("jira-token"),
        base_url=_JIRA_BASE,
        config=cfg,
    )


def _pending_request(user: AbstractBaseUser) -> ExternalSyncRequest:
    return ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DISPATCHED
    )


def _issue(key: str) -> dict[str, Any]:
    return {
        "key": key,
        "fields": {
            "summary": "Do a thing",
            "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
            "duedate": None,
        },
    }


def _mock_search(
    monkeypatch: pytest.MonkeyPatch, issues: list[dict[str, Any]], total: Any = None
) -> None:
    """Mock the Jira search. ``total`` omitted mirrors a provider that sends none."""
    payload: dict[str, Any] = {"issues": issues}
    if total is not None:
        payload["total"] = total
    body = json.dumps(payload).encode()
    monkeypatch.setattr(http, "get", lambda *a, **k: http.EgressResponse(200, body, {}))


def _sync(user: AbstractBaseUser) -> IntegrationCredential:
    """Run one pull for ``user`` and return the reloaded credential row."""
    req = _pending_request(user)
    tasks._do_sync(str(req.id))
    return IntegrationCredential.objects.get(user=user, provider="jira")


# ---------------------------------------------------------------------------
# A successful pull records what it did
# ---------------------------------------------------------------------------


def test_successful_pull_records_counts(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    _mock_search(monkeypatch, [_issue(f"RIV-{n}") for n in range(4)], total=4)

    cred = _sync(user)

    outcome = cred.config["last_sync"]
    assert outcome["ok"] is True
    assert outcome["reason"] == ""
    assert outcome["fetched"] == 4
    assert outcome["stored"] == 4
    assert outcome["total_available"] == 4
    assert outcome["truncated"] is False
    assert outcome["at"]


def test_successful_empty_pull_is_recorded_not_absent(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Zero items is an outcome, and must be distinguishable from "never pulled"."""
    _connect(user)
    _mock_search(monkeypatch, [], total=0)

    outcome = _sync(user).config["last_sync"]

    assert outcome["ok"] is True
    assert outcome["stored"] == 0
    assert outcome["truncated"] is False


# ---------------------------------------------------------------------------
# Truncation — three independent detection routes
# ---------------------------------------------------------------------------


def test_truncation_detected_from_the_providers_own_total(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exact case from the issue: >100 assigned issues, one 100-item page."""
    _connect(user)
    _mock_search(monkeypatch, [_issue(f"RIV-{n}") for n in range(100)], total=412)

    outcome = _sync(user).config["last_sync"]

    assert outcome["truncated"] is True
    assert outcome["stored"] == 100
    assert outcome["total_available"] == 412


def test_truncation_detected_from_the_cache_cap(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """More DTOs came back than the cache cap allows — stored < fetched."""
    _connect(user)
    monkeypatch.setattr(tasks, "CACHE_ITEM_CAP", 3)
    _mock_search(monkeypatch, [_issue(f"RIV-{n}") for n in range(10)], total=10)

    outcome = _sync(user).config["last_sync"]

    assert outcome["fetched"] == 10
    assert outcome["stored"] == 3
    assert outcome["truncated"] is True


def test_a_duplicated_id_is_deduplication_not_truncation(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``stored`` counts distinct ids, so ``stored < fetched`` is not a cap hit.

    A page carrying a duplicate would otherwise satisfy the cap rung with the
    cap nowhere in sight, and tell an owner their complete list is partial.
    """
    _connect(user)
    monkeypatch.setattr(tasks, "CACHE_ITEM_CAP", 500)
    _mock_search(monkeypatch, [_issue("RIV-1"), _issue("RIV-1"), _issue("RIV-2")], total=2)

    outcome = _sync(user).config["last_sync"]

    assert outcome["fetched"] == 3
    assert outcome["stored"] == 2
    assert outcome["truncated"] is False


def test_truncation_falls_back_to_a_full_page_when_no_total_is_reported(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No ``total`` in the body: a full page is the only remaining signal."""
    _connect(user)
    monkeypatch.setattr(tasks, "CACHE_ITEM_CAP", 500)
    _mock_search(monkeypatch, [_issue(f"RIV-{n}") for n in range(100)])

    outcome = _sync(user).config["last_sync"]

    assert outcome["truncated"] is True
    # Unknown, not zero — the client must not render a denominator from this.
    assert outcome["total_available"] is None


def test_a_short_page_with_no_total_is_not_reported_as_truncated(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    _mock_search(monkeypatch, [_issue(f"RIV-{n}") for n in range(7)])

    outcome = _sync(user).config["last_sync"]

    assert outcome["truncated"] is False
    assert outcome["stored"] == 7


def test_a_nonsense_total_degrades_to_unknown(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider-supplied total that is not a count must not become a denominator."""
    _connect(user)
    _mock_search(monkeypatch, [_issue("RIV-1")], total="lots")

    outcome = _sync(user).config["last_sync"]

    assert outcome["total_available"] is None
    assert outcome["truncated"] is False


# ---------------------------------------------------------------------------
# Failure paths — every one records a closed-vocabulary reason
# ---------------------------------------------------------------------------


def _mock_status(monkeypatch: pytest.MonkeyPatch, status_code: int) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: http.EgressResponse(status_code, b"{}", {}))


def test_auth_failure_records_the_reason(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    _mock_status(monkeypatch, 401)

    cred = _sync(user)

    assert cred.config["status"] == "auth_failed"
    outcome = cred.config["last_sync"]
    assert outcome["ok"] is False
    assert outcome["reason"] == tasks.SYNC_REASON_AUTH_FAILED
    assert outcome["stored"] == 0
    assert outcome["truncated"] is False


def test_invalid_filter_records_the_reason(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A stored project key that is not a project key — the pull refuses rather
    # than widening past what the owner selected (#2888).
    _connect(user, project_keys=["RIV'; DROP"])
    _mock_search(monkeypatch, [_issue("RIV-1")])

    cred = _sync(user)

    assert cred.config["status"] == "invalid_filter"
    assert cred.config["last_sync"]["reason"] == tasks.SYNC_REASON_INVALID_FILTER


def test_unreachable_records_the_reason_without_flipping_the_status(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 5xx is not an auth problem — the outcome is recorded, the status is not."""
    _connect(user)
    _mock_status(monkeypatch, 503)

    cred = _sync(user)

    assert cred.config["status"] == "connected"
    assert cred.config["last_sync"]["ok"] is False
    assert cred.config["last_sync"]["reason"] == tasks.SYNC_REASON_UNREACHABLE


def test_undecryptable_credential_records_the_reason(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    cred = _connect(user)
    cred.secret_ciphertext = b"not-a-fernet-token"
    cred.save(update_fields=["secret_ciphertext"])
    _mock_search(monkeypatch, [_issue("RIV-1")])

    reloaded = _sync(user)

    assert reloaded.config["last_sync"]["reason"] == tasks.SYNC_REASON_DECRYPT_FAILED


def test_a_rate_limit_requeue_is_not_recorded_as_a_failed_pull(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pull is still in flight — reporting a failure would be a lie."""
    _connect(user)
    monkeypatch.setattr(
        http, "get", lambda *a, **k: http.EgressResponse(429, b"{}", {"Retry-After": "30"})
    )

    cred = _sync(user)

    assert "last_sync" not in cred.config


def test_a_spent_rate_limit_budget_is_recorded(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    monkeypatch.setattr(
        http, "get", lambda *a, **k: http.EgressResponse(429, b"{}", {"Retry-After": "30"})
    )
    req = _pending_request(user)
    req.attempt_count = tasks._MAX_RATE_LIMIT_ATTEMPTS - 1
    req.save(update_fields=["attempt_count"])

    tasks._do_sync(str(req.id))

    cred = IntegrationCredential.objects.get(user=user, provider="jira")
    assert cred.config["last_sync"]["reason"] == tasks.SYNC_REASON_RATE_LIMITED


def test_a_formatted_reason_never_leaves_the_read_boundary() -> None:
    """The vocabulary fails closed on read, not only on write.

    Writer discipline alone leaves the guarantee unenforced at the one boundary
    that serves it, and ``config`` is a schemaless column an Enterprise
    integration also writes to. Type-checking would enforce nothing here — the
    thing that must never reach a client is a *formatted string*, and a formatted
    string is a ``str``.
    """
    leaked = "Jira unreachable: https://acme.atlassian.net/rest/api/3/search?jql=assignee..."

    projected = last_sync_summary({"last_sync": {"ok": False, "reason": leaked}})

    assert projected is not None
    assert projected["reason"] == ""


def test_a_concurrent_filter_edit_survives_the_workers_write(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The worker merges its own keys; it must not rewrite the owner's.

    ``config`` is one JSON column shared between the connect wizard and this
    worker, and a whole-column save from the snapshot loaded before the fetch
    reverts anything the owner changed mid-pull. That is not cosmetic:
    ``project_keys`` is ANDed into the JQL (#2888) so reverting it *widens* the
    next pull past what the owner selected.
    """
    _connect(user, project_keys=["OLD"])
    req = _pending_request(user)

    def _fetch_then_owner_edits(*a: Any, **k: Any) -> http.EgressResponse:
        # Stand in for the owner saving a narrower filter while the pull is in
        # flight — a direct UPDATE, exactly as the PUT handler would leave it.
        IntegrationCredential.objects.filter(user=user, provider="jira").update(
            config={
                "account_email": "priya@acme.io",
                "jql": "",
                "status": "connected",
                "project_keys": ["NARROW"],
            }
        )
        return http.EgressResponse(200, json.dumps({"issues": [], "total": 0}).encode(), {})

    monkeypatch.setattr(http, "get", _fetch_then_owner_edits)
    tasks._do_sync(str(req.id))

    cfg = IntegrationCredential.objects.get(user=user, provider="jira").config
    assert cfg["project_keys"] == ["NARROW"]
    # …and the worker's own keys still landed.
    assert cfg["last_sync"]["ok"] is True
    assert cfg["status"] == "connected"


def test_the_outcome_timestamp_matches_its_siblings_spelling(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``at`` and ``last_synced_at`` are in the same object — one spelling."""
    _connect(user)
    _mock_search(monkeypatch, [_issue("RIV-1")], total=1)
    _sync(user)

    body = client.get("/api/v1/me/connections/jira/").json()

    assert body["last_sync"]["at"].endswith("Z")
    assert body["last_synced_at"].endswith("Z")


def test_every_recorded_reason_is_from_the_closed_vocabulary(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard that keeps a URL or provider body out of an owner-readable field.

    A regression here is a disclosure bug, not a copy bug: interpolating the
    exception into ``reason`` would put the request URL — which embeds the
    owner's JQL, and on some deployments the credential — behind a plain
    ``GET /me/connections/jira/``.
    """
    _connect(user)
    for status_code in (401, 403, 500, 503):
        _mock_status(monkeypatch, status_code)
        cred = _sync(user)
        reason = cred.config["last_sync"]["reason"]
        assert reason in tasks.SYNC_FAILURE_REASONS
        # Reset so the auth_failed flip does not change the later iterations.
        cred.config = {**cred.config, "status": "connected"}
        cred.save(update_fields=["config"])


# ---------------------------------------------------------------------------
# The extension point stays backward compatible
# ---------------------------------------------------------------------------


class _LegacySource(ExternalTaskSource):
    """A source written before #2925 — implements only the abstract read."""

    key = "legacy"
    label = "Legacy"

    def fetch_assigned_items(
        self, *, base_url: str, secret: str, config: dict[str, Any]
    ) -> list[ExternalWorkItemDTO]:
        return [
            ExternalWorkItemDTO(
                external_id="L-1",
                external_url="https://example.test/L-1",
                title="Legacy item",
                external_status="Open",
                display_bucket="todo",
            )
        ]


def test_a_source_that_predates_the_result_api_still_works() -> None:
    """The ABC default must wrap the old method and claim *unknown* bounds.

    An Enterprise source registered against this ABC cannot be recompiled by an
    OSS change, so the new call has to work against the old implementation — and
    must not invent a truncation signal it has no basis for.
    """
    result = _LegacySource().fetch_assigned_items_result(base_url="", secret="", config={})

    assert isinstance(result, ExternalFetchResult)
    assert len(result.items) == 1
    assert result.total_available is None
    assert result.page_size is None


# ---------------------------------------------------------------------------
# Read surfaces
# ---------------------------------------------------------------------------


def test_connection_summary_exposes_the_outcome(
    client: APIClient, user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    _mock_search(monkeypatch, [_issue(f"RIV-{n}") for n in range(100)], total=412)
    _sync(user)

    body = client.get("/api/v1/me/connections/jira/").json()

    assert body["last_sync"]["truncated"] is True
    assert body["last_sync"]["stored"] == 100
    assert body["last_sync"]["total_available"] == 412
    assert body["last_sync"]["ok"] is True


def test_connection_summary_outcome_is_null_before_the_first_pull(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """ "No pull yet" is a different state from "a pull that stored nothing"."""
    _connect(user)

    body = client.get("/api/v1/me/connections/jira/").json()

    assert body["exists"] is True
    assert body["last_sync"] is None


def test_summary_does_not_echo_unknown_config_keys(
    client: APIClient, user: AbstractBaseUser
) -> None:
    """``config`` is schemaless and shared — only reviewed keys may reach a client."""
    _connect(user, poll_enabled=True, some_future_secret="do-not-leak")

    body = client.get("/api/v1/me/connections/jira/").json()

    assert "some_future_secret" not in body
    # ``poll_enabled`` became a *reviewed* key in #3104 — it is the owner's own
    # setting and the switch that writes it has to read its state back. The rule
    # this test guards is unchanged: a key reaches a client only by being
    # projected explicitly in ``_summary``, never by ``config`` being echoed.
    assert body["poll_enabled"] is True
    assert "config" not in body
    assert "secret" not in body and "secret_ciphertext" not in body


@pytest.mark.parametrize(
    "stored",
    [
        "not-a-dict",
        {"ok": "yes", "fetched": -4, "stored": None, "total_available": True, "at": 17},
        {},
    ],
)
def test_a_malformed_stored_outcome_degrades_instead_of_raising(stored: Any) -> None:
    """A hand-edited or pre-#2925 row must render, not 500 the owner's settings page."""
    projected = last_sync_summary({"last_sync": stored})

    if projected is None:
        assert stored == "not-a-dict"
        return
    assert projected["fetched"] == 0
    assert projected["stored"] == 0
    assert projected["total_available"] is None
    assert projected["at"] is None or isinstance(projected["at"], str)


def test_my_work_source_block_carries_the_outcome(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """My Work is where the truncated list is actually read, so it must say so."""
    _connect(user)
    _mock_search(monkeypatch, [_issue(f"RIV-{n}") for n in range(100)], total=250)
    _sync(user)

    summaries = external_source_summaries(user)

    assert len(summaries) == 1
    assert summaries[0]["last_sync"]["truncated"] is True
    assert summaries[0]["last_sync"]["stored"] == 100
    assert summaries[0]["last_sync"]["total_available"] == 250
