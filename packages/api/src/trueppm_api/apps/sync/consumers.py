"""WebSocket consumer for real-time project board events."""

from __future__ import annotations

import json
import logging
import sys
from typing import Any, cast

from channels.generic.websocket import AsyncJsonWebsocketConsumer

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.observability.otel import metrics
from trueppm_api.apps.sync.ws_auth import authenticate_scope, warn_if_legacy

logger = logging.getLogger(__name__)

_PRESENCE_TTL = 60  # seconds — refreshed on every received message (heartbeat)

# Upper bound on events replayed on a single reconnect (ADR-0236). A client
# further behind than this is cheaper to fully refetch than to stream, so it gets
# a ``resync_required`` frame instead — matching the "since older than retention"
# fallback.
_REPLAY_CAP = 1000


def _presence_key(project_pk: str) -> str:
    return f"project:{project_pk}:presence"


def _parse_since(query_string: bytes) -> int:
    """Parse a non-negative ``?since=<seq>`` from the raw ASGI query string.

    Returns 0 when the param is absent or non-numeric — 0 means "no replay, I am
    a fresh client" (the initial REST load already has current state). Mirrors the
    naive byte-split parsing in ``ws_auth._parse_query``; ``since`` is plain digits
    so no percent-decoding is needed.
    """
    for pair in query_string.split(b"&"):
        if pair.startswith(b"since="):
            try:
                # Clamp to [0, bigint max]: a value above Postgres' bigint range
                # (sys.maxsize == 2**63-1 on 64-bit) would raise mid-query when
                # bound as a bigint, closing the socket on a bogus input.
                return max(min(int(pair[len(b"since=") :]), sys.maxsize), 0)
            except ValueError:
                return 0
    return 0


class ProjectConsumer(AsyncJsonWebsocketConsumer):  # type: ignore[misc]
    """Pushes project board events to subscribed clients.

    Authentication:  A single-use ticket supplied as `?ticket=<id>` (ADR-0141),
                     issued by `POST /api/v1/ws/ticket/` and consumed from Redis
                     on connect. The legacy `?token=<jwt>` query param is disabled
                     by default and opt-in only via
                     `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED` (#1723). Connection is
                     rejected (4001) if no valid credential is present.

    Authorization:   The user must hold at least the Member role (ordinal ≥ 1)
                     on the requested project. Viewers (role == Role.VIEWER) are rejected.

    Presence:        On connect, the user is added to a Redis hash keyed by
                     `project:{pk}:presence`.  A `presence_join` event is
                     broadcast to the group.  On disconnect, the entry is
                     removed and a `presence_leave` event is broadcast.
                     The hash expires after _PRESENCE_TTL seconds; each
                     received message (heartbeat) resets the expiry.

    Receive:         Client→server messages reset the presence TTL.  All other
                     content is silently discarded.
    """

    #: One async Redis client per socket, created lazily on the first presence
    #: call and closed in ``disconnect`` (#1530). ``None`` until first use / after
    #: close, so ``disconnect`` before ``connect`` is a safe no-op.
    _redis: Any = None

    #: True once this socket was counted into the active-connections gauge (after
    #: accept). Guards the disconnect decrement so an early-rejected connect — which
    #: returns before the increment — never underflows the gauge (#1900).
    _ws_counted: bool = False

    async def websocket_connect(self, message: dict[str, Any]) -> None:
        """Override to run sync DB queries before accepting the socket."""
        # Authenticate the handshake before calling super() which sends ACCEPT.
        # Prefers the single-use ?ticket= (ADR-0141); the ?token=<jwt> fallback is
        # off by default, opt-in via TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED (#1723).
        scope = self.scope
        auth = await authenticate_scope(scope)
        if auth.user is None:
            await self.close(code=4001)
            return
        user = auth.user

        # Resolve project PK from URL route kwargs.
        project_pk = str(scope["url_route"]["kwargs"]["pk"])
        warn_if_legacy(auth, consumer="ProjectConsumer", project_pk=project_pk)

        # Check membership ≥ Member (Viewers cannot connect). Symbolic comparison
        # so the gate stays correct under ADR-0072 role-ordinal re-spacing.
        role = await self._get_role(user, project_pk)
        if role is None or role < Role.MEMBER:
            await self.close(code=4003)
            return

        self.project_pk = project_pk
        self.group_name = f"project_{project_pk}"
        self._user = user
        self._display_name: str = user.get_full_name() or user.username

        await self.channel_layer.group_add(self.group_name, self.channel_name)

        # Register presence in Redis and notify other clients.
        await self._presence_join()

        await super().websocket_connect(message)

        # Count this socket into the active-connections gauge only after accept, so
        # rejected handshakes (which returned above) are never counted. The paired
        # decrement in disconnect() is guarded by _ws_counted so the gauge balances
        # even if the connection is torn down at any later point (#1900).
        metrics.record_ws_connection_opened()
        self._ws_counted = True

        # Replay events missed while this client was disconnected (ADR-0236).
        # Runs AFTER accept (send_json needs an open socket) but still inside
        # websocket_connect: AsyncJsonWebsocketConsumer's dispatch loop is blocked
        # until this coroutine returns, so no live board_event is delivered during
        # replay — replayed (older seq) frames always precede live (newer seq)
        # ones. group_add ran first, so an event broadcast mid-replay is queued and
        # delivered right after these frames, never lost. Only members reach here
        # (Viewers were rejected above), and the query is scoped to this project,
        # so replay honors the same authz as the live stream (no cross-project
        # leak).
        since = _parse_since(scope.get("query_string", b""))
        if since > 0:
            await self._replay_missed_events(since)

    async def disconnect(self, code: int) -> None:
        # Balance the active-connections gauge: decrement only if this socket was
        # actually counted at accept (early-rejected connects never were) (#1900).
        if self._ws_counted:
            metrics.record_ws_connection_closed()
            self._ws_counted = False

        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

        if hasattr(self, "_user"):
            await self._presence_leave()

        # Close the single Redis client opened for this socket's presence calls.
        # Each open client owns a connection pool; leaving it open on disconnect
        # leaks connections against Valkey/fd limits (#1530). Guarded because
        # disconnect can fire before connect ever created a client (early close).
        client = getattr(self, "_redis", None)
        if client is not None:
            await client.aclose()
            self._redis = None

    async def receive_json(self, content: Any, **kwargs: Any) -> None:
        # Heartbeat: client messages refresh the presence TTL so the user is
        # not evicted while the socket is open but idle.
        if hasattr(self, "_user"):
            await self._presence_heartbeat()

    async def board_event(self, event: dict[str, Any]) -> None:
        """Handle channel layer group_send messages of type 'board.event'.

        A board.event can be dispatched to this channel *after* its socket has
        already closed: the client disconnects (or is evicted, code 4003) while
        a group_send for the same project is still in flight. The channel is not
        removed from the group until ``disconnect`` runs ``group_discard``, and
        messages already queued are still delivered — and ``await_many_dispatch``
        does not guarantee the ``websocket.disconnect`` is dispatched before an
        already-queued ``board.event``, so a closed-state flag cannot fully
        prevent the race. Sending on a closed socket raises ``RuntimeError`` from
        the ASGI server, so guard the send and drop the stale event. Losing it is
        safe: the broadcast is best-effort by design and clients reconcile via
        the sync delta on reconnect (see ``broadcast.py``). (#1108)
        """
        try:
            from trueppm_api.apps.sync.broadcast import WS_PROTOCOL_VERSION

            await self.send_json(
                {
                    "protocol_version": event.get("protocol_version", WS_PROTOCOL_VERSION),
                    "event_type": event.get("event_type"),
                    "payload": event.get("payload"),
                    # Replay sequence for persisted events, or None for ephemeral
                    # ones (presence / task-run progress). The client advances its
                    # last-seen ``seq`` off this and requests ``?since=`` on
                    # reconnect (ADR-0236).
                    "seq": event.get("seq"),
                }
            )
        except RuntimeError:
            logger.debug(
                "Dropped board.event for closed socket on project %s",
                getattr(self, "project_pk", "?"),
            )

    async def _replay_missed_events(self, since: int) -> None:
        """Stream buffered BoardEvents with ``seq > since``, or signal a resync.

        Gap detection (ADR-0236): the purge deletes a contiguous low-``id`` prefix
        (``created_at`` is monotonic with ``id`` at 24 h granularity), so the
        smallest surviving global ``id`` is a valid watermark. If the first event
        the client wants (``since + 1``) is older than that watermark — i.e.
        ``since < oldest - 1`` — some missed events were purged and completeness
        can't be guaranteed, so we send a single ``resync_required`` frame (the
        client refetches) rather than a partial replay. The same fallback fires
        when the client is further behind than ``_REPLAY_CAP`` (cheaper to refetch
        than to stream).
        """
        from channels.db import database_sync_to_async

        from trueppm_api.apps.sync.broadcast import WS_PROTOCOL_VERSION

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _fetch() -> tuple[list[dict[str, Any]], int | None, int | None]:
            from trueppm_api.apps.sync.models import BoardEvent

            # oldest is GLOBAL by design: gap detection relies on the purge
            # trimming a contiguous global low-id prefix, so the smallest surviving
            # id across all projects is the valid retention watermark. latest, by
            # contrast, is scoped to THIS project — it only baselines the client's
            # cursor after a resync, and a global max would leak the instance-wide
            # event-counter (cross-tenant activity volume) to any single member.
            oldest = BoardEvent.objects.order_by("id").values_list("id", flat=True).first()
            latest = (
                BoardEvent.objects.filter(project_id=self.project_pk)
                .order_by("-id")
                .values_list("id", flat=True)
                .first()
            )
            # Fetch one past the cap so we can detect truncation cheaply.
            rows = cast(
                "list[dict[str, Any]]",
                list(
                    BoardEvent.objects.filter(project_id=self.project_pk, id__gt=since)
                    .order_by("id")
                    .values("id", "event_type", "payload")[: _REPLAY_CAP + 1]
                ),
            )
            return rows, oldest, latest

        rows, oldest, latest = await _fetch()

        purged_gap = oldest is None or since < oldest - 1
        truncated = len(rows) > _REPLAY_CAP
        if purged_gap or truncated:
            await self.send_json(
                {
                    "protocol_version": WS_PROTOCOL_VERSION,
                    "event_type": "resync_required",
                    # latest_seq lets the client baseline its last-seen sequence to
                    # the buffer head after it refetches, so the next reconnect
                    # doesn't re-request the purged gap.
                    "payload": {"latest_seq": latest},
                    "seq": None,
                }
            )
            return

        for row in rows:
            await self.send_json(
                {
                    "protocol_version": WS_PROTOCOL_VERSION,
                    "event_type": row["event_type"],
                    "payload": row["payload"],
                    "seq": row["id"],
                    "replayed": True,
                }
            )

    async def connection_evict(self, event: dict[str, Any]) -> None:
        """Close this socket if its user's project access was just revoked (#813).

        Handles channel-layer messages of type 'connection.evict'. Membership is
        only checked at connect; this evicts a live socket when the user's
        ProjectMembership is soft-deleted or demoted below Member, so revocation
        takes effect immediately instead of lasting until the client disconnects.
        Sockets for other users in the group ignore the message.
        """
        if hasattr(self, "_user") and event.get("user_id") == str(self._user.pk):
            await self.close(code=4003)

    # ------------------------------------------------------------------
    # Presence helpers
    # ------------------------------------------------------------------

    async def _presence_join(self) -> None:
        """Add this user to the Redis presence hash and broadcast presence_join."""
        r = await self._get_redis()
        key = _presence_key(self.project_pk)
        entry = json.dumps({"user_id": str(self._user.pk), "display_name": self._display_name})
        await r.hset(key, str(self._user.pk), entry)
        await r.expire(key, _PRESENCE_TTL)

        # Async-native broadcast: we are on the consumer's event loop, so the
        # sync broadcast_board_event (which wraps group_send in async_to_sync)
        # would raise "cannot use AsyncToSync in the same thread" here (#958).
        from trueppm_api.apps.sync.broadcast import abroadcast_board_event

        await abroadcast_board_event(
            project_id=self.project_pk,
            event_type="presence_join",
            payload={"user_id": str(self._user.pk), "display_name": self._display_name},
        )

    async def _presence_leave(self) -> None:
        """Remove this user from the Redis presence hash and broadcast presence_leave."""
        r = await self._get_redis()
        key = _presence_key(self.project_pk)
        await r.hdel(key, str(self._user.pk))

        # Async-native broadcast — see _presence_join for why the sync helper
        # cannot be used from the consumer's event loop (#958).
        from trueppm_api.apps.sync.broadcast import abroadcast_board_event

        await abroadcast_board_event(
            project_id=self.project_pk,
            event_type="presence_leave",
            payload={"user_id": str(self._user.pk), "display_name": self._display_name},
        )

    async def _presence_heartbeat(self) -> None:
        """Refresh the presence TTL so an active user is not evicted."""
        r = await self._get_redis()
        await r.expire(_presence_key(self.project_pk), _PRESENCE_TTL)

    async def _get_redis(self) -> Any:
        """Return this consumer's async Redis client, creating it once and caching it.

        One client (and its connection pool) is created lazily on the socket's
        first presence call — which happens during ``websocket_connect`` — and
        reused for every subsequent presence call (join, leave, and each
        heartbeat frame) for the socket's lifetime, then closed in
        ``disconnect``. The presence path previously built a fresh
        ``aioredis.from_url`` client on *every* call: because ``receive_json``
        heartbeats fire on every inbound frame and nothing ever closed them, the
        Channels worker steadily leaked a connection pool per message until
        Valkey/fd limits were hit (#1530). Caching the client here bounds it to
        one pool per socket, matching the explicit close pattern in ``ws_auth``.
        """
        client = getattr(self, "_redis", None)
        if client is None:
            import redis.asyncio as aioredis
            from django.conf import settings

            client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
            self._redis = client
        return client

    # ------------------------------------------------------------------
    # Private helpers (run in thread pool via sync_to_async internally)
    # ------------------------------------------------------------------

    async def _get_role(self, user: Any, project_pk: str) -> int | None:
        """Return the user's role ordinal on the project, or None if not a member."""
        from channels.db import database_sync_to_async

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _query(u: Any, pk: str) -> int | None:
            from trueppm_api.apps.access.models import ProjectMembership

            try:
                return ProjectMembership.objects.get(project_id=pk, user=u, is_deleted=False).role
            except ProjectMembership.DoesNotExist:
                return None

        return await _query(user, project_pk)  # type: ignore[no-any-return]
