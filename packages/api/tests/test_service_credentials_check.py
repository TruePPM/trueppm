"""Tests for the datastore-credential hardening check (#3176).

The gap this closes: ``SECRET_KEY`` (#566), the attachment backend (#775), the
integration encryption key (#1002) and ``sslmode`` (#1550) all refuse to boot when
misconfigured, but the database and cache passwords were only ever checked for
*presence* — by compose's ``${DB_PASSWORD:?...}``, which the ``change-me`` string
shipped in ``.env.example`` satisfies.

Same two callers as its siblings: the Django system-check registry and an explicit
import-time guard in ``settings/prod.py``. Both call the pure
``validate_service_credentials``, so these exercise that directly.
"""

from __future__ import annotations

from unittest import mock

import pytest
from django.conf import settings as django_settings
from django.core.checks import registry

from trueppm_api.core.security_checks import (
    MIN_SERVICE_PASSWORD_LENGTH,
    PLACEHOLDER_SERVICE_PASSWORDS,
    check_service_credentials,
    validate_service_credentials,
)

STRONG = "x7Qv2mKp9wLbR4tZ"


def test_strong_passwords_pass() -> None:
    assert validate_service_credentials(STRONG, STRONG, debug=False) == []


@pytest.mark.parametrize("placeholder", sorted(PLACEHOLDER_SERVICE_PASSWORDS))
def test_every_placeholder_is_rejected(placeholder: str) -> None:
    errors = validate_service_credentials(placeholder, STRONG, debug=False)
    assert [e.id for e in errors] == ["trueppm.E010"]


def test_the_env_example_placeholder_specifically() -> None:
    """The exact string .env.example shipped — the whole reason this check exists."""
    errors = validate_service_credentials("change-me", "change-me", debug=False)
    assert {e.id for e in errors} == {"trueppm.E010", "trueppm.E011"}


def test_placeholder_match_is_case_insensitive() -> None:
    errors = validate_service_credentials("Change-Me", STRONG, debug=False)
    assert [e.id for e in errors] == ["trueppm.E010"]


def test_short_password_is_rejected() -> None:
    short = "a" * (MIN_SERVICE_PASSWORD_LENGTH - 1)
    errors = validate_service_credentials(STRONG, short, debug=False)
    assert [e.id for e in errors] == ["trueppm.E011"]


def test_password_at_the_minimum_length_passes() -> None:
    assert validate_service_credentials("b" * MIN_SERVICE_PASSWORD_LENGTH, None, debug=False) == []


@pytest.mark.parametrize("absent", [None, ""])
def test_absent_password_is_not_this_checks_business(absent: str | None) -> None:
    """Trust auth (Unix socket, IAM, cert) has no password to weaken.

    Flagging it would fail a legitimate managed-database posture, and the credential
    that is actually missing is not one this check can see.
    """
    assert validate_service_credentials(absent, absent, debug=False) == []


def test_debug_short_circuits() -> None:
    """Developer workstations keep booting on the base.py defaults, like every sibling."""
    assert validate_service_credentials("change-me", "change-me", debug=True) == []


def test_both_credentials_are_reported_independently() -> None:
    """One bad credential must not mask the other — an operator fixing serially
    would otherwise need two deploy cycles to find out."""
    errors = validate_service_credentials("change-me", "short", debug=False)
    assert [e.id for e in errors] == ["trueppm.E010", "trueppm.E011"]


def test_system_check_is_registered_under_the_security_tag() -> None:
    assert check_service_credentials in registry.registry.get_checks(include_deployment_checks=True)


def test_system_check_reads_live_settings(settings: pytest.FixtureRequest) -> None:
    """The entry point reads DATABASES/REDIS_URL/DEBUG off django.conf.settings.

    The pure validator above is exercised directly; this proves the check actually
    pulls the two credentials out of live settings, which is the half a wrong
    attribute name would silently break while every validator test stayed green.

    ``DATABASES["default"]`` is patched in place rather than reassigned: replacing
    the whole setting makes Django warn and drops the configured connections.
    """
    settings.DEBUG = False  # type: ignore[attr-defined]
    settings.REDIS_URL = "redis://:change-me@valkey:6379/0"  # type: ignore[attr-defined]
    with mock.patch.dict(django_settings.DATABASES["default"], {"PASSWORD": "change-me"}):
        assert [e.id for e in check_service_credentials()] == ["trueppm.E010", "trueppm.E011"]


def test_system_check_passes_on_strong_live_credentials(
    settings: pytest.FixtureRequest,
) -> None:
    settings.DEBUG = False  # type: ignore[attr-defined]
    settings.REDIS_URL = f"redis://:{STRONG}@valkey:6379/0"  # type: ignore[attr-defined]
    with mock.patch.dict(django_settings.DATABASES["default"], {"PASSWORD": STRONG}):
        assert check_service_credentials() == []


def test_system_check_tolerates_credentials_being_absent(
    settings: pytest.FixtureRequest,
) -> None:
    """Trust auth and an unauthenticated cache leave both lookups empty.

    The getattr/or defaults must absorb that rather than raising inside a check
    whose whole job is to report, not to crash the checks run.
    """
    settings.DEBUG = False  # type: ignore[attr-defined]
    settings.REDIS_URL = ""  # type: ignore[attr-defined]
    with mock.patch.dict(django_settings.DATABASES["default"], {"PASSWORD": None}):
        assert check_service_credentials() == []
