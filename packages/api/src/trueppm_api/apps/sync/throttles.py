"""Rate limiting for the mobile sync upload endpoint (ADR-0082, #667).

Mirrors ``projects.throttles``: raw redis-py against ``settings.REDIS_URL/2``
(the throttle-counter DB), INCR a per-bucket key with a 60s TTL, fail-open on
any Redis error so a cache outage can never take sync writes down.
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
        bucket_key = f"rate:sync_upload:{project_pk}:{user.pk}"

        try:
            client = _client()
            count = int(client.incr(bucket_key))  # type: ignore[arg-type]
            if count == 1:
                client.expire(bucket_key, 60)
        except redis.RedisError:
            logger.exception("SyncUploadThrottle: Redis error, failing open")
            return True

        if count > UPLOAD_LIMIT:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        return getattr(self, "wait_seconds", None)
