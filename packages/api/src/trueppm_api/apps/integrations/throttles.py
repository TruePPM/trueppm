"""Rate limiting + delivery dedup for the inbound Git webhook (#329, ADR-0158).

Reuses the established raw-redis throttle plumbing in
:mod:`trueppm_api.apps.projects.throttles` (a per-bucket ``INCR`` + ``EXPIRE``,
fail-open on any Redis error so DoS protection never becomes a DoS surface). Two
surfaces live here:

- :class:`GitWebhookThrottle` — a per-project request cap on the public,
  signature-authenticated receiver.
- :func:`claim_webhook_delivery` — a ``SET NX EX`` idempotency claim so a provider
  redelivery of the same event is a cheap no-op (the forward-only guard in
  ``git_automation_services`` is the second, Redis-independent idempotency layer).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import redis
from rest_framework.throttling import BaseThrottle

# Reuse the single shared connection pool + client factory from the projects
# throttles module rather than opening a second pool.
from trueppm_api.apps.projects.throttles import _client

if TYPE_CHECKING:
    from rest_framework.request import Request
    from rest_framework.views import APIView

logger = logging.getLogger(__name__)

# Per-project cap. Generous: a busy repo bursts several PR events at once, and the
# work per request is one indexed lookup + at most one status write.
_WEBHOOK_LIMIT_PER_MIN = 120

# Per-user cap on the task-link refresh action (#571, ADR-0163). A refresh makes
# an outbound HTTP fetch; for the cloud-file providers that fetch is *anonymous*
# (no credential gate), so the endpoint is a potential SSRF/egress amplifier. The
# existing SSRF deny-list + 5 s / 256 KB caps bound each call; this bounds the
# call *rate* per user. Generous enough for a human clicking refresh on a task's
# handful of links, far below an automated abuse rate.
_REFRESH_LIMIT_PER_MIN = 30


class GitWebhookThrottle(BaseThrottle):
    """Per-project rate limit for the inbound Git-event receiver.

    Keyed on the URL ``project_pk`` (the receiver is unauthenticated-by-session,
    so there is no user/token principal to key on). Fail-open on Redis error.
    """

    def allow_request(self, request: Request, view: APIView) -> bool:
        project_pk = getattr(view, "kwargs", {}).get("project_pk")
        if project_pk is None:
            return True

        bucket_key = f"rate:git_webhook:{project_pk}"
        try:
            client = _client()
            count = int(client.incr(bucket_key))  # type: ignore[arg-type]
            if count == 1:
                client.expire(bucket_key, 60)
        except redis.RedisError:
            logger.exception("GitWebhookThrottle: Redis error, failing open")
            return True

        if count > _WEBHOOK_LIMIT_PER_MIN:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        return getattr(self, "wait_seconds", None)


class TaskLinkRefreshThrottle(BaseThrottle):
    """Per-user rate limit for the task-link refresh action (#571, ADR-0163).

    Keyed on the authenticated user id (the action requires auth). Fails *open*
    on any Redis error — a throttle outage must never block a Viewer from
    refreshing a link, and the SSRF guard remains the hard egress boundary.
    """

    def allow_request(self, request: Request, view: APIView) -> bool:
        user = getattr(request, "user", None)
        user_id = getattr(user, "pk", None)
        if user_id is None:  # pragma: no cover — IsProjectMember requires auth
            return True

        bucket_key = f"rate:link_refresh:{user_id}"
        try:
            client = _client()
            count = int(client.incr(bucket_key))  # type: ignore[arg-type]
            if count == 1:
                client.expire(bucket_key, 60)
        except redis.RedisError:
            logger.exception("TaskLinkRefreshThrottle: Redis error, failing open")
            return True

        if count > _REFRESH_LIMIT_PER_MIN:
            self.wait_seconds = 60
            return False
        return True

    def wait(self) -> float | None:
        return getattr(self, "wait_seconds", None)


def claim_webhook_delivery(project_pk: object, delivery_key: str, ttl: int = 3600) -> bool:
    """Claim a webhook delivery for processing; ``False`` if already seen.

    Returns ``True`` the first time ``(project, delivery_key)`` is seen within the
    ``ttl`` window (the caller should process it), ``False`` on a redelivery (the
    caller returns a 200 ``duplicate`` no-op). Fails *open* (``True``) on any Redis
    error or an empty key — the forward-only status guard makes a duplicate apply
    harmless, so a throttle outage must never drop a real first delivery.
    """
    if not delivery_key:
        return True
    bucket_key = f"gitwebhook:{project_pk}:{delivery_key}"
    try:
        client = _client()
        claimed = client.set(bucket_key, 1, nx=True, ex=ttl)
    except redis.RedisError:
        logger.exception("claim_webhook_delivery: Redis error, failing open")
        return True
    return bool(claimed)
