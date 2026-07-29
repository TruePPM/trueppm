"""The single place a Valkey/Redis client is constructed (ADR-0716, #2554).

Before this module every consumer built its own client by string-concatenating a
database index onto ``settings.REDIS_URL``::

    redis.from_url(f"{settings.REDIS_URL}/2")

That idiom pins the process to **one host**, which quietly rules out every
high-availability topology. Sentinel in particular cannot be expressed as a URL
at all for two of our three headline consumers, so an operator who configured it
got a deploy that either refused to start or talked to a replica — and the
eleven raw call sites listed in ADR-0716 would have kept talking to a dead
primary after a failover *silently*, because most of them fail open by design.

Routing every client through one factory means adding a topology is a change
here and nowhere else. Two modes are supported:

* **Single endpoint** (default, unchanged) — ``REDIS_URL`` plus a database index.
  A deploy that sets nothing new gets byte-for-byte the previous behavior.
* **Sentinel** — enabled by a non-empty ``TRUEPPM_VALKEY_SENTINELS``. Clients are
  built with :meth:`redis.sentinel.Sentinel.master_for`, which re-resolves the
  current primary when a connection is established. That is what makes failover
  transparent without a restart.

Cluster mode is deliberately **not** supported; see ADR-0716 for why (a clustered
endpoint exposes only database 0, and we use four).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

import redis
import redis.asyncio as aioredis
from django.conf import settings

if TYPE_CHECKING:
    from redis.asyncio.sentinel import Sentinel as AsyncSentinel
    from redis.sentinel import Sentinel as SyncSentinel

# ---------------------------------------------------------------------------
# Logical database map
# ---------------------------------------------------------------------------
# These indexes were previously magic numbers spread across eleven modules, and
# ``DB_NOTIFICATIONS`` (3) appeared in no document at all — it was discoverable
# only by grep. Naming them here makes the role map reviewable in one place and
# is what the Cluster-incompatibility argument rests on: four distinct databases
# cannot live behind a clustered endpoint, which exposes only database 0.

DB_CELERY = 0
"""Celery broker and result backend."""

DB_CHANNELS = 1
"""Django Channels layer (WebSocket fan-out)."""

DB_CACHE = 2
"""Django ``CACHES["default"]`` — OIDC login state and DRF throttle counters."""

DB_NOTIFICATIONS = 3
"""Notification fan-out throttle counters."""


def sentinel_mode() -> bool:
    """Whether Sentinel is configured (a non-empty sentinel host list)."""
    return bool(getattr(settings, "VALKEY_SENTINELS", ()))


def _sentinel_kwargs() -> dict[str, Any]:
    """Connection kwargs shared by every data-node connection we open."""
    kwargs: dict[str, Any] = {}
    password = getattr(settings, "VALKEY_PASSWORD", "")
    if password:
        kwargs["password"] = password
    if getattr(settings, "VALKEY_USE_TLS", False):
        kwargs["ssl"] = True
    return kwargs


def _sentinel_node_kwargs() -> dict[str, Any]:
    """Connection kwargs for talking to the Sentinel nodes themselves.

    Sentinels frequently carry a *different* password from the data nodes (they
    are commonly left unauthenticated even when the primary is not), so this is a
    separate setting rather than a reuse of ``VALKEY_PASSWORD``.
    """
    kwargs: dict[str, Any] = {}
    password = getattr(settings, "VALKEY_SENTINEL_PASSWORD", "")
    if password:
        kwargs["password"] = password
    return kwargs


def url_for(db: int) -> str:
    """Return the single-endpoint URL for ``db``.

    Only meaningful outside Sentinel mode. Kept for the few places that genuinely
    need a URL *string* rather than a client — the Celery and channel-layer
    settings entries — and for tests asserting the legacy shape is unchanged.
    """
    return f"{settings.REDIS_URL}/{db}"


def client(db: int, *, decode_responses: bool = False, **kwargs: Any) -> redis.Redis:
    """Return a synchronous client bound to logical database ``db``.

    In Sentinel mode the returned client resolves the current primary on each
    connection, so a failover needs no restart. Callers keep their own
    fail-open / fail-closed policy — this function raises only on
    misconfiguration, never on a broker being unreachable (no connection is
    opened here). Extra ``kwargs`` (``socket_timeout`` and friends) pass through
    to the underlying connection in both modes.
    """
    if sentinel_mode():
        return cast(
            "redis.Redis",
            _sync_sentinel().master_for(  # type: ignore[no-untyped-call]
                settings.VALKEY_MASTER_NAME,
                db=db,
                decode_responses=decode_responses,
                **_sentinel_kwargs(),
                **kwargs,
            ),
        )
    return redis.from_url(url_for(db), decode_responses=decode_responses, **kwargs)


def async_client(db: int, *, decode_responses: bool = False, **kwargs: Any) -> aioredis.Redis:
    """Asyncio counterpart of :func:`client`, for the Channels consumers."""
    if sentinel_mode():
        return cast(
            "aioredis.Redis",
            _async_sentinel().master_for(
                settings.VALKEY_MASTER_NAME,
                db=db,
                decode_responses=decode_responses,
                **_sentinel_kwargs(),
                **kwargs,
            ),
        )
    return aioredis.from_url(url_for(db), decode_responses=decode_responses, **kwargs)


def pool(db: int, *, decode_responses: bool = False, **kwargs: Any) -> redis.ConnectionPool:
    """Return a connection pool for ``db``.

    Used by the throttles, which hold a module-level pool for the process
    lifetime rather than building a client per request. In Sentinel mode this is
    the pool behind a ``master_for`` client, so it is a
    ``SentinelConnectionPool`` and re-resolves the primary on failover; the
    caller's ``redis.Redis(connection_pool=...)`` idiom is unchanged either way.
    """
    if sentinel_mode():
        return client(db, decode_responses=decode_responses, **kwargs).connection_pool
    return redis.ConnectionPool.from_url(url_for(db), decode_responses=decode_responses, **kwargs)


# ---------------------------------------------------------------------------
# Sentinel managers
# ---------------------------------------------------------------------------
# Cached per process: the manager holds connections to the sentinel nodes and is
# safe to share. It is *not* cached per database — ``master_for`` is the cheap
# per-database call, and caching that would defeat re-resolution on failover.

_sync_manager: SyncSentinel | None = None
_async_manager: AsyncSentinel | None = None


def _sync_sentinel() -> SyncSentinel:
    global _sync_manager
    if _sync_manager is None:
        from redis.sentinel import Sentinel

        _sync_manager = Sentinel(  # type: ignore[no-untyped-call]
            list(settings.VALKEY_SENTINELS),
            sentinel_kwargs=_sentinel_node_kwargs(),
            **_sentinel_kwargs(),
        )
    return _sync_manager


def _async_sentinel() -> AsyncSentinel:
    global _async_manager
    if _async_manager is None:
        from redis.asyncio.sentinel import Sentinel

        _async_manager = Sentinel(  # type: ignore[no-untyped-call]
            list(settings.VALKEY_SENTINELS),
            sentinel_kwargs=_sentinel_node_kwargs(),
            **_sentinel_kwargs(),
        )
    return _async_manager


def reset_managers() -> None:
    """Drop the cached Sentinel managers so a test can rebind the settings.

    Mirrors ``observability.otel.export_health``'s pool reset: the managers are
    process-global by design, so any test using ``override_settings`` to switch
    topology must clear them or it will assert against the previous mode.
    """
    global _sync_manager, _async_manager
    _sync_manager = None
    _async_manager = None
