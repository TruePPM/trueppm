"""Tests for the dedicated JWT ``SIGNING_KEY`` hardening check (#2247).

``JWT_SIGNING_KEY`` defaults to ``SECRET_KEY`` (single-knob install). When set
to a *distinct* value it must meet the same strength bar as ``SECRET_KEY``, or a
separate-but-weak signing key would defeat the point of separating it. The check
deliberately returns clean when the signing key is unset or equal to
``SECRET_KEY`` (that value is already validated by ``validate_secret_key``), so
these tests assert both the pass-through cases and the distinct-weak-key cases.
"""

from __future__ import annotations

import pytest
from django.core.checks import Error, registry

from trueppm_api.core.security_checks import (
    INSECURE_PREFIX,
    MIN_SECRET_KEY_LENGTH,
    check_signing_key,
    validate_signing_key,
)

_STRONG = "a" * MIN_SECRET_KEY_LENGTH
_OTHER_STRONG = "b" * MIN_SECRET_KEY_LENGTH


def test_debug_short_signing_key_is_allowed() -> None:
    """Developer workstations keep booting regardless of the signing key."""
    assert validate_signing_key("x", "y", debug=True) == []


def test_unset_signing_key_passes() -> None:
    """Unset (None) inherits SECRET_KEY, already validated elsewhere."""
    assert validate_signing_key(None, _STRONG, debug=False) == []


def test_signing_key_equal_to_secret_key_passes() -> None:
    """Equal to SECRET_KEY → covered by validate_secret_key, no double-report."""
    assert validate_signing_key(_STRONG, _STRONG, debug=False) == []


def test_distinct_strong_signing_key_passes() -> None:
    assert validate_signing_key(_OTHER_STRONG, _STRONG, debug=False) == []


def test_distinct_short_signing_key_fails() -> None:
    errors = validate_signing_key("b" * (MIN_SECRET_KEY_LENGTH - 1), _STRONG, debug=False)
    ids = {e.id for e in errors}
    assert ids == {"trueppm.E005"}


def test_distinct_insecure_prefix_signing_key_fails() -> None:
    # Long enough to pass the length rule — only the placeholder prefix should fail.
    key = INSECURE_PREFIX + "x" * 50
    errors = validate_signing_key(key, _STRONG, debug=False)
    ids = {e.id for e in errors}
    assert "trueppm.E004" in ids
    assert "trueppm.E005" not in ids  # length rule must not also fire


def test_threshold_boundary_passes() -> None:
    """Exactly MIN_SECRET_KEY_LENGTH characters, distinct from SECRET_KEY, is fine."""
    assert validate_signing_key(_OTHER_STRONG, _STRONG, debug=False) == []


def test_system_check_is_registered_under_security_deploy_tag() -> None:
    registered = registry.registry.get_checks(include_deployment_checks=True)
    assert check_signing_key in registered
    assert "security" in check_signing_key.tags


def test_system_check_reads_live_settings(settings: pytest.FixtureRequest) -> None:
    """Reads JWT_SIGNING_KEY/SECRET_KEY/DEBUG from django.conf.settings; DEBUG=True → clean."""
    settings.DEBUG = True  # type: ignore[attr-defined]
    settings.SECRET_KEY = "strong-enough-secret-key-for-the-test-abcdef"  # type: ignore[attr-defined]
    settings.JWT_SIGNING_KEY = "x"  # type: ignore[attr-defined]
    assert check_signing_key() == []


def test_system_check_flags_distinct_weak_key_when_debug_off(
    settings: pytest.FixtureRequest,
) -> None:
    settings.DEBUG = False  # type: ignore[attr-defined]
    settings.SECRET_KEY = _STRONG  # type: ignore[attr-defined]
    settings.JWT_SIGNING_KEY = "x"  # type: ignore[attr-defined]  # distinct + weak
    errors = check_signing_key()
    assert errors
    assert all(isinstance(e, Error) for e in errors)
