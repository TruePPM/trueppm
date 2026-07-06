"""The read-only tool surface for the TruePPM MCP server (ADR-0186 §D/§G, #504).

Every tool is a hand-authored async function that issues one (occasionally two)
``httpx`` ``GET`` requests through :class:`~trueppm_mcp.client.TruePPMClient` and
shapes a compact, LLM-context-friendly result. There is no ORM access and no
enterprise import: authorization — RBAC role gates, member-scoped querysets, the
404-vs-403 existence oracle — is enforced once, at the API layer, identically for
this client and the web client (ADR-0186 §I). Read-only by construction: every
tool is a ``GET``; none can mutate data.

The compact-result contract (#504):

* Null and empty (``None`` / ``""`` / ``[]`` / ``{}``) fields are omitted.
* Long free-text fields (``description``, ``notes``, …) are truncated to 200
  characters and the containing object is marked ``"truncated": true``.
* ``list_projects`` / ``get_project`` (and ``list_programs``) carry
  ``caller_role`` — the caller's own role, passed through from the API's
  authoritative ``my_role_label``, never inferred in the MCP server (ADR-0186 §F).

Each module-level ``_<tool>`` function is the testable implementation (exercised
against ``httpx.MockTransport``); :func:`register_tools` binds a thin
``@server.tool()`` wrapper around each, closing over the shared client.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from mcp.server.fastmcp import FastMCP

from trueppm_mcp.client import TruePPMClient

#: Free-text fields truncated to keep tool results within an LLM context budget.
_TEXT_FIELDS = frozenset({"description", "notes", "mitigation", "response", "summary", "narrative"})

#: Maximum length (characters) of a retained free-text field before truncation.
_TEXT_LIMIT = 200


# ---------------------------------------------------------------------------
# Compaction helpers
# ---------------------------------------------------------------------------


def _compact_value(value: Any) -> Any:
    """Recursively compact a JSON value (see :func:`_compact_mapping`)."""
    if isinstance(value, Mapping):
        return _compact_mapping(value)
    if isinstance(value, list):
        return [_compact_value(item) for item in value]
    return value


def _compact_mapping(data: Mapping[str, Any]) -> dict[str, Any]:
    """Drop null/empty entries and truncate long free-text fields.

    Zero and ``False`` are preserved (only ``None`` / ``""`` / ``[]`` / ``{}`` are
    dropped). When any field in :data:`_TEXT_FIELDS` exceeds :data:`_TEXT_LIMIT`
    it is cut to the limit and the returned object gains a ``"truncated": true``
    marker so the model knows the text was elided.
    """
    out: dict[str, Any] = {}
    truncated = False
    for key, raw in data.items():
        value = _compact_value(raw)
        if value is None or value == "" or value == [] or value == {}:
            continue
        if key in _TEXT_FIELDS and isinstance(value, str) and len(value) > _TEXT_LIMIT:
            value = value[:_TEXT_LIMIT]
            truncated = True
        out[key] = value
    if truncated:
        out["truncated"] = True
    return out


def _with_caller_role(item: Mapping[str, Any]) -> dict[str, Any]:
    """Fold the API's ``my_role`` / ``my_role_label`` into a single ``caller_role``.

    The human label is preferred (an LLM reasons about "Viewer" / "Project
    Manager", not an ordinal); the integer role is a fallback. The raw
    ``my_role`` / ``my_role_label`` keys are removed so the result carries exactly
    one role representation. ``caller_role`` is omitted entirely when the API did
    not annotate a role (defensive — reachable rows always carry one).
    """
    out = dict(item)
    label = out.pop("my_role_label", None)
    role = out.pop("my_role", None)
    caller_role = label if label is not None else role
    if caller_role is not None:
        out["caller_role"] = caller_role
    return out


def _items(payload: Any) -> list[Any]:
    """Extract the row list from a DRF response (paginated ``results`` or a list)."""
    if isinstance(payload, Mapping) and "results" in payload:
        results = payload["results"]
        return list(results) if isinstance(results, list) else []
    if isinstance(payload, list):
        return payload
    return []


def _count(payload: Any) -> int:
    """Total row count from a DRF response — ``count`` if paginated, else length."""
    if isinstance(payload, Mapping):
        count = payload.get("count")
        if isinstance(count, int):
            return count
    return len(_items(payload))


def _project_result(item: Mapping[str, Any]) -> dict[str, Any]:
    """Compact a project row and enrich it with ``caller_role`` (ADR-0186 §F)."""
    return _compact_mapping(_with_caller_role(item))


# ---------------------------------------------------------------------------
# Tool implementations (testable; each takes the client explicitly)
# ---------------------------------------------------------------------------


async def _list_projects(client: TruePPMClient) -> list[dict[str, Any]]:
    """Every project the token owner can read, each with ``caller_role``."""
    payload = await client.get("projects/")
    return [_project_result(row) for row in _items(payload)]


async def _get_project(client: TruePPMClient, project_id: str) -> dict[str, Any]:
    """Full project metadata (with ``caller_role``) plus its health overview."""
    detail = await client.get(f"projects/{project_id}/")
    result = _project_result(detail if isinstance(detail, Mapping) else {})
    overview = await client.get(f"projects/{project_id}/overview/")
    compact_overview = _compact_value(overview)
    if compact_overview not in (None, "", [], {}):
        result["overview"] = compact_overview
    return result


def _task_params(
    project_id: str,
    *,
    status: str | None,
    assignee: str | None,
    sprint: str | None,
    is_critical: bool | None,
    task_type: str | None,
    updated_after: str | None,
) -> dict[str, Any]:
    """Build the ``/tasks/`` query string, omitting unset filters."""
    params: dict[str, Any] = {"project": project_id}
    if status is not None:
        params["status"] = status
    if assignee is not None:
        params["assignee"] = assignee
    if sprint is not None:
        params["sprint"] = sprint
    if is_critical is not None:
        params["is_critical"] = "true" if is_critical else "false"
    if task_type is not None:
        params["type"] = task_type
    if updated_after is not None:
        params["updated_after"] = updated_after
    return params


async def _list_tasks(
    client: TruePPMClient,
    project_id: str,
    *,
    status: str | None = None,
    assignee: str | None = None,
    sprint: str | None = None,
    is_critical: bool | None = None,
    task_type: str | None = None,
    updated_after: str | None = None,
) -> list[dict[str, Any]]:
    """Tasks in a project, filterable and compacted."""
    params = _task_params(
        project_id,
        status=status,
        assignee=assignee,
        sprint=sprint,
        is_critical=is_critical,
        task_type=task_type,
        updated_after=updated_after,
    )
    payload = await client.get("tasks/", params=params)
    return [_compact_mapping(row) for row in _items(payload)]


async def _get_task(client: TruePPMClient, task_id: str) -> dict[str, Any]:
    """A single task with all its fields (dates, assignee, criteria, sprint)."""
    payload = await client.get(f"tasks/{task_id}/")
    return _compact_mapping(payload if isinstance(payload, Mapping) else {})


async def _get_board_state(client: TruePPMClient, project_id: str) -> dict[str, Any]:
    """Board columns composed with the project's task cards (two endpoints)."""
    board_config = await client.get(f"projects/{project_id}/board-config/")
    tasks = await client.get("tasks/", params={"project": project_id})
    columns = board_config.get("columns") if isinstance(board_config, Mapping) else board_config
    return {
        "columns": _compact_value(columns) if columns is not None else [],
        "cards": [_compact_mapping(row) for row in _items(tasks)],
    }


async def _get_schedule_summary(client: TruePPMClient, project_id: str) -> dict[str, Any]:
    """CPM/Monte-Carlo forecast plus the count of critical-path tasks."""
    forecast = await client.get(f"projects/{project_id}/forecast/")
    critical = await client.get("tasks/", params={"project": project_id, "is_critical": "true"})
    result = _compact_mapping(forecast if isinstance(forecast, Mapping) else {})
    result["critical_task_count"] = _count(critical)
    return result


async def _list_risks(client: TruePPMClient, project_id: str) -> list[dict[str, Any]]:
    """The project's risk register (impact / probability / status)."""
    payload = await client.get(f"projects/{project_id}/risks/")
    return [_compact_mapping(row) for row in _items(payload)]


async def _get_monte_carlo_forecast(client: TruePPMClient, project_id: str) -> dict[str, Any]:
    """The latest persisted Monte Carlo run (P50/P80/P95, cpm_finish, delta)."""
    payload = await client.get(f"projects/{project_id}/monte-carlo/latest/")
    return _compact_mapping(payload if isinstance(payload, Mapping) else {})


async def _whatif(
    client: TruePPMClient,
    project_id: str,
    task_id: str,
    *,
    duration_delta: int | None = None,
    new_duration: int | None = None,
    n_simulations: int | None = None,
) -> dict[str, Any]:
    """Perturb one task's duration and recompute CPM + Monte Carlo (non-mutating).

    Wraps ``GET /projects/<pk>/monte-carlo/whatif/`` (#993): the endpoint runs a
    baseline and a perturbed pass through the engine in memory — persisting
    nothing — and returns ``current`` vs ``whatif`` percentiles, the deterministic
    CPM finish, ``critical_path_changed``, and the signed ``delta_vs_current``.
    Exactly one of ``duration_delta`` / ``new_duration`` must be supplied; the
    endpoint returns 400 otherwise (surfaced here as an :class:`ApiError`). The
    result is compacted like every other tool, so ``critical_path_changed`` (a
    ``bool``) and zero-day deltas survive — only ``None`` deltas are dropped.
    """
    params: dict[str, Any] = {"task_id": task_id}
    if duration_delta is not None:
        params["duration_delta"] = duration_delta
    if new_duration is not None:
        params["new_duration"] = new_duration
    if n_simulations is not None:
        params["n_simulations"] = n_simulations
    payload = await client.get(f"projects/{project_id}/monte-carlo/whatif/", params=params)
    return _compact_mapping(payload if isinstance(payload, Mapping) else {})


async def _get_schedule_derivation(
    client: TruePPMClient,
    project_id: str,
    task_id: str,
    quantity: str,
) -> dict[str, Any]:
    """The server-computed *why* behind one computed schedule value (ADR-0218)."""
    payload = await client.get(
        f"projects/{project_id}/schedule/derivation/",
        params={"task_id": task_id, "quantity": quantity},
    )
    return _compact_mapping(payload if isinstance(payload, Mapping) else {})


async def _get_release_forecast(client: TruePPMClient, project_id: str) -> dict[str, Any]:
    """P50/P80 sprints and dates to clear the project's committed backlog."""
    payload = await client.get(f"projects/{project_id}/sprint-forecast/")
    return _compact_mapping(payload if isinstance(payload, Mapping) else {})


async def _list_sprints(client: TruePPMClient, project_id: str) -> list[dict[str, Any]]:
    """The project's sprints (aggregates only — no per-person velocity)."""
    payload = await client.get(f"projects/{project_id}/sprints/")
    return [_compact_mapping(row) for row in _items(payload)]


async def _get_sprint(client: TruePPMClient, sprint_id: str) -> dict[str, Any]:
    """A single sprint with its project's health band (aggregates only)."""
    sprint = await client.get(f"sprints/{sprint_id}/")
    result = _compact_mapping(sprint if isinstance(sprint, Mapping) else {})
    project_id = sprint.get("project") if isinstance(sprint, Mapping) else None
    if project_id is not None:
        health = await client.get(f"projects/{project_id}/sprint-health/")
        compact_health = _compact_value(health)
        if compact_health not in (None, "", [], {}):
            result["health"] = compact_health
    return result


async def _list_my_work(client: TruePPMClient) -> list[dict[str, Any]]:
    """The caller's assigned tasks across every project they belong to."""
    payload = await client.get("me/work/")
    return [_compact_mapping(row) for row in _items(payload)]


async def _list_programs(client: TruePPMClient) -> list[dict[str, Any]]:
    """Every program the token owner can read, each with ``caller_role``."""
    payload = await client.get("programs/")
    return [_project_result(row) for row in _items(payload)]


async def _get_program_health(client: TruePPMClient, program_id: str) -> dict[str, Any]:
    """A single program's rollup health (single-program only; cross-program is Enterprise)."""
    payload = await client.get(f"programs/{program_id}/rollup/")
    return _compact_mapping(payload if isinstance(payload, Mapping) else {})


async def _list_program_backlog(client: TruePPMClient, program_id: str) -> list[dict[str, Any]]:
    """The program's backlog — its intake pool of items, ranked by priority."""
    payload = await client.get(f"programs/{program_id}/backlog-items/")
    return [_compact_mapping(row) for row in _items(payload)]


async def _whoami(client: TruePPMClient) -> dict[str, Any]:
    """The identity behind the configured token (connection check)."""
    payload = await client.get("auth/me/")
    return _compact_mapping(payload if isinstance(payload, Mapping) else {})


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def register_tools(server: FastMCP[TruePPMClient], client: TruePPMClient) -> None:
    """Register the read-only tool surface on ``server``, bound to ``client``.

    Each ``@server.tool()`` wrapper closes over the shared
    :class:`~trueppm_mcp.client.TruePPMClient` (the same instance the lifespan
    authenticates and closes) and delegates to the matching module-level
    implementation. The wrappers carry the LLM-facing descriptions; the
    implementations carry the request/compaction logic.
    """

    @server.tool()
    async def list_projects() -> list[dict[str, Any]]:
        """List every project you can read, each with your role (``caller_role``)."""
        return await _list_projects(client)

    @server.tool()
    async def get_project(project_id: str) -> dict[str, Any]:
        """Full metadata and health overview for one project, with ``caller_role``.

        Args:
            project_id: The project's UUID.
        """
        return await _get_project(client, project_id)

    @server.tool()
    async def list_tasks(
        project_id: str,
        status: str | None = None,
        assignee: str | None = None,
        sprint: str | None = None,
        is_critical: bool | None = None,
        type: str | None = None,  # mirrors the API's ?type= filter
        updated_after: str | None = None,
        since: str | None = None,
    ) -> list[dict[str, Any]]:
        """List a project's tasks, optionally filtered.

        Args:
            project_id: The project's UUID (required).
            status: Filter by workflow status (e.g. ``TODO``, ``IN_PROGRESS``).
            assignee: Filter by assignee (user UUID).
            sprint: Filter by sprint UUID.
            is_critical: Only critical-path tasks when true.
            type: Filter by task type (e.g. ``TASK``, ``STORY``, ``EPIC``).
            updated_after: ISO-8601 timestamp — only tasks changed since then
                (for incremental re-reads). ``since`` is an accepted alias.
            since: Alias for ``updated_after``.
        """
        return await _list_tasks(
            client,
            project_id,
            status=status,
            assignee=assignee,
            sprint=sprint,
            is_critical=is_critical,
            task_type=type,
            updated_after=updated_after if updated_after is not None else since,
        )

    @server.tool()
    async def get_task(task_id: str) -> dict[str, Any]:
        """Full detail for one task (dates, assignee, acceptance criteria, sprint).

        Args:
            task_id: The task's UUID.
        """
        return await _get_task(client, task_id)

    @server.tool()
    async def get_board_state(project_id: str) -> dict[str, Any]:
        """The board's columns and their task cards for one project.

        Args:
            project_id: The project's UUID.
        """
        return await _get_board_state(client, project_id)

    @server.tool()
    async def get_schedule_summary(project_id: str) -> dict[str, Any]:
        """CPM finish, Monte Carlo P50/P80/P95, SPI, and critical-task count.

        Args:
            project_id: The project's UUID.
        """
        return await _get_schedule_summary(client, project_id)

    @server.tool()
    async def list_risks(project_id: str) -> list[dict[str, Any]]:
        """The project's risk register (impact, probability, status).

        Args:
            project_id: The project's UUID.
        """
        return await _list_risks(client, project_id)

    @server.tool()
    async def get_monte_carlo_forecast(project_id: str) -> dict[str, Any]:
        """The latest persisted Monte Carlo forecast (P50/P80/P95, cpm_finish, delta).

        Read-only: returns the most recent stored run and never triggers a new
        simulation. Use ``whatif`` to ask "what breaks if this task slips?" —
        it recomputes in memory without persisting anything.

        Args:
            project_id: The project's UUID.
        """
        return await _get_monte_carlo_forecast(client, project_id)

    @server.tool()
    async def whatif(
        project_id: str,
        task_id: str,
        duration_delta: int | None = None,
        new_duration: int | None = None,
        n_simulations: int | None = None,
    ) -> dict[str, Any]:
        """What breaks if this task's duration changes — an engine-computed answer.

        Perturbs one task's duration and recomputes the whole schedule (CPM +
        Monte Carlo) **in memory, persisting nothing**. Returns the current vs.
        what-if P50/P80/P95 forecast, the deterministic CPM finish for each,
        whether the critical path changed (``critical_path_changed``), and the
        signed calendar-day shift of each figure (``delta_vs_current``, positive =
        later/worse). Use it to answer "what happens to the delivery date if I
        slip this task 5 days?" with a computed number, not a guess.

        Read-only and side-effect-free (modeled as a GET): it writes no rows,
        caches nothing, and enqueues no recompute.

        Args:
            project_id: The project's UUID.
            task_id: The committed task whose duration to perturb.
            duration_delta: Signed day offset on the task's current duration
                (e.g. ``5`` to slip it a working week, ``-2`` to pull it in).
                Supply exactly one of ``duration_delta`` or ``new_duration``.
            new_duration: Absolute day count to set the duration to (>= 0).
                Supply exactly one of ``duration_delta`` or ``new_duration``.
            n_simulations: Monte Carlo iterations; defaults to the server cap.
        """
        return await _whatif(
            client,
            project_id,
            task_id,
            duration_delta=duration_delta,
            new_duration=new_duration,
            n_simulations=n_simulations,
        )

    @server.tool()
    async def get_schedule_derivation(
        project_id: str, task_id: str, quantity: str
    ) -> dict[str, Any]:
        """The *why* behind a computed schedule value — cite the reason, not just the number.

        Returns the server-computed derivation of one value: the driving
        predecessor/successor, the binding constraint, each term's lag and
        calendar-snap contribution, and which CPM pass (forward/backward/float)
        set it. Computed from the engine's own pass data — never guessed — so an
        agent can explain *why* a date, float, or forecast percentile is what it is.

        Read-only. Use it to answer "why is this task's early start this date?" or
        "what drives the P80 finish?" with a citable reason.

        Args:
            project_id: The project's UUID.
            task_id: The task whose computed value is being explained. Required for
                a CPM quantity; ignored for a Monte Carlo percentile.
            quantity: A CPM quantity (early_start, early_finish, late_start,
                late_finish, total_float, free_float) or a Monte Carlo percentile
                (p50, p80, p95).
        """
        return await _get_schedule_derivation(client, project_id, task_id, quantity)

    @server.tool()
    async def get_release_forecast(project_id: str) -> dict[str, Any]:
        """P50/P80 delivery forecast for clearing a project's committed backlog.

        Runs off the team's velocity Monte Carlo: returns the P50 and P80 number
        of sprints — and the calendar dates — to finish the remaining committed
        backlog, plus the P95 date and the remaining point/count totals. Always a
        range, never a single date. Returns a ``warming_up`` shape (null figures)
        when there is not yet enough velocity history, or when you are below the
        project's velocity audience.

        Read-only: the forecast is computed on read and never persists anything.

        Args:
            project_id: The project's UUID.
        """
        return await _get_release_forecast(client, project_id)

    @server.tool()
    async def list_sprints(project_id: str) -> list[dict[str, Any]]:
        """The project's sprints (health bands and aggregates only).

        Args:
            project_id: The project's UUID.
        """
        return await _list_sprints(client, project_id)

    @server.tool()
    async def get_sprint(sprint_id: str) -> dict[str, Any]:
        """One sprint with its project's health band (aggregates only).

        Args:
            sprint_id: The sprint's UUID.
        """
        return await _get_sprint(client, sprint_id)

    @server.tool()
    async def list_my_work() -> list[dict[str, Any]]:
        """Your assigned tasks across every project you belong to (``My Work``)."""
        return await _list_my_work(client)

    @server.tool()
    async def list_programs() -> list[dict[str, Any]]:
        """List every program you can read, each with your role (``caller_role``)."""
        return await _list_programs(client)

    @server.tool()
    async def get_program_health(program_id: str) -> dict[str, Any]:
        """Rollup health for one program (single-program; cross-program is Enterprise).

        Args:
            program_id: The program's UUID.
        """
        return await _get_program_health(client, program_id)

    @server.tool()
    async def list_program_backlog(program_id: str) -> list[dict[str, Any]]:
        """A program's backlog — its intake pool of items, ranked by priority.

        Read-only listing of the program's backlog items: title, type, status,
        story points, priority rank, and whether each has already been pulled
        into a project task. Single-program only; cross-program portfolio intake
        is Enterprise.

        Args:
            program_id: The program's UUID.
        """
        return await _list_program_backlog(client, program_id)

    @server.tool()
    async def whoami() -> dict[str, Any]:
        """The identity behind your token — a quick connection check."""
        return await _whoami(client)
