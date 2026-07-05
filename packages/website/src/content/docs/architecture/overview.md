---
title: Architecture Overview
description: System diagram, design decisions, and package structure.
---

This page describes the architecture of TruePPM as it exists today. The scheduling engine, API, real-time layer, web frontend, and the 0.2 settings/administration and program platform are all functional as of 0.2 — shipped as the `0.2.0-alpha.1` pre-release (May 31, 2026).

## System diagram

```mermaid
flowchart LR
    client["React web + mobile<br/>(API clients)"]

    subgraph asgi["Django ASGI process (uvicorn)"]
        direction TB
        drf["DRF ViewSets<br/>REST API"]
        channels["Django Channels<br/>WebSocket consumers"]
    end

    worker["Celery worker<br/>CPM auto-scheduler"]

    pg[("PostgreSQL 16")]
    valkey[("Valkey")]

    client -->|REST| drf
    client <-->|WebSocket| channels

    drf --> pg
    channels --> pg
    worker --> pg

    drf -. enqueue .-> valkey
    valkey -. task .-> worker
    worker -. publish .-> valkey
    valkey -. broadcast .-> channels
```

**How to read it.** Solid arrows are direct **PostgreSQL** reads and writes;
dotted arrows are asynchronous messages passed through **Valkey**, which is both
the Celery broker and the Django Channels layer. **PostgreSQL** stores every
project, task, and the WBS hierarchy as an `ltree` column with a GiST index for
subtree and ancestor queries.

Follow a schedule change end to end: a write through a **DRF ViewSet** enqueues
a reschedule on the Valkey broker; the **Celery worker** runs the CPM engine,
writes the new dates to PostgreSQL, and publishes the result back through
Valkey; **Django Channels** picks that up off the channel layer and fans it out
to every connected client over its **WebSocket**.

## Key design decisions

### API-first

Every feature is a REST or WebSocket endpoint before it is a UI element. Web and mobile clients have no privileged access — they are API consumers identical to any third-party integration. The OpenAPI schema at `/api/schema/` is the authoritative contract.

### Computed, not guessed

_The AI-native foundation._ Every incumbent is bolting an LLM onto a project database and letting the model
guess dates. TruePPM takes the opposite stance, and it has a name: **computed,
not guessed.** An AI-surfaced answer is never the language model's opinion — it is
a CPM or Monte Carlo computation the engine performed, carrying a server-side
derivation you can cite. The model's only job is to translate a question into an
engine call and to phrase the engine's answer back in natural language. It never
supplies the number.

This is an architectural commitment, not a feature toggle. It is why the
scheduling engine is a [separate, deterministic package](#scheduling-as-a-separate-package)
and why [every feature is an API fact first](#api-first): if a value is computed
server-side and reachable over the API, an agent can retrieve it and cite it; if
it lived only in a chat prompt, the agent could only guess at it.

```
Incumbent — the LLM is the answer:

    question ─▶ LLM ─▶ asserted answer
                       (a plausible guess; no derivation to check)


TruePPM — the engine is the answer: "computed, not guessed"

    question ─▶ NL layer ─▶ engine call ─▶ provenance-carrying answer
                (translates   (CPM / Monte    ("P80 is Oct 22, derived from
                 to a call)    Carlo computes)  this critical chain" — citable)
```

The principle is sequenced across the roadmap as one body of work, not four
scattered AI bullets — see the [roadmap](/overview/roadmap/):

- **Provenance graph** (#1058) — every computed date, float, and P80 will carry
  the derivation an agent can cite, so an answer is explainable, not asserted.
  This is the first piece and it lands with the 0.4 read-only
  [MCP server](/features/mcp-server/).
- **Natural-language query layer** (#1060 #1061, planned for 0.5) — will compile a
  question into engine calls, never into an answer; the model translates, the
  engine answers.
- **Safe agent writes** (#1062–#1064, planned for 0.6) — an engine-as-referee will
  reject any agent write that would create an impossible schedule; this is the
  write side of the same principle.
- **Reproducible answers** (#1065, planned for 0.9) — a computed response will
  carry an engine-version and input hash so the number can be re-run and audited
  later.

The AI-native foundation is unshipped; the first piece (provenance) is targeted at
the 0.4 beta. The dates above are targets, not commitments — the
[roadmap](/overview/roadmap/) is the source of record for what has shipped versus
what is planned.

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

React 19 + TypeScript + Vite 6. Tailwind CSS with Design System v1.0 tokens (WCAG 2.1 AA). TanStack Query for server state, Zustand for client state, React Router v7. The Schedule view (Gantt-style) uses a purpose-built canvas renderer in `src/features/schedule/engine/` (no third-party Gantt library). The application shell, Schedule, Board, Sprints, and supporting views are wired against the live API.

### packages/api

Django 5.2 + DRF 3.15. Django Channels 4 (ASGI). Celery 5.4 + Valkey (BSD-licensed Redis fork; wire-compatible). django-allauth + simplejwt. drf-spectacular (OpenAPI 3.0.3). PostgreSQL 16 with `ltree` for WBS hierarchy.

### packages/website

This Astro Starlight site. Built with `npx astro build`; deploys to GitLab Pages.

### packages/helm

Helm 3 chart with vendored first-party sub-charts for PostgreSQL and Valkey (under `packages/helm/charts/`, using the official `postgres` and `valkey/valkey` images). Separate `values-dev.yaml` and `values-prod.yaml` overlays.

## OSS / Enterprise boundary

The community edition must never import from `trueppm_enterprise`. The dependency is strictly one-way: enterprise → core.

```bash
# Verify the boundary is clean
grep -r "trueppm_enterprise" packages/
# must return zero results
```

**Community:** scheduling engine, CPM, Monte Carlo, Schedule (Gantt-style) UI, Board, Sprints workspace, program management (coordinating multiple projects within a program), baseline comparison, offline sync, real-time, 5-role RBAC, REST/WS API, Helm chart, MS Project import/export. On the Community roadmap but not yet shipped: basic single sign-on (OIDC/OAuth login against your own identity provider) and the mobile apps land in 0.4, time tracking in 0.5.

**Enterprise (separate repo):** portfolio analytics and health scores, cross-program resource leveling, org identity governance (SAML 2.0 federation, SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO), immutable audit trail, custom roles, approval workflows, the org-wide Jira/GitLab/ServiceNow integration hub, AI scheduling, scenario modeling, multi-tenancy.

The OSS unit is the **program** (one PM, one or more related projects). The Enterprise unit is the **portfolio** (multiple programs under organizational governance).
