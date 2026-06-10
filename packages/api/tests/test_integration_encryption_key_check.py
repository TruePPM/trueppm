"""Tests for the INTEGRATION_ENCRYPTION_KEY boot validation (#1002).

Mirrors the SECRET_KEY hardening check: the same pure
``validate_integration_encryption_key`` function backs both the
``manage.py check --deploy`` system check and the import-time guard in
``settings/prod.py``, so the unit tests exercise the function directly and one
test confirms the system-check entry point is registered.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from django.core.checks import Error, registry

from trueppm_api.core.security_checks import (
    check_integration_encryption_key,
    validate_integration_encryption_key,
)


def _valid_key() -> str:
    return Fernet.generate_key().decode()


def test_debug_empty_key_is_allowed() -> None:
    """Dev / CI keep booting with no (or a placeholder) key under DEBUG."""
    assert validate_integration_encryption_key("", debug=True) == []


def test_valid_key_passes_in_prod() -> None:
    assert validate_integration_encryption_key(_valid_key(), debug=False) == []


def test_empty_key_fails_in_prod() -> None:
    errors = validate_integration_encryption_key("", debug=False)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E005"


def test_none_key_fails_in_prod() -> None:
    errors = validate_integration_encryption_key(None, debug=False)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E005"


def test_short_key_fails_in_prod() -> None:
    """A truncated value is not a valid 32-byte urlsafe-base64 Fernet key."""
    errors = validate_integration_encryption_key("too-short", debug=False)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E006"


def test_malformed_key_fails_in_prod() -> None:
    """Right length, wrong alphabet/padding — Fernet rejects it."""
    errors = validate_integration_encryption_key("!" * 44, debug=False)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E006"


def test_system_check_is_registered_under_security_deploy_tag() -> None:
    registered = registry.registry.get_checks(include_deployment_checks=True)
    assert check_integration_encryption_key in registered
    assert "security" in check_integration_encryption_key.tags  # type: ignore[attr-defined]


def test_system_check_reads_live_settings(settings: pytest.FixtureRequest) -> None:
    """Under DEBUG the check returns clean even with an empty key."""
    settings.DEBUG = True  # type: ignore[attr-defined]
    settings.INTEGRATION_ENCRYPTION_KEY = ""  # type: ignore[attr-defined]
    assert check_integration_encryption_key() == []


def test_system_check_flags_missing_key_when_debug_off(
    settings: pytest.FixtureRequest,
) -> None:
    settings.DEBUG = False  # type: ignore[attr-defined]
    settings.INTEGRATION_ENCRYPTION_KEY = ""  # type: ignore[attr-defined]
    errors = check_integration_encryption_key()
    assert errors
    assert all(isinstance(e, Error) for e in errors)
