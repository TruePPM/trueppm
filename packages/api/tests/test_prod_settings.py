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
import tempfile
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from unittest import mock

import pytest

from trueppm_api.core.security_checks import MIN_SERVICE_PASSWORD_LENGTH, validate_secret_key
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


# A DATABASE_URL that clears the #1550 unencrypted-DB boot guard.
_DB_URL_TLS = "postgres://u:p@db.example.com:5432/trueppm?sslmode=require"
# A DATABASE_URL that trips the #1550 guard (no sslmode parameter).
_DB_URL_PLAINTEXT = "postgres://u:p@db.example.com:5432/trueppm"

# A REDIS_URL with no password at all, so the #3176 datastore-credential guard is
# neutral unless a test deliberately supplies one.
_REDIS_URL_CLEAN = "redis://valkey:6379/0"
# Long enough to clear the #3176 length floor and not a known placeholder. Derived
# from the constant so it cannot drift if the floor moves, and deliberately a
# repeated character: a high-entropy literal next to a PASSWORD identifier trips
# the gitleaks pre-commit hook, and no test here needs the entropy.
_STRONG_DATASTORE_PASSWORD = "s" * MIN_SERVICE_PASSWORD_LENGTH

# A writable MEDIA_ROOT for the #3184 boot probe. Module-scoped rather than a
# tmp_path fixture because _load_prod is a plain helper, not a fixture consumer,
# and every caller that opts into local storage needs one.
_WRITABLE_MEDIA_ROOT = Path(tempfile.mkdtemp(prefix="trueppm-prod-settings-media-"))

#: chmod cannot make a directory unwritable to root, so the refusal cases below
#: would report a false red on a root runner rather than exercise anything.
#: CI runs as `ci` (.gitlab/ci-images/api.Dockerfile).
_requires_non_root = pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root bypasses directory permissions, so the unwritable-path probe cannot fail",
)


def _load_prod(
    *,
    backend: str,
    allow_local: bool,
    encryption_key: str = _VALID_FERNET_KEY,
    database_url: str = _DB_URL_TLS,
    allow_unencrypted_db: bool = False,
    jwt_signing_key: str | None = None,
    db_password: str | None = None,
    redis_url: str = _REDIS_URL_CLEAN,
    media_root: str | Path | None = None,
) -> ModuleType:
    """Import (or re-import) settings/prod.py with controlled storage + env.

    prod.py reads ALLOWED_HOSTS/SECRET_KEY/DATABASE_URL/JWT_SIGNING_KEY from the
    environment and STORAGES/ALLOW_LOCAL_ATTACHMENT_STORAGE/
    INTEGRATION_ENCRYPTION_KEY/ALLOW_UNENCRYPTED_DB from ``base`` at import time.
    We patch each so the guards run against known inputs without mutating the live
    settings (the ``DATABASES`` patch keeps prod's CONN_MAX_AGE write off the
    shared dict). ``database_url`` defaults to an sslmode=require URL so the #1550
    guard passes unless a test deliberately supplies a plaintext one.
    ``jwt_signing_key`` is only injected into the env when provided (#2247); left
    unset, prod's JWT_SIGNING_KEY inherits SECRET_KEY. ``db_password``/``redis_url``
    feed the #3176 datastore-credential guard and default to a passwordless pair,
    which that guard deliberately treats as none of its business.

    ``media_root`` feeds the #3184 writability probe, which only runs behind the
    local-storage opt-in. It defaults to a writable temp directory so a test
    asserting "the opt-in boots" is asserting the opt-in and not the test host's
    /var/lib permissions; pass an unwritable path to exercise the refusal.
    """
    storages = {
        "default": {"BACKEND": backend},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
    env_overrides = {
        "ALLOWED_HOSTS": "prod.example.com",
        "SECRET_KEY": _STRONG_KEY,
        "TRUEPPM_SECURE_SSL_REDIRECT": "false",
        "DATABASE_URL": database_url,
    }
    if jwt_signing_key is not None:
        env_overrides["JWT_SIGNING_KEY"] = jwt_signing_key
    with (
        mock.patch.dict(os.environ, env_overrides),
        mock.patch.object(base, "STORAGES", storages),
        mock.patch.object(base, "ALLOW_LOCAL_ATTACHMENT_STORAGE", allow_local),
        mock.patch.object(base, "ALLOW_UNENCRYPTED_DB", allow_unencrypted_db),
        mock.patch.object(base, "INTEGRATION_ENCRYPTION_KEY", encryption_key),
        mock.patch.object(base, "DATABASES", {"default": {"PASSWORD": db_password}}),
        mock.patch.object(base, "REDIS_URL", redis_url),
        mock.patch.object(base, "MEDIA_ROOT", Path(media_root or _WRITABLE_MEDIA_ROOT)),
    ):
        # Ensure a stale JWT_SIGNING_KEY from a prior test's patched env never
        # bleeds in when this call means to test the inherit-SECRET_KEY default.
        if jwt_signing_key is None:
            os.environ.pop("JWT_SIGNING_KEY", None)
        existing = sys.modules.get(_PROD)
        if existing is None:
            return importlib.import_module(_PROD)
        return importlib.reload(existing)


@pytest.fixture(autouse=True)
def _drop_reloaded_prod() -> Iterator[None]:
    """Drop the reloaded prod module and restore the shared SIMPLE_JWT signing key.

    prod.py re-derives ``SIMPLE_JWT["SIGNING_KEY"]`` and mutates the dict imported
    from ``base`` (the same object the live settings use), so a prod-load test
    would otherwise leave the signing key pointing at a test value. Snapshot and
    restore it so JWT auth in unrelated tests keeps using the live key.
    """
    original_signing_key = base.SIMPLE_JWT.get("SIGNING_KEY")
    yield
    sys.modules.pop(_PROD, None)
    base.SIMPLE_JWT["SIGNING_KEY"] = original_signing_key


def test_prod_boots_and_sets_security_headers() -> None:
    prod = _load_prod(backend=_S3, allow_local=False)
    assert prod.DEBUG is False
    assert prod.SECURE_CONTENT_TYPE_NOSNIFF is True
    assert prod.SECURE_REFERRER_POLICY == "same-origin"
    # HTTP→HTTPS redirect is opt-in (default off) with the k8s probe paths exempt.
    assert prod.SECURE_SSL_REDIRECT is False
    assert "^api/v1/health/$" in prod.SECURE_REDIRECT_EXEMPT
    assert "^api/v1/edition/$" in prod.SECURE_REDIRECT_EXEMPT


def test_prod_authenticates_with_jwt_and_owner_token_only() -> None:
    """Prod drops SessionAuthentication — no unused second auth surface (#2248, #2547)."""
    prod = _load_prod(backend=_S3, allow_local=False)
    assert prod.REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"] == [
        "trueppm_api.apps.projects.authentication.OwnerScopedApiTokenAuthentication",
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ]


def test_prod_pins_secure_session_and_csrf_cookies() -> None:
    """Prod keeps the base SameSite/HttpOnly pins and adds Secure (#2248)."""
    prod = _load_prod(backend=_S3, allow_local=False)
    assert prod.SESSION_COOKIE_HTTPONLY is True
    assert prod.SESSION_COOKIE_SAMESITE == "Lax"
    assert prod.CSRF_COOKIE_SAMESITE == "Lax"
    assert prod.SESSION_COOKIE_SECURE is True
    assert prod.CSRF_COOKIE_SECURE is True


def test_prod_refuses_local_attachment_storage() -> None:
    """A local-disk attachment backend without opt-in stops the boot (#775)."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        _load_prod(backend=_LOCAL, allow_local=False)


def test_prod_boots_on_local_storage_when_opted_in() -> None:
    """TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE lets local storage through."""
    prod = _load_prod(backend=_LOCAL, allow_local=True)
    assert prod.STORAGES["default"]["BACKEND"] == _LOCAL


@_requires_non_root
def test_prod_refuses_local_storage_opt_in_without_a_writable_media_root(
    tmp_path: Path,
) -> None:
    """The opt-in is a claim about the deployment; #3184 made it falsifiable.

    Before this, the opt-in plus no MEDIA_ROOT at all — every containerized
    deploy — booted clean and then failed every upload with EROFS.
    """
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        with pytest.raises(RuntimeError, match="Refusing to start"):
            _load_prod(backend=_LOCAL, allow_local=True, media_root=locked)
    finally:
        locked.chmod(0o700)


@_requires_non_root
def test_prod_ignores_media_root_on_object_storage(tmp_path: Path) -> None:
    """An S3 deploy never touches MEDIA_ROOT, so the probe must not gate it."""
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        prod = _load_prod(backend=_S3, allow_local=True, media_root=locked)
        assert prod.STORAGES["default"]["BACKEND"] == _S3
    finally:
        locked.chmod(0o700)


def test_prod_refuses_empty_integration_encryption_key() -> None:
    """An empty INTEGRATION_ENCRYPTION_KEY stops the boot (#1002)."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        _load_prod(backend=_S3, allow_local=False, encryption_key="")


def test_prod_refuses_unencrypted_database_url() -> None:
    """A DATABASE_URL without sslmode and no opt-in stops the boot (#1550)."""
    with pytest.raises(RuntimeError, match="sslmode=require"):
        _load_prod(backend=_S3, allow_local=False, database_url=_DB_URL_PLAINTEXT)


def test_prod_boots_with_sslmode_require() -> None:
    """A DATABASE_URL carrying sslmode=require clears the #1550 guard."""
    prod = _load_prod(backend=_S3, allow_local=False, database_url=_DB_URL_TLS)
    assert prod.DEBUG is False


def test_prod_boots_on_unencrypted_db_when_opted_in() -> None:
    """TRUEPPM_ALLOW_UNENCRYPTED_DB lets a plaintext DATABASE_URL through (#1550)."""
    prod = _load_prod(
        backend=_S3,
        allow_local=False,
        database_url=_DB_URL_PLAINTEXT,
        allow_unencrypted_db=True,
    )
    assert prod.DEBUG is False


# ---------------------------------------------------------------------------
# #3176: datastore credentials. compose's ${DB_PASSWORD:?...} only proves the
# variable is *set*, which the change-me string .env.example shipped satisfies —
# so the documented copy-paste path produced a deploy nothing rejected.
# ---------------------------------------------------------------------------


def test_prod_refuses_placeholder_database_password() -> None:
    """The exact string .env.example shipped stops the boot (#3176)."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        _load_prod(backend=_S3, allow_local=False, db_password="change-me")


def test_prod_refuses_placeholder_valkey_password() -> None:
    """The cache credential is guarded independently of the database one (#3176)."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        _load_prod(
            backend=_S3,
            allow_local=False,
            redis_url="redis://:change-me@valkey:6379/0",
        )


def test_prod_refuses_short_database_password() -> None:
    """Weak-but-not-placeholder is refused too, or the guard only blocks one string."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        _load_prod(backend=_S3, allow_local=False, db_password="short")


def test_prod_boots_with_strong_datastore_passwords() -> None:
    """Strong credentials on both datastores clear the #3176 guard."""
    prod = _load_prod(
        backend=_S3,
        allow_local=False,
        db_password=_STRONG_DATASTORE_PASSWORD,
        redis_url=f"redis://:{_STRONG_DATASTORE_PASSWORD}@valkey:6379/0",
    )
    assert prod.DEBUG is False


def test_prod_boots_when_datastores_use_passwordless_auth() -> None:
    """Trust auth / IAM / client certs have no password for the guard to weaken."""
    prod = _load_prod(backend=_S3, allow_local=False)
    assert prod.DEBUG is False


# ---------------------------------------------------------------------------
# #2247: dedicated JWT signing key. Unset → inherits SECRET_KEY; a distinct value
# is strength-validated at boot exactly like SECRET_KEY.
# ---------------------------------------------------------------------------


def test_prod_signing_key_defaults_to_secret_key() -> None:
    """With JWT_SIGNING_KEY unset, SIMPLE_JWT signs with SECRET_KEY (#2247)."""
    prod = _load_prod(backend=_S3, allow_local=False)
    assert prod.JWT_SIGNING_KEY == _STRONG_KEY
    assert prod.SIMPLE_JWT["SIGNING_KEY"] == _STRONG_KEY


def test_prod_boots_with_distinct_strong_signing_key() -> None:
    """A distinct, strong JWT_SIGNING_KEY is accepted and wired into SIMPLE_JWT."""
    distinct = "j" * 50  # ≥ 32, no placeholder prefix, != SECRET_KEY
    prod = _load_prod(backend=_S3, allow_local=False, jwt_signing_key=distinct)
    assert distinct == prod.JWT_SIGNING_KEY
    assert prod.SIMPLE_JWT["SIGNING_KEY"] == distinct
    assert prod.SIMPLE_JWT["SIGNING_KEY"] != prod.SECRET_KEY


def test_prod_refuses_distinct_weak_signing_key() -> None:
    """A distinct-but-weak JWT_SIGNING_KEY stops the boot (#2247)."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        _load_prod(backend=_S3, allow_local=False, jwt_signing_key="short")


# ---------------------------------------------------------------------------
# #1716: the Helm chart's two DATABASE_URL paths must stay consistent with this
# boot guard WITHOUT training operators to disable the encryption check.
#
#   - Bundled dev/demo datastore + NetworkPolicy enforced: the chart's built
#     DATABASE_URL is plaintext (no sslmode) but the pod network isolates the
#     hop, so the chart AUTO-sets TRUEPPM_ALLOW_UNENCRYPTED_DB=true. Boot must
#     succeed — no manual toggle, no crash-loop.
#   - External/managed DB (postgresql.enabled=false): the chart emits NO auto
#     flag, so the operator's DATABASE_URL must still carry sslmode=require. A
#     plaintext external URL must still fail closed.
#
# These two tests pin the settings-side contract the chart depends on; the chart
# side (which env each path renders) is verified by `helm template` in the Helm
# package's own checks.
# ---------------------------------------------------------------------------


def test_bundled_datastore_posture_boots_on_plaintext_db() -> None:
    """Bundled DB + NetworkPolicy: chart auto-sets the flag, so a plaintext
    DATABASE_URL boots cleanly (#1716)."""
    prod = _load_prod(
        backend=_S3,
        allow_local=False,
        database_url=_DB_URL_PLAINTEXT,
        allow_unencrypted_db=True,  # what the chart injects for the bundled+NP shape
    )
    assert prod.DEBUG is False


def test_external_db_posture_still_requires_sslmode() -> None:
    """External/managed DB: chart emits NO auto flag, so a plaintext external
    DATABASE_URL must still fail the boot guard (#1716)."""
    with pytest.raises(RuntimeError, match="sslmode=require"):
        _load_prod(
            backend=_S3,
            allow_local=False,
            database_url=_DB_URL_PLAINTEXT,
            allow_unencrypted_db=False,  # external path: chart injects nothing
        )


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


def test_env_example_ships_no_usable_secret_material() -> None:
    """No shipped secret may be a value a deploy could boot on (#3187).

    Asserted over EVERY secret in the file, not just SECRET_KEY: the failure was
    that one of four secrets shipped a passing value while the other three
    shipped empty, and nothing compared them. `cp .env.example .env` then gave a
    production install whose JWT signing key was published in this repository,
    because JWT_SIGNING_KEY defaults to SECRET_KEY.

    Empty is the only acceptable shipped value — init-prod.sh generates
    SECRET_KEY and refuses a placeholder in any of them. A non-empty value here
    must at minimum be one the validator rejects.
    """
    active = _parse_env_example()

    # SECRET_KEY must be EMPTY, not merely rejectable. init-prod.sh generates it
    # when empty, so shipping anything at all only trades a working first run for
    # a crash the operator has to diagnose — and a shipped value is one edit away
    # from being a passing one again.
    assert active.get("SECRET_KEY", "") == "", (
        ".env.example ships a non-empty SECRET_KEY; it must ship empty so "
        "init-prod.sh generates one (#3187)"
    )

    # The rest must at least be values the app refuses to boot on.
    for key in ("JWT_SIGNING_KEY", "DB_PASSWORD", "REDIS_PASSWORD"):
        value = active.get(key, "")
        if not value:
            continue
        assert validate_secret_key(value, debug=False), (
            f".env.example ships a non-empty {key}={value!r} that passes validation — "
            "a verbatim copy would deploy on a credential published in this repo"
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
