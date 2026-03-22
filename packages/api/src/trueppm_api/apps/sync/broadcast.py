"""Broadcast helper — sends events to a project's WebSocket group.

All mutations and CPM completions call broadcast_board_event() wrapped in
transaction.on_commit() so that clients never receive an event for a write
that was subsequently rolled back.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _group_name(project_id: str) -> str:
    """Return the channel layer group name for a project."""
    return f"project_{project_id}"


def broadcast_board_event(
    project_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Send a JSON event to all WebSocket clients connected to a project group.

    This is a synchronous helper designed to be called from Celery tasks and
    Django views (both of which run in sync context). It uses
    asyncio.run() to drive the async channel layer call.

    Args:
        project_id:  UUID string of the project whose group to broadcast to.
        event_type:  Short identifier for the event, e.g. "task_created" or
                     "cpm_complete".
        payload:     JSON-serializable dict with event-specific data.
    """
    from channels.layers import get_channel_layer

    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.warning("broadcast_board_event: no channel layer configured, skipping broadcast")
        return

    group = _group_name(project_id)
    message = {
        "type": "board.event",
        "event_type": event_type,
        "payload": payload,
    }

    try:
        asyncio.run(_send(channel_layer, group, message))
    except RuntimeError:
        # asyncio.run() raises RuntimeError if an event loop is already running
        # (e.g. inside an async consumer). Use the running loop instead.
        loop = asyncio.get_event_loop()
        _bg_task = loop.create_task(_send(channel_layer, group, message))
        # Keep a reference so the task is not garbage-collected before completion.
        _bg_task.add_done_callback(lambda t: None)
    except Exception:
        logger.exception("broadcast_board_event: failed to send %s to group %s", event_type, group)


async def _send(channel_layer: Any, group: str, message: dict[str, Any]) -> None:
    await channel_layer.group_send(group, message)
