"""WebSocket consumer for workshop session events (cursor + edit broadcast)."""

from __future__ import annotations

import logging
from typing import Any

from channels.generic.websocket import AsyncJsonWebsocketConsumer

logger = logging.getLogger(__name__)


class WorkshopConsumer(AsyncJsonWebsocketConsumer):  # type: ignore[misc]
    """Relays workshop cursor and edit events to all session participants.

    Authentication:  JWT access token supplied as `?token=<token>` query param.
    Authorization:   User must hold at least Member role on the project AND an
                     active WorkshopSession must exist.  Rejects with 4004 if
                     no session is active (prevents ghost connections lingering
                     after a session ends).

    Receive:         Any JSON message from the client is stamped with
                     user_id/display_name and broadcast to the group, excluding
                     the sender.  Message types: cursor, phase_rename, task_add,
                     phase_add — the consumer is type-agnostic.

    Participants:    On connect, a WorkshopParticipant row is created (or fetched
                     if already present from a prior reconnect).  On disconnect,
                     the row's left_at is set to now.
    """

    async def websocket_connect(self, message: dict[str, Any]) -> None:
        scope = self.scope
        query_string: bytes = scope.get("query_string", b"")
        params = dict(pair.split(b"=", 1) for pair in query_string.split(b"&") if b"=" in pair)
        token_bytes = params.get(b"token")
        if not token_bytes:
            await self.close(code=4001)
            return

        token = token_bytes.decode("utf-8")
        user = await self._authenticate(token)
        if user is None:
            await self.close(code=4001)
            return

        project_pk = str(scope["url_route"]["kwargs"]["pk"])
        role = await self._get_role(user, project_pk)
        if role is None or role < 1:
            await self.close(code=4003)
            return

        session = await self._get_active_session(project_pk)
        if session is None:
            await self.close(code=4004)
            return

        self.project_pk = project_pk
        self.group_name = f"project_{project_pk}_workshop"
        self._user = user
        self._display_name: str = user.get_full_name() or user.username
        self._session_pk = session.pk

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self._participant_join(session)
        await super().websocket_connect(message)

    async def disconnect(self, code: int) -> None:
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)
        if hasattr(self, "_user") and hasattr(self, "_session_pk"):
            await self._participant_leave()

    async def receive_json(self, content: Any, **kwargs: Any) -> None:
        """Relay client messages to the entire workshop group, excluding the sender."""
        if not hasattr(self, "_user"):
            return
        # Overwrite rather than setdefault — prevents clients from spoofing
        # another user's identity by supplying their own user_id/display_name.
        content["user_id"] = str(self._user.pk)
        content["display_name"] = self._display_name
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "workshop.event",
                "content": content,
                "sender": self.channel_name,
            },
        )

    async def workshop_event(self, event: dict[str, Any]) -> None:
        """Handle channel layer messages of type 'workshop.event'."""
        if event.get("sender") == self.channel_name:
            return
        await self.send_json(event["content"])

    # ------------------------------------------------------------------
    # Participant tracking
    # ------------------------------------------------------------------

    async def _participant_join(self, session: Any) -> None:
        from channels.db import database_sync_to_async
        from django.db import transaction

        from trueppm_api.apps.workshops.broadcast import broadcast_workshop_event

        project_pk = self.project_pk
        user_pk = str(self._user.pk)
        display_name = self._display_name

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _create(sess: Any) -> None:
            from trueppm_api.apps.workshops.models import WorkshopParticipant

            color = int(user_pk.replace("-", ""), 16) % 8
            participant, created = WorkshopParticipant.objects.get_or_create(
                session=sess,
                user=self._user,
                defaults={"color_index": color},
            )
            # Clear left_at on reconnect — get_or_create returns the existing
            # row without touching left_at, so a reconnecting user would stay
            # offline until the banner next polls.
            if not created and participant.left_at is not None:
                participant.left_at = None
                participant.save(update_fields=["left_at"])
            # Broadcast only after the participant row commits, preventing
            # clients from receiving a joined event for a non-existent row.
            transaction.on_commit(
                lambda: broadcast_workshop_event(
                    project_id=project_pk,
                    event_type="participant_joined",
                    payload={"user_id": user_pk, "display_name": display_name},
                )
            )

        await _create(session)

    async def _participant_leave(self) -> None:
        from channels.db import database_sync_to_async
        from django.db import transaction
        from django.utils import timezone

        from trueppm_api.apps.workshops.broadcast import broadcast_workshop_event

        project_pk = self.project_pk
        user_pk = str(self._user.pk)
        display_name = self._display_name

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _mark_left() -> None:
            from trueppm_api.apps.workshops.models import WorkshopParticipant

            WorkshopParticipant.objects.filter(
                session_id=self._session_pk,
                user=self._user,
                left_at__isnull=True,
            ).update(left_at=timezone.now())
            transaction.on_commit(
                lambda: broadcast_workshop_event(
                    project_id=project_pk,
                    event_type="participant_left",
                    payload={"user_id": user_pk, "display_name": display_name},
                )
            )

        await _mark_left()

    # ------------------------------------------------------------------
    # Auth helpers (mirrors ProjectConsumer)
    # ------------------------------------------------------------------

    async def _authenticate(self, token: str) -> Any:
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
        from channels.db import database_sync_to_async

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _query(u: Any, pk: str) -> int | None:
            from trueppm_api.apps.access.models import ProjectMembership

            try:
                return ProjectMembership.objects.get(project_id=pk, user=u).role
            except ProjectMembership.DoesNotExist:
                return None

        return await _query(user, project_pk)  # type: ignore[no-any-return]

    async def _get_active_session(self, project_pk: str) -> Any:
        from channels.db import database_sync_to_async

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _query(pk: str) -> Any:
            from trueppm_api.apps.workshops.models import WorkshopSession

            try:
                return WorkshopSession.objects.get(project_id=pk, ended_at__isnull=True)
            except WorkshopSession.DoesNotExist:
                return None

        return await _query(project_pk)
