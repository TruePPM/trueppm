"""Brute-force throttle test for the JWT login endpoint (#770).

The stock simplejwt ``TokenObtainPairView`` ships no throttle. The
``ThrottledTokenObtainPairView`` applies a scoped ``login`` rate so password
guessing against ``/api/v1/auth/token/`` is bounded per client IP.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

User = get_user_model()

_LOGIN_URL = "/api/v1/auth/token/"


@pytest.mark.django_db
def test_login_endpoint_throttles_after_rate_limit() -> None:
    # Throttle history lives in the (LocMem) cache; clear it so the count starts
    # from zero regardless of test ordering, and again at the end so a later test
    # that hits the endpoint isn't pre-throttled.
    cache.clear()
    try:
        User.objects.create_user(username="throttle_user", password="correct-horse")
        client = APIClient()

        # "login" scope is 10/min. The first 10 wrong-password attempts are
        # processed (401); the 11th is rejected by the throttle (429) before
        # authentication even runs.
        statuses = [
            client.post(
                _LOGIN_URL,
                {"username": "throttle_user", "password": "wrong"},
                format="json",
            ).status_code
            for _ in range(11)
        ]

        assert statuses[:10] == [401] * 10
        assert statuses[10] == 429
    finally:
        cache.clear()
