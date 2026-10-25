"""DNS-rebinding protection on the HTTP/SSE transports (#4636).

The MCP SDK only turns Host/Origin validation on by itself when the bind host is
loopback. Inside a container the process must bind ``0.0.0.0``, which would
silently switch the check off, so ``build_server`` always installs it.
"""

from __future__ import annotations

# ruff: noqa: S104
import httpx
import pytest
from mcp.server.transport_security import TransportSecurityMiddleware
from starlette.requests import Request

from tests.conftest import SAMPLE_API_URL, SAMPLE_TOKEN
from trueppm_mcp import cli
from trueppm_mcp.client import TruePPMClient
from trueppm_mcp.config import Settings
from trueppm_mcp.server import (
    ENV_ALLOWED_HOSTS,
    build_server,
    build_transport_security,
    parse_allowed_hosts,
)

_INIT_BODY = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "t", "version": "0"},
    },
}
_HEADERS = {"content-type": "application/json", "accept": "application/json, text/event-stream"}


async def _post(server_host: str, host_header: str, origin: str | None = None) -> int:
    settings = Settings.from_env(
        {"TRUEPPM_API_URL": SAMPLE_API_URL, "TRUEPPM_API_TOKEN": SAMPLE_TOKEN}
    )
    client = TruePPMClient(settings)
    try:
        server = build_server(
            client, host=server_host, port=8000, allowed_hosts=["mcp.example.test"]
        )
        app = server.streamable_http_app()  # also creates the session manager
        headers = {**_HEADERS, "host": host_header}
        if origin:
            headers["origin"] = origin
        # The session manager's lifespan is not started, so a request that passes the
        # host check may fail later; only the security-layer status matters here.
        async with (
            server.session_manager.run(),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://x",
            ) as http,
        ):
            return (await http.post("/mcp", json=_INIT_BODY, headers=headers)).status_code
    finally:
        await client.aclose()


@pytest.mark.parametrize("bind_host", ["0.0.0.0", "127.0.0.1", "::"])
def test_protection_enabled_for_every_bind_host(settings: Settings, bind_host: str) -> None:
    server = build_server(TruePPMClient(settings), host=bind_host)
    ts = server.settings.transport_security
    assert ts is not None
    assert ts.enable_dns_rebinding_protection is True
    assert "localhost:*" in ts.allowed_hosts


async def test_foreign_host_rejected_when_bound_to_all_interfaces() -> None:
    assert await _post("0.0.0.0", "evil.example") == 421


async def test_foreign_origin_rejected() -> None:
    assert await _post("0.0.0.0", "localhost:8000", origin="http://evil.example") == 403


async def _validate(host_header: str, origin: str | None = None) -> int | None:
    """Run the SDK's own Host/Origin check against our settings; ``None`` means accepted."""
    ts = build_transport_security("0.0.0.0", 8000, ["mcp.example.test"])
    headers = [(b"host", host_header.encode()), (b"content-type", b"application/json")]
    if origin:
        headers.append((b"origin", origin.encode()))
    request = Request({"type": "http", "method": "POST", "headers": headers})
    response = await TransportSecurityMiddleware(ts).validate_request(request, is_post=True)
    return None if response is None else response.status_code


async def test_loopback_host_accepted() -> None:
    assert await _validate("localhost:8000") is None
    assert await _validate("[::1]:8000", "http://localhost:3000") is None


async def test_allowed_host_accepted_negative_control() -> None:
    assert await _validate("mcp.example.test") is None
    assert await _validate("mcp.example.test:8443", "https://mcp.example.test") is None
    assert await _validate("evil.example") == 421
    assert await _validate("mcp.example.test", "https://evil.example") == 403


def test_specific_bind_host_is_allowed() -> None:
    ts = build_transport_security("10.1.2.3", 9000, [])
    assert "10.1.2.3:9000" in ts.allowed_hosts
    wildcard = build_transport_security("0.0.0.0", 9000, [])
    assert not any("0.0.0.0" in h for h in wildcard.allowed_hosts)


def test_parse_allowed_hosts() -> None:
    assert parse_allowed_hosts(" a.test, b.test ,,") == ["a.test", "b.test"]
    assert parse_allowed_hosts(None) == []
    assert parse_allowed_hosts("") == []


def test_cli_flag_and_env_plumbing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRUEPPM_API_URL", SAMPLE_API_URL)
    monkeypatch.setenv("TRUEPPM_API_TOKEN", SAMPLE_TOKEN)
    monkeypatch.setenv(ENV_ALLOWED_HOSTS, "env.test,both.test")
    seen: dict[str, object] = {}

    class _Fake:
        def run(self, transport: str) -> None:
            pass

    def _capture(_client: object, **kwargs: object) -> _Fake:
        seen.update(kwargs)
        return _Fake()

    monkeypatch.setattr(cli, "build_server", _capture)
    assert (
        cli.main(
            ["--transport", "http", "--allowed-host", "flag.test", "--allowed-host", "both.test"]
        )
        == 0
    )
    assert seen["allowed_hosts"] == ["env.test", "both.test", "flag.test"]


def test_env_name_is_documented() -> None:
    assert ENV_ALLOWED_HOSTS == "TRUEPPM_MCP_ALLOWED_HOSTS"


def test_ipv6_bind_host_is_bracketed() -> None:
    ts = build_transport_security("fd00::5", 9000, [])
    assert "[fd00::5]:9000" in ts.allowed_hosts
    assert "http://[fd00::5]:9000" in ts.allowed_origins
    assert "fd00::5:9000" not in ts.allowed_hosts


def test_ipv6_allowed_host_literal_bare_or_bracketed() -> None:
    for given in ("fd00::7", "[fd00::7]"):
        ts = build_transport_security("0.0.0.0", 8000, [given])
        assert "[fd00::7]" in ts.allowed_hosts
        assert "[fd00::7]:*" in ts.allowed_hosts
        assert "https://[fd00::7]" in ts.allowed_origins


async def test_ipv6_host_header_validates() -> None:
    ts = build_transport_security("fd00::5", 9000, [])
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "headers": [(b"host", b"[fd00::5]:9000"), (b"content-type", b"application/json")],
        }
    )
    assert await TransportSecurityMiddleware(ts).validate_request(request, is_post=True) is None


async def test_portless_loopback_host_accepted() -> None:
    assert await _validate("localhost") is None
    assert await _validate("127.0.0.1", "http://127.0.0.1") is None


async def test_sse_app_rejects_foreign_host(settings: Settings) -> None:
    client = TruePPMClient(settings)
    try:
        app = build_server(client, host="0.0.0.0").sse_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://x",
        ) as http:
            bad = await http.get("/sse", headers={"host": "evil.example"})
            bad_post = await http.post(
                "/messages/?session_id=0" + "0" * 31,
                json={},
                headers={"host": "evil.example", "content-type": "application/json"},
            )
        assert bad.status_code == 421
        assert bad_post.status_code == 421
    finally:
        await client.aclose()
