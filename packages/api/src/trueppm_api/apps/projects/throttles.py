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

        count: int
        try:
            client = _client()
            count = int(client.incr(bucket_key))  # type: ignore[arg-type]
            if count == 1:
                # First request in the window — set the 60-second TTL.
                client.expire(bucket_key, 60)
        except redis.RedisError:
            # Fail-open: a Redis outage must not block legitimate sync traffic.
            # Logged so an operator can alert on it.
            logger.exception("TaskSyncThrottle: Redis error, failing open")
            return True

        if count > limit:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        # Set by allow_request on a hit; None when we passed through.
        return getattr(self, "wait_seconds", None)


class AcceptanceResultThrottle(BaseThrottle):
    """Per-token rate limit for the inbound CI acceptance-result endpoint (ADR-0148).

    Same window/limits as ``TaskSyncThrottle`` (100 req/min steady, 1000 req/min in
    the first 60 minutes after the token was minted) so a CI matrix that fans out
    on first integration gets headroom, then drops to steady-state. Keyed on the
    token PK (not project_id) so a program-scoped token — whose ``project_id`` is
    ``None`` — gets its own bucket rather than colliding with every other
    program-scoped token on a shared ``None`` key. Fail-open on Redis error: DoS
    protection must not itself become a DoS surface.
    """

    def allow_request(self, request: Request, view: APIView) -> bool:
        from trueppm_api.apps.projects.models import ProjectApiToken

        token = getattr(request, "auth", None)
        if not isinstance(token, ProjectApiToken):
            return True

        limit = (
            BACKFILL_LIMIT
            if (timezone.now() - token.created_at) < BACKFILL_WINDOW
            else STEADY_STATE_LIMIT
        )
        bucket_key = f"rate:acceptance_result:{token.pk}"

        count: int
        try:
            client = _client()
            count = int(client.incr(bucket_key))  # type: ignore[arg-type]
            if count == 1:
                client.expire(bucket_key, 60)
        except redis.RedisError:
            logger.exception("AcceptanceResultThrottle: Redis error, failing open")
            return True

        if count > limit:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        return getattr(self, "wait_seconds", None)


def claim_visit_window(user_pk: object, project_pk: object, ttl: int = 60) -> bool:
    """Server-side coalesce for last-visited recording (ADR-0150 D3).

    Returns ``True`` if this is the first visit-ping for ``(user, project)`` in
    the current ``ttl``-second window — the caller should perform the upsert.
    Returns ``False`` if a recent ping already claimed the window, so the caller
    skips the write and returns a ``200`` no-op (a coalesced ping is *not* an
    error — never surface 429 for an inconsequential navigation ping).

    Fails *open* (returns ``True``) on any Redis error: a throttle outage must
    never drop real last-visited data — at worst we do an extra cheap upsert.
    Uses ``SET NX EX`` so the claim is atomic.
    """

    bucket_key = f"rate:project_visit:{user_pk}:{project_pk}"
    try:
        client = _client()
        # SET key 1 NX EX ttl → returns True only if the key did not exist.
        claimed = client.set(bucket_key, 1, nx=True, ex=ttl)
    except redis.RedisError:
        logger.exception("claim_visit_window: Redis error, failing open (recording visit)")
        return True
    return bool(claimed)


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
        count: int
        try:
            client = _client()
            count = int(client.incr(bucket_key))  # type: ignore[arg-type]
            if count == 1:
                client.expire(bucket_key, 60)
        except redis.RedisError:
            logger.exception("TokenIssuanceThrottle: Redis error, failing open")
            return True

        if count > self.USER_LIMIT:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        return getattr(self, "wait_seconds", None)
