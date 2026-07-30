"""Tests for the storage-backend importability check (#2559).

Sibling of test_attachment_storage_check.py (#775). That check answers "is this
backend *durable*"; this one answers "does this backend *exist* in the running
image, and is it configured well enough to accept an upload". Both had to be
separate: #775's guard passed happily on
``storages.backends.s3.S3Storage`` at a time when the package was not installed
at all, so the boot guard actively steered operators toward a crash.
"""

from __future__ import annotations

import pytest
from django.core.checks import Error, registry

from trueppm_api.core.security_checks import (
    check_storage_backend,
    validate_storage_backend,
)

_LOCAL = "django.core.files.storage.FileSystemStorage"
_S3 = "storages.backends.s3.S3Storage"
_S3_LEGACY = "storages.backends.s3boto3.S3Boto3Storage"
_BUCKET_OPTS = {"bucket_name": "trueppm-attachments"}


# ---------------------------------------------------------------------------
# Importability — the #2559 regression itself
# ---------------------------------------------------------------------------


def test_bundled_s3_backend_imports() -> None:
    """The regression guard: the backend all four operator docs recommend must be
    importable in the shipped image. This test fails if django-storages is ever
    dropped from pyproject.toml while the docs still recommend it."""
    assert validate_storage_backend(_S3, backend_options=_BUCKET_OPTS) == []


def test_local_default_imports() -> None:
    assert validate_storage_backend(_LOCAL) == []


def test_legacy_s3boto3_alias_imports() -> None:
    assert validate_storage_backend(_S3_LEGACY, backend_options=_BUCKET_OPTS) == []


def test_unimportable_backend_is_flagged() -> None:
    errors = validate_storage_backend("nonexistent_pkg.storage.Backend")
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E007"
    assert "cannot be imported" in str(errors[0].msg)


def test_typo_in_dotted_path_is_flagged() -> None:
    """A real typo an operator would make: right module, wrong class name."""
    errors = validate_storage_backend("storages.backends.s3.S3Storrage")
    assert {e.id for e in errors} == {"trueppm.E007"}


def test_empty_backend_is_not_flagged() -> None:
    """Django supplies the default; an unset value is not this check's business."""
    assert validate_storage_backend(None) == []
    assert validate_storage_backend("") == []


@pytest.mark.parametrize(
    ("backend", "requirement"),
    [
        ("storages.backends.gcloud.GoogleCloudStorage", "django-storages[google]"),
        ("storages.backends.azure_storage.AzureStorage", "django-storages[azure]"),
        ("storages.backends.sftpstorage.SFTPStorage", "django-storages[sftp]"),
        ("storages.backends.dropbox.DropboxStorage", "django-storages[dropbox]"),
    ],
)
def test_unbundled_extras_name_the_exact_requirement(backend: str, requirement: str) -> None:
    """GCS and Azure Blob are on the signed-url allow-list but their extras are NOT
    bundled, so the hint has to name the specific extra rather than say
    'install django-storages' — which would look already-satisfied."""
    errors = validate_storage_backend(backend)
    assert len(errors) == 1, f"{backend} unexpectedly importable — is a new extra bundled?"
    assert requirement in str(errors[0].hint)


def test_unknown_backend_hint_falls_back_to_typo_advice() -> None:
    errors = validate_storage_backend("myapp.storage.CustomBackend")
    assert len(errors) == 1
    assert "typo" in str(errors[0].hint)


# ---------------------------------------------------------------------------
# S3 bucket configuration — importable but unusable
# ---------------------------------------------------------------------------


def test_s3_without_bucket_name_is_flagged() -> None:
    """Pointing TRUEPPM_DEFAULT_FILE_STORAGE at S3 and nothing else used to boot
    and then fail on the first upload with boto3's opaque
    'Required parameter name not set'."""
    errors = validate_storage_backend(_S3, backend_options=None)
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E008"
    assert "TRUEPPM_S3_BUCKET_NAME" in str(errors[0].hint)


def test_s3_with_empty_bucket_name_is_flagged() -> None:
    """An unset env var resolves to "" rather than absent — equally broken."""
    errors = validate_storage_backend(_S3, backend_options={"bucket_name": ""})
    assert {e.id for e in errors} == {"trueppm.E008"}


def test_legacy_s3_alias_also_requires_a_bucket() -> None:
    assert validate_storage_backend(_S3_LEGACY, backend_options={}) != []


def test_non_s3_backend_needs_no_bucket() -> None:
    """FileSystemStorage must not be asked for a bucket it has no concept of."""
    assert validate_storage_backend(_LOCAL, backend_options={}) == []


# ---------------------------------------------------------------------------
# System-check registration
# ---------------------------------------------------------------------------


def test_system_check_registered_under_security_deploy_tag() -> None:
    registered = registry.registry.get_checks(include_deployment_checks=True)
    assert check_storage_backend in registered
    assert "security" in check_storage_backend.tags  # type: ignore[attr-defined]


def test_system_check_reads_live_settings(settings: pytest.FixtureRequest) -> None:
    settings.STORAGES = {"default": {"BACKEND": _LOCAL}}  # type: ignore[attr-defined]
    assert check_storage_backend() == []


def test_system_check_flags_unimportable_backend(settings: pytest.FixtureRequest) -> None:
    settings.STORAGES = {  # type: ignore[attr-defined]
        "default": {"BACKEND": "nonexistent_pkg.storage.Backend"}
    }
    errors = check_storage_backend()
    assert errors
    assert all(isinstance(e, Error) for e in errors)
    assert errors[0].id == "trueppm.E007"


def test_system_check_reads_options_for_bucket(settings: pytest.FixtureRequest) -> None:
    """Proves the check plumbs STORAGES['default']['OPTIONS'] through, so a fully
    configured S3 deploy is clean rather than falsely flagged."""
    settings.STORAGES = {  # type: ignore[attr-defined]
        "default": {"BACKEND": _S3, "OPTIONS": _BUCKET_OPTS}
    }
    assert check_storage_backend() == []


def test_system_check_flags_s3_missing_options(settings: pytest.FixtureRequest) -> None:
    settings.STORAGES = {"default": {"BACKEND": _S3}}  # type: ignore[attr-defined]
    assert [e.id for e in check_storage_backend()] == ["trueppm.E008"]
