"""Token refresh and password login racing a password reset (#4846).

#4839 serialized durable-grant mints against a reset through a ``UserProfile`` row
lock. Refresh and password login read the cutoff without it, so a pair could be minted
from a pre-reset credential after the reset's stamp. Both now take the same lock
(``lock_profile_and_read_cutoff``) and re-check against the locked row.

Two real connections (threads), ordered with events and a ``pg_stat_activity`` wait
probe, never sleeps:

- **reset first** — the reset has stamped and swept and holds its transaction open; the
  refresh or login (which passed its read before the cutoff was visible) blocks on the
  lock, then is refused with a 401 and sets no cookie.
- **session first** — the refresh or login holds the lock mid-request; the reset must
  wait for it.

Negative control: removing the lock call from either path turns the reset-first test
red (the request returns 200 and sets a cookie).
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from contextlib import nullcontext
from typing import Any
from unittest.mock import patch

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connections
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from trueppm_api.apps.profiles.models import UserProfile

from .test_mint_vs_reset_race import (
    _CONFIRM_URL,
    _EVICT,
    _NEW_PASSWORD,
    _TIMEOUT,
    _join,
    _Reset,
    _wait_until_blocked_or_done,
)

User = get_user_model()

pytestmark = pytest.mark.django_db(transaction=True)

_AV = "trueppm_api.core.auth_views"
_LOGIN = "/api/v1/auth/token/"
_REFRESH = "/api/v1/auth/token/refresh/"


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user() -> Any:
    return User.objects.create_user(username="sess_user", email="sess@example.com", password="pw")


def _refresh_call(user: Any) -> Callable[[APIClient], Any]:
    raw = str(RefreshToken.for_user(user))

    def _call(client: APIClient) -> Any:
        client.cookies[settings.AUTH_REFRESH_COOKIE_NAME] = raw
        return client.post(_REFRESH, {}, format="json")

    return _call


def _login_call(_user: Any) -> Callable[[APIClient], Any]:
    return lambda c: c.post(_LOGIN, {"username": "sess_user", "password": "pw"}, format="json")


# kind -> (call factory, module attribute the view uses to take the lock)
_PATHS: dict[str, tuple[Callable[[Any], Callable[[APIClient], Any]], str]] = {
    "refresh": (_refresh_call, "trueppm_api.core.credential_cutoff.lock_profile_and_read_cutoff"),
    "login": (_login_call, "trueppm_api.core.credential_cutoff.lock_profile_and_read_cutoff"),
}


def _run(call: Callable[[APIClient], Any], out: dict[str, Any]) -> None:
    try:
        out["resp"] = call(APIClient())
    finally:
        connections.close_all()


def _has_session_cookie(resp: Any) -> bool:
    morsel = resp.cookies.get(settings.AUTH_REFRESH_COOKIE_NAME)
    return bool(morsel and morsel.value)


def _import_lock() -> Callable[[Any], Any]:
    from trueppm_api.core.credential_cutoff import lock_profile_and_read_cutoff

    return lock_profile_and_read_cutoff


@pytest.mark.parametrize("profile_exists", [False, True], ids=["new-profile", "existing-profile"])
@pytest.mark.parametrize("kind", ["refresh", "login"])
def test_session_that_read_before_a_reset_commits_is_refused(
    kind: str, profile_exists: bool, user: Any
) -> None:
    """Reset swept and still open: the refresh/login blocks on the lock, then gets a 401.

    With an existing profile row the only thing that can park the request is
    ``FOR UPDATE`` (a missing row parks it on the INSERT's unique key instead), so that
    variant is the one that fails if the lock is dropped.
    """
    if profile_exists:
        UserProfile.objects.create(user=user)
    call = _PATHS[kind][0](user)
    reset = _Reset(user, "view")
    with patch(_EVICT, reset.hook()):
        resetter = reset.start()
        assert reset.swept.wait(_TIMEOUT), "the reset never reached its commit point"
        out: dict[str, Any] = {}
        worker = threading.Thread(target=_run, args=(call, out))
        worker.start()
        _wait_until_blocked_or_done(worker)
        reset.hold.set()
        _join(resetter, worker)
    resp = out["resp"]
    assert resp.status_code == 401, (kind, resp.status_code, getattr(resp, "data", None))
    assert not _has_session_cookie(resp)


@pytest.mark.parametrize(
    "skew_margin_s",
    [None, -3600],
    ids=["cutoff-covers-pair", "hash-only"],
)
def test_login_that_verified_the_password_before_a_reset_is_refused(
    skew_margin_s: int | None, user: Any, caplog: pytest.LogCaptureFixture
) -> None:
    """The password check ran (and a pair was minted) before the reset committed.

    The login is parked between credential validation and the lock; the reset runs to
    completion in this thread; the login then locks, sees the changed password hash and
    refuses, so the pre-reset password cannot yield a session after the reset.

    The default variant is refused by *either* check (the reset commits within ms, so
    the pair's ``iat`` is at or before the cutoff). The ``hash-only`` variant shifts
    the stored cutoff an hour into the past, so the pair's ``iat`` postdates it and the
    password-hash comparison is the only branch that can refuse. The refusal also
    emits the ``auth.login_failed`` audit event like every other 401 on this view.
    """
    from datetime import timedelta

    from trueppm_api.core.auth_views import _refuse_login_raced_by_reset as real

    authed, go = threading.Event(), threading.Event()

    def _park(request: Any, u: Any, token: Any) -> None:
        authed.set()
        assert go.wait(_TIMEOUT)
        real(request, u, token)

    reset = _Reset(user, "view")
    reset.hold.set()
    out: dict[str, Any] = {}
    margin = (
        patch(
            "trueppm_api.core.credential_cutoff.CLOCK_SKEW_MARGIN",
            timedelta(seconds=skew_margin_s),
        )
        if skew_margin_s is not None
        else nullcontext()
    )
    with caplog.at_level("WARNING"), patch(f"{_AV}._refuse_login_raced_by_reset", _park), margin:
        worker = threading.Thread(target=_run, args=(_login_call(user), out))
        worker.start()
        assert authed.wait(_TIMEOUT), "the login never passed credential validation"
        resp = APIClient().post(
            _CONFIRM_URL,
            {"uid": reset._uid, "token": reset._token, "new_password": _NEW_PASSWORD},
            format="json",
        )
        assert resp.status_code == 200, resp.data
        go.set()
        _join(worker)
    if skew_margin_s is not None:
        cutoff = UserProfile.objects.get(user=user).credentials_revoked_at
        assert cutoff is not None
        assert cutoff.timestamp() < RefreshToken.for_user(user).payload["iat"] - 60, (
            "the cutoff must predate the pair's iat so only the hash check can refuse"
        )
    assert out["resp"].status_code == 401
    assert not _has_session_cookie(out["resp"])
    assert "auth.login_failed" in caplog.text


@pytest.mark.parametrize("kind", ["refresh", "login"])
def test_reset_waits_for_an_in_flight_session_mint(kind: str, user: Any) -> None:
    """The refresh/login holds the profile lock mid-request; the reset must wait."""
    UserProfile.objects.create(user=user)
    call = _PATHS[kind][0](user)
    real = _import_lock()
    locked, proceed = threading.Event(), threading.Event()

    def _pause_after_lock(u: Any) -> Any:
        cutoff = real(u)
        locked.set()
        assert proceed.wait(_TIMEOUT)
        return cutoff

    reset = _Reset(user, "view")
    reset.hold.set()
    out: dict[str, Any] = {}
    with patch(_PATHS[kind][1], _pause_after_lock), patch(_EVICT, reset.hook()):
        worker = threading.Thread(target=_run, args=(call, out))
        worker.start()
        assert locked.wait(_TIMEOUT), "the session path never reached its lock"
        resetter = reset.start()
        blocked = _wait_until_blocked_or_done(resetter)
        assert blocked and resetter.is_alive(), "the reset did not wait for the session mint"
        proceed.set()
        _join(worker, resetter)
    assert out["resp"].status_code == 200, getattr(out["resp"], "data", None)
    assert reset.status == 200
    # The pair was minted while the lock was held, so the reset's cutoff (stamped after)
    # covers it: the authenticator refuses it.
    access = out["resp"].data["access"]
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    assert client.get("/api/v1/auth/me/").status_code == 401


def test_refresh_and_revoke_api_tokens_do_not_deadlock(user: Any) -> None:
    """``revoke_api_tokens`` (the realistic off-boarding lock-taker) vs an in-flight refresh.

    Both take the profile row lock and both touch the same ``OutstandingToken`` row
    (the refresh rotates the token the command blacklists), so a lock-order inversion
    would deadlock. The refresh parks holding the profile lock; the command must wait
    on it (``pg_stat_activity`` probe) and, once released, both finish inside the
    bounded joins, with the command having seen the refresh's new pair.
    """
    UserProfile.objects.create(user=user)
    call = _refresh_call(user)
    real = _import_lock()
    locked, proceed = threading.Event(), threading.Event()

    def _pause_after_lock(u: Any) -> Any:
        cutoff = real(u)
        locked.set()
        assert proceed.wait(_TIMEOUT)
        return cutoff

    revoke = _Reset(user, "command")
    revoke.hold.set()
    out: dict[str, Any] = {}
    with patch(_PATHS["refresh"][1], _pause_after_lock), patch(_EVICT, revoke.hook()):
        worker = threading.Thread(target=_run, args=(call, out))
        worker.start()
        assert locked.wait(_TIMEOUT), "the refresh never reached its lock"
        revoker = revoke.start()
        blocked = _wait_until_blocked_or_done(revoker)
        assert blocked and revoker.is_alive(), "the revoke did not wait for the refresh"
        proceed.set()
        _join(worker, revoker)
    assert out["resp"].status_code == 200, getattr(out["resp"], "data", None)
    assert revoke.status == 0
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {out['resp'].data['access']}")
    assert client.get("/api/v1/auth/me/").status_code == 401


def test_refresh_after_an_old_cutoff_still_works(user: Any) -> None:
    """The lock must not lock out a refresh whose token postdates a stale cutoff."""
    from datetime import timedelta

    from django.utils import timezone

    from trueppm_api.core.credential_cutoff import mark_credentials_revoked

    mark_credentials_revoked(user, at=timezone.now() - timedelta(seconds=30))
    resp = _refresh_call(user)(APIClient())
    assert resp.status_code == 200, resp.data
    assert _login_call(user)(APIClient()).status_code == 200
