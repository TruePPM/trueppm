"""Shared authentication for the WebSocket handshake (ADR-0141).

Browsers cannot set an ``Authorization`` header on the WebSocket upgrade, so the
credential has to ride in the URL. A raw JWT in the URL leaks into every access
log (#818); the fix is a short-lived, single-use **ticket** (RFC 6750 §2.3):

* :func:`issue_ticket` is called synchronously from the REST view that mints a
  ticket for an already-authenticated user. The ticket is opaque and stored in
  Redis with a 30-second TTL.
* :func:`consume_ticket` is called from the async consumer at connect time. It
  uses ``GETDEL`` so a ticket is valid exactly once — a ticket that later turns
  up in a log is already spent.
* :func:`authenticate_scope` is the single entry point both consumers use: it
  prefers ``?ticket=``. The **deprecated** ``?token=<jwt>`` fallback is now gated
  behind ``TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED`` (default off, #1723) — a raw JWT
  in the URL leaks into every access log, so the fallback is opt-in for one last
  release and removed next. When it is on and used, :func:`warn_if_legacy` logs it
  (never the value) so operators can find stragglers before removal.

The ticket carries authentication only. Each consumer still runs its own
membership/role authorization gate after resolving the user.

Redis is accessed directly via ``settings.REDIS_URL`` (sync client to write, the
``redis.asyncio`` client to read) rather than through Django's cache framework:
no ``CACHES`` backend is configured, so the default per-process ``LocMemCache``
would be invisible to the separate Channels worker that runs the consumer.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)

#: Single-use ticket lifetime. Generous for one REST round-trip before the
#: socket opens, short enough that a leaked (already-consumed) ticket is useless.
TICKET_TTL_SECONDS = 30

_TICKET_PREFIX = "ws:ticket:"


def _ticket_key(ticket: str) -> str:
    return f"{_TICKET_PREFIX}{ticket}"


def issue_ticket(user_id: str) -> str:
    """Mint and store a single-use WebSocket ticket for ``user_id`` (sync).

    Returns the opaque ticket string the client passes as ``?ticket=`` on the
    WebSocket URL. The value is unguessable (256 bits of entropy) and expires
    after :data:`TICKET_TTL_SECONDS`.
    """
    import redis

    ticket = secrets.token_urlsafe(32)
    client = redis.from_url(settings.REDIS_URL)
    try:
        client.set(_ticket_key(ticket), str(user_id), ex=TICKET_TTL_SECONDS)
    finally:
        client.close()
    return ticket


async def consume_ticket(ticket: str) -> str | None:
    """Atomically read-and-delete a ticket, returning its ``user_id`` or ``None``.

    ``GETDEL`` makes the ticket single-use: a concurrent or replayed consume sees
    ``None``. ``None`` is also returned for an expired or never-issued ticket.
    """
    import redis.asyncio as aioredis

    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        return await client.getdel(_ticket_key(ticket))  # type: ignore[no-any-return]
    finally:
        await client.aclose()


@dataclass
class WsAuthResult:
    """Outcome of authenticating a WebSocket scope.

    ``user`` is ``None`` when authentication failed (missing/invalid/spent
    credential). ``via`` records which path resolved it so the consumer can warn
    on the deprecated token path; it is ``None`` when no credential was supplied.
    """

    user: Any | None
    via: str | None  # "ticket" | "token" | None


def _parse_query(query_string: bytes) -> dict[bytes, bytes]:
    return dict(pair.split(b"=", 1) for pair in query_string.split(b"&") if b"=" in pair)


async def _resolve_active_user(user_id: str) -> Any | None:
    """Return the active user for ``user_id``, or ``None``.

    Mirrors the JWT path's ``is_active`` filter: a user deactivated inside the
    ticket's short lifetime must not connect.
    """
    from channels.db import database_sync_to_async

    @database_sync_to_async  # type: ignore[untyped-decorator]
    def _query(uid: str) -> Any | None:
        from django.contrib.auth import get_user_model

        User = get_user_model()
        try:
            return User.objects.get(pk=uid, is_active=True)
        except (User.DoesNotExist, ValueError, TypeError):
            return None

    return await _query(user_id)


async def authenticate_token(token: str) -> Any | None:
    """Validate a JWT access token and return the active user, or ``None``.

    The legacy ``?token=`` handshake path (deprecated by ADR-0141). Kept as a
    module function so both consumers share one implementation.
    """
    from channels.db import database_sync_to_async

    @database_sync_to_async  # type: ignore[untyped-decorator]
    def _validate(tok: str) -> Any | None:
        from django.contrib.auth import get_user_model
        from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
        from rest_framework_simplejwt.tokens import AccessToken

        User = get_user_model()
        try:
            access = AccessToken(tok)  # type: ignore[arg-type]
            # is_active filter (#888): a deactivated user may still hold a JWT
            # that has not yet expired; treat it as a failed resolve (4001),
            # mirroring DRF's JWTAuthentication.
            return User.objects.get(pk=access["user_id"], is_active=True)
        except (TokenError, InvalidToken, User.DoesNotExist):
            return None

    return await _validate(token)


async def authenticate_scope(scope: dict[str, Any]) -> WsAuthResult:
    """Resolve the connecting user from a Channels ``scope``.

    Prefers the single-use ``?ticket=`` (ADR-0141). Falls back to the deprecated
    ``?token=<jwt>`` **only** when ``TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED`` is set
    (default off, #1723) — with the fallback disabled a ``?token=`` handshake is
    treated as no credential at all, so a client cannot force a raw JWT into the
    URL. The caller closes with code 4001 when ``user`` is ``None`` and applies its
    own authorization gate otherwise.
    """
    params = _parse_query(scope.get("query_string", b""))

    ticket_bytes = params.get(b"ticket")
    if ticket_bytes:
        user_id = await consume_ticket(ticket_bytes.decode("utf-8"))
        user = await _resolve_active_user(user_id) if user_id else None
        return WsAuthResult(user=user, via="ticket")

    token_bytes = params.get(b"token")
    if token_bytes and getattr(settings, "TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED", False):
        user = await authenticate_token(token_bytes.decode("utf-8"))
        return WsAuthResult(user=user, via="token")

    return WsAuthResult(user=None, via=None)


def warn_if_legacy(result: WsAuthResult, *, consumer: str, project_pk: str) -> None:
    """Emit a deprecation warning when a socket authenticated via ``?token=``.

    A WebSocket client cannot read handshake response headers, so a server-side
    log is the dependable deprecation signal — it lets operators find clients
    still on the legacy path before it is removed next release.
    """
    if result.via == "token":
        # No secret logged: args are the consumer, project pk and user pk. The
        # literal "token" is the deprecated query-param's *name*, never its value.
        # nosemgrep: python-logger-credential-disclosure
        logger.warning(
            "Deprecated WebSocket auth: %s connected via ?token= (project %s, "
            "user %s). Migrate to POST /api/v1/ws/ticket/ (ADR-0141); the token "
            "query param is removed next release.",
            consumer,
            project_pk,
            getattr(result.user, "pk", "?"),
        )
