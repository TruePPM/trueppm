"""WebSocket consumer for real-time project board events."""

from __future__ import annotations

import json
import logging
from typing import Any

from channels.generic.websocket import AsyncJsonWebsocketConsumer

logger = logging.getLogger(__name__)

_PRESENCE_TTL = 60  # seconds — refreshed on every received message (heartbeat)


def _presence_key(project_pk: str) -> str:
    return f"project:{project_pk}:presence"


class ProjectConsumer(AsyncJsonWebsocketConsumer):  # type: ignore[misc]
    """Pushes project board events to subscribed clients.

    Authentication:  JWT access token supplied as `?token=<token>` query param.
                     Token is validated on connect; connection is rejected if
                     the token is missing, invalid, or expired.

    Authorization:   The user must hold at least the Member role (ordinal ≥ 1)
                     on the requested project. Viewers (role=0) are rejected.

    Presence:        On connect, the user is added to a Redis hash keyed by
                     `project:{pk}:presence`.  A `presence.join` event is
                     broadcast to the group.  On disconnect, the entry is
                     removed and a `presence.leave` event is broadcast.
                     The hash expires after _PRESENCE_TTL seconds; each
                     received message (heartbeat) resets the expiry.

    Receive:         Client→server messages reset the presence TTL.  All other
                     content is silently discarded.
    """

    async def websocket_connect(self, message: dict[str, Any]) -> None:
        """Override to run sync DB queries before accepting the socket."""
        # Parse token and project_pk before calling super() which sends ACCEPT.
        scope = self.scope
        query_string: bytes = scope.get("query_string", b"")
        params = dict(pair.split(b"=", 1) for pair in query_string.split(b"&") if b"=" in pair)
        token_bytes = params.get(b"token")
        if not token_bytes:
            await self.close(code=4001)
            return

        token = token_bytes.decode("utf-8")

        # Validate JWT and resolve user.
        user = await self._authenticate(token)
        if user is None:
            await self.close(code=4001)
            return

        # Resolve project PK from URL route kwargs.
        project_pk = str(scope["url_route"]["kwargs"]["pk"])

        # Check membership ≥ Member (Viewers cannot connect).
        role = await self._get_role(user, project_pk)
        if role is None or role < 1:
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
        """Handle channel layer group_send messages of type 'board.event'."""
        await self.send_json(
            {
                "event_type": event.get("event_type"),
                "payload": event.get("payload"),
            }
        )

    # ------------------------------------------------------------------
    # Presence helpers
    # ------------------------------------------------------------------

    async def _presence_join(self) -> None:
        """Add this user to the Redis presence hash and broadcast presence.join."""
        r = await self._get_redis()
        key = _presence_key(self.project_pk)
        entry = json.dumps({"user_id": str(self._user.pk), "display_name": self._display_name})
        await r.hset(key, str(self._user.pk), entry)
        await r.expire(key, _PRESENCE_TTL)

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        broadcast_board_event(
            project_id=self.project_pk,
            event_type="presence.join",
            payload={"user_id": str(self._user.pk), "display_name": self._display_name},
        )

    async def _presence_leave(self) -> None:
        """Remove this user from the Redis presence hash and broadcast presence.leave."""
        r = await self._get_redis()
        key = _presence_key(self.project_pk)
        await r.hdel(key, str(self._user.pk))

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        broadcast_board_event(
            project_id=self.project_pk,
            event_type="presence.leave",
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

    async def _authenticate(self, token: str) -> Any:
        """Validate a JWT access token and return the user, or None on failure."""
        from channels.db import database_sync_to_async

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _validate(tok: str) -> Any:
            from django.contrib.auth import get_user_model
            from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
            from rest_framework_simplejwt.tokens import AccessToken

            User = get_user_model()
            try:
                access = AccessToken(tok)  # type: ignore[arg-type]
                user_id = access["user_id"]
                return User.objects.get(pk=user_id)
            except (TokenError, InvalidToken, User.DoesNotExist):
                return None

        return await _validate(token)

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
