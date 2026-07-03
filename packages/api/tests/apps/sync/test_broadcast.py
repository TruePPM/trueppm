"""Tests for evict_project_connection (#813) — the push-based WS eviction helper.

The consumer-side connection_evict handler is covered in test_consumers.py; this
file covers the broadcast helper that fans the evict out to both the board and
workshop groups, including its best-effort failure handling.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from trueppm_api.apps.sync.broadcast import abroadcast_board_event, evict_project_connection

_GET_LAYER = "channels.layers.get_channel_layer"


class _FakeChannelLayer:
    """Records group_send calls instead of touching a real channel backend."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []

    async def group_send(self, group: str, message: dict[str, Any]) -> None:
        self.sent.append((group, message))


def test_evict_sends_to_board_and_workshop_groups() -> None:
    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        evict_project_connection("p1", "u9")
    assert layer.sent == [
        ("project_p1", {"type": "connection.evict", "user_id": "u9"}),
        ("project_p1_workshop", {"type": "connection.evict", "user_id": "u9"}),
    ]


def test_evict_is_noop_when_no_channel_layer_configured() -> None:
    # No layer (e.g. layers disabled in a worker) → log + return, never raise.
    with patch(_GET_LAYER, return_value=None):
        evict_project_connection("p1", "u9")


def test_evict_swallows_group_send_failure() -> None:
    """Best-effort like broadcast_board_event: a layer error is logged, not raised."""

    class _BoomLayer:
        async def group_send(self, group: str, message: dict[str, Any]) -> None:
            raise RuntimeError("channel layer down")

    with patch(_GET_LAYER, return_value=_BoomLayer()):
        evict_project_connection("p1", "u9")


# ---------------------------------------------------------------------------
# abroadcast_board_event (#958) — async-native broadcast for event-loop callers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_abroadcast_awaits_group_send_with_board_envelope() -> None:
    """The async helper awaits group_send directly with the flat board.event shape."""
    layer = _FakeChannelLayer()
    with patch(_GET_LAYER, return_value=layer):
        await abroadcast_board_event("p1", "presence_join", {"user_id": "u9"})
    assert layer.sent == [
        (
            "project_p1",
            {
                "type": "board.event",
                "protocol_version": 1,
                "event_type": "presence_join",
                "payload": {"user_id": "u9"},
            },
        )
    ]


@pytest.mark.asyncio
async def test_abroadcast_is_noop_when_no_channel_layer_configured() -> None:
    with patch(_GET_LAYER, return_value=None):
        await abroadcast_board_event("p1", "presence_join", {"user_id": "u9"})


@pytest.mark.asyncio
async def test_abroadcast_swallows_group_send_failure() -> None:
    """Best-effort like the sync helper: a layer error is logged, not raised."""

    class _BoomLayer:
        async def group_send(self, group: str, message: dict[str, Any]) -> None:
            raise RuntimeError("channel layer down")

    with patch(_GET_LAYER, return_value=_BoomLayer()):
        await abroadcast_board_event("p1", "presence_join", {"user_id": "u9"})


# ---------------------------------------------------------------------------
# WS event-type freeze (#1019) — the WebSocket analogue of test_event_type_cap.
#
# WS event types are scattered as string literals in broadcast_board_event() /
# abroadcast_board_event() call sites rather than centralized in an enum (unlike
# the webhook WebhookEventType cap). That makes the WS contract easy to drift: a
# new mutation can broadcast a brand-new event_type with no review gate. The
# 0.4 read-only MCP server and external integrators bind to this set, so it must
# freeze before launch. This test re-derives the live set by AST-scanning the
# source for the second positional (or event_type=) literal of those two helpers
# and asserts it equals the frozen list below. Adding or removing a broadcast
# event without updating FROZEN_WS_EVENT_TYPES fails loudly — the WS analogue of
# the webhook OSS_WEBHOOK_EVENT_CAP guard.
#
# Two call sites pass event_type as a *variable* (the inbound-sync relay and the
# generic services.py dispatcher), not a literal; they forward an already-frozen
# type and so are intentionally excluded — there is nothing to freeze there.
#
# The scanner also follows ONE level of wrapper indirection (#1381): a local
# function/method that forwards one of its *parameters* into the event_type slot
# of a helper (e.g. taskruns/tracker.py:_broadcast, projects/retro_board_services
# .py:_broadcast) is itself a broadcast site whose real event types live at its
# *call* sites as literals. Without this, a wrapper-emitted event (task_run_*,
# retro_item_*) silently escapes the freeze guard. See _broadcast_event_types_in_
# source below.
# ---------------------------------------------------------------------------

FROZEN_WS_EVENT_TYPES = frozenset(
    {
        "api_token_minted",
        "api_token_revoked",
        "assignment_created",
        "assignment_deleted",
        "assignment_updated",
        "backlog_reranked",
        "baseline_activated",
        "baseline_created",
        "baseline_deleted",
        "board_config_updated",
        "board_view_created",
        "board_view_deleted",
        "board_view_updated",
        "comment_created",
        "cpm_complete",
        "cpm_error",
        "demo_presenter_set",
        "demo_reordered",
        "demo_toggled",
        "dependency_accepted",
        "dependency_created",
        "dependency_deleted",
        "dependency_rejected",
        "dependency_updated",
        "flagged_for_backlog",
        "member_added",
        "member_removed",
        "member_role_changed",
        "milestone_forecast_updated",
        "milestone_rollup_updated",
        "phases_reordered",
        "poker_session_updated",
        "presence_join",
        "presence_leave",
        "retro_item_created",
        "retro_item_deleted",
        "retro_item_moved",
        "retro_item_updated",
        "program_closed",
        "program_deleted",
        "program_reopened",
        "program_split",
        "program_sponsorship_transferred",
        "project_archived",
        "project_created",
        "project_custom_fields_updated",
        "project_deleted",
        "project_hard_deleted",
        "project_transferred",
        "project_unarchived",
        "project_updated",
        "queue_reordered",
        "review_note_set",
        "risk_created",
        "risk_deleted",
        "risk_updated",
        "risks_imported",
        "roster_changed",
        "slip_conflict_acknowledged",
        "slip_conflicts_updated",
        "sprint_activated",
        "sprint_cancelled",
        "sprint_closed",
        "sprint_created",
        "sprint_deleted",
        "sprint_reranked",
        "sprint_retro_updated",
        "sprint_scope_changed",
        "sprint_updated",
        "suggestion_created",
        "suggestion_declined",
        "suggestion_revoked",
        "task_attachment_created",
        "task_attachment_deleted",
        "task_comment_ack_changed",
        "task_comment_created",
        "task_comment_deleted",
        "task_comment_reaction_added",
        "task_comment_reaction_removed",
        "task_comment_updated",
        "task_created",
        "task_dates_updated",
        "task_deleted",
        "task_duration_changed",
        "task_link_created",
        "task_link_deleted",
        "task_link_updated",
        "task_note_created",
        "task_note_decision_toggled",
        "task_note_deleted",
        "task_note_pinned",
        "task_note_updated",
        "task_run_cancelled",
        "task_run_completed",
        "task_run_failed",
        "task_run_progress",
        "task_run_started",
        "task_updated",
        "tasks_bulk_mutated",
        "tasks_reordered",
        "tasks_restructured",
        "team_member_changed",
        "workshop_ended",
        "workshop_started",
    }
)


def _broadcast_event_types_in_source() -> set[str]:
    """AST-scan the API source for literal event types reaching the broadcast helpers.

    Returns the set of distinct string literals that become a broadcast
    ``event_type``, discovered two ways:

    1. **Direct** — a string literal passed as the ``event_type`` argument
       (2nd positional, or ``event_type=`` keyword) of a
       ``broadcast_board_event`` / ``abroadcast_board_event`` call.
    2. **One level of wrapper indirection** (#1381) — a local function/method
       that forwards one of its *parameters* into the helper's ``event_type``
       slot is a "wrapper"; its real event types are the literals passed for
       that parameter at the wrapper's *own* call sites. This catches events
       emitted only through a thin relay (``taskruns/tracker.py:_broadcast``,
       ``projects/retro_board_services.py:_broadcast``), which would otherwise
       escape the freeze guard because the helper sees a variable, not a literal.

    Wrapper detection and resolution are scoped per-module (a wrapper is matched
    against call sites in the same file), which keeps same-named wrappers in
    different modules from cross-contaminating.
    """
    import ast
    import pathlib

    import trueppm_api

    root = pathlib.Path(trueppm_api.__file__).resolve().parent
    helpers = {"broadcast_board_event", "abroadcast_board_event"}
    found: set[str] = set()

    def _callee_name(call: ast.Call) -> str | None:
        func = call.func
        if isinstance(func, ast.Attribute):
            return func.attr
        if isinstance(func, ast.Name):
            return func.id
        return None

    def _str_const(node: ast.expr | None) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return None

    def _event_type_arg(call: ast.Call) -> ast.expr | None:
        """The node in a helper call's ``event_type`` slot (2nd positional / kw)."""
        if len(call.args) >= 2:
            return call.args[1]
        for kw in call.keywords:
            if kw.arg == "event_type":
                return kw.value
        return None

    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), str(path))

        # Pass 1 — find wrapper functions in this module. A wrapper forwards a
        # parameter into a helper's event_type slot. Record, per wrapper name,
        # the parameter name and the positional index that parameter occupies at
        # the wrapper's call sites (a bound method drops `self`/`cls`, so the
        # call-site index is one less than the def index).
        wrappers: dict[str, list[tuple[str, int]]] = {}
        for fn in ast.walk(tree):
            if not isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            params = [a.arg for a in fn.args.posonlyargs] + [a.arg for a in fn.args.args]
            is_method = bool(params) and params[0] in {"self", "cls"}
            for sub in ast.walk(fn):
                if not isinstance(sub, ast.Call) or _callee_name(sub) not in helpers:
                    continue
                ev = _event_type_arg(sub)
                if isinstance(ev, ast.Name) and ev.id in params:
                    def_index = params.index(ev.id)
                    call_index = def_index - 1 if is_method else def_index
                    wrappers.setdefault(fn.name, []).append((ev.id, call_index))

        # Pass 2 — collect literals from direct helper calls and from calls to
        # any wrapper discovered above.
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _callee_name(node)
            if name in helpers:
                lit = _str_const(_event_type_arg(node))
                if lit is not None:
                    found.add(lit)
            elif name in wrappers:
                for param_name, call_index in wrappers[name]:
                    if 0 <= call_index < len(node.args):
                        lit = _str_const(node.args[call_index])
                        if lit is not None:
                            found.add(lit)
                    for kw in node.keywords:
                        if kw.arg == param_name:
                            lit = _str_const(kw.value)
                            if lit is not None:
                                found.add(lit)
    return found


def test_ws_event_type_set_is_frozen() -> None:
    """The set of WS event types broadcast from source must match the frozen list.

    If this fails, a broadcast_board_event() / abroadcast_board_event() call added
    or removed a literal event_type. Update FROZEN_WS_EVENT_TYPES *and* the WS↔
    webhook taxonomy table in docs/api (packages/website/src/content/docs/api/
    websockets.md) in the same change — the WS contract is frozen for MCP/external
    consumers (#1019)."""
    live = _broadcast_event_types_in_source()
    missing = FROZEN_WS_EVENT_TYPES - live
    added = live - FROZEN_WS_EVENT_TYPES
    assert not missing, f"Frozen WS event types no longer broadcast in source: {sorted(missing)}"
    assert not added, f"New WS event types broadcast without freezing them: {sorted(added)}"


def test_wrapper_emitted_events_are_discovered_and_frozen() -> None:
    """Events emitted only through a one-level broadcast wrapper are still frozen (#1381).

    ``task_run_*`` (taskruns/tracker.py:_broadcast) and ``retro_item_*``
    (retro_board_services.py:_broadcast) reach broadcast_board_event with a
    *variable* event_type, so the scanner must follow the wrapper to its call
    sites to find their literals. This guards both halves: the scanner discovers
    them, and they are in the frozen set."""
    wrapper_emitted = {
        "task_run_started",
        "task_run_progress",
        "task_run_completed",
        "task_run_failed",
        "task_run_cancelled",
        "retro_item_created",
        "retro_item_updated",
        "retro_item_moved",
        "retro_item_deleted",
    }
    live = _broadcast_event_types_in_source()
    undiscovered = wrapper_emitted - live
    assert not undiscovered, (
        "Wrapper-emitted WS events not discovered by the scanner — wrapper "
        f"indirection regressed: {sorted(undiscovered)}"
    )
    assert wrapper_emitted <= FROZEN_WS_EVENT_TYPES
