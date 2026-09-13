"""Django admin is off by default, and defended when an operator turns it on (#3557).

``/admin/login/`` was a second password door onto the same account store as
``POST /api/v1/auth/token/``, with none of that door's controls: DRF throttles do
not apply to a plain Django view, the ``auth.login_*`` audit lines are emitted by
our own login view, and the enterprise ``local_login_allowed`` seam is consulted
there. ``create_admin`` makes a superuser on first deploy, so an exposed
``/admin/`` was an unthrottled, unrecorded guessing surface against a
known-present privileged account.

Both halves of the fix are asserted here: the surface answers ``404`` unless
``TRUEPPM_DJANGO_ADMIN_ENABLED`` is set, and when it is set, the login carries the
API login's two throttle buckets, its two audit lines, and its policy seam.

The tests run under ``settings/dev.py``, which defaults the flag **on** — the
developer-workstation position — so the disabled case is the one that has to say
so explicitly with ``override_settings``.
"""

from __future__ import annotations

import hashlib
import logging

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import Client, override_settings
from rest_framework.test import APIClient

import trueppm_api.settings.base as base_settings

User = get_user_model()

_ADMIN_LOGIN_URL = "/admin/login/"
_ADMIN_INDEX_URL = "/admin/"
_API_LOGIN_URL = "/api/v1/auth/token/"
_PASSWORD = "correct-horse-battery-staple"
_LOGGER = "trueppm.auth"


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    """Both login throttles are cache-backed; isolate their history between tests."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def superuser(db: object):
    return User.objects.create_superuser(
        username="site_admin", email="site_admin@example.com", password=_PASSWORD
    )


def _lines(caplog: pytest.LogCaptureFixture, verb: str) -> list[str]:
    return [r.getMessage() for r in caplog.records if verb in r.getMessage()]


def _hashed(identifier: str) -> str:
    return hashlib.sha256(identifier.strip().lower().encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# (a) Off by default
# ---------------------------------------------------------------------------


def test_base_settings_default_the_admin_off() -> None:
    """The shipped default is OFF; only ``settings/dev.py`` turns it back on.

    Asserted against the ``base`` module rather than ``django.conf.settings``,
    because the suite runs under ``dev``, whose override would otherwise hide a
    regression in the default every production deploy inherits.
    """
    assert base_settings.DJANGO_ADMIN_ENABLED is False


@override_settings(DJANGO_ADMIN_ENABLED=False)
@pytest.mark.parametrize("url", [_ADMIN_INDEX_URL, _ADMIN_LOGIN_URL])
@pytest.mark.django_db  # ATOMIC_REQUESTS opens a transaction before the view runs
def test_admin_paths_404_when_disabled(url: str) -> None:
    """404, not 403 — a 403 confirms the path exists."""
    assert Client().get(url).status_code == 404


@override_settings(DJANGO_ADMIN_ENABLED=False)
@pytest.mark.django_db
def test_correct_credentials_do_not_log_in_when_the_admin_is_disabled(superuser) -> None:
    """The disabled check runs before authentication, so valid credentials 404 too.

    The falsifiable half of the flag: a guard that only hid the *login page* while
    still processing a POST would mint a session for anyone who knew the form's
    field names.
    """
    client = Client()
    resp = client.post(
        _ADMIN_LOGIN_URL, {"username": "site_admin", "password": _PASSWORD}, REMOTE_ADDR="10.0.0.1"
    )

    assert resp.status_code == 404
    assert "_auth_user_id" not in client.session


@override_settings(DJANGO_ADMIN_ENABLED=False)
@pytest.mark.django_db
def test_a_model_admin_url_404s_rather_than_redirecting_to_the_login_page() -> None:
    """The guard is the OUTER wrapper on ``admin_view``, and that ordering matters.

    Django's own `admin_view` wrapper redirects an unauthenticated caller to
    `/admin/login/`. If the disabled check ran inside that, a probe of any admin
    URL would answer `302 → /admin/login/` and advertise the door the flag exists
    to remove. Asserted on a `ModelAdmin` URL (`django.contrib.auth`'s, registered
    by `autodiscover`) rather than a site-level one, because `ModelAdmin.get_urls`
    reaches `admin_view` by a different route than `AdminSite.get_urls` does.
    """
    resp = Client().get("/admin/auth/user/")

    assert resp.status_code == 404
    assert "Location" not in resp


@pytest.mark.django_db
def test_admin_login_page_renders_when_enabled() -> None:
    """dev settings default the flag on, so the page is reachable with no override."""
    assert Client().get(_ADMIN_LOGIN_URL).status_code == 200


@pytest.mark.django_db
def test_an_enabled_model_admin_url_still_redirects_an_anonymous_caller_to_login() -> None:
    """The negative control for the test above: the guard must not change this.

    Wrapping `admin_view` could plausibly have broken Django's own
    "not signed in → go to the login page" behavior. With the admin enabled it is
    unchanged.
    """
    resp = Client().get("/admin/auth/user/")

    assert resp.status_code == 302
    assert _ADMIN_LOGIN_URL in resp["Location"]


# ---------------------------------------------------------------------------
# (b) Audit lines on the enabled door
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_failed_admin_login_emits_the_same_audit_line_as_the_api(
    superuser, caplog: pytest.LogCaptureFixture
) -> None:
    """One ``auth.login_failed``, hashed identifier, real client IP.

    Same verb and same fields as the API login's refusal, because an operator
    alarming on a credential-stuffing burst must not have to know which door the
    attempts arrived at.
    """
    caplog.set_level(logging.INFO, logger=_LOGGER)
    resp = Client().post(
        _ADMIN_LOGIN_URL,
        {"username": "site_admin", "password": "wrong"},
        REMOTE_ADDR="203.0.113.11",
    )

    assert resp.status_code == 200  # the form re-renders with an error
    failures = _lines(caplog, "auth.login_failed")
    assert len(failures) == 1
    assert f"username_hash={_hashed('site_admin')}" in failures[0]
    assert "client_ip=203.0.113.11" in failures[0]
    assert "site_admin" not in failures[0]  # never in the clear


@pytest.mark.django_db
def test_successful_admin_login_emits_a_success_line_naming_the_admin_door(
    superuser, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger=_LOGGER)
    client = Client()
    resp = client.post(
        _ADMIN_LOGIN_URL,
        {"username": "site_admin", "password": _PASSWORD},
        REMOTE_ADDR="203.0.113.12",
    )

    assert resp.status_code == 302
    assert client.session["_auth_user_id"] == str(superuser.pk)
    successes = _lines(caplog, "auth.login_succeeded")
    assert len(successes) == 1
    assert f"user_id={superuser.pk}" in successes[0]
    assert "method=admin" in successes[0]
    assert "client_ip=203.0.113.12" in successes[0]


# ---------------------------------------------------------------------------
# (b) Throttles on the enabled door
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_admin_login_and_api_login_share_one_ip_bucket(superuser) -> None:
    """The two doors must not each hand out a full ``login`` allowance.

    Spends the 10/min IP budget entirely on ``/api/v1/auth/token/`` — a different
    username each time so the per-account throttle is never the limiter — then
    knocks on ``/admin/login/`` from the same address. A per-door bucket would
    serve that request and give an attacker ``2 x`` the guesses the ``login`` rate
    is written to permit.
    """
    api = APIClient()
    for i in range(10):
        resp = api.post(
            _API_LOGIN_URL,
            {"username": f"ip_probe_{i}", "password": "wrong"},
            format="json",
            REMOTE_ADDR="203.0.113.20",
        )
        assert resp.status_code == 401

    refused = Client().post(
        _ADMIN_LOGIN_URL,
        {"username": "site_admin", "password": _PASSWORD},
        REMOTE_ADDR="203.0.113.20",
    )

    assert refused.status_code == 429
    assert refused["Retry-After"]


@pytest.mark.django_db
def test_admin_login_locks_out_an_account_across_distinct_source_ips(superuser) -> None:
    """The per-account (5/min) bucket applies to the admin door too.

    Every attempt comes from a fresh IP, so the IP throttle is never the limiter —
    this isolates the cross-IP credential-stuffing bound that #1717 added for the
    API and that the bare admin view had no share of.
    """
    statuses = [
        Client()
        .post(
            _ADMIN_LOGIN_URL,
            {"username": "site_admin", "password": "wrong"},
            REMOTE_ADDR=f"198.51.100.{i}",
        )
        .status_code
        for i in range(6)
    ]

    assert statuses[:5] == [200] * 5
    assert statuses[5] == 429


@pytest.mark.django_db
def test_a_throttled_admin_attempt_is_still_audited(
    superuser, caplog: pytest.LogCaptureFixture
) -> None:
    """A 429 is a refused login attempt and must appear in the audit stream.

    The burst is exactly what an operator alarms on, so it would be perverse for
    the throttle to silence the very attempts that tripped it.
    """
    caplog.set_level(logging.INFO, logger=_LOGGER)
    for i in range(6):
        Client().post(
            _ADMIN_LOGIN_URL,
            {"username": "site_admin", "password": "wrong"},
            REMOTE_ADDR=f"198.51.100.{100 + i}",
        )

    assert len(_lines(caplog, "auth.login_failed")) == 6


# ---------------------------------------------------------------------------
# (b) The enterprise policy seam
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_local_login_policy_seam_refuses_the_admin_door_too(
    superuser, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Enforced org-wide SSO must not be bypassable through ``/admin/login/``.

    ``local_login_allowed`` is what an enterprise policy hangs "disable local
    accounts" off. The seam is consulted *after* credentials validate (checking it
    earlier would answer "does this account exist and is it SSO-only?" to an
    unauthenticated caller), which means Django has already established the session
    by the time we refuse — so the assertion that matters is that the session is
    gone again, not merely that the status is 403.
    """
    monkeypatch.setattr("trueppm_api.apps.sso.extensions.local_login_allowed", lambda _u: False)

    caplog.set_level(logging.INFO, logger=_LOGGER)
    client = Client()
    resp = client.post(
        _ADMIN_LOGIN_URL, {"username": "site_admin", "password": _PASSWORD}, REMOTE_ADDR="10.0.0.2"
    )

    assert resp.status_code == 403
    assert "_auth_user_id" not in client.session
    assert _lines(caplog, "auth.login_succeeded") == [], (
        "a login the policy seam refused must emit no success line"
    )
