"""WebSocket consumer for workshop session events (cursor + edit broadcast)."""

from __future__ import annotations

import json
import logging
from typing import Any, cast

import redis
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.sync.broadcast import WS_PROTOCOL_VERSION
from trueppm_api.apps.sync.ws_auth import authenticate_scope, warn_if_legacy

logger = logging.getLogger(__name__)

# Module-level Redis connection pool for the relay rate limit. Mirrors
# ``sync.throttles``: a single pool against the throttle-counter DB (/2) with
# decode_responses, lazily initialized. The previous code opened a fresh
# ``redis.Redis.from_url(...)`` on EVERY frame, leaking a connection per cursor
# move (#perf); pooling reuses connections across frames.
_pool: redis.ConnectionPool | None = None


def _client() -> redis.Redis:
    global _pool
    if _pool is None:
        _pool = redis.ConnectionPool.from_url(
            f"{settings.REDIS_URL}/2",  # /2 is reserved for throttle counters
            decode_responses=True,
        )
    return redis.Redis(connection_pool=_pool)


# Hardening for receive_json (#895). The relay fans every accepted frame out to
# all session participants, so an unbounded / unauthenticated-shape payload is a
# DoS amplifier. These three limits bound it:
#
#  * MAX_FRAME_BYTES — reject frames whose JSON serialization exceeds this, so a
#    single client cannot push a multi-megabyte blob to every participant.
#  * RELAY_RATE_LIMIT / _WINDOW — per-user message-rate cap (cursor moves are
#    chatty but bounded; a runaway client looping group_send is not).
#  * ALLOWED_EVENT_TYPES — allowlist of known top-level event types. The relay
#    was previously type-agnostic ("relay anything"); an allowlist means a
#    crafted frame with an unknown type is dropped, not amplified.
MAX_FRAME_BYTES = 4096

# Pre-parse raw-text ceiling (#895). Rejected in ``receive`` BEFORE JSON parsing
# so a single oversize frame is never fully parsed/allocated. Set slightly above
# MAX_FRAME_BYTES because the raw wire text (with whitespace/escapes) can be
# marginally larger than the re-serialized ``json.dumps(content)`` the post-parse
# cap measures; the tighter post-parse cap still applies to accepted frames.
MAX_RAW_FRAME_BYTES = 8192

RELAY_RATE_LIMIT = 60  # frames per window, per (project, user)
RELAY_RATE_WINDOW = 1  # second

# Top-level "type" values the workshop relay forwards. Unknown types are dropped.
# Mirrors the documented client surface (cursor moves, phase/task collaboration).
ALLOWED_EVENT_TYPES = frozenset(
    {
        "cursor_move",
        "cursor",
        "phase_rename",
        "phase_add",
        "phase_move",
        "task_add",
        "task_move",
    }
)


class WorkshopConsumer(AsyncJsonWebsocketConsumer):  # type: ignore[misc]
    """Relays workshop cursor and edit events to all session participants.

    Authentication:  Single-use `?ticket=<id>` (ADR-0141); the deprecated
                     `?token=` fallback is off by default, opt-in via
                     `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED` (#1723). See
                     `sync.ws_auth`.
    Authorization:   User must hold at least Member role on the project AND an
                     active WorkshopSession must exist.  Rejects with 4004 if
                     no session is active (prevents ghost connections lingering
                     after a session ends).

    Receive:         A JSON message from the client is stamped with
                     user_id/display_name and broadcast to the group, excluding
                     the sender. Frames are validated before fan-out (#895): the
                     top-level ``type`` must be in ``ALLOWED_EVENT_TYPES``
                     (cursor_move, phase_rename, task_add, phase_add, …), the
                     serialized frame must be ≤ ``MAX_FRAME_BYTES``, and the user
                     must be under the per-window relay rate limit. Frames
                     failing any check are dropped.

    Participants:    On connect, a WorkshopParticipant row is created (or fetched
                     if already present from a prior reconnect).  On disconnect,
                     the row's left_at is set to now.
    """

    async def websocket_connect(self, message: dict[str, Any]) -> None:
        scope = self.scope
        # Single-use ?ticket= (ADR-0141); the deprecated ?token= fallback is off
        # by default, opt-in via TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED (#1723).
        auth = await authenticate_scope(scope)
        if auth.user is None:
            await self.close(code=4001)
            return
        user = auth.user

        project_pk = str(scope["url_route"]["kwargs"]["pk"])
        warn_if_legacy(auth, consumer="WorkshopConsumer", project_pk=project_pk)
        # Symbolic comparison so the gate stays correct under ADR-0072 role-ordinal re-spacing.
        role = await self._get_role(user, project_pk)
        if role is None or role < Role.MEMBER:
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

    async def receive(self, text_data: str | None = None, bytes_data: bytes | None = None) -> None:
        """Reject oversize frames before they are parsed/allocated (#895).

        Channels' ``AsyncJsonWebsocketConsumer.receive`` parses ``text_data`` as
        JSON before ``receive_json`` ever runs, so the post-parse size cap fires
        only AFTER a multi-megabyte blob has been decoded into Python objects. We
        short-circuit here on the raw text length so a single oversize frame is
        dropped without paying the parse/allocation cost. Legitimate small frames
        (cursor moves, edits) are well under the ceiling and pass straight
        through to the inherited JSON handling.
        """
        if text_data is not None and len(text_data) > MAX_RAW_FRAME_BYTES:
            logger.warning("workshop relay: dropping oversize raw frame (pre-parse)")
            return
        await super().receive(text_data=text_data, bytes_data=bytes_data)

    async def receive_json(self, content: Any, **kwargs: Any) -> None:
        """Relay a client message to the workshop group, excluding the sender.

        Hardened against DoS amplification (#895): every accepted frame is fanned
        out to all participants, so before relaying we (1) require an object with
        an allowlisted top-level ``type``, (2) cap the serialized size, and
        (3) rate-limit per user. A frame failing any check is dropped silently —
        the relay is best-effort, so dropping is the safe failure mode and avoids
        handing an attacker a feedback signal.
        """
        if not hasattr(self, "_user"):
            return

        # (c) Allowlist: drop frames that aren't a dict with a known event type.
        # The relay was previously type-agnostic; an unknown/forged type is now
        # rejected rather than amplified to every participant.
        if not isinstance(content, dict):
            return
        event_type = content.get("type")
        if event_type not in ALLOWED_EVENT_TYPES:
            logger.debug("workshop relay: dropping frame with unknown type %r", event_type)
            return

        # (a) Size cap: reject oversized frames before fan-out.
        if len(json.dumps(content)) > MAX_FRAME_BYTES:
            logger.warning("workshop relay: dropping oversize frame from user %s", self._user.pk)
            return

        # (b) Rate limit: bound per-user message frequency.
        if not await self._allow_relay():
            logger.warning("workshop relay: rate limit exceeded for user %s", self._user.pk)
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

    async def _allow_relay(self) -> bool:
        """Return True if this user is under the per-window relay rate limit.

        Mirrors ``sync.throttles``/``projects.throttles``: an INCR on a per-
        (project, user) bucket key in the throttle-counter Redis DB with a short
        TTL window. Fails **open** on any Redis error so a cache outage can never
        wedge live collaboration — the size cap and allowlist still apply.
        """
        from channels.db import database_sync_to_async

        project_pk = self.project_pk
        user_pk = str(self._user.pk)

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _check() -> bool:
            bucket_key = f"rate:workshop_relay:{project_pk}:{user_pk}"
            try:
                client = _client()  # pooled — no per-frame connection (#perf)
                count = int(cast(int, client.incr(bucket_key)))
                if count == 1:
                    client.expire(bucket_key, RELAY_RATE_WINDOW)
            except redis.RedisError:
                logger.exception("workshop relay rate limit: Redis error, failing open")
                return True
            return count <= RELAY_RATE_LIMIT

        return await _check()  # type: ignore[no-any-return]

    async def workshop_event(self, event: dict[str, Any]) -> None:
        """Handle channel layer messages of type 'workshop.event'.

        Stamps ``protocol_version`` onto every outgoing workshop frame here — the
        single chokepoint for both shapes this channel carries: relayed client
        frames (``receive_json`` → flat ``{type, user_id, …}``) and server-pushed
        events (``broadcast_workshop_event`` → ``{event_type, payload}``). The
        workshop channel was previously unversioned and dual-shaped; sharing
        ``sync.broadcast.WS_PROTOCOL_VERSION`` means a client can branch on the
        same wire version it reads off ``board.event`` (#1355, #1325). A copy is
        sent so the shared channel-layer ``event`` dict is never mutated.
        """
        if event.get("sender") == self.channel_name:
            return
        content = {**event["content"], "protocol_version": WS_PROTOCOL_VERSION}
        await self.send_json(content)

    async def connection_evict(self, event: dict[str, Any]) -> None:
        """Close this workshop socket if the user's project access was revoked (#813).

        Mirrors ProjectConsumer.connection_evict: workshop access gates on the same
        ProjectMembership, so a soft-delete / demotion below Member must drop the
        live workshop socket too, not just the board socket.
        """
        if hasattr(self, "_user") and event.get("user_id") == str(self._user.pk):
            await self.close(code=4003)

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
    # Auth helpers (mirrors ProjectConsumer; ticket/token auth in ws_auth.py)
    # ------------------------------------------------------------------

    async def _get_role(self, user: Any, project_pk: str) -> int | None:
        from channels.db import database_sync_to_async

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _query(u: Any, pk: str) -> int | None:
            from trueppm_api.apps.access.models import ProjectMembership

            try:
                return ProjectMembership.objects.get(project_id=pk, user=u, is_deleted=False).role
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
