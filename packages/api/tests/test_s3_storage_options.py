"""Tests for the S3 attachment-storage option builder (#2559).

``core.storage_config`` is the pure half; ``settings/base.py`` is the thin wiring
that hands it ``os.environ``. Same split as ``core.valkey_config`` (#2554), and for
the same reason — the builder has to run at settings-import time, so it must not
depend on Django being configured.

The last group is the real point of the issue: it instantiates the actual
django-storages backend our operator docs recommend and proves it presigns. That
is the assertion nothing in the tree made before, which is how the docs came to
recommend a module the image could not import.
"""

from __future__ import annotations

import pytest

from trueppm_api.core.storage_config import (
    DEFAULT_QUERYSTRING_EXPIRE,
    DEFAULT_REGION_NAME,
    DEFAULT_SIGNATURE_VERSION,
    S3_STORAGE_BACKENDS,
    build_s3_storage_options,
)

_S3 = "storages.backends.s3.S3Storage"


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


def test_empty_environ_yields_safe_defaults() -> None:
    opts = build_s3_storage_options({})
    assert opts["bucket_name"] == ""
    assert opts["region_name"] == DEFAULT_REGION_NAME
    assert opts["signature_version"] == DEFAULT_SIGNATURE_VERSION
    assert opts["querystring_expire"] == DEFAULT_QUERYSTRING_EXPIRE


def test_signature_version_defaults_to_sigv4() -> None:
    """Not cosmetic: with an endpoint_url and no explicit signature_version,
    botocore falls back to the deprecated SigV2 (?AWSAccessKeyId=&Signature=),
    which AWS rejects in every region created after 2014 — and which would make
    the signed-url action's expires_at promise rest on a legacy scheme."""
    assert build_s3_storage_options({})["signature_version"] == "s3v4"


def test_file_overwrite_is_disabled() -> None:
    """django-storages defaults this to True, which would silently replace an
    existing object at the same key. Attachment keys derive from user-supplied
    filenames, so two users uploading report.pdf to one task would destroy the
    first upload — FileSystemStorage suffixes instead."""
    assert build_s3_storage_options({})["file_overwrite"] is False


def test_no_public_acl_is_set() -> None:
    assert build_s3_storage_options({})["default_acl"] is None


# ---------------------------------------------------------------------------
# Optional keys are OMITTED rather than passed empty
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "key",
    ["endpoint_url", "addressing_style", "access_key", "secret_key"],
)
def test_optional_keys_absent_when_unset(key: str) -> None:
    """Passing endpoint_url="" would stop boto3 resolving the real AWS endpoint,
    and empty credentials would defeat its resolution chain (IRSA, IAM instance
    profile, ~/.aws) — which is how an EKS deploy should authenticate."""
    assert key not in build_s3_storage_options({})


def test_credentials_from_environ_are_forwarded() -> None:
    opts = build_s3_storage_options(
        {"TRUEPPM_S3_ACCESS_KEY_ID": "AKIA123", "TRUEPPM_S3_SECRET_ACCESS_KEY": "secret"}
    )
    assert opts["access_key"] == "AKIA123"
    assert opts["secret_key"] == "secret"


def test_minio_shaped_environ() -> None:
    """The configuration the docs now give for MinIO, end to end."""
    opts = build_s3_storage_options(
        {
            "TRUEPPM_S3_BUCKET_NAME": "trueppm-attachments",
            "TRUEPPM_S3_ENDPOINT_URL": "http://minio:9000",
            "TRUEPPM_S3_ADDRESSING_STYLE": "path",
            "TRUEPPM_S3_REGION_NAME": "us-east-1",
            "TRUEPPM_S3_ACCESS_KEY_ID": "minioadmin",
            "TRUEPPM_S3_SECRET_ACCESS_KEY": "minioadmin",
        }
    )
    assert opts["bucket_name"] == "trueppm-attachments"
    assert opts["endpoint_url"] == "http://minio:9000"
    assert opts["addressing_style"] == "path"


def test_explicit_overrides_win() -> None:
    opts = build_s3_storage_options(
        {
            "TRUEPPM_S3_REGION_NAME": "eu-west-2",
            "TRUEPPM_S3_SIGNATURE_VERSION": "s3",
            "TRUEPPM_S3_QUERYSTRING_EXPIRE": "60",
        }
    )
    assert opts["region_name"] == "eu-west-2"
    assert opts["signature_version"] == "s3"
    assert opts["querystring_expire"] == 60


def test_blank_override_falls_back_to_default() -> None:
    """An env var present-but-empty (a common Helm/compose artifact) must not
    produce an empty region, which would break SigV4's credential scope."""
    opts = build_s3_storage_options({"TRUEPPM_S3_REGION_NAME": "", "TRUEPPM_S3_ENDPOINT_URL": ""})
    assert opts["region_name"] == DEFAULT_REGION_NAME
    assert "endpoint_url" not in opts


def test_malformed_expiry_falls_back_rather_than_crashing_boot() -> None:
    """A typo in a tuning knob must not lock an operator out of their deploy."""
    opts = build_s3_storage_options({"TRUEPPM_S3_QUERYSTRING_EXPIRE": "fifteen minutes"})
    assert opts["querystring_expire"] == DEFAULT_QUERYSTRING_EXPIRE


# ---------------------------------------------------------------------------
# The backend the docs recommend is importable AND usable (#2559)
# ---------------------------------------------------------------------------


def test_documented_backend_is_in_the_s3_family_set() -> None:
    assert _S3 in S3_STORAGE_BACKENDS


def test_documented_backend_imports() -> None:
    """Regression guard for the issue itself: this raised ModuleNotFoundError
    before django-storages was a dependency, while four operator-facing surfaces
    told operators to configure exactly this value."""
    from storages.backends.s3 import S3Storage

    assert S3Storage is not None


def test_documented_backend_presigns_with_an_expiry() -> None:
    """Instantiate the real backend with the real built options and prove .url()
    returns a genuinely time-limited SigV4 URL — the promise the signed-url action
    makes via storage_backend_supports_signed_urls. No network: presigning is a
    local HMAC over the request, so this needs no bucket to exist.
    """
    from storages.backends.s3 import S3Storage

    opts = build_s3_storage_options(
        {
            "TRUEPPM_S3_BUCKET_NAME": "trueppm-attachments",
            "TRUEPPM_S3_ENDPOINT_URL": "http://minio:9000",
            "TRUEPPM_S3_ADDRESSING_STYLE": "path",
            "TRUEPPM_S3_ACCESS_KEY_ID": "ak",
            "TRUEPPM_S3_SECRET_ACCESS_KEY": "sk",
        }
    )
    url = S3Storage(**opts).url("attachments/report.pdf")

    assert "X-Amz-Algorithm=AWS4-HMAC-SHA256" in url, "not a SigV4 presigned URL"
    assert f"X-Amz-Expires={DEFAULT_QUERYSTRING_EXPIRE}" in url
    assert "X-Amz-Signature=" in url
    # SigV2 markers must be absent — their presence would mean the deprecated
    # scheme, which is what botocore falls back to without signature_version.
    assert "AWSAccessKeyId=" not in url


def test_requested_ttl_reaches_the_signature() -> None:
    """The signed_url action passes its `ttl` to storage.url(expire=...) (#2559).

    Without that, django-storages signs with the backend's own querystring_expire
    and the action's `expires_at` is fiction: a client asking for the 3600s maximum
    got a URL that actually died after 900. This asserts the backend honors a
    per-call expiry, which is the mechanism the view relies on.
    """
    import re

    from storages.backends.s3 import S3Storage

    opts = build_s3_storage_options({"TRUEPPM_S3_BUCKET_NAME": "b"})
    opts.update(access_key="ak", secret_key="sk")
    storage = S3Storage(**opts)

    default_url = storage.url("a.pdf")
    long_url = storage.url("a.pdf", expire=3600)

    assert re.search(r"X-Amz-Expires=(\d+)", default_url).group(1) == str(  # type: ignore[union-attr]
        DEFAULT_QUERYSTRING_EXPIRE
    )
    assert re.search(r"X-Amz-Expires=(\d+)", long_url).group(1) == "3600"  # type: ignore[union-attr]


def test_storage_expire_seconds_reads_both_spellings() -> None:
    """The view's fallback for a backend whose url() takes no expire kwarg."""
    import datetime

    from trueppm_api.apps.projects.views import _storage_expire_seconds

    class _S3Like:
        querystring_expire = 900

    class _GcsLike:
        expiration = datetime.timedelta(minutes=30)

    class _Neither:
        pass

    assert _storage_expire_seconds(_S3Like()) == 900
    assert _storage_expire_seconds(_GcsLike()) == 1800
    assert _storage_expire_seconds(_Neither()) is None


def test_bare_backend_without_options_fails_on_save() -> None:
    """Documents the exact pre-fix failure mode, so the reason the OPTIONS plumbing
    exists cannot be refactored away by someone who assumes the BACKEND string was
    sufficient on its own."""
    from django.core.files.base import ContentFile
    from storages.backends.s3 import S3Storage

    with pytest.raises(ValueError, match="Required parameter name not set"):
        S3Storage().save("probe.txt", ContentFile(b"x"))
