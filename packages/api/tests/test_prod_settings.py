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
from pathlib import Path
from types import ModuleType
from unittest import mock

import pytest

from trueppm_api.settings import base

# Repo root holds the install artifact operators copy to .env. From
# packages/api/tests/test_prod_settings.py that is three parents up.
_ENV_EXAMPLE = Path(__file__).resolve().parents[3] / ".env.example"

_PROD = "trueppm_api.settings.prod"
_STRONG_KEY = "k" * 50  # ≥ MIN_SECRET_KEY_LENGTH (32), no "django-insecure-" prefix
_S3 = "storages.backends.s3.S3Storage"
_LOCAL = "django.core.files.storage.FileSystemStorage"
# A real, parseable Fernet key (32 url-safe-base64 bytes) so the #1002 boot guard
# passes; the validator's own empty/malformed cases live in
# test_integration_encryption_key_check.py.
_VALID_FERNET_KEY = "cNHot7PnbAHGIuY4zUht8FwB5wYGv06O7ppzGyhzR84="


def _load_prod(
    *, backend: str, allow_local: bool, encryption_key: str = _VALID_FERNET_KEY
) -> ModuleType:
    """Import (or re-import) settings/prod.py with controlled storage + env.

    prod.py reads ALLOWED_HOSTS/SECRET_KEY from the environment and STORAGES/
    ALLOW_LOCAL_ATTACHMENT_STORAGE/INTEGRATION_ENCRYPTION_KEY from ``base`` at
    import time. We patch each so the guards run against known inputs without
    mutating the live settings (the ``DATABASES`` patch keeps prod's CONN_MAX_AGE
    write off the shared dict).
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
        mock.patch.object(base, "INTEGRATION_ENCRYPTION_KEY", encryption_key),
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


def test_prod_refuses_empty_integration_encryption_key() -> None:
    """An empty INTEGRATION_ENCRYPTION_KEY stops the boot (#1002)."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        _load_prod(backend=_S3, allow_local=False, encryption_key="")


# ---------------------------------------------------------------------------
# #1354: the install artifact (.env.example) must keep operators clear of the
# import-time boot guards. A fresh copy that omits a required key walks the
# operator straight into a crash-loop, so these assert the artifact documents
# every key prod refuses to boot without and that a config derived from it
# (keys filled the way the file instructs) imports cleanly.
# ---------------------------------------------------------------------------

# Env vars whose absence/emptiness makes settings.prod raise at import time.
# Keep in sync with the guards in settings/prod.py (validate_secret_key,
# validate_integration_encryption_key, validate_attachment_storage).
_BOOT_GUARD_ENV_KEYS = ("SECRET_KEY", "INTEGRATION_ENCRYPTION_KEY")
_STORAGE_CHOICE_KEYS = ("TRUEPPM_DEFAULT_FILE_STORAGE", "TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE")


def _parse_env_example() -> dict[str, str]:
    """Active (uncommented) ``KEY=value`` assignments in .env.example."""
    env: dict[str, str] = {}
    for line in _ENV_EXAMPLE.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        env[key.strip()] = value.strip()
    return env


def test_env_example_documents_every_boot_guard_key() -> None:
    """Each import-time boot guard's env var must appear in .env.example so a
    fresh copy can't silently omit it and crash-loop the deploy (#1354)."""
    text = _ENV_EXAMPLE.read_text()
    for key in _BOOT_GUARD_ENV_KEYS:
        assert key in text, f"{key} is missing from .env.example"
    # Storage is a required *choice* between two vars — at least one must be
    # documented so the operator knows the local default refuses to boot.
    assert any(key in text for key in _STORAGE_CHOICE_KEYS), (
        "no attachment-storage choice documented in .env.example"
    )


def test_env_example_derived_prod_config_boots() -> None:
    """The documented happy path must clear every boot guard once the operator
    fills the REQUIRED-but-empty keys the file calls out (#1354)."""
    active = _parse_env_example()
    # SECRET_KEY ships as a placeholder to replace; INTEGRATION_ENCRYPTION_KEY
    # ships empty for the operator to generate. Confirm that shape, then mirror
    # the completed state with valid values and a documented storage choice.
    assert "SECRET_KEY" in active
    assert active.get("INTEGRATION_ENCRYPTION_KEY", "x") == "", (
        "INTEGRATION_ENCRYPTION_KEY should ship empty so the operator generates it"
    )
    # Pick storage option (b) — local opt-in — and confirm prod boots.
    prod = _load_prod(backend=_LOCAL, allow_local=True, encryption_key=_VALID_FERNET_KEY)
    assert prod.DEBUG is False
