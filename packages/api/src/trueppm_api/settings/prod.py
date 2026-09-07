"""Production settings — security hardened, secrets from environment."""

from __future__ import annotations

import logging
import urllib.parse

import environ

from trueppm_api.apps.observability.logging import build_logging_config
from trueppm_api.core.security_checks import (
    validate_allowed_hosts,
    validate_attachment_storage,
    validate_integration_encryption_key,
    validate_project_soft_delete_retention,
    validate_secret_key,
    validate_service_credentials,
    validate_signing_key,
)

from .base import *  # noqa: F403
from .base import (
    ALLOW_LOCAL_ATTACHMENT_STORAGE,
    ALLOW_UNENCRYPTED_DB,
    ALLOW_WILDCARD_ALLOWED_HOSTS,
    DATABASES,
    DJANGO_LOG_LEVEL,
    INTEGRATION_ENCRYPTION_KEY,
    MEDIA_ROOT,
    REDIS_URL,
    SIMPLE_JWT,
    STORAGES,
    TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS,
)

env = environ.Env()

DEBUG = False

# Prefix for every import-time boot-guard failure below.
_REFUSING_TO_START = "Refusing to start: "

# Force single-line JSON logs in production so a collector (Loki/ELK/CloudWatch)
# can index each record's fields — including the OTel trace_id/span_id/request_id
# the filter injects (ADR-0223, #1899) — for log-to-trace correlation. The base
# config defaults to human-readable console output for dev; here we always emit
# JSON regardless of TRUEPPM_LOG_JSON, while still honouring DJANGO_LOG_LEVEL.
LOGGING = build_logging_config(level=DJANGO_LOG_LEVEL, json_output=True)

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS")

# Refuse to boot on a bare-wildcard ALLOWED_HOSTS (#3515). Host validation is the
# only bound on the host the API reports, and therefore on every absolute URL it
# builds; "*" removes it. Same import-time enforcement as the guards below, since
# gunicorn/asgi workers never run `manage.py check`. Operators whose host set is
# genuinely unknowable opt in via TRUEPPM_ALLOW_WILDCARD_HOSTS=true and keep the
# warning instead — the TRUEPPM_ALLOW_UNENCRYPTED_DB shape, chosen so an existing
# install running "*" has a one-variable remedy rather than a crash-loop.
_wildcard_host_errors = validate_allowed_hosts(
    ALLOWED_HOSTS, debug=DEBUG, allow_wildcard=ALLOW_WILDCARD_ALLOWED_HOSTS
)
if _wildcard_host_errors:
    raise RuntimeError(_REFUSING_TO_START + "; ".join(str(e.msg) for e in _wildcard_host_errors))
if ALLOW_WILDCARD_ALLOWED_HOSTS and "*" in ALLOWED_HOSTS:
    logging.getLogger("trueppm.settings").warning(
        "ALLOWED_HOSTS contains the wildcard '*', so Django performs no host "
        "validation. Absolute URLs the API builds (the OIDC redirect_uri and the "
        "inbound Git-webhook URL) will follow whatever host the caller sends. "
        "Proceeding because TRUEPPM_ALLOW_WILDCARD_HOSTS=true is set."
    )

SECRET_KEY = env("SECRET_KEY")  # required; no default in prod

# Refuse to boot with a weak SECRET_KEY (#566, PYSEC-2025-183).
# Django's system-check registry only fires under `manage.py check`; gunicorn
# and asgi workers do not run checks at startup, so the failure must be
# raised at settings import time to actually stop a broken deploy.
_secret_key_errors = validate_secret_key(SECRET_KEY, debug=DEBUG)
if _secret_key_errors:
    raise RuntimeError(_REFUSING_TO_START + "; ".join(str(e.msg) for e in _secret_key_errors))

# Dedicated JWT signing key (#2247). base.py already derived JWT_SIGNING_KEY from
# the SECRET_KEY env var; re-derive it here against the prod-required SECRET_KEY so
# the binding is explicit and cannot drift, and mirror the value into SIMPLE_JWT.
# Then refuse to boot on a weak *explicit* key — an unset key inherits the
# already-validated SECRET_KEY, so validate_signing_key returns clean for it.
JWT_SIGNING_KEY = env("JWT_SIGNING_KEY", default=SECRET_KEY)
SIMPLE_JWT["SIGNING_KEY"] = JWT_SIGNING_KEY
_signing_key_errors = validate_signing_key(JWT_SIGNING_KEY, SECRET_KEY, debug=DEBUG)
if _signing_key_errors:
    raise RuntimeError(_REFUSING_TO_START + "; ".join(str(e.msg) for e in _signing_key_errors))

# Persistent connections for production load.
DATABASES["default"]["CONN_MAX_AGE"] = 600

# Security headers.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# The host is NOT taken from the proxy, and that asymmetry with the line above is
# deliberate (#3515). Django defaults both of these to False; stating them keeps
# the file from inheriting a position it never took.
#
# Why the scheme is trusted and the host is not:
#
#   * X-Forwarded-Proto carries information the app cannot obtain any other way —
#     the container always speaks plain HTTP on :8000, so without the header
#     every request looks insecure. Its failure mode here is contained: the
#     Secure flags on the session, CSRF and refresh cookies are hardcoded True
#     above and in base.py rather than derived from is_secure(), so a spoofed
#     value does not downgrade a cookie.
#
#   * X-Forwarded-Host carries nothing new. Every proxy this project ships
#     preserves the original Host (`proxy_set_header Host $host` in
#     nginx/app.conf.template, app-http.conf.template, demo.conf.template,
#     packages/web/nginx.conf and the chart's web ConfigMap), and none of them
#     sets or strips X-Forwarded-Host. Turning this on would therefore trust a
#     header whose only author in every supported topology is the client: Host is
#     the edge's routing key, so a value that does not route never arrives, while
#     X-Forwarded-Host routes fine and would be believed anyway. That is a strict
#     widening of who can steer request.build_absolute_uri(), and it buys nothing.
#
# The premise True would need — "the proxy is the sole ingress path" — is also not
# something the chart enforces: templates/networkpolicy.yaml restricts the bundled
# datastore pods only, and the admin docs hand API-pod ingress restriction to the
# operator. Do not flip this without also closing that gap and stripping the
# header at every edge.
#
# An operator whose proxy genuinely rewrites Host does not need this switch:
# TRUEPPM_PUBLIC_API_BASE_URL pins the origin for both request-derived absolute
# URLs (the OIDC redirect_uri and the inbound Git-webhook URL), which is a value
# they control rather than a belief about a header they cannot verify.
USE_X_FORWARDED_HOST = False
USE_X_FORWARDED_PORT = False
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
SECURE_REDIRECT_EXEMPT = [r"^api/v1/health/$", r"^api/v1/readyz$", r"^api/v1/edition/$"]

# Refuse to boot when task attachments would land on ephemeral local disk in a
# containerized deploy (#775) — same import-time enforcement as the SECRET_KEY
# guard, since gunicorn/asgi workers never run `manage.py check`. Passing
# MEDIA_ROOT extends the guard to the opted-in case (#3184): before this the
# opt-in was an unverified claim, and the deployment it described — no MEDIA_ROOT
# at all, on a read-only root filesystem — booted clean and then EROFS'd on the
# first upload.
_storage_errors = validate_attachment_storage(
    STORAGES["default"]["BACKEND"],
    debug=DEBUG,
    allow_local=ALLOW_LOCAL_ATTACHMENT_STORAGE,
    media_root=MEDIA_ROOT,
)
if _storage_errors:
    raise RuntimeError(_REFUSING_TO_START + "; ".join(str(e.msg) for e in _storage_errors))

# Refuse to boot without a valid integration encryption key (#1002). The key
# encrypts integration PATs at rest; without this guard a missing/malformed key
# only surfaces as a 500 on the first PAT connect, long after deploy. Same
# import-time enforcement as the SECRET_KEY and storage guards above.
_integration_key_errors = validate_integration_encryption_key(
    INTEGRATION_ENCRYPTION_KEY, debug=DEBUG
)
if _integration_key_errors:
    raise RuntimeError(_REFUSING_TO_START + "; ".join(str(e.msg) for e in _integration_key_errors))

# Refuse to boot when the soft-delete retention window is 0 (#3186). 0 sets the
# purge cutoff to the present moment, so the next tick HARD-deletes every
# trashed project and all of its children via CASCADE — irreversibly, with no
# tombstone. The API has always refused this value
# (RetentionPolicyWriteSerializer.value is min_value=1); the env var had no
# floor, and the chart's own comment told operators to set exactly this "to keep
# the default". Same import-time posture as the guards above, since asgi workers
# never run `manage.py check`.
_retention_errors = validate_project_soft_delete_retention(
    TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS
)
if _retention_errors:
    raise RuntimeError(_REFUSING_TO_START + "; ".join(str(e.msg) for e in _retention_errors))

# Refuse to boot when DATABASE_URL has no sslmode parameter in a non-DEBUG
# deployment (#1550). Without sslmode=require the connection falls back to
# whatever the server negotiates, which may be plaintext — the same fail-closed
# posture as the SECRET_KEY (#566), attachment-storage (#775), and integration-
# key (#1002) guards above, since gunicorn/asgi workers never run
# `manage.py check`. Operators terminating TLS at the proxy/sidecar layer (where
# the app-to-DB link is already encrypted) opt in via
# TRUEPPM_ALLOW_UNENCRYPTED_DB=true and keep the warning instead.
_db_url_raw: str = env("DATABASE_URL", default="")
if _db_url_raw:
    _db_url_qs = urllib.parse.parse_qs(urllib.parse.urlparse(_db_url_raw).query)
    if "sslmode" not in _db_url_qs:
        if ALLOW_UNENCRYPTED_DB:
            logging.getLogger("trueppm.settings").warning(
                "DATABASE_URL does not include sslmode=require. "
                "Database connections may use unencrypted transport. "
                "Proceeding because TRUEPPM_ALLOW_UNENCRYPTED_DB=true is set; "
                "ensure TLS is enforced at the network layer."
            )
        else:
            raise RuntimeError(
                "Refusing to start: DATABASE_URL does not include sslmode=require "
                "in a non-DEBUG environment; database connections may use "
                "unencrypted transport. Set sslmode=require in DATABASE_URL, or set "
                "TRUEPPM_ALLOW_UNENCRYPTED_DB=true if TLS is enforced at the network "
                "layer."
            )

# Refuse to boot on a placeholder datastore credential (#3176). Compose's
# ``${DB_PASSWORD:?...}`` only asserts the variable is non-empty, and .env.example
# shipped ``change-me`` — so the documented copy-paste path produced a deploy in which
# SECRET_KEY, the attachment backend, the integration key and sslmode were all validated
# and the database/cache passwords were not. Same import-time enforcement as the guards
# above, for the same reason: gunicorn/asgi workers never run ``manage.py check``.
_service_cred_errors = validate_service_credentials(
    DATABASES["default"].get("PASSWORD"),
    urllib.parse.urlparse(REDIS_URL or "").password,
    debug=DEBUG,
)
if _service_cred_errors:
    raise RuntimeError(_REFUSING_TO_START + "; ".join(str(e.msg) for e in _service_cred_errors))
