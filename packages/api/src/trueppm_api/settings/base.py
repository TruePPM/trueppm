"""Base Django settings shared across all environments."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env()

# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

SECRET_KEY = env("SECRET_KEY", default="django-insecure-change-me-in-prod")

DEBUG = False

ALLOWED_HOSTS: list[str] = []

# ---------------------------------------------------------------------------
# Applications
# ---------------------------------------------------------------------------

DJANGO_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.postgres",
]

THIRD_PARTY_APPS = [
    "rest_framework",
    "rest_framework_simplejwt",
    # Refresh-token revocation (#910): provides OutstandingToken + BlacklistedToken
    # so refresh-token rotation (BLACKLIST_AFTER_ROTATION) and logout actually
    # revoke the old token instead of letting it live out its full TTL. The
    # auth_views blacklist() calls are no-ops without this app installed.
    "rest_framework_simplejwt.token_blacklist",
    "allauth",
    "allauth.account",
    "channels",
    "drf_spectacular",
    "simple_history",
]

LOCAL_APPS = [
    "trueppm_api.apps.access",
    "trueppm_api.apps.projects",
    "trueppm_api.apps.resources",
    "trueppm_api.apps.scheduling",
    "trueppm_api.apps.sync",
    "trueppm_api.apps.history",
    "trueppm_api.apps.msproject",
    "trueppm_api.apps.webhooks",
    "trueppm_api.apps.taskruns",
    "trueppm_api.apps.workshops",
    "trueppm_api.apps.notifications",
    "trueppm_api.apps.integrations",
    "trueppm_api.apps.observability",
    "trueppm_api.apps.workflow_engine",
    "trueppm_api.apps.idempotency",
    "trueppm_api.apps.workspace",
    "trueppm_api.apps.teams",
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # CSP header on every response (#897). Placed high so the header is attached
    # even for early short-circuit responses (redirects, errors).
    "trueppm_api.core.csp.ContentSecurityPolicyMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    "simple_history.middleware.HistoryRequestMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "trueppm_api.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "trueppm_api.wsgi.application"
ASGI_APPLICATION = "trueppm_api.asgi.application"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

DATABASES = {
    "default": env.db("DATABASE_URL", default="postgres://trueppm:trueppm@db:5432/trueppm")
}
DATABASES["default"]["CONN_MAX_AGE"] = 60
# Wrap every request in a transaction so transaction.on_commit() defers
# callbacks to after commit rather than firing immediately in autocommit mode.
DATABASES["default"]["ATOMIC_REQUESTS"] = True

# ---------------------------------------------------------------------------
# File / object storage (#775)
# ---------------------------------------------------------------------------

# Default file-storage backend. TaskAttachment.file is stored here. The
# FileSystemStorage default is fine for local dev, but a containerized prod
# deploy must point this at a remote object-storage backend (S3/MinIO via
# django-storages) or attachment uploads are lost on every pod restart. prod.py
# refuses to boot on the local default unless the operator explicitly opts in.
STORAGES = {
    "default": {
        "BACKEND": env(
            "TRUEPPM_DEFAULT_FILE_STORAGE",
            default="django.core.files.storage.FileSystemStorage",
        ),
    },
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
    },
}

# Operator opt-in to run prod on local-disk attachment storage (e.g. when it is
# backed by a persistent volume). Consumed by validate_attachment_storage.
ALLOW_LOCAL_ATTACHMENT_STORAGE = env.bool("TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE", default=False)

# Origins trusted for cross-origin POST / CSRF — required when the web app is
# served from a different origin than the API (split dev setup or subdomain
# split). Empty by default (same-origin reverse-proxy deploy).
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# ---------------------------------------------------------------------------
# Cache / Channels / Celery  (all backed by Redis)
# ---------------------------------------------------------------------------

REDIS_URL = env("REDIS_URL", default="redis://redis:6379")

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [f"{REDIS_URL}/1"],
            "capacity": 1500,
            "expiry": 10,
        },
    },
}

CELERY_BROKER_URL = f"{REDIS_URL}/0"
CELERY_RESULT_BACKEND = f"{REDIS_URL}/0"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = "UTC"
from celery.schedules import crontab  # noqa: E402 — must follow REDIS_URL

CELERY_BEAT_SCHEDULE = {
    # Retention purge coordinator (ADR-0090): one self-gating task that purges the
    # five operational tables (event history, task runs, webhook deliveries, import
    # requests, sync batches) as a single unified run, recorded in PurgeRun. Fires
    # every 30 min and no-ops outside the operator-configured window (Settings →
    # System health → Retention & purge). Replaces the five former per-table nightly
    # purge entries (history/task-runs/webhook/import/sync) — the per-table tasks
    # remain dispatchable but are no longer independently scheduled.
    "retention-purge-coordinator": {
        "task": "retention.run_purge",
        "schedule": crontab(minute="*/30"),
    },
    # Outbox drain: dispatches pending ScheduleRequest rows every 30 seconds.
    # Also recovers orphaned dispatched rows (worker died before completing).
    "drain-schedule-queue": {
        "task": "scheduling.drain_schedule_queue",
        "schedule": 30.0,
    },
    # Nightly cleanup: deletes done/dead ScheduleRequest rows older than 7 days.
    "schedule-requests-purge-nightly": {
        "task": "scheduling.purge_old_schedule_requests",
        # 02:15 UTC — between the two existing purge jobs.
        "schedule": crontab(hour=2, minute=15),
    },
    # Nightly cleanup: trims project Monte Carlo run history to the newest
    # MC_HISTORY_CAP rows per project (ADR-0109, #961). No-ops when the cap is
    # None (Enterprise unlimited).
    "purge-monte-carlo-runs-nightly": {
        "task": "scheduling.purge_old_monte_carlo_runs",
        # 02:20 UTC — right after the schedule-requests purge.
        "schedule": crontab(hour=2, minute=20),
    },
    # Webhook delivery drain: re-enqueues stranded PENDING deliveries whose
    # initial .delay() call was lost (e.g. broker down at creation time).
    "drain-webhook-queue": {
        "task": "webhooks.drain_webhook_queue",
        "schedule": 30.0,
    },
    # MS Project import drain: dispatches pending ImportRequest rows every 30 s.
    # Also recovers orphaned dispatched rows (worker died mid-import).
    "drain-import-queue": {
        "task": "msproject.drain_import_queue",
        "schedule": 30.0,
    },
    # Sprint close drain: dispatches pending SprintCloseRequest rows every 30 s.
    # Also recovers IN_FLIGHT rows orphaned past the 5-minute window.
    "drain-sprint-close-requests": {
        "task": "projects.drain_sprint_close_requests",
        "schedule": 30.0,
    },
    # Daily burndown snapshot: writes yesterday's row for every ACTIVE sprint
    # — covers days with no task status changes (signal handler covers today).
    "update-sprint-burndown-snapshots": {
        "task": "projects.update_sprint_burndown_snapshots",
        "schedule": crontab(hour=1, minute=0),
    },
    # Nightly cleanup: deletes COMPLETED/FAILED SprintCloseRequest rows >7 days.
    "purge-sprint-close-requests": {
        "task": "projects.purge_sprint_close_requests",
        # 03:00 UTC — after other nightly purge jobs.
        "schedule": crontab(hour=3, minute=0),
    },
    # Notification email outbox drain: send queued mention emails every 30 s.
    # Respects 5-min orphan window so it doesn't race in-flight comment-create
    # transactions (ADR-0075 §F durable-execution checklist item 3).
    "drain-notification-emails": {
        "task": "notifications.drain_notification_emails",
        "schedule": 30.0,
    },
    # Nightly archive: notifications older than 90 days with is_read=True become
    # is_archived=True. Keeps the unread-bell query path on a shallow index.
    "archive-old-notifications": {
        "task": "notifications.archive_old_notifications",
        # 03:15 UTC — after other nightly purge/archive jobs.
        "schedule": crontab(hour=3, minute=15),
    },
    # Beat liveness heartbeat: a single worker writes BeatHeartbeat.last_heartbeat
    # every 30 s. GET /api/v1/health/beat/ reads it to detect a dead Beat (ADR-0081).
    "beat-heartbeat": {
        "task": "beat.heartbeat",
        "schedule": 30.0,
    },
    # Secondary in-cluster stale-heartbeat detector: logs WARNING when the heartbeat
    # is older than TRUEPPM_BEAT_STALE_SECONDS. The /health/beat/ endpoint is the
    # primary (external) detector; this serves adopters with no external monitoring.
    "beat-check-stale-heartbeat": {
        "task": "beat.check_stale_heartbeat",
        "schedule": 60.0,
    },
    # Workflow step-outbox drain: re-dispatch stranded WorkflowOutboxRow rows
    # every 30 s and recover rows orphaned by a dead worker (ADR-0080 §D).
    "drain-workflow-outbox": {
        "task": "workflows.outbox_drain",
        "schedule": 30.0,
    },
    # Workflow sleep-timer drain: fire due WorkflowTimer rows and wake their
    # sleeping workflows. 60 s cadence — sleep durations are minute-grained.
    "drain-workflow-timers": {
        "task": "workflows.timer_drain",
        "schedule": 60.0,
    },
    # Nightly cleanup: terminal workflow outbox rows >7 days and history past
    # the configurable retention window.
    "purge-workflow-records": {
        "task": "workflows.purge_old_records",
        # 04:00 UTC — after the other nightly purge jobs.
        "schedule": crontab(hour=4, minute=0),
    },
    # Hourly cleanup: deletes stored Idempotency-Key rows older than
    # IDEMPOTENCY_RETENTION_HOURS. Hourly (not nightly) so the 24h contract holds —
    # a nightly job would let rows live up to ~48h (ADR-0083).
    "idempotency-keys-purge-hourly": {
        "task": "idempotency.purge_old_keys",
        "schedule": crontab(minute=5),
    },
    # Workspace invite email outbox drain: send queued invite emails every 30 s.
    # Respects the 5-min orphan window so it doesn't race invite-create txns
    # (ADR-0087 §Durable Execution item 3).
    "drain-invite-emails": {
        "task": "workspace.drain_invite_emails",
        "schedule": 30.0,
    },
    # Nightly cleanup: expire overdue pending invites and delete terminal invites
    # older than INVITE_RETENTION_DAYS (ADR-0087 §Durable Execution item 6).
    "purge-stale-invites": {
        "task": "workspace.purge_stale_invites",
        # 04:15 UTC — after the other nightly purge jobs.
        "schedule": crontab(hour=4, minute=15),
    },
    # Re-dispatch workspace export jobs orphaned by a broker outage at on_commit
    # (ADR-0092 §Durable Execution item 2; 5-min orphan window inside the task).
    "drain-workspace-exports": {
        "task": "workspace.drain_workspace_exports",
        "schedule": 30.0,
    },
    # Nightly: delete export jobs past their download-link expiry and their files
    # (ADR-0092 §Durable Execution item 6).
    "purge-expired-exports": {
        "task": "workspace.purge_expired_exports",
        # 04:20 UTC — after purge-stale-invites.
        "schedule": crontab(hour=4, minute=20),
    },
    # Lazily materialize upcoming recurring-task occurrences within the
    # TRUEPPM_RECURRENCE_HORIZON_DAYS look-ahead. Hourly: occurrences are date-grained,
    # and a missed tick self-heals on the next one (idempotent). See ADR-0090 / #736.
    "generate-recurring-occurrences": {
        "task": "projects.generate_recurring_occurrences",
        "schedule": crontab(minute=0),
    },
    # Nightly: flush expired OutstandingToken/BlacklistedToken rows so the JWT
    # blacklist tables stay bounded to roughly the active-session window (#910).
    # No-ops when the token_blacklist app is not installed.
    "flush-expired-blacklisted-tokens": {
        "task": "access.flush_expired_blacklisted_tokens",
        # 04:30 UTC — after the other nightly purge jobs.
        "schedule": crontab(hour=4, minute=30),
    },
}

# ---------------------------------------------------------------------------
# Auth / Passwords
# ---------------------------------------------------------------------------

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# ---------------------------------------------------------------------------
# SimpleJWT token lifetimes + httpOnly refresh-cookie migration (#897)
# ---------------------------------------------------------------------------

# Short access-token TTL bounds the blast radius of a leaked in-memory access
# token; the SPA transparently refreshes via the httpOnly cookie on 401. A
# 7-day refresh TTL is the session length — long enough to avoid daily re-login,
# short enough that a stolen refresh token (cookie) self-expires within a week.
# Rotation + (optional) blacklist further limit replay of a leaked refresh token.
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    # Blacklisting requires the token_blacklist app + its migrations, now shipped
    # in INSTALLED_APPS by default (#910), so rotation actually revokes the prior
    # refresh token. The refresh/logout views still tolerate the app's absence so
    # an operator who removes it (lean OSS deploy) degrades gracefully to
    # TTL-only expiry rather than erroring.
    "BLACKLIST_AFTER_ROTATION": True,
}

# httpOnly refresh-cookie attributes (#897). The refresh token rides in this
# cookie instead of the JSON body so JavaScript (and therefore XSS) cannot read
# it. Attributes are env-overridable so a non-HTTPS local dev server can still
# complete the flow.
#
# SameSite=Strict is safe here: the refresh request is a same-origin XHR from the
# SPA, which Strict permits, while it blocks the cookie on any cross-site request
# — the CSRF mitigation for this path (see core/auth_views.py).
AUTH_REFRESH_COOKIE_NAME = env("AUTH_REFRESH_COOKIE_NAME", default="trueppm_refresh")
AUTH_REFRESH_COOKIE_PATH = env("AUTH_REFRESH_COOKIE_PATH", default="/api/v1/auth/token/refresh/")
AUTH_REFRESH_COOKIE_SAMESITE = env("AUTH_REFRESH_COOKIE_SAMESITE", default="Strict")
# Default Secure=True; dev settings flip this to False for plain-HTTP localhost.
AUTH_REFRESH_COOKIE_SECURE = env.bool("AUTH_REFRESH_COOKIE_SECURE", default=True)

# ---------------------------------------------------------------------------
# Content-Security-Policy (#897)
# ---------------------------------------------------------------------------

# Strict CSP, assembled into a header by core.csp.ContentSecurityPolicyMiddleware.
# script-src 'self' (no inline / no hash) is possible because the theme-init
# script was moved to an external file (web/public/theme-init.js). connect-src
# carries wss: for the WebSocket collaboration channel; the host is overridable
# per deploy. style-src keeps 'unsafe-inline' because the SPA emits inline style
# attributes (Tailwind/JS-driven) — tightening this is tracked separately.
CSP_CONNECT_SRC = env.list("CSP_CONNECT_SRC", default=["'self'", "wss:"])
CSP_DIRECTIVES: dict[str, list[str]] = {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
    "font-src": ["fonts.gstatic.com"],
    "img-src": ["'self'", "data:"],
    "connect-src": CSP_CONNECT_SRC,
    "frame-ancestors": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
}

# ---------------------------------------------------------------------------
# Internationalization
# ---------------------------------------------------------------------------

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------

STATIC_URL = "static/"
# Allow an explicit env override so the app can write static files to a
# writable path when installed as a pip package (where BASE_DIR resolves
# inside the read-only venv).
STATIC_ROOT = Path(env("STATIC_ROOT", default=str(BASE_DIR / "staticfiles")))

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------------------
# Edition detection
# Set TRUEPPM_EDITION=enterprise in the enterprise Helm chart to activate
# enterprise landing logic in the frontend. The /api/v1/edition/ endpoint
# reads this setting and returns it to unauthenticated clients so the React
# shell can make the post-login redirect decision without importing enterprise
# code (ADR-0029).
# ---------------------------------------------------------------------------

TRUEPPM_EDITION: str = env("TRUEPPM_EDITION", default="community")

# ---------------------------------------------------------------------------
# Integration credential encryption key (ADR-0049 §3)
#
# Fernet key used to encrypt the PAT secrets stored in
# trueppm_api.apps.integrations.IntegrationCredential.secret_ciphertext.
# Production deployments source this from a Kubernetes Secret via the Helm
# chart; the empty default fails loud (ImproperlyConfigured) the first time
# the helper is called, which is what we want — better than silently storing
# unencrypted PATs in dev because someone forgot to set the env var.
#
# Generate one with:
#   python -c "from cryptography.fernet import Fernet; \
#              print(Fernet.generate_key().decode())"
# ---------------------------------------------------------------------------

INTEGRATION_ENCRYPTION_KEY: str = env(
    "INTEGRATION_ENCRYPTION_KEY",
    default="",
)

# ---------------------------------------------------------------------------
# Monte Carlo simulation caps (OSS tier)
# Set to None for unlimited (Enterprise overrides these in enterprise settings).
# ---------------------------------------------------------------------------

MC_SIMULATION_CAP: int | None = 1_000
# Raised 500 -> 5000 (#823): the OSS scaling story is "10k tasks", but the MC
# endpoint returned HTTP 402 for any project over 500 tasks, so Monte Carlo was
# silently unavailable for realistic large projects. The vectorised numpy path
# (scheduler/engine.py) is O(runs x tasks x edges) and handles a 5000-task x
# 1000-run simulation in a few seconds. Operators on constrained hardware can
# lower this; Enterprise overrides it in enterprise settings.
MC_TASK_CAP: int | None = 5_000

# Project Monte Carlo run-history retention (ADR-0109, #961): the nightly purge
# keeps the newest MC_HISTORY_CAP MonteCarloRun rows per project so a PM can read
# finish-date forecast drift over time. None = unlimited (Enterprise overrides it
# — unbounded history + cross-program rollup is the portfolio upsell).
MC_HISTORY_CAP: int | None = 100

# ---------------------------------------------------------------------------
# Upload caps (ADR-0075, task attachments)
# ---------------------------------------------------------------------------

# Hard 100 MB ceiling matches the TaskAttachment cap (ADR-0075 locked
# constraint #4). The serializer also enforces this, but the setting must
# fire FIRST — without it, Django buffers the entire body to /tmp before
# the serializer runs, which lets an authenticated Member spam 100 MB+
# multipart bodies and exhaust worker time + disk. Operators should also
# set nginx `client_max_body_size: 100m` so over-sized requests are
# rejected at the edge, not after Django finishes parsing them.
DATA_UPLOAD_MAX_MEMORY_SIZE = 100 * 1024 * 1024  # 100 MB
FILE_UPLOAD_MAX_MEMORY_SIZE = 2_621_440  # 2.5 MB (Django default; explicit)

# Per-file cap for MS Project (.mpp/.xml) imports. Lower than the 100 MB
# attachment ceiling on purpose: unlike attachments (FileField → disk), an
# import is read fully into memory and stored base64-encoded in a single
# ImportRequest DB row (~+33%), so a 50 MB upload already costs ~67 MB of
# memory and row size. 50 MB is the practical MS Project file ceiling
# (larger schedules degrade in Project itself). The global
# DATA_UPLOAD_MAX_MEMORY_SIZE and nginx client_max_body_size (both 100 MB)
# remain the hard edge cap — do not configure this above them.
MSPROJECT_MAX_UPLOAD_MB: int = env.int("MSPROJECT_MAX_UPLOAD_MB", default=50)

# Max size of an uploaded JSON program seed (ADR-0109, #615). Seeds are bounded
# (the largest bundled sample is a few hundred KB); 5 MB is generous headroom
# while bounding the memory a single authenticated import request can consume.
SEED_MAX_UPLOAD_MB: int = env.int("SEED_MAX_UPLOAD_MB", default=5)

# ---------------------------------------------------------------------------
# Django REST Framework
# ---------------------------------------------------------------------------

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_FILTER_BACKENDS": [
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    # Scoped throttles only. The "login" scope is consumed by the JWT
    # TokenObtainPairView (#770) to bound password-guessing on the auth
    # endpoint. Deliberately NOT a global DEFAULT_THROTTLE_CLASSES /
    # AnonRateThrottle — that would also throttle the unauthenticated
    # /health/ and /edition/ probe endpoints that Kubernetes hits on a
    # tight liveness/readiness loop.
    "DEFAULT_THROTTLE_RATES": {
        "login": "10/min",
        # JWT refresh (#814). 60/min is loose enough that any realistic
        # web/mobile client (5-minute access-token TTL → ~12 refreshes/hour)
        # never trips it, but tight enough that a stolen/leaked refresh token
        # cannot be exchanged for access tokens at unbounded rate.
        "refresh": "60/min",
        # User typeahead for member invite (#815). Tight enough that a single
        # account cannot bulk-scrape the workspace user list, loose enough that
        # interactive typeahead (debounced, >=2 chars) never trips it.
        "user_search": "60/min",
    },
}

# ---------------------------------------------------------------------------
# django-allauth
# ---------------------------------------------------------------------------

SITE_ID = 1
ACCOUNT_EMAIL_VERIFICATION = "none"

# ---------------------------------------------------------------------------
# drf-spectacular (OpenAPI)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Object change history (django-simple-history)
# ---------------------------------------------------------------------------

# Retention window in days. Records older than this are purged nightly by the
# Celery beat task in trueppm_api.apps.history.tasks.
# Set to None to disable automatic purging (enterprise unlimited retention).
HISTORY_RETENTION_DAYS: int | None = env.int("HISTORY_RETENTION_DAYS", default=90)

# ---------------------------------------------------------------------------
# Task run retention (trueppm_api.apps.taskruns)
# ---------------------------------------------------------------------------

# Retention window in days for completed/failed/cancelled TaskRun records.
# Set to None to disable automatic purging.
TASK_RUN_RETENTION_DAYS: int | None = env.int("TASK_RUN_RETENTION_DAYS", default=30)

# ---------------------------------------------------------------------------
# Outbox retention + Beat liveness (ADR-0081)
# ---------------------------------------------------------------------------

# Retention window in days for terminal (SUCCESS/FAILED) WebhookDelivery rows.
# Set to None to disable the nightly purge. New tunables are TRUEPPM_-prefixed
# for env-var namespacing in shared ConfigMaps/Secrets (ADR-0081 §D).
TRUEPPM_WEBHOOK_RETENTION_DAYS: int | None = env.int("TRUEPPM_WEBHOOK_RETENTION_DAYS", default=7)

# Retention window in days for terminal (DONE/DEAD) ImportRequest rows. These
# carry multi-MB file_content_b64 blobs. Set to None to disable the nightly purge.
TRUEPPM_IMPORT_RETENTION_DAYS: int | None = env.int("TRUEPPM_IMPORT_RETENTION_DAYS", default=7)

# Download-link validity (days) for a completed WorkspaceExportJob; past this the
# nightly purge deletes the job row and its stored archive (ADR-0092). The full
# archive can be large and contains every project's data, so it is not kept
# indefinitely. Set to None to disable expiry/purge (links never lapse).
TRUEPPM_EXPORT_RETENTION_DAYS: int | None = env.int("TRUEPPM_EXPORT_RETENTION_DAYS", default=7)

# Age in seconds past which the Beat heartbeat is considered stale. Drives both
# the GET /api/v1/health/beat/ stale flag and the beat.check_stale_heartbeat
# WARNING log. Default 120 s = four missed 30 s beats.
TRUEPPM_BEAT_STALE_SECONDS: int = env.int("TRUEPPM_BEAT_STALE_SECONDS", default=120)

# Freshness/dedup window in hours for mobile sync upload batches (ADR-0082). A
# duplicate upload with the same client_batch_id within this window replays the
# stored response; past it, the id is allowed to re-run and the nightly
# sync.purge_sync_batches task reaps the stale row.
TRUEPPM_SYNC_BATCH_RETENTION_HOURS: int = env.int("TRUEPPM_SYNC_BATCH_RETENTION_HOURS", default=24)

# How long a manual retention purge may be considered "in progress" before the
# run endpoint stops treating a RUNNING PurgeRow as blocking (ADR-0090 §G). Bounds
# the API-level single-flight guard to the coordinator's Redis lock window so a
# worker that died mid-run can't block all future manual runs with a stale row.
RETENTION_PURGE_INFLIGHT_SECONDS: int = env.int("RETENTION_PURGE_INFLIGHT_SECONDS", default=600)

# Maximum rows (created + updated + deleted) in a single mobile sync upload
# batch (ADR-0082). The batch applies in one transaction; this bounds how long
# that transaction (and its per-task row locks) can be held by one request.
TRUEPPM_SYNC_BATCH_MAX_ROWS: int = env.int("TRUEPPM_SYNC_BATCH_MAX_ROWS", default=500)

# Look-ahead horizon (days) for lazy recurring-task occurrence generation (ADR-0090).
# The hourly projects.generate_recurring_occurrences sweep materializes only
# occurrences due within this window — a bounded look-ahead, never the full series.
TRUEPPM_RECURRENCE_HORIZON_DAYS: int = env.int("TRUEPPM_RECURRENCE_HORIZON_DAYS", default=14)

# ---------------------------------------------------------------------------
# Workflow execution engine (ADR-0080)
# ---------------------------------------------------------------------------

# Dotted path to the WorkflowBackend implementation. The OSS default composes
# the transactional outbox + Celery; enterprise editions register an alternate
# (e.g. Temporal) by overriding this — the edition-routing pattern of ADR-0030.
WORKFLOW_BACKEND = env.str(
    "WORKFLOW_BACKEND",
    default="trueppm_api.workflows.backends.default.DefaultWorkflowBackend",
)

# Retention window in days for WorkflowHistoryEvent rows (purged nightly by
# workflows.purge_old_records). Set to None / 0 to disable history purging.
WORKFLOW_HISTORY_RETENTION_DAYS: int | None = env.int("WORKFLOW_HISTORY_RETENTION_DAYS", default=30)

# Max rows the workflow outbox/timer drains process per tick. Bounds the work
# per run so a large backlog (e.g. after a broker outage) can't exceed the task
# time_limit — subsequent ticks drain the remainder.
WORKFLOW_DRAIN_BATCH_SIZE = env.int("WORKFLOW_DRAIN_BATCH_SIZE", default=200)

# Rows deleted per statement by the nightly workflow retention purge. The purge
# deletes in bounded chunks rather than one unbounded statement so the first run
# on a mature install (e.g. after WORKFLOW_HISTORY_RETENTION_DAYS is first set)
# cannot take a long lock over a large slice of the history/outbox tables.
WORKFLOW_PURGE_BATCH_SIZE = env.int("WORKFLOW_PURGE_BATCH_SIZE", default=500)

# ---------------------------------------------------------------------------
# Idempotency-Key retention (trueppm_api.apps.idempotency, ADR-0083)
# ---------------------------------------------------------------------------

# Retention window in hours for stored Idempotency-Key responses. Purged hourly by
# the Celery beat task in trueppm_api.apps.idempotency.tasks. After expiry, a retry
# with the same key re-runs the mutation. Set to None to disable automatic purging.
IDEMPOTENCY_RETENTION_HOURS: int | None = env.int("IDEMPOTENCY_RETENTION_HOURS", default=24)
# Maximum stored response body size (bytes). Responses larger than this are not stored
# (the claim row is dropped, so a retry re-runs). Mutation responses are single objects
# and effectively never approach this.
IDEMPOTENCY_MAX_BODY_BYTES: int = env.int("IDEMPOTENCY_MAX_BODY_BYTES", default=1 * 1024 * 1024)

# ---------------------------------------------------------------------------
# drf-spectacular (OpenAPI)
# ---------------------------------------------------------------------------

SPECTACULAR_SETTINGS = {
    "TITLE": "TruePPM API",
    "DESCRIPTION": "REST API for the TruePPM project scheduling platform.",
    "VERSION": "0.3.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    # Pin state-enum names (ADR-0090). PurgeRun.state shares the field name "state"
    # with the sprint lifecycle enum; introducing a second "state" choice set makes
    # drf-spectacular disambiguate *both* by model prefix, renaming the sprint enum
    # away from the stable `StateEnum` component (a schema regression). Pinning the
    # sprint enum to `StateEnum` and ours to `PurgeRunStateEnum` keeps both stable.
    # Likewise for "frequency": TaskRecurrenceRule.frequency (#736) introduces a
    # second choice set sharing the field name with RetentionSchedule.frequency,
    # so drf-spectacular would disambiguate both by model prefix and rename the
    # stable `FrequencyEnum` component (a regression). Pin the retention enum back
    # to `FrequencyEnum` and the recurrence enum to `RecurrenceFrequencyEnum`.
    "ENUM_NAME_OVERRIDES": {
        "StateEnum": "trueppm_api.apps.projects.models.SprintState",
        "PurgeRunStateEnum": "trueppm_api.apps.observability.models.PurgeRun.State",
        "PurgeRunTriggerEnum": "trueppm_api.apps.observability.models.PurgeRun.Trigger",
        "FrequencyEnum": "trueppm_api.apps.observability.models.RetentionSchedule.Frequency",
        "RecurrenceFrequencyEnum": "trueppm_api.apps.projects.models.TaskRecurrenceFrequency",
        # ADR-0102: SprintScopeChange.status (pending|accepted|rejected) introduces
        # a new "status" choice set; without a pin drf-spectacular disambiguates
        # every "status" field by model prefix and renames existing stable
        # components (a schema-drift regression — project memory
        # project_drf_enum_name_collision). Pin ours to a stable name.
        "ScopeChangeStatusEnum": "trueppm_api.apps.projects.models.ScopeChangeStatus",
        # ADR-0116: Workspace.iteration_label_override_policy adds an
        # INHERIT/SUGGEST/ENFORCE choice set. Pin it so drf-spectacular does not
        # rename existing stable enums (the same schema-drift regression class as
        # ScopeChangeStatus above — project_drf_enum_name_collision).
        "TermOverridePolicyEnum": "trueppm_api.apps.workspace.models.TermOverridePolicy",
        # ADR-0105: Task gains task_type / readiness and Project gains
        # backlog_scoring_model. Each is a new choice set on a *_type / status-adjacent
        # field; pin to model-prefixed names so drf-spectacular does not rename the
        # existing stable enums (same regression class as ScopeChangeStatus above).
        "TaskTypeEnum": "trueppm_api.apps.projects.models.TaskType",
        "DorStateEnum": "trueppm_api.apps.projects.models.DorState",
        "PrioritizationModelEnum": "trueppm_api.apps.projects.models.PrioritizationModel",
        # ADR-0078 (#927): TeamMembership.role (member|admin) is a second "role"
        # choice set sharing the field name with the access Role ordinal. Without
        # a pin drf-spectacular disambiguates both by hash and renames the stable
        # `RoleEnum` component (same regression class as ScopeChangeStatus above —
        # project memory project_drf_enum_name_collision). Pin the access role back
        # to `RoleEnum` and the team role to `TeamRoleEnum`.
        "RoleEnum": "trueppm_api.apps.access.models.Role",
        "TeamRoleEnum": "trueppm_api.apps.teams.models.TeamRole",
        # ADR-0036 (#407): Task.governance_class / .delivery_mode add two new choice
        # sets. Pin to stable model-prefixed names so a later delivery_mode on another
        # model (e.g. Project, #410) cannot trigger a drf-spectacular rename of the
        # existing component (same regression class as ScopeChangeStatus — project
        # memory project_drf_enum_name_collision).
        "GovernanceClassEnum": "trueppm_api.apps.projects.models.GovernanceClass",
        "DeliveryModeEnum": "trueppm_api.apps.projects.models.DeliveryMode",
        # ADR-0106 §5 (#860): ForecastSnapshot.basis / .confidence introduce two
        # new choice sets on "basis" / "confidence" fields. Pin to model-prefixed
        # names so drf-spectacular does not rename existing stable components
        # (same regression class as ScopeChangeStatus — project memory
        # project_drf_enum_name_collision).
        "ForecastBasisEnum": "trueppm_api.apps.projects.models.ForecastBasis",
        "ForecastConfidenceEnum": "trueppm_api.apps.projects.models.ForecastConfidence",
        # ADR-0104 (#553): SignalAudience is a fresh ladder enum used in the
        # signal-privacy serializer; pin it to a stable name so a future "audience"
        # field cannot collide-and-rename it (project memory
        # project_drf_enum_name_collision).
        "SignalAudienceEnum": "trueppm_api.apps.projects.models.SignalAudience",
        # #983: Sprint.goal_outcome (MET|PARTIAL|MISSED) is a new choice set; pin
        # to a stable model-prefixed name so drf-spectacular does not rename
        # existing components (same regression class as ScopeChangeStatus —
        # project memory project_drf_enum_name_collision).
        "SprintGoalOutcomeEnum": "trueppm_api.apps.projects.models.SprintGoalOutcome",
        # #985: SprintTaskDisposition is exposed in the /outcome/ read serializer
        # (DidntShipItemSerializer.disposition). Pin to a stable name so
        # drf-spectacular does not hash-disambiguate it (project memory
        # project_drf_enum_name_collision).
        "SprintTaskDispositionEnum": "trueppm_api.apps.projects.models.SprintTaskDisposition",
    },
}
