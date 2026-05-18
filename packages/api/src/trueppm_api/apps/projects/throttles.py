"""Rate limiting for inbound task-sync and token issuance (ADR-0068).

Uses raw redis-py against ``settings.REDIS_URL`` rather than ``django-redis``
so the API doesn't take on a new top-level dependency.  Single-purpose counter:
INCR a per-bucket key, set EXPIRE 60 on the first increment, fail-open on any
Redis error (a Redis outage must not take inbound sync down — DoS protection
should not become a DoS surface).
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import TYPE_CHECKING, ClassVar

import redis
from django.conf import settings
from django.utils import timezone
from rest_framework.throttling import BaseThrottle

if TYPE_CHECKING:
    from rest_framework.request import Request
    from rest_framework.views import APIView

logger = logging.getLogger(__name__)


# Module-level pool — shared across all requests, lazily initialized on first use.
_pool: redis.ConnectionPool | None = None


def _client() -> redis.Redis:
    global _pool
    if _pool is None:
        _pool = redis.ConnectionPool.from_url(
            f"{settings.REDIS_URL}/2",  # /2 is reserved for throttle counters
            decode_responses=True,
        )
    return redis.Redis(connection_pool=_pool)


# Backfill window: how long a fresh token gets the higher rate cap.  The window
# starts at created_at, not last_used_at, so a token that sits unused for a
# week and is then bulk-loaded still pays the steady-state rate.  Matches the
# common pattern of "mint token, run backfill within the hour".
BACKFILL_WINDOW = timedelta(minutes=60)
STEADY_STATE_LIMIT = 100  # req/min/project
BACKFILL_LIMIT = 1000  # req/min/project during the backfill window


class TaskSyncThrottle(BaseThrottle):
    """Per-project rate limit for the inbound task-sync endpoint.

    100 req/min steady-state; 1000 req/min during the first 60 minutes after
    the token was minted.  Resolves Jordan's bulk-import 🟡 — a 2000-ticket
    Jira backfill chunks to two 1000-req chunks in the backfill window then
    drops to steady-state for incremental updates.
    """

    def allow_request(self, request: Request, view: APIView) -> bool:
        # auth was set by ProjectApiTokenAuthentication — guard for other
        # throttle entry-points (e.g. shared base class on a JWT view).
        from trueppm_api.apps.projects.models import ProjectApiToken

        token = getattr(request, "auth", None)
        if not isinstance(token, ProjectApiToken):
            return True

        limit = (
            BACKFILL_LIMIT
            if (timezone.now() - token.created_at) < BACKFILL_WINDOW
            else STEADY_STATE_LIMIT
        )
        bucket_key = f"rate:task_sync:{token.project_id}"

        try:
            client = _client()
            count = client.incr(bucket_key)
            if count == 1:
                # First request in the window — set the 60-second TTL.
                client.expire(bucket_key, 60)
        except redis.RedisError:
            # Fail-open: a Redis outage must not block legitimate sync traffic.
            # Logged so an operator can alert on it.
            logger.exception("TaskSyncThrottle: Redis error, failing open")
            return True

        # int comparison — redis-py with decode_responses=True returns str for
        # GET but int for INCR.  Belt-and-braces in case the lib changes.
        if int(count) > limit:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        # Set by allow_request on a hit; None when we passed through.
        return getattr(self, "wait_seconds", None)


class TokenIssuanceThrottle(BaseThrottle):
    """5 req/min per user on the token-issuance endpoint.

    Admin/PM scope is not by itself defense against a scripted attacker who
    has compromised an admin session — the throttle caps the blast radius
    even if RBAC is satisfied.
    """

    USER_LIMIT: ClassVar[int] = 5

    def allow_request(self, request: Request, view: APIView) -> bool:
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return True  # let permission classes deal with anonymous

        bucket_key = f"rate:api_token_mint:{user.pk}"
        try:
            client = _client()
            count = client.incr(bucket_key)
            if count == 1:
                client.expire(bucket_key, 60)
        except redis.RedisError:
            logger.exception("TokenIssuanceThrottle: Redis error, failing open")
            return True

        if int(count) > self.USER_LIMIT:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        return getattr(self, "wait_seconds", None)
