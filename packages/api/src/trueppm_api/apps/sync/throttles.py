"""Rate limiting for the mobile sync upload endpoint (ADR-0082, #667, #1719).

Raw redis-py against ``settings.REDIS_URL/2`` (the throttle-counter DB): INCR a
per-bucket key with a 60s TTL. Two independent windows must both pass —
per-``(project, user)`` and a per-``user`` GLOBAL bucket — so a member of N
projects can no longer sustain ``UPLOAD_LIMIT × N`` heavyweight batch writes/min by
spreading them across projects (#1719).

Unlike a read throttle, this gates the **write** path, and each admitted request is
a 500-row batch inside one ``transaction.atomic()`` (row locks + a CPM recalc
enqueue). It therefore fails **CLOSED** (deny) on any Redis error: a cache blip must
not silently remove the only DoS bound globally. Denial is safe here because the
offline client already retries uploads with backoff — a brief 429 during an outage
costs a retry, whereas failing open costs an unbounded authenticated write flood.
"""

from __future__ import annotations

import logging
import uuid
from contextlib import contextmanager
from typing import TYPE_CHECKING

import redis
from django.conf import settings
from rest_framework.exceptions import Throttled
from rest_framework.throttling import BaseThrottle

from trueppm_api.core import valkey
from trueppm_api.core.ratelimit import bypass_when_disabled
from trueppm_api.core.redis_throttle import incr_with_ttl

if TYPE_CHECKING:
    from collections.abc import Iterator

    from rest_framework.request import Request
    from rest_framework.views import APIView

logger = logging.getLogger(__name__)

_pool: redis.ConnectionPool | None = None

# req/min, per (project, user). Generous for batched offline replay on
# reconnect, but bounded against a runaway client looping a failing batch.
UPLOAD_LIMIT = 60

# req/min, per user across ALL projects (#1719). Caps the cross-project
# amplification: without it a member of N projects could sustain
# ``UPLOAD_LIMIT × N`` batch writes/min. Set above UPLOAD_LIMIT so a user legitimately
# replaying reconnect deltas for a couple of projects is unaffected, but the
# per-user ceiling holds regardless of how many projects the writes are spread over.
GLOBAL_UPLOAD_LIMIT = 120


def _client() -> redis.Redis:
    global _pool
    if _pool is None:
        _pool = valkey.pool(valkey.DB_CACHE, decode_responses=True)
    return redis.Redis(connection_pool=_pool)


@bypass_when_disabled
class SyncUploadThrottle(BaseThrottle):
    """Per-(project, user) rate limit for ``POST /projects/{pk}/sync/``.

    Fails CLOSED on Redis error (see module docstring), but the global operator
    kill switch (ADR-0604) still bypasses it entirely — "off means off", including
    this write-path guard — so the admin-facing "rate limiting disabled" status is
    literally accurate.
    """

    def allow_request(self, request: Request, view: APIView) -> bool:
        user = getattr(request, "user", None)
        if user is None or not getattr(user, "is_authenticated", False):
            return True  # auth layer rejects anonymous; nothing to bucket on
        project_pk = view.kwargs.get("pk")
        project_key = f"rate:sync_upload:{project_pk}:{user.pk}"
        user_key = f"rate:sync_upload:user:{user.pk}"

        try:
            client = _client()
            # Two independent atomic INCR+first-hit-EXPIRE counters (#1757). Each
            # EVAL is its own atomic unit, so neither bucket can outlive its 60s
            # window without a TTL even if the process dies between the two calls.
            project_count = incr_with_ttl(client, project_key, 60)
            user_count = incr_with_ttl(client, user_key, 60)
        except redis.RedisError:
            # Fail CLOSED on the write path (#1719): denying is safe (the offline
            # client retries with backoff); failing open would remove the only DoS
            # bound the instant Redis hiccups. See the module docstring.
            logger.warning("SyncUploadThrottle: Redis error, failing closed (deny)")
            self.wait_seconds = 60
            return False

        if project_count > UPLOAD_LIMIT or user_count > GLOBAL_UPLOAD_LIMIT:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        return getattr(self, "wait_seconds", None)


# Per-holder lease semaphore (#2287). KEYS[1] is a sorted set of holder ids
# scored by lease expiry (Redis server time, so every API pod reads one clock).
# Reaping expired leases, counting, and admitting run in ONE script, so two
# concurrent acquires can never both see "cap - 1" and both enter. The whole-key
# EXPIRE is only a backstop: it is set to the newest lease's expiry, which is at
# or after every member's, so it can never drop a live lease.
# ARGV: [1] lease seconds, [2] cap, [3] holder id. Returns 1 admitted, 0 refused.
_ACQUIRE_SLOT_LUA = """
local now = tonumber(redis.call('TIME')[1])
local lease = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
    return 0
end
redis.call('ZADD', KEYS[1], now + lease, ARGV[3])
redis.call('EXPIRE', KEYS[1], lease)
return 1
"""


@contextmanager
def sync_batch_concurrency_slot(user_pk: object) -> Iterator[None]:
    """Bound simultaneously in-flight sync-upload batches per user (#1756, #2287).

    The ``SyncUploadThrottle`` caps requests/minute, but each accepted batch is a
    heavy ``transaction.atomic()`` (up to ``TRUEPPM_SYNC_BATCH_MAX_ROWS`` row locks
    plus a CPM recalc enqueue). Under lock contention a burst of *concurrent*
    batches from one user can still tie up worker/DB resources within the rate cap.
    This is a per-user Redis semaphore around the batch apply. When
    ``TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES`` holders are already in flight the
    request is rejected with a 429 (``Throttled``) carrying a short ``Retry-After``.

    **Per-holder leases, not a shared counter (#2287).** Each admitted batch adds
    its own random holder id to a sorted set, scored by a lease expiry
    ``TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS`` ahead; release removes exactly that id.
    The earlier INCR/DECR counter shared one TTL between every holder, which drifted
    both ways: a key that expired under a long apply was re-created from 0 and the
    original holder's DECR then drove it negative (over-admit), and because every
    entry refreshed the TTL a crash-leaked +1 survived as long as uploads kept
    arriving (under-admit). With leases:

    - a release can never undercount — removing an id that is gone is a no-op;
    - a crash-leaked slot frees itself when *its own* lease ends, however busy the
      user is, because every acquire reaps expired leases before counting;
    - a holder that outlives its lease stops being counted from that moment, so
      the cap may admit one extra batch per such holder. That is the one residual
      imprecision, it cannot compound, and it is why the TTL should sit above the
      p99 contended apply time.

    **Fail open.** Any Redis error degrades to running the batch *without* the
    concurrency guard rather than blocking a legitimate upload. Unlike the rate
    throttle (which fails closed because it is the only global DoS bound), the
    per-minute rate cap here remains fully in force, so failing open on this
    defense-in-depth layer never removes the hard bound.
    """
    cap = getattr(settings, "TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES", 4)
    ttl = getattr(settings, "TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS", 120)
    # A new key name, not the old counter's: during a rolling update an old pod
    # still INCRs ``inflight:sync_upload:user:<pk>`` as a string, and a ZADD on
    # that key would fail with WRONGTYPE. Separate keys only cost the cap being
    # counted twice for the length of the rollout.
    key = f"inflight:sync_upload:holders:user:{user_pk}"
    holder = uuid.uuid4().hex

    try:
        client = _client()
        admitted = int(client.eval(_ACQUIRE_SLOT_LUA, 1, key, ttl, cap, holder))  # type: ignore[arg-type]
    except redis.RedisError:
        # Fail open — proceed without the guard; the rate throttle still bounds abuse.
        logger.warning("sync_batch_concurrency_slot: Redis error, proceeding without slot")
        yield
        return

    if not admitted:
        # Refused inside the script, so no lease was taken and nothing to refund.
        raise Throttled(
            wait=1,
            detail=(
                "Too many sync batches in flight for your account; retry once the "
                "current uploads finish."
            ),
        )

    try:
        yield
    finally:
        # Release exactly our own lease. A failure here is non-fatal: the lease
        # expires on its own and the next acquire reaps it.
        try:
            client.zrem(key, holder)
        except redis.RedisError:
            logger.warning(
                "sync_batch_concurrency_slot: Redis error releasing slot; lease will expire"
            )
