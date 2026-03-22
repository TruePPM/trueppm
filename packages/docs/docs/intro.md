---
id: intro
title: TruePPM
slug: /
sidebar_position: 1
---

TruePPM is an open-core Project, Program, and Portfolio Management (P3M) platform built for teams that need reliable schedule control.

The community edition (Apache 2.0) includes:

- **CPM scheduling engine** — forward/backward pass, all four dependency types (FS, SS, FF, SF), calendar-aware lag, float and critical-path identification
- **Monte Carlo simulation** — PERT-Beta distributions, P50/P80/P95 completion dates, 10k runs on a 200-task chain in under 5 seconds
- **REST API** — Django 5.1, full CRUD for projects, tasks, dependencies, resources, calendars
- **5-role RBAC** — Owner / Admin / Scheduler / Member / Viewer, enforced per endpoint and per object
- **Real-time collaboration** — WebSocket broadcasts via Django Channels; every mutation is pushed to connected clients
- **Offline-first mobile sync** — WatermelonDB-compatible delta protocol; soft-delete tombstones; TOCTOU-safe version snapshotting
- **Auto-scheduling** — CPM recalculated automatically on every task or dependency write via Celery

## Repository layout

```
trueppm-suite/
├── packages/
│   ├── scheduler/   # Pure-Python CPM + Monte Carlo engine (pip: trueppm-scheduler)
│   ├── api/         # Django REST + Channels backend
│   ├── docs/        # This site
│   ├── helm/        # Helm 3 chart for Kubernetes
│   └── web/         # React 19 frontend (coming soon)
└── docker-compose.yml
```

## Next steps

- [Installation](getting-started/installation.md) — set up a local development environment
- [Quickstart](getting-started/quickstart.md) — create your first project via the API
- [Architecture](architecture/overview.md) — understand how the pieces fit together
