"""Tests for the read-only MCP tool surface (ADR-0186 §G, #504).

Every tool is exercised against ``httpx.MockTransport`` — no network, no running
TruePPM instance, no database. The tests assert three contracts:

* **Endpoint mapping** — each tool calls the API path(s) from ADR-0186 §G, and
  ``list_tasks`` forwards its filters as query parameters.
* **Compaction** — null/empty fields are dropped, long free-text is truncated to
  200 chars with a ``truncated`` marker, and ``0`` / ``False`` are preserved.
* **caller_role** — the two project tools (and ``list_programs``) surface the
  caller's role from the API's ``my_role_label``, never inferred locally.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest

from tests.conftest import SAMPLE_API_URL
from trueppm_mcp.client import ApiError, AuthError, TruePPMClient
from trueppm_mcp.config import Settings
from trueppm_mcp.server import build_server
from trueppm_mcp.tools import (
    _compact_mapping,
    _get_board_state,
    _get_monte_carlo_forecast,
    _get_program_health,
    _get_project,
    _get_schedule_derivation,
    _get_schedule_summary,
    _get_sprint,
    _get_task,
    _list_my_work,
    _list_programs,
    _list_projects,
    _list_risks,
    _list_sprints,
    _list_tasks,
    _whoami,
    _with_caller_role,
)

API_PREFIX = "/api/v1/"

Handler = Callable[[httpx.Request], httpx.Response]
RouteValue = httpx.Response | Handler
Routes = dict[str, RouteValue]


def _relative(request: httpx.Request) -> str:
    """The API path with the ``/api/v1/`` prefix stripped (e.g. ``projects/``)."""
    path = request.url.path
    assert path.startswith(API_PREFIX), path
    return path[len(API_PREFIX) :]


def _client(settings: Settings, routes: Routes) -> TruePPMClient:
    """A client whose transport answers each relative path from ``routes``.

    A route value is either a ready ``httpx.Response`` or a callable taking the
    request (used to capture query parameters). An unmapped path is a test bug
    and fails loudly rather than silently returning an empty list.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        rel = _relative(request)
        if rel not in routes:
            raise AssertionError(f"unexpected request path: {rel}")
        route = routes[rel]
        if isinstance(route, httpx.Response):
            return route
        return route(request)

    return TruePPMClient(settings, transport=httpx.MockTransport(handler))


def _json(payload: object) -> httpx.Response:
    return httpx.Response(200, json=payload)


def _page(results: list[dict[str, object]], count: int | None = None) -> dict[str, object]:
    return {
        "count": count if count is not None else len(results),
        "next": None,
        "previous": None,
        "results": results,
    }


# ---------------------------------------------------------------------------
# Compaction helpers
# ---------------------------------------------------------------------------


def test_compact_drops_null_and_empty_but_keeps_zero_and_false() -> None:
    result = _compact_mapping(
        {
            "name": "Task",
            "empty_str": "",
            "null": None,
            "empty_list": [],
            "empty_dict": {},
            "count": 0,
            "flag": False,
        }
    )
    assert result == {"name": "Task", "count": 0, "flag": False}


def test_compact_truncates_long_text_and_marks_truncated() -> None:
    long_text = "x" * 250
    result = _compact_mapping({"description": long_text})
    assert len(result["description"]) == 200
    assert result["truncated"] is True


def test_compact_short_text_is_not_marked_truncated() -> None:
    result = _compact_mapping({"description": "short"})
    assert result == {"description": "short"}
    assert "truncated" not in result


def test_compact_recurses_into_nested_mappings_and_lists() -> None:
    result = _compact_mapping({"nested": {"keep": 1, "drop": None}, "items": [{"a": 1, "b": ""}]})
    assert result == {"nested": {"keep": 1}, "items": [{"a": 1}]}


def test_caller_role_prefers_label_and_removes_raw_keys() -> None:
    result = _with_caller_role({"id": "p-1", "my_role": 400, "my_role_label": "Project Admin"})
    assert result == {"id": "p-1", "caller_role": "Project Admin"}


def test_caller_role_falls_back_to_ordinal_when_label_absent() -> None:
    result = _with_caller_role({"id": "p-1", "my_role": 100})
    assert result == {"id": "p-1", "caller_role": 100}


def test_caller_role_omitted_when_api_supplies_no_role() -> None:
    result = _with_caller_role({"id": "p-1", "my_role": None, "my_role_label": None})
    assert result == {"id": "p-1"}


# ---------------------------------------------------------------------------
# Project tools
# ---------------------------------------------------------------------------


async def test_list_projects_compacts_rows_and_surfaces_caller_role(settings: Settings) -> None:
    routes: Routes = {
        "projects/": _json(
            _page(
                [
                    {
                        "id": "p-1",
                        "name": "Apollo",
                        "description": None,
                        "my_role": 400,
                        "my_role_label": "Project Admin",
                    }
                ]
            )
        )
    }
    async with _client(settings, routes) as client:
        result = await _list_projects(client)
    assert result == [{"id": "p-1", "name": "Apollo", "caller_role": "Project Admin"}]


async def test_get_project_merges_detail_and_overview(settings: Settings) -> None:
    routes: Routes = {
        "projects/p-1/": _json(
            {"id": "p-1", "name": "Apollo", "my_role": 200, "my_role_label": "Resource Manager"}
        ),
        "projects/p-1/overview/": _json({"health": "GREEN", "task_count": 12, "blank": None}),
    }
    async with _client(settings, routes) as client:
        result = await _get_project(client, "p-1")
    assert result["id"] == "p-1"
    assert result["caller_role"] == "Resource Manager"
    assert result["overview"] == {"health": "GREEN", "task_count": 12}


# ---------------------------------------------------------------------------
# Task tools
# ---------------------------------------------------------------------------


async def test_list_tasks_forwards_all_filters_as_query_params(settings: Settings) -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(dict(request.url.params))
        return _json(_page([]))

    routes: Routes = {"tasks/": handler}
    async with _client(settings, routes) as client:
        await _list_tasks(
            client,
            "p-1",
            status="IN_PROGRESS",
            assignee="u-9",
            sprint="s-3",
            is_critical=True,
            task_type="STORY",
            updated_after="2026-06-01T00:00:00Z",
        )
    assert seen == {
        "project": "p-1",
        "status": "IN_PROGRESS",
        "assignee": "u-9",
        "sprint": "s-3",
        "is_critical": "true",
        "type": "STORY",
        "updated_after": "2026-06-01T00:00:00Z",
    }


async def test_list_tasks_omits_unset_filters(settings: Settings) -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(dict(request.url.params))
        return _json(_page([]))

    routes: Routes = {"tasks/": handler}
    async with _client(settings, routes) as client:
        await _list_tasks(client, "p-1")
    assert seen == {"project": "p-1"}


async def test_list_tasks_is_critical_false_is_sent_as_string(settings: Settings) -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(dict(request.url.params))
        return _json(_page([]))

    routes: Routes = {"tasks/": handler}
    async with _client(settings, routes) as client:
        await _list_tasks(client, "p-1", is_critical=False)
    assert seen == {"project": "p-1", "is_critical": "false"}


async def test_get_task_compacts_and_truncates(settings: Settings) -> None:
    routes: Routes = {
        "tasks/t-1/": _json(
            {
                "id": "t-1",
                "name": "Design",
                "notes": "n" * 300,
                "assignee": None,
                "progress": 0,
            }
        )
    }
    async with _client(settings, routes) as client:
        result = await _get_task(client, "t-1")
    assert result["id"] == "t-1"
    assert "assignee" not in result
    assert result["progress"] == 0
    assert len(result["notes"]) == 200
    assert result["truncated"] is True


# ---------------------------------------------------------------------------
# Composed tools
# ---------------------------------------------------------------------------


async def test_get_board_state_composes_columns_and_cards(settings: Settings) -> None:
    captured: dict[str, str] = {}

    def tasks_handler(request: httpx.Request) -> httpx.Response:
        captured.update(dict(request.url.params))
        return _json(_page([{"id": "t-1", "name": "A", "status": "TODO", "blank": None}]))

    routes: Routes = {
        "projects/p-1/board-config/": _json({"columns": [{"key": "TODO", "label": "To Do"}]}),
        "tasks/": tasks_handler,
    }
    async with _client(settings, routes) as client:
        result = await _get_board_state(client, "p-1")
    assert captured == {"project": "p-1"}
    assert result["columns"] == [{"key": "TODO", "label": "To Do"}]
    assert result["cards"] == [{"id": "t-1", "name": "A", "status": "TODO"}]


async def test_get_schedule_summary_adds_critical_task_count(settings: Settings) -> None:
    def tasks_handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params.get("is_critical") == "true"
        return _json(_page([{"id": "t-1"}, {"id": "t-2"}], count=2))

    routes: Routes = {
        "projects/p-1/forecast/": _json({"cpm_finish": "2026-09-01", "spi": 0.92, "empty": None}),
        "tasks/": tasks_handler,
    }
    async with _client(settings, routes) as client:
        result = await _get_schedule_summary(client, "p-1")
    assert result["cpm_finish"] == "2026-09-01"
    assert result["spi"] == 0.92
    assert result["critical_task_count"] == 2
    assert "empty" not in result


# ---------------------------------------------------------------------------
# Risk / Monte Carlo / sprint / program / identity tools
# ---------------------------------------------------------------------------


async def test_list_risks_compacts_rows(settings: Settings) -> None:
    routes: Routes = {
        "projects/p-1/risks/": _json(
            _page([{"id": "r-1", "title": "Vendor slip", "impact": 4, "owner": None}])
        )
    }
    async with _client(settings, routes) as client:
        result = await _list_risks(client, "p-1")
    assert result == [{"id": "r-1", "title": "Vendor slip", "impact": 4}]


async def test_get_monte_carlo_forecast_returns_latest_run(settings: Settings) -> None:
    routes: Routes = {
        "projects/p-1/monte-carlo/latest/": _json(
            {"p50": "2026-09-01", "p80": "2026-09-15", "p95": "2026-10-01"}
        )
    }
    async with _client(settings, routes) as client:
        result = await _get_monte_carlo_forecast(client, "p-1")
    assert result["p80"] == "2026-09-15"


async def test_get_schedule_derivation_returns_why(settings: Settings) -> None:
    routes: Routes = {
        "projects/p-1/schedule/derivation/": _json(
            {
                "task_id": "t-2",
                "quantity": "early_start",
                "value": "2026-03-06",
                "pass": "forward",
                "binding": {"kind": "predecessor_fs", "source_task_id": "t-1"},
                "contributions": [{"kind": "predecessor_fs", "is_binding": True}],
            }
        )
    }
    async with _client(settings, routes) as client:
        result = await _get_schedule_derivation(client, "p-1", "t-2", "early_start")
    assert result["binding"]["kind"] == "predecessor_fs"
    assert result["pass"] == "forward"


async def test_list_sprints_compacts_rows(settings: Settings) -> None:
    routes: Routes = {
        "projects/p-1/sprints/": _json(
            _page([{"id": "s-1", "name": "Sprint 1", "state": "ACTIVE"}])
        )
    }
    async with _client(settings, routes) as client:
        result = await _list_sprints(client, "p-1")
    assert result == [{"id": "s-1", "name": "Sprint 1", "state": "ACTIVE"}]


async def test_get_sprint_merges_health_when_project_present(settings: Settings) -> None:
    routes: Routes = {
        "sprints/s-1/": _json({"id": "s-1", "name": "Sprint 1", "project": "p-1"}),
        "projects/p-1/sprint-health/": _json({"band": "ON_TRACK", "completion": 0.4}),
    }
    async with _client(settings, routes) as client:
        result = await _get_sprint(client, "s-1")
    assert result["id"] == "s-1"
    assert result["health"] == {"band": "ON_TRACK", "completion": 0.4}


async def test_get_sprint_without_project_skips_health_call(settings: Settings) -> None:
    routes: Routes = {"sprints/s-1/": _json({"id": "s-1", "name": "Orphan"})}
    async with _client(settings, routes) as client:
        result = await _get_sprint(client, "s-1")
    assert result == {"id": "s-1", "name": "Orphan"}
    assert "health" not in result


async def test_list_my_work_compacts_rows(settings: Settings) -> None:
    routes: Routes = {
        "me/work/": _json(_page([{"id": "t-1", "name": "Mine", "due": "2026-07-05"}]))
    }
    async with _client(settings, routes) as client:
        result = await _list_my_work(client)
    assert result == [{"id": "t-1", "name": "Mine", "due": "2026-07-05"}]


async def test_list_programs_surfaces_caller_role(settings: Settings) -> None:
    routes: Routes = {
        "programs/": _json(
            _page(
                [
                    {
                        "id": "pr-1",
                        "name": "Mars",
                        "my_role": 300,
                        "my_role_label": "Project Manager",
                    }
                ]
            )
        )
    }
    async with _client(settings, routes) as client:
        result = await _list_programs(client)
    assert result == [{"id": "pr-1", "name": "Mars", "caller_role": "Project Manager"}]


async def test_get_program_health_returns_rollup(settings: Settings) -> None:
    routes: Routes = {"programs/pr-1/rollup/": _json({"health": "AMBER", "project_count": 5})}
    async with _client(settings, routes) as client:
        result = await _get_program_health(client, "pr-1")
    assert result == {"health": "AMBER", "project_count": 5}


async def test_whoami_returns_identity(settings: Settings) -> None:
    routes: Routes = {"auth/me/": _json({"id": "u-1", "display_name": "Ada", "initials": "AL"})}
    async with _client(settings, routes) as client:
        result = await _whoami(client)
    assert result == {"id": "u-1", "display_name": "Ada", "initials": "AL"}


# ---------------------------------------------------------------------------
# Error propagation
# ---------------------------------------------------------------------------


async def test_tool_propagates_auth_error(settings: Settings) -> None:
    routes: Routes = {"projects/": httpx.Response(401, json={"detail": "Invalid token."})}
    async with _client(settings, routes) as client:
        with pytest.raises(AuthError):
            await _list_projects(client)


async def test_tool_propagates_api_error(settings: Settings) -> None:
    routes: Routes = {"projects/p-1/risks/": httpx.Response(404, json={"detail": "Not found."})}
    async with _client(settings, routes) as client:
        with pytest.raises(ApiError):
            await _list_risks(client, "p-1")


# ---------------------------------------------------------------------------
# Registered wrappers (server.tool surface)
# ---------------------------------------------------------------------------


async def test_registered_wrappers_delegate_to_implementations(settings: Settings) -> None:
    """Each ``@server.tool()`` wrapper delegates to its implementation.

    Calls every registered tool's underlying function through the tool manager,
    with a transport that answers each tool's endpoint(s), to prove the wrappers
    are wired to the client and — for ``list_tasks`` — resolve the ``since``
    alias to ``updated_after``.
    """
    seen_task_params: dict[str, str] = {}

    def tasks_handler(request: httpx.Request) -> httpx.Response:
        seen_task_params.update(dict(request.url.params))
        return _json(_page([]))

    routes: Routes = {
        "projects/": _json(_page([])),
        "projects/p-1/": _json({"id": "p-1"}),
        "projects/p-1/overview/": _json({"health": "GREEN"}),
        "tasks/": tasks_handler,
        "tasks/t-1/": _json({"id": "t-1"}),
        "projects/p-1/board-config/": _json({"columns": []}),
        "projects/p-1/forecast/": _json({"cpm_finish": "2026-09-01"}),
        "projects/p-1/risks/": _json(_page([])),
        "projects/p-1/monte-carlo/latest/": _json({"p50": "2026-09-01"}),
        "projects/p-1/sprints/": _json(_page([])),
        "sprints/s-1/": _json({"id": "s-1"}),
        "me/work/": _json(_page([])),
        "programs/": _json(_page([])),
        "programs/pr-1/rollup/": _json({"health": "AMBER"}),
        "auth/me/": _json({"id": "u-1"}),
    }
    client = _client(settings, routes)
    server = build_server(client)
    manager = server._tool_manager
    try:

        async def call(name: str, **kwargs: object) -> Any:
            tool = manager.get_tool(name)
            assert tool is not None
            return await tool.fn(**kwargs)

        assert await call("list_projects") == []
        assert (await call("get_project", project_id="p-1"))["id"] == "p-1"
        assert await call("get_task", task_id="t-1") == {"id": "t-1"}
        assert (await call("get_board_state", project_id="p-1"))["cards"] == []
        assert "critical_task_count" in await call("get_schedule_summary", project_id="p-1")
        assert await call("list_risks", project_id="p-1") == []
        assert (await call("get_monte_carlo_forecast", project_id="p-1"))["p50"] == "2026-09-01"
        assert await call("list_sprints", project_id="p-1") == []
        assert (await call("get_sprint", sprint_id="s-1"))["id"] == "s-1"
        assert await call("list_my_work") == []
        assert await call("list_programs") == []
        assert (await call("get_program_health", program_id="pr-1"))["health"] == "AMBER"
        assert (await call("whoami"))["id"] == "u-1"

        # ``since`` is the accepted alias for ``updated_after``.
        seen_task_params.clear()
        await call("list_tasks", project_id="p-1", since="2026-06-01T00:00:00Z")
        assert seen_task_params == {"project": "p-1", "updated_after": "2026-06-01T00:00:00Z"}

        # An explicit ``updated_after`` wins over ``since``.
        seen_task_params.clear()
        await call(
            "list_tasks",
            project_id="p-1",
            updated_after="2026-06-10T00:00:00Z",
            since="2026-06-01T00:00:00Z",
        )
        assert seen_task_params["updated_after"] == "2026-06-10T00:00:00Z"
    finally:
        await client.aclose()


def test_base_url_prefix_is_stable() -> None:
    """Guards the ``/api/v1/`` prefix the route table strips (belt-and-suspenders)."""
    assert API_PREFIX == "/api/v1/"
    assert SAMPLE_API_URL == "https://ppm.example.test"
