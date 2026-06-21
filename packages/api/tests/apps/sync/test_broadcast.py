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
        "dependency_created",
        "dependency_deleted",
        "dependency_updated",
        "flagged_for_backlog",
        "member_added",
        "member_removed",
        "member_role_changed",
        "milestone_forecast_updated",
        "milestone_rollup_updated",
        "phases_reordered",
        "presence_join",
        "presence_leave",
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
        "review_note_set",
        "risk_created",
        "risk_deleted",
        "risk_updated",
        "risks_imported",
        "roster_changed",
        "sprint_activated",
        "sprint_cancelled",
        "sprint_closed",
        "sprint_created",
        "sprint_deleted",
        "sprint_reranked",
        "sprint_scope_changed",
        "sprint_updated",
        "suggestion_created",
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
        "task_note_deleted",
        "task_note_pinned",
        "task_note_updated",
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
    """AST-scan the API source for literal event types passed to the broadcast helpers.

    Returns the set of distinct string literals appearing as the ``event_type``
    argument (2nd positional, or ``event_type=`` keyword) of any
    ``broadcast_board_event`` / ``abroadcast_board_event`` call.
    """
    import ast
    import pathlib

    import trueppm_api

    root = pathlib.Path(trueppm_api.__file__).resolve().parent
    helpers = {"broadcast_board_event", "abroadcast_board_event"}
    found: set[str] = set()
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = (
                func.attr
                if isinstance(func, ast.Attribute)
                else func.id
                if isinstance(func, ast.Name)
                else None
            )
            if name not in helpers:
                continue
            if (
                len(node.args) >= 2
                and isinstance(node.args[1], ast.Constant)
                and isinstance(node.args[1].value, str)
            ):
                found.add(node.args[1].value)
            for kw in node.keywords:
                if (
                    kw.arg == "event_type"
                    and isinstance(kw.value, ast.Constant)
                    and isinstance(kw.value.value, str)
                ):
                    found.add(kw.value.value)
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
