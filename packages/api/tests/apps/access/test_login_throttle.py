"""Brute-force throttle tests for the JWT login endpoint (#770, #1717).

The stock simplejwt ``TokenObtainPairView`` ships no throttle. TruePPM's
``CookieTokenObtainPairView`` stacks two throttles:

* the IP-keyed ``login`` scope (#770) — bounds password guessing per source IP;
* the account-keyed ``login_account`` scope (#1717) — bounds guessing per
  *account* (hashed username) across ALL source IPs, closing the distributed
  credential-stuffing gap where a rotating IP pool gets the full per-IP allowance
  from every fresh IP.

Both must pass for a request to reach authentication. A rejected login also emits
an ``auth.login_failed`` audit event so operators can alarm on stuffing bursts.
"""

from __future__ import annotations

import logging

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

User = get_user_model()

_LOGIN_URL = "/api/v1/auth/token/"


@pytest.mark.django_db
def test_login_endpoint_throttles_after_ip_rate_limit() -> None:
    """The IP-keyed ``login`` scope (10/min) still bounds guesses per source IP.

    Uses a *different* username on every attempt so the per-account throttle is
    never the limiter — this isolates the IP throttle. All 11 requests share one
    REMOTE_ADDR, so the 11th trips the 10/min ``login`` cap.
    """
    cache.clear()
    try:
        client = APIClient()
        statuses = [
            client.post(
                _LOGIN_URL,
                {"username": f"ip_probe_{i}", "password": "wrong"},
                format="json",
                REMOTE_ADDR="203.0.113.9",
            ).status_code
            for i in range(11)
        ]

        assert statuses[:10] == [401] * 10
        assert statuses[10] == 429
    finally:
        cache.clear()


@pytest.mark.django_db
def test_login_endpoint_throttles_per_account_across_distinct_ips() -> None:
    """The per-account throttle catches distributed stuffing the IP throttle can't.

    All six attempts target ONE username but each comes from a distinct source IP,
    so the IP-keyed ``login`` throttle (10/min per IP) never trips — each IP makes
    a single request. The ``login_account`` throttle (5/min per hashed username)
    is the only thing that can stop this, and it does: the 6th attempt is 429.
    """
    cache.clear()
    try:
        User.objects.create_user(username="victim", password="correct-horse")
        client = APIClient()

        statuses = [
            client.post(
                _LOGIN_URL,
                {"username": "victim", "password": "wrong"},
                format="json",
                # A fresh IP for every attempt — the IP throttle sees one hit each.
                REMOTE_ADDR=f"198.51.100.{i}",
            ).status_code
            for i in range(6)
        ]

        assert statuses[:5] == [401] * 5, "IP throttle must not fire — distinct IPs"
        assert statuses[5] == 429, "per-account throttle must lock the account out"
    finally:
        cache.clear()


@pytest.mark.django_db
def test_login_account_throttle_keys_on_username_not_shared() -> None:
    """One account's failures do not throttle a *different* account, nor a success.

    Four failed attempts on ``account_a`` (under the 5/min per-account cap) leave
    both a correct-password login for ``account_a`` and any attempt on
    ``account_b`` unaffected — the per-account buckets are independent.
    """
    cache.clear()
    try:
        User.objects.create_user(username="account_a", password="correct-horse-a")
        User.objects.create_user(username="account_b", password="correct-horse-b")
        client = APIClient()

        # Four wrong guesses on account_a (bucket now at 4, under the 5 cap).
        for i in range(4):
            resp = client.post(
                _LOGIN_URL,
                {"username": "account_a", "password": "wrong"},
                format="json",
                REMOTE_ADDR=f"192.0.2.{i}",
            )
            assert resp.status_code == 401

        # A correct login for account_a still succeeds (5th hit, still <= cap).
        ok = client.post(
            _LOGIN_URL,
            {"username": "account_a", "password": "correct-horse-a"},
            format="json",
            REMOTE_ADDR="192.0.2.50",
        )
        assert ok.status_code == 200

        # account_b is on its own bucket — unaffected by account_a's failures.
        other = client.post(
            _LOGIN_URL,
            {"username": "account_b", "password": "correct-horse-b"},
            format="json",
            REMOTE_ADDR="192.0.2.51",
        )
        assert other.status_code == 200
    finally:
        cache.clear()


@pytest.mark.django_db
def test_failed_login_emits_auth_failure_audit_event(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A rejected login emits an ``auth.login_failed`` event on ``trueppm.auth``.

    The event carries the *hashed* username (never the raw email/credential) plus
    the client IP so operators can alarm on credential-stuffing bursts.
    """
    cache.clear()
    try:
        User.objects.create_user(username="alarmed", password="correct-horse")
        client = APIClient()

        with caplog.at_level(logging.WARNING, logger="trueppm.auth"):
            resp = client.post(
                _LOGIN_URL,
                {"username": "alarmed", "password": "wrong"},
                format="json",
                REMOTE_ADDR="203.0.113.7",
            )

        assert resp.status_code == 401
        records = [r for r in caplog.records if "auth.login_failed" in r.getMessage()]
        assert records, "expected an auth.login_failed audit event"
        message = records[0].getMessage()
        assert "username_hash=" in message
        assert "client_ip=203.0.113.7" in message
        # The raw username must never appear in the audit log line.
        assert "alarmed" not in message
    finally:
        cache.clear()
