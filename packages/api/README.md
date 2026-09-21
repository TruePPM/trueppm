# trueppm-api

[![PyPI version](https://img.shields.io/pypi/v/trueppm-api.svg)](https://pypi.org/project/trueppm-api/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-api.svg)](https://pypi.org/project/trueppm-api/)
[![CI](https://gitlab.com/trueppm/trueppm/badges/main/pipeline.svg)](https://gitlab.com/trueppm/trueppm/-/pipelines)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

Django REST + WebSocket backend for [TruePPM](https://trueppm.com) — projects, tasks,
critical-path scheduling, agile boards and sprints, offline sync, and real-time
collaboration.

## Is this package for you?

Most people should **not** `pip install` this directly. If you want to run TruePPM,
start from the [quickstart guide](https://docs.trueppm.com/getting-started/quickstart/)
(`docker compose up`) or the [Helm chart](https://gitlab.com/trueppm/trueppm/-/tree/main/packages/helm) —
both wire up PostgreSQL, Valkey, the web frontend, and a Celery worker for you.

This package exists on PyPI for two narrower audiences:

- **Downstream projects that depend on the OSS backend as a library** — most notably
  [TruePPM Enterprise](https://trueppm.com) (proprietary, separate repo), which pins an
  exact `trueppm-api` release instead of a git submodule or path dependency. See
  [Using this as a dependency](#using-this-as-a-dependency).
- **Operators who want to run the API standalone** — against Postgres/Valkey you
  already manage, without Docker Compose or the bundled frontend. See
  [Standalone quickstart](#standalone-quickstart).

If neither of those is you, the linked quickstart is a better starting point.

## Requirements

- **Python 3.11+**
- **PostgreSQL 16+**, with the `ltree`, `pg_trgm`, and `btree_gist` extensions
  installable by the connecting role (migrations run `CREATE EXTENSION IF NOT EXISTS`
  for each — the role needs `CREATEDB`/superuser on a fresh database, or ask your DBA
  to pre-create the extensions)
- **Valkey 8+** (or Redis 7+, wire-compatible) — backs the WebSocket channel layer and
  the Celery broker/result backend
- **A Celery worker**, if you want anything that runs off the request/response cycle:
  async schedule recalculation, notifications, MS Project/Jira/CSV import jobs. The
  API serves reads and writes without one, but background jobs will queue and never run.
- **S3-compatible object storage**, in production only, for task attachments. Local
  disk storage is the dev default and is explicitly refused at boot in
  `trueppm_api.settings.prod` unless you opt in (fine for local/single-node
  evaluation, not for anything you intend to keep).

## Install

```bash
# Development — precompiled psycopg wheel, no compiler or system libpq needed
pip install "trueppm-api[binary]"

# Production — links against the system libpq, so OS security patches reach
# the driver without a new release of this package
pip install "trueppm-api[c]"
```

Extras:

| Extra | Use it for |
|---|---|
| `binary` | Local dev / quick-start psycopg (precompiled wheel, bundles its own libpq) |
| `c` | Production psycopg (compiled against the system libpq) |
| `dev` | Test tooling (pytest, mypy, ruff, testcontainers) — installed from a source checkout, not by consumers |
| `fuzz` | Schemathesis, for OpenAPI-schema-driven fuzz testing — installed from a source checkout, not by consumers |

Pick one of `binary`/`c`. The base install already pulls plain `psycopg`, whose
pure-Python core binds to `libpq` via `ctypes` at runtime — that only works if a
system `libpq` is already installed and discoverable, so `binary` (bundles its
own) or `c` (links the one you installed) is the reliable path.

## Standalone quickstart

This runs the API by itself against Postgres/Valkey instances you already have —
no Docker Compose, no frontend. Five minutes if those two services are already up.

```bash
pip install "trueppm-api[binary]"

export DJANGO_SETTINGS_MODULE=trueppm_api.settings.dev
export TRUEPPM_ALLOW_DEV_SETTINGS=1  # dev settings refuse to import without this
export SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export DATABASE_URL="postgres://trueppm:trueppm@localhost:5432/trueppm"
export REDIS_URL="redis://localhost:6379"

django-admin migrate
django-admin createsuperuser
django-admin runserver 0.0.0.0:8000
```

Then:

- `http://localhost:8000/api/v1/health/` — liveness check, no auth
- `http://localhost:8000/api/docs/` — interactive Swagger UI (served from `[sidecar]`
  static assets, so it works offline / behind a strict CSP)
- `http://localhost:8000/admin/` — Django admin, using the superuser you just created

`trueppm_api.settings.dev` hardcodes `ALLOWED_HOSTS = ["*"]` and open (`AllowAny`)
API permissions, so it refuses to even import without `TRUEPPM_ALLOW_DEV_SETTINGS=1`
set (or a test runner active) — that guard is what the env var above satisfies.
**Do not use it past localhost.** For anything reachable over a network, switch to
`trueppm_api.settings.prod`, which enforces `ALLOWED_HOSTS`, a real `SECRET_KEY`,
and durable attachment storage at import time — it refuses to boot rather than
silently run insecure. `manage.py` (the entry point the full repo uses) is a thin
wrapper around `django-admin` that defaults `DJANGO_SETTINGS_MODULE` to
`trueppm_api.settings.dev`; installed via pip you use `django-admin` directly, as
above, and set the setting explicitly.

For the full experience — the React frontend, a Celery worker, WebSocket
broadcasts, seeded demo data — use the [Docker Compose
quickstart](https://docs.trueppm.com/getting-started/quickstart/) instead; it
runs this same package, wired up for you.

Every environment variable this package reads, including production-only ones
(object storage, OIDC single sign-on, OpenTelemetry, rate limits) is documented at
**[docs.trueppm.com/administration/configuration](https://docs.trueppm.com/administration/configuration/)**.
`SECRET_KEY`, `DATABASE_URL`, and `REDIS_URL` above are the only three with no safe
default outside of `trueppm_api.settings.dev`.

## Using this as a dependency

Pin an exact release the same way you'd pin any other PyPI package:

```toml
# pyproject.toml
[project]
dependencies = [
    "trueppm-api==0.4.0b3",
]
```

```bash
pip install "trueppm-api[c]==0.4.0b3"
```

`import trueppm_api; trueppm_api.__version__` reflects the installed distribution
version (read from package metadata, not a hand-maintained string), so it always
agrees with `pip show trueppm-api`.

`trueppm_api.settings.base` is written to be extended: a downstream project's own
settings module can do `from trueppm_api.settings.base import *` and layer
additional `INSTALLED_APPS`, middleware, or DRF settings on top, the same pattern
`trueppm_api.settings.prod` itself uses. This is how TruePPM Enterprise adds its
portfolio-governance apps without forking the OSS backend.

## Versioning and releases

**The version number tracks the whole TruePPM platform release, not this package
independently.** `0.4.0b3` on PyPI corresponds to git tag `v0.4.0-beta.3` in the
[trueppm-suite](https://gitlab.com/trueppm/trueppm) monorepo — the same release
that produced the `api`/`web` Docker images and the Helm chart at that version.
There is no separate changelog or release cadence for `trueppm-api` alone; see the
[root `CHANGELOG.md`](https://gitlab.com/trueppm/trueppm/-/blob/main/CHANGELOG.md)
for what changed in any given release.

Every `v*` tag publishes this package to PyPI automatically (CI job
`api:publish:pypi`), alongside the Docker images and the Helm chart. `@trueppm/web`
on npm is wired to the same tag (`web:publish:npm`) but is not live yet — see the
[root README's Published artifacts table](https://gitlab.com/trueppm/trueppm#published-artifacts)
for current status. As of #3943, this job authenticates via **PyPI Trusted
Publishing** (GitLab OIDC) and signs [PEP 740](https://peps.python.org/pep-0740/)
attestations, the same as `trueppm-scheduler` and `trueppm-mcp` — there is no
static upload token on the publish path. That release job is unproven until
the next `v*` tag, so versions through `0.4.0-beta.3` predate it and were
published with a static token, with no attestation. Pre-release versions (`aN`/`bN`/`rcN`) are real
releases of whatever that tag shipped, not throwaway snapshots — TruePPM is
pre-1.0 and ships its entire release line as alphas/betas/RCs, per
[SECURITY.md](https://gitlab.com/trueppm/trueppm/-/blob/main/SECURITY.md).

Before 1.0, breaking changes to this package's Python API (settings shape, model
fields, management commands) can happen between releases without a deprecation
window — the published contract that *is* stable pre-1.0 is the HTTP/WebSocket API
surface, documented at
[docs.trueppm.com/api/stability](https://docs.trueppm.com/api/stability/). If
you're pinning this package as a library dependency rather than talking to a
running instance over HTTP, expect to read the changelog on every bump.

## Documentation

- **Full docs**: [docs.trueppm.com](https://docs.trueppm.com)
- **API reference**: [docs.trueppm.com/api/reference](https://docs.trueppm.com/api/reference/)
- **Configuration reference**: [docs.trueppm.com/administration/configuration](https://docs.trueppm.com/administration/configuration/)
- **Source / issues**: [gitlab.com/trueppm/trueppm](https://gitlab.com/trueppm/trueppm)

## Tests

From a source checkout:

```bash
cd packages/api
pip install -e ".[binary,dev]"
pytest
```

Most tests need a real PostgreSQL (for `ltree`/`pg_trgm` queries) — the repo's
`docker compose up` provides one; `testcontainers[postgres]` (a `dev` extra) can
also spin one up ephemerally.

## License

Apache 2.0 — see [LICENSE](https://gitlab.com/trueppm/trueppm/-/blob/main/LICENSE).
Copyright MacroDream, LLC and contributors — see
[NOTICE](https://gitlab.com/trueppm/trueppm/-/blob/main/NOTICE).
