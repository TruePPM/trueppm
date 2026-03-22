# TruePPM

Open-core Project, Program, and Portfolio Management (P3M) platform.

- **Community edition** — Apache 2.0, this repo
- **Enterprise edition** — proprietary, `trueppm/trueppm-enterprise`

## What's here

```
trueppm-suite/
├── packages/
│   ├── scheduler/   # CPM + Monte Carlo engine (pip: trueppm-scheduler)
│   ├── api/         # Django 5.1 REST + Channels backend
│   ├── helm/        # Helm 3 chart for Kubernetes deployment
│   └── web/         # React 19 + TypeScript frontend (coming soon)
├── docs/            # ADRs, design system
└── docker-compose.yml
```

### packages/scheduler

Pure-Python scheduling engine. No Django dependency — ships independently on PyPI.

- Forward/backward CPM pass with all four dependency types (FS, SS, FF, SF)
- Calendar-aware working-day arithmetic (weekend skip + holiday exceptions)
- Monte Carlo simulation via PERT-Beta distributions (numpy-vectorised, ~10k runs/sec)
- CLI: `trueppm-scheduler schedule` / `trueppm-scheduler monte-carlo`

### packages/api

Django 5.1 backend.

- REST CRUD for calendars, projects, tasks, dependencies, resources, task-resources
- 5-role RBAC: Owner / Admin / Scheduler / Member / Viewer, enforced per-endpoint
- Auto-scheduling: Celery task recalculates CPM on every task/dependency write (idempotent Redis lock)
- Real-time: Django Channels 4 WebSocket per project, JWT auth, role-gated
- Offline sync: `GET /api/v1/projects/{pk}/sync/?since={version}` — WatermelonDB-compatible delta protocol with soft-delete tombstones
- OpenAPI 3.1 schema at `/api/schema/`

## Quickstart (Docker Compose)

```bash
git clone git@gitlab.com:trueppm/trueppm.git
cd trueppm
docker compose up -d
```

| Service        | URL                        |
|----------------|----------------------------|
| API            | http://localhost:8000      |
| API schema     | http://localhost:8000/api/schema/ |
| PostgreSQL     | localhost:5432             |
| Redis          | localhost:6379             |

Apply migrations and create a superuser:

```bash
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
```

## Development

### Scheduler

```bash
pip install -e ".[dev]"
pytest                          # run tests
ruff check src/ tests/          # lint
ruff format src/ tests/         # format
mypy                            # type-check
```

### API

```bash
pip install -e "packages/api[dev]"
cd packages/api

pytest                          # runs against testcontainers PostgreSQL
ruff check src/                 # lint
ruff format src/                # format
mypy src/trueppm_api            # type-check (strict)
python manage.py makemigrations --check --dry-run  # migration check
```

Tests require Docker (testcontainers spins up PostgreSQL automatically). In CI, `DATABASE_URL` is set via service containers instead.

### Helm

```bash
helm lint packages/helm
```

## Environment variables (API)

| Variable                  | Default (dev)                                    | Required in prod |
|---------------------------|--------------------------------------------------|------------------|
| `SECRET_KEY`              | `dev-secret-key-change-in-prod`                  | Yes              |
| `DATABASE_URL`            | `postgres://trueppm:trueppm@db:5432/trueppm`     | Yes              |
| `REDIS_URL`               | `redis://redis:6379`                             | Yes              |
| `DJANGO_SETTINGS_MODULE`  | `trueppm_api.settings.dev`                       | Yes              |
| `ALLOWED_HOSTS`           | `*` (dev)                                        | Yes              |

## CI

GitLab CI (`.gitlab-ci.yml`). Jobs per push:

| Job                    | What it checks                                  |
|------------------------|-------------------------------------------------|
| `scheduler:lint`       | ruff check                                      |
| `scheduler:type-check` | mypy                                            |
| `scheduler:test`       | pytest (coverage ≥ 80%)                         |
| `api:lint`             | ruff check                                      |
| `api:type-check`       | mypy --strict                                   |
| `api:migration-check`  | makemigrations --check                          |
| `api:openapi-check`    | drf-spectacular schema generation               |
| `api:test`             | pytest with PostgreSQL + Redis (coverage ≥ 65%) |
| `helm:lint`            | helm lint                                       |
| `license:check`        | pip-licenses (Apache 2.0 compatible only)       |
| `security:bandit`      | bandit static analysis                          |
| `security:pip-audit`   | pip-audit CVE scan                              |
| `changelog:check`      | CHANGELOG.md [Unreleased] section present (MR)  |

## Contributing

1. Branch from `main`: `git checkout -b feat/<short-description>`
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.)
3. Update `CHANGELOG.md` `[Unreleased]` section before opening an MR
4. All MRs require a green pipeline before merge

See `CLAUDE.md` for the full developer guide (AI-assisted workflows, two-repo rules, OSS/Enterprise boundary).

## License

Apache 2.0 — see [LICENSE](LICENSE).

Enterprise features (portfolio analytics, SSO/SAML, audit trail, cross-project resource leveling, AI scheduling) are proprietary and live in a separate repository.
