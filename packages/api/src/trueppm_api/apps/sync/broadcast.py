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

# Event types that are deliberately NOT persisted to the BoardEvent replay buffer
# (ADR-0236, #321). Everything else is persisted so a reconnecting client can
# replay it via ``?since=``. A *denylist* (not an allowlist) is the fail-safe
# default: every mutation event maps to an idempotent client cache-invalidation,
# so replaying one is always safe, and a newly-added mutation event should be
# replayable without anyone remembering to register it. Two reasons to exclude:
#
#   1. **Ephemeral** high-frequency live progress / presence pings — a stale
#      progress bar or a presence ping for a since-departed peer carries no value
#      on replay.
#   2. **Post-delete** — ``project_hard_deleted`` fires from an on_commit callback
#      *after* the project row (and its cascade-deleted buffer rows) are gone, so
#      persisting a BoardEvent for it would dangle the project FK. The DEFERRABLE
#      FK check surfaces at COMMIT, past ``_persist_board_event``'s try/except, so
#      it cannot be swallowed — it must not be attempted. A hard-deleted project
#      has no replay value anyway (a reconnecting member is evicted or 404s).
DONT_PERSIST_EVENT_TYPES = frozenset(
    {
        "presence_join",
        "presence_leave",
        "task_run_started",
        "task_run_progress",
        "task_run_completed",
        "task_run_failed",
        "task_run_cancelled",
        "project_hard_deleted",
    }
)


def _group_name(project_id: str) -> str:
    """Return the channel layer group name for a project."""
    return f"project_{project_id}"


def _record_broadcast_metric() -> None:
    """Best-effort increment of the WS broadcast counter (#1900).

    Imported lazily (matching this module's lazy-import convention) and wrapped so a
    telemetry error can never touch the latency-sensitive broadcast path — the
    broadcast is best-effort, and so is its metric.
    """
    try:
        from trueppm_api.apps.observability.otel import metrics

        metrics.record_ws_broadcast()
    except Exception:
        logger.debug("broadcast metric increment skipped", exc_info=True)


def _persist_board_event(project_id: str, event_type: str, payload: dict[str, Any]) -> int | None:
    """Persist a replayable event to the BoardEvent buffer; return its sequence.

    The sequence is the row's ``BigAutoField`` PK — globally monotonic, assigned
    atomically by Postgres, so it survives concurrent commits with no lost or
    duplicate values (ADR-0236). Returns ``None`` for non-persisted events
    (``DONT_PERSIST_EVENT_TYPES``) and on any DB failure: best-effort exactly like the
    broadcast itself, so a failed insert logs and is swallowed — the live event
    still goes out (without a ``seq``) and the client recovers the gap via a
    ``resync_required`` on its next reconnect.

    Callers already run this inside a ``transaction.on_commit`` callback, so the
    INSERT happens post-commit in autocommit — the row is the durable truth, the
    broadcast is the best-effort echo.
    """
    if event_type in DONT_PERSIST_EVENT_TYPES:
        return None

    from django.db import DatabaseError

    from trueppm_api.apps.sync.models import BoardEvent

    try:
        row = BoardEvent.objects.create(
            project_id=project_id, event_type=event_type, payload=payload
        )
    except DatabaseError:
        logger.exception(
            "broadcast: failed to persist BoardEvent %s for project %s", event_type, project_id
        )
        return None
    return row.pk


def _board_message(
    event_type: str, payload: dict[str, Any], seq: int | None = None
) -> dict[str, Any]:
    """Build the ``board.event`` channel-layer envelope consumers expect.

    Shared by the sync and async broadcast helpers so the wire shape stays in
    one place — ``ProjectConsumer.board_event`` reads ``event_type``/``payload``
    off the top level (unlike the workshop channel, which nests under
    ``content``). The ``protocol_version`` field is the single source of the wire
    version for every board event (#1325).

    ``seq`` is the BoardEvent sequence for a persisted (replayable) event, or
    ``None`` for an ephemeral event that was not buffered (ADR-0236). It is
    additive: a client that ignores it behaves exactly as before, so
    ``protocol_version`` stays ``1``.
    """
    return {
        "type": "board.event",
        "protocol_version": WS_PROTOCOL_VERSION,
        "event_type": event_type,
        "payload": payload,
        "seq": seq,
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

    # Persist the replay-buffer row first so its sequence can ride the live
    # payload (ADR-0236). Best-effort: a persist failure yields seq=None and the
    # event still broadcasts.
    seq = _persist_board_event(project_id, event_type, payload)

    group = _group_name(project_id)
    try:
        async_to_sync(channel_layer.group_send)(group, _board_message(event_type, payload, seq))
    except Exception:
        logger.exception("broadcast_board_event: failed to send %s to group %s", event_type, group)
    else:
        # Count the successful fan-out (#1900). A strict no-op unless telemetry is
        # on, self-guarding, and in the ``else`` branch so a failed send is not
        # counted — this only observes the broadcast, never alters its semantics.
        _record_broadcast_metric()


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

    # Persist the replay-buffer row (ADR-0236). The only async callers today are
    # presence join/leave, which are ephemeral and short-circuit to seq=None
    # without touching the DB; the database_sync_to_async hop only runs if a future
    # async caller broadcasts a replayable event, keeping this path symmetric with
    # the sync helper rather than silently dropping such an event from the buffer.
    if event_type in DONT_PERSIST_EVENT_TYPES:
        seq = None
    else:
        from channels.db import database_sync_to_async

        seq = await database_sync_to_async(_persist_board_event)(project_id, event_type, payload)

    group = _group_name(project_id)
    try:
        await channel_layer.group_send(group, _board_message(event_type, payload, seq))
    except Exception:
        logger.exception("abroadcast_board_event: failed to send %s to group %s", event_type, group)
    else:
        # Count the successful fan-out (#1900) — same contract as the sync helper.
        _record_broadcast_metric()


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
