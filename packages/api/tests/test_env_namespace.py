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


# --- #3791 / #4482: one resolver, one precedence, a deprecation warning ------

_TWELVE = {
    "CSV_IMPORT_MAX_ROWS": 5_000,
    "CSV_IMPORT_MAX_UNCOMPRESSED_MB": 100,
    "CSV_IMPORT_MAX_UPLOAD_MB": 10,
    "IMPORT_BULK_BATCH_SIZE": 500,
    "JIRA_IMPORT_MAX_ROWS": 20_000,
    "JIRA_IMPORT_MAX_UPLOAD_MB": 25,
    "MPXJ_MAX_HEAP_MB": 512,
    "MPXJ_MAX_OUTPUT_MB": 512,
    "MSPROJECT_MAX_ROWS": 20_000,
    "SEED_IMPORT_MAX_CONCURRENT_JOBS": 3,
    "TIMETRACKING_BACKDATE_DAYS": 60,
    "TIMETRACKING_TIMER_MAX_MINUTES": 600,
}


@pytest.fixture
def _clean_twelve() -> Iterator[None]:
    keys = [k for n in _TWELVE for k in (n, f"TRUEPPM_{n}")]
    with mock.patch.dict(os.environ):
        for k in keys:
            os.environ.pop(k, None)
        yield


@pytest.mark.parametrize("name", sorted(_TWELVE))
def test_twelve_defaults_unchanged(name: str, _clean_twelve: None) -> None:
    importlib.reload(base)
    assert getattr(base, name) == _TWELVE[name]


@pytest.mark.parametrize("name", sorted(_TWELVE))
def test_twelve_prefixed_wins_over_legacy(name: str, _clean_twelve: None) -> None:
    os.environ[f"TRUEPPM_{name}"] = "7"
    os.environ[name] = "9"
    importlib.reload(base)
    assert getattr(base, name) == 7


@pytest.mark.parametrize("name", sorted(_TWELVE))
def test_twelve_legacy_still_honored(name: str, _clean_twelve: None) -> None:
    os.environ[name] = "9"
    importlib.reload(base)
    assert getattr(base, name) == 9


def test_empty_prefixed_cookie_name_falls_through_to_legacy() -> None:
    """One precedence rule: an empty prefixed value is unset for every setting."""
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with(
            {"TRUEPPM_AUTH_REFRESH_COOKIE_NAME": "", "AUTH_REFRESH_COOKIE_NAME": "legacy_refresh"}
        )
        assert base.AUTH_REFRESH_COOKIE_NAME == "legacy_refresh"


def test_legacy_secure_flag_parsed_as_bool() -> None:
    with mock.patch.dict(os.environ, {"AUTH_REFRESH_COOKIE_SECURE": "false"}):
        os.environ.pop("TRUEPPM_AUTH_REFRESH_COOKIE_SECURE", None)
        importlib.reload(base)
        assert base.AUTH_REFRESH_COOKIE_SECURE is False


def test_legacy_use_warns_once_prefixed_use_is_silent(caplog: pytest.LogCaptureFixture) -> None:
    from trueppm_api.core import env_compat

    env = base.environ.Env()
    env_compat._warned.discard("LEGACY_X")
    with mock.patch.dict(os.environ, {"LEGACY_X": "5"}):
        os.environ.pop("TRUEPPM_X", None)
        with caplog.at_level("WARNING", logger="trueppm.settings"):
            assert env_compat.env_with_legacy(env, "TRUEPPM_X", "LEGACY_X", 1, int) == 5
            assert env_compat.env_with_legacy(env, "TRUEPPM_X", "LEGACY_X", 1, int) == 5
        warnings = [r for r in caplog.records if "LEGACY_X" in r.getMessage()]
        assert len(warnings) == 1
        assert "TRUEPPM_X" in warnings[0].getMessage()
    caplog.clear()
    with mock.patch.dict(os.environ, {"LEGACY_X": "5", "TRUEPPM_X": "6"}):
        with caplog.at_level("WARNING", logger="trueppm.settings"):
            assert env_compat.env_with_legacy(env, "TRUEPPM_X", "LEGACY_X", 1, int) == 6
        assert not caplog.records
