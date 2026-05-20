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
    "history-purge-nightly": {
        "task": "history.purge_old_records",
        # 02:00 UTC every night — off-peak, avoids overlap with report generation.
        "schedule": crontab(hour=2, minute=0),
    },
    "task-runs-purge-nightly": {
        "task": "taskruns.purge_old_records",
        # 02:30 UTC — stagger from history purge.
        "schedule": crontab(hour=2, minute=30),
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
    # Nightly cleanup: deletes done/dead ImportRequest rows older than 7 days,
    # reclaiming storage for accumulated file_content_b64 blobs.
    "import-requests-purge-nightly": {
        "task": "msproject.purge_old_import_requests",
        # 02:45 UTC — after other nightly purge jobs.
        "schedule": crontab(hour=2, minute=45),
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
# drf-spectacular (OpenAPI)
# ---------------------------------------------------------------------------

SPECTACULAR_SETTINGS = {
    "TITLE": "TruePPM API",
    "DESCRIPTION": "REST API for the TruePPM project scheduling platform.",
    "VERSION": "0.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
}
