"""TRUEPPM_-prefixed env-var precedence with legacy-name fallback (#1325, #1355).

The 0.3 public-surface freeze standardized configuration on the ``TRUEPPM_``
prefix while keeping the legacy bare names working so existing deploys upgrade
without a config change. These tests pin that contract:

* the prefixed name wins when set;
* the legacy bare name is used when the prefixed one is absent;
* an *empty* ``TRUEPPM_FRONTEND_BASE_URL`` falls through to a legacy override
  rather than shadowing it (the ``or``-fallthrough — the chart ships the
  prefixed key empty by default, so a nested default would silently mask a
  legacy override).

``base`` is reloaded under a controlled environment so its module-level
``env()`` expressions re-evaluate. ``django.conf.settings`` snapshots ``base``
at startup and is unaffected by these reloads; only code that reads ``base.*``
directly (this test) sees the reloaded values, and the autouse fixture reloads
``base`` once more afterwards so the module is clean for other tests.
"""

from __future__ import annotations

import importlib
import os
from collections.abc import Iterator
from unittest import mock

import pytest

from trueppm_api.settings import base

_MANAGED_KEYS = (
    "TRUEPPM_FRONTEND_BASE_URL",
    "FRONTEND_BASE_URL",
    "TRUEPPM_AUTH_REFRESH_COOKIE_NAME",
    "AUTH_REFRESH_COOKIE_NAME",
)


@pytest.fixture(autouse=True)
def _restore_base() -> Iterator[None]:
    yield
    importlib.reload(base)


def _reload_base_with(env_overrides: dict[str, str]) -> None:
    """Reload ``base`` with only ``env_overrides`` set for the managed keys."""
    for key in _MANAGED_KEYS:
        os.environ.pop(key, None)
    os.environ.update(env_overrides)
    importlib.reload(base)


def test_prefixed_frontend_url_wins_over_legacy() -> None:
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with(
            {
                "TRUEPPM_FRONTEND_BASE_URL": "https://new.example",
                "FRONTEND_BASE_URL": "https://old.example",
            }
        )
        assert base.FRONTEND_BASE_URL == "https://new.example"


def test_empty_prefixed_frontend_url_falls_through_to_legacy() -> None:
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with(
            {
                "TRUEPPM_FRONTEND_BASE_URL": "",
                "FRONTEND_BASE_URL": "https://legacy.example",
            }
        )
        assert base.FRONTEND_BASE_URL == "https://legacy.example"


def test_frontend_url_empty_when_neither_set() -> None:
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with({})
        assert base.FRONTEND_BASE_URL == ""


def test_prefixed_cookie_name_wins_over_legacy_and_default() -> None:
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with(
            {
                "TRUEPPM_AUTH_REFRESH_COOKIE_NAME": "tp_refresh",
                "AUTH_REFRESH_COOKIE_NAME": "legacy_refresh",
            }
        )
        assert base.AUTH_REFRESH_COOKIE_NAME == "tp_refresh"


def test_legacy_cookie_name_used_when_prefixed_absent() -> None:
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with({"AUTH_REFRESH_COOKIE_NAME": "legacy_refresh"})
        assert base.AUTH_REFRESH_COOKIE_NAME == "legacy_refresh"


def test_cookie_name_default_when_neither_set() -> None:
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with({})
        assert base.AUTH_REFRESH_COOKIE_NAME == "trueppm_refresh"
