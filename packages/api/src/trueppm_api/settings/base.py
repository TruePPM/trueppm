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

# Dedicated JWT signing key (#2247). Defaults to SECRET_KEY so a default install
# stays single-knob, but can be set independently via JWT_SIGNING_KEY to:
#   (a) limit the blast radius of a SECRET_KEY leak — a leaked SECRET_KEY alone
#       can no longer forge access/refresh tokens for any user; and
#   (b) give operators a deliberate "log everyone out now" lever: rotating
#       JWT_SIGNING_KEY invalidates every outstanding token without also
#       rotating the general Django secret (which would churn CSRF/session
#       signing too).
# When set explicitly it is strength-validated in prod exactly like SECRET_KEY
# (see core.security_checks.validate_signing_key); when it defaults to SECRET_KEY
# the SECRET_KEY validation already covers it. Rotation runbook:
# docs/administration/secret-rotation.md.
JWT_SIGNING_KEY = env("JWT_SIGNING_KEY", default=SECRET_KEY)

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
    # SITE_ID = 1 (below) is already set; allauth.socialaccount's SocialApp is an
    # M2M to Site, so the sites framework must be installed (ADR-0517 §1).
    "django.contrib.sites",
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
    # ADR-0517: adopt allauth.socialaccount as the provider *registry* only — our
    # own hardened views in apps/sso drive the flow (egress, alg allow-list, Fernet
    # secret, JWT bridge). We do NOT mount allauth.urls. openid_connect covers every
    # OIDC IdP (as named APPS keyed by our registry slug); github is the one non-OIDC
    # OAuth2 IdP that motivated the re-platform (#2108).
    "allauth.socialaccount",
    "allauth.socialaccount.providers.openid_connect",
    "allauth.socialaccount.providers.github",
    "channels",
    "drf_spectacular",
    # Serves the Swagger UI / ReDoc static bundles from Django static ('self')
    # so the /api/docs/ and /api/schema/swagger-ui/ pages render under the strict
    # CSP without a CDN. Must precede any app that would shadow its static files.
    "drf_spectacular_sidecar",
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
    "trueppm_api.apps.jiraimport",
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
    "trueppm_api.apps.profiles",
    "trueppm_api.apps.timetracking",
    "trueppm_api.apps.sso",
    "trueppm_api.apps.agents",
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # Serve collected static files from the ASGI app itself (#1603). We run under
    # `uvicorn ...asgi:application` in dev and prod — not `manage.py runserver` —
    # so Django's dev static handler never engages and there is no nginx/CDN in the
    # request path. Without this, every /static/ request 404s: Django admin CSS and
    # the Swagger UI / ReDoc bundles (served same-origin under our strict CSP) both
    # fail. WhiteNoise must sit immediately after SecurityMiddleware (its documented
    # position) so it can short-circuit static requests before the rest of the stack.
    "whitenoise.middleware.WhiteNoiseMiddleware",
    # Assign each request a correlation id and bind it to the logging contextvar
    # (#1899) so every log record emitted while handling the request carries it,
    # and echo it back on the response. Placed high — but after WhiteNoise, which
    # short-circuits static requests that need no id — so the id is set before any
    # downstream middleware or view can log.
    "trueppm_api.apps.observability.logging.RequestIDMiddleware",
    # CSP header on every response (#897). Placed high so the header is attached
    # even for early short-circuit responses (redirects, errors).
    "trueppm_api.core.csp.ContentSecurityPolicyMiddleware",
    # Reject NUL bytes in /api/ query strings before the view opens its
    # ATOMIC_REQUESTS transaction (#2229) — a NUL in a text DB filter otherwise
    # raises an uncaught psycopg DataError (500). Placed inside RequestID/CSP so
    # the 400 still carries the correlation id and CSP header, but before Session
    # so a garbage request skips session/auth work.
    "trueppm_api.core.middleware.RejectNullBytesMiddleware",
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

# Operator opt-in confirming the configured STORAGES['default']['BACKEND'] signs
# its .url() output with a real time-limited URL, for a backend not on
# security_checks.storage_backend_supports_signed_urls's allow-list (#573,
# MED-2). Default False: the TaskAttachmentViewSet.signed_url action refuses
# with 501 rather than hand out a stable indefinite-lifetime URL labeled as
# time-limited for any backend it can't positively identify as signing-capable.
ATTACHMENT_STORAGE_SIGNS_URLS = env.bool("TRUEPPM_ATTACHMENT_STORAGE_SIGNS_URLS", default=False)

# Operator opt-in to run prod against a DATABASE_URL without sslmode=require (e.g.
# when TLS to the database is enforced at the network layer). Consumed by the
# unencrypted-DB boot guard in settings/prod.py.
ALLOW_UNENCRYPTED_DB = env.bool("TRUEPPM_ALLOW_UNENCRYPTED_DB", default=False)

# Origins trusted for cross-origin POST / CSRF — required when the web app is
# served from a different origin than the API (split dev setup or subdomain
# split). Empty by default (same-origin reverse-proxy deploy).
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# Public origin the web app is served from, e.g. "https://app.example.com". Used
# to build absolute deep-links into emails/notifications (ADR-0165, #1158) — the
# API otherwise has no notion of where the frontend lives. Empty by default
# (zero-config): when unset, email bodies render without a link rather than emit a
# broken relative URL. Trailing slash is stripped at use; do not include a path.
# Env var standardized on the TRUEPPM_ prefix pre-0.3 (#1325, #1355); the legacy
# bare name remains a fallback so existing deploys keep working. ``or`` (not a
# nested default) so an *empty* TRUEPPM_ value — e.g. the chart's documented
# ``TRUEPPM_FRONTEND_BASE_URL: ""`` default — falls through to a legacy override
# rather than shadowing it. Empty means "no deep-links", so the fallthrough is
# also semantically correct.
FRONTEND_BASE_URL = env("TRUEPPM_FRONTEND_BASE_URL", default="") or env(
    "FRONTEND_BASE_URL", default=""
)

# Public origin of the API itself, used only to derive the OIDC ``redirect_uri``
# (ADR-0187): ``{TRUEPPM_PUBLIC_API_BASE_URL}/api/v1/auth/oidc/callback/``. The
# operator copies this exact value into their IdP's allowed-redirect list. Empty
# by default (zero-config): the SSO views fall back to the request's absolute URI,
# correct for a single-origin dev setup; set it explicitly behind a reverse proxy
# so the allow-listed value is deterministic. Trailing slash is stripped at use.
TRUEPPM_PUBLIC_API_BASE_URL = env("TRUEPPM_PUBLIC_API_BASE_URL", default="")

# ---------------------------------------------------------------------------
# Cache / Channels / Celery  (all backed by Redis)
# ---------------------------------------------------------------------------

REDIS_URL = env("REDIS_URL", default="redis://redis:6379")

# Shared cache backend (Valkey/Redis db 2 — db 1 is the channel layer, db 0 is
# Celery). Backs the short-lived, single-use OIDC login state / PKCE verifier /
# nonce (ADR-0187 §Durable Execution) and the DRF scoped throttles, both of which
# must be consistent across worker processes in a multi-worker deploy. ``dev.py``
# overrides this to LocMemCache so a local run / pytest needs no separate cache
# service (single process, so per-process memory is sufficient there).
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": f"{REDIS_URL}/2",
    },
}

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

# Legacy WebSocket ?token=<jwt> handshake (ADR-0141, #1723). The single-use
# ?ticket= scheme replaced it: a raw JWT in the URL leaks verbatim into
# reverse-proxy / ingress / Daphne access logs (the credential-in-URL class of
# #818). The fallback shipped deprecated-but-live for one release; it is now
# OFF by default and must be explicitly opted into by an operator who still has
# clients on the old path. It is removed entirely next release.
TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED: bool = env.bool(
    "TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED", default=False
)

CELERY_BROKER_URL = f"{REDIS_URL}/0"
CELERY_RESULT_BACKEND = f"{REDIS_URL}/0"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = "UTC"
from celery.schedules import crontab  # noqa: E402 — must follow REDIS_URL

CELERY_BEAT_SCHEDULE = {
    # Retention purge coordinator (ADR-0173): one self-gating task that purges the
    # six operational tables (event history, task runs, webhook deliveries, import
    # requests, sync batches, soft-deleted projects) as a single unified run,
    # recorded in PurgeRun. Fires every 30 min and no-ops outside the
    # operator-configured window (Settings → System health → Retention & purge).
    # Replaces the former per-table nightly purge entries — the per-table tasks
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
    # Nightly cleanup: deletes acknowledged / auto-resolved CrossProjectSlipConflict
    # rows 90 days past their resolution (ADR-0120 D4). Unresolved + unacknowledged
    # conflicts are kept indefinitely — they are still live.
    "purge-resolved-slip-conflicts-nightly": {
        "task": "scheduling.purge_resolved_slip_conflicts",
        # 02:25 UTC — after the Monte Carlo purge.
        "schedule": crontab(hour=2, minute=25),
    },
    # Nightly cleanup: reaps WebSocket replay-buffer rows (BoardEvent) older than
    # TRUEPPM_BOARD_EVENT_RETENTION_HOURS so the buffer stays bounded (ADR-0236,
    # #321). Standalone rather than in the ADR-0173 operator coordinator: the
    # buffer is internal transport plumbing, deliberately not surfaced as an
    # operator-tunable retention row.
    "purge-board-events-nightly": {
        "task": "sync.purge_board_events",
        # 02:35 UTC — after the slip-conflict purge.
        "schedule": crontab(hour=2, minute=35),
    },
    # Nightly cleanup: trims project Monte Carlo run history to the newest
    # MC_HISTORY_CAP rows per project (ADR-0175, #961). No-ops when the cap is
    # None (Enterprise unlimited).
    "purge-monte-carlo-runs-nightly": {
        "task": "scheduling.purge_old_monte_carlo_runs",
        # 02:20 UTC — right after the schedule-requests purge.
        "schedule": crontab(hour=2, minute=20),
    },
    # Daily forecast-snapshot floor: guarantees ≥1 ProjectForecastSnapshot per
    # active project per day and backfills any recompute capture missed by a broker
    # blip / worker death (ADR-0154, #388). The durability backstop for capture.
    "capture-daily-forecast-floor": {
        "task": "scheduling.capture_daily_forecast_floor",
        # 00:30 UTC — early, before the nightly purges, so every project has a row.
        "schedule": crontab(hour=0, minute=30),
    },
    # Nightly cleanup: applies the tiered retention curve to project forecast
    # snapshots — all <90 d, weekly to 1 y, monthly forever (ADR-0154, #388).
    "prune-forecast-snapshots-nightly": {
        "task": "scheduling.prune_forecast_snapshots",
        # 04:15 UTC — after the other nightly purge jobs.
        "schedule": crontab(hour=4, minute=15),
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
    # Jira import drain: dispatches pending JiraImportRequest rows every 30 s and
    # recovers orphaned dispatched rows (worker died mid-import).
    "drain-jira-import-queue": {
        "task": "jira.drain_import_queue",
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
    # Daily stale-task detection (ADR-0200): nudge assignees of non-terminal tasks
    # that have sat in their status past the project's stale_task_threshold_days
    # (default 7). Dedupes against existing unread task.stale notifications.
    "detect-stale-tasks": {
        "task": "notifications.detect_stale_tasks",
        # 05:30 UTC — after the nightly purges/archive, so the scan reads settled
        # state and lands a fresh nudge before the working day starts.
        "schedule": crontab(hour=5, minute=30),
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
    # a nightly job would let rows live up to ~48h (ADR-0170).
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
    # (ADR-0174 §Durable Execution item 2; 5-min orphan window inside the task).
    "drain-workspace-exports": {
        "task": "workspace.drain_workspace_exports",
        "schedule": 30.0,
    },
    # Nightly: delete export jobs past their download-link expiry and their files
    # (ADR-0174 §Durable Execution item 6).
    "purge-expired-exports": {
        "task": "workspace.purge_expired_exports",
        # 04:20 UTC — after purge-stale-invites.
        "schedule": crontab(hour=4, minute=20),
    },
    # Re-dispatch project export bundle jobs orphaned by a broker outage at on_commit
    # (ADR-0219 §Durable Execution item 2; 5-min orphan window inside the task).
    "drain-project-exports": {
        "task": "projects.drain_project_exports",
        "schedule": 30.0,
    },
    # Nightly: delete project export jobs past their download-link expiry and their
    # files (ADR-0219 §Durable Execution item 6; shares TRUEPPM_EXPORT_RETENTION_DAYS).
    "purge-expired-project-exports": {
        "task": "projects.purge_expired_project_exports",
        # 04:25 UTC — after the workspace export purge.
        "schedule": crontab(hour=4, minute=25),
    },
    # Re-dispatch program export bundle jobs orphaned by a broker outage at on_commit
    # (ADR-0219 §Durable Execution item 2, program grain #1958).
    "drain-program-exports": {
        "task": "projects.drain_program_exports",
        "schedule": 30.0,
    },
    # Nightly: delete program export jobs past their download-link expiry and their
    # files (ADR-0219 §Durable Execution item 6; shares TRUEPPM_EXPORT_RETENTION_DAYS).
    "purge-expired-program-exports": {
        "task": "projects.purge_expired_program_exports",
        # 04:30 UTC — after the project export purge.
        "schedule": crontab(hour=4, minute=30),
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
    # Nightly: hard-delete per-row soft-deleted tombstones (is_deleted=True) from
    # live projects older than TRUEPPM_TOMBSTONE_RETENTION_DAYS (default 90 days).
    # Tombstones are kept so mobile sync clients receive deletion signals; once the
    # retention window passes there is no further sync value in the row (#1321).
    "reap-domain-tombstones-nightly": {
        "task": "sync.reap_domain_tombstones",
        # 03:30 UTC — between the sprint-close and workflow purge windows.
        "schedule": crontab(hour=3, minute=30),
    },
    # External task sync (ADR-0097 §4, #1419). Outbox drain for user-scoped
    # read-only Jira pulls: dispatches PENDING ExternalSyncRequest rows and
    # recovers orphaned DISPATCHED ones. 300 s cadence — a personal read-only
    # pull is not latency-critical (the POST .../sync/ trigger dispatches
    # immediately via on_commit; this is the broker-outage backstop).
    "drain-external-sync": {
        "task": "integrations.drain_external_sync",
        "schedule": 300.0,
    },
    # Opt-in low-frequency poll (ADR-0097 §4). Default-off per connection
    # (config["poll_enabled"]); fans out zero pulls until a user turns it on, so
    # a 15-minute cadence is a safe upper bound on the wired-but-dormant hook.
    "poll-external-sources": {
        "task": "integrations.poll_external_sources",
        "schedule": crontab(minute="*/15"),
    },
    # Nightly: hard-delete terminal (done/dead) ExternalSyncRequest outbox rows
    # older than 7 days and long-stale ExternalWorkItem cache rows (ADR-0097
    # §Durable Execution #6).
    "purge-external-sync-nightly": {
        "task": "integrations.purge_external_sync",
        # 03:45 UTC — after the domain-tombstone reap.
        "schedule": crontab(hour=3, minute=45),
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

# Self-service password reset (ADR-0209). Django's stateless
# ``PasswordResetTokenGenerator`` (default_token_generator) rejects tokens older
# than this window in ``check_token``. 30 minutes is the value surfaced in the
# reset-email copy and on the "sent" / "expired" screens — short enough to bound a
# leaked-link window, long enough for a user to act on the email.
PASSWORD_RESET_TIMEOUT = env.int("TRUEPPM_PASSWORD_RESET_TIMEOUT", default=1800)

# ---------------------------------------------------------------------------
# SimpleJWT token lifetimes + httpOnly refresh-cookie migration (#897)
# ---------------------------------------------------------------------------

# Short access-token TTL bounds the blast radius of a leaked in-memory access
# token; the SPA transparently refreshes via the httpOnly cookie on 401. A
# 7-day refresh TTL is the session length — long enough to avoid daily re-login,
# short enough that a stolen refresh token (cookie) self-expires within a week.
# Rotation + (optional) blacklist further limit replay of a leaked refresh token.
SIMPLE_JWT = {
    # Sign tokens with the dedicated JWT key (#2247). Defaults to SECRET_KEY, so
    # existing deploys are unaffected; set JWT_SIGNING_KEY to separate the two.
    "SIGNING_KEY": JWT_SIGNING_KEY,
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
#
# Env vars standardized on the TRUEPPM_ prefix pre-0.3 (#1325, #1355); the legacy
# bare names remain fallbacks so existing deploys keep working.
AUTH_REFRESH_COOKIE_NAME = env(
    "TRUEPPM_AUTH_REFRESH_COOKIE_NAME",
    default=env("AUTH_REFRESH_COOKIE_NAME", default="trueppm_refresh"),
)
AUTH_REFRESH_COOKIE_PATH = env(
    "TRUEPPM_AUTH_REFRESH_COOKIE_PATH",
    default=env("AUTH_REFRESH_COOKIE_PATH", default="/api/v1/auth/token/refresh/"),
)
AUTH_REFRESH_COOKIE_SAMESITE = env(
    "TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE",
    default=env("AUTH_REFRESH_COOKIE_SAMESITE", default="Strict"),
)
# Default Secure=True; dev settings flip this to False for plain-HTTP localhost.
AUTH_REFRESH_COOKIE_SECURE = env.bool(
    "TRUEPPM_AUTH_REFRESH_COOKIE_SECURE",
    default=env.bool("AUTH_REFRESH_COOKIE_SECURE", default=True),
)

# ---------------------------------------------------------------------------
# Content-Security-Policy (#897)
# ---------------------------------------------------------------------------

# Strict CSP, assembled into a header by core.csp.ContentSecurityPolicyMiddleware.
# script-src 'self' (no inline / no hash) is possible because the theme-init
# script was moved to an external file (web/public/theme-init.js). connect-src
# carries wss: for the WebSocket collaboration channel; the host is overridable
# per deploy. style-src keeps 'unsafe-inline' because the SPA emits inline style
# attributes (Tailwind/JS-driven) — tightening this is tracked separately.
_CSP_SELF = "'self'"
CSP_CONNECT_SRC = env.list("CSP_CONNECT_SRC", default=[_CSP_SELF, "wss:"])
CSP_DIRECTIVES: dict[str, list[str]] = {
    "default-src": [_CSP_SELF],
    "script-src": [_CSP_SELF],
    "style-src": [_CSP_SELF, "'unsafe-inline'", "fonts.googleapis.com"],
    "font-src": ["fonts.gstatic.com"],
    "img-src": [_CSP_SELF, "data:"],
    "connect-src": CSP_CONNECT_SRC,
    "frame-ancestors": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": [_CSP_SELF],
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
# OpenTelemetry observability foundation (ADR-0223, #708)
#
# OPT-IN, no default endpoint. Telemetry is enabled only when an OTLP endpoint
# is configured AND the master switch is on; with no endpoint the provider is a
# strict no-op (no SDK objects, no export threads, zero per-request cost). We
# read the well-known upstream OTEL_* env vars so operators reuse the names they
# already know from every other OTel-emitting service in their cluster, and add
# a few TRUEPPM_OTEL_* switches for behaviour the standard vars don't express.
# The bootstrap in trueppm_api.apps.observability.otel consumes these settings.
# ---------------------------------------------------------------------------

# The gate: an empty endpoint means telemetry is off. No default is provided on
# purpose — export must be a deliberate operator choice, never a silent egress.
OTEL_EXPORTER_OTLP_ENDPOINT: str = env("OTEL_EXPORTER_OTLP_ENDPOINT", default="")
# "grpc" (default, port 4317) or "http/protobuf" (port 4318).
OTEL_EXPORTER_OTLP_PROTOCOL: str = env("OTEL_EXPORTER_OTLP_PROTOCOL", default="grpc")
# Passed through verbatim to the exporter, e.g. "authorization=Bearer <token>"
# for a SaaS OTLP backend. Comma-separated key=value pairs per the OTel spec.
OTEL_EXPORTER_OTLP_HEADERS: str = env("OTEL_EXPORTER_OTLP_HEADERS", default="")
# Resource service.name. Defaults to the service, not the pod.
OTEL_SERVICE_NAME: str = env("OTEL_SERVICE_NAME", default="trueppm-api")
# Master kill switch, AND-ed with endpoint presence. Lets an operator leave the
# endpoint configured (e.g. in a shared ConfigMap) while disabling export here.
TRUEPPM_OTEL_ENABLED: bool = env.bool("TRUEPPM_OTEL_ENABLED", default=True)
# Independent signal toggles (only consulted when telemetry is enabled overall).
TRUEPPM_OTEL_TRACES_ENABLED: bool = env.bool("TRUEPPM_OTEL_TRACES_ENABLED", default=True)
TRUEPPM_OTEL_METRICS_ENABLED: bool = env.bool("TRUEPPM_OTEL_METRICS_ENABLED", default=True)
# Trace sampler selection, using the standard upstream env var names. Because the
# TracerProvider is built by hand (not via the SDK auto-config path), these would
# otherwise be silently ignored; the bootstrap reads them to build a Sampler so
# operators can throttle DB-span-dominated trace volume without a code change.
# Recognized samplers: always_on (default), always_off, traceidratio,
# parentbased_always_on, parentbased_always_off, parentbased_traceidratio.
# The arg carries the ratio (0.0–1.0) for the ratio-based samplers.
OTEL_TRACES_SAMPLER: str = env("OTEL_TRACES_SAMPLER", default="parentbased_always_on")
OTEL_TRACES_SAMPLER_ARG: str = env("OTEL_TRACES_SAMPLER_ARG", default="")
# Wall-clock bound (seconds) for the admin telemetry test-export probe (#2110):
# caps the one-off canary export and the TCP reachability probe so a dead collector
# can never hang the request thread. Well under the gunicorn worker timeout.
TELEMETRY_TEST_EXPORT_TIMEOUT_SECONDS: int = env.int(
    "TRUEPPM_TELEMETRY_TEST_EXPORT_TIMEOUT_SECONDS", default=5
)

# ---------------------------------------------------------------------------
# Structured logging + trace correlation (ADR-0223, #1899)
#
# The base config emits human-readable console lines that still carry the OTel
# trace_id/span_id/request_id inline, so a developer sees the same correlation
# context locally. prod.py flips this to single-line JSON (TRUEPPM_LOG_JSON) for a
# collector to index. The level honours DJANGO_LOG_LEVEL (default INFO) — the same
# well-known name operators set on every other Django service. Trace correlation
# (not OTLP log export, which is #711) means a log line can be pivoted straight to
# the trace exported for the same request.
# ---------------------------------------------------------------------------

DJANGO_LOG_LEVEL: str = env("DJANGO_LOG_LEVEL", default="INFO")
# JSON is opt-in in the base config so dev stays readable; prod.py sets this True.
TRUEPPM_LOG_JSON: bool = env.bool("TRUEPPM_LOG_JSON", default=False)

from trueppm_api.apps.observability.logging import (  # noqa: E402
    build_logging_config,
)

LOGGING = build_logging_config(level=DJANGO_LOG_LEVEL, json_output=TRUEPPM_LOG_JSON)

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

# Age in seconds past which a connected external-source connection's cache is
# "stale" for the My Work on-open refresh (ADR-0097 §4 "on-open refresh-if-
# stale"; #1921). Reuses the same order of magnitude as the manual-refresh
# cooldown (ADR-0097 §Resolution #5, `services.MANUAL_SYNC_COOLDOWN_SECONDS`)
# rather than inventing an unrelated number — a connection synced within this
# window is fresh enough that another My Work load should not re-trigger a
# pull. Configurable per-operator: a slower Jira instance or a rate-sensitive
# token may want a wider floor.
TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS: int = env.int(
    "TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS", default=300
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

# Project Monte Carlo run-history retention (ADR-0175, #961): the nightly purge
# keeps the newest MC_HISTORY_CAP MonteCarloRun rows per project so a PM can read
# finish-date forecast drift over time. None = unlimited (Enterprise overrides it
# — unbounded history + cross-program rollup is the portfolio upsell).
MC_HISTORY_CAP: int | None = 100

# Per-run distribution persistence (#1231, ADR-0144). The full
# {histogram_buckets, confidence_curve, sensitivity} payload is stored on
# MonteCarloRun.distribution so the histogram survives cache expiry. Bounded at
# 32 KB: a payload over this is down-sampled (every Nth histogram bucket) before
# persist so a pathological high-bucket run cannot bloat the row. The cache copy
# is unaffected by the down-sample.
MC_DISTRIBUTION_MAX_BYTES: int = 32_768

# Absolute upper bound on the per-workspace forecast-history retention cap
# (ADR-0144). The per-workspace mc_history_retention_cap is clamped to this on
# read so an operator (or future Enterprise override) cannot configure an
# unbounded per-project history that the nightly purge would never trim.
MC_HISTORY_HARD_CAP: int = 500

# Tiered retention curve for project-grain forecast snapshots (ADR-0154, #388).
# The nightly prune keeps every snapshot younger than ``daily_days``, then thins to
# one-per-ISO-week up to ``weekly_days``, then one-per-calendar-month beyond that
# (kept forever — the cold tail is ~12 rows/project/year). Operators can tune the
# two windows; the per-period keeper is always the newest row in that bucket.
FORECAST_SNAPSHOT_RETENTION: dict[str, int] = {
    "daily_days": 90,
    "weekly_days": 365,
}

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

# Max number of tasks (also applied to resources and dependency links) a single
# MS Project import may contain (#1721). The upload SIZE cap alone is not enough:
# a 50 MB MSPDI XML can encode ~1M tasks, and the importer builds one Task object
# per task, computes WBS over all of them, then bulk-creates the lot — a
# worker-memory / transaction-time DoS well within the byte ceiling. Rejecting
# outright (like the risk-CSV importer's MAX_ROWS) is safer than partially
# processing. 20k tasks is far above any realistic hand-authored schedule while
# bounding the object graph a single request can materialize.
MSPROJECT_MAX_ROWS: int = env.int("MSPROJECT_MAX_ROWS", default=20_000)

# batch_size for the import bulk_create() calls (#1721). Without it, Django emits
# one giant multi-row INSERT that pins the whole task/dependency set in a single
# statement (and can exceed PostgreSQL parameter limits); chunking bounds the
# per-statement memory and parameter count. Shared by the MS Project and Jira
# import paths (both persist through msproject.importer.import_project).
IMPORT_BULK_BATCH_SIZE: int = env.int("IMPORT_BULK_BATCH_SIZE", default=500)

# Hard cap on the XML MPXJ streams to stdout when converting a .mpp (#1722). A
# decompression-bomb .mpp within the 50 MB upload cap can expand to multi-GB XML;
# buffering it unbounded (the old capture_output=True) OOMs the worker. We stream
# stdout and abort past this many bytes. 512 MB is generous headroom for a
# legitimate 50 MB .mpp (MSPDI XML is ~5-10x the binary) while still bounded.
MPXJ_MAX_OUTPUT_MB: int = env.int("MPXJ_MAX_OUTPUT_MB", default=512)

# JVM max-heap (-Xmx) for the MPXJ subprocess (#1722). Bounding the JVM heap is a
# second line of defense: even if MPXJ tries to build a giant in-memory model
# from a bomb file, the JVM dies with an OutOfMemoryError (caught as a non-zero
# exit) instead of driving the host into swap.
MPXJ_MAX_HEAP_MB: int = env.int("MPXJ_MAX_HEAP_MB", default=512)

# Max size of an uploaded Jira XML export (#1664). Jira issue-navigator exports
# are small relative to .mpp files; the 25 MB default is generous for the minimal
# import slice and stays well under the DATA_UPLOAD_MAX_MEMORY_SIZE hard cap.
JIRA_IMPORT_MAX_UPLOAD_MB: int = env.int("JIRA_IMPORT_MAX_UPLOAD_MB", default=25)

# Max number of issues a single Jira XML import may contain (#1721). Same
# rationale as MSPROJECT_MAX_ROWS: the byte cap does not bound the derived task
# count, and every issue becomes a Task object built and bulk-created through the
# shared importer. Rejected outright over the limit.
JIRA_IMPORT_MAX_ROWS: int = env.int("JIRA_IMPORT_MAX_ROWS", default=20_000)

# Max size of an uploaded JSON program seed (ADR-0109, #615). Seeds are bounded
# (the largest bundled sample is a few hundred KB); 5 MB is generous headroom
# while bounding the memory a single authenticated import request can consume.
SEED_MAX_UPLOAD_MB: int = env.int("SEED_MAX_UPLOAD_MB", default=5)

# ---------------------------------------------------------------------------
# Django REST Framework
# ---------------------------------------------------------------------------

# The tightest scoped-throttle tier, shared by the handful of single-shot
# endpoints whose per-call cost — one outbound egress probe or one double
# CPM + Monte Carlo pass — makes even a modest loop abusive. Kept as one named
# constant so the rate lives in a single place rather than a repeated literal.
_STRICT_ABUSE_RATE = "6/min"

# The remaining scoped-throttle tiers, from the general per-user default down
# to the credential-shaped endpoints (login, password reset, invite resend).
# Named once for the same reason as _STRICT_ABUSE_RATE above.
_STANDARD_RATE = "60/min"
_MODERATE_RATE = "20/min"
_STRICT_RATE = "10/min"
_STRICTEST_RATE = "5/min"

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
    # API-only service: render JSON, nothing else. DRF's default renderer set
    # includes BrowsableAPIRenderer, which content-negotiates on the request
    # Accept header and, for a serializer-less GenericViewSet, calls
    # get_serializer() to build its HTML form — firing DRF's
    # `assert self.serializer_class is not None` (an unhandled 500) whenever a
    # caller sends `Accept: text/html`. A fuzzer (or any browser) trivially
    # trips this on every serializer-less action. Restricting to JSONRenderer
    # turns those requests into a clean 406 and removes the whole class of bug
    # (#2213). Set unconditionally (not DEBUG-gated) because the nightly fuzz
    # and the test suite run under dev settings with DEBUG=True — the browsable
    # API is redundant with the drf-spectacular Swagger UI anyway.
    "DEFAULT_RENDERER_CLASSES": [
        "rest_framework.renderers.JSONRenderer",
    ],
    # Custom handler translates a malformed UUID (bad path segment or query param)
    # into 404/400 instead of the 500 DRF's default returns for the Django
    # ValidationError / uuid.UUID ValueError those raise (#2125).
    "EXCEPTION_HANDLER": "trueppm_api.core.exception_handlers.trueppm_exception_handler",
    # Tolerant OPTIONS metadata: DRF's default calls get_serializer() while
    # building action metadata, which asserts (→ 500) on serializer-less
    # GenericViewSets. This subclass degrades that to empty action metadata (#2229).
    "DEFAULT_METADATA_CLASS": "trueppm_api.core.metadata.TolerantMetadata",
    "DEFAULT_FILTER_BACKENDS": [
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    # Custom AutoSchema documents a 429 response on rate-limited operations (#1333);
    # throttling is a view attribute invisible to the schema post-processing hooks.
    "DEFAULT_SCHEMA_CLASS": "trueppm_api.core.openapi.TruePPMAutoSchema",
    # General default throttle (#1080). Every endpoint that does NOT declare its
    # own throttle_classes gets the baseline "anon"/"user" rate below — the
    # general DoS / resource-starvation protection a self-hoster expects. The
    # ProbeExempt* classes are the stock DRF anon/user throttles with one
    # override: they never count the unauthenticated /api/v1/health/ and
    # /api/v1/edition/ probe endpoints, which Kubernetes hits on a tight
    # liveness/readiness loop (the reason a bare AnonRateThrottle was previously
    # avoided — now solved by the exemption). A view that sets its own
    # throttle_classes (login, refresh, monte_carlo, etc. below) REPLACES this
    # default rather than stacking on top of it, so those endpoints keep only
    # their specific, stricter scope.
    "DEFAULT_THROTTLE_CLASSES": [
        "trueppm_api.core.throttling.ProbeExemptAnonRateThrottle",
        "trueppm_api.core.throttling.ProbeExemptUserRateThrottle",
    ],
    # Trusted-proxy depth for client-IP extraction (#1080). Without this DRF keys
    # the anon throttle on the client-supplied X-Forwarded-For header verbatim, so
    # an attacker could rotate XFF to mint a fresh anon identity per request and
    # bypass the anon limit entirely. NUM_PROXIES tells DRF how many trusted proxies
    # sit in front of the app (the standard Helm chart has a single ingress → 1), so
    # it reads the real client IP from a trusted position and ignores attacker-
    # prepended entries. Set to the deployment's actual proxy depth via env; 0 means
    # "no proxy, use REMOTE_ADDR". The authenticated "user" scope keys on the account
    # id and is unaffected.
    "NUM_PROXIES": env.int("TRUEPPM_NUM_PROXIES", default=1),
    "DEFAULT_THROTTLE_RATES": {
        # General default rates for the ProbeExempt* classes above. Env-tunable
        # so operators can tighten or loosen the baseline without a rebuild.
        # "anon" bounds unauthenticated traffic per client IP; "user" bounds an
        # authenticated account. Both are generous enough that a normal
        # interactive client never trips them.
        "anon": env("TRUEPPM_THROTTLE_ANON_RATE", default=_STANDARD_RATE),
        "user": env("TRUEPPM_THROTTLE_USER_RATE", default="1000/min"),
        "login": _STRICT_RATE,
        # Per-account login lockout (#1717). The "login" scope above keys on the
        # client IP, so it only bounds guesses per source address; a distributed
        # credential-stuffing attack from a rotating IP pool gets the full per-IP
        # allowance from every fresh IP and is unbounded in aggregate against one
        # account. This scope keys on the (hashed, normalized) submitted username
        # instead, so attempts against a single account are capped no matter how
        # many IPs participate. It is STACKED with "login" — both throttles apply
        # to the login view. Env-tunable so an operator can tighten or loosen it.
        # 5/min still leaves room for a human who fat-fingers a password a few
        # times, while making cross-IP account targeting expensive.
        "login_account": env("TRUEPPM_THROTTLE_LOGIN_ACCOUNT_RATE", default=_STRICTEST_RATE),
        # Self-service password reset (#765, ADR-0209). Covers BOTH the request
        # endpoint (which emails a reset link) and the confirm endpoint (which sets
        # the new password). 5/min per IP bounds two abuses at once: email-bombing a
        # victim by looping the request endpoint, and timing/enumeration probing of
        # which addresses have accounts (the request endpoint returns an identical
        # 200 either way, so the throttle is the primary enumeration defense — see
        # ADR-0209). 5/min still leaves ample room for a human who mistypes, resends,
        # and retries a confirm a couple of times.
        "password_reset": _STRICTEST_RATE,
        # JWT refresh (#814). 60/min is loose enough that any realistic
        # web/mobile client (5-minute access-token TTL → ~12 refreshes/hour)
        # never trips it, but tight enough that a stolen/leaked refresh token
        # cannot be exchanged for access tokens at unbounded rate.
        "refresh": _STANDARD_RATE,
        # User typeahead for member invite (#815). Tight enough that a single
        # account cannot bulk-scrape the workspace user list, loose enough that
        # interactive typeahead (debounced, >=2 chars) never trips it.
        "user_search": _STANDARD_RATE,
        # ⌘K global Epic/Story omni-search (ADR-0508 D4, #2103). A debounced,
        # >=2-char typeahead over the caller's own membership; the 60/min bound
        # matches user_search — snug enough that a scripted loop cannot bulk-map
        # every epic/story title the account can see, loose enough that live typing
        # never trips it.
        "omni_search": env("TRUEPPM_THROTTLE_OMNI_SEARCH_RATE", default=_STANDARD_RATE),
        # WebSocket connection tickets (#818, ADR-0141). One ticket is minted per
        # socket open (and per reconnect, since tickets are single-use); 120/min
        # covers aggressive reconnect storms without letting one account flood
        # Redis with 30-second ticket keys.
        "ws_ticket": "120/min",
        # Invite-email resend (#969, ADR-0149). Each request re-issues a token and
        # re-queues an email; 5/min per admin bounds email-bomb abuse while leaving
        # ample room for a human clicking "Resend" on a handful of stuck invites.
        # "Resend all" is one request → one bucket hit, so it cannot be looped past
        # the cap.
        "invite_resend": _STRICTEST_RATE,
        # Workspace SMTP config (#712, ADR-0213). Writes re-open a candidate SMTP
        # connection (validate-before-persist); "probe" covers the two outbound
        # amplifiers — send-test (opens a real SMTP socket) and the deliverability
        # health check (fires live DNS TXT lookups). Both are blind-SSRF / egress
        # oracles if unbounded, so cap them tightly (security review H3). An admin
        # configuring mail never trips these; a script probing hosts does.
        "email_settings": "12/min",
        "email_settings_probe": _STRICT_ABUSE_RATE,
        # SSO domain discovery (ADR-0187). Unauthenticated; reveals only whether a
        # *domain* uses SSO (never whether an account exists), but the rate still
        # bounds bulk domain-probing. Loose enough for the interactive login page.
        "oidc_discover": "30/min",
        # SSO login start (ADR-0187). Each hit mints a single-use state/PKCE/nonce
        # cache entry and 302s to the IdP; this also implicitly bounds the callback
        # (every callback requires a state minted here). Snug but ample for humans.
        "oidc_login": _MODERATE_RATE,
        # SSO callback (ADR-0187). A token-issuing endpoint; the implicit bound via
        # oidc_login already caps legitimate use, but an explicit cap blunts a flood
        # of forged callbacks (each fails fast at the browser-state-cookie check).
        "oidc_callback": "30/min",
        # Admin "Test connection" probe (ADR-0517 §3.4). Each call triggers
        # server-side egress (OIDC discovery + JWKS, or the GitHub API), so it needs
        # an abuse bound so an admin cannot drive unbounded outbound requests.
        # 20/min is ample for a human wiring up a provider.
        "sso_test_connection": _MODERATE_RATE,
        # Integration-credential and Git webhook-secret endpoints (#1551). Covers the
        # per-user credential store (connect/rotate/revoke/read) and the project-admin
        # Git-automation config + secret-rotation views. Each of these mints, returns,
        # or reveals the presence of a plaintext credential/secret, so they need the
        # same brute-force/abuse bound the other credential-adjacent endpoints already
        # carry. 10/min is snug for a human wiring up integrations yet far below any
        # automated rotation-scraping rate.
        "credential_rotate": _STRICT_RATE,
        # Manual external-source pull trigger (POST /me/connections/{source}/sync/,
        # ADR-0097 §4, #1419). The service-layer 60 s per-connection cooldown is the
        # primary spacing control; this scope is the coarse abuse bound so a scripted
        # loop cannot spam the outbox faster than a human ever would. 20/min sits
        # above the cooldown's ~1/min steady state with headroom for multiple
        # connected sources.
        "external_sync": _MODERATE_RATE,
        # Synchronous Monte Carlo simulation (#1552). run_monte_carlo executes an
        # expensive (up to MC_SIMULATION_CAP iterations, caller-controlled
        # n_simulations) simulation inline in the request/response cycle, gated only
        # by project membership. Without a rate cap any single member can loop the
        # endpoint to exhaust CPU. 10/min leaves ample headroom for a human tuning
        # estimates and re-running the forecast a handful of times, while blunting a
        # scripted resource-exhaustion flood.
        "monte_carlo": _STRICT_RATE,
        # Non-mutating Monte Carlo what-if (#993). The what-if endpoint runs *two*
        # CPM passes and *two* Monte Carlo simulations per call (baseline vs the
        # perturbed schedule, so the delta isolates the perturbation) — roughly
        # double the CPU of a single run_monte_carlo — so it carries a tighter cap
        # than the plain "monte_carlo" scope. 6/min still leaves ample room for a
        # human (or an MCP agent) exploring a handful of "what if I slip this task"
        # scenarios while blunting a scripted resource-exhaustion flood.
        "monte_carlo_whatif": _STRICT_ABUSE_RATE,
        # MCP read surface per-token rate limits (#1808 finding F4). These bound
        # token-authenticated reads on any McpReadableViewMixin view ONLY — human
        # JWT/Session traffic on the same views is unaffected (the throttles'
        # get_cache_key returns None for non-token callers, so DRF skips them; see
        # apps/access/throttles.py). "mcp_read" is the baseline cap every
        # MCP-readable view applies per token; "mcp_read_compute" is the tighter
        # bucket the four compute-heavy tools (whatif, monte-carlo/latest, forecast,
        # sprint-forecast) STACK on top, since each triggers a CPM + Monte Carlo
        # recompute per call and a read-only token loop must not burn arbitrary CPU.
        # Env-tunable so an operator can widen the budget for a trusted agent fleet
        # or tighten it under load. OSS ships basic per-token limits; per-agent
        # budgets and anomaly auto-suspend are Phase 4 / Enterprise.
        "mcp_read": env("TRUEPPM_THROTTLE_MCP_READ_RATE", default="120/min"),
        "mcp_read_compute": env("TRUEPPM_THROTTLE_MCP_READ_COMPUTE_RATE", default="12/min"),
        # Public board share-link endpoints (#283, ADR-0245). "share_mint" bounds
        # how fast one Admin account can spray share links; "share_access" bounds
        # scraping/abuse of the unauthenticated public board endpoint (the 256-bit
        # token is already non-enumerable — this stops a leaked/viral link becoming
        # an unthrottled load source on a self-hosted box, per Omar's VoC concern).
        "share_mint": env("TRUEPPM_THROTTLE_SHARE_MINT_RATE", default=_MODERATE_RATE),
        "share_access": env("TRUEPPM_THROTTLE_SHARE_ACCESS_RATE", default=_STANDARD_RATE),
        # Telemetry test-export probe (#2110). An admin-only button that opens one
        # outbound canary/reachability probe to the configured OTLP collector;
        # scoped-throttled so it can't be used to hammer the collector.
        "telemetry_test": env("TRUEPPM_THROTTLE_TELEMETRY_TEST_RATE", default=_STRICT_ABUSE_RATE),
    },
}

# MCP administration controls (#2021, ADR-0497).
#
# Instance-wide MCP kill switch. Default True preserves backward compatibility —
# existing deployments keep agent (mcp:read token) access. Set False to deny every
# MCP-token read at the McpReadableViewMixin chokepoint (403), even though the
# token exists; human JWT/session auth on the same viewsets is unaffected. This is
# the operator lever for "no agent access on this instance, period."
TRUEPPM_MCP_ENABLED: bool = env.bool("TRUEPPM_MCP_ENABLED", default=True)

# Env-overridable safety caps for API tokens and inbound task-sync. Each keeps its
# historical hardcoded default; surfacing them as settings lets an operator tune the
# blast-radius/limits per deployment without a code change. Read at request time so
# override_settings (and a live env change) takes effect.
#
# Max ACTIVE personal access tokens per user (ADR-0214). Bounds the blast radius of
# a leaked account and keeps the /me/api-tokens/ list navigable.
TRUEPPM_MAX_PERSONAL_ACCESS_TOKENS: int = env.int("TRUEPPM_MAX_PERSONAL_ACCESS_TOKENS", default=10)
# Token-issuance rate cap (req/min/user) on the mint endpoint (ADR-0068). Caps the
# blast radius of a compromised admin session even when RBAC is satisfied.
TRUEPPM_TOKEN_ISSUANCE_PER_MINUTE: int = env.int("TRUEPPM_TOKEN_ISSUANCE_PER_MINUTE", default=5)
# Inbound task-sync per-project rate caps (ADR-0068). Steady-state limit applies
# after the 60-minute backfill window; the higher backfill limit applies to a
# freshly minted token so a large first import gets headroom.
TRUEPPM_TASK_SYNC_STEADY_STATE_LIMIT: int = env.int(
    "TRUEPPM_TASK_SYNC_STEADY_STATE_LIMIT", default=100
)
TRUEPPM_TASK_SYNC_BACKFILL_LIMIT: int = env.int("TRUEPPM_TASK_SYNC_BACKFILL_LIMIT", default=1000)

# Sync watermark source (#822, ADR-0142). When True the sync pull reads the
# denormalized Project.last_sync_version column; set False to fall back to the
# 12-table UNION ALL (_snapshot_max_version) for one release if a drift bug is
# found in production. The conformance test asserts the two agree.
SYNC_WATERMARK_USE_COLUMN = env.bool("SYNC_WATERMARK_USE_COLUMN", default=True)

# Public read-only sharing — board (#283, ADR-0245) and schedule (#1486, ADR-0265).
# The instance kill switch governs BOTH share kinds: when False, minting new links
# (403) and every public share endpoint (uniform 404, retroactively disabling
# existing links) are turned off org-wide — the operator/PMO off lever for the
# unauthenticated egress surface. One lever, one mental model: a deployment can
# never leak schedules while "board sharing" reads off. Default True is safe because
# no data is exposed until an Owner/Admin explicitly mints a link. The SHARE_*_MAX_*
# caps bound each public snapshot payload (the projection flags "truncated" past the
# cap rather than silently dropping content). The env var keeps its #283 name for
# back-compat with deployments that already set it.
TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED = env.bool(
    "TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED", default=True
)
SHARE_BOARD_MAX_CARDS = env.int("TRUEPPM_SHARE_BOARD_MAX_CARDS", default=1000)
SHARE_SCHEDULE_MAX_TASKS = env.int("TRUEPPM_SHARE_SCHEDULE_MAX_TASKS", default=1000)

# ---------------------------------------------------------------------------
# django-allauth
# ---------------------------------------------------------------------------

SITE_ID = 1
ACCOUNT_EMAIL_VERIFICATION = "none"

# ModelBackend FIRST so username/password login keeps working exactly as before
# (ADR-0517 §1). The allauth backend is appended only so allauth's own account
# machinery resolves; our SSO views never call allauth's login() — they mint the
# simplejwt cookie session via the JWT bridge (apps/sso/views.py).
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]

# SOCIALACCOUNT_PROVIDERS is used purely as a per-provider CONFIG REGISTRY — it
# pins the server-fixed OSS scopes and PKCE. Per-provider APPS are NOT hardcoded
# here: each configured IdP lives as a DB `SocialApp` row (provider_id == our
# registry slug) written through the admin API, so the APPS list stays empty
# (ADR-0517 §1). We deliberately do NOT set LOGIN_REDIRECT_URL or
# SOCIALACCOUNT_ADAPTER — our own views own the flow, allauth is a library.
SOCIALACCOUNT_PROVIDERS = {
    "openid_connect": {
        "APPS": [],
        "OAUTH_PKCE_ENABLED": True,
        # Server-fixed in OSS — `groups`/custom claims are an Enterprise widening.
        "SCOPE": ["openid", "email", "profile"],
    },
    "github": {
        # OIDC-equivalent scopes: identity via GET /user + /user/emails.
        "SCOPE": ["read:user", "user:email"],
    },
}

# ---------------------------------------------------------------------------
# Outbound email transport (#639 read-only status page, #764)
# ---------------------------------------------------------------------------
# Bind Django's standard EMAIL_* settings from the environment so operators
# configure SMTP via container env vars / Helm values with no settings override.
# The Beat-driven notification drain runs on the api, celery, and celery-beat
# workloads, so all three must receive the same env. EMAIL_HOST_PASSWORD is read
# from the environment but never exposed by the API or logged (#639).
#
# EMAIL_HOST defaults to "" (not Django's implicit "localhost") so an
# unconfigured deployment reports "Not configured" on the read-only status page
# and the drain skips sending, rather than silently attempting localhost:25.
EMAIL_BACKEND = env("EMAIL_BACKEND", default="django.core.mail.backends.smtp.EmailBackend")
EMAIL_HOST = env("EMAIL_HOST", default="")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_USE_TLS = env.bool("EMAIL_USE_TLS", default=True)
EMAIL_USE_SSL = env.bool("EMAIL_USE_SSL", default=False)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="")
EMAIL_TIMEOUT = env.int("EMAIL_TIMEOUT", default=10)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="notifications@trueppm.local")

# ---------------------------------------------------------------------------
# drf-spectacular (OpenAPI)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Object change history (django-simple-history)
# ---------------------------------------------------------------------------

# Retention window in days. Records older than this are purged nightly by the
# Celery beat task in trueppm_api.apps.history.tasks.
# Set to None to disable automatic purging (enterprise unlimited retention).
# Operator env var standardized on the TRUEPPM_ prefix pre-0.3 (#1325) so all
# tunables share one namespace in ConfigMaps/Secrets; the legacy bare name is read
# as a fallback so deploys that already set it keep working until they migrate.
HISTORY_RETENTION_DAYS: int | None = env.int(
    "TRUEPPM_HISTORY_RETENTION_DAYS", default=env.int("HISTORY_RETENTION_DAYS", default=90)
)

# ---------------------------------------------------------------------------
# Signal-privacy ceiling-raise ratification (ADR-0104 Amendment A, #930)
# ---------------------------------------------------------------------------

# How long a team-ratification proposal to raise a signal's ceiling stays OPEN
# before it lazily expires UNRATIFIED (the ceiling is left unchanged — silence is
# never consent for widening a team signal's exposure). 72h is long enough for an
# async team yet short enough not to stall a pending share. Evaluated lazily on
# read/vote/propose; no Celery/Beat sweep is required.
SIGNAL_CEILING_PROPOSAL_TTL_HOURS: int = env.int("SIGNAL_CEILING_PROPOSAL_TTL_HOURS", default=72)

# ---------------------------------------------------------------------------
# Task run retention (trueppm_api.apps.taskruns)
# ---------------------------------------------------------------------------

# Retention window in days for completed/failed/cancelled TaskRun records.
# Set to None to disable automatic purging. Env var standardized on the TRUEPPM_
# prefix pre-0.3 (#1325); legacy bare name read as a fallback.
TASK_RUN_RETENTION_DAYS: int | None = env.int(
    "TRUEPPM_TASK_RUN_RETENTION_DAYS", default=env.int("TASK_RUN_RETENTION_DAYS", default=30)
)

# ---------------------------------------------------------------------------
# Time tracking (trueppm_api.apps.timetracking, ADR-0185)
# ---------------------------------------------------------------------------

# Stale-timer ceiling: a running timer that exceeds this many minutes is flagged
# ``stale`` on GET /me/timer/, and ``stop`` caps the logged minutes at it rather
# than the raw elapsed (so a timer left running over a weekend logs the ceiling,
# not thousands of minutes). Default 600 = 10 h.
TIMETRACKING_TIMER_MAX_MINUTES: int = env.int("TIMETRACKING_TIMER_MAX_MINUTES", default=600)

# Manual-entry backdate window: a manual ``entry_date`` is rejected if it is in the
# future or older than this many days, so a contributor can fill in last week but
# not rewrite arbitrary history. Default 60 days.
TIMETRACKING_BACKDATE_DAYS: int = env.int("TIMETRACKING_BACKDATE_DAYS", default=60)

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
# nightly purge deletes the job row and its stored archive (ADR-0174). The full
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

# Retention window in hours for the WebSocket event replay buffer (ADR-0236,
# #321). BoardEvent rows older than this are reaped by the nightly
# sync.purge_board_events task so the buffer stays bounded; a client reconnecting
# with a ?since= older than the retained window gets a resync_required frame and
# refetches. Kept deliberately short (a reconnect gap is minutes, not days).
TRUEPPM_BOARD_EVENT_RETENTION_HOURS: int = env.int(
    "TRUEPPM_BOARD_EVENT_RETENTION_HOURS", default=24
)

# Retention window in days for soft-deleted (trashed) projects. Once a project has
# been soft-deleted for longer than this, the consolidated retention purge
# (retention.run_purge, ADR-0173) HARD-deletes it and all its child data (tasks,
# dependencies, sprints, baselines, …) via DB CASCADE. Set to None to disable the
# purge (trashed projects are retained unbounded). A project soft-deleted before
# this column existed has a NULL deleted_at and is never auto-purged.
TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS: int | None = env.int(
    "TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS", default=30
)

# How long a manual retention purge may be considered "in progress" before the
# run endpoint stops treating a RUNNING PurgeRow as blocking (ADR-0173 §G). Bounds
# the API-level single-flight guard to the coordinator's Redis lock window so a
# worker that died mid-run can't block all future manual runs with a stale row.
RETENTION_PURGE_INFLIGHT_SECONDS: int = env.int("RETENTION_PURGE_INFLIGHT_SECONDS", default=600)

# Maximum rows (created + updated + deleted) in a single mobile sync upload
# batch (ADR-0082). The batch applies in one transaction; this bounds how long
# that transaction (and its per-task row locks) can be held by one request.
TRUEPPM_SYNC_BATCH_MAX_ROWS: int = env.int("TRUEPPM_SYNC_BATCH_MAX_ROWS", default=500)

# Cursor pagination for the offline delta PULL (#1013). A cold start (since=0)
# on a large project would otherwise materialize every row into one unbounded
# multi-MB response, past the "500-task delta < 3s" mobile target. The pull now
# returns at most PAGE_SIZE rows (across all collections) per request and the
# client loops on the cursor. PAGE_SIZE is the default; MAX_PAGE_SIZE clamps a
# client-requested page_size so one request can never re-open the unbounded cliff.
TRUEPPM_SYNC_PULL_PAGE_SIZE: int = env.int("TRUEPPM_SYNC_PULL_PAGE_SIZE", default=1000)
TRUEPPM_SYNC_PULL_MAX_PAGE_SIZE: int = env.int("TRUEPPM_SYNC_PULL_MAX_PAGE_SIZE", default=5000)

# Retention window in days for per-row soft-deleted tombstones in live projects
# (is_deleted=True rows on Task, Risk, Sprint, Dependency). Rows older than this
# are hard-deleted by the nightly sync.reap_domain_tombstones task. The 90-day
# default aligns with the HistoricalTask history window so tombstones are never
# retained longer than the audit trail that references them (#1321).
TRUEPPM_TOMBSTONE_RETENTION_DAYS: int = env.int("TRUEPPM_TOMBSTONE_RETENTION_DAYS", default=90)

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
# Env vars standardized on the TRUEPPM_ prefix pre-0.3 (#1325); legacy bare names
# read as a fallback so existing deploys keep working until they migrate.
WORKFLOW_BACKEND = env.str(
    "TRUEPPM_WORKFLOW_BACKEND",
    default=env.str(
        "WORKFLOW_BACKEND",
        default="trueppm_api.workflows.backends.default.DefaultWorkflowBackend",
    ),
)

# Retention window in days for WorkflowHistoryEvent rows (purged nightly by
# workflows.purge_old_records). Set to None / 0 to disable history purging.
WORKFLOW_HISTORY_RETENTION_DAYS: int | None = env.int(
    "TRUEPPM_WORKFLOW_HISTORY_RETENTION_DAYS",
    default=env.int("WORKFLOW_HISTORY_RETENTION_DAYS", default=30),
)

# Max rows the workflow outbox/timer drains process per tick. Bounds the work
# per run so a large backlog (e.g. after a broker outage) can't exceed the task
# time_limit — subsequent ticks drain the remainder.
WORKFLOW_DRAIN_BATCH_SIZE = env.int(
    "TRUEPPM_WORKFLOW_DRAIN_BATCH_SIZE", default=env.int("WORKFLOW_DRAIN_BATCH_SIZE", default=200)
)

# Rows deleted per statement by the nightly workflow retention purge. The purge
# deletes in bounded chunks rather than one unbounded statement so the first run
# on a mature install (e.g. after WORKFLOW_HISTORY_RETENTION_DAYS is first set)
# cannot take a long lock over a large slice of the history/outbox tables.
WORKFLOW_PURGE_BATCH_SIZE = env.int(
    "TRUEPPM_WORKFLOW_PURGE_BATCH_SIZE", default=env.int("WORKFLOW_PURGE_BATCH_SIZE", default=500)
)

# ---------------------------------------------------------------------------
# Idempotency-Key retention (trueppm_api.apps.idempotency, ADR-0170)
# ---------------------------------------------------------------------------

# Retention window in hours for stored Idempotency-Key responses. Purged hourly by
# the Celery beat task in trueppm_api.apps.idempotency.tasks. After expiry, a retry
# with the same key re-runs the mutation. Set to None to disable automatic purging.
# Env vars standardized on the TRUEPPM_ prefix pre-0.3 (#1325); legacy bare names
# read as a fallback so existing deploys keep working until they migrate.
IDEMPOTENCY_RETENTION_HOURS: int | None = env.int(
    "TRUEPPM_IDEMPOTENCY_RETENTION_HOURS",
    default=env.int("IDEMPOTENCY_RETENTION_HOURS", default=24),
)
# Maximum stored response body size (bytes). Responses larger than this are not stored
# (the claim row is dropped, so a retry re-runs). Mutation responses are single objects
# and effectively never approach this.
IDEMPOTENCY_MAX_BODY_BYTES: int = env.int(
    "TRUEPPM_IDEMPOTENCY_MAX_BODY_BYTES",
    default=env.int("IDEMPOTENCY_MAX_BODY_BYTES", default=1 * 1024 * 1024),
)

# ---------------------------------------------------------------------------
# drf-spectacular (OpenAPI)
# ---------------------------------------------------------------------------

SPECTACULAR_SETTINGS = {
    "TITLE": "TruePPM API",
    "DESCRIPTION": "REST API for the TruePPM project scheduling platform.",
    "VERSION": "0.3.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    # Meaningful top-level tag block (#1333). drf-spectacular defaults every
    # /api/v1/ operation to the tag "v1", which collapses a generated client into a
    # single API class. Defining tags here (plus the resource-tag assignment in the
    # post-processing hook below) splits the SDK into ProjectsApi, SprintsApi,
    # SchedulingApi, … the way an SDK consumer expects. Kept in lockstep with the
    # tag-assignment map in trueppm_api.core.openapi (defined inline rather than
    # imported: settings must not import DRF-dependent app code, which would force
    # rest_framework's api_settings to cache before REST_FRAMEWORK is defined).
    "TAGS": [
        {
            "name": "auth",
            "description": "Authentication, login, token issuance and OIDC single sign-on.",
        },
        {
            "name": "me",
            "description": "The authenticated user's own account, credentials, timers and work.",
        },
        {
            "name": "workspace",
            "description": "Workspace-level settings, membership, invites and branding.",
        },
        {
            "name": "projects",
            "description": "Projects and their project-level views (overview, status, history).",
        },
        {
            "name": "programs",
            "description": "Programs — grouping of related projects managed by one PM.",
        },
        {
            "name": "tasks",
            "description": "Tasks, dependencies, milestones, acceptance criteria and task runs.",
        },
        {
            "name": "task-relations",
            "description": "Informational task-to-task relations (relates to, blocks, "
            "duplicates) — cross-references with no scheduling effect.",
        },
        {
            "name": "scheduling",
            "description": "CPM scheduling, baselines, Monte Carlo forecasts and slip analysis.",
        },
        {
            "name": "sprints",
            "description": "Sprints, backlog, velocity, retrospectives and agile ceremonies.",
        },
        {
            "name": "resources",
            "description": "Resources, skills, allocation, utilization and assignments.",
        },
        {"name": "calendars", "description": "Working calendars, exceptions and recurrence rules."},
        {"name": "teams", "description": "Teams and team membership."},
        {"name": "members", "description": "Project and program membership management."},
        {
            "name": "integrations",
            "description": "External task sources, Git automation and personal credentials.",
        },
        {
            "name": "assets",
            "description": "Workspace-scoped Assets feed: file/URL attachments and task links "
            "aggregated across every project the caller can read.",
        },
        {"name": "import-export", "description": "MS Project import/export and data exports."},
        {"name": "webhooks", "description": "Outbound webhook subscriptions."},
        {
            "name": "sync",
            "description": "Offline delta-sync protocol and WebSocket connection tickets.",
        },
        {"name": "workshops", "description": "Collaborative planning workshops."},
        {
            "name": "share",
            "description": "Public read-only board share links: mint, list, revoke, and the "
            "public unauthenticated read endpoint.",
        },
        {
            "name": "agent-actions",
            "description": "Append-only, hash-chained audit trail of MCP/agent read actions "
            "and refusals, scoped to project membership.",
        },
        {
            "name": "meta",
            "description": "Deployment metadata, health probes and administrative endpoints.",
        },
    ],
    # Fill SDK-quality facets (operation summaries, resource tags, global + public
    # security) that per-view annotations leave thin. Runs after the built-in enum
    # post-processor, which must be preserved (drf-spectacular default).
    "POSTPROCESSING_HOOKS": [
        "drf_spectacular.hooks.postprocess_schema_enums",
        "trueppm_api.core.openapi.postprocess_openapi",
    ],
    # Serve the Swagger UI / ReDoc assets from the bundled sidecar package (Django
    # static, same origin) instead of the default jsdelivr CDN. Our strict CSP
    # (script-src / style-src 'self', no CDN host) blocks the CDN-hosted bundles,
    # leaving the docs pages blank. SIDECAR resolves every asset under 'self', so
    # the pages work under CSP and offline/air-gapped. Paired with the split
    # Swagger view in urls.py, which moves the bootstrap JS out of an inline
    # <script> (also blocked by script-src 'self') to a same-origin request.
    "SWAGGER_UI_DIST": "SIDECAR",
    "SWAGGER_UI_FAVICON_HREF": "SIDECAR",
    "REDOC_DIST": "SIDECAR",
    # Self-hosted deployments serve the API from their own origin, so the schema
    # advertises a single templated server (scheme + host variables) whose
    # defaults are the local-dev address. Without a top-level `servers` array,
    # openapi-typescript / Orval / openapi-generator emit base-URL-less clients
    # or fail outright (#1329). Paths already carry the `/api/v1/` prefix, so the
    # server URL is just the deployment origin.
    "SERVERS": [
        {
            "url": "{scheme}://{host}",
            "description": "Your TruePPM deployment",
            "variables": {
                "scheme": {"default": "https", "enum": ["https", "http"]},
                "host": {
                    "default": "localhost:8000",
                    "description": "Host (and port) of your TruePPM API server.",
                },
            },
        },
    ],
    # Pin state-enum names (ADR-0173). PurgeRun.state shares the field name "state"
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
        # ADR-0107: Workspace gains a third use of Methodology (after Project +
        # Program) and methodology_override_policy reuses TermOverridePolicy. Pin
        # Methodology to its stable component name proactively so the third use does
        # not trip the drf-spectacular enum-name-collision / schema-drift regression
        # (project_drf_enum_name_collision), same class as the entries above.
        "MethodologyEnum": "trueppm_api.apps.projects.models.Methodology",
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
        # ADR-0124 (#1135): Task.blocker_type adds a new structured-blocker choice
        # set. Pin to a stable model-prefixed name so drf-spectacular does not
        # hash-disambiguate or rename existing components (same regression class as
        # ScopeChangeStatus above — project memory project_drf_enum_name_collision).
        "BlockerTypeEnum": "trueppm_api.apps.projects.models.BlockerType",
        # ADR-0219 (#1266): ProjectExportJob.status introduces a second export-job
        # status choice set with the SAME members (pending|running|success|failed)
        # as workspace.ExportJobStatus. drf-spectacular unifies identical value-sets
        # into ONE component, and without a pin it hash-disambiguates and DROPS the
        # existing WorkspaceExportJobStatusEnum (a schema-drift regression — project
        # memory project_drf_enum_name_collision). Pin the shared value-set to the
        # already-published WorkspaceExportJobStatusEnum name so no component is
        # removed; the project export field simply reuses that stable component.
        "WorkspaceExportJobStatusEnum": "trueppm_api.apps.workspace.models.ExportJobStatus",
        # ADR-0112 RC1 (#1805): the AgentAction read serializer exposes verdict,
        # refusal_reason, and actor_kind choice sets. "verdict"/"refusal_reason" are
        # generic field names a future model could reuse; pin to stable model-prefixed
        # names so drf-spectacular does not hash-disambiguate or rename them (same
        # regression class as ScopeChangeStatus — project_drf_enum_name_collision).
        "AgentActionVerdictEnum": "trueppm_api.apps.agents.models.AgentActionVerdict",
        "AgentActionRefusalReasonEnum": "trueppm_api.apps.agents.models.AgentActionRefusalReason",
        "AgentActorKindEnum": "trueppm_api.apps.agents.models.AgentActorKind",
        # ADR-0421 (#1850): the refusal side-car exposes a "constraint" choice set;
        # "constraint" is a generic field name, so pin it to a stable model-prefixed
        # component name (same rationale as the verdict/refusal_reason enums above).
        "RefusalConstraintEnum": "trueppm_api.apps.agents.models.RefusalConstraint",
    },
}
