# Changelog

All notable changes to TruePPM are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- PyPI publish pipeline for `trueppm-scheduler` (issue #37): pushing a git tag
  `scheduler-vX.Y.Z` triggers a new `publish` stage that builds an sdist + wheel
  via `python -m build` and uploads to PyPI via `twine`. A version-consistency
  guard fails fast if the tag version does not match `pyproject.toml`. Requires
  a `PYPI_TOKEN` CI/CD variable (masked + protected). Built artifacts are kept
  as GitLab CI job artifacts for 7 days.

### Added
- Keyboard rescheduling for the Gantt chart (WCAG 2.1.1 gap, issue #34): selecting a task
  and pressing Enter enters keyboard reschedule mode. Arrow keys nudge by 1 working day;
  Shift+Arrow nudges by 5. 'd' opens a date-input popover for precise entry. Enter confirms
  (PATCH), Escape cancels. Preview bars, the CP-flip badge, and milestone delta tooltip all
  render identically to the pointer drag. An origin ghost bar (dashed outline) marks the
  task's pre-nudge position. Screen reader support via separate assertive + polite aria-live
  regions. Offline guard prevents PATCH when `navigator.onLine` is false. Closes #34.
- `nudgeWorkingDays(isoDate, days)` utility in `ganttUtils.ts` — advances or retreats an
  ISO date by N working days (Mon–Fri), skipping weekends.
- `DateInputPopover` component — `role="dialog"` focus-trapped modal for direct date entry
  during keyboard reschedule. Derives finish from start + task duration.
- Design rules 51–53 in `packages/web/CLAUDE.md`: keyboard instruction strip, origin ghost
  bar, and assertive aria-live region requirements for keyboard rescheduling.
- Canvas Gantt renderer Phase 1 (issue #19): replaces `@svar-ui/react-gantt` with a
  purpose-built HTML5 Canvas 2D renderer. Delivers feature parity with the previous SVAR
  widget plus new capabilities: 3-layer dirty-rect canvas stack (row bands/grid/today line,
  task bars/arrows, drag interaction chrome), row virtualisation for smooth performance at
  500+ tasks, snap-to-day dragging with Shift to suspend snap, resize-handle drag to extend
  task duration, Pointer Events API throughout for unified mouse/touch/stylus support on
  iPad, and a `GanttEngineImpl` class that satisfies the stable `GanttEngine` API contract.
  The `GanttAriaOverlay` transparent DOM layer provides a fully virtualised WCAG 2.1 AA
  `role="grid"` structure with roving tabindex and canonical aria-labels over the canvas.
  New UX: timeline loads with today at 25% from the left edge; a "Today" button in the
  toolbar scrolls back to the current date; zoom level changes preserve the viewport center
  date; empty project state shows a prompt instead of a blank canvas; canvas init failure
  shows a plain HTML task table fallback. `ZoomLevel` union now includes `'year'`.
- Canvas Gantt renderer Phase 0 (issue #19): public `GanttEngine` interface and
  `GanttScaleData` coordinate system replacing SVAR's private `_scales` API. Includes
  `dateToLeft`, `leftToDate`, `parseUTCDate`, and `buildScaleData` utilities (DST-safe,
  UTC-only arithmetic). `GanttEngineStub` test double provides compile-time interface
  verification and a no-op implementation for unit tests. Design rules 54–77 added to
  `packages/web/CLAUDE.md` covering canvas architecture, dirty-rect invalidation, row
  virtualisation, drag FSM, Pointer Events API, ARIA grid overlay, and performance budgets.
- Monte Carlo tooltip plain-language summary: "8 in 10 simulations finish by **[date]**"
  appears at the top of the histogram tooltip (P80 as anchor). Closes #31.
- At-risk and critical count badges in TopBar are now clickable buttons — click opens a
  popover listing affected tasks (WBS · name); clicking a task selects and scrolls to it
  in the Gantt. `BadgePopover` component with `role="menu"` / `role="menuitem"`. Closes #32.
- Mobile Monte Carlo confidence: P80 chip ("P80: Mon D") added to `StatusBar` for `< md`
  viewports; `MonteCarloLabel` cell shows persistent P80 chip at `md+`; MC confidence bars
  increased to 8px height (was 6px). Closes #33.

### Fixed
- Gantt task list expand arrow was pointing backwards — disabled SVAR's built-in task list
  panel (`columns={false}`) so only our custom panel renders. Closes #47.
- Gantt task list columns (Task / Dur / Start / %) are now drag-to-resize with widths
  persisted to localStorage (`useColumnWidths` hook). Closes #48.
- Gantt bar grid columns were misaligned with the header row — root cause was SVAR rendering
  a duplicate header; fixed by the same `columns={false}` change. Closes #49.
- `text-[10px]` and `fontSize={9}` violations in `MonteCarloTimeline` and `MonteCarloHistogram`
  replaced with `text-xs` / `fontSize={12}` (design rule 50 — 12px floor). Fixes WCAG 1.4.3.
- `StatusBar` legend items now use semantic Tailwind tokens (`bg-semantic-on-track` etc.)
  instead of hardcoded hex colors (design rule 8). Legend updated to match rule 44 (Complete /
  In progress / Critical path / ◆ Milestone). Last-saved format corrected to `"min"` not `"m"`
  (design rule 45).
- Rule 39 in `packages/web/CLAUDE.md` corrected: at-risk/critical badge buttons use
  `aria-haspopup="menu"` not `"listbox"` (listbox implies value-selection; these navigate).
- Gantt task list panel was rendering with a white background against the dark canvas
  timeline, creating a jarring split. `TaskListPanel`, `TaskListHeader`, and `TaskListRow`
  now use `gantt-surface` tokens throughout: `bg-gantt-surface` background,
  `text-gantt-text-primary/secondary` labels, `text-gantt-semantic-critical` for critical
  path tasks, `bg-white/10` selection highlight, and `bg-gantt-semantic-critical` progress
  fill. Also fixes a `fontSize:10px` inline style to `text-xs` (design rule 50).

### Changed
- Web UI polish: replaced emoji nav icons with inline SVG icon set (`GanttIcon`,
  `BoardIcon`, `ListIcon`, `CalendarIcon`, `ResourcesIcon`); added geometric logo
  mark; top bar alert badges use `WarningIcon`/`CriticalDotIcon` instead of raw
  Unicode; task list rows show a mini progress bar instead of plain percentage text;
  status bar uses 1px vertical dividers instead of · dots; Monte Carlo histogram
  tooltip formats ISO dates as "Mon D"; MC confidence bars increased 4px → 6px with
  even vertical spacing; placeholder views show a blueprint grid SVG.

### Added
- Gantt task list resizable columns (`useColumnWidths` hook): task/duration/start/progress
  columns can be dragged to resize, widths persisted to localStorage. MC label cell
  tracks task list width so the vertical border stays aligned. Closes #44 (column layout).
- Design rules 35–50 in `packages/web/CLAUDE.md`: sidebar dark surface token
  (`gantt-surface`), section header sizing floor, ViewTabs underline vs pill, TopBar
  badge outlined style, dark-surface semantic token overrides (`gantt-semantic-*`),
  GanttToolbar ARIA, StatusBar legend/copy, focus rings on dark surface, Monte Carlo
  RBAC gate, export/print mode, critical-path tooltip, and `text-[10px]` prohibition.
  Derived from five-review design sprint (UX design, architect, UX review, accessibility,
  VoC) for issue #44.
- Monte Carlo confidence display (`packages/web/src/features/gantt/`): P50/P80/P95
  vertical confidence lines below the Gantt split pane, aligned to the SVAR timeline
  date axis via `useSvarScale` (reads `getState()._scales` + `scrollLeft`). Histogram
  tooltip on hover/focus shows the full weekly-bucketed distribution as an SVG
  bar chart with percentile rules. P80 badge in the top bar updated to use
  `semantic-at-risk` tokens and display at `md` breakpoint (was `xl`).
  Hidden on mobile (`< md`). `prefers-reduced-motion` respected.
  Closes #20.
- `useMonteCarloResult` stub hook and `FIXTURE_MC_RESULT` fixture (pre-bucketed
  weekly distribution, ready to swap for a real `useQuery` call).
- `useSvarScale` hook — bridges SVAR's internal scroll/zoom reactive state into
  React state for date-aligned DOM overlays.
- `MonteCarloResult` and `McBucket` types added to `src/types/index.ts`.
- `MC_ROW_HEIGHT = 44` constant added to `ganttConstants.ts`.
- SVAR test stub (`src/test/mocks/svar-gantt.tsx`) extended with `getState`,
  `getReactiveState`, `getStores`, `getTable`, `getTask`, `detach`, `serialize`.
- Monte Carlo design rules added to `packages/web/CLAUDE.md` (rules 17–22).
- Gantt drag CPM preview (`packages/web/src/features/gantt/`, `src/hooks/`, `src/workers/`):
  dragging a task bar spawns a Web Worker that runs an incremental CPM forward pass and
  renders translucent preview bars for all downstream-impacted tasks before the drop is
  committed. Milestone slip delta is shown in a tooltip. Escape cancels the drag.
  Offline guard prevents PATCH when `navigator.onLine` is false. aria-live region
  announces critical-path changes without triggering re-renders.
  Closes #19.
- `buildSubgraph` — extracts the affected task subgraph for incremental CPM.
- `ganttUtils` — shared date↔px math (`dateToLeft`, `dateFromCanvasLeft`) used by both
  PreviewOverlay and MonteCarloTimeline.
- `dragStore` (Zustand) — drag phase, preview results, overflow count.
- `ghost-fill` / `ghost-border` Tailwind tokens (design rules 23–25).
- Drag preview design rules added to `packages/web/CLAUDE.md` (rules 23–34).

### Added
- Root `.gitignore` covering Python, pytest, mypy, ruff, Docker override files, and editor
  artifacts. Previously the repo had no root ignore file.
- CI pipeline restructured to 4 stages (lint → analyze → test → security) with a
  per-package DAG (`needs:`). Test jobs now start as soon as their own package's
  analysis passes rather than waiting for all packages to complete.
  New jobs: `web:lint`, `web:type-check`, `web:build`, `web:test`, `web:security`
  (npm audit), `website:build`, npm license check in `license:check`.
  `security:bandit` moved from security stage to analyze stage (it is static analysis
  and does not need test results). `changelog:check` moved to lint stage.

### Changed
- Scheduler moved from repo root (`src/trueppm_scheduler/`, root `pyproject.toml`) into
  `packages/scheduler/` — all packages now live under `packages/`. Updated everywhere:
  `packages/api/Dockerfile`, `.gitlab-ci.yml`, `.pre-commit-config.yaml`, `CLAUDE.md`,
  `README.md`, and `packages/website/docs/architecture/overview.md`.
- Duplicate `docs/adr/0003-rbac-auto-scheduling-websockets.md` removed — canonical copy
  is `packages/website/docs/adr/0003-rbac-auto-scheduling-websockets.md`.
- Design System HTML moved from `docs/design/` to `packages/website/static/design/` so
  Docusaurus serves it at a stable URL.
- Mobile references removed from `CLAUDE.md`, `README.md`, and `docs/architecture/overview.md`.
  Mobile is not yet started; dead references erode doc trust. Will be re-added when
  `packages/mobile` is scaffolded.
- `README.md` web section updated to clearly state what is built vs what is not yet built.
- `docs/architecture/overview.md` system diagram updated to show current client topology
  (web only; offline-first sync protocol noted as designed for future clients).
- Gantt view added to Docusaurus sidebar (`features/gantt`).

### Fixed
- `scheduling/tasks.py` `bulk_update` comment expanded to explain WHY `server_version` is
  intentionally not incremented for CPM field writes (prevents spurious mobile sync deltas).


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
