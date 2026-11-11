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


@pytest.fixture(autouse=True)
def _reset_budgets() -> Any:
    from trueppm_api.apps.sync import consumers

    consumers._frame_budgets.clear()
    yield
    consumers._frame_budgets.clear()


def _consumer(project: str = "p1", user_pk: int | None = None) -> ProjectConsumer:
    c = ProjectConsumer()
    if user_pk is not None:
        c.project_pk = project
        c._user = type("U", (), {"pk": user_pk})()
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
async def test_budget_shared_across_a_users_sockets_on_a_project(settings: Any) -> None:
    settings.TRUEPPM_WS_RATE_LIMIT_FRAMES = 2
    settings.TRUEPPM_WS_RATE_LIMIT_WINDOW_SECONDS = 60
    a, b = _consumer("p1", 7), _consumer("p1", 7)
    await a.receive(text_data="{}")
    await b.receive(text_data="{}")
    a.close.assert_not_awaited()
    await b.receive(text_data="{}")  # third frame across two sockets
    b.close.assert_awaited_once_with(code=WS_CLOSE_RATE_LIMITED)


@pytest.mark.asyncio
async def test_other_user_and_other_project_unaffected(settings: Any) -> None:
    settings.TRUEPPM_WS_RATE_LIMIT_FRAMES = 1
    settings.TRUEPPM_WS_RATE_LIMIT_WINDOW_SECONDS = 60
    a = _consumer("p1", 7)
    other_user = _consumer("p1", 8)
    other_project = _consumer("p2", 7)
    for c in (a, other_user, other_project):
        await c.receive(text_data="{}")
        c.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_expired_budget_keys_are_pruned(
    settings: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from trueppm_api.apps.sync import consumers

    settings.TRUEPPM_WS_RATE_LIMIT_WINDOW_SECONDS = 10
    monkeypatch.setattr(consumers, "_BUDGET_SWEEP_EVERY", 1)
    consumers._budget_admit(("p", "old"), 0.0)
    consumers._budget_admit(("p", "new"), 100.0)  # sweep runs first, drops "old"
    assert ("p", "old") not in consumers._frame_budgets


@pytest.mark.parametrize(
    ("hosts", "origin", "expected"),
    [
        (["app.example.com"], b"null", False),
        (["app.example.com"], b"https://app.example.com:8443", True),
        (["app.example.com"], b"ws://app.example.com", True),
        ([".example.com"], b"https://example.com", True),
        ([".example.com"], b"https://a.b.example.com", True),
        (["*"], b"https://anything.test", True),
        (["[::1]"], b"http://[::1]:5173", True),
        (["app.example.com"], b"https://app.example.com.evil.org", False),
        (["app.example.com"], b"", False),
        (["app.example.com"], b"%%%garbage", False),
        (["app.example.com"], b"http://[::1", False),  # malformed: must deny, not raise
        (["app.example.com"], b"https://evil:99999", False),
    ],
)
@pytest.mark.asyncio
async def test_origin_edge_cases(
    settings: Any, hosts: list[str], origin: bytes, expected: bool
) -> None:
    settings.ALLOWED_HOSTS = hosts
    assert await _connect(origin) is expected


@pytest.mark.asyncio
async def test_malformed_port_with_scheme_entry_denied_not_500(settings: Any) -> None:
    settings.ALLOWED_HOSTS = ["api.example.com"]
    settings.TRUEPPM_WS_ALLOWED_ORIGINS = ["https://app.example.com"]
    assert not await _connect(b"https://evil:99999")


@pytest.mark.asyncio
async def test_denial_is_logged_and_rate_limited(
    settings: Any, caplog: pytest.LogCaptureFixture
) -> None:
    from trueppm_api.apps.sync import ws_origin

    ws_origin._last_deny_log = float("-inf")
    settings.ALLOWED_HOSTS = ["app.example.com"]
    with caplog.at_level("WARNING", logger=ws_origin.logger.name):
        for _ in range(3):
            await _connect(b"https://evil.example.org")
    assert len([r for r in caplog.records if "denied" in r.getMessage()]) == 1


@pytest.mark.asyncio
async def test_asgi_application_wires_the_validator(settings: Any) -> None:
    """The real ``application`` must deny a foreign Origin before any route runs."""
    from asgiref.testing import ApplicationCommunicator

    from trueppm_api.asgi import application

    settings.ALLOWED_HOSTS = ["app.example.com"]
    scope = {
        "type": "websocket",
        "path": "/ws/v1/projects/00000000-0000-0000-0000-000000000000/",
        "query_string": b"",
        "headers": [(b"origin", b"https://evil.example.org")],
        "subprotocols": [],
    }
    comm = ApplicationCommunicator(application, scope)
    await comm.send_input({"type": "websocket.connect"})
    out = await comm.receive_output(timeout=5)
    assert out["type"] == "websocket.close"  # pre-accept denial
