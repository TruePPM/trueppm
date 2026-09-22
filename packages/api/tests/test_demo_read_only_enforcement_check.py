"""Tests for the DEMO_READ_ONLY enforcement trip-wire (#3925, ADR-1197).

Mirrors test_attachment_storage_check.py: a pure ``validate_demo_read_only_enforcement``
function with two callers — the Django system-check registry and an import-time guard
in ``settings/prod.py``. This check exists so that ``validate_attachment_storage``'s
``writes_disabled`` escape is never trusted on a bare boolean — it proves
DemoReadOnlyMiddleware is actually installed whenever TRUEPPM_DEMO_READ_ONLY claims
writes are blocked.
"""

from __future__ import annotations

import pytest
from django.core.checks import Error, registry

from trueppm_api.core.security_checks import (
    check_demo_read_only_enforcement,
    validate_demo_read_only_enforcement,
)

_MIDDLEWARE_ENTRY = "trueppm_api.core.demo_read_only.DemoReadOnlyMiddleware"
_OTHER_MIDDLEWARE = ["django.middleware.security.SecurityMiddleware"]
_FULL_MIDDLEWARE = [*_OTHER_MIDDLEWARE, _MIDDLEWARE_ENTRY]


def test_clean_when_demo_read_only_false_regardless_of_middleware() -> None:
    """A normal, non-demo chart never sets TRUEPPM_DEMO_READ_ONLY — always a no-op."""
    assert (
        validate_demo_read_only_enforcement(demo_read_only=False, middleware=_OTHER_MIDDLEWARE)
        == []
    )


def test_clean_when_demo_read_only_true_and_middleware_present() -> None:
    assert (
        validate_demo_read_only_enforcement(demo_read_only=True, middleware=_FULL_MIDDLEWARE) == []
    )


def test_flags_demo_read_only_true_without_middleware() -> None:
    """The trip-wire: claim and enforcement have drifted apart."""
    errors = validate_demo_read_only_enforcement(demo_read_only=True, middleware=_OTHER_MIDDLEWARE)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E013"
    assert _MIDDLEWARE_ENTRY in str(errors[0].msg)


def test_flags_demo_read_only_true_with_empty_middleware() -> None:
    errors = validate_demo_read_only_enforcement(demo_read_only=True, middleware=[])
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E013"


def test_system_check_registered_under_security_deploy_tag() -> None:
    registered = registry.registry.get_checks(include_deployment_checks=True)
    assert check_demo_read_only_enforcement in registered
    assert "security" in check_demo_read_only_enforcement.tags  # type: ignore[attr-defined]


def test_system_check_clean_in_test_env(settings: pytest.FixtureRequest) -> None:
    """DEMO_READ_ONLY defaults False, so the live registry is clean out of the box."""
    settings.DEMO_READ_ONLY = False  # type: ignore[attr-defined]
    assert check_demo_read_only_enforcement() == []


def test_system_check_flags_demo_read_only_without_middleware(
    settings: pytest.FixtureRequest,
) -> None:
    settings.DEMO_READ_ONLY = True  # type: ignore[attr-defined]
    settings.MIDDLEWARE = _OTHER_MIDDLEWARE  # type: ignore[attr-defined]
    errors = check_demo_read_only_enforcement()
    assert len(errors) == 1
    assert isinstance(errors[0], Error)
    assert errors[0].id == "trueppm.E013"


def test_system_check_clean_when_demo_read_only_and_middleware_present(
    settings: pytest.FixtureRequest,
) -> None:
    settings.DEMO_READ_ONLY = True  # type: ignore[attr-defined]
    settings.MIDDLEWARE = _FULL_MIDDLEWARE  # type: ignore[attr-defined]
    assert check_demo_read_only_enforcement() == []
