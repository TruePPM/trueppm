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
| `HISTORY_RETENTION_DAYS` | `90` | How many days of object-change history to keep. Records older than this are purged nightly by Celery beat. Set to `0` to disable automatic purging entirely (enterprise unlimited-retention tier does this). |
| `TASK_RUN_RETENTION_DAYS` | `30` | How many days of completed/failed/cancelled Celery task-run records to keep before the nightly purge. Set to `0` to disable. |
| `VITE_FEATURE_FLAGS` | `{}` | Build-time JSON blob of feature flag overrides for the React frontend, e.g. `'{"schedule_build_mode_v1":true}'`. Set in `packages/web/.env` or `.env.production` before `npm run build`. Per-user `localStorage` overrides win over this default at runtime. |

## First user setup

After starting the stack and running migrations:

```bash
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
```

The superuser can then authenticate via the API and create projects. When a user creates a project, they automatically become its Owner.
