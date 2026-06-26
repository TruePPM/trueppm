"""Broadcast helper — sends events to a project's WebSocket group.

All mutations and CPM completions call broadcast_board_event() wrapped in
transaction.on_commit() so that clients never receive an event for a write
that was subsequently rolled back.
"""

from __future__ import annotations

import logging
from datetime import UTC
from typing import Any

from asgiref.sync import async_to_sync

logger = logging.getLogger(__name__)

# Wire-protocol version for the ``board.event`` envelope (#1325). A bare integer
# down-payment reserved *before* 0.3 ships and freezes 60+ ``event_type`` strings:
# once a client builds against the envelope, adding a versioning handshake later
# would be a breaking change, whereas a field that is already present can grow a
# meaning without one. Clients that don't read it are unaffected; future clients
# can branch on it. Bump only on a backward-incompatible envelope change.
WS_PROTOCOL_VERSION = 1


def _group_name(project_id: str) -> str:
    """Return the channel layer group name for a project."""
    return f"project_{project_id}"


def _board_message(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Build the ``board.event`` channel-layer envelope consumers expect.

    Shared by the sync and async broadcast helpers so the wire shape stays in
    one place — ``ProjectConsumer.board_event`` reads ``event_type``/``payload``
    off the top level (unlike the workshop channel, which nests under
    ``content``). The ``protocol_version`` field is the single source of the wire
    version for every board event (#1325).
    """
    return {
        "type": "board.event",
        "protocol_version": WS_PROTOCOL_VERSION,
        "event_type": event_type,
        "payload": payload,
    }


def broadcast_task_updated(
    project_id: str,
    *,
    task_id: str,
    changed_fields: list[str],
    version: int | None,
    actor_id: str | None,
) -> None:
    """Broadcast a field-level ``task_updated`` delta (ADR-0152, #327).

    Assembles the standard mutation-delta payload so every task-mutation call site
    emits the same shape: collaborators learn *which* fields changed, at what
    ``server_version``, and *who* changed them — without the field *values* ever
    crossing the wire. Values are deliberately omitted because task fields are
    role-gated (ADR-0104 nulls ``story_points`` below the velocity audience, cost
    fields are gated, etc.); a client that needs the new values re-reads the task
    through the serializer, which re-applies per-user gating. ``actor_id`` lets the
    originating client suppress its own echo and avoid clobbering an in-flight
    optimistic update.

    Like :func:`broadcast_board_event`, this is best-effort and must be wrapped in
    ``transaction.on_commit`` by the caller. The ``id`` key is retained for
    backward compatibility with consumers that only read it.
    """
    broadcast_board_event(
        project_id,
        "task_updated",
        {
            "id": task_id,
            "changed_fields": sorted(changed_fields),
            "version": version,
            "actor_id": actor_id,
            "ts": _utcnow_iso(),
        },
    )


def _utcnow_iso() -> str:
    """Current UTC time as an ISO-8601 string (factored out for test stubbing)."""
    from datetime import datetime

    return datetime.now(UTC).isoformat()


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
    try:
        async_to_sync(channel_layer.group_send)(group, _board_message(event_type, payload))
    except Exception:
        logger.exception("broadcast_board_event: failed to send %s to group %s", event_type, group)


async def abroadcast_board_event(
    project_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Async-native broadcast for callers already on an event loop.

    The synchronous ``broadcast_board_event`` wraps ``group_send`` in
    ``async_to_sync``, which raises ``RuntimeError`` when called from a thread
    that already runs an event loop — exactly the case inside a Channels
    consumer. Async callers (e.g. ``ProjectConsumer`` presence join/leave) must
    ``await`` this instead so ``group_send`` is awaited directly.

    Same best-effort durability contract as the sync helper: a channel-layer
    failure is logged and swallowed, never raised — clients reconcile on
    reconnect (#958).

    Args:
        project_id:  UUID string of the project whose group to broadcast to.
        event_type:  Short identifier for the event, e.g. "presence_join".
        payload:     JSON-serializable dict with event-specific data.
    """
    from channels.layers import get_channel_layer

    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.warning("abroadcast_board_event: no channel layer configured, skipping broadcast")
        return

    group = _group_name(project_id)
    try:
        await channel_layer.group_send(group, _board_message(event_type, payload))
    except Exception:
        logger.exception("abroadcast_board_event: failed to send %s to group %s", event_type, group)


def evict_project_connection(project_id: str, user_id: str) -> None:
    """Push a ``connection.evict`` to a project's board + workshop WS groups (#813).

    Project membership is checked only at ``websocket_connect``; once accepted, a
    socket keeps receiving every ``board_event`` until it disconnects. When a
    ``ProjectMembership`` is soft-deleted or demoted below ``Role.MEMBER``, this
    evicts the user's *live* sockets so they stop receiving real-time project data
    immediately (the reconnect path is already gated — this closes the active-
    connection gap, the analog of #419). Each consumer whose authenticated user
    matches ``user_id`` closes with code 4003; sockets for other users ignore it.

    Targets both the board group (``project_{id}``) and the workshop group
    (``project_{id}_workshop``) since both gate on the same membership. Best-effort
    like ``broadcast_board_event`` — callers defer it with ``transaction.on_commit``.
    """
    from channels.layers import get_channel_layer

    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.warning("evict_project_connection: no channel layer configured, skipping")
        return

    message = {"type": "connection.evict", "user_id": str(user_id)}
    base = _group_name(project_id)
    for group in (base, f"{base}_workshop"):
        try:
            async_to_sync(channel_layer.group_send)(group, message)
        except Exception:
            logger.exception("evict_project_connection: failed to evict %s from %s", user_id, group)
