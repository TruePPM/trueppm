"""WebSocket consumer for real-time project board events."""

from __future__ import annotations

import json
import logging
from typing import Any

from channels.generic.websocket import AsyncJsonWebsocketConsumer

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.sync.ws_auth import authenticate_scope, warn_if_legacy

logger = logging.getLogger(__name__)

_PRESENCE_TTL = 60  # seconds — refreshed on every received message (heartbeat)


def _presence_key(project_pk: str) -> str:
    return f"project:{project_pk}:presence"


class ProjectConsumer(AsyncJsonWebsocketConsumer):  # type: ignore[misc]
    """Pushes project board events to subscribed clients.

    Authentication:  A single-use ticket supplied as `?ticket=<id>` (ADR-0141),
                     issued by `POST /api/v1/ws/ticket/` and consumed from Redis
                     on connect. The legacy `?token=<jwt>` query param still works
                     for one release (logged as deprecated). Connection is
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

    async def websocket_connect(self, message: dict[str, Any]) -> None:
        """Override to run sync DB queries before accepting the socket."""
        # Authenticate the handshake before calling super() which sends ACCEPT.
        # Prefers the single-use ?ticket= (ADR-0141); ?token=<jwt> still works for
        # one release as a logged, deprecated fallback.
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

    async def disconnect(self, code: int) -> None:
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

        if hasattr(self, "_user"):
            await self._presence_leave()

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
                }
            )
        except RuntimeError:
            logger.debug(
                "Dropped board.event for closed socket on project %s",
                getattr(self, "project_pk", "?"),
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

    @staticmethod
    async def _get_redis() -> Any:
        """Return an async Redis client pointed at the configured REDIS_URL."""
        import redis.asyncio as aioredis
        from django.conf import settings

        return aioredis.from_url(settings.REDIS_URL, decode_responses=True)

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
