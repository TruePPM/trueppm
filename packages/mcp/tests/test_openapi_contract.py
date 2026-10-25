"""Contract: what an MCP tool sends and promises must match the API (#4637).

``GET /api/v1/tasks/`` silently ignores unknown query params, so a tool that
advertises a filter the server never reads returns the unfiltered list and no
test on the MCP side notices (the client tests only assert forwarding). These
tests bind every query param a tool sends, and every enum value its docstring
quotes, to ``docs/api/openapi.json``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import httpx

from trueppm_mcp.client import TruePPMClient
from trueppm_mcp.config import Settings
from trueppm_mcp.server import build_server

OPENAPI = Path(__file__).resolve().parents[3] / "docs" / "api" / "openapi.json"
API_PREFIX = "/api/v1"

# Query params the client/pagination layer adds itself, not a tool filter.
_TRANSPORT_PARAMS = {"page", "page_size"}

# One value per argument name; enough to make every tool send every param it can.
_ARG_VALUES: dict[str, Any] = {
    "project_id": "p-1",
    "task_id": "t-1",
    "sprint_id": "s-1",
    "program_id": "pr-1",
    "status": "IN_PROGRESS",
    "sprint": "s-1",
    "is_critical": True,
    "type": "task",
    "assignee": "1",
    "updated_after": "2026-06-01T00:00:00Z",
    "since": "2026-06-01T00:00:00Z",
    "duration_delta": 1,
    "new_duration": 2,
    "n_simulations": 100,
    "quantity": "early_start",
}


def _spec() -> dict[str, Any]:
    spec: dict[str, Any] = json.loads(OPENAPI.read_text(encoding="utf-8"))
    return spec


def _operation_params(spec: dict[str, Any], rel_path: str) -> set[str] | None:
    """Declared query params of the GET operation matching ``rel_path``, or None."""
    for template, item in spec["paths"].items():
        pattern = "/".join(
            "[^/]+" if seg.startswith("{") else re.escape(seg) for seg in template.split("/")
        )
        if re.fullmatch(pattern, f"{API_PREFIX}/{rel_path}") and "get" in item:
            return {p["name"] for p in item["get"].get("parameters", []) if p["in"] == "query"}
    return None


async def _sent_requests(settings: Settings) -> tuple[list[tuple[str, set[str]]], list[str]]:
    seen: list[tuple[str, set[str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path[len(API_PREFIX) + 1 :], set(request.url.params)))
        return httpx.Response(200, json={"count": 0, "next": None, "previous": None, "results": []})

    client = TruePPMClient(settings, transport=httpx.MockTransport(handler))
    names: list[str] = []
    try:
        server = build_server(client)
        for tool in await server.list_tools():
            names.append(tool.name)
            registered = server._tool_manager.get_tool(tool.name)
            assert registered is not None
            kwargs = {k: _ARG_VALUES[k] for k in registered.parameters["properties"]}
            await registered.fn(**kwargs)
    finally:
        await client.aclose()
    return seen, names


async def test_every_query_param_a_tool_sends_is_declared_by_the_api(settings: Settings) -> None:
    spec = _spec()
    seen, names = await _sent_requests(settings)
    assert names, "no tools registered"
    assert seen, "no requests captured"
    offenders = []
    for rel_path, params in seen:
        declared = _operation_params(spec, rel_path)
        assert declared is not None, f"no GET operation in openapi.json for {rel_path}"
        undeclared = params - declared - _TRANSPORT_PARAMS
        if undeclared:
            offenders.append((rel_path, sorted(undeclared)))
    assert not offenders, f"tools send query params the API does not declare: {offenders}"


async def test_list_tasks_docstring_enum_examples_are_real_enum_members(
    settings: Settings,
) -> None:
    schemas = _spec()["components"]["schemas"]
    client = TruePPMClient(settings)
    try:
        tools = {t.name: t for t in await build_server(client).list_tools()}
        doc = tools["list_tasks"].description or ""
    finally:
        await client.aclose()

    for arg, enum_name in (("status", "TaskStatusEnum"), ("type", "TaskTypeEnum")):
        line = re.search(rf"{arg}: (.*?)(?:\n\s+\w+: |\Z)", doc, re.S)
        assert line is not None, f"docstring no longer documents {arg}"
        quoted = set(re.findall(r"``([^`]+)``", line.group(1)))
        assert quoted, f"{arg} docstring quotes no values"
        assert quoted == set(schemas[enum_name]["enum"]), (arg, quoted)
