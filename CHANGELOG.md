# Changelog

All notable changes to TruePPM are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Gantt view (`packages/web/src/features/gantt/`): split-pane task list (280px, virtualized
  via @tanstack/react-virtual) + SVAR React Gantt timeline. All 6 bar types (normal/critical/
  complete/summary/milestone/baseline ghost). All 4 dependency types (FS/SS/FF/SF). Zoom
  control (Day/Week/Month/Quarter). Scroll sync via SVAR IApi (scroll-chart exec/on).
  Adapter layer (toSvarTasks, toSvarLinks) maps TruePPM types to SVAR ITask/ILink shapes.
  gantt.css scoped to .gantt-root with Design System v1.0 color tokens. Bar labels use
  #1A1917 dark text (WCAG). `readonly={true}` until WASM CPM drag (issue #19). jsdom
  test mock for SVAR canvas component. Closes #18.
- Application shell (`packages/web/`): top bar (48px), collapsible sidebar (220px→60px,
  200ms ease-out), status bar (28px), bottom nav rail at <768px, mobile drawer overlay.
  React Router v7 `createBrowserRouter`, Zustand shell store, stub hooks with fixture data.
  Custom Tailwind breakpoints for Design System v1.0 §7 (xs=320px, sm=375px, 2xl=1440px).
  WCAG 2.1 AA focus rings, aria landmarks, keyboard-navigable sidebar toggle. Closes #17.
- `packages/web/CLAUDE.md` — frontend design rules (no shadows, focus rings, health token
  encoding, touch targets, color dot a11y pattern).
- React 19 + Vite 6 + TypeScript 5 web frontend scaffold (`packages/web/`): TanStack Query v5,
  Zustand v5, Tailwind CSS v3 with TruePPM Design System v1.0 tokens (WCAG-corrected
  `text-secondary: #6B6965`), ESLint 9 flat config with jsx-a11y, vitest, axios API client with
  JWT interceptor, Zustand auth store, placeholder router, nginx Dockerfile, and Docker Compose
  `web` service.
- Rewrote `README.md` for the full monorepo: structure, Docker Compose quickstart, per-package dev commands, CI job table, and contributing guide.
- Docusaurus v3.7 documentation site (`packages/website/`) with getting-started guides, architecture
  overview, feature docs (CPM/Monte Carlo, RBAC, real-time, offline sync), API index, and ADR-0003.
- Nested membership CRUD at `/api/v1/projects/{pk}/members/`: Owner-only create/update/delete with
  role-escalation guard (callers cannot assign roles ≥ their own), last-Owner atomic guard, Viewer self-removal,
  and `member_added` / `member_role_changed` / `member_removed` WebSocket broadcasts.
- Offline delta sync pull endpoint `GET /api/v1/projects/{pk}/sync/?since={server_version}` returning
  WatermelonDB-compatible `changes` + `timestamp`. Snaps the high-water mark before delta queries to
  eliminate TOCTOU gaps. Soft-deleted rows appear as tombstones in `deleted` arrays.
- Soft-delete on `VersionedModel` (`is_deleted`, `deleted_version`): all `perform_destroy` hooks now
  call `soft_delete()` instead of hard-deleting, so mobile clients receive tombstones on the next pull.
- `Dependency` promoted to extend `VersionedModel` (gains `server_version`, `is_deleted`,
  `deleted_version`) so dependency changes are visible to the sync protocol.
- 5-role RBAC (`access` app): `ProjectMembership` through-table with Owner/Admin/Scheduler/Member/Viewer roles;
  `ProjectScopedViewSet` mixin for IDOR prevention; `IsProject*` permission classes wired into all ViewSets.
  Project creators are auto-assigned Owner on creation.
- Auto-scheduling Celery task (`recalculate_schedule`) triggered on every Task/Dependency write via
  `transaction.on_commit`. Idempotency enforced via Redis SET NX lock; lock collisions re-queue with 10s countdown.
- Real-time WebSocket support (`sync` app): `ProjectConsumer` with JWT `?token=` auth; Viewers (role=0) rejected
  with close code 4003; `broadcast_board_event()` helper broadcasts mutation and CPM completion events to all
  connected project clients.
- CI pipeline expanded with `api:type-check` (mypy strict), `api:migration-check`,
  `api:openapi-check`, `changelog:check` (MR-only), `license:check`,
  `security:bandit`, and `security:pip-audit` (MR + main). Coverage thresholds
  enforced: scheduler ≥ 80%, api ≥ 65%. Minio-backed caches keyed on
  pyproject.toml file hash per package. `workflow:rules` prevents duplicate
  branch + MR pipelines.

### Fixed
- `VersionedModel.save()` no longer overwrites the atomically-incremented
  `server_version` via `super().save()`. The subsequent `UPDATE` now excludes
  `server_version` via `update_fields`, preserving the F()-expression increment.
  Without this fix, `server_version` was always 0 on update — breaking the mobile
  sync protocol entirely.
- `DependencySerializer` now validates that predecessor and successor belong to the
  same project. Cross-project edges produced undefined CPM behaviour; they now return
  HTTP 400.
- `scheduling` and `sync` app URL modules are now included in the root URL conf.
  Previously, any endpoint added to either app would silently 404.

### Security
- Added `IsProjectMember` permission class (Phase 1 stub) to all ViewSets. Every
  endpoint now requires authentication; object-level project-scoping will be enforced
  in Phase 2 once the `ProjectMembership` model exists.

### Added
- CPM scheduling engine (`schedule()`) with forward/backward pass, float calculation,
  and critical-path identification. Supports all four dependency types (FS, SS, FF, SF)
  with calendar-day lag, calendar-aware working-day arithmetic, weekend skipping, and
  holiday exceptions.
- Monte Carlo probabilistic simulation (`monte_carlo()`) using PERT-Beta distributions
  (method-of-moments parameterisation). Vectorised with numpy; 10 000 runs on a
  200-task chain completes in well under 5 seconds. Returns P50/P80/P95 completion
  dates and the full sorted distribution.
- `CyclicDependencyError` exception with the offending cycle exposed as `.cycle`.
- `ScheduleResult` and `MonteCarloResult` dataclasses with `to_dict()` serialisation.
- CLI entry point `trueppm-scheduler` with `schedule` and `monte-carlo` subcommands.
  Supports `--json` output and `--distribution` flag for the full MC distribution.
- 45 unit and integration tests covering CPM correctness, calendar arithmetic,
  all dependency types, float/critical-path computation, cycle detection, and MC
  statistical properties including a performance benchmark.
- Django 5.1 REST API package (`trueppm-api`) scaffolded with src-layout, django-environ
  settings split (base/dev/prod), uvicorn ASGI server, Celery 5.4 task queue, and
  Django Channels 4 WebSocket support.
- Core Django models: `Calendar`, `CalendarException`, `Project`, `Task`, `Dependency`,
  `Resource`, `TaskResource`. All extend `VersionedModel` (UUID PK + atomic
  `server_version` increment) for offline-sync support. `Task.wbs_path` uses a custom
  `LtreeField` with PostgreSQL `ltree` extension and GiST index for hierarchy queries.
- Initial database migration including `CREATE EXTENSION IF NOT EXISTS ltree` and
  GiST index on `wbs_path`.
- REST CRUD endpoints for all core entities at `/api/v1/`: calendars, projects, tasks,
  dependencies, resources, task-resources. Powered by DRF `ModelViewSet` with pagination,
  search, ordering, and field-level filters (project, is_critical, dep_type).
- CPM output fields (`early_start`, `early_finish`, `late_start`, `late_finish`,
  `total_float`, `is_critical`) are read-only on the Task API — set only by the
  scheduling engine.
- `server_version` is read-only on the Project API — enforced at the serializer layer.
- OpenAPI 3.1 schema via drf-spectacular at `/api/schema/`.
- 25 API and model tests using `pytest-django` with testcontainers for local PostgreSQL
  (falls back to `DATABASE_URL` env var in CI).
- Helm 3 chart (`packages/helm/`) with Bitnami sub-charts for PostgreSQL and Redis;
  separate `values-dev.yaml` and `values-prod.yaml` overlays.
- Docker Compose dev environment (`docker-compose.yml`) with db, redis, api, and
  celery-worker services; non-root `trueppm` user in the API Dockerfile.
- GitLab CI jobs for API lint, API tests (with PostgreSQL + Redis service containers),
  and Helm lint.
