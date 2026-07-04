"""General default API rate-limit tests (#1080).

The base ``REST_FRAMEWORK`` config installs a global ``DEFAULT_THROTTLE_CLASSES``
(``ProbeExemptAnonRateThrottle`` / ``ProbeExemptUserRateThrottle``) so every
endpoint that does not declare its own throttle gets a baseline anon/user rate
limit. These tests assert:

* an unauthenticated caller is throttled once it exceeds the ``anon`` rate,
* the ``/api/v1/health/`` and ``/api/v1/edition/`` k8s probe endpoints are never
  throttled — even far past the limit — so a tight readiness loop can't be 429'd,
* an authenticated caller is bucketed under the ``user`` scope, not ``anon``.

Rates are overridden with ``mock.patch.dict`` on ``SimpleRateThrottle.THROTTLE_RATES``
— the dict every throttle reads at request time — rather than ``@override_settings``,
because DRF binds ``THROTTLE_RATES`` to that dict object at class-definition time and
a settings override does not reach the already-imported throttle classes. Throttle
history lives in the (LocMem) cache under pytest, so it is cleared before and after
each test to keep counts deterministic regardless of test ordering.
"""

from __future__ import annotations

from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient
from rest_framework.throttling import SimpleRateThrottle

User = get_user_model()

# Anonymous-reachable, non-probe, non-scoped endpoint for the anon-throttle tests.
# DRF checks permissions BEFORE throttles, so an auth-required endpoint 401s before
# the anon bucket is ever touched — the anon throttle only bites where anon is
# actually served. The OpenAPI schema view is AllowAny (spectacular default) and
# declares no throttle of its own, so it exercises the general anon default.
_ANON_URL = "/api/schema/"
# Authenticated-request endpoint: ProjectViewSet is auth-only (200 once authed) and
# declares no throttle of its own, so it exercises the general "user" default.
_THROTTLED_URL = "/api/v1/projects/"
_HEALTH_URL = "/api/v1/health/"
_EDITION_URL = "/api/v1/edition/"


@pytest.mark.django_db
def test_anonymous_requests_throttled_after_anon_rate() -> None:
    cache.clear()
    try:
        client = APIClient()
        with mock.patch.dict(SimpleRateThrottle.THROTTLE_RATES, {"anon": "2/min"}):
            statuses = [client.get(_ANON_URL).status_code for _ in range(3)]

        # First two are served; the third exceeds the 2/min anon bucket.
        assert statuses[:2] == [200, 200]
        assert statuses[2] == 429
    finally:
        cache.clear()


@pytest.mark.django_db
def test_throttle_response_includes_retry_after_header() -> None:
    cache.clear()
    try:
        client = APIClient()
        with mock.patch.dict(SimpleRateThrottle.THROTTLE_RATES, {"anon": "2/min"}):
            client.get(_ANON_URL)
            client.get(_ANON_URL)
            throttled = client.get(_ANON_URL)

        assert throttled.status_code == 429
        # DRF sets Retry-After (seconds) on a throttled response.
        assert "Retry-After" in throttled.headers
        assert int(throttled.headers["Retry-After"]) >= 0
    finally:
        cache.clear()


@pytest.mark.django_db
def test_probe_endpoints_never_throttled() -> None:
    cache.clear()
    try:
        client = APIClient()
        # Both scopes pinned to 1/min: any counted request past the first would 429.
        with mock.patch.dict(SimpleRateThrottle.THROTTLE_RATES, {"anon": "1/min", "user": "1/min"}):
            health_statuses = [client.get(_HEALTH_URL).status_code for _ in range(5)]
            edition_statuses = [client.get(_EDITION_URL).status_code for _ in range(5)]

        # get_cache_key returns None for probe paths → never throttled.
        assert health_statuses == [200] * 5
        assert edition_statuses == [200] * 5
    finally:
        cache.clear()


@pytest.mark.django_db
def test_authenticated_user_uses_user_scope_not_anon() -> None:
    cache.clear()
    try:
        user = User.objects.create_user(username="throttle_scope_user", password="pw-correct-horse")
        client = APIClient()
        client.force_authenticate(user=user)

        # anon pinned tiny, user left generous: if the authenticated caller were
        # bucketed under "anon" the third request would 429. It must not.
        with mock.patch.dict(
            SimpleRateThrottle.THROTTLE_RATES, {"anon": "1/min", "user": "1000/min"}
        ):
            statuses = [client.get(_THROTTLED_URL).status_code for _ in range(3)]

        assert statuses == [200, 200, 200]
    finally:
        cache.clear()


@pytest.mark.django_db
def test_authenticated_requests_throttled_by_user_rate() -> None:
    cache.clear()
    try:
        user = User.objects.create_user(username="throttle_user_rate", password="pw-correct-horse")
        client = APIClient()
        client.force_authenticate(user=user)

        # Pin the user scope low; the anon scope must not interfere for an
        # authenticated caller (AnonRateThrottle skips authenticated requests).
        with mock.patch.dict(
            SimpleRateThrottle.THROTTLE_RATES, {"user": "2/min", "anon": "1000/min"}
        ):
            statuses = [client.get(_THROTTLED_URL).status_code for _ in range(3)]

        assert statuses[:2] == [200, 200]
        assert statuses[2] == 429
    finally:
        cache.clear()
