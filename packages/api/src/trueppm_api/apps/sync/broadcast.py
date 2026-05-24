"""Broadcast helper — sends events to a project's WebSocket group.

All mutations and CPM completions call broadcast_board_event() wrapped in
transaction.on_commit() so that clients never receive an event for a write
that was subsequently rolled back.
"""

from __future__ import annotations

import logging
from typing import Any

from asgiref.sync import async_to_sync

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

    Synchronous helper for Django views and Celery tasks. Uses asgiref's
    async_to_sync adapter (the official Channels approach) rather than
    asyncio.run() so the existing thread's event-loop context is reused
    instead of a fresh one being booted per call.

    Durability: this broadcast is **best-effort by design** and safe to lose.
    Every event it carries is durably persisted in the DB before the broadcast
    is scheduled (callers wrap this in ``transaction.on_commit``), and clients
    reconcile by pulling the sync delta on (re)connect. If the channel layer is
    down at commit time the event is dropped and the client recovers it on its
    next delta fetch — nothing durable is lost. This is why ``on_commit``
    callbacks that *only* broadcast need no outbox row, whereas callbacks that
    dispatch Celery work must commit one first. See
    ``docs/durability/on-commit-audit.md`` (#659).

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
        async_to_sync(channel_layer.group_send)(group, message)
    except Exception:
        logger.exception("broadcast_board_event: failed to send %s to group %s", event_type, group)
