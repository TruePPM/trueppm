"""Live S3 round-trip against a real MinIO service (#2559).

This is the test that closes the gap the issue is about. `test_s3_storage_options`
proves the options are *built* right and that presigning is SigV4; nothing proved
an attachment could actually be stored and read back, which is why four
operator-facing surfaces could recommend a backend the image could not even
import.

Skipped unless ``TRUEPPM_S3_ENDPOINT_URL`` points at an S3-compatible endpoint, so
a developer's `pytest` stays offline and hermetic. The `api:s3-drill` CI job
supplies a MinIO service and sets it (see .gitlab-ci.yml).

Marked ``enable_socket`` because conftest bans outbound sockets to non-infra hosts
(#1653) and MinIO is deliberately a real network dependency here.
"""

from __future__ import annotations

import os
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from trueppm_api.core.storage_config import build_s3_storage_options

_ENDPOINT = os.environ.get("TRUEPPM_S3_ENDPOINT_URL", "")

pytestmark = [
    pytest.mark.skipif(
        not _ENDPOINT,
        reason="TRUEPPM_S3_ENDPOINT_URL unset — run under the api:s3-drill job or a local MinIO",
    ),
    pytest.mark.enable_socket,
]


@pytest.fixture
def s3_options() -> dict[str, Any]:
    """Options for a bucket unique to this run, so parallel shards never collide."""
    opts = build_s3_storage_options(dict(os.environ))
    opts["bucket_name"] = f"trueppm-drill-{uuid.uuid4().hex[:12]}"
    return opts


@pytest.fixture
def storage(s3_options: dict[str, Any]) -> Iterator[Any]:
    """A real S3Storage against MinIO, with its bucket created and then removed."""
    import boto3
    from storages.backends.s3 import S3Storage

    client = boto3.client(
        "s3",
        endpoint_url=s3_options["endpoint_url"],
        aws_access_key_id=s3_options["access_key"],
        aws_secret_access_key=s3_options["secret_key"],
        region_name=s3_options["region_name"],
    )
    bucket = s3_options["bucket_name"]
    client.create_bucket(Bucket=bucket)
    try:
        yield S3Storage(**s3_options)
    finally:
        # Empty then delete — S3 refuses to drop a non-empty bucket.
        listing = client.list_objects_v2(Bucket=bucket)
        for obj in listing.get("Contents", []):
            client.delete_object(Bucket=bucket, Key=obj["Key"])
        client.delete_bucket(Bucket=bucket)


def test_upload_and_read_back(storage: Any) -> None:
    """The plain durability claim: an attachment survives a write and reads back."""
    from django.core.files.base import ContentFile

    name = storage.save("attachments/report.pdf", ContentFile(b"%PDF-1.7 fake"))
    assert storage.exists(name)
    with storage.open(name) as fh:
        assert fh.read() == b"%PDF-1.7 fake"


def test_presigned_url_actually_downloads(storage: Any) -> None:
    """The signed-url action's promise, end to end: the URL it hands a client must
    be fetchable by an *unauthenticated* HTTP GET. `storage_backend_supports_signed_urls`
    allow-lists this backend on the strength of exactly this behavior, and until now
    nothing verified it against a live endpoint."""
    from django.core.files.base import ContentFile

    name = storage.save("attachments/signed.txt", ContentFile(b"signed-body"))
    url = storage.url(name)

    assert "X-Amz-Signature=" in url, "not a SigV4 presigned URL"
    with urllib.request.urlopen(url, timeout=15) as resp:
        assert resp.status == 200
        assert resp.read() == b"signed-body"


def test_unsigned_url_is_rejected(storage: Any) -> None:
    """The other half of the promise: strip the signature and the object must NOT be
    readable. A bucket left world-readable would make the presigned URL security
    theater, so assert the negative rather than infer it."""
    from django.core.files.base import ContentFile

    name = storage.save("attachments/private.txt", ContentFile(b"private-body"))
    bare = storage.url(name).split("?")[0]

    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(bare, timeout=15)
    assert exc.value.code in (401, 403), f"unsigned GET returned {exc.value.code}, not a denial"


def test_per_call_expiry_is_honored_by_the_server(storage: Any) -> None:
    """A URL signed with expire=1 must be REJECTED by MinIO once it lapses, proving
    the per-call TTL the signed_url action passes is enforced server-side and not
    merely echoed in the query string (#2559)."""
    import time

    from django.core.files.base import ContentFile

    name = storage.save("attachments/shortlived.txt", ContentFile(b"body"))
    url = storage.url(name, expire=1)
    time.sleep(3)

    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(url, timeout=15)
    assert exc.value.code in (400, 403), f"expired URL returned {exc.value.code}, not a rejection"


def test_same_name_does_not_overwrite(storage: Any) -> None:
    """file_overwrite=False (see storage_config): two users uploading `report.pdf`
    to one task must not destroy each other's attachment."""
    from django.core.files.base import ContentFile

    first = storage.save("attachments/dup.txt", ContentFile(b"first"))
    second = storage.save("attachments/dup.txt", ContentFile(b"second"))

    assert first != second, "second upload overwrote the first — file_overwrite regressed"
    with storage.open(first) as fh:
        assert fh.read() == b"first"


def test_deploy_check_is_clean_against_the_live_config(s3_options: dict[str, Any]) -> None:
    """The configuration the docs now give must pass the deploy check it ships with,
    so `manage.py check --deploy` cannot contradict an install that demonstrably
    works — the preceding tests proved these same options round-trip."""
    from trueppm_api.core.security_checks import validate_storage_backend

    assert (
        validate_storage_backend("storages.backends.s3.S3Storage", backend_options=s3_options) == []
    )
