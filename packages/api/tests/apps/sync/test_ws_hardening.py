"""Origin validation + inbound frame cap / rate limit on the WS surface (#1729)."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest

from trueppm_api.apps.sync.consumers import (
    WS_CLOSE_RATE_LIMITED,
    WS_CLOSE_TOO_BIG,
    ProjectConsumer,
)
from trueppm_api.apps.sync.ws_origin import TruePPMOriginValidator

pytestmark = pytest.mark.django_db(transaction=True)


async def _inner(scope: dict, receive: Any, send: Any) -> None:
    """Stand-in for the router: reaching it means the Origin check passed."""
    await send({"type": "websocket.accept"})


async def _connect(origin: bytes | None) -> bool:
    """Drive the validator over raw ASGI (channels.testing needs daphne, not installed)."""
    headers = [(b"origin", origin)] if origin is not None else []
    scope = {"type": "websocket", "path": "/ws/x/", "headers": headers}
    sent: list[dict] = []

    inbox = [{"type": "websocket.connect"}, {"type": "websocket.disconnect", "code": 1000}]

    async def receive() -> dict:
        return inbox.pop(0) if len(inbox) > 1 else inbox[0]

    async def send(message: dict) -> None:
        sent.append(message)

    await TruePPMOriginValidator(_inner)(scope, receive, send)
    return sent[0]["type"] == "websocket.accept"


@pytest.mark.asyncio
async def test_origin_in_allowed_hosts_accepted(settings: Any) -> None:
    settings.ALLOWED_HOSTS = ["app.example.com"]
    assert await _connect(b"https://app.example.com")


@pytest.mark.asyncio
async def test_foreign_origin_refused(settings: Any) -> None:
    settings.ALLOWED_HOSTS = ["app.example.com"]
    assert not await _connect(b"https://evil.example.org")


@pytest.mark.asyncio
async def test_extra_allowed_origin_accepted(settings: Any) -> None:
    settings.ALLOWED_HOSTS = ["api.example.com"]
    settings.TRUEPPM_WS_ALLOWED_ORIGINS = ["https://app.example.com"]
    assert await _connect(b"https://app.example.com")
    assert not await _connect(b"http://app.example.com")  # scheme must match


@pytest.mark.asyncio
async def test_no_origin_allowed_by_default_for_non_browser_clients(settings: Any) -> None:
    settings.ALLOWED_HOSTS = ["app.example.com"]
    assert await _connect(None)


@pytest.mark.asyncio
async def test_no_origin_refused_when_required(settings: Any) -> None:
    settings.ALLOWED_HOSTS = ["app.example.com"]
    settings.TRUEPPM_WS_REQUIRE_ORIGIN = True
    assert not await _connect(None)
    assert await _connect(b"https://app.example.com")


def _consumer() -> ProjectConsumer:
    c = ProjectConsumer()
    c.close = AsyncMock()  # type: ignore[method-assign]
    c.receive_json = AsyncMock()  # type: ignore[method-assign]
    return c


@pytest.mark.asyncio
async def test_oversize_text_frame_closed_before_parse(settings: Any) -> None:
    settings.TRUEPPM_WS_MAX_FRAME_BYTES = 100
    c = _consumer()
    await c.receive(text_data=json.dumps({"x": "a" * 500}))
    c.close.assert_awaited_once_with(code=WS_CLOSE_TOO_BIG)
    c.receive_json.assert_not_awaited()


@pytest.mark.asyncio
async def test_oversize_multibyte_counted_in_bytes_not_chars(settings: Any) -> None:
    settings.TRUEPPM_WS_MAX_FRAME_BYTES = 100
    c = _consumer()
    await c.receive(text_data="é" * 60)  # 60 chars, 120 bytes
    c.close.assert_awaited_once_with(code=WS_CLOSE_TOO_BIG)


@pytest.mark.asyncio
async def test_normal_frame_reaches_handler(settings: Any) -> None:
    c = _consumer()
    await c.receive(text_data='{"type": "ping"}')
    c.close.assert_not_awaited()
    c.receive_json.assert_awaited_once()


@pytest.mark.asyncio
async def test_frame_flood_closed_after_budget(settings: Any) -> None:
    settings.TRUEPPM_WS_RATE_LIMIT_FRAMES = 3
    settings.TRUEPPM_WS_RATE_LIMIT_WINDOW_SECONDS = 60
    c = _consumer()
    for _ in range(3):
        await c.receive(text_data="{}")
    c.close.assert_not_awaited()
    await c.receive(text_data="{}")
    c.close.assert_awaited_once_with(code=WS_CLOSE_RATE_LIMITED)
    assert c.receive_json.await_count == 3  # the over-budget frame did no work


@pytest.mark.asyncio
async def test_rate_window_slides(settings: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    settings.TRUEPPM_WS_RATE_LIMIT_FRAMES = 1
    settings.TRUEPPM_WS_RATE_LIMIT_WINDOW_SECONDS = 10
    clock = [1000.0]
    monkeypatch.setattr("trueppm_api.apps.sync.consumers.time.monotonic", lambda: clock[0])
    c = _consumer()
    await c.receive(text_data="{}")
    clock[0] += 11
    await c.receive(text_data="{}")
    c.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_rate_limit_is_per_connection(settings: Any) -> None:
    settings.TRUEPPM_WS_RATE_LIMIT_FRAMES = 1
    a, b = _consumer(), _consumer()
    await a.receive(text_data="{}")
    await b.receive(text_data="{}")
    a.close.assert_not_awaited()
    b.close.assert_not_awaited()
