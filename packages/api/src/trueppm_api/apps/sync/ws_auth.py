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
import time
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

    **The stored value is the bare user id, and must stay that way.** Old and new
    pods share one Valkey during a rolling deploy, and the previous release's
    consumer resolves the value with ``User.objects.get(pk=value)``: any other
    format makes that raise, which closes the socket with 4001, and the web client
    treats a second 4001 as an expired session. The issue time the credential
    cutoff needs (#4499) is derived from the key's remaining TTL at consume time
    instead — see :func:`consume_ticket`.
    """
    from trueppm_api.core import valkey

    ticket = secrets.token_urlsafe(32)
    client = valkey.client(valkey.DB_CELERY)
    try:
        client.set(_ticket_key(ticket), str(user_id), ex=TICKET_TTL_SECONDS)
    finally:
        client.close()
    return ticket


@dataclass(frozen=True)
class TicketClaim:
    """A consumed ticket: whose it was, and when it was issued.

    ``issued_at`` is epoch seconds on the consuming pod's clock, derived from the
    key's remaining TTL. ``-inf`` means the age is unknowable (a key with no TTL,
    which only a bug writes): it predates any cutoff, so it fails closed.
    """

    user_id: str
    issued_at: float


async def consume_ticket(ticket: str) -> TicketClaim | None:
    """Atomically read-and-delete a ticket, returning its claim or ``None``.

    ``PTTL`` and ``GETDEL`` run in one ``MULTI`` transaction, so the ticket is
    single-use (a concurrent or replayed consume sees ``None``) and the TTL read
    belongs to the same key that was deleted. ``None`` is also returned for an
    expired or never-issued ticket.

    The issue time is ``now - (TTL - remaining)``. Valkey measures the elapsed
    part, so only the consuming pod's clock is involved — the cutoff margin in
    ``core.credential_cutoff`` absorbs that pod's skew against the resetting pod.
    Deriving it rather than storing it keeps the value format the previous
    release reads (see :func:`issue_ticket`), and gives tickets minted by an
    old pod mid-rollout a real issue time too.
    """
    from trueppm_api.core import valkey

    key = _ticket_key(ticket)
    client = valkey.async_client(valkey.DB_CELERY, decode_responses=True)
    try:
        async with client.pipeline(transaction=True) as pipe:
            pipe.pttl(key)
            pipe.getdel(key)
            remaining_ms, user_id = await pipe.execute()
    finally:
        await client.aclose()
    if user_id is None:
        return None
    if not isinstance(remaining_ms, int) or remaining_ms < 0:
        return TicketClaim(user_id=user_id, issued_at=float("-inf"))
    elapsed = TICKET_TTL_SECONDS - remaining_ms / 1000
    return TicketClaim(user_id=user_id, issued_at=time.time() - elapsed)


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


async def _resolve_active_user(user_id: str, issued_at: float) -> Any | None:
    """Return the active user for ``user_id``, or ``None``.

    Mirrors the JWT path's ``is_active`` filter: a user deactivated inside the
    ticket's short lifetime must not connect. Also mirrors its credential cutoff
    (#4499): a ticket issued at or before the account's cutoff is refused. The
    ticket's issue time is derived to the millisecond, so the comparison is exact.
    """
    from channels.db import database_sync_to_async

    @database_sync_to_async  # type: ignore[untyped-decorator]
    def _query(uid: str) -> Any | None:
        from django.contrib.auth import get_user_model

        from trueppm_api.core.credential_cutoff import (
            credentials_revoked_at,
            issued_before_cutoff,
        )

        User = get_user_model()
        try:
            user = User.objects.select_related("profile").get(pk=uid, is_active=True)
        except (User.DoesNotExist, ValueError, TypeError):
            return None
        if issued_before_cutoff(issued_at, credentials_revoked_at(user), whole_seconds=False):
            return None
        return user

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

        from trueppm_api.core.credential_cutoff import (
            credentials_revoked_at,
            issued_before_cutoff,
        )

        User = get_user_model()
        try:
            access = AccessToken(tok)  # type: ignore[arg-type]
            # is_active filter (#888): a deactivated user may still hold a JWT
            # that has not yet expired; treat it as a failed resolve (4001),
            # mirroring DRF's JWTAuthentication.
            user = User.objects.select_related("profile").get(pk=access["user_id"], is_active=True)
        except (TokenError, InvalidToken, User.DoesNotExist):
            return None
        # Credential cutoff (#4499), mirroring CredentialCutoffJWTAuthentication:
        # a JWT issued at or before a password reset must not open a socket.
        if issued_before_cutoff(access.get("iat"), credentials_revoked_at(user)):
            return None
        return user

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
        claim = await consume_ticket(ticket_bytes.decode("utf-8"))
        user = await _resolve_active_user(claim.user_id, claim.issued_at) if claim else None
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
