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
| `REDIS_URL` | Redis connection string. Used for Celery and Channels. | `redis://redis:6379` |
| `DJANGO_SETTINGS_MODULE` | Settings module to load. | `trueppm_api.settings.prod` |
| `ALLOWED_HOSTS` | Comma-separated list of allowed hostnames. | `trueppm.example.com` |

## Default values (development only)

| Variable | Default |
|----------|---------|
| `SECRET_KEY` | `dev-secret-key-change-in-prod` |
| `DATABASE_URL` | `postgres://trueppm:trueppm@db:5432/trueppm` |
| `REDIS_URL` | `redis://redis:6379` |
| `DJANGO_SETTINGS_MODULE` | `trueppm_api.settings.dev` |
| `ALLOWED_HOSTS` | `*` |

:::danger
Never use the default `SECRET_KEY` or `ALLOWED_HOSTS=*` in production. The default secret key is public — anyone who knows it can forge session cookies and JWTs.
:::

## First user setup

After starting the stack and running migrations:

```bash
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
```

The superuser can then authenticate via the API and create projects. When a user creates a project, they automatically become its Owner.
