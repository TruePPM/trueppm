"""Import-time guard tests for settings/prod.py (#566, #775).

prod.py enforces two security guards at module *import* time rather than via the
Django system-check registry, because gunicorn/asgi workers never run
``manage.py check`` — a misconfiguration must stop the boot itself. The validator
functions are unit-tested in test_secret_key_check.py / test_attachment_storage_check.py;
these tests exercise the prod.py wiring: a clean import sets the hardened headers,
and a local attachment backend refuses to boot.
"""

from __future__ import annotations

import importlib
import os
import sys
from collections.abc import Iterator
from types import ModuleType
from unittest import mock

import pytest

from trueppm_api.settings import base

_PROD = "trueppm_api.settings.prod"
_STRONG_KEY = "k" * 50  # ≥ MIN_SECRET_KEY_LENGTH (32), no "django-insecure-" prefix
_S3 = "storages.backends.s3.S3Storage"
_LOCAL = "django.core.files.storage.FileSystemStorage"


def _load_prod(*, backend: str, allow_local: bool) -> ModuleType:
    """Import (or re-import) settings/prod.py with controlled storage + env.

    prod.py reads ALLOWED_HOSTS/SECRET_KEY from the environment and STORAGES/
    ALLOW_LOCAL_ATTACHMENT_STORAGE from ``base`` at import time. We patch both so
    the guards run against known inputs without mutating the live settings (the
    ``DATABASES`` patch keeps prod's CONN_MAX_AGE write off the shared dict).
    """
    storages = {
        "default": {"BACKEND": backend},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
    with (
        mock.patch.dict(
            os.environ,
            {
                "ALLOWED_HOSTS": "prod.example.com",
                "SECRET_KEY": _STRONG_KEY,
                "TRUEPPM_SECURE_SSL_REDIRECT": "false",
            },
        ),
        mock.patch.object(base, "STORAGES", storages),
        mock.patch.object(base, "ALLOW_LOCAL_ATTACHMENT_STORAGE", allow_local),
        mock.patch.object(base, "DATABASES", {"default": {}}),
    ):
        existing = sys.modules.get(_PROD)
        if existing is None:
            return importlib.import_module(_PROD)
        return importlib.reload(existing)


@pytest.fixture(autouse=True)
def _drop_reloaded_prod() -> Iterator[None]:
    """Drop the reloaded prod module so its patched-env state never leaks."""
    yield
    sys.modules.pop(_PROD, None)


def test_prod_boots_and_sets_security_headers() -> None:
    prod = _load_prod(backend=_S3, allow_local=False)
    assert prod.DEBUG is False
    assert prod.SECURE_CONTENT_TYPE_NOSNIFF is True
    assert prod.SECURE_REFERRER_POLICY == "same-origin"
    # HTTP→HTTPS redirect is opt-in (default off) with the k8s probe paths exempt.
    assert prod.SECURE_SSL_REDIRECT is False
    assert "^api/v1/health/$" in prod.SECURE_REDIRECT_EXEMPT
    assert "^api/v1/edition/$" in prod.SECURE_REDIRECT_EXEMPT


def test_prod_refuses_local_attachment_storage() -> None:
    """A local-disk attachment backend without opt-in stops the boot (#775)."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        _load_prod(backend=_LOCAL, allow_local=False)


def test_prod_boots_on_local_storage_when_opted_in() -> None:
    """TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE lets local storage through."""
    prod = _load_prod(backend=_LOCAL, allow_local=True)
    assert prod.STORAGES["default"]["BACKEND"] == _LOCAL
