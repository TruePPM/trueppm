"""SECRET_KEY hardening — refuse to boot in prod with a weak key (#566).

PYSEC-2025-183 against pyjwt notes that key length is the caller's
responsibility. ``djangorestframework-simplejwt`` inherits Django's
``SECRET_KEY`` for ``SIGNING_KEY`` unless explicitly overridden, so any
weakness in ``SECRET_KEY`` flows directly into JWT signing. Django's own
``check_secret_key`` only warns; we want a hard refusal in prod.

Two enforcement paths share the same validator:

* ``manage.py check --deploy`` — exercised via the Django system-check
  registry below (tagged ``Tags.security``, ``deploy=True``).
* App boot — ``settings/prod.py`` calls :func:`validate_secret_key` at
  import time and raises ``RuntimeError`` on any error message. Without
  this, ``gunicorn``/``asgi`` workers never run system checks and a weak
  key would only surface at the first JWT verify failure.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from django.core.checks import Error, register
from django.core.checks.messages import CheckMessage
from django.core.checks.registry import Tags
from django.core.exceptions import ImproperlyConfigured
from django.utils.module_loading import import_string

from trueppm_api.core.storage_config import S3_STORAGE_BACKENDS

MIN_SECRET_KEY_LENGTH = 32

INSECURE_PREFIX = "django-insecure-"

# Remediation commands, extracted so the same generator isn't duplicated across every
# ``Error`` hint (SonarCloud S1192). The secrets variant seeds ``SECRET_KEY`` and the
# JWT signing key; the Fernet variant seeds the integration-credential encryption key.
_TOKEN_URLSAFE_CMD = 'python3 -c "import secrets; print(secrets.token_urlsafe(50))"'
_TOKEN_URLSAFE_HINT = f"Generate one with: {_TOKEN_URLSAFE_CMD}"
_FERNET_KEY_CMD = (
    'python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"'
)
_FERNET_KEY_HINT = f"Generate one with: {_FERNET_KEY_CMD}"


def validate_secret_key(secret_key: str | None, *, debug: bool) -> list[CheckMessage]:
    """Return Django check errors for a weak ``SECRET_KEY`` in prod.

    Returns an empty list when ``debug`` is True so developer workstations
    keep booting with the placeholder key from ``settings/base.py``.
    """
    if debug:
        return []

    errors: list[CheckMessage] = []

    if not secret_key:
        errors.append(
            Error(
                "SECRET_KEY is empty in a non-DEBUG environment.",
                hint=_TOKEN_URLSAFE_HINT,
                id="trueppm.E001",
            )
        )
        return errors

    if secret_key.startswith(INSECURE_PREFIX):
        errors.append(
            Error(
                f"SECRET_KEY starts with {INSECURE_PREFIX!r} — this is the "
                "Django placeholder and must not be used outside DEBUG.",
                hint=_TOKEN_URLSAFE_HINT,
                id="trueppm.E002",
            )
        )

    if len(secret_key) < MIN_SECRET_KEY_LENGTH:
        errors.append(
            Error(
                f"SECRET_KEY is {len(secret_key)} characters; minimum is {MIN_SECRET_KEY_LENGTH}.",
                hint=(
                    "JWT signing inherits SECRET_KEY when SIMPLE_JWT.SIGNING_KEY "
                    "is unset (PYSEC-2025-183). Generate a strong key with: " + _TOKEN_URLSAFE_CMD
                ),
                id="trueppm.E003",
            )
        )

    return errors


@register(Tags.security, deploy=True)
def check_secret_key(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — reads live settings."""
    from django.conf import settings

    return validate_secret_key(
        getattr(settings, "SECRET_KEY", None),
        debug=bool(getattr(settings, "DEBUG", False)),
    )


def validate_signing_key(
    signing_key: str | None,
    secret_key: str | None,
    *,
    debug: bool,
) -> list[CheckMessage]:
    """Return deploy errors for a weak, explicitly-set JWT ``SIGNING_KEY`` (#2247).

    When ``JWT_SIGNING_KEY`` is left unset it defaults to ``SECRET_KEY`` (see
    ``settings/base.py``), and :func:`validate_secret_key` already covers that
    value — re-validating here would double-report the same error. So this only
    fires when the operator has set a *distinct* signing key, and it applies the
    same strength bar (non-placeholder, ``>= MIN_SECRET_KEY_LENGTH``) because a
    separate-but-weak signing key would defeat the whole point of separating it.
    Returns an empty list under DEBUG so developer workstations keep booting.
    """
    if debug:
        return []
    if not signing_key or signing_key == secret_key:
        return []

    errors: list[CheckMessage] = []

    if signing_key.startswith(INSECURE_PREFIX):
        errors.append(
            Error(
                f"JWT_SIGNING_KEY starts with {INSECURE_PREFIX!r} — this is the "
                "Django placeholder and must not be used to sign tokens.",
                hint=_TOKEN_URLSAFE_HINT,
                id="trueppm.E004",
            )
        )

    if len(signing_key) < MIN_SECRET_KEY_LENGTH:
        errors.append(
            Error(
                f"JWT_SIGNING_KEY is {len(signing_key)} characters; "
                f"minimum is {MIN_SECRET_KEY_LENGTH}.",
                hint=(
                    "A separate JWT signing key must be at least as strong as "
                    "SECRET_KEY, or a leak of it forges tokens for any user. " + _TOKEN_URLSAFE_HINT
                ),
                id="trueppm.E005",
            )
        )

    return errors


@register(Tags.security, deploy=True)
def check_signing_key(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — reads live settings."""
    from django.conf import settings

    return validate_signing_key(
        getattr(settings, "JWT_SIGNING_KEY", None),
        getattr(settings, "SECRET_KEY", None),
        debug=bool(getattr(settings, "DEBUG", False)),
    )


# ---------------------------------------------------------------------------
# Attachment storage hardening — refuse to boot in prod when uploads would land
# on ephemeral local disk (#775).
# ---------------------------------------------------------------------------

_LOCAL_STORAGE_BACKENDS = frozenset(
    {
        "django.core.files.storage.FileSystemStorage",
        "django.core.files.storage.filesystem.FileSystemStorage",
    }
)


def validate_attachment_storage(
    default_storage_backend: str | None,
    *,
    debug: bool,
    allow_local: bool,
) -> list[CheckMessage]:
    """Return a deploy error when attachments would land on ephemeral local disk.

    ``TaskAttachment.file`` uses the default file-storage backend. In a
    containerized prod deploy a ``FileSystemStorage`` backend loses every upload
    on pod restart and the signed-url action returns a non-signed static path.
    Operators that back local storage with a persistent volume can opt in via
    ``TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true``. Returns an empty list under
    DEBUG so developer workstations keep using local storage.
    """
    if debug or allow_local:
        return []
    if default_storage_backend in _LOCAL_STORAGE_BACKENDS:
        return [
            Error(
                "Task attachments use local filesystem storage "
                f"({default_storage_backend}) in a non-DEBUG environment; uploads "
                "are lost on container/pod restart.",
                hint=(
                    "Point STORAGES['default']['BACKEND'] at a remote object-storage "
                    "backend (e.g. S3/MinIO via django-storages) using the "
                    "TRUEPPM_DEFAULT_FILE_STORAGE env var, or set "
                    "TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true if local storage is "
                    "backed by a persistent volume."
                ),
                id="trueppm.E004",
            )
        ]
    return []


@register(Tags.security, deploy=True)
def check_attachment_storage(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — reads live STORAGES + override flag."""
    from django.conf import settings

    storages = getattr(settings, "STORAGES", {}) or {}
    backend = storages.get("default", {}).get("BACKEND")
    return validate_attachment_storage(
        backend,
        debug=bool(getattr(settings, "DEBUG", False)),
        allow_local=bool(getattr(settings, "ALLOW_LOCAL_ATTACHMENT_STORAGE", False)),
    )


# ---------------------------------------------------------------------------
# Storage-backend importability (#2559)
#
# TRUEPPM_DEFAULT_FILE_STORAGE is a dotted path resolved lazily by Django, so a
# typo — or a backend whose package the image does not carry — surfaces as a bare
# ``ModuleNotFoundError`` on the first attachment upload rather than at deploy
# time. The image bundles django-storages' S3 extra only; GCS and Azure Blob are
# on the signed-url allow-list but need extras we do not ship, so the hint has to
# name the specific package to install rather than say "install django-storages".
# ---------------------------------------------------------------------------

#: Dotted-path prefix -> the pip requirement that provides it. Prefix-matched so a
#: subclass or a future backend module in the same package still resolves to the
#: right remediation.
_STORAGE_BACKEND_PACKAGES: tuple[tuple[str, str], ...] = (
    ("storages.backends.gcloud", "django-storages[google]"),
    ("storages.backends.azure_storage", "django-storages[azure]"),
    ("storages.backends.sftpstorage", "django-storages[sftp]"),
    ("storages.backends.dropbox", "django-storages[dropbox]"),
    ("storages.backends.s3", "django-storages[s3]"),
    ("storages.", "django-storages"),
)


def _remediation_package(backend_path: str) -> str | None:
    """Return the pip requirement providing ``backend_path``, if we know one."""
    for prefix, requirement in _STORAGE_BACKEND_PACKAGES:
        if backend_path.startswith(prefix):
            return requirement
    return None


def validate_storage_backend(
    default_storage_backend: str | None,
    *,
    backend_options: Mapping[str, object] | None = None,
) -> list[CheckMessage]:
    """Return deploy errors when the configured storage backend cannot work.

    Two failure modes, both of which used to surface only on the first upload:

    1. The dotted path does not import — the operator followed documentation for a
       backend whose package is absent from this image. The hint names the exact
       requirement to install, because the S3 extra we bundle does not cover the
       GCS/Azure backends the signed-url allow-list also recognizes.
    2. The path imports but an S3-family backend has no ``bucket_name`` — boto3
       raises an opaque ``ValueError: Required parameter name not set`` on save,
       which names neither the setting nor the backend.

    Runs in every environment including DEBUG: an unimportable backend is a
    misconfiguration on a developer workstation too, and catching it at
    ``manage.py check`` is strictly better than at upload time.
    """
    if not default_storage_backend:
        return []

    # ImproperlyConfigured as well as ImportError: django-storages' gcloud, azure,
    # and dropbox modules catch their own missing bindings at import and re-raise as
    # ImproperlyConfigured ("Could not load Google Cloud Storage bindings"), so an
    # ImportError-only except would miss exactly the unbundled extras this check is
    # for. Everything here is a "the configured backend cannot be loaded" failure
    # regardless of which exception type carries it.
    try:
        import_string(default_storage_backend)
    except (ImportError, ImproperlyConfigured) as exc:
        requirement = _remediation_package(default_storage_backend)
        hint = (
            f"Install it with: pip install '{requirement}' (this image bundles "
            "django-storages[s3] only), or point TRUEPPM_DEFAULT_FILE_STORAGE at a "
            "backend the image carries."
            if requirement
            else (
                "Check TRUEPPM_DEFAULT_FILE_STORAGE for a typo, or install the "
                "package that provides this backend."
            )
        )
        return [
            Error(
                f"STORAGES['default']['BACKEND'] is set to "
                f"{default_storage_backend!r}, which cannot be imported: {exc}.",
                hint=hint,
                id="trueppm.E007",
            )
        ]

    if default_storage_backend in S3_STORAGE_BACKENDS and not (backend_options or {}).get(
        "bucket_name"
    ):
        return [
            Error(
                f"{default_storage_backend} is configured without a bucket name; "
                "attachment uploads would fail with 'Required parameter name not set'.",
                hint=(
                    "Set TRUEPPM_S3_BUCKET_NAME to the bucket that holds task "
                    "attachments. For a non-AWS endpoint (MinIO, Ceph, R2) also set "
                    "TRUEPPM_S3_ENDPOINT_URL and TRUEPPM_S3_ADDRESSING_STYLE=path."
                ),
                id="trueppm.E008",
            )
        ]
    return []


@register(Tags.security, deploy=True)
def check_storage_backend(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — resolves the live STORAGES default."""
    from django.conf import settings

    storages = getattr(settings, "STORAGES", {}) or {}
    default = storages.get("default", {}) or {}
    return validate_storage_backend(
        default.get("BACKEND"),
        backend_options=default.get("OPTIONS"),
    )


# ---------------------------------------------------------------------------
# Signed-URL backend detection — the attachment ``signed-url`` action must refuse
# rather than lie when the storage backend can't actually produce a time-limited,
# user-scoped URL (#573, MED-2 follow-up to !306's security review).
# ---------------------------------------------------------------------------

#: Storage backends known to sign ``.url()`` with a query-string expiry (the
#: django-storages object-storage backends). Explicit allow-list, not a deny-list
#: of known-bad backends: an unrecognized backend (including a self-hoster's
#: custom one) might silently behave just like ``FileSystemStorage`` and return a
#: stable indefinite-lifetime path, which is exactly the misleading ``expires_at``
#: this check exists to prevent. Self-hosters running a signing-capable backend
#: not yet in this list can opt in via ``TRUEPPM_ATTACHMENT_STORAGE_SIGNS_URLS``.
_SIGNING_CAPABLE_STORAGE_BACKENDS = frozenset(
    {
        "storages.backends.s3boto3.S3Boto3Storage",  # django-storages, legacy class name
        "storages.backends.s3.S3Storage",  # django-storages >=1.14
        "storages.backends.gcloud.GoogleCloudStorage",  # django-storages GCS
        "storages.backends.azure_storage.AzureStorage",  # django-storages Azure Blob
    }
)


def storage_backend_supports_signed_urls(
    backend_path: str | None,
    *,
    force_signing_capable: bool = False,
) -> bool:
    """Whether ``backend_path``'s ``.url()`` produces a real time-limited signed URL.

    ``TaskAttachment.file.url`` is a genuine signed URL only for object-storage
    backends that sign the query string with an expiry (S3/MinIO, GCS, Azure Blob
    via django-storages). ``FileSystemStorage`` — and any backend this function
    doesn't recognize — returns the same indefinite-lifetime path on every call, so
    the ``expires_at`` the ``signed-url`` action promises would be fiction. Fails
    closed: only an explicitly allow-listed backend is trusted; the operator opt-in
    (``force_signing_capable``, wired to ``TRUEPPM_ATTACHMENT_STORAGE_SIGNS_URLS``)
    exists for a signing-capable backend not yet on the list rather than silently
    trusting an unrecognized one.
    """
    if force_signing_capable:
        return True
    return backend_path in _SIGNING_CAPABLE_STORAGE_BACKENDS


# ---------------------------------------------------------------------------
# Integration credential encryption key — refuse to boot in prod without a valid
# Fernet key (#1002). Mirrors the fail-closed posture chosen for SECRET_KEY
# (#566) and attachment storage (#775).
# ---------------------------------------------------------------------------


def validate_integration_encryption_key(
    key: str | None,
    *,
    debug: bool,
) -> list[CheckMessage]:
    """Return a deploy error when ``INTEGRATION_ENCRYPTION_KEY`` is missing/malformed.

    The key encrypts integration PATs at rest (ADR-0049). Its only existing guard
    is ``integrations.encryption._load_fernet``, which raises on the *first*
    encrypt/decrypt — so a prod deploy that forgets the key boots successfully and
    only 500s the first time a user connects a PAT, potentially long after deploy.
    This validator moves that failure to boot time. Returns an empty list under
    ``debug`` so dev / CI keep booting with the deterministic test key.
    """
    if debug:
        return []

    if not key:
        return [
            Error(
                "INTEGRATION_ENCRYPTION_KEY is empty in a non-DEBUG environment.",
                hint=(
                    "Integration credentials cannot be encrypted without it. " + _FERNET_KEY_HINT
                ),
                id="trueppm.E005",
            )
        ]

    # A truncated or garbled key must fail at boot, not at first encrypt. Fernet
    # requires a 32-byte urlsafe-base64 key and raises ValueError otherwise.
    from cryptography.fernet import Fernet

    try:
        Fernet(key.encode() if isinstance(key, str) else key)
    except (ValueError, TypeError):
        return [
            Error(
                "INTEGRATION_ENCRYPTION_KEY is not a valid Fernet key "
                "(expected 32-byte urlsafe-base64).",
                hint=_FERNET_KEY_HINT,
                id="trueppm.E006",
            )
        ]

    return []


@register(Tags.security, deploy=True)
def check_integration_encryption_key(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — reads live settings."""
    from django.conf import settings

    return validate_integration_encryption_key(
        getattr(settings, "INTEGRATION_ENCRYPTION_KEY", None),
        debug=bool(getattr(settings, "DEBUG", False)),
    )
