"""Tests for trueppm_api.settings.dev._assert_dev_environment_safe (#256).

The guard prevents the dev settings module — which sets AllowAny and
ALLOWED_HOSTS=['*'] — from being loaded outside a developer workstation
or test runner.
"""

from __future__ import annotations

import pytest

from trueppm_api.settings.dev import _assert_dev_environment_safe


def test_pytest_marker_in_env_allows_load() -> None:
    """PYTEST_CURRENT_TEST in env permits dev settings (test runner case)."""
    _assert_dev_environment_safe(env={"PYTEST_CURRENT_TEST": "1"}, modules={})


def test_pytest_module_loaded_allows_load() -> None:
    """pytest already imported in process permits dev settings (test runner case)."""
    _assert_dev_environment_safe(env={}, modules={"pytest": object()})


def test_mypy_module_loaded_allows_load() -> None:
    """mypy already imported permits dev settings (django-stubs introspection)."""
    _assert_dev_environment_safe(env={}, modules={"mypy": object()})


def test_explicit_opt_in_allows_load() -> None:
    """TRUEPPM_ALLOW_DEV_SETTINGS=1 permits dev settings (developer workstation)."""
    _assert_dev_environment_safe(env={"TRUEPPM_ALLOW_DEV_SETTINGS": "1"}, modules={})


def test_no_marker_and_no_pytest_raises() -> None:
    """Loading dev settings outside dev or pytest raises — prod/staging must not boot."""
    with pytest.raises(RuntimeError, match="outside local dev"):
        _assert_dev_environment_safe(env={}, modules={})


def test_empty_opt_in_value_does_not_count() -> None:
    """An empty TRUEPPM_ALLOW_DEV_SETTINGS does not opt in."""
    with pytest.raises(RuntimeError):
        _assert_dev_environment_safe(env={"TRUEPPM_ALLOW_DEV_SETTINGS": ""}, modules={})
