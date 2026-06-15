---
title: License & Third-Party Attribution
description: TruePPM Community Edition is Apache 2.0. Here is the license, the enterprise boundary, and the CI-enforced policy that keeps every dependency permissively licensed.
sidebar:
  order: 100
---

This page exists so you can adopt TruePPM Community Edition with confidence. It tells you the license you are agreeing to, why no proprietary code is hiding in the open-source repository, and how the dependency licenses are mechanically verified on every build — not just promised.

:::tip[Community Edition is Apache License 2.0]
TruePPM's open-source Community Edition is licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) — an OSI-approved permissive license. You may use it commercially, modify it, redistribute it, and run it privately. Apache 2.0 also includes an **explicit patent grant** from contributors, so adopting TruePPM does not expose you to a contributor's patent claims over the code they contributed.
:::

The authoritative text is the [`LICENSE`](https://gitlab.com/trueppm/trueppm/-/blob/main/LICENSE) file at the repository root. If anything on this page ever disagrees with that file, the file wins.

## What "Community Edition" includes

Everything a project manager and their team need to run a program is in the Apache 2.0 Community Edition: the scheduling engine (CPM, Monte Carlo), the schedule view, Kanban boards and sprints, real-time collaboration, offline sync, 5-role RBAC, time tracking, baselines, MS Project import/export, the REST and WebSocket API, and the Helm chart.

## The enterprise boundary

TruePPM is open-core. Governance and portfolio features (SSO/SAML/OIDC, LDAP sync, portfolio dashboards, cross-program resource leveling, approval workflows, the org-wide integration hub) are **proprietary** and live in a **separate repository** (`trueppm-enterprise`).

The dependency is strictly one-way — enterprise code depends on the core, never the reverse. **The Community Edition never imports, links, or ships any proprietary code.** Cloning and running the open-source repository pulls in zero enterprise code. This separation is an architectural rule, not a packaging convenience: it is enforced in the codebase and documented in the [contributing guide](/contributing/guide/).

## Dependency licenses are enforced in CI, not just promised

You do not have to take our word that the dependency tree is clean. Every merge request and every push to `main` runs automated license audits. A dependency carrying an incompatible license **fails the pipeline** and cannot merge.

- **Python dependencies** (`license:check:py`, via `pip-licenses`) — the GPL family (GPLv2, GPLv3, AGPLv3) is **blocked**; introducing a GPL-licensed package fails the build. **LGPL is permitted** under its library-linking (dynamic-linking) exemption: LGPL code is linked at runtime, not statically incorporated into TruePPM's own source, so it does not affect the Apache 2.0 license of TruePPM's code.
- **JavaScript / npm dependencies** (`license:check:web`, via `license-checker --production --onlyAllow`) — a strict allowlist. Only these licenses are permitted; anything else fails the build:

  ```
  MIT  Apache-2.0  BSD-2-Clause  BSD-3-Clause  ISC  0BSD
  CC0-1.0  CC-BY-3.0  CC-BY-4.0  Python-2.0  Unlicense  WTFPL  BlueOak-1.0.0
  ```

The license boundary is therefore mechanically enforced on every change — a copyleft dependency cannot silently enter the codebase between reviews.

## Principal third-party dependencies

The tables below attribute the major **direct** dependencies by layer. They are not exhaustive; the complete, authoritative set is whatever the CI license jobs verify on each build. You can regenerate full transitive reports yourself with `pip-licenses` (Python) and `npx license-checker` (npm).

### Backend (Python)

| Library | Purpose | License |
|---|---|---|
| Django | Web framework | BSD-3-Clause |
| Django REST Framework | REST API | BSD-3-Clause |
| Django Channels / channels-redis | WebSockets | BSD-3-Clause |
| Celery | Task queue | BSD-3-Clause |
| django-allauth | Authentication | MIT |
| djangorestframework-simplejwt | JWT auth | MIT |
| django-simple-history | Audit history | BSD-3-Clause |
| drf-spectacular | OpenAPI schema | BSD-3-Clause |
| django-environ | Configuration | MIT |
| uvicorn | ASGI server | BSD-3-Clause |
| cryptography | Cryptographic primitives | Apache-2.0 OR BSD-3-Clause |
| defusedxml | Safe XML parsing | PSF (Python Software Foundation License) |
| psycopg (v3) | PostgreSQL driver | LGPL-3.0 ¹ |
| redis-py | Valkey / Redis client | MIT |
| networkx | Graph algorithms (CPM engine) | BSD-3-Clause |
| numpy | Numerical computing (Monte Carlo) | BSD-3-Clause |
| trueppm-scheduler | TruePPM's own scheduling engine ² | Apache-2.0 |

¹ **psycopg is LGPL-3.0** — the one copyleft dependency, and it is permitted deliberately. It is dynamically linked, not statically incorporated, so under the LGPL's library-linking exemption it does not affect the licensing of TruePPM's own code. This is the honest detail behind "LGPL is permitted" above. **Redistributing a frozen image** (a self-hosted bundle that vendors the psycopg binary, rather than pip-installing it at build time) carries the LGPL's standard relinking obligation: you must let recipients replace the library. The stock TruePPM images install psycopg from PyPI as a normal, replaceable dependency, so this obligation is satisfied without any extra step — it only becomes your responsibility if you build a deliberately frozen/vendored derivative.

² `trueppm-scheduler` is TruePPM's own CPM/Monte Carlo engine, published as a standalone Apache 2.0 package on [PyPI](https://pypi.org/project/trueppm-scheduler/).

### Frontend (TypeScript / React)

| Library | Purpose | License |
|---|---|---|
| React / react-dom | UI framework | MIT |
| react-router | Routing | MIT |
| @tanstack/react-query | Server-state management | MIT |
| @tanstack/react-virtual | List virtualization | MIT |
| @dnd-kit (core, sortable, utilities) | Drag and drop | MIT |
| zustand | Client-state management | MIT |
| recharts | Charts | MIT |
| axios | HTTP client | MIT |
| jspdf | PDF export | MIT |
| html-to-image | Image export | MIT |

### Infrastructure

| Component | Purpose | License |
|---|---|---|
| PostgreSQL | Database | PostgreSQL License (permissive, BSD-style) |
| Valkey | Cache & queue (Redis-compatible) | BSD-3-Clause |

## A note on Visiban

You may notice references to **[Visiban](https://visiban.com)** elsewhere in these docs. Visiban is a sibling project from the same maintainer — a Kanban platform, also Apache 2.0. TruePPM was built clean-room: it contains no Visiban code, imports, or dependencies (per [ADR-0013](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0013-board-kanban-view.md)). The relationship is shared authorship and shared values, not a code dependency.
