# Architecture Overview

## System diagram

```
┌─────────────────────────────────────────────────────┐
│                   Clients                           │
│  React web (browser)  │  React Native (mobile)      │
└───────────┬───────────┴──────────────┬──────────────┘
            │ REST / WebSocket         │ REST (offline-first)
            ▼                          ▼
┌─────────────────────────────────────────────────────┐
│              Django ASGI (uvicorn)                  │
│                                                     │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │  DRF ViewSets│  │  Django Channels              │ │
│  │  REST API    │  │  WebSocket consumers          │ │
│  └──────┬───────┘  └──────────────┬───────────────┘ │
│         │                         │                 │
│  ┌──────▼─────────────────────────▼───────────────┐ │
│  │           PostgreSQL 16                        │ │
│  │  (ltree WBS hierarchy, GiST indexes)           │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌──────────────────────┐  ┌──────────────────────┐ │
│  │  Celery worker       │  │  Redis               │ │
│  │  CPM auto-scheduler  │◄─┤  broker + channel    │ │
│  │  (trueppm-scheduler) │  │  layer               │ │
│  └──────────────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Key design decisions

### API-first

Every feature is a REST or WebSocket endpoint before it is a UI element. The web and mobile clients have no privileged access — they are API consumers, identical to any third-party integration. The OpenAPI schema at `/api/schema/` is the authoritative contract.

### Mobile-first with offline support

The mobile client uses [WatermelonDB](https://watermelondb.dev/) as a local SQLite store. The sync endpoint (`GET /api/v1/projects/{pk}/sync/`) implements WatermelonDB's `synchronize()` protocol:

- `changes.{collection}.updated` — live rows modified since `since`
- `changes.{collection}.deleted` — tombstone IDs for soft-deleted rows
- `timestamp` — the high-water mark to use as `since` on the next pull

The server snapshots `max(server_version)` across all tables *before* running the delta queries, eliminating the TOCTOU gap where a write could land between the version-read and the row-queries.

### Scheduling as a separate package

The CPM and Monte Carlo engine lives in `packages/scheduler` (`trueppm-scheduler` on PyPI), completely independent of Django. This separation means:

- The engine can be used without the API (embedded in other tools, WASM compilation, etc.)
- The engine has its own test suite and release cycle
- Algorithmic correctness can be validated without a running database

The Celery worker imports `trueppm-scheduler` as a library. The `recalculate_schedule` task fetches the project's tasks and dependencies from PostgreSQL, calls `schedule()`, and writes the CPM output fields back.

### Versioned models and soft delete

Every synced model extends `VersionedModel`:

```python
class VersionedModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    server_version = models.BigIntegerField(default=0)
    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_version = models.BigIntegerField(null=True, blank=True)
```

`server_version` starts at 1 on INSERT and increments atomically on every UPDATE via a `F()` expression to avoid lost-update races. Deletes are soft: the row is retained with `is_deleted=True` so mobile clients receive a tombstone on the next sync pull.

### Real-time broadcasts

Every mutation in the API is followed by a `broadcast_board_event()` call deferred inside `transaction.on_commit()`. This ensures:

1. The broadcast only fires if the database transaction committed successfully
2. WebSocket clients receive the event as a push, not a poll

## Packages

### packages/scheduler

- Language: Python 3.12+
- Dependencies: `networkx` (graph traversal), `numpy` (Monte Carlo vectorisation)
- License: Apache 2.0

### packages/api

- Framework: Django 5.1 + Django REST Framework 3.15
- Real-time: Django Channels 4 (ASGI, Redis channel layer)
- Task queue: Celery 5.4
- Auth: django-allauth + simplejwt (JWT)
- Schema: drf-spectacular (OpenAPI 3.1)
- Database: PostgreSQL 16 with `ltree` extension for WBS hierarchy

### packages/helm

Helm 3 chart with Bitnami sub-charts for PostgreSQL and Redis. Separate `values-dev.yaml` and `values-prod.yaml` overlays. Non-root `trueppm` user in the API Dockerfile.

## OSS / Enterprise boundary

The community edition (`trueppm/trueppm`) must never import from `trueppm_enterprise`. The dependency is strictly one-way: enterprise → core. Extension points (URL patterns, Django settings includes, signal hooks) are stable interfaces that enterprise code registers against.

Verify the boundary is clean at any time:

```bash
grep -r "trueppm_enterprise" packages/
# must return zero results
```

Community features: scheduling engine, CPM, Monte Carlo, Gantt UI, mobile apps, offline sync, real-time, 5-role RBAC, REST/WS API, time tracking, baselines, Helm chart, MS Project import/export.

Enterprise features: portfolio analytics, SSO/SAML/OIDC, LDAP sync, immutable audit trail, custom roles, approval workflows, Jira/GitLab/ServiceNow connectors, AI scheduling, scenario modeling, multi-tenancy.
