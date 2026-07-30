"""Pure builder for the S3 / MinIO attachment-storage options (#2559).

Deliberately free of any Django import, for the same reason as
``core.valkey_config``: ``settings/base.py`` needs :func:`build_s3_storage_options`
at module import time, and it must not drag the check registry in while settings
are still being read.

Why this exists at all: django-storages' ``S3Storage`` reads its bucket from
*Django settings*, not the environment, so setting
``TRUEPPM_DEFAULT_FILE_STORAGE=storages.backends.s3.S3Storage`` — the value all
four operator-facing surfaces recommend — was necessary but never sufficient. The
backend instantiated fine and then failed on the first upload with a bare
``ValueError: Required parameter name not set``. This module maps
``TRUEPPM_S3_*`` env vars onto the ``STORAGES['default']['OPTIONS']`` dict that
django-storages 1.14+ accepts.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

#: Backends that take the S3 option set below. The legacy ``S3Boto3Storage`` alias
#: is included because django-storages still ships it and older operator runbooks
#: name it. Mirrored by ``core.security_checks._S3_FAMILY_BACKENDS``.
S3_STORAGE_BACKENDS = frozenset(
    {
        "storages.backends.s3.S3Storage",
        "storages.backends.s3boto3.S3Boto3Storage",
    }
)

#: SigV4 is not botocore's default once an ``endpoint_url`` is supplied — it falls
#: back to the deprecated SigV2 (``?AWSAccessKeyId=…&Signature=…``), which AWS
#: rejects in every region created after 2014. Defaulting it forward is what makes
#: the ``signed-url`` action hand out a real ``X-Amz-Expires`` URL rather than a
#: SigV2 one, so the promise in ``storage_backend_supports_signed_urls`` holds.
DEFAULT_SIGNATURE_VERSION = "s3v4"

#: Region must be concrete for SigV4: the signature embeds it in the credential
#: scope, so an empty region yields an unusable signature even against MinIO.
DEFAULT_REGION_NAME = "us-east-1"

#: Presigned-URL lifetime, in seconds, for TaskAttachmentViewSet.signed_url.
DEFAULT_QUERYSTRING_EXPIRE = 900


def _int_or_default(raw: str, default: int) -> int:
    """Coerce an env value to int, falling back rather than crashing the boot.

    A malformed expiry is not worth refusing to start over — the default is safe,
    and the alternative is an operator locked out of their own deploy by a typo in
    a tuning knob.
    """
    try:
        return int(raw)
    except ValueError:
        return default


def build_s3_storage_options(environ: Mapping[str, str]) -> dict[str, Any]:
    """Build ``STORAGES['default']['OPTIONS']`` for an S3-family backend.

    Only the keys the operator actually set are emitted for the optional knobs:
    passing ``endpoint_url=""`` would stop boto3 resolving the real AWS endpoint,
    and passing empty credentials would defeat its resolution chain (IRSA, IAM
    instance profile, ``~/.aws``) — which is how a well-run EKS deploy should
    authenticate. ``bucket_name`` is always emitted, even empty, so the deploy
    check in ``core.security_checks`` can report it as missing with a message that
    names the env var.
    """
    options: dict[str, Any] = {
        "bucket_name": environ.get("TRUEPPM_S3_BUCKET_NAME", ""),
        "region_name": environ.get("TRUEPPM_S3_REGION_NAME") or DEFAULT_REGION_NAME,
        "signature_version": (
            environ.get("TRUEPPM_S3_SIGNATURE_VERSION") or DEFAULT_SIGNATURE_VERSION
        ),
        "querystring_expire": _int_or_default(
            environ.get("TRUEPPM_S3_QUERYSTRING_EXPIRE", ""),
            DEFAULT_QUERYSTRING_EXPIRE,
        ),
        # django-storages defaults file_overwrite=True, which silently REPLACES the
        # object already at that key. TaskAttachment keys derive from user-supplied
        # filenames, so two people uploading `report.pdf` to one task would destroy
        # the first attachment. FileSystemStorage suffixes instead of overwriting;
        # match it, so choosing a storage backend is not also choosing data loss.
        "file_overwrite": False,
        # Never attach a canned public ACL. Attachments are project-scoped and
        # reached only through a presigned URL.
        "default_acl": None,
    }

    # Non-AWS S3-compatible endpoint (MinIO, Ceph RGW, Cloudflare R2, Wasabi).
    if endpoint := environ.get("TRUEPPM_S3_ENDPOINT_URL", ""):
        options["endpoint_url"] = endpoint
    # MinIO and Ceph need path-style addressing; AWS prefers virtual-hosted, and
    # boto3's own "auto" default already gets AWS right — so only override on ask.
    if addressing := environ.get("TRUEPPM_S3_ADDRESSING_STYLE", ""):
        options["addressing_style"] = addressing
    if access_key := environ.get("TRUEPPM_S3_ACCESS_KEY_ID", ""):
        options["access_key"] = access_key
    if secret_key := environ.get("TRUEPPM_S3_SECRET_ACCESS_KEY", ""):
        options["secret_key"] = secret_key

    return options
