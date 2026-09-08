"""Login-success logging tests (#3552, ADR-1120).

The auth surface recorded refusals (``auth.login_failed``) and no successes, so an
incident review could see a brute-force burst and not the login that ended it. ADR-1120
routes login success to a structured ``trueppm.auth`` line rather than an ``AuditEvent``
row: its rate is set by request traffic, and the OSS audit table has no retention.

The load-bearing test here is **not** the happy path. It is
``test_no_success_line_when_the_password_login_policy_seam_refuses``: "credentials
validated" is not where a login succeeds, because the enterprise ``local_login_allowed``
seam runs afterwards and can still return a 403 with no session. A line emitted at the
validation point would report a success for a refused request — inverting exactly the
signal an operator alarms on.

``caplog.set_level(..., logger="trueppm.auth")`` is required on every test: ``settings/
dev.py`` (which pytest uses) replaces ``LOGGING`` with a root handler at ``WARNING``, so
an ``INFO`` record is dropped before it reaches any handler unless the level is raised
explicitly.
"""

from __future__ import annotations

import logging

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

User = get_user_model()

_LOGIN_URL = "/api/v1/auth/token/"
_PASSWORD = "correct-horse-battery-staple"
_LOGGER = "trueppm.auth"


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    """Both login throttles are cache-backed; isolate their history between tests."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def user(db: object):
    return User.objects.create_user(
        username="login_success_user", email="lsu@example.com", password=_PASSWORD
    )


def _success_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if "auth.login_succeeded" in r.getMessage()]


@pytest.mark.django_db
def test_password_login_emits_one_success_line_with_every_field(
    user, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger=_LOGGER)
    resp = APIClient().post(
        _LOGIN_URL,
        {"username": "login_success_user", "password": _PASSWORD},
        format="json",
        REMOTE_ADDR="203.0.113.7",
    )

    assert resp.status_code == 200
    lines = _success_lines(caplog)
    assert len(lines) == 1
    line = lines[0]
    assert f"user_id={user.pk}" in line
    assert "method=password" in line
    assert "client_ip=203.0.113.7" in line
    assert "remember=False" in line


@pytest.mark.django_db
def test_success_line_carries_the_pk_never_the_username_or_email(
    user, caplog: pytest.LogCaptureFixture
) -> None:
    """The identifier must not appear in the clear.

    ``auth.login_failed`` hashes the submitted identifier rather than logging it, and
    ``_require_active`` logs ``user.pk``. A success line that wrote the email would put
    a credential-adjacent identifier into a stream that leaves TruePPM's control.
    """
    caplog.set_level(logging.INFO, logger=_LOGGER)
    APIClient().post(
        _LOGIN_URL,
        {"username": "login_success_user", "password": _PASSWORD},
        format="json",
    )

    line = _success_lines(caplog)[0]
    assert "lsu@example.com" not in line
    assert "login_success_user" not in line
    assert _PASSWORD not in line


@pytest.mark.django_db
def test_remember_me_is_reflected_in_the_line(user, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=_LOGGER)
    APIClient().post(
        _LOGIN_URL,
        {"username": "login_success_user", "password": _PASSWORD, "remember_me": True},
        format="json",
    )

    assert "remember=True" in _success_lines(caplog)[0]


@pytest.mark.django_db
def test_login_by_email_identifier_still_emits_one_success_line(
    user, caplog: pytest.LogCaptureFixture
) -> None:
    """The #3468 email fallback re-validates through the same serializer, so the line
    must be emitted exactly once — not once per validation attempt."""
    caplog.set_level(logging.INFO, logger=_LOGGER)
    resp = APIClient().post(
        _LOGIN_URL,
        {"username": "lsu@example.com", "password": _PASSWORD},
        format="json",
    )

    assert resp.status_code == 200
    assert len(_success_lines(caplog)) == 1


@pytest.mark.django_db
def test_failed_login_emits_no_success_line(user, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=_LOGGER)
    resp = APIClient().post(
        _LOGIN_URL,
        {"username": "login_success_user", "password": "wrong-password-entirely"},
        format="json",
    )

    assert resp.status_code == 401
    assert _success_lines(caplog) == []
    # The pre-existing failure line is unchanged.
    assert any("auth.login_failed" in r.getMessage() for r in caplog.records)


@pytest.mark.django_db
def test_no_success_line_when_the_password_login_policy_seam_refuses(
    user, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The falsifiable test for the call site (ADR-1120).

    ``local_login_allowed`` is the enterprise seam that blocks password sign-in for an
    account under enforced org-wide SSO. It runs **after** credentials validate, so a
    login with entirely correct credentials still ends in a 403 with no cookie. A
    success line emitted at the validation point would claim that login succeeded.
    """
    # The view imports this lazily inside ``post``, so patching the attribute on the
    # extensions module is what the call site actually resolves.
    monkeypatch.setattr("trueppm_api.apps.sso.extensions.local_login_allowed", lambda _u: False)

    caplog.set_level(logging.INFO, logger=_LOGGER)
    resp = APIClient().post(
        _LOGIN_URL,
        {"username": "login_success_user", "password": _PASSWORD},
        format="json",
    )

    assert resp.status_code == 403, resp.data
    assert _success_lines(caplog) == [], (
        "a login refused by the password-login policy seam must emit no success line"
    )
