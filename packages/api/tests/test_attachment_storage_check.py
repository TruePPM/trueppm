"""Tests for the attachment-storage hardening check (#775).

Mirrors the SECRET_KEY guard (test_secret_key_check.py): a pure
``validate_attachment_storage`` function with two callers — the Django
system-check registry and an import-time guard in ``settings/prod.py``.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest
from django.core.checks import Error, registry
from django.core.checks.messages import CheckMessage

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


#: chmod cannot make a directory unwritable to root, so a root test runner would
#: pass the "rejects an unwritable MEDIA_ROOT" cases without exercising anything.
#: CI runs as `ci` (.gitlab/ci-images/api.Dockerfile); skip rather than lie.
_requires_non_root = pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root bypasses directory permissions, so the unwritable-path probe cannot fail",
)


# ---------------------------------------------------------------------------
# MEDIA_ROOT writability behind the opt-in (#3184)
#
# The opt-in is a CLAIM about the deployment ("local disk is durable here"). Until
# #3184 nothing tested the claim, and the deployment it described could not
# possibly work: MEDIA_ROOT was set nowhere, so Django resolved uploads against
# /app on a read-only root filesystem. These cover the branch that makes the
# claim falsifiable at boot.
# ---------------------------------------------------------------------------


def test_opt_in_without_media_root_is_still_clean() -> None:
    """A caller that passes no media_root keeps the pre-#3184 signature."""
    assert validate_attachment_storage(_LOCAL, debug=False, allow_local=True) == []


def test_opt_in_with_writable_media_root_passes(tmp_path: Path) -> None:
    assert (
        validate_attachment_storage(_LOCAL, debug=False, allow_local=True, media_root=tmp_path)
        == []
    )


def test_opt_in_creates_a_missing_media_root(tmp_path: Path) -> None:
    """An empty PVC mounts with no subdirectory; creating it is not a failure."""
    target = tmp_path / "media"
    assert (
        validate_attachment_storage(_LOCAL, debug=False, allow_local=True, media_root=target) == []
    )
    assert target.is_dir()


def test_concurrent_probes_do_not_report_a_good_volume_as_unwritable(
    tmp_path: Path,
) -> None:
    """Six containers boot together against ONE ReadWriteMany volume.

    With a shared probe filename, two interleaved write/unlink pairs leave the
    loser's unlink raising FileNotFoundError — an OSError, which the guard would
    report as "not writable" and crash-loop a perfectly good volume.
    """
    results: list[list[CheckMessage]] = []
    barrier = threading.Barrier(8)

    def probe() -> None:
        barrier.wait()
        for _ in range(25):
            results.append(
                validate_attachment_storage(
                    _LOCAL, debug=False, allow_local=True, media_root=tmp_path
                )
            )

    threads = [threading.Thread(target=probe) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results, "no probes ran"
    assert all(r == [] for r in results), (
        f"{sum(1 for r in results if r)} of {len(results)} concurrent probes "
        "reported a writable volume as unwritable"
    )
    # And nothing is left behind on the volume.
    assert list(tmp_path.iterdir()) == []


def test_opt_in_with_empty_media_root_is_rejected() -> None:
    """Django's own default. This is the exact #3184 production configuration."""
    errors = validate_attachment_storage(_LOCAL, debug=False, allow_local=True, media_root="")
    assert len(errors) == 1
    assert errors[0].id == "trueppm.E004"
    assert "working directory" in str(errors[0].msg)


def test_opt_in_with_relative_media_root_is_rejected() -> None:
    errors = validate_attachment_storage(_LOCAL, debug=False, allow_local=True, media_root="media")
    assert len(errors) == 1
    assert "relative" in str(errors[0].msg)


@_requires_non_root
def test_opt_in_with_unwritable_media_root_is_rejected(tmp_path: Path) -> None:
    """Stands in for readOnlyRootFilesystem, which os.access would call writable.

    The probe is a real create-and-delete rather than a permission-bit check for
    exactly this reason — a read-only *mount* is invisible to the bits.
    """
    target = tmp_path / "locked"
    target.mkdir()
    target.chmod(0o500)
    try:
        errors = validate_attachment_storage(
            _LOCAL, debug=False, allow_local=True, media_root=target
        )
        assert len(errors) == 1
        assert errors[0].id == "trueppm.E004"
        assert "not writable" in str(errors[0].msg)
    finally:
        target.chmod(0o700)


@_requires_non_root
def test_unwritable_media_root_is_irrelevant_on_object_storage(tmp_path: Path) -> None:
    """The probe is scoped to local storage — S3 never touches MEDIA_ROOT."""
    target = tmp_path / "locked"
    target.mkdir()
    target.chmod(0o500)
    try:
        assert (
            validate_attachment_storage(_S3, debug=False, allow_local=True, media_root=target) == []
        )
    finally:
        target.chmod(0o700)


@_requires_non_root
def test_unwritable_media_root_is_irrelevant_under_debug(tmp_path: Path) -> None:
    target = tmp_path / "locked"
    target.mkdir()
    target.chmod(0o500)
    try:
        assert (
            validate_attachment_storage(_LOCAL, debug=True, allow_local=True, media_root=target)
            == []
        )
    finally:
        target.chmod(0o700)


@_requires_non_root
def test_system_check_flags_unwritable_media_root(
    settings: pytest.FixtureRequest, tmp_path: Path
) -> None:
    """The registry caller passes MEDIA_ROOT through — not just the unit function."""
    target = tmp_path / "locked"
    target.mkdir()
    target.chmod(0o500)
    settings.DEBUG = False  # type: ignore[attr-defined]
    settings.ALLOW_LOCAL_ATTACHMENT_STORAGE = True  # type: ignore[attr-defined]
    settings.STORAGES = {"default": {"BACKEND": _LOCAL}}  # type: ignore[attr-defined]
    settings.MEDIA_ROOT = str(target)  # type: ignore[attr-defined]
    try:
        errors = check_attachment_storage()
        assert len(errors) == 1
        assert errors[0].id == "trueppm.E004"
    finally:
        target.chmod(0o700)


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
