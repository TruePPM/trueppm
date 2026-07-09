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
from typing import TYPE_CHECKING

import redis
from django.conf import settings
from rest_framework.throttling import BaseThrottle

if TYPE_CHECKING:
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
            # One round-trip for both counters; each gets its own 60s window on first hit.
            pipe = client.pipeline()
            pipe.incr(project_key)
            pipe.incr(user_key)
            project_count, user_count = (int(v) for v in pipe.execute())
            if project_count == 1 or user_count == 1:
                exp = client.pipeline()
                if project_count == 1:
                    exp.expire(project_key, 60)
                if user_count == 1:
                    exp.expire(user_key, 60)
                exp.execute()
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
