---
id: overview
title: Architecture Overview
sidebar_position: 1
---

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

Every feature is a REST or WebSocket endpoint before it is a UI element. Web and mobile clients have no privileged access — they are API consumers identical to any third-party integration. The OpenAPI schema at `/api/schema/` is the authoritative contract.

### Mobile-first with offline support

The mobile client uses [WatermelonDB](https://watermelondb.dev/) as a local SQLite store. The sync endpoint (`GET /api/v1/projects/{pk}/sync/`) implements WatermelonDB's `synchronize()` protocol — see [Offline Sync](../features/offline-sync.md) for details.

### Scheduling as a separate package

The CPM and Monte Carlo engine lives in `packages/scheduler` (`trueppm-scheduler` on PyPI), completely independent of Django. This means:

- The engine can be used without the API (embedded in other tools, WASM compilation for on-device scheduling)
- The engine has its own test suite and release cycle
- Algorithmic correctness can be validated without a running database

The Celery worker imports `trueppm-scheduler` as a library, fetches project data from PostgreSQL, calls `schedule()`, and writes CPM output fields back.

### Versioned models and soft delete

Every synced model extends `VersionedModel`:

```python
class VersionedModel(models.Model):
    id             = models.UUIDField(primary_key=True, default=uuid.uuid4)
    server_version = models.BigIntegerField(default=0)
    is_deleted     = models.BooleanField(default=False, db_index=True)
    deleted_version= models.BigIntegerField(null=True, blank=True)
```

`server_version` starts at 1 on INSERT and increments atomically on every UPDATE via an `F()` expression to avoid lost-update races. Deletes are soft: the row is retained with `is_deleted=True` so mobile clients receive a tombstone on the next sync pull.

### Real-time broadcasts

Every mutation is followed by a `broadcast_board_event()` call deferred inside `transaction.on_commit()`. This ensures:

1. The broadcast only fires if the database transaction committed successfully
2. WebSocket clients receive the event as a push, not a poll

## Packages

### Scheduler (repo root — `src/trueppm_scheduler`)
Pure-Python. Dependencies: `networkx` (graph), `numpy` (Monte Carlo). Ships on PyPI as `trueppm-scheduler`. Lives at the repository root to allow Vite/WASM compilation targets in the future without restructuring.

### packages/web
React 19 + TypeScript + Vite 6. Tailwind CSS with Design System v1.0 tokens (WCAG 2.1 AA). TanStack Query for server state, Zustand for client state, React Router v7. The Gantt view uses SVAR React Gantt (MIT). Currently wired to fixture data; API hooks will be wired in subsequent milestones.

### packages/api
Django 5.1 + DRF 3.15. Django Channels 4 (ASGI). Celery 5.4 + Redis. django-allauth + simplejwt. drf-spectacular (OpenAPI 3.1). PostgreSQL 16 with `ltree` for WBS hierarchy.

### packages/website
This Docusaurus site. Deployed to GitLab Pages.

### packages/helm
Helm 3 chart with Bitnami sub-charts for PostgreSQL and Redis. Separate `values-dev.yaml` and `values-prod.yaml` overlays.

## OSS / Enterprise boundary

The community edition must never import from `trueppm_enterprise`. The dependency is strictly one-way: enterprise → core.

```bash
# Verify the boundary is clean
grep -r "trueppm_enterprise" packages/
# must return zero results
```

**Community:** scheduling engine, CPM, Monte Carlo, Gantt UI, mobile apps, offline sync, real-time, 5-role RBAC, REST/WS API, time tracking, baselines, Helm chart, MS Project import/export.

**Enterprise (separate repo):** portfolio analytics, SSO/SAML/OIDC, LDAP sync, immutable audit trail, custom roles, approval workflows, Jira/GitLab/ServiceNow connectors, AI scheduling, scenario modeling, multi-tenancy.
