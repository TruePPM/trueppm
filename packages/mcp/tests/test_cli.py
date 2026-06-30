"""CLI entry-point tests for :mod:`trueppm_mcp.cli`."""

from __future__ import annotations

import pytest

import trueppm_mcp.cli as cli
from trueppm_mcp.cli import _TRANSPORTS, main


def test_missing_config_returns_exit_code_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A misconfigured client gets an actionable stderr message and exit code 2."""
    monkeypatch.delenv("TRUEPPM_API_URL", raising=False)
    monkeypatch.delenv("TRUEPPM_API_TOKEN", raising=False)
    assert main([]) == 2
    err = capsys.readouterr().err
    assert "Configuration error" in err


def test_main_runs_chosen_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    """With valid config, main() builds the server and runs the chosen transport.

    ``server.run`` blocks on a real transport, so it is stubbed to capture the
    transport it would have served and return immediately.
    """
    monkeypatch.setenv("TRUEPPM_API_URL", "https://ppm.example.test")
    monkeypatch.setenv("TRUEPPM_API_TOKEN", "tppm_x")
    served: dict[str, str] = {}

    class _FakeServer:
        def run(self, transport: str) -> None:
            served["transport"] = transport

    monkeypatch.setattr(cli, "build_server", lambda *a, **k: _FakeServer())

    assert main(["--transport", "http"]) == 0
    assert served["transport"] == "streamable-http"


def test_http_transport_maps_to_streamable_http() -> None:
    """`--transport http` resolves to FastMCP's streamable-http transport."""
    assert _TRANSPORTS["http"] == "streamable-http"
    assert _TRANSPORTS["stdio"] == "stdio"
    assert _TRANSPORTS["sse"] == "sse"
