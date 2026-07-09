"""Tests for the WebSocket ticket flow (ADR-0141, #818).

Covers the REST mint endpoint, the issue/consume single-use semantics, and
``authenticate_scope``'s ticket-preferred / token-fallback resolution.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

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
    def __init__(self, store: dict[str, str]) -> None:
        self._store = store

    def set(self, key: str, value: str, ex: int | None = None) -> None:
        self._store[key] = value

    def close(self) -> None:
        pass


class _FakeAsyncRedis:
    def __init__(self, store: dict[str, str]) -> None:
        self._store = store

    async def getdel(self, key: str) -> str | None:
        return self._store.pop(key, None)

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


# ---------------------------------------------------------------------------
# issue_ticket / consume_ticket single-use semantics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_issue_then_consume_is_single_use() -> None:
    store: dict[str, str] = {}
    with (
        patch("redis.from_url", return_value=_FakeSyncRedis(store)),
        patch("redis.asyncio.from_url", return_value=_FakeAsyncRedis(store)),
    ):
        ticket = ws_auth.issue_ticket("user-42")
        assert ticket  # opaque, non-empty
        assert store[f"ws:ticket:{ticket}"] == "user-42"

        first = await ws_auth.consume_ticket(ticket)
        assert first == "user-42"
        # Second consume of the same ticket sees nothing (GETDEL removed it).
        second = await ws_auth.consume_ticket(ticket)
        assert second is None


@pytest.mark.asyncio
async def test_consume_unknown_ticket_returns_none() -> None:
    with patch("redis.asyncio.from_url", return_value=_FakeAsyncRedis({})):
        assert await ws_auth.consume_ticket("does-not-exist") is None


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
    with patch.object(ws_auth, "consume_ticket", new=AsyncMock(return_value=str(user.pk))):
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
