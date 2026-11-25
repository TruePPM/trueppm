"""Tool-id validation and the cleartext base-URL refusal (#4302).

Tool arguments are chosen by the calling model, which may have read a prompt-injected
task or comment. An id interpolated into a REST path can steer the GET at another
read endpoint, so every id must be a UUID before any request is built; and a base URL
that is not ``https`` (or loopback) would send the bearer token in cleartext.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from mcp.server.fastmcp.exceptions import ToolError

from tests.conftest import SAMPLE_TOKEN
from trueppm_mcp.client import TruePPMClient
from trueppm_mcp.config import ConfigError, Settings
from trueppm_mcp.server import build_server

_UUID = "123e4567-e89b-12d3-a456-426614174000"

# (tool name, arguments naming every id argument with a placeholder to corrupt)
_ID_TOOLS: list[tuple[str, dict[str, Any]]] = [
    ("get_project", {"project_id": _UUID}),
    ("list_tasks", {"project_id": _UUID}),
    ("get_task", {"task_id": _UUID}),
    ("get_board_state", {"project_id": _UUID}),
    ("get_schedule_summary", {"project_id": _UUID}),
    ("list_risks", {"project_id": _UUID}),
    ("get_monte_carlo_forecast", {"project_id": _UUID}),
    ("get_project_cost", {"project_id": _UUID}),
    ("whatif", {"project_id": _UUID, "task_id": _UUID}),
    ("get_schedule_derivation", {"project_id": _UUID, "quantity": "p80"}),
    # The optional task_id is checked only when supplied, so it needs its own row.
    ("get_schedule_derivation", {"project_id": _UUID, "task_id": _UUID, "quantity": "p80"}),
    ("get_schedule_driving_chain", {"project_id": _UUID, "task_id": _UUID}),
    ("get_release_forecast", {"project_id": _UUID}),
    ("list_sprints", {"project_id": _UUID}),
    ("get_sprint", {"sprint_id": _UUID}),
    ("get_sprint_close_request", {"sprint_id": _UUID}),
    ("get_program_health", {"program_id": _UUID}),
    ("list_program_backlog", {"program_id": _UUID}),
    ("get_project_history", {"project_id": _UUID}),
    ("get_project_views", {"project_id": _UUID}),
    ("list_dependencies", {"project_id": _UUID}),
    ("list_baselines", {"project_id": _UUID}),
    ("get_changeset", {"project_id": _UUID}),
    ("list_baseline_decisions", {"project_id": _UUID}),
    ("list_phases", {"project_id": _UUID}),
]

_HOSTILE = ["x/../../auth/me", "x?param=1", "x#frag", "../y", "p-1", "", _UUID + "/extra", "%2e%2e"]


def _server(settings: Settings) -> tuple[Any, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"results": [], "count": 0})

    client = TruePPMClient(settings, transport=httpx.MockTransport(handler))
    return build_server(client), seen


@pytest.mark.parametrize(("tool", "args"), _ID_TOOLS)
@pytest.mark.parametrize("bad", _HOSTILE)
async def test_a_non_uuid_id_is_refused_before_any_request(
    settings: Settings, tool: str, args: dict[str, Any], bad: str
) -> None:
    server, seen = _server(settings)
    for name in [k for k in args if k.endswith("_id")]:
        with pytest.raises(ToolError, match=f"{name} must be a UUID"):
            await server.call_tool(tool, {**args, name: bad})
    assert seen == []


async def test_every_tool_taking_an_id_is_in_the_table(settings: Settings) -> None:
    """A new tool with an ``*_id`` argument must join ``_ID_TOOLS`` (and validate it)."""
    server, _ = _server(settings)
    covered = {name for name, _args in _ID_TOOLS}
    takes_id = {
        tool.name
        for tool in await server.list_tools()
        if any(k.endswith("_id") for k in tool.inputSchema.get("properties", {}))
    }
    assert takes_id - covered == set()


async def test_a_uuid_id_is_still_accepted(settings: Settings) -> None:
    server, seen = _server(settings)
    await server.call_tool("list_risks", {"project_id": _UUID})
    assert seen, "a valid UUID must reach the API"
    assert f"projects/{_UUID}/" in str(seen[0].url)


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com",
        "http://ppm.example.test/api/v1",
        "http://10.0.0.5:8000",
        "http://localhost.evil.test",
        "ppm.example.test",
        "ftp://ppm.example.test",
        "https://",
    ],
)
def test_a_cleartext_or_schemeless_base_url_is_refused(url: str) -> None:
    with pytest.raises(ConfigError) as exc_info:
        Settings.from_env({"TRUEPPM_API_URL": url, "TRUEPPM_API_TOKEN": SAMPLE_TOKEN})
    assert "https" in str(exc_info.value)
    assert SAMPLE_TOKEN not in str(exc_info.value)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://[::1]:8000",
        "https://ppm.example.test",
    ],
)
def test_https_and_loopback_base_urls_are_allowed(url: str) -> None:
    settings = Settings.from_env({"TRUEPPM_API_URL": url, "TRUEPPM_API_TOKEN": SAMPLE_TOKEN})
    assert settings.api_base_url.endswith("/api/v1")
