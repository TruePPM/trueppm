---
title: Configuration
description: Environment variables and settings for TruePPM.
---

All configuration is via environment variables. For local development, `docker-compose.yml` sets sensible defaults.

## Required in production

| Variable | Description | Example |
|----------|-------------|---------|
| `SECRET_KEY` | Django secret key. Use a long random string. | `$(python -c "import secrets; print(secrets.token_urlsafe(50))")` |
| `DATABASE_URL` | PostgreSQL connection string. | `postgres://trueppm:password@db:5432/trueppm` |
| `REDIS_URL` | Connection string for the Celery broker / Channels layer. TruePPM ships with [Valkey](https://valkey.io) (BSD-licensed Redis fork, wire-compatible); the `redis://` scheme works against either. | `redis://valkey:6379` |
| `DJANGO_SETTINGS_MODULE` | Settings module to load. | `trueppm_api.settings.prod` |
| `ALLOWED_HOSTS` | Comma-separated list of allowed hostnames. | `trueppm.example.com` |

## Default values (development only)

| Variable | Default |
|----------|---------|
| `SECRET_KEY` | `dev-secret-key-change-in-prod` |
| `DATABASE_URL` | `postgres://trueppm:trueppm@db:5432/trueppm` |
| `REDIS_URL` | `redis://valkey:6379` |
| `DJANGO_SETTINGS_MODULE` | `trueppm_api.settings.dev` |
| `ALLOWED_HOSTS` | `*` |

:::danger
Never use the default `SECRET_KEY` or `ALLOWED_HOSTS=*` in production. The default secret key is public — anyone who knows it can forge session cookies and JWTs.
:::

## Optional / advanced settings

| Variable | Default | Description |
|----------|---------|-------------|
| `TRUEPPM_EDITION` | `community` | Edition discriminator read by `/api/v1/edition/`. Set to `enterprise` in the enterprise Helm chart so the React shell can make the post-login redirect decision without importing enterprise code (ADR-0029). Never set this in an OSS deployment. |
| `HISTORY_RETENTION_DAYS` | `90` | How many days of object-change history to keep. Records older than this are purged nightly by Celery beat. To disable automatic purging, set the Django setting to `None` in a settings override or toggle the table off in the [Retention & purge](/administration/retention/) editor. **Do not set `0`** — a zero-day window makes the cutoff "now" and purges all rows on the next run. |
| `TASK_RUN_RETENTION_DAYS` | `30` | How many days of completed/failed/canceled Celery task-run records to keep before the nightly purge. To disable, set the Django setting to `None` in a settings override or toggle the table off in the [Retention & purge](/administration/retention/) editor. **Do not set `0`** — a zero-day window purges all rows on the next run. |
| `MSPROJECT_MAX_UPLOAD_MB` | `50` | Per-file size cap for MS Project (`.mpp` / `.xml`) imports, in megabytes. See [MS Project import limit](#ms-project-import-limit) below. |
| `VITE_FEATURE_FLAGS` | `{}` | Build-time JSON blob of feature flag overrides for the React frontend, e.g. `'{"schedule_build_mode_v1":true}'`. Set in `packages/web/.env` or `.env.production` before `npm run build`. Per-user `localStorage` overrides win over this default at runtime. |
| `INTEGRATION_ENCRYPTION_KEY` | _(empty)_ | Fernet key used to encrypt stored integration credentials (connected-account PATs). **Required once any user connects an account** — the app raises `ImproperlyConfigured` on first integration use if unset. Generate with `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. |
| `TRUEPPM_DEFAULT_FILE_STORAGE` | `django.core.files.storage.FileSystemStorage` | Backend for task-attachment storage. The local default is **ephemeral in a container** — uploads are lost on every pod restart. Point this at a persistent object-storage backend for production, e.g. `storages.backends.s3.S3Storage`. |
| `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE` | `false` | Operator opt-in to run production on the local `FileSystemStorage` default (e.g. when local disk is backed by a persistent volume). `prod` refuses to boot on local storage unless this is `true` or `TRUEPPM_DEFAULT_FILE_STORAGE` is set to a remote backend. |
| `CSRF_TRUSTED_ORIGINS` | _(empty)_ | Comma-separated origins (scheme included) trusted for cross-origin POST/CSRF. Required only for split-origin deploys where the web app and API are served from different hostnames, e.g. `https://app.example.com,https://api.example.com`. |
| `AUTH_REFRESH_COOKIE_SECURE` | `true` | Sets the `Secure` flag on the refresh-token cookie. The browser drops a `Secure` cookie over plain HTTP, so set `false` only on a non-HTTPS dev/preview host. The dev settings already default this to `false` for localhost. |
| `AUTH_REFRESH_COOKIE_SAMESITE` | `Strict` | `SameSite` policy for the refresh cookie. `Strict` blocks the cookie on any cross-site request. **Split-origin deploys must relax this** to `Lax` or `None` so the refresh request carries the cookie; `None` additionally requires `Secure` (HTTPS). See [split-origin notes](#split-origin-deploys). |
| `AUTH_REFRESH_COOKIE_NAME` | `trueppm_refresh` | Name of the refresh-token cookie. Override only to avoid a collision with another app on the same domain. |
| `AUTH_REFRESH_COOKIE_PATH` | `/api/v1/auth/token/refresh/` | Path the refresh cookie is scoped to. Override only if you reverse-proxy the API under a non-default base path. |
| `CSP_CONNECT_SRC` | `'self' wss:` | Space-separated `connect-src` sources for the Content-Security-Policy header — the origins the browser may open XHR / fetch / WebSocket connections to. **Split-origin deploys must add the API origin** (and its `wss://` origin) here, e.g. `'self' https://api.example.com wss://api.example.com`. See [split-origin notes](#split-origin-deploys). |
| `TRUEPPM_WEBHOOK_RETENTION_DAYS` | `7` | Days of webhook delivery records to keep before the nightly purge. See [Retention](/administration/retention/). |
| `TRUEPPM_EXPORT_RETENTION_DAYS` | `7` | Days of generated export artifacts to keep before purge. See [Retention](/administration/retention/). |
| `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` | `24` | Hours of processed offline-sync upload batches to keep before purge. See [Retention](/administration/retention/). |
| `RETENTION_PURGE_INFLIGHT_SECONDS` | `600` | Lock TTL (seconds) guarding against overlapping retention-purge runs. See [Retention](/administration/retention/). |
| `TRUEPPM_BEAT_STALE_SECONDS` | `120` | Age (seconds) after which the last Celery-beat heartbeat is considered stale by `/health/beat/`. See [Durability](/administration/durability/). |
| `TRUEPPM_RECURRENCE_HORIZON_DAYS` | `14` | Look-ahead window (days) for spawning recurring-task occurrences. See [Recurring tasks](/features/recurring-tasks/). |
| `SYNC_WATERMARK_USE_COLUMN` | `true` | Source for the offline-sync pull watermark. When `true`, the pull reads the denormalized `Project.last_sync_version` column. Set `false` to fall back to the slower 12-table `UNION ALL` watermark — a one-release escape hatch if a watermark-drift bug is found in production. The conformance test asserts the two sources agree, so the column source is safe by default. |
| `WORKFLOW_BACKEND` | `trueppm_api.workflows.backends.default.DefaultWorkflowBackend` | Dotted path to the `WorkflowBackend` implementation for the durable-execution engine. The OSS default composes the transactional outbox with Celery. Enterprise editions register an alternate backend (e.g. Temporal) by overriding this; do not change it in an OSS deployment. |
| `WORKFLOW_HISTORY_RETENTION_DAYS` | `30` | Days of `WorkflowHistoryEvent` records to keep before the nightly `workflows.purge_old_records` task purges them. Set the Django setting to `None` (or `0`) to disable history purging. |
| `WORKFLOW_DRAIN_BATCH_SIZE` | `200` | Maximum rows the workflow outbox/timer drains process per tick. Bounds the work per run so a large backlog (e.g. after a broker outage) cannot exceed the Celery task time limit — later ticks drain the remainder. |
| `WORKFLOW_PURGE_BATCH_SIZE` | `500` | Rows deleted per statement by the nightly workflow retention purge. The purge deletes in bounded chunks rather than one unbounded statement, so the first run on a mature install cannot hold a long lock over a large slice of the history/outbox tables. |
| `IDEMPOTENCY_RETENTION_HOURS` | `24` | Hours to retain stored `Idempotency-Key` responses, purged hourly by the Celery beat task. After expiry, a retry with the same key re-runs the mutation. Set the Django setting to `None` to disable automatic purging. |
| `IDEMPOTENCY_MAX_BODY_BYTES` | `1048576` | Maximum stored response body size, in bytes (1 MiB default). Responses larger than this are not stored — the claim row is dropped so a retry re-runs the mutation. Single-object mutation responses effectively never approach this limit. |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_HOST_USER` / … | _(Django default)_ | SMTP settings for notification and invite email. **Currently must be set via a Django settings override — dedicated env-var / Helm bindings are not yet wired**, so setting bare `EMAIL_HOST` env vars has no effect. See [Outbound email](/administration/email/). |

## MS Project import limit

[MS Project import](/features/msproject-import-export/) accepts `.mpp` and
`.xml` files. The per-file size cap is configurable:

| Variable | Default | Unit | What it bounds |
|----------|---------|------|----------------|
| `MSPROJECT_MAX_UPLOAD_MB` | `50` | MB | Maximum size of a single MS Project import upload |

This cap was raised from a previously hardcoded 10 MB. An import is read fully
into memory and stored base64-encoded in a single database row (about +33%), so
a 50 MB upload already costs roughly 67 MB of memory and row size — keep the
limit close to the practical MS Project file ceiling rather than maximizing it.

:::caution[Do not configure above the hard ceiling]
`MSPROJECT_MAX_UPLOAD_MB` must stay **at or below 100 MB**. The global Django
`DATA_UPLOAD_MAX_MEMORY_SIZE` (100 MB) and the operator-configured nginx
`client_max_body_size` are the hard edge cap — the shipped reference nginx
templates set `client_max_body_size 20M`, so the 50 MB import default is
unreachable until you raise it to at least your `MSPROJECT_MAX_UPLOAD_MB`. Set
both, and keep `MSPROJECT_MAX_UPLOAD_MB` under them. Setting it higher has no
effect: the larger request is rejected at the edge before the importer ever
sees it.
:::

```bash
# Allow MS Project imports up to 80 MB. Must stay <= 100 MB
# (DATA_UPLOAD_MAX_MEMORY_SIZE / nginx client_max_body_size).
MSPROJECT_MAX_UPLOAD_MB=80
```

Imported files are stored base64-encoded in an `ImportRequest` row only until
the import is processed, then purged on the schedule set by
`TRUEPPM_IMPORT_RETENTION_DAYS` (default 7 days). See
[Outbox & Record Retention](/administration/retention/) to tune that window.

## Monte Carlo simulation caps

The Community (OSS) tier bounds [Monte Carlo risk analysis](/features/monte-carlo/)
with three caps. Like the email settings above, these are **Django settings
constants, not environment variables** — override them in a Django settings
module; setting bare env vars of the same name has no effect. The Enterprise
edition raises or removes them.

| Setting | Default (OSS) | What it bounds |
|---------|---------------|----------------|
| `MC_SIMULATION_CAP` | `1000` | Maximum simulation runs (iterations) per request. The Monte Carlo run endpoint rejects an `n_simulations` above this. |
| `MC_TASK_CAP` | `5000` | Largest project — by task count — Monte Carlo will run on. The vectorized NumPy path handles 5000 tasks × 1000 runs in a few seconds; a larger project is refused rather than run unbounded. |
| `MC_HISTORY_CAP` | `100` | Forecast-history rows kept per project. The nightly purge trims each project to its newest `MC_HISTORY_CAP` `MonteCarloRun` rows. |

Set any cap to `None` for unlimited — the Enterprise default, where unbounded
forecast history plus cross-program rollup is part of the portfolio tier.
Operators on constrained hardware can lower `MC_TASK_CAP` to keep simulations
cheap.

```python
# settings override — raise the task ceiling for a large-project deployment.
MC_TASK_CAP = 10_000
```

## Split-origin deploys

A standard deploy serves the web app from the **same origin** as the API
(e.g. nginx routes `/` to the SPA and `/api` to Django on one hostname). The
secure defaults assume this and need no extra configuration.

A **split-origin** deploy serves the SPA from a different origin than the API —
for example `https://app.example.com` (SPA) and `https://api.example.com` (API).
Two security defaults are origin-aware and must be relaxed for the browser to
talk to the API:

| Setting | Why it must change | Set to |
|---------|--------------------|--------|
| `AUTH_REFRESH_COOKIE_SAMESITE` | The refresh cookie is `SameSite=Strict`, so the browser will not send it on the cross-origin refresh request, and sessions silently fail to renew. | `Lax` (or `None` if the SPA and API are on unrelated sites — `None` requires HTTPS, which the `Secure` flag already enforces). |
| `CSP_CONNECT_SRC` | The Content-Security-Policy `connect-src` defaults to `'self' wss:`. With the SPA on a different origin, the browser blocks XHR / WebSocket connections to the API origin. | `'self' https://api.example.com wss://api.example.com` — add the API origin and its `wss://` origin. |

Also set `CSRF_TRUSTED_ORIGINS` (above) for any split-origin deploy.

## First user setup

No manual steps are needed: the api container runs migrations and the `create_admin` bootstrap automatically on startup. Retrieve the generated admin password as described in [Admin password setup](/administration/admin-password/).

The admin user can then authenticate via the API and create projects. When a user creates a project, they automatically become its Owner.
