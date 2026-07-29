"""A Sentinel-aware Django cache backend (ADR-0716, #2554).

Django's built-in ``django.core.cache.backends.redis.RedisCache`` has no Sentinel
support: it builds pools with ``ConnectionPool.from_url(server)``, and a Sentinel
topology cannot be expressed as a URL. The conventional fix is to add
``django-redis`` for its ``SentinelClient``.

We deliberately do not. ADR-0065 and ADR-0068 both declined ``django-redis`` to
avoid a new top-level dependency, and that decision survives here because
Django's backend has exactly the seam we need: ``RedisCache.__init__`` assigns
``self._class``, and the client builds its pool in one overridable method. So
Sentinel support costs one attribute and one method override — every cache
operation, the serializer, and all timeout semantics are inherited untouched.

This backend is selected **only** in Sentinel mode. Single-endpoint deploys keep
using Django's stock ``RedisCache`` on precisely the path they use today, so the
common case carries none of this code.

The coupling to two private Django names (``RedisCacheClient`` and
``_get_connection_pool``) is the accepted cost, recorded in ADR-0716's
Consequences. ``tests/test_valkey_sentinel.py`` asserts the subclass still binds
to the real Django base and completes a cache round trip, so a Django upgrade
that moves either name fails a test rather than production.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.core.cache.backends.redis import RedisCache, RedisCacheClient

from trueppm_api.core import valkey

if TYPE_CHECKING:
    import redis


class _SentinelCacheClient(RedisCacheClient):
    """``RedisCacheClient`` that resolves its pool through Sentinel."""

    def _get_connection_pool(self, write: bool) -> redis.ConnectionPool:
        """Return the pool for the current primary.

        The base class picks a pool by index across ``self._servers`` and splits
        reads across replicas. Under Sentinel there is exactly one address that
        matters — whichever node is primary *right now* — and
        ``SentinelConnectionPool`` re-resolves it on connect. So ``write`` is
        ignored on purpose: sending reads to a replica here would reintroduce the
        stale-read window that the cache (which backs single-use OIDC login state
        and throttle counters) specifically must not have.
        """
        return valkey.pool(valkey.DB_CACHE)


class SentinelRedisCache(RedisCache):
    """Django cache backend backed by a Valkey/Redis Sentinel primary.

    Configured automatically by ``settings/base.py`` when
    ``TRUEPPM_VALKEY_SENTINELS`` is set; not intended to be named directly in
    operator configuration. ``LOCATION`` is ignored — the topology comes from the
    ``TRUEPPM_VALKEY_*`` settings via :mod:`trueppm_api.core.valkey`.
    """

    def __init__(self, server: str, params: dict[str, Any]) -> None:
        super().__init__(server, params)
        self._class = _SentinelCacheClient
