"""Auth-and-boot tests for the scaffold (ADR-0186 §E/§I, #503).

The scaffold's contract: a bad token yields 401, a valid token yields 200, and
the server exposes an empty tool list. Token handling must never leak the secret.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

import httpx
import pytest

from tests.conftest import SAMPLE_API_URL, SAMPLE_TOKEN
from trueppm_mcp.client import AUTH_VERIFY_PATH, ApiError, AuthError, TruePPMClient
from trueppm_mcp.config import Settings
from trueppm_mcp.server import build_server, make_lifespan

MockFactory = Callable[
    [httpx.Response | Callable[[httpx.Request], httpx.Response]], httpx.MockTransport
]


async def test_bad_token_raises_auth_error(settings: Settings, make_transport: MockFactory) -> None:
    """A 401 from /auth/me/ surfaces as AuthError (bad token → 401)."""
    transport = make_transport(httpx.Response(401, json={"detail": "Invalid token."}))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(AuthError):
            await client.verify_auth()


async def test_valid_token_returns_identity(
    settings: Settings, make_transport: MockFactory
) -> None:
    """A 200 from /auth/me/ returns the identity payload (valid token → 200)."""
    identity = {"id": "u-1", "display_name": "Ada Lovelace", "initials": "AL"}
    transport = make_transport(httpx.Response(200, json=identity))
    async with TruePPMClient(settings, transport=transport) as client:
        result = await client.verify_auth()
    assert result == identity


async def test_verify_auth_calls_auth_me_with_bearer_header(
    settings: Settings, make_transport: MockFactory
) -> None:
    """The request targets /api/v1/auth/me/ and carries the bearer token."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers.get("authorization", "")
        return httpx.Response(200, json={"id": "u-1"})

    transport = make_transport(handler)
    async with TruePPMClient(settings, transport=transport) as client:
        await client.verify_auth()

    assert seen["url"] == f"{SAMPLE_API_URL}/api/v1/{AUTH_VERIFY_PATH}"
    assert seen["authorization"] == f"Bearer {SAMPLE_TOKEN}"


async def test_unexpected_status_raises_api_error(
    settings: Settings, make_transport: MockFactory
) -> None:
    """A non-401 error status surfaces as ApiError, not AuthError."""
    transport = make_transport(httpx.Response(503, text="upstream down"))
    async with TruePPMClient(settings, transport=transport) as client:
        with pytest.raises(ApiError):
            await client.verify_auth()


async def test_server_registers_read_tool_surface(settings: Settings) -> None:
    """The server registers the #504 read-only tool surface (14 tools, no writes)."""
    client = TruePPMClient(settings)
    try:
        server = build_server(client)
        tools = await server.list_tools()
    finally:
        await client.aclose()
    names = {tool.name for tool in tools}
    assert names == {
        "list_projects",
        "get_project",
        "list_tasks",
        "get_task",
        "get_board_state",
        "get_schedule_summary",
        "list_risks",
        "get_monte_carlo_forecast",
        "get_schedule_derivation",
        "list_sprints",
        "get_sprint",
        "list_my_work",
        "list_programs",
        "get_program_health",
        "whoami",
    }
    # Read-only contract: no tool name implies a mutation.
    assert not any(
        tool.name.startswith(("create_", "update_", "delete_", "set_")) for tool in tools
    )


async def test_lifespan_verifies_auth_then_closes_on_valid_token(
    settings: Settings, make_transport: MockFactory
) -> None:
    """Boot lifespan calls verify_auth, yields the client, then closes it (200)."""
    transport = make_transport(httpx.Response(200, json={"id": "u-1"}))
    client = TruePPMClient(settings, transport=transport)
    lifespan = make_lifespan(client)
    server = build_server(client)

    async with lifespan(server) as yielded:
        assert yielded is client
    # Closed on exit: a second close is a no-op, but a fresh request now fails.
    with pytest.raises(RuntimeError):
        await client.verify_auth()


async def test_lifespan_aborts_boot_on_bad_token(
    settings: Settings, make_transport: MockFactory
) -> None:
    """Boot lifespan raises AuthError before yielding when the token is bad (401)."""
    transport = make_transport(httpx.Response(401, json={"detail": "Invalid token."}))
    client = TruePPMClient(settings, transport=transport)
    lifespan = make_lifespan(client)
    server = build_server(client)

    with pytest.raises(AuthError):
        async with lifespan(server):
            pytest.fail("lifespan must not yield when auth fails")
    await client.aclose()


def test_settings_repr_redacts_token(settings: Settings) -> None:
    """The token must never appear in repr() — it lands in logs and tracebacks."""
    rendered = repr(settings)
    assert SAMPLE_TOKEN not in rendered
    assert "<redacted>" in rendered


async def test_auth_failure_does_not_log_token(
    settings: Settings,
    make_transport: MockFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No log record emitted during an auth failure contains the token."""
    transport = make_transport(httpx.Response(401, json={"detail": "Invalid token."}))
    with caplog.at_level(logging.DEBUG):
        async with TruePPMClient(settings, transport=transport) as client:
            with pytest.raises(AuthError) as exc_info:
                await client.verify_auth()
    assert SAMPLE_TOKEN not in str(exc_info.value)
    for record in caplog.records:
        assert SAMPLE_TOKEN not in record.getMessage()
