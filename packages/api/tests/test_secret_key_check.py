"""Tests for the SECRET_KEY hardening check (#566, PYSEC-2025-183 mitigation).

The check has two callers:

* the Django system-check registry (``manage.py check --deploy``)
* an explicit guard at the top of ``settings/prod.py`` that raises
  ``RuntimeError`` so workers refuse to boot

Both call the same pure ``validate_secret_key`` function, so the unit tests
exercise that function directly and a second test confirms the system-check
entry point is registered with the right tag.
"""

from __future__ import annotations

import pytest
from django.core.checks import Error, registry

from trueppm_api.core.security_checks import (
    INSECURE_PREFIX,
    MIN_SECRET_KEY_LENGTH,
    check_secret_key,
    validate_secret_key,
)


def test_debug_short_secret_key_is_allowed() -> None:
    """Developer workstations keep booting with the placeholder key."""
    assert validate_secret_key("x", debug=True) == []


def test_strong_key_passes_in_prod() -> None:
    strong = "a" * MIN_SECRET_KEY_LENGTH
    assert validate_secret_key(strong, debug=False) == []


def test_empty_key_fails_in_prod() -> None:
    errors = validate_secret_key("", debug=False)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E001"


def test_none_key_fails_in_prod() -> None:
    errors = validate_secret_key(None, debug=False)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E001"


def test_django_insecure_prefix_fails_in_prod() -> None:
    # 50-char key built around the placeholder prefix — long enough to pass the
    # length rule on its own; only the prefix should fail.
    key = INSECURE_PREFIX + "x" * 50
    errors = validate_secret_key(key, debug=False)
    ids = {e.id for e in errors}
    assert "trueppm.E002" in ids
    assert "trueppm.E003" not in ids  # length rule must not also fire


def test_short_key_fails_in_prod() -> None:
    errors = validate_secret_key("a" * (MIN_SECRET_KEY_LENGTH - 1), debug=False)
    ids = {e.id for e in errors}
    assert ids == {"trueppm.E003"}


def test_threshold_boundary_passes() -> None:
    """Exactly MIN_SECRET_KEY_LENGTH characters is acceptable."""
    assert validate_secret_key("a" * MIN_SECRET_KEY_LENGTH, debug=False) == []


def test_system_check_is_registered_under_security_deploy_tag() -> None:
    """The check is wired into Django's registry, not just defined."""
    registered = registry.registry.get_checks(include_deployment_checks=True)
    assert check_secret_key in registered
    assert "security" in registry.registry.tags_available(deployment_checks=True)
    assert "security" in check_secret_key.tags  # type: ignore[attr-defined]


def test_system_check_reads_live_settings(settings: pytest.FixtureRequest) -> None:
    """The check entry point reads SECRET_KEY/DEBUG from django.conf.settings.

    In the test environment DEBUG is True, so the check should return clean
    even with a deliberately-weak key.
    """
    settings.DEBUG = True  # type: ignore[attr-defined]
    settings.SECRET_KEY = "x"  # type: ignore[attr-defined]
    assert check_secret_key() == []


def test_system_check_flags_weak_key_when_debug_off(
    settings: pytest.FixtureRequest,
) -> None:
    settings.DEBUG = False  # type: ignore[attr-defined]
    settings.SECRET_KEY = "x"  # type: ignore[attr-defined]
    errors = check_secret_key()
    assert errors
    assert all(isinstance(e, Error) for e in errors)
