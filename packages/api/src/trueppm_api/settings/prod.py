"""Production settings — security hardened, secrets from environment."""

from __future__ import annotations

import environ

from trueppm_api.core.security_checks import (
    validate_attachment_storage,
    validate_integration_encryption_key,
    validate_secret_key,
)

from .base import *  # noqa: F403
from .base import (
    ALLOW_LOCAL_ATTACHMENT_STORAGE,
    DATABASES,
    INTEGRATION_ENCRYPTION_KEY,
    STORAGES,
)

env = environ.Env()

DEBUG = False

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS")

SECRET_KEY = env("SECRET_KEY")  # required; no default in prod

# Refuse to boot with a weak SECRET_KEY (#566, PYSEC-2025-183).
# Django's system-check registry only fires under `manage.py check`; gunicorn
# and asgi workers do not run checks at startup, so the failure must be
# raised at settings import time to actually stop a broken deploy.
_secret_key_errors = validate_secret_key(SECRET_KEY, debug=DEBUG)
if _secret_key_errors:
    raise RuntimeError("Refusing to start: " + "; ".join(str(e.msg) for e in _secret_key_errors))

# Persistent connections for production load.
DATABASES["default"]["CONN_MAX_AGE"] = 600

# Security headers.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
# HTTP→HTTPS redirect is opt-in: many deploys terminate TLS at the ingress and
# speak plain HTTP to the app (incl. the k8s liveness/readiness probes that hit
# /health/ and /edition/), where an unconditional redirect would break them.
# Operators that expose the app directly over TLS opt in via env; the probe
# paths stay exempt so they keep working over plain HTTP either way.
SECURE_SSL_REDIRECT = env.bool("TRUEPPM_SECURE_SSL_REDIRECT", default=False)
SECURE_REDIRECT_EXEMPT = [r"^api/v1/health/$", r"^api/v1/edition/$"]

# Refuse to boot when task attachments would land on ephemeral local disk in a
# containerized deploy (#775) — same import-time enforcement as the SECRET_KEY
# guard, since gunicorn/asgi workers never run `manage.py check`.
_storage_errors = validate_attachment_storage(
    STORAGES["default"]["BACKEND"],
    debug=DEBUG,
    allow_local=ALLOW_LOCAL_ATTACHMENT_STORAGE,
)
if _storage_errors:
    raise RuntimeError("Refusing to start: " + "; ".join(str(e.msg) for e in _storage_errors))

# Refuse to boot without a valid integration encryption key (#1002). The key
# encrypts integration PATs at rest; without this guard a missing/malformed key
# only surfaces as a 500 on the first PAT connect, long after deploy. Same
# import-time enforcement as the SECRET_KEY and storage guards above.
_integration_key_errors = validate_integration_encryption_key(
    INTEGRATION_ENCRYPTION_KEY, debug=DEBUG
)
if _integration_key_errors:
    raise RuntimeError(
        "Refusing to start: " + "; ".join(str(e.msg) for e in _integration_key_errors)
    )
