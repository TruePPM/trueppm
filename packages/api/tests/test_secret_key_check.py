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
    PLACEHOLDER_SECRET_KEY_PREFIXES,
    check_secret_key,
    validate_secret_key,
    validate_signing_key,
)

#: The exact string .env.example shipped until #3187. 56 characters, no
#: ``django-insecure-`` prefix — so it cleared every rule the validator had.
_SHIPPED_PLACEHOLDER = "REPLACE-WITH-A-LONG-RANDOM-STRING-AT-LEAST-32-CHARS-LONG"


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


# ---------------------------------------------------------------------------
# Documented placeholders (#3187)
#
# The key that shipped in .env.example was long enough and carried no Django
# prefix, so it passed both guards — and JWT_SIGNING_KEY defaults to SECRET_KEY,
# so `cp .env.example .env` (which the README instructs) produced a production
# install whose token-signing key was public.
# ---------------------------------------------------------------------------


def test_the_key_env_example_used_to_ship_is_rejected() -> None:
    """The regression case, by its literal value."""
    errors = validate_secret_key(_SHIPPED_PLACEHOLDER, debug=False)
    assert errors, "the placeholder .env.example shipped still passes validation"
    assert "trueppm.E002" in {e.id for e in errors}


def test_the_shipped_placeholder_would_have_passed_the_old_rules() -> None:
    """Pins WHY it got through, so the two old rules are not credited with it.

    If this ever fails, the placeholder no longer exercises the gap the
    placeholder check exists to close, and the test above is passing for the
    wrong reason.
    """
    assert len(_SHIPPED_PLACEHOLDER) >= MIN_SECRET_KEY_LENGTH
    assert not _SHIPPED_PLACEHOLDER.startswith(INSECURE_PREFIX)


@pytest.mark.parametrize("prefix", PLACEHOLDER_SECRET_KEY_PREFIXES)
def test_every_placeholder_prefix_is_rejected(prefix: str) -> None:
    key = prefix + "-" + "x" * MIN_SECRET_KEY_LENGTH
    assert "trueppm.E002" in {e.id for e in validate_secret_key(key, debug=False)}


@pytest.mark.parametrize("prefix", PLACEHOLDER_SECRET_KEY_PREFIXES)
def test_placeholder_prefix_match_is_case_insensitive(prefix: str) -> None:
    key = prefix.upper() + "-" + "X" * MIN_SECRET_KEY_LENGTH
    assert "trueppm.E002" in {e.id for e in validate_secret_key(key, debug=False)}


def test_placeholder_key_is_allowed_under_debug() -> None:
    assert validate_secret_key(_SHIPPED_PLACEHOLDER, debug=True) == []


def test_a_real_key_containing_a_placeholder_word_is_not_rejected() -> None:
    """Prefix-matched, not substring-matched — a real key must not false-fail."""
    key = "x" * 20 + "replace-with" + "y" * 20
    assert validate_secret_key(key, debug=False) == []


def test_placeholder_signing_key_is_rejected() -> None:
    """The signing key inherits the same bar when set explicitly (#2247)."""
    errors = validate_signing_key(_SHIPPED_PLACEHOLDER, "a" * 50, debug=False)
    assert "trueppm.E004" in {e.id for e in errors}


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
