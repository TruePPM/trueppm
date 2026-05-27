"""Base Django settings shared across all environments."""

from __future__ import annotations

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
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
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
# Set to None for unlimited (Team tier overrides these in enterprise settings).
# ---------------------------------------------------------------------------

MC_SIMULATION_CAP: int | None = 1_000
MC_TASK_CAP: int | None = 500

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
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    # Pin state-enum names (ADR-0090). PurgeRun.state shares the field name "state"
    # with the sprint lifecycle enum; introducing a second "state" choice set makes
    # drf-spectacular disambiguate *both* by model prefix, renaming the sprint enum
    # away from the stable `StateEnum` component (a schema regression). Pinning the
    # sprint enum to `StateEnum` and ours to `PurgeRunStateEnum` keeps both stable.
    "ENUM_NAME_OVERRIDES": {
        "StateEnum": "trueppm_api.apps.projects.models.SprintState",
        "PurgeRunStateEnum": "trueppm_api.apps.observability.models.PurgeRun.State",
        "PurgeRunTriggerEnum": "trueppm_api.apps.observability.models.PurgeRun.Trigger",
    },
}
