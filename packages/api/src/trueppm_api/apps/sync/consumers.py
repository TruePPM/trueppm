"""WebSocket consumer for real-time project board events."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sys
from typing import Any, cast

from channels.generic.websocket import AsyncJsonWebsocketConsumer

from trueppm_api.apps.access.permissions import role_can_subscribe_live
from trueppm_api.apps.observability.otel import metrics
from trueppm_api.apps.sync.ws_auth import authenticate_scope, warn_if_legacy

logger = logging.getLogger(__name__)

_PRESENCE_TTL = 60  # seconds — refreshed by the per-socket keepalive below

# How often each open socket re-arms the presence TTL (#2607).
#
# The TTL was originally refreshed only from ``receive_json`` — a heartbeat no
# client sends. The web client's project socket is receive-only, so in practice
# nothing ever refreshed it and the roster emptied about a minute
# into every session while everyone was still connected and editing.
#
# Refreshing on *traffic* would not fix it either: a quiet project generates no
# frames, and presence means "this person is here", not "this person is busy".
# So each socket re-arms its own TTL on a timer for as long as it is open, which
# needs no client change and therefore covers mobile and any future client for
# free. The TTL keeps doing the job it is actually good at — reaping a socket
# that died without ``disconnect`` running (worker kill, network partition).
#
# Half the TTL: one missed tick (a slow event loop, a brief Redis blip) still
# leaves a full interval of margin before anyone is wrongly reaped.
_PRESENCE_REFRESH_INTERVAL = _PRESENCE_TTL // 2

# Upper bound on events replayed on a single reconnect (ADR-0236). A client
# further behind than this is cheaper to fully refetch than to stream, so it gets
# a ``resync_required`` frame instead — matching the "since older than retention"
# fallback.
_REPLAY_CAP = 1000

# Close codes (#4375). Which side of the handshake a refusal happens on decides
# whether a browser can ever see the code:
#
# - Before ``accept``, the ASGI server (uvicorn in production) answers the HTTP
#   upgrade with a 403 instead of switching protocols, and a browser reports close
#   code **1006** with no application code at all. The client cannot
#   tell "you may not" from "the network dropped", so it retries forever.
# - After ``accept``, the close frame carries the code and the browser's
#   ``CloseEvent.code`` is the value sent here.
#
# So every *policy* refusal a legitimate client must act on is post-accept:
#
# - ``WS_CLOSE_UNAUTHENTICATED`` (4001): no valid ticket. Accepting first reveals
#   nothing — the check runs before the project id is even read.
# - ``WS_CLOSE_FORBIDDEN`` (4003): not a member, a soft-deleted member, a role
#   below the live-update floor, or a project that does not exist. All four send
#   the same code from the same point, so the code is not an existence oracle;
#   also sent by ``connection_evict`` on a live socket.
#
# The one pre-accept rejection is the router catch-all in ``asgi.py`` (4404, an
# unrouted path). No client the product ships connects to one, there is nothing
# for a browser to act on, and refusing at the upgrade keeps scanners off the
# accept path. Its code never reaches a browser, by design.
WS_CLOSE_UNAUTHENTICATED = 4001
WS_CLOSE_FORBIDDEN = 4003


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
                     refused (4001) if no valid credential is present.

    Authorization:   The user must clear ``role_can_subscribe_live`` (Member+) on
                     the requested project; anyone else is refused (4003). The
                     project serializer's ``can_subscribe_live`` emits the same
                     verdict so the web client does not dial a socket it will be
                     refused (#4375).

    Refusals:        Accepted first, then closed with the code, so a browser's
                     ``CloseEvent`` carries it — see the module-level close-code
                     notes. A pre-accept close surfaces as 1006 in a browser.

    Presence:        On connect, the user is added to a Redis hash keyed by
                     `project:{pk}:presence`.  A `presence_join` event is
                     broadcast to the group.  On disconnect, the entry is
                     removed and a `presence_leave` event is broadcast.
                     The hash expires after _PRESENCE_TTL seconds and is re-armed
                     every _PRESENCE_REFRESH_INTERVAL by a per-socket keepalive
                     task, so the roster reflects who is connected rather than
                     who is generating traffic (#2607). The TTL remains the
                     backstop for a socket that dies without `disconnect`.

    Receive:         Client→server messages also reset the presence TTL, but no
                     client sends any — the keepalive above is what keeps the
                     roster alive.  All content is silently discarded.

    Not here:        There are **no row-level or per-field locks**, and there will
                     not be — ADR-0914 (#2721) is the decision, not an omission.
                     Presence answers "who is here"; it does not answer "who is
                     busy", and it never answers "who may write".

                     The reason is not cost. A soft lock expires on inactivity and
                     on disconnect and never gates the write, so it cannot prevent
                     the conflict it appears to prevent, and every one of its
                     failure modes is silent in the reassuring direction: a ring
                     missing while someone is still typing implies a safety nobody
                     held, and a ring left on an idle row makes a planner wait for
                     a hold that does not exist. What actually protects the data is
                     ``server_version`` optimistic locking returning 409.

    Coming here:     Row *edit-awareness* is accepted, and it is not a lock.
                     ADR-0914 adopts ADR-0046 §1's advisory
                     ``state: editing | idle`` broadcast for the Schedule outline:
                     it renders who is typing where, it never gates a write, and
                     its copy never claims exclusivity. Staleness is therefore
                     cheap — it misleads about a fact rather than about permission,
                     which is the distinction the whole decision turns on.

                     It is not implemented yet, and implementing it makes this
                     consumer **bidirectional** — every open project socket becomes
                     a Redis write path for any Member. ADR-0914 §6 binds the
                     constraints that has to carry: the row id must be validated as
                     belonging to *this* project (otherwise the socket becomes the
                     cross-project existence oracle ADR-0772 removed), the frame
                     rate must be bounded, the payload fixed and size-bounded, and
                     nothing persisted. Do not add the frame handler without them.
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
            await self._refuse(WS_CLOSE_UNAUTHENTICATED)
            return
        user = auth.user

        # Resolve project PK from URL route kwargs.
        project_pk = str(scope["url_route"]["kwargs"]["pk"])
        warn_if_legacy(auth, consumer="ProjectConsumer", project_pk=project_pk)

        # Live-update floor (Member+; Viewers and non-members are refused). The
        # predicate is shared with ProjectSerializer.can_subscribe_live so the client
        # gate and this one cannot drift (#4375).
        role = await self._get_role(user, project_pk)
        if not role_can_subscribe_live(role):
            await self._refuse(WS_CLOSE_FORBIDDEN)
            return

        self.project_pk = project_pk
        self.group_name = f"project_{project_pk}"
        self._user = user
        self._display_name: str = user.get_full_name() or user.username

        await self.channel_layer.group_add(self.group_name, self.channel_name)

        # Register presence in Redis and notify other clients.
        await self._presence_join()

        # Keep this socket's presence alive for as long as it is open (#2607).
        # Started before accept so a socket that never sees a single frame is
        # still represented in the roster.
        self._presence_task: asyncio.Task[None] | None = asyncio.create_task(
            self._presence_keepalive()
        )

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

        # Stop the keepalive before releasing presence, so a tick in flight cannot
        # re-arm the TTL on a key the leave below is about to clean up.
        task = getattr(self, "_presence_task", None)
        if task is not None:
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
            self._presence_task = None

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
            from trueppm_api.apps.sync.broadcast import SEQ_SCOPE_PROJECT, WS_PROTOCOL_VERSION

            # Forward a seq only when the sender marked it as the per-project
            # sequence (ADR-1285, #4386). A pre-#4386 pod in a rolling update sends
            # its global row id unmarked; adopting that as a cursor would put the
            # client in the wrong number space, so it goes out as an unsequenced
            # frame instead — applied, never gated.
            seq = event.get("seq") if event.get("seq_scope") == SEQ_SCOPE_PROJECT else None
            await self.send_json(
                {
                    "protocol_version": event.get("protocol_version", WS_PROTOCOL_VERSION),
                    "event_type": event.get("event_type"),
                    "payload": event.get("payload"),
                    # Replay sequence for persisted events, or None for ephemeral
                    # ones (presence / task-run progress). The client advances its
                    # last-seen ``seq`` off this and requests ``?since=`` on
                    # reconnect (ADR-0236).
                    "seq": seq,
                }
            )
        except RuntimeError:
            logger.debug(
                "Dropped board.event for closed socket on project %s",
                getattr(self, "project_pk", "?"),
            )

    async def _replay_missed_events(self, since: int) -> None:
        """Stream buffered BoardEvents with ``seq > since``, or signal a resync.

        ``seq`` is dense per project (ADR-1285, #4386), so completeness is a count,
        not a guess: the project's counter value is the head, the client is owed
        exactly ``head - since`` events, and a replay is sent only when exactly that
        many rows survive. Anything else gets one ``resync_required`` frame and the
        client refetches:

        - ``since > head`` — a cursor the project's sequence never reached. One
          example is a global id an old pod issued during the #4386 rolling update
          for a project created in that window, whose counter starts at 0.
          ``latest_seq`` re-baselines it.
        - A global-id cursor from before or during the #4386 upgrade, for a project
          that existed at the upgrade, is below the project's seed
          (``seed_board_event_sequences``, offset by
          ``BOARD_EVENT_SEQ_UPGRADE_OFFSET``). It is owed more events than carry a
          ``seq``, so it falls into the "fewer rows than owed" case below and
          resyncs.
        - ``head - since > _REPLAY_CAP`` — cheaper to refetch than to stream.
        - fewer rows than owed — the purge reaped part of the gap.

        ``since == head`` replays nothing and needs no resync. The row query is
        bounded above by the head it was counted against, so an event committed
        between the two reads cannot inflate the count; it reaches the client live,
        because the socket joined the group before this ran.

        Every value read here is scoped to this project. The old global-id design
        had to read a *global* minimum id to detect purge gaps; the density check
        needs nothing outside the project, so no instance-wide figure reaches a
        member.
        """
        from channels.db import database_sync_to_async

        from trueppm_api.apps.sync.broadcast import WS_PROTOCOL_VERSION

        @database_sync_to_async  # type: ignore[untyped-decorator]
        def _fetch() -> tuple[list[dict[str, Any]], int]:
            from trueppm_api.apps.sync.models import BoardEvent, BoardEventSequence

            head = (
                BoardEventSequence.objects.filter(project_id=self.project_pk)
                .values_list("value", flat=True)
                .first()
            ) or 0
            owed = head - since
            if owed <= 0 or owed > _REPLAY_CAP:
                return [], head
            rows = cast(
                "list[dict[str, Any]]",
                list(
                    BoardEvent.objects.filter(
                        project_id=self.project_pk, seq__gt=since, seq__lte=head
                    )
                    .order_by("seq")
                    .values("seq", "event_type", "payload")
                ),
            )
            return rows, head

        rows, head = await _fetch()
        owed = head - since
        if owed == 0:
            return
        if owed < 0 or len(rows) != owed:
            await self.send_json(
                {
                    "protocol_version": WS_PROTOCOL_VERSION,
                    "event_type": "resync_required",
                    # latest_seq lets the client baseline its last-seen sequence to
                    # the buffer head after it refetches, so the next reconnect
                    # doesn't re-request the purged gap.
                    "payload": {"latest_seq": head},
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
                    "seq": row["seq"],
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

        ``all=True`` (``evict_project_group``, #4577) closes every socket in the group:
        the project itself was trashed, so no member keeps a role on it.
        """
        if event.get("all") is True:
            await self.close(code=WS_CLOSE_FORBIDDEN)
            return
        if hasattr(self, "_user") and event.get("user_id") == str(self._user.pk):
            await self.close(code=WS_CLOSE_FORBIDDEN)

    async def _refuse(self, code: int) -> None:
        """Refuse a connect so the browser actually receives ``code`` (#4375).

        Accept, then close. Closing before accept makes the ASGI server (uvicorn)
        answer the HTTP upgrade with a 403, which a browser reports as code 1006 — so the
        client could never recognize 4001 or 4003 as terminal and kept reconnecting.
        Nothing has been joined or counted at this point (no group, no presence, no
        gauge increment), so ``disconnect`` is a no-op for a refused socket.
        """
        await self.accept()
        await self.close(code=code)

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

    async def _presence_keepalive(self) -> None:
        """Re-arm the presence TTL every interval for as long as this socket is open.

        Started at connect and cancelled at disconnect, so presence tracks socket
        lifetime rather than traffic (#2607) — an idle project's roster is as
        correct as a busy one's.

        Never allowed to kill the socket. A Redis blip here means one skipped
        refresh, and the next tick re-arms a TTL that has not yet expired; letting
        the exception escape would tear down a working connection over a
        supporting affordance. ``CancelledError`` is re-raised so ``disconnect``'s
        await returns promptly rather than swallowing its own cancellation.
        """
        while True:
            try:
                await asyncio.sleep(_PRESENCE_REFRESH_INTERVAL)
                await self._presence_heartbeat()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning(
                    "presence keepalive refresh failed for project %s",
                    getattr(self, "project_pk", "?"),
                    exc_info=True,
                )

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
            from trueppm_api.core import valkey

            client = valkey.async_client(valkey.DB_CELERY, decode_responses=True)
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
                # project__is_deleted (#4577): a trashed project confers no role, so
                # a socket cannot subscribe to one — same floor as `_membership_role`.
                return ProjectMembership.objects.get(
                    project_id=pk, user=u, is_deleted=False, project__is_deleted=False
                ).role
            except ProjectMembership.DoesNotExist:
                return None

        return await _query(user, project_pk)  # type: ignore[no-any-return]
