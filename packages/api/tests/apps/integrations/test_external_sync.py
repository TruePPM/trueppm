"""Tests for the user-scoped external task sync engine (ADR-0097 §4, #1419).

Covers the four moving parts the sync worker adds on top of the #1418 data layer:

1. ``_do_sync`` worker — upsert, soft-remove-missing, auth_failed flip, transient
   failure preserving the last-good cache, and idempotent no-op on a terminal row.
2. ``enqueue_external_sync`` service — PENDING row creation, adopt-existing
   idempotency, and the manual-refresh cooldown.
3. ``_do_drain`` / ``_do_purge`` / ``_do_poll`` outbox machinery.
4. The REST surface — ``POST /me/connections/{source}/sync/`` (202 / 429 / 400 /
   404) and ``GET /me/external-items/`` (personal isolation, stale hidden).

Outbound HTTP is mocked at ``integrations.http.get`` (the single egress
chokepoint the Jira source routes through), so no test touches the network.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AbstractBaseUser
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.integrations import http, tasks
from trueppm_api.apps.integrations.encryption import encrypt_secret
from trueppm_api.apps.integrations.models import (
    ExternalSyncRequest,
    ExternalSyncRequestReason,
    ExternalSyncRequestStatus,
    ExternalWorkItem,
    IntegrationCredential,
)
from trueppm_api.apps.integrations.services import (
    MANUAL_SYNC_COOLDOWN_SECONDS,
    SyncCooldownActive,
    enqueue_external_sync,
)
from trueppm_api.apps.projects.models import VersionedModel

User = get_user_model()

pytestmark = pytest.mark.django_db

_JIRA_BASE = "https://acme.atlassian.net"


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------


class _FakeResult:
    """Stand-in for a Celery ``AsyncResult`` so dispatch code has an ``.id``."""

    id = "fake-task-id"


@pytest.fixture(autouse=True)
def _no_broker(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stop any ``external_sync.delay`` from reaching a real broker.

    The service dispatches through ``transaction.on_commit``; in a django_db test
    that callback is captured rather than run, but stubbing ``.delay`` regardless
    keeps the drain tests (which call it directly) hermetic.
    """
    monkeypatch.setattr(tasks.external_sync, "delay", lambda *a, **k: _FakeResult())


@pytest.fixture
def user() -> AbstractBaseUser:
    return User.objects.create_user(username="sync_user", password="pw")


@pytest.fixture
def other_user() -> AbstractBaseUser:
    return User.objects.create_user(username="sync_other", password="pw")


@pytest.fixture
def client(user: AbstractBaseUser) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _connect(user: AbstractBaseUser, *, status: str = "connected") -> IntegrationCredential:
    """Create a connected Jira credential row for ``user``."""
    return IntegrationCredential.objects.create(
        user=user,
        provider="jira",
        secret_ciphertext=encrypt_secret("jira-token"),
        base_url=_JIRA_BASE,
        config={"account_email": "priya@acme.io", "jql": "", "status": status},
    )


def _pending_request(user: AbstractBaseUser) -> ExternalSyncRequest:
    return ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DISPATCHED
    )


def _issue(
    key: str, category: str = "indeterminate", summary: str = "Do a thing"
) -> dict[str, Any]:
    return {
        "key": key,
        "fields": {
            "summary": summary,
            "status": {"name": "In Progress", "statusCategory": {"key": category}},
            "duedate": "2026-08-01",
        },
    }


def _mock_search(monkeypatch: pytest.MonkeyPatch, issues: list[dict[str, Any]]) -> None:
    body = json.dumps({"issues": issues}).encode()
    monkeypatch.setattr(http, "get", lambda *a, **k: http.EgressResponse(200, body, {}))


def _mock_status(monkeypatch: pytest.MonkeyPatch, status_code: int) -> None:
    monkeypatch.setattr(http, "get", lambda *a, **k: http.EgressResponse(status_code, b"{}", {}))


# ---------------------------------------------------------------------------
# _do_sync — worker
# ---------------------------------------------------------------------------


def test_sync_upserts_items_and_marks_done(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    cred = _connect(user)
    req = _pending_request(user)
    _mock_search(monkeypatch, [_issue("RIV-1", "new"), _issue("RIV-2", "done")])

    tasks._do_sync(str(req.id))

    items = {i.external_id: i for i in ExternalWorkItem.objects.filter(user=user)}
    assert set(items) == {"RIV-1", "RIV-2"}
    assert items["RIV-1"].display_bucket == "todo"
    assert items["RIV-2"].display_bucket == "done"
    assert items["RIV-1"].external_url == f"{_JIRA_BASE}/browse/RIV-1"
    assert items["RIV-1"].is_stale is False

    req.refresh_from_db()
    cred.refresh_from_db()
    assert req.status == ExternalSyncRequestStatus.DONE
    assert cred.config["status"] == "connected"
    assert cred.last_used_at is not None


def test_sync_reactivates_a_previously_stale_item(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An item that reappears in Jira is un-stale'd (update_or_create path)."""
    _connect(user)
    ExternalWorkItem.objects.create(user=user, source="jira", external_id="RIV-1", is_stale=True)
    req = _pending_request(user)
    _mock_search(monkeypatch, [_issue("RIV-1")])

    tasks._do_sync(str(req.id))

    item = ExternalWorkItem.objects.get(user=user, external_id="RIV-1")
    assert item.is_stale is False


def test_sync_soft_removes_vanished_items(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    ExternalWorkItem.objects.create(user=user, source="jira", external_id="OLD-9", is_stale=False)
    req = _pending_request(user)
    _mock_search(monkeypatch, [_issue("RIV-1")])

    tasks._do_sync(str(req.id))

    # OLD-9 was not in this pull → soft-removed, not deleted.
    old = ExternalWorkItem.objects.get(user=user, external_id="OLD-9")
    assert old.is_stale is True
    assert ExternalWorkItem.objects.filter(user=user, external_id="RIV-1", is_stale=False).exists()


def test_sync_auth_failed_flips_connection_and_keeps_cache(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    cred = _connect(user)
    keep = ExternalWorkItem.objects.create(
        user=user, source="jira", external_id="RIV-1", is_stale=False
    )
    req = _pending_request(user)
    _mock_status(monkeypatch, 401)

    tasks._do_sync(str(req.id))

    cred.refresh_from_db()
    req.refresh_from_db()
    keep.refresh_from_db()
    assert cred.config["status"] == "auth_failed"
    assert req.status == ExternalSyncRequestStatus.DEAD
    assert req.last_error == "auth_failed"
    # Last-good cache preserved — an auth failure must not wipe the list.
    assert keep.is_stale is False


def test_sync_transient_error_preserves_cache_and_connection(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    cred = _connect(user)
    keep = ExternalWorkItem.objects.create(
        user=user, source="jira", external_id="RIV-1", is_stale=False
    )
    req = _pending_request(user)
    _mock_status(monkeypatch, 503)

    tasks._do_sync(str(req.id))

    cred.refresh_from_db()
    req.refresh_from_db()
    keep.refresh_from_db()
    # 5xx is transient — connection stays connected, cache untouched, row DEAD.
    assert cred.config["status"] == "connected"
    assert req.status == ExternalSyncRequestStatus.DEAD
    assert keep.is_stale is False


def test_sync_is_noop_on_terminal_row(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(user)
    req = ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DONE
    )
    _mock_search(monkeypatch, [_issue("RIV-1")])

    tasks._do_sync(str(req.id))

    # A re-dispatch of an already-done row must not pull again.
    assert not ExternalWorkItem.objects.filter(user=user).exists()


def test_sync_caps_stored_items(user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch) -> None:
    _connect(user)
    req = _pending_request(user)
    monkeypatch.setattr(tasks, "CACHE_ITEM_CAP", 3)
    _mock_search(monkeypatch, [_issue(f"RIV-{n}") for n in range(10)])

    tasks._do_sync(str(req.id))

    assert ExternalWorkItem.objects.filter(user=user).count() == 3


def test_sync_dead_when_connection_removed(
    user: AbstractBaseUser, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No credential (disconnected after queueing) retires the row, no crash."""
    req = _pending_request(user)  # note: no _connect(user)
    _mock_search(monkeypatch, [_issue("RIV-1")])

    tasks._do_sync(str(req.id))

    req.refresh_from_db()
    assert req.status == ExternalSyncRequestStatus.DEAD


# ---------------------------------------------------------------------------
# enqueue_external_sync — service
# ---------------------------------------------------------------------------


def test_enqueue_creates_pending_row(user: AbstractBaseUser) -> None:
    req = enqueue_external_sync(user.pk, "jira")
    assert req is not None
    assert req.status == ExternalSyncRequestStatus.PENDING
    assert ExternalSyncRequest.objects.filter(user=user, source="jira").count() == 1


def test_enqueue_adopts_existing_pending(user: AbstractBaseUser) -> None:
    first = ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.PENDING
    )
    # A poll trigger (no cooldown) while a PENDING row exists adopts it.
    adopted = enqueue_external_sync(user.pk, "jira", reason=ExternalSyncRequestReason.POLL)
    assert adopted is not None
    assert adopted.id == first.id
    assert ExternalSyncRequest.objects.filter(user=user, source="jira").count() == 1


def test_enqueue_unknown_source_raises(user: AbstractBaseUser) -> None:
    with pytest.raises(ValueError, match="Unknown external task source"):
        enqueue_external_sync(user.pk, "not_a_source")


def test_enqueue_manual_cooldown_raises(user: AbstractBaseUser) -> None:
    ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DONE
    )
    with pytest.raises(SyncCooldownActive) as exc:
        enqueue_external_sync(user.pk, "jira")
    assert 0 < exc.value.retry_after <= MANUAL_SYNC_COOLDOWN_SECONDS


def test_enqueue_poll_ignores_cooldown(user: AbstractBaseUser) -> None:
    ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DONE
    )
    # POLL is exempt from the manual cooldown.
    req = enqueue_external_sync(user.pk, "jira", reason=ExternalSyncRequestReason.POLL)
    assert req is not None


# ---------------------------------------------------------------------------
# drain / purge / poll
# ---------------------------------------------------------------------------


def _age_request(req: ExternalSyncRequest, **fields: Any) -> None:
    """Backdate an outbox row (``requested_at`` is auto_now_add)."""
    ExternalSyncRequest.objects.filter(id=req.id).update(**fields)


def test_drain_dispatches_stranded_pending(user: AbstractBaseUser) -> None:
    req = ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.PENDING
    )
    _age_request(req, requested_at=timezone.now() - timedelta(minutes=5))

    tasks._do_drain()

    req.refresh_from_db()
    assert req.status == ExternalSyncRequestStatus.DISPATCHED
    assert req.celery_task_id == "fake-task-id"


def test_drain_skips_fresh_pending(user: AbstractBaseUser) -> None:
    """A just-created PENDING row is left for its on_commit dispatch (no double-fire)."""
    req = ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.PENDING
    )
    tasks._do_drain()
    req.refresh_from_db()
    assert req.status == ExternalSyncRequestStatus.PENDING


def test_drain_recovers_orphaned_dispatched(user: AbstractBaseUser) -> None:
    req = ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DISPATCHED
    )
    _age_request(
        req,
        requested_at=timezone.now() - timedelta(minutes=30),
        dispatched_at=timezone.now() - timedelta(minutes=30),
    )

    tasks._do_drain()

    req.refresh_from_db()
    # Orphan reset to PENDING then re-dispatched in the same drain pass.
    assert req.status == ExternalSyncRequestStatus.DISPATCHED


def test_purge_deletes_old_terminal_rows_and_stale_items(user: AbstractBaseUser) -> None:
    old_done = ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DONE
    )
    _age_request(old_done, requested_at=timezone.now() - timedelta(days=10))
    fresh_done = ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DEAD
    )
    old_item = ExternalWorkItem.objects.create(
        user=user,
        source="jira",
        external_id="GONE-1",
        is_stale=True,
        last_synced_at=timezone.now() - timedelta(days=10),
    )
    live_item = ExternalWorkItem.objects.create(
        user=user, source="jira", external_id="RIV-1", is_stale=False
    )

    tasks._do_purge()

    assert not ExternalSyncRequest.objects.filter(id=old_done.id).exists()
    assert ExternalSyncRequest.objects.filter(id=fresh_done.id).exists()
    assert not ExternalWorkItem.objects.filter(id=old_item.id).exists()
    assert ExternalWorkItem.objects.filter(id=live_item.id).exists()


def test_poll_only_enqueues_opted_in_connections(
    user: AbstractBaseUser, other_user: AbstractBaseUser
) -> None:
    # Opted in.
    IntegrationCredential.objects.create(
        user=user,
        provider="jira",
        secret_ciphertext=encrypt_secret("t"),
        base_url=_JIRA_BASE,
        config={"status": "connected", "poll_enabled": True},
    )
    # Not opted in (default off).
    IntegrationCredential.objects.create(
        user=other_user,
        provider="jira",
        secret_ciphertext=encrypt_secret("t"),
        base_url=_JIRA_BASE,
        config={"status": "connected"},
    )

    tasks._do_poll()

    assert ExternalSyncRequest.objects.filter(user=user).count() == 1
    assert ExternalSyncRequest.objects.filter(user=other_user).count() == 0


def test_poll_skips_auth_failed_connections(user: AbstractBaseUser) -> None:
    IntegrationCredential.objects.create(
        user=user,
        provider="jira",
        secret_ciphertext=encrypt_secret("t"),
        base_url=_JIRA_BASE,
        config={"status": "auth_failed", "poll_enabled": True},
    )
    tasks._do_poll()
    assert ExternalSyncRequest.objects.filter(user=user).count() == 0


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


def test_post_sync_returns_202_and_queues(client: APIClient, user: AbstractBaseUser) -> None:
    _connect(user)
    resp = client.post("/api/v1/me/connections/jira/sync/")
    assert resp.status_code == 202
    assert resp.data == {"queued": True}
    assert ExternalSyncRequest.objects.filter(user=user, source="jira").count() == 1


def test_post_sync_cooldown_returns_429(client: APIClient, user: AbstractBaseUser) -> None:
    _connect(user)
    ExternalSyncRequest.objects.create(
        user=user, source="jira", status=ExternalSyncRequestStatus.DONE
    )
    resp = client.post("/api/v1/me/connections/jira/sync/")
    assert resp.status_code == 429
    assert resp.data["code"] == "sync_cooldown"
    assert "Retry-After" in resp.headers


def test_post_sync_unknown_source_400(client: APIClient) -> None:
    resp = client.post("/api/v1/me/connections/nope/sync/")
    assert resp.status_code == 400


def test_post_sync_without_connection_404(client: APIClient) -> None:
    resp = client.post("/api/v1/me/connections/jira/sync/")
    assert resp.status_code == 404


def test_post_sync_requires_auth() -> None:
    resp = APIClient().post("/api/v1/me/connections/jira/sync/")
    assert resp.status_code in (401, 403)


def test_external_items_list_is_personal_and_hides_stale(
    client: APIClient, user: AbstractBaseUser, other_user: AbstractBaseUser
) -> None:
    ExternalWorkItem.objects.create(user=user, source="jira", external_id="MINE-1", is_stale=False)
    ExternalWorkItem.objects.create(
        user=user, source="jira", external_id="MINE-STALE", is_stale=True
    )
    ExternalWorkItem.objects.create(
        user=other_user, source="jira", external_id="THEIRS-1", is_stale=False
    )

    resp = client.get("/api/v1/me/external-items/")
    assert resp.status_code == 200
    ids = {row["external_id"] for row in resp.data["results"]}
    assert ids == {"MINE-1"}
    assert resp.data["results"][0]["source_key"] == "jira"


def test_external_items_list_requires_auth() -> None:
    resp = APIClient().get("/api/v1/me/external-items/")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Invariant guard for the new outbox model
# ---------------------------------------------------------------------------


def test_sync_request_is_not_versioned() -> None:
    """The outbox row is server-side dispatch state — never synced to a client."""
    assert not issubclass(ExternalSyncRequest, VersionedModel)
    fields = {f.name for f in ExternalSyncRequest._meta.get_fields()}
    assert "server_version" not in fields
