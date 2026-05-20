"""Rate limiting for mention creation (ADR-0075 locked constraints #8, #9).

Per-user daily + hourly burst limits, applied at comment-create time before
the mention parser runs the fan-out. Uses the same redis-pool pattern as
``apps/projects/throttles.py``; same fail-open policy on Redis errors.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, cast

import redis
from django.conf import settings
from rest_framework.throttling import BaseThrottle

from .services import MENTION_DAILY_LIMIT, MENTION_HOURLY_BURST

if TYPE_CHECKING:
    from rest_framework.request import Request
    from rest_framework.views import APIView

logger = logging.getLogger(__name__)

_pool: redis.ConnectionPool | None = None


def _client() -> redis.Redis:
    global _pool
    if _pool is None:
        # /3 reserved for mention-counter buckets (distinct from task-sync /2)
        _pool = redis.ConnectionPool.from_url(
            f"{settings.REDIS_URL}/3",
            decode_responses=True,
        )
    return redis.Redis(connection_pool=_pool)


class MentionRateThrottle(BaseThrottle):
    """Two-window throttle: 1000 mentions/day AND 100 mentions/hour per user.

    Applied on the comment-create endpoint; the actual count is the number of
    parsed mentions in the body (parsed in the viewset, not here — this only
    checks whether the user has burst budget remaining).
    """

    wait_seconds: int | None = None

    def allow_request(self, request: Request, view: APIView) -> bool:
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated:
            return True

        user_pk = str(user.pk)
        try:
            client = _client()
            hourly_key = f"mention:hour:{user_pk}"
            daily_key = f"mention:day:{user_pk}"
            hourly = int(cast("str | int | None", client.get(hourly_key)) or 0)
            daily = int(cast("str | int | None", client.get(daily_key)) or 0)
        except redis.RedisError:
            logger.exception("MentionRateThrottle: Redis error, failing open")
            return True

        if hourly >= MENTION_HOURLY_BURST:
            self.wait_seconds = 3600
            return False
        if daily >= MENTION_DAILY_LIMIT:
            self.wait_seconds = 86400
            return False
        return True

    def wait(self) -> float | None:
        return float(self.wait_seconds) if self.wait_seconds else None


def record_mention_usage(user_pk: str | int, count: int) -> None:
    """Increment the user's hour/day mention counters by `count`.

    Called by the comment viewset after a successful mention fan-out so the
    limit reflects actual fan-out volume rather than just create-count.
    Fail-open on Redis errors (matches MentionRateThrottle).
    """
    if count <= 0:
        return
    try:
        client = _client()
        pipe = client.pipeline()
        hourly_key = f"mention:hour:{user_pk}"
        daily_key = f"mention:day:{user_pk}"
        pipe.incrby(hourly_key, count)
        pipe.expire(hourly_key, 3600)
        pipe.incrby(daily_key, count)
        pipe.expire(daily_key, 86400)
        pipe.execute()
    except redis.RedisError:
        logger.exception("record_mention_usage: Redis error, failing open")
