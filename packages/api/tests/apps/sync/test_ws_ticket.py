"""Tests for the WebSocket ticket flow (ADR-0141, #818).

Covers the REST mint endpoint, the issue/consume single-use semantics, and
``authenticate_scope``'s ticket-preferred / token-fallback resolution.
"""

from __future__ import annotations

import secrets
import time
from datetime import timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import ApiToken
from trueppm_api.apps.sync import ws_auth

User = get_user_model()

_URL = "/api/v1/ws/ticket/"


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="ticket_user", password="pw")


# ---------------------------------------------------------------------------
# Fake Redis — a shared dict so the sync writer and async reader see one store.
# ---------------------------------------------------------------------------


class _FakeSyncRedis:
    """Writes into a shared store; ``ttls`` records each key's expiry (epoch s)."""

    def __init__(self, store: dict[str, str], ttls: dict[str, float] | None = None) -> None:
        self._store = store
        self._ttls = ttls if ttls is not None else {}

    def set(self, key: str, value: str, ex: int | None = None) -> None:
        self._store[key] = value
        if ex is not None:
            self._ttls[key] = time.time() + ex

    def close(self) -> None:
        pass


class _FakePipeline:
    """The queue-then-execute shape of ``redis.asyncio``'s transactional pipeline."""

    def __init__(self, redis: _FakeAsyncRedis) -> None:
        self._redis = redis
        self._ops: list[tuple[str, str]] = []

    async def __aenter__(self) -> _FakePipeline:
        return self

    async def __aexit__(self, *exc: object) -> None:
        pass

    def pttl(self, key: str) -> _FakePipeline:
        self._ops.append(("pttl", key))
        return self

    def getdel(self, key: str) -> _FakePipeline:
        self._ops.append(("getdel", key))
        return self

    async def execute(self) -> list[Any]:
        out: list[Any] = []
        for op, key in self._ops:
            if op == "pttl":
                if key not in self._redis.store:
                    out.append(-2)
                elif key not in self._redis.ttls:
                    out.append(-1)
                else:
                    out.append(int((self._redis.ttls[key] - time.time()) * 1000))
            else:
                self._redis.ttls.pop(key, None)
                out.append(self._redis.store.pop(key, None))
        return out


class _FakeAsyncRedis:
    def __init__(self, store: dict[str, str], ttls: dict[str, float] | None = None) -> None:
        self.store = store
        self.ttls = ttls if ttls is not None else {}

    async def getdel(self, key: str) -> str | None:
        self.ttls.pop(key, None)
        return self.store.pop(key, None)

    def pipeline(self, transaction: bool = True) -> _FakePipeline:
        return _FakePipeline(self)

    async def aclose(self) -> None:
        pass


# ---------------------------------------------------------------------------
# REST mint endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_ticket_requires_auth() -> None:
    resp = APIClient().post(_URL)
    assert resp.status_code == 401


@pytest.mark.django_db
def test_ticket_minted_for_authed_user(user: object) -> None:
    client = APIClient()
    client.force_authenticate(user=user)
    # The view imports issue_ticket into its own namespace — patch it there.
    with patch("trueppm_api.apps.sync.views.issue_ticket", return_value="tkt-abc") as mint:
        resp = client.post(_URL)
    assert resp.status_code == 200
    assert resp.json() == {"ticket": "tkt-abc", "expires_in": ws_auth.TICKET_TTL_SECONDS}
    mint.assert_called_once_with(str(user.pk))


@pytest.mark.django_db
def test_ticket_minted_for_jwt_authenticated_user(user: object) -> None:
    """#4462 test plan: JWT-authenticated requests still succeed once the PAT
    guard is added — the guard must not catch the browser's own credential.
    """
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(user).access_token}")
    with patch("trueppm_api.apps.sync.views.issue_ticket", return_value="tkt-jwt") as mint:
        resp = client.post(_URL)
    assert resp.status_code == 200, resp.data
    assert resp.json() == {"ticket": "tkt-jwt", "expires_in": ws_auth.TICKET_TTL_SECONDS}
    mint.assert_called_once_with(str(user.pk))


@pytest.mark.django_db
def test_ticket_refused_for_personal_access_token(user: object) -> None:
    """#4462: a PAT may never mint a WS ticket.

    A ticket opens a live socket the consumer authenticates exactly once, at
    connect — unlike every other credential grant ``IsNotTokenAuthenticated``
    guards, a later token revocation cannot reach a socket already open. Browsers
    never mint a ticket with a bearer PAT, so refusing it here closes the PAT half
    of #4462 with no loss of any real client's functionality.
    """
    raw = TOKEN_PREFIX + secrets.token_hex(32)
    ApiToken.objects.create(
        owner=user,
        name="leaked",
        token_prefix=raw[len(TOKEN_PREFIX) :][:8],
        token_hash=sha256_hex(raw),
        created_by=user,
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    # return_value is set so that a regressed guard fails this test fast and
    # cleanly (a 200 with a real ticket, tripping the status/call assertions
    # below) rather than leaving an unconfigured Mock to hang the response
    # pipeline until pytest's own timeout.
    with patch("trueppm_api.apps.sync.views.issue_ticket", return_value="should-not-mint") as mint:
        resp = client.post(_URL)
    assert resp.status_code == 403, resp.data
    mint.assert_not_called()


# ---------------------------------------------------------------------------
# issue_ticket / consume_ticket single-use semantics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_issue_then_consume_is_single_use() -> None:
    store: dict[str, str] = {}
    ttls: dict[str, float] = {}
    with (
        patch("redis.from_url", return_value=_FakeSyncRedis(store, ttls)),
        patch("redis.asyncio.from_url", return_value=_FakeAsyncRedis(store, ttls)),
    ):
        before = time.time()
        ticket = ws_auth.issue_ticket("user-42")
        assert ticket  # opaque, non-empty
        assert store[f"ws:ticket:{ticket}"] == "user-42"

        first = await ws_auth.consume_ticket(ticket)
        assert first is not None
        assert first.user_id == "user-42"
        # Issue time is derived from the key's remaining TTL (#4499), not stored.
        assert first.issued_at is not None
        assert before - 1 <= first.issued_at <= time.time()
        # Second consume of the same ticket sees nothing (GETDEL removed it).
        second = await ws_auth.consume_ticket(ticket)
        assert second is None


@pytest.mark.asyncio
async def test_consume_unknown_ticket_returns_none() -> None:
    with patch("redis.asyncio.from_url", return_value=_FakeAsyncRedis({})):
        assert await ws_auth.consume_ticket("does-not-exist") is None


@pytest.mark.asyncio
async def test_a_ticket_with_no_ttl_has_no_trustworthy_issue_time() -> None:
    """Only a bug writes a ticket without a TTL; its age is unknowable — fail closed."""
    store = {"ws:ticket:tk": "user-42"}
    with patch("redis.asyncio.from_url", return_value=_FakeAsyncRedis(store)):
        claim = await ws_auth.consume_ticket("tk")
    assert claim is not None
    assert claim.issued_at == float("-inf")


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_an_aged_ticket_is_judged_by_its_true_issue_time(user: object) -> None:
    """Real ``consume_ticket`` TTL math (#4499): a ticket minted 20 s ago (10 s of TTL
    left) is refused against a cutoff 10 s ago. If the elapsed time were ignored —
    treating consume time as issue time — it would be accepted."""
    from channels.db import database_sync_to_async
    from django.utils import timezone

    from trueppm_api.apps.profiles.models import UserProfile

    def _set_cutoff() -> None:
        UserProfile.objects.update_or_create(
            user=user,
            defaults={"credentials_revoked_at": timezone.now() - timedelta(seconds=10)},
        )

    await database_sync_to_async(_set_cutoff)()
    store = {"ws:ticket:aged": str(user.pk)}
    ttls = {"ws:ticket:aged": time.time() + 10}  # 30 s TTL, 20 s elapsed
    with patch("redis.asyncio.from_url", return_value=_FakeAsyncRedis(store, ttls)):
        claim = await ws_auth.consume_ticket("aged")
        assert claim is not None
        assert abs((time.time() - claim.issued_at) - 20) < 1
    with patch.object(ws_auth, "consume_ticket", new=AsyncMock(return_value=claim)):
        result = await ws_auth.authenticate_scope(_scope("ticket=aged"))
    assert result.user is None

    # Control: the same ticket fresh (full TTL left) connects.
    store = {"ws:ticket:fresh": str(user.pk)}
    ttls = {"ws:ticket:fresh": time.time() + 30}
    with patch("redis.asyncio.from_url", return_value=_FakeAsyncRedis(store, ttls)):
        result = await ws_auth.authenticate_scope(_scope("ticket=fresh"))
    assert result.user is not None


# ---------------------------------------------------------------------------
# Mixed-version rolling deploy (#4499): old and new pods share one Valkey
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_stored_value_is_what_an_old_pod_can_resolve(user: object) -> None:
    """New pod mints, old pod consumes.

    The previous release's consumer runs ``User.objects.get(pk=<stored value>)``.
    Any change to the stored value's format makes that raise, which it turns into
    a 4001 close — and the web client's second 4001 shows a false
    "session expired" modal to users reconnecting mid-rollout.
    """
    store: dict[str, str] = {}
    with patch("redis.from_url", return_value=_FakeSyncRedis(store)):
        ticket = ws_auth.issue_ticket(str(user.pk))
    stored = store[f"ws:ticket:{ticket}"]
    # The old pod's exact lookup (pre-#4499 _resolve_active_user).
    assert User.objects.get(pk=stored, is_active=True).pk == user.pk


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_a_new_pod_accepts_an_old_pods_ticket(user: object) -> None:
    """Old pod mints (bare user id, 30 s TTL), new pod consumes."""
    store: dict[str, str] = {}
    ttls: dict[str, float] = {}
    # What the previous release's issue_ticket wrote, byte for byte.
    _FakeSyncRedis(store, ttls).set("ws:ticket:old", str(user.pk), ex=30)
    with patch("redis.asyncio.from_url", return_value=_FakeAsyncRedis(store, ttls)):
        result = await ws_auth.authenticate_scope(_scope("ticket=old"))
    assert result.user is not None
    assert result.user.pk == user.pk


# ---------------------------------------------------------------------------
# authenticate_scope — ticket preferred, token fallback
# ---------------------------------------------------------------------------


def _scope(query: str) -> dict[str, object]:
    return {"query_string": query.encode()}


# transaction=True so the threaded database_sync_to_async user lookup in
# _resolve_active_user sees the committed fixture row.
@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_authenticate_scope_ticket_path(user: object) -> None:
    claim = ws_auth.TicketClaim(user_id=str(user.pk), issued_at=time.time())
    with patch.object(ws_auth, "consume_ticket", new=AsyncMock(return_value=claim)):
        result = await ws_auth.authenticate_scope(_scope("ticket=tk"))
    assert result.via == "ticket"
    assert result.user is not None
    assert result.user.pk == user.pk


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_authenticate_scope_spent_ticket_rejected() -> None:
    with patch.object(ws_auth, "consume_ticket", new=AsyncMock(return_value=None)):
        result = await ws_auth.authenticate_scope(_scope("ticket=spent"))
    assert result.via == "ticket"
    assert result.user is None


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_authenticate_scope_token_fallback_when_enabled(user: object, settings: Any) -> None:
    """With the opt-in flag on, ?token= still resolves (last-release fallback)."""
    settings.TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED = True
    with patch.object(ws_auth, "authenticate_token", new=AsyncMock(return_value=user)):
        result = await ws_auth.authenticate_scope(_scope("token=jwt"))
    assert result.via == "token"
    assert result.user is user


@pytest.mark.django_db
@pytest.mark.asyncio
async def test_authenticate_scope_token_ignored_by_default(user: object, settings: Any) -> None:
    """Default (#1723): ?token= is not consulted — no raw JWT can enter the URL path.

    A client presenting only ?token= is treated as unauthenticated (via=None),
    which the consumer closes as 4001. authenticate_token must never be called.
    """
    settings.TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED = False
    token = AsyncMock(return_value=user)
    with patch.object(ws_auth, "authenticate_token", new=token):
        result = await ws_auth.authenticate_scope(_scope("token=jwt"))
    assert result.user is None
    assert result.via is None
    token.assert_not_awaited()


@pytest.mark.asyncio
async def test_authenticate_scope_no_credential() -> None:
    result = await ws_auth.authenticate_scope(_scope(""))
    assert result.user is None
    assert result.via is None


def test_warn_if_legacy_only_warns_on_token(caplog: pytest.LogCaptureFixture) -> None:
    import logging

    with caplog.at_level(logging.WARNING):
        ws_auth.warn_if_legacy(
            ws_auth.WsAuthResult(user=None, via="ticket"), consumer="C", project_pk="p"
        )
    assert not caplog.records
    with caplog.at_level(logging.WARNING):
        ws_auth.warn_if_legacy(
            ws_auth.WsAuthResult(user=None, via="token"), consumer="C", project_pk="p"
        )
    assert any("Deprecated WebSocket auth" in r.message for r in caplog.records)
