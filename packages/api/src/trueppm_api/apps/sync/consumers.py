"""WebSocket consumer for real-time project board events."""

from __future__ import annotations

import logging
from typing import Any

from channels.generic.websocket import AsyncJsonWebsocketConsumer

logger = logging.getLogger(__name__)


class ProjectConsumer(AsyncJsonWebsocketConsumer):
    """Pushes project board events to subscribed clients.

    Authentication:  JWT access token supplied as `?token=<token>` query param.
                     Token is validated on connect; connection is rejected if
                     the token is missing, invalid, or expired.

    Authorization:   The user must hold at least the Member role (ordinal ≥ 1)
                     on the requested project. Viewers (role=0) are rejected.

    Receive:         v1 is push-only — no client→server messages are handled.
    """

    async def websocket_connect(self, message: dict[str, Any]) -> None:
        """Override to run sync DB queries before accepting the socket."""
        # Parse token and project_pk before calling super() which sends ACCEPT.
        scope = self.scope
        query_string: bytes = scope.get("query_string", b"")
        params = dict(
            pair.split(b"=", 1)
            for pair in query_string.split(b"&")
            if b"=" in pair
        )
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

        await self.channel_layer.group_add(self.group_name, self.channel_name)  # type: ignore[union-attr]
        await super().websocket_connect(message)

    async def disconnect(self, code: int) -> None:
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(  # type: ignore[union-attr]
                self.group_name, self.channel_name
            )

    async def receive_json(self, content: Any, **kwargs: Any) -> None:
        # v1: server-push only. Silently discard any client messages.
        pass

    async def board_event(self, event: dict[str, Any]) -> None:
        """Handle channel layer group_send messages of type 'board.event'."""
        await self.send_json(
            {
                "event_type": event.get("event_type"),
                "payload": event.get("payload"),
            }
        )

    # ------------------------------------------------------------------
    # Private helpers (run in thread pool via sync_to_async internally)
    # ------------------------------------------------------------------

    async def _authenticate(self, token: str) -> Any:
        """Validate a JWT access token and return the user, or None on failure."""
        from channels.db import database_sync_to_async

        @database_sync_to_async
        def _validate(tok: str) -> Any:
            from django.contrib.auth import get_user_model
            from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
            from rest_framework_simplejwt.tokens import AccessToken

            User = get_user_model()
            try:
                access = AccessToken(tok)
                user_id = access["user_id"]
                return User.objects.get(pk=user_id)
            except (TokenError, InvalidToken, User.DoesNotExist):
                return None

        return await _validate(token)

    async def _get_role(self, user: Any, project_pk: str) -> int | None:
        """Return the user's role ordinal on the project, or None if not a member."""
        from channels.db import database_sync_to_async

        @database_sync_to_async
        def _query(u: Any, pk: str) -> int | None:
            from trueppm_api.apps.access.models import ProjectMembership

            try:
                return ProjectMembership.objects.get(project_id=pk, user=u).role
            except ProjectMembership.DoesNotExist:
                return None

        return await _query(user, project_pk)
