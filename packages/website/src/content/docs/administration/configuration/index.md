---
title: Configuration
description: Environment variables and settings for TruePPM.
documentedFor: "0.4"
---

This page is the reference for every environment variable and Django setting a
self-hosted TruePPM install reads — what it defaults to, what changing it does, and
when you would need to. Most self-hosters only ever touch the handful under
[Required in production](#required-in-production); the rest exist for the narrower
cases called out in each section (a split-network topology, a slower box, a stricter
security posture). All configuration is set via environment variables. For local
development, `docker-compose.yml` sets sensible defaults.

## In this section

- [Optional and advanced settings](/administration/configuration/advanced/) — optional and advanced environment variables, and the in-product feedback settings.
- [Rate limits and import caps](/administration/configuration/limits/) — aPI and login rate limiting, the MCP read-surface limits, and the size caps on MS Project, Jira, CSV/Excel and seed imports and on Monte Carlo runs.
- [Logging, telemetry and retention](/administration/configuration/logging-and-telemetry/) — log output, OpenTelemetry export, and data-retention settings.
- [Object storage, TLS and split-origin deploys](/administration/configuration/storage-and-networking/) — s3/MinIO object storage, the TLS redirect posture, and the settings for deploys that split the web and API origins.

## Required in production

| Variable | Description | Example |
|----------|-------------|---------|
| `SECRET_KEY` | Django secret key. Use a long random string. | `$(python -c "import secrets; print(secrets.token_urlsafe(50))")` |
| `DATABASE_URL` | PostgreSQL connection string. **Include `?sslmode=require`** — production refuses to boot on a URL without an `sslmode` parameter (the connection could otherwise fall back to unencrypted transport), unless you set `TRUEPPM_ALLOW_UNENCRYPTED_DB=true` because TLS is enforced at the network layer. | `postgres://trueppm:password@db:5432/trueppm?sslmode=require` |
| `REDIS_URL` | Connection string for the Celery broker / Channels layer / cache. TruePPM ships with [Valkey](https://valkey.io) (BSD-licensed Redis fork, wire-compatible); the `redis://` scheme works against either. Do not append a database index — TruePPM addresses four (`0`–`3`) and adds them itself. **Ignored when `TRUEPPM_VALKEY_SENTINELS` is set.** | `redis://valkey:6379` |
| `TRUEPPM_VALKEY_SENTINELS` | **Experimental** (0.4). Comma-separated `host:port` list of Valkey Sentinel nodes. Setting it to a non-empty value switches every consumer to Sentinel mode, replacing `REDIS_URL`. Not yet verified against a live quorum failover — validate in staging first. Use three or more so a quorum can authorize failover. See [Valkey HA](/administration/valkey-ha/#configuring-sentinel). | `s0:26379,s1:26379,s2:26379` |
| `TRUEPPM_VALKEY_MASTER_NAME` | The name the Sentinels monitor the primary under. **Required** whenever `TRUEPPM_VALKEY_SENTINELS` is set — the app refuses to boot without it. | `mymaster` |
| `TRUEPPM_VALKEY_PASSWORD` | Password for the Valkey **data** nodes in Sentinel mode. | `s3cret` |
| `TRUEPPM_VALKEY_SENTINEL_PASSWORD` | Password for the **Sentinel** nodes themselves, when it differs from the data-node password. | `s3ntinel` |
| `TRUEPPM_VALKEY_USE_TLS` | Use TLS to the Valkey data nodes in Sentinel mode. | `false` |
| `DJANGO_SETTINGS_MODULE` | Settings module to load. | `trueppm_api.settings.prod` |
| `ALLOWED_HOSTS` | Comma-separated list of allowed hostnames. Must include every name a request arrives under, not just your public one — see [Host names you must include](#host-names-you-must-include). | `trueppm.example.com,localhost,127.0.0.1` |
| `INTEGRATION_ENCRYPTION_KEY` | Fernet key that encrypts stored integration credentials (connected-account PATs) at rest. **Production refuses to boot if this is empty** — the guard runs at settings-import time, so a missing key crash-loops the deploy rather than failing later. | `$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")` |
| Attachment storage | Pick one: set `TRUEPPM_DEFAULT_FILE_STORAGE` to a persistent object-storage backend **and** `TRUEPPM_S3_BUCKET_NAME` to its bucket, **or** set `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` **and give `TRUEPPM_MEDIA_ROOT` a writable volume**. **Production refuses to boot on the ephemeral local default** otherwise, and from 0.4 it also refuses the local opt-in when that path is not writable (see [object storage](/administration/configuration/storage-and-networking/#object-storage-s3--minio) for the full variable set). | `storages.backends.s3.S3Storage` |

## Default values (development only)

| Variable | Default |
|----------|---------|
| `SECRET_KEY` | `django-insecure-change-me-in-prod` |
| `DATABASE_URL` | `postgres://trueppm:trueppm@db:5432/trueppm` |
| `REDIS_URL` | `redis://redis:6379` |
| `DJANGO_SETTINGS_MODULE` | `trueppm_api.settings.dev` |
| `ALLOWED_HOSTS` | `*` |

These are the defaults in `settings/base.py` — the values that apply when the
variable is unset. They are **not** the values `docker-compose.yml` sets, and
this table used to quote the compose file for `SECRET_KEY` and `REDIS_URL`
instead: it listed `dev-secret-key-change-in-prod` and `redis://valkey:6379`,
neither of which any code path produces. An operator grepping their
configuration for the documented string found nothing and could reasonably
conclude they had already replaced it.

The `SECRET_KEY` default's `django-insecure-` prefix matters: it is exactly what
`validate_secret_key` rejects, so production refuses to boot on it rather than
running with a key published in this repository. The compose files set their own
values on top; check what your deployment actually passes, not what this table
says is the fallback.

:::danger
Never use the default `SECRET_KEY` or `ALLOWED_HOSTS=*` in production. The default secret key is public — anyone who knows it can forge session cookies and JWTs.
:::

### `TRUEPPM_ALLOW_DEV_SETTINGS` — the one variable that disables authentication

| Variable | Default | What it does |
|----------|---------|--------------|
| `TRUEPPM_ALLOW_DEV_SETTINGS` | _(unset)_ | Set to `1` to permit `trueppm_api.settings.dev` to load outside a test runner. **Never set this on any instance reachable by anyone but you.** |

`settings.dev` sets DRF's `DEFAULT_PERMISSION_CLASSES` to `AllowAny`,
`ALLOWED_HOSTS` to `["*"]`, `DEBUG = True`, and a hardcoded integration
encryption key. Loading it is not "development mode" — it removes
authentication from **every** endpoint instance-wide.

The module refuses to import unless one of four things is true: pytest is
running, `pytest` or `mypy` is already imported, or `TRUEPPM_ALLOW_DEV_SETTINGS=1`
is set. That guard is fail-closed and the default state is safe — an
unconfigured container cannot load dev settings by accident. This variable is
the only way to override it, which is exactly why it is documented here:

- **Do not put it in a Helm values file, a Kubernetes Secret, a ConfigMap, or a
  `.env` used by anything other than your workstation.** It has no legitimate
  production use.
- **Alarm on it.** If your configuration management or admission control can
  reject a manifest containing this key, do that.
- The safe way to run a local instance is `DJANGO_SETTINGS_MODULE=trueppm_api.settings.dev`
  in the dev compose stack, which sets it for you and binds to localhost.

Setting it does not by itself load dev settings — `DJANGO_SETTINGS_MODULE` still
has to name the dev module. It removes the interlock that would otherwise stop
that combination.

### Host names you must include

Django validates the `Host` header in `get_host()`, before any view runs, and
returns **400 DisallowedHost** on a miss. The response does not mention
`ALLOWED_HOSTS`, so the symptom looks like a proxy or ingress fault rather than a
configuration one.

Your public hostname is rarely the only name in play:

| Caller | `Host` it sends | Applies to |
|---|---|---|
| Browsers and API clients | your public hostname | every deployment |
| The api container's healthcheck | `localhost` | Docker Compose — `docker-compose.prod.yml` curls `http://localhost:8000/api/v1/health/` |
| kubelet liveness/readiness probes | the pod IP, unless a `Host` header is set | Kubernetes |
| The `helm test` connection probe | `<release>-trueppm-api` | Kubernetes |
| A `kubectl port-forward` browser session | `localhost` | Kubernetes — the only route in when `ingress.enabled: false`, the chart default |

On **Compose**, omit `localhost` and the api container reports `unhealthy`
forever while the site itself serves correctly — nginx passes `Host $host`, so
real traffic is unaffected and only the healthcheck fails.

On **Kubernetes**, the chart sets an explicit `Host` header on both probes,
resolved from `ingress.hosts[0].host` when `ingress.enabled: true` and otherwise
from the api Service name `<release>-trueppm-api`, and overridable with
`probes.api.hostHeader`. That value must appear in `ALLOWED_HOSTS`. If it does
not, `/readyz` returns 400, no pod becomes Ready, the Service has no endpoints,
and the Ingress serves 503.

Because `ingress.enabled` defaults to **false**, the default install sends
`<release>-trueppm-api` on both probes — the same name the `helm test` row above
already requires. One entry covers all three of those callers, but not the
port-forward session below, which sends a different name.

Also on **Kubernetes**, `NOTES.txt` prints a `kubectl port-forward` command
after every install without an Ingress — which is the default. The web tier's
nginx proxies `/api/` with `proxy_set_header Host $host`, so a browser on
`http://localhost:8080` makes Django see `Host: localhost`. Omit `localhost` and
the failure is deceptively partial: the SPA document and its JS bundles load
fine, because nginx serves them off disk and never touches Django, while every
`/api/v1/...` call returns 400. The app renders and then appears broken, with
nothing naming the cause.

`<release>-trueppm-api` collapses to `trueppm-api` **only** when the release name
already contains "trueppm". `helm install ppm ...` produces `ppm-trueppm-api` —
list the name your own release actually generates.

Wildcards are not a fix. `ALLOWED_HOSTS=*` disables host validation entirely and
is never appropriate in production — list the names instead.

`ALLOWED_HOSTS` is the only bound on the host TruePPM reports, and therefore on
the absolute URLs it builds. TruePPM does **not** trust `X-Forwarded-Host` — your
edge must preserve the original `Host` — so this list is what an operator
controls. See
[The scheme comes from the proxy; the host does not](/administration/networking/#tls).

## Variables that are not operator settings

Read from the environment but **not** configuration knobs. Listed so a grep of
`packages/api/src` does not leave you wondering what you missed.

| Variable | What it is |
|----------|-----------|
| `TRUEPPM_ALLOW_DEV_SETTINGS` | The override on the guard that stops `settings.dev` loading anywhere. It disables authentication instance-wide — see the dev-settings section above. |
| `PYTEST_CURRENT_TEST` | Set by pytest itself; read only to detect that a test runner is active. |
| `TRUEPPM_TEST_DB` / `TRUEPPM_TEST_DB_TEMPLATE` | Per-worktree test-database isolation and the CI template-DB prewarm. Development and CI only. |
| `DJANGO_SUPERUSER_USERNAME` / `DJANGO_SUPERUSER_PASSWORD` | Django's own `createsuperuser` variables, honored by `create_admin`. Prefer the generated password file — see [Admin password setup](/administration/admin-password/). |
| `SSO_KEYCLOAK_*` / `SSO_ADMIN_EMAIL` | Inputs to `seed_sso_keycloak`, a local-development fixture command. Not read by the running application. |
| `INTEGRATION_USER_EMAIL` | Input to `seed_integration_fixtures`, likewise a development fixture command. |

## First user setup

No manual steps are needed: the api container runs migrations and the `create_admin` bootstrap automatically on startup. Retrieve the generated admin password as described in [Admin password setup](/administration/admin-password/).

The admin user can then authenticate via the API and create projects. When a user creates a project, they automatically become its Owner.
