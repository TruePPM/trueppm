"""Broadcast helper — sends events to a project's workshop WebSocket group.

Workshop cursor and edit events use a separate channel group
(project_{pk}_workshop) to avoid polluting the main board channel with
high-frequency cursor messages.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _workshop_group(project_id: str) -> str:
    return f"project_{project_id}_workshop"


def broadcast_workshop_event(
    project_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Send a JSON event to all clients connected to the project's workshop group.

    Uses the same asyncio.run() / loop.create_task() dispatch pattern as
    broadcast_board_event, but the channel-layer message envelope intentionally
    differs: event_type and payload are nested under a "content" key so that
    WorkshopConsumer.workshop_event() can relay the entire content dict to the
    client with a single send_json(event["content"]) call.  Do not "fix" this
    to match the flat broadcast_board_event layout — the consumer reads "content".

    Args:
        project_id: UUID string of the project.
        event_type: Short event identifier, e.g. "participant_joined".
        payload:    JSON-serializable dict with event-specific data.
    """
    from channels.layers import get_channel_layer

    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.warning("broadcast_workshop_event: no channel layer configured, skipping")
        return

    group = _workshop_group(project_id)
    message = {
        "type": "workshop.event",
        "content": {
            "event_type": event_type,
            "payload": payload,
        },
    }

    try:
        asyncio.run(_send(channel_layer, group, message))
    except RuntimeError:
        loop = asyncio.get_event_loop()
        _task = loop.create_task(_send(channel_layer, group, message))
        _task.add_done_callback(lambda t: None)
    except Exception:
        logger.exception(
            "broadcast_workshop_event: failed to send %s to group %s",
            event_type,
            group,
        )


async def _send(channel_layer: Any, group: str, message: dict[str, Any]) -> None:
    await channel_layer.group_send(group, message)
