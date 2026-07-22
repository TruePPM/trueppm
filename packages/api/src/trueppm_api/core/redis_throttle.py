"""Atomic INCR-with-TTL primitives for the raw-redis throttle counters (#1757).

Every raw-redis throttle under ``apps/*/throttles.py`` bounds a request rate by
INCRementing a per-bucket counter key and setting a TTL so the window resets.
The historical idiom did this as two separate round trips::

    count = client.incr(key)
    if count == 1:
        client.expire(key, ttl)

A crash — or a dropped connection, or an EXPIRE error — *between* the INCR and
the EXPIRE leaves the counter key with **no TTL**: it never resets and that
principal is wedged at HTTP 429 for that bucket indefinitely, a self-inflicted
DoS (flagged Low/pre-existing in the #1719 security review). Collapsing both
commands into one server-side Lua script makes the TTL inseparable from the
counter's creation — Redis runs the script atomically, so a bucket either exists
*with* a TTL or does not exist at all. There is no interleaving in which the
counter outlives its window.

``projects.throttles.claim_visit_window`` and
``integrations.throttles.claim_webhook_delivery`` already have this guarantee via
the atomic ``SET NX EX`` idiom; these helpers give the *counter* throttles the
equivalent. The script text is passed to ``EVAL`` on every call: it is ~40 bytes,
so the bandwidth cost is negligible and we avoid any ``NOSCRIPT`` cache-miss
handling that ``EVALSHA`` would require.

Both helpers raise ``redis.RedisError`` straight through on a broker failure —
each caller keeps its own fail-open (rate throttles) or fail-closed (the
write-path sync throttle) policy exactly as before.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import redis

# INCR the key and, only on the transition to 1 (the first hit of a fresh
# window), stamp the TTL. Running both inside one EVAL means the EXPIRE can never
# be lost between two round trips. Returns the post-increment count.
_INCR_WITH_TTL_LUA = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
"""

# INCRBY the key by ARGV[1] and (re)stamp the TTL unconditionally. Used where the
# counter is advanced by a variable amount and the window is meant to slide from
# the most recent activity (mention fan-out accounting; the sync in-flight
# semaphore, whose TTL is a crash-leak guard that should refresh on every entry).
_INCRBY_WITH_TTL_LUA = """
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return count
"""


def incr_with_ttl(client: redis.Redis, key: str, ttl: int) -> int:
    """Atomically INCR ``key`` and, on the first hit, set its ``ttl`` (seconds).

    Drop-in replacement for the non-atomic ``INCR`` + ``if count == 1: EXPIRE``
    idiom so a crash between the two can no longer strand a counter without a TTL.
    Returns the post-increment count. Propagates ``redis.RedisError`` so the
    caller keeps its existing fail-open / fail-closed policy.
    """
    # redis-py types eval() as Awaitable|str for the sync/async-generic client;
    # the sync client returns the script's integer result. Matches the existing
    # ``int(client.incr(...))  # type: ignore[arg-type]`` pattern in the throttles.
    return int(client.eval(_INCR_WITH_TTL_LUA, 1, key, ttl))  # type: ignore[arg-type]


def incrby_with_ttl(client: redis.Redis, key: str, amount: int, ttl: int) -> int:
    """Atomically INCRBY ``key`` by ``amount`` and (re)set its ``ttl`` (seconds).

    Like :func:`incr_with_ttl` but for the variable-amount counters, and it stamps
    the TTL on *every* call (a sliding window) rather than only the first. Returns
    the post-increment count. Propagates ``redis.RedisError``.
    """
    return int(client.eval(_INCRBY_WITH_TTL_LUA, 1, key, amount, ttl))  # type: ignore[arg-type]
