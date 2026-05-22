---
title: Architecture Overview
description: System diagram, design decisions, and package structure.
---

This page describes the architecture of TruePPM as it exists today. The scheduling engine, API, real-time layer, and web frontend are all functional as of 0.1 (May 2026).

## System diagram

```
┌─────────────────────────────────────────────────────┐
│                   Clients                           │
│         React web (browser)                         │
└───────────────────────┬─────────────────────────────┘
                        │ REST / WebSocket
                        ▼
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
│  │  Celery worker       │  │  Valkey              │ │
│  │  CPM auto-scheduler  │◄─┤  broker + channel    │ │
│  │  (trueppm-scheduler) │  │  layer (Redis-compat)│ │
│  └──────────────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Key design decisions

### API-first

Every feature is a REST or WebSocket endpoint before it is a UI element. Web and mobile clients have no privileged access — they are API consumers identical to any third-party integration. The OpenAPI schema at `/api/schema/` is the authoritative contract.

### Offline-first sync protocol

The API exposes a WatermelonDB-compatible sync endpoint (`GET /api/v1/projects/{pk}/sync/`) returning `changes` and `deleted` arrays keyed by `server_version`. This is designed for future mobile and PWA clients — see [Offline Sync](/features/offline-sync/) for details.

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

### packages/scheduler
Pure-Python. Dependencies: `networkx` (graph), `numpy` (Monte Carlo). Ships on PyPI as `trueppm-scheduler`.

### packages/web
React 19 + TypeScript + Vite 6. Tailwind CSS with Design System v1.0 tokens (WCAG 2.1 AA). TanStack Query for server state, Zustand for client state, React Router v7. The Schedule view (Gantt-style) uses a purpose-built canvas renderer in `src/features/schedule/engine/` (no third-party Gantt library; see ADR-0040 for the rationale). The application shell, Schedule, Board, Sprints, and supporting views are wired against the live API.

### packages/api
Django 5.1 + DRF 3.15. Django Channels 4 (ASGI). Celery 5.4 + Valkey (BSD-licensed Redis fork; wire-compatible). django-allauth + simplejwt. drf-spectacular (OpenAPI 3.1). PostgreSQL 16 with `ltree` for WBS hierarchy.

### packages/website
This Astro Starlight site. Built with `npx astro build`; deploys to GitLab Pages.

### packages/helm
Helm 3 chart with Bitnami sub-charts for PostgreSQL and Valkey. Separate `values-dev.yaml` and `values-prod.yaml` overlays.

## OSS / Enterprise boundary

The community edition must never import from `trueppm_enterprise`. The dependency is strictly one-way: enterprise → core.

```bash
# Verify the boundary is clean
grep -r "trueppm_enterprise" packages/
# must return zero results
```

**Community:** scheduling engine, CPM, Monte Carlo, Schedule (Gantt-style) UI, Board, Sprints workspace, program management (coordinating multiple projects within a program), mobile apps, offline sync, real-time, 5-role RBAC, REST/WS API, time tracking, baselines, Helm chart, MS Project import/export.

**Enterprise (separate repo):** portfolio analytics and health scores, cross-program resource leveling, SSO/SAML/OIDC, LDAP sync, immutable audit trail, custom roles, approval workflows, Jira/GitLab/ServiceNow connectors, AI scheduling, scenario modeling, multi-tenancy.

The OSS unit is the **program** (one PM, one or more related projects). The Enterprise unit is the **portfolio** (multiple programs under organizational governance).
