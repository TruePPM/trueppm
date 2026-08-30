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

import os
import urllib.parse
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path

from django.core.checks import Error, register
from django.core.checks.messages import CheckMessage
from django.core.checks.registry import Tags
from django.core.exceptions import ImproperlyConfigured
from django.utils.module_loading import import_string

from trueppm_api.core.storage_config import S3_STORAGE_BACKENDS

MIN_SECRET_KEY_LENGTH = 32

INSECURE_PREFIX = "django-insecure-"

# Deploy-check ids are an operator-facing contract — they are what goes into
# ``SILENCED_SYSTEM_CHECKS`` — so they are bound to constants rather than
# repeated, and must not be renumbered once shipped.
#
# E004 is deliberately shared by two unrelated checks: an untrustworthy
# JWT signing key and an unusable attachment-storage backend. That sharing
# predates this constant and is asserted by tests in both
# ``test_signing_key_check.py`` and ``test_secret_key_check.py``; naming it once
# here does not change it. The cost is that an operator silencing E004 for one
# also silences the other, which is worth splitting separately rather than as
# part of a Sonar cleanup.
_ID_UNTRUSTED_CONFIG = "trueppm.E004"

#: Prefixes of documented placeholder keys, matched case-insensitively (#3187).
#:
#: Length and the ``django-insecure-`` prefix were the only two things
#: ``validate_secret_key`` looked at, and the placeholder ``.env.example`` shipped
#: — ``REPLACE-WITH-A-LONG-RANDOM-STRING-AT-LEAST-32-CHARS-LONG`` — satisfied
#: both: 56 characters, no Django prefix. It therefore cleared this validator AND
#: ``validate_signing_key``, and because ``JWT_SIGNING_KEY`` defaults to
#: ``SECRET_KEY``, a verbatim ``cp .env.example .env`` (which the README and the
#: deployment guide both instruct) yielded a production install whose
#: token-signing key was published in this repository.
#:
#: The real fix is that the key now ships empty and ``init-prod.sh`` generates it;
#: this list is the backstop for an operator who reaches a deploy some other way,
#: and for the docs' own strings if they are ever copied verbatim again. Kept
#: deliberately short and prefix-matched, for the same reason
#: ``PLACEHOLDER_SERVICE_PASSWORDS`` is: a denylist that tries to be a
#: password-strength oracle produces false failures on legitimate secrets.
PLACEHOLDER_SECRET_KEY_PREFIXES = ("replace-with", "change-me", "changeme", "your-secret")

# Remediation commands, extracted so the same generator isn't duplicated across every
# ``Error`` hint (SonarCloud S1192). The secrets variant seeds ``SECRET_KEY`` and the
# JWT signing key; the Fernet variant seeds the integration-credential encryption key.
_TOKEN_URLSAFE_CMD = 'python3 -c "import secrets; print(secrets.token_urlsafe(50))"'
_TOKEN_URLSAFE_HINT = f"Generate one with: {_TOKEN_URLSAFE_CMD}"
_FERNET_KEY_CMD = (
    'python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"'
)
_FERNET_KEY_HINT = f"Generate one with: {_FERNET_KEY_CMD}"


def _is_placeholder_key(key: str) -> bool:
    """True when ``key`` starts with a documented placeholder prefix (#3187)."""
    lowered = key.lower()
    return any(lowered.startswith(prefix) for prefix in PLACEHOLDER_SECRET_KEY_PREFIXES)


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

    if _is_placeholder_key(secret_key):
        errors.append(
            Error(
                f"SECRET_KEY is a documented placeholder ({secret_key!r}) — it is "
                "published in this repository, so JWTs signed with it can be "
                "forged by anyone.",
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


# Placeholder credentials that ship in .env.example / docs and must never survive
# into a real deploy. Compared case-insensitively against the password component of
# DATABASE_URL / REDIS_URL. Kept deliberately short: this is a guard against the
# documented placeholder being left in place, not a password-strength oracle — a
# denylist that tries to be clever produces false failures on legitimate secrets.
PLACEHOLDER_SERVICE_PASSWORDS = frozenset(
    {
        "change-me",
        "changeme",
        "password",
        "postgres",
        "trueppm",
        "secret",
    }
)

MIN_SERVICE_PASSWORD_LENGTH = 12


def validate_service_credentials(
    db_password: str | None,
    redis_password: str | None,
    *,
    debug: bool,
) -> list[CheckMessage]:
    """Return errors for placeholder or absent DB / Valkey passwords in prod (#3176).

    The gap this closes: ``SECRET_KEY``, the attachment backend, the integration
    encryption key, and ``sslmode`` all refuse to boot when misconfigured, but the
    database and cache credentials were checked only for *presence* — by compose's
    ``${DB_PASSWORD:?...}``, which ``change-me`` satisfies. ``.env.example`` shipped
    exactly that string, so the documented copy-paste path produced a deploy whose
    every other credential was validated and whose datastore ones were not.

    Bounded on the bundled compose stack (neither service publishes a host port), so
    this is an ``Error`` about the credential itself rather than a claim of
    exploitability — and it stops being bounded the moment an operator repoints at an
    external database, which ``.env.example`` documents how to do.

    A URL with no password component at all is left alone: trust authentication
    (Unix socket, IAM, cert) is a legitimate posture and has no password to weaken.
    Returns an empty list when ``debug`` is True, like every sibling validator.
    """
    if debug:
        return []

    errors: list[CheckMessage] = []
    for label, password, err_id in (
        ("DATABASE_URL", db_password, "trueppm.E010"),
        ("REDIS_URL", redis_password, "trueppm.E011"),
    ):
        if not password:
            # No password component — trust auth (Unix socket, IAM, cert), or an
            # unauthenticated local service. Neither is this check's business.
            continue
        if password.lower() in PLACEHOLDER_SERVICE_PASSWORDS:
            errors.append(
                Error(
                    f"{label} uses the placeholder password {password!r} in a "
                    "non-DEBUG environment.",
                    hint=(
                        "This is the value shipped in .env.example as a fill-me-in. "
                        "Replace it with: " + _TOKEN_URLSAFE_CMD
                    ),
                    id=err_id,
                )
            )
        elif len(password) < MIN_SERVICE_PASSWORD_LENGTH:
            errors.append(
                Error(
                    f"{label} password is {len(password)} characters; minimum is "
                    f"{MIN_SERVICE_PASSWORD_LENGTH}.",
                    hint="Generate a strong one with: " + _TOKEN_URLSAFE_CMD,
                    id=err_id,
                )
            )
    return errors


@register(Tags.security, deploy=True)
def check_service_credentials(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — reads live settings."""
    from django.conf import settings

    databases = getattr(settings, "DATABASES", {}) or {}
    db_password = (databases.get("default") or {}).get("PASSWORD")
    redis_password = urllib.parse.urlparse(getattr(settings, "REDIS_URL", "") or "").password

    return validate_service_credentials(
        db_password,
        redis_password,
        debug=bool(getattr(settings, "DEBUG", False)),
    )


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
                id=_ID_UNTRUSTED_CONFIG,
            )
        )

    if _is_placeholder_key(signing_key):
        errors.append(
            Error(
                f"JWT_SIGNING_KEY is a documented placeholder ({signing_key!r}) — "
                "it is published in this repository, so tokens signed with it can "
                "be forged by anyone.",
                hint=_TOKEN_URLSAFE_HINT,
                id=_ID_UNTRUSTED_CONFIG,
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


def _media_root_write_failure(media_root: str | os.PathLike[str] | None) -> str | None:
    """Return why ``media_root`` cannot receive uploads, or None if it can.

    Probes with a real create-and-delete rather than ``os.access``: the container
    runs as a non-root UID against a volume whose ownership the operator controls,
    and ``os.access`` answers from the permission bits without accounting for a
    read-only mount, so it returns True on exactly the path that then raises
    EROFS. Missing parents are created — the chart mounts an empty PVC and Django
    would otherwise only create the tree on the first upload.

    The probe file is per-process and its removal tolerates being already gone.
    Six containers import these settings against ONE ReadWriteMany volume, and
    they boot together: with a shared probe name, two of them interleaving
    write/unlink leaves the loser's ``unlink`` raising ``FileNotFoundError`` —
    an ``OSError``, which this function would report as "not writable" and the
    boot guard would turn into a crash-loop on a perfectly good volume.
    """
    if media_root is None or str(media_root) == "":
        return "MEDIA_ROOT is empty, so uploads resolve against the process working directory"
    path = Path(media_root)
    if not path.is_absolute():
        return (
            f"MEDIA_ROOT {str(media_root)!r} is relative, so uploads follow the "
            "process working directory"
        )
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".trueppm-write-probe-{os.getpid()}-{uuid.uuid4().hex}"
        probe.write_bytes(b"")
        probe.unlink(missing_ok=True)
    except OSError as exc:
        return f"MEDIA_ROOT {str(path)!r} is not writable: {exc.strerror or exc}"
    return None


def validate_attachment_storage(
    default_storage_backend: str | None,
    *,
    debug: bool,
    allow_local: bool,
    media_root: str | os.PathLike[str] | None = None,
) -> list[CheckMessage]:
    """Return a deploy error when attachments cannot durably land on disk.

    Two distinct failures, both of which used to surface only on the first upload:

    1. ``TaskAttachment.file`` uses the default file-storage backend. In a
       containerized prod deploy a ``FileSystemStorage`` backend loses every
       upload on pod restart and the signed-url action returns a non-signed
       static path. Operators that back local storage with a persistent volume
       can opt in via ``TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true``.
    2. Having opted in, the operator may have no writable ``MEDIA_ROOT`` behind
       the opt-in — which was every deployment before #3184, because the setting
       did not exist and Django's default resolved against ``/app`` on a
       read-only root filesystem. The opt-in is a claim about the deployment
       ("local disk is durable here"); this check is what makes the claim testable
       at boot instead of at the first EROFS on upload. ``media_root`` is optional
       so a caller that only wants the backend question keeps the old signature.

    Returns an empty list under DEBUG so developer workstations keep using local
    storage.
    """
    if debug:
        return []

    is_local = default_storage_backend in _LOCAL_STORAGE_BACKENDS

    if allow_local:
        if not is_local or media_root is None:
            return []
        failure = _media_root_write_failure(media_root)
        if failure is None:
            return []
        return [
            Error(
                "TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE is set, but local "
                f"attachment storage cannot be used: {failure}.",
                hint=(
                    "Set TRUEPPM_MEDIA_ROOT to a writable persistent path and mount a "
                    "volume there. On Helm set persistence.media.enabled=true (the "
                    "chart mounts the claim on the api and celery-worker pods); on "
                    "docker compose the `media` volume is mounted at "
                    "/var/lib/trueppm/media. Or drop the opt-in and point "
                    "TRUEPPM_DEFAULT_FILE_STORAGE at object storage."
                ),
                id=_ID_UNTRUSTED_CONFIG,
            )
        ]

    if is_local:
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
                    "backed by a persistent volume (and TRUEPPM_MEDIA_ROOT points at "
                    "that volume)."
                ),
                id=_ID_UNTRUSTED_CONFIG,
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
        media_root=getattr(settings, "MEDIA_ROOT", None),
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


# ---------------------------------------------------------------------------
# MCP program-export policy (#3014)
#
# TRUEPPM_MCP_PROGRAM_EXPORT_POLICY takes one of two words. A typo cannot be
# allowed to silently pick a behavior: `program_export_policy()` falls back to the
# restrictive `withhold` on an unrecognized value, which is the right runtime
# default but also means a misspelled `allwo` would look like it worked and quietly
# do the opposite of what the operator wrote. This check makes the typo loud at
# deploy time so the fallback stays a safety net rather than a place mistakes hide.
#
# Registered as an Error rather than a Warning: the setting governs a consent
# control, and "your security policy is not the one you wrote" is not advisory.
# ---------------------------------------------------------------------------


def validate_mcp_program_export_policy(value: object) -> list[CheckMessage]:
    """Validate the configured program-export policy word."""
    from trueppm_api.apps.projects.mcp_settings import (
        PROGRAM_EXPORT_POLICIES,
        PROGRAM_EXPORT_WITHHOLD,
    )

    if isinstance(value, str) and value.strip().lower() in PROGRAM_EXPORT_POLICIES:
        return []
    allowed = ", ".join(sorted(PROGRAM_EXPORT_POLICIES))
    return [
        Error(
            f"TRUEPPM_MCP_PROGRAM_EXPORT_POLICY is {value!r}, which is not a "
            f"recognized policy ({allowed}).",
            hint=(
                "The running instance falls back to "
                f"{PROGRAM_EXPORT_WITHHOLD!r} (the safe value), so agent tokens are "
                "being refused a program bulk export whenever a member project has "
                "opted out of agent reads — which may not be what you intended. Fix "
                "the value or unset it to accept the default."
            ),
            id="trueppm.E009",
        )
    ]


@register(Tags.security, deploy=True)
def check_mcp_program_export_policy(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — reads the live setting."""
    from django.conf import settings

    return validate_mcp_program_export_policy(
        getattr(settings, "TRUEPPM_MCP_PROGRAM_EXPORT_POLICY", "withhold")
    )


def validate_project_soft_delete_retention(value: object) -> list[CheckMessage]:
    """Reject a soft-delete retention window of 0 days.

    ``TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS`` is the one retention window
    whose purge is irreversible and reaches user data: ``retention.run_purge``
    computes ``cutoff = now() - timedelta(days=value)``, so 0 makes the cutoff
    *now* and HARD-deletes every trashed project — with its tasks, dependencies,
    sprints and baselines, via DB CASCADE — on the next tick. There is no
    tombstone and no undo.

    The API already refuses it: ``RetentionPolicyWriteSerializer.value`` is
    ``IntegerField(min_value=1)``, so the Settings → System Health save-bar
    cannot store 0. The environment variable had no such floor, and the Helm
    chart's own comment told operators to set exactly this value "to keep the
    default" (#3186) — ``env.int`` parses ``"0"`` as 0, not as the default.

    Deliberately scoped to this one key. The other five windows cover log-shaped
    tables (webhooks, exports, imports, task runs, sync batches) where "keep
    nothing" is a defensible operator choice, and rejecting 0 there would
    crash-loop a working deployment on upgrade.

    Disabling the purge entirely is a different lever and still available: turn
    the policy off in Settings → System Health, which stores a
    ``RetentionPolicy`` row with ``enabled=False`` and resolves to ``None``.
    """
    if value != 0:
        return []
    return [
        Error(
            "TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS is 0, which hard-deletes "
            "every trashed project on the next retention purge.",
            hint=(
                "0 sets the purge cutoff to the present moment, so every project "
                "in the trash — and all of its tasks, dependencies, sprints and "
                "baselines, via CASCADE — is deleted irreversibly. Set the number "
                "of days to retain trashed projects (the default is 30), or unset "
                "the variable to accept that default. To stop auto-purging "
                "entirely, leave the variable alone and disable the policy in "
                "Settings → System Health instead."
            ),
            id="trueppm.E010",
        )
    ]


@register(Tags.security, deploy=True)
def check_project_soft_delete_retention(
    app_configs: Sequence[object] | None = None,
    **kwargs: object,
) -> list[CheckMessage]:
    """Django system check entry point — reads the live setting."""
    from django.conf import settings

    return validate_project_soft_delete_retention(
        getattr(settings, "TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS", 30)
    )
