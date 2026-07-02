"""Outbound EMAIL_* settings bind from the environment (#764).

Before #764 nothing bound Django's EMAIL_* settings to the environment, so
setting ``EMAIL_HOST`` as a container env var / Helm value had no effect, and
Django's implicit ``EMAIL_HOST = "localhost"`` default made the read-only status
page report a phantom host. These tests pin the binding contract and the
"unconfigured by default" behavior (empty host => the status page shows
"Not configured" and the notification drain skips) without a live SMTP server.

``base`` is reloaded under a controlled environment so its module-level
``env()`` expressions re-evaluate; ``django.conf.settings`` snapshots ``base`` at
startup and is unaffected. The autouse fixture reloads ``base`` once more
afterwards so the module is clean for other tests (mirrors
``test_env_namespace.py``).
"""

from __future__ import annotations

import importlib
import os
from collections.abc import Iterator
from unittest import mock

import pytest

from trueppm_api.settings import base

_MANAGED_KEYS = (
    "EMAIL_BACKEND",
    "EMAIL_HOST",
    "EMAIL_PORT",
    "EMAIL_USE_TLS",
    "EMAIL_USE_SSL",
    "EMAIL_HOST_USER",
    "EMAIL_HOST_PASSWORD",
    "DEFAULT_FROM_EMAIL",
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


def test_email_host_defaults_to_unconfigured_not_localhost() -> None:
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with({})
        # The regression guard: absent an EMAIL_HOST env var the setting is ""
        # (NOT Django's implicit "localhost"), so the status page reads
        # "Not configured" and the drain does not attempt localhost:25.
        assert base.EMAIL_HOST == ""
        assert base.EMAIL_BACKEND.endswith("EmailBackend")
        assert base.EMAIL_PORT == 587
        assert base.EMAIL_USE_TLS is True
        assert base.EMAIL_USE_SSL is False
        assert base.DEFAULT_FROM_EMAIL


def test_email_settings_read_from_environment() -> None:
    with mock.patch.dict(os.environ, {}, clear=False):
        _reload_base_with(
            {
                "EMAIL_HOST": "smtp.example.com",
                "EMAIL_PORT": "465",
                "EMAIL_USE_TLS": "false",
                "EMAIL_USE_SSL": "true",
                "EMAIL_HOST_USER": "notify@example.com",
                "EMAIL_HOST_PASSWORD": "s3cret",
                "DEFAULT_FROM_EMAIL": "notify@example.com",
            }
        )
        assert base.EMAIL_HOST == "smtp.example.com"
        assert base.EMAIL_PORT == 465
        assert base.EMAIL_USE_TLS is False
        assert base.EMAIL_USE_SSL is True
        assert base.EMAIL_HOST_USER == "notify@example.com"
        assert base.EMAIL_HOST_PASSWORD == "s3cret"
        assert base.DEFAULT_FROM_EMAIL == "notify@example.com"
