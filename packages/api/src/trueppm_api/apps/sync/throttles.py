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
from contextlib import contextmanager
from typing import TYPE_CHECKING

import redis
from django.conf import settings
from rest_framework.exceptions import Throttled
from rest_framework.throttling import BaseThrottle

from trueppm_api.core.redis_throttle import incr_with_ttl, incrby_with_ttl

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
        _pool = redis.ConnectionPool.from_url(
            f"{settings.REDIS_URL}/2",  # /2 is reserved for throttle counters
            decode_responses=True,
        )
    return redis.Redis(connection_pool=_pool)


class SyncUploadThrottle(BaseThrottle):
    """Per-(project, user) rate limit for ``POST /projects/{pk}/sync/``."""

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


@contextmanager
def sync_batch_concurrency_slot(user_pk: object) -> Iterator[None]:
    """Bound simultaneously in-flight sync-upload batches per user (#1756).

    The ``SyncUploadThrottle`` caps requests/minute, but each accepted batch is a
    heavy ``transaction.atomic()`` (up to ``TRUEPPM_SYNC_BATCH_MAX_ROWS`` row locks
    plus a CPM recalc enqueue). Under lock contention a burst of *concurrent*
    batches from one user can still tie up worker/DB resources within the rate cap.
    This is a per-user Redis semaphore around the batch apply: INCR a slot on entry,
    DECR it in a ``finally``. When the count exceeds
    ``TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES`` the slot is immediately released and the
    request is rejected with a 429 (``Throttled``) carrying a short ``Retry-After``.

    Two safety properties:

    - **Slot-leak guard.** The counter carries a TTL
      (``TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS``), refreshed on every entry via
      :func:`incrby_with_ttl`, so a worker that dies mid-apply (never reaching the
      ``finally`` DECR) cannot leak its slot permanently — the whole counter is
      reclaimed once no further batch refreshes it within the window.
    - **Fail open.** Any Redis error degrades to running the batch *without* the
      concurrency guard rather than blocking a legitimate upload. Unlike the rate
      throttle (which fails closed because it is the only global DoS bound), the
      per-minute rate cap here remains fully in force, so failing open on this
      defense-in-depth layer never removes the hard bound.

    Known precision limit (tracked in #2287): a single TTL-refreshed counter can
    drift if an apply outlives ``TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS`` (over-admit) or
    a crash-leaked slot persists under sustained load (under-admit). Both are
    bounded to this defense-in-depth layer — the fail-closed rate cap stays the hard
    bound — so it ships as-is; a per-holder-token semaphore would make it exact.
    """
    cap = getattr(settings, "TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES", 4)
    ttl = getattr(settings, "TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS", 120)
    key = f"inflight:sync_upload:user:{user_pk}"

    try:
        client = _client()
        # INCRBY 1 + refresh TTL atomically (#1757 helper): the slot count and its
        # leak-guard TTL are set together, so a crash can't strand a wedged counter.
        count = incrby_with_ttl(client, key, 1, ttl)
    except redis.RedisError:
        # Fail open — proceed without the guard; the rate throttle still bounds abuse.
        logger.warning("sync_batch_concurrency_slot: Redis error, proceeding without slot")
        yield
        return

    if count > cap:
        # Over cap: release our own increment immediately (we are rejecting, not
        # holding a slot) and ask the client to retry once in-flight work drains.
        try:
            client.decr(key)
        except redis.RedisError:
            # The TTL will reclaim the over-count; nothing else to do.
            logger.warning("sync_batch_concurrency_slot: Redis error releasing over-cap slot")
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
        # Release the held slot. A failure here is non-fatal: the TTL reclaims it.
        try:
            client.decr(key)
        except redis.RedisError:
            logger.warning(
                "sync_batch_concurrency_slot: Redis error releasing slot; TTL will reclaim"
            )
