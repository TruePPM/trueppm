"""Tests for the attachment-storage hardening check (#775).

Mirrors the SECRET_KEY guard (test_secret_key_check.py): a pure
``validate_attachment_storage`` function with two callers — the Django
system-check registry and an import-time guard in ``settings/prod.py``.
"""

from __future__ import annotations

import pytest
from django.core.checks import Error, registry

from trueppm_api.core.security_checks import (
    check_attachment_storage,
    storage_backend_supports_signed_urls,
    validate_attachment_storage,
)

_LOCAL = "django.core.files.storage.FileSystemStorage"
_S3 = "storages.backends.s3.S3Storage"


def test_local_storage_fails_in_prod() -> None:
    errors = validate_attachment_storage(_LOCAL, debug=False, allow_local=False)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E004"


def test_local_storage_allowed_in_debug() -> None:
    assert validate_attachment_storage(_LOCAL, debug=True, allow_local=False) == []


def test_local_storage_allowed_with_opt_in() -> None:
    assert validate_attachment_storage(_LOCAL, debug=False, allow_local=True) == []


def test_remote_storage_passes_in_prod() -> None:
    assert validate_attachment_storage(_S3, debug=False, allow_local=False) == []


def test_filesystem_dotted_variant_also_flagged() -> None:
    variant = "django.core.files.storage.filesystem.FileSystemStorage"
    errors = validate_attachment_storage(variant, debug=False, allow_local=False)
    assert {e.id for e in errors} == {"trueppm.E004"}


def test_system_check_registered_under_security_deploy_tag() -> None:
    registered = registry.registry.get_checks(include_deployment_checks=True)
    assert check_attachment_storage in registered
    assert "security" in check_attachment_storage.tags  # type: ignore[attr-defined]


def test_system_check_reads_live_settings(settings: pytest.FixtureRequest) -> None:
    """In the test env DEBUG is True, so local storage is clean."""
    settings.DEBUG = True  # type: ignore[attr-defined]
    assert check_attachment_storage() == []


def test_system_check_flags_local_storage_when_debug_off(
    settings: pytest.FixtureRequest,
) -> None:
    settings.DEBUG = False  # type: ignore[attr-defined]
    settings.ALLOW_LOCAL_ATTACHMENT_STORAGE = False  # type: ignore[attr-defined]
    settings.STORAGES = {"default": {"BACKEND": _LOCAL}}  # type: ignore[attr-defined]
    errors = check_attachment_storage()
    assert errors
    assert all(isinstance(e, Error) for e in errors)
    assert errors[0].id == "trueppm.E004"


# ---------------------------------------------------------------------------
# Signed-URL backend detection (#573, MED-2 follow-up to !306's security review)
# ---------------------------------------------------------------------------


def test_local_storage_is_not_signing_capable() -> None:
    assert storage_backend_supports_signed_urls(_LOCAL) is False


def test_filesystem_dotted_variant_is_not_signing_capable() -> None:
    variant = "django.core.files.storage.filesystem.FileSystemStorage"
    assert storage_backend_supports_signed_urls(variant) is False


def test_unrecognized_custom_backend_is_not_signing_capable() -> None:
    """Fail closed: an unlisted backend is treated the same as FileSystemStorage,
    not assumed to sign, since a self-hoster's custom backend may not either."""
    assert storage_backend_supports_signed_urls("myapp.storage.WeirdBackend") is False


def test_none_backend_is_not_signing_capable() -> None:
    assert storage_backend_supports_signed_urls(None) is False


@pytest.mark.parametrize(
    "backend",
    [
        "storages.backends.s3boto3.S3Boto3Storage",
        "storages.backends.s3.S3Storage",
        "storages.backends.gcloud.GoogleCloudStorage",
        "storages.backends.azure_storage.AzureStorage",
    ],
)
def test_known_object_storage_backends_are_signing_capable(backend: str) -> None:
    assert storage_backend_supports_signed_urls(backend) is True


def test_force_signing_capable_overrides_unlisted_backend() -> None:
    """Operator opt-in (TRUEPPM_ATTACHMENT_STORAGE_SIGNS_URLS) for a
    signing-capable backend not yet on the allow-list."""
    assert (
        storage_backend_supports_signed_urls(
            "myapp.storage.WeirdBackend", force_signing_capable=True
        )
        is True
    )


def test_force_signing_capable_is_a_noop_when_already_capable() -> None:
    assert storage_backend_supports_signed_urls(_S3, force_signing_capable=True) is True
