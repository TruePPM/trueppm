# Changelog

All notable changes to TruePPM are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Idempotent task framework** (issue #63): reusable `@idempotent_task` decorator in
  `trueppm_api.core.idempotent` that wraps `@shared_task` with Redis distributed locking.
  Supports three contention strategies (`retry`, `skip`, `queue`), automatic lock extension
  via daemon thread with Lua compare-and-extend script, and an import-time lock key registry
  that catches accidental collisions. `recalculate_schedule` migrated from hand-rolled Redis
  lock to `@idempotent_task(on_contention="queue")`; `purge_old_history_records` now uses
  `@idempotent_task(on_contention="skip")` for global lock protection. ADR-0018.
- **Board / Kanban view** (issue #21): four-column drag-and-drop board view (To Do,
  In Progress, On Hold, Done) built with @dnd-kit. Cards can be dragged between columns
  to update task status via API PATCH. Keyboard move alternative via overflow menu
  "Move to..." submenu (WCAG 2.1.1). Mobile horizontal snap scroll with dot indicator.
  `TaskStatus` type added to frontend `Task` interface. Wired into ProjectShell view
  switcher and BottomNav. ADR-0013.
- **Celery task hardening** (issue #62): all Celery tasks now have retry policies
  (exponential backoff + jitter for transient errors), time limits (CPM: 480s/600s,
  purge: 300s/360s), and dead-letter tracking via new `FailedTask` model. Admin API
  at `/api/v1/admin/failed-tasks/` for list/retry/dismiss. Task lifecycle Django
  signals (`celery_task_started`, `celery_task_succeeded`, `celery_task_failed`,
  `celery_task_retried`) bridged from Celery framework signals — enterprise extension
  point. Re-queue loop in `recalculate_schedule` capped at 5 attempts. Beat schedule
  format fixed (was malformed dict, now proper `crontab` object). ADR-0017.
- **WASM CPM engine** (issue #39): Rust + petgraph scheduling engine compiled to
  WebAssembly via wasm-pack. Exposes `compute_schedule()` and `incremental_update()`
  for in-browser Gantt drag simulation and future offline mobile scheduling. Shared
  JSON fixture suite enforces Python ↔ Rust parity in CI. 184 KB raw / 81 KB gzip
  bundle. ADR-0015.
- **Task status field** (issue #58): `Task.status` field with four values —
  `NOT_STARTED` (default), `IN_PROGRESS`, `ON_HOLD`, `COMPLETE`. Exposed on all task
  list and detail endpoints; writable via `PATCH /api/v1/tasks/{id}/`. Filter tasks by
  status using `?status=<value>` on the task list. Status is included in the offline
  sync pull endpoint so mobile clients receive it in delta pulls. A
  `task_status_changed` Django signal is emitted whenever the value changes (with
  `old_status` and `new_status` kwargs); Enterprise can attach receivers without
  modifying OSS code. ADR-0013.
- **Monte Carlo simulation API** (issue #54): new synchronous endpoint
  `POST /api/v1/projects/{pk}/monte-carlo/` returns P50/P80/P95 completion dates.
  OSS tier is capped at 1 000 simulations and 500 tasks per run (configurable via
  `MC_SIMULATION_CAP` / `MC_TASK_CAP` settings; set to `None` for Team tier unlimited).
  Exceeding the cap returns HTTP 402 with `{"error": "simulation_cap_exceeded", "tier": "team",
  "message": "..."}`. Requires project Viewer role or above. No database writes; results are
  returned directly. `SimulationCapExceeded` exception added to `trueppm-scheduler` public API.
  ADR-0012.
- **Risk Register** (issue #52): per-project risk tracking with probability × impact severity
  scoring. New `Risk` model (`RiskStatus` choices: OPEN / MITIGATING / RESOLVED / ACCEPTED /
  CLOSED) with soft-delete and `django-simple-history` audit trail. REST endpoints:
  `POST /api/v1/projects/{pk}/risks/` (create, Member+), `GET` (list/retrieve, Viewer+),
  `PATCH`/`PUT` (update, Member+), `DELETE` (soft-delete, Owner only). `severity` is computed
  as `probability × impact` (1–25, never stored). Risks may link to up to 10 tasks in the same
  project via a many-to-many through table (`RiskTask`). Ordering by severity supported via
  `?ordering=-severity`. Status filter via `?status=OPEN`. WebSocket events
  (`risk_created`, `risk_updated`, `risk_deleted`) broadcast on commit.
  `Risk` is included in the offline sync pull endpoint
  (`GET /api/v1/projects/{pk}/sync/`) with task IDs serialized as a flat UUID list
  (`task_ids`) on the risk payload — mobile clients receive risk changes in the same
  delta pull as tasks and memberships. A `risk_changed` Django signal is emitted on
  every probability, impact, or status change and on soft-delete; Enterprise can attach
  portfolio rollup receivers without modifying OSS code.
- **Risk Register web UI** (issue #52): `Risks` tab added to the project view switcher
  (ViewTabs desktop + BottomNav mobile). The register shows a sortable table with
  WCAG-compliant severity chips (CRITICAL/HIGH/MEDIUM/LOW/MINIMAL), status badges, and a
  5×5 probability × impact matrix that highlights occupied cells. Desktop: risk detail
  opens in a 480px right-side drawer. Mobile: 85vh bottom sheet with drag handle.
  Create/edit form; mobile FAB above the nav rail. All rules 86–90 from
  `packages/web/CLAUDE.md` are enforced.
- **Web authentication**: JWT login page (`POST /api/v1/auth/token/`), `RequireAuth`
  route guard (redirects to `/login?next=` when unauthenticated), and single-flight
  token refresh interceptor (coalesces concurrent 401s, retries originals, dispatches
  `auth:sessionExpired` on refresh failure). All routes except `/login` are protected.
  Dead placeholder routes (`/board`, `/list`, `/calendar`, `/resources`) removed; `*`
  catch-all redirects to `/gantt`. `useGanttTasks` and `useProjects` now call the live
  API (fixture stubs removed).
- **Object change history** (issue #51): every user-initiated mutation to `Task`, `Project`,
  and `Dependency` is now recorded via `django-simple-history` with field-level diffs (old
  value, new value, who changed it, when). CPM output fields (`early_start`, `early_finish`,
  etc.) are excluded. New endpoints: `GET /api/v1/projects/{pid}/tasks/{task_id}/history/`,
  `GET /api/v1/projects/{pid}/history/`, and `GET /api/v1/projects/{pid}/history/summary/`
  (mutation counts by field and object type, 5-minute Redis cache with `?refresh=1` bust).
  `history_user` details visible to Owner/Admin only; Viewer/Member receive null. Nightly
  Celery purge task controlled by `HISTORY_RETENTION_DAYS` setting (default 90 days; `None`
  disables purging for enterprise unlimited retention). Closes issue #12 (superseded).
  Enterprise extension point: `history_record_created` Django signal fires after each record
  save for cold-storage archiving without OSS modification.
- **Calendar view** (issue #55): a month/week calendar overlaid with fragment chips for each
  task. Tasks that span multiple weeks are split into contiguous chip fragments per row so
  no task is ever truncated mid-week. Milestones render as ◆ diamond chips (using the
  explicit `is_milestone` field — never inferred from `duration == 0`). Critical-path tasks
  use `semantic-critical` color; complete tasks use `semantic-on-track`; normal tasks use
  `brand-primary`. Up to 4 chip lanes per week row via greedy interval scheduling; overflow
  shows "+N more". Month and week toggle stored in `?calView=` URL param. Prev/Next/Today
  navigation with anchor stored in `?calAnchor=`. Accessible: chips are `<button>` elements
  with `aria-label` carrying name + CP + milestone status; focus rings WCAG 2.1 AA.
- `Task.is_milestone` field (`BooleanField(default=False)`) on the Task model and serializer.
  Explicit flag preserved from MS Project `<Milestone>` / Primavera P6 `task_type=TT_Mile`
  imports. Inferring milestone status from `duration == 0` is rejected — a 1-day gate
  meeting is a valid milestone without zero duration, and inference breaks round-trip
  fidelity with import sources.
- **`[Gantt · WBS · Table]` view-mode switcher** extended to five tabs:
  `[Gantt · WBS · Table · Calendar · Resources]` — both Calendar and Resources are live views.
- **WBS Tree view** (issue #40): a collapsible hierarchy panel, accessible from the
  `[Gantt · WBS · Table]` view-mode switcher. Rows show WBS number, task name, progress
  bar, duration, and a critical-path (CP) badge. Summary rows use +/− expand/collapse
  toggles (MS Project convention). Tasks can be reordered within a parent via drag-to-
  reorder (`@dnd-kit`); sibling-only constraint enforced client-side. Inline rename via
  double-click or F2. Keyboard accessible: `aria-level`, `aria-expanded`, WCAG 2.1 AA.
- **Task Table view** (issue #40): a virtualized flat-list table (via
  `@tanstack/react-virtual`) of all tasks, sortable by WBS, name, start, finish, duration,
  or progress. Supports bulk-select with checkboxes, a "My tasks" filter toggle, and
  inline rename via double-click or F2. Critical-path rows get a subtle red tint and a CP
  badge matching the WBS view.
- **`[Gantt · WBS · Table]` view-mode switcher** is now fully functional — previously the
  WBS and Table buttons were disabled placeholders. Active view is tracked in the `?view=`
  URL search param so links are shareable and the TanStack Query cache is stable across
  view switches.
- `RecalculatingBadge` in the project toolbar is now live — driven by WebSocket
  `cpm_queued` / `cpm_complete` events so the spinner appears automatically when the
  CPM engine is running and dismisses when recalculation finishes.
- **WebSocket project channel** (`/ws/v1/projects/{id}/?token=…`): the frontend
  establishes a persistent connection for the active project and dispatches incoming
  events to the TanStack Query cache and Zustand scheduler store. Reconnects with
  exponential backoff (1 s → 30 s cap) on drop.
- `schedulerStore` Zustand slice: tracks `isRecalculating`, `cpmError`, and
  `recalculatedAt` state driven by WebSocket CPM lifecycle events.
- CPM engine now broadcasts a `cpm_queued` event to connected clients immediately
  after acquiring the scheduling lock, so the frontend can show the in-progress
  indicator without polling.
- CPM engine broadcasts `cpm_error` with `error: "cyclic_dependency"` (including
  the offending cycle) or `error: "internal_error"` so the frontend can surface a
  meaningful error message rather than a silent stale schedule.
- `useGanttTasks` now fetches tasks and dependencies from the live API
  (`GET /api/v1/tasks/?project=…` and `GET /api/v1/dependencies/?project=…`)
  instead of returning fixture data.
- Playwright E2E test scaffold (`packages/web/e2e/`) with smoke and Gantt tests
- **Baselines** (issue #9): snapshot the current schedule for comparison against actuals.
  `POST /api/v1/projects/{pk}/baselines/` creates a named snapshot of all task
  start/finish dates; auto-names as "Baseline 1", "Baseline 2", … when no name is
  supplied (custom names accepted). Baselines are immutable once created — task rows
  cannot be mutated after snapshot. `POST …/activate/` marks a baseline as the active
  reference; only one baseline can be active per project at a time (enforced at the
  DB level). `DELETE …/{id}/` soft-deletes a baseline (Owner only).
- `GET /api/v1/tasks/` now returns `baseline_start` and `baseline_finish` date fields
  annotated from the active baseline (or an explicit `?baseline=<id>` override).
  Both fields are `null` when no baseline is active or the task was not present in the
  snapshot. Gantt bar rendering uses these fields to draw the 6px baseline ghost bar.
- `Baseline.has_cpm_dates` flag: `false` when the snapshot was taken before the CPM
  engine has run (early start/finish are null). Creation still succeeds — the flag lets
  the UI warn the user that date comparison will be meaningless until the scheduler runs.
- WebSocket project channel now dispatches `baseline_created`, `baseline_activated`, and
  `baseline_deleted` events to all connected clients; the frontend invalidates the
  baselines and tasks cache on receipt.
  that run against the production build in CI; covers shell landmarks, view-mode
  switcher state, task list accessibility, and Gantt legend. New `web:e2e` CI job
  uses the official Playwright Docker image and saves reports as artifacts on failure.
- Test coverage for the Gantt drag CPM preview feature (issue #19): 51 new test cases
  across `dragStore`, `useDragCpm`, `PreviewOverlay`, `MilestoneDeltaTooltip`, and
  `ganttUtils` — covering the full drag state machine, CPM worker seq guard, offline drop
  guard, Escape-key cancellation, CP badge timing (400 ms delay), overflow cap label,
  keyboard instruction strip, origin ghost bar, and `nudgeWorkingDays` edge cases.
- **Resource utilization view** (issue #22): new `Resources` tab in the project view
  switcher shows per-resource daily load as percentage-filled bars, color-coded green
  (< 85%), amber (85–100%), and red (overallocated > 100%). Capacity is calendar-driven
  (`resource.calendar.hours_per_day × max_units`) — part-time workers are represented
  correctly. Default window is ±4 weeks from today; a "Fit to project" toolbar button
  expands to the full project span. A mismatch tooltip (ⓘ) appears on any resource whose
  calendar differs from the project calendar. Permission-gated to Scheduler and above.
- REST endpoint `GET /api/v1/projects/{id}/utilization/` returning per-resource daily
  load hours, contributing task IDs, and `unassigned_task_count` for tasks with CPM
  dates but no resource assignment. Accepts `?start=` and `?end=` date filters; returns
  409 when no CPM dates exist. Permission gate: SCHEDULER (role ≥ 2) and above.
- `Task.hours_per_day` is now included per resource in the utilization response,
  enabling the frontend to compute load percentages without additional API calls.
- Composite database index `task_utilization_window_idx` on `(project, early_start,
  early_finish)` — cuts the utilization window filter from a full project-task scan to
  an index range scan; critical for projects with hundreds of tasks.

### Fixed
- **Auth 401-retry race on login**: after logging in, TanStack Query retried stale 401 errors before the new token was stored, causing a persistent "Failed to load projects" screen. Fixed by gating renders on Zustand hydration, clearing the query cache on login, suppressing 401 retries at the query level, and redirecting to `/login` on session expiry via a custom event.
- **Sidebar blank on API failure**: when the projects API returned an error (e.g. 401 while unauthenticated), the sidebar rendered completely blank with no message. Now shows "Failed to load projects" in the error state.
- **Risk register: add risk fails silently**: `POST /api/v1/projects//risks/` 404 when `projectId` was empty string — `RiskRegisterView` now returns early with a "Select a project" prompt instead of rendering the broken form. API errors (400, 403, 404) are now surfaced in the form as a visible error banner.
- **Gantt blank rendering on unscheduled tasks**: tasks with null `early_start`/`early_finish`
  dates produced `Invalid Date` / NaN canvas coordinates, causing both the task list and
  timeline panels to render as blank boxes. Engine now filters unscheduled tasks from
  range calculation and rendering; task list shows duration without a start date.
- Switching view tabs (Gantt / WBS / Table / Calendar / Resources) no longer drops the
  `?project=` URL search param, which previously caused the active project to be lost on
  every view switch.
- Celery worker container failed to start in Docker Compose — `packages/api/Dockerfile`
  used `ENTRYPOINT` for uvicorn, causing docker-compose `command` overrides to be
  appended as uvicorn arguments instead of replacing the command. Changed to `CMD`
  so `docker compose run` and `command:` overrides work correctly for celery, migrations,
  and any other management commands.
- **Gantt canvas rendering** (issue #19 follow-up): four visual bugs fixed.
  Task bars were painted 28 px too high (no `HEADER_HEIGHT` offset), alternating row
  bands drifted away from their rows on vertical scroll (`drawRowBands` ignored
  `scrollTop`), dependency arrows disconnected from bars on scroll (`drawDependencyArrows`
  ignored `scrollTop`), and no date labels were shown on the timeline. A two-row
  timeline header (major unit / minor unit) is now drawn in the top 28 px of the
  canvas on every full repaint, matching the task-list header height so rows
  align correctly.

### Added
- **Short hex object IDs** (issue #50, ADR-0016): Tasks and Risks now receive a
  human-readable 8-character hex identifier (e.g. `000A3F`) on creation, scoped
  per project. Exposed as read-only `short_id` on `TaskSerializer`,
  `RiskSerializer`, and their sync counterparts. Filterable via
  `?short_id=000A3F` on task and risk list endpoints. Existing objects are
  backfilled via data migration.
- `Task.planned_start` field (SNET — start no earlier than): PMs can now set a
  constraint date on any task via `PATCH /api/v1/tasks/{id}/`. The CPM forward
  pass applies it as a floor (`early_start = max(CPM-computed, planned_start)`),
  so constrained tasks cascade correctly to successors. Included in the mobile
  sync delta payload (`SyncTaskSerializer`) so on-device CPM respects the
  constraint offline.
- REST endpoint `POST /api/v1/projects/{pk}/tasks/reorder/` — atomically reorders
  sibling tasks within a WBS level; accepts `parent_path` + `ordered_ids`, recomputes
  `wbs_path` server-side, and returns updated paths so clients can invalidate caches
  without a full refetch. Triggers CPM recalculation and real-time broadcast on commit.
- REST endpoint `POST /api/v1/projects/{pk}/tasks/bulk/` — atomically creates, updates,
  and deletes tasks in a single request; returns `{ created, updated, deleted }` lists.
  Uses `SELECT FOR UPDATE` row-locking to prevent concurrent soft-delete races. Triggers
  CPM recalculation once after all operations commit.
- UI harmonization sprint (issue #44): sidebar, toolbar, and Gantt panel now share a
  consistent dark surface (`#0F1117`). Changes include:
  - Sidebar background migrated from brand-green to the same dark token as the Gantt
    task-list panel; project health labels now use dark-surface semantic color variants
    that meet WCAG 1.4.3 (previously 1.02–1.09:1 contrast — invisible).
  - Sidebar active project row gains a 2px left border as a non-color selection indicator
    (WCAG 1.4.1). "PROJECTS" section header added (rule 36).
  - Gantt toolbar gains a `[Gantt · WBS · List]` view-mode switcher. WBS and List are
    disabled placeholders until those panels ship in a follow-up branch.
  - `ShellStats.recalculatedAt` field: StatusBar now displays a separate
    "Recalculated: N min ago" indicator for the CPM engine, distinct from "Last saved"
    (the data-entry save timestamp).
- `gantt.*` Tailwind token group in `tailwind.config.ts` — `gantt-surface`,
  `gantt-text-primary/secondary`, and `gantt-semantic-critical/at-risk/on-track` now
  emit real CSS. All prior references were silent no-ops.

### Fixed
- Badge borders (`at-risk`, `critical`) in TopBar and StatusBar were at 40% opacity
  (1.92–2.04:1 contrast), failing WCAG 1.4.11. Raised to 80% opacity (~4.25:1+).
- Hamburger menu touch target increased from 32×32px to 44×44px (WCAG 2.5.5).
- StatusBar online-user count was gated behind the `2xl` (1440px) breakpoint; changed
  to `lg` (1024px) per design spec.
- Gantt task-list column layout: separate Duration and Start columns merged into a single
  "Dur · Start" column (`{n}d · {MMM D}`, 100px). Mini progress bar removed from the `%`
  column — text percentage only.
- Two runnable Jupyter notebooks for `trueppm-scheduler` (issue #38):
  `01-cpm-quickstart.ipynb` covers project definition, CPM run, float table,
  custom calendar with holiday, SS dependency with lag, cycle detection, and
  JSON round-trip; `02-monte-carlo.ipynb` covers PERT three-point tasks, P50/P80/P95
  output, matplotlib histogram with percentile lines, and scenario comparison.
  Also corrects the scheduler API reference in `docs/features/scheduler.md` —
  the previous doc used constructor signatures that do not exist
  (`Calendar(id=, name=, working_days={set})`, `schedule(project, tasks, deps, cal)`).
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

### Added
- `Task.assignee` field (nullable FK to the user model) — Team Members can now be
  assigned to tasks via `PATCH /api/v1/tasks/{id}/` with `{ "assignee": "<uuid>" }`.
  The field is included in all task list and retrieve responses.
- `role_label` field in membership list/retrieve responses (`GET /api/v1/projects/{pk}/members/`)
  — returns the human-readable role name (e.g. `"Project Manager"`) alongside the integer
  `role` ordinal. Display-only; not accepted on write.

### Changed
- Role labels updated to PM-standard terminology (integer ordinals are unchanged — no data
  migration required): `"Member"` → `"Team Member"`, `"Scheduler"` → `"Resource Manager"`,
  `"Admin"` → `"Project Manager"`, `"Owner"` → `"Project Admin"`.
- Task write permissions now enforce the full 5-role model (issue #11): Team Members may
  only edit tasks where they are the assignee; Resource Managers cannot edit task content
  (read-only for task fields); Project Managers and above can edit any task.
- Dependency create/update/delete now requires Resource Manager role or above — previously
  any Team Member could modify scheduling dependencies.

### Fixed
- Security: non-member users could create tasks in any project by supplying a known project
  UUID — `TaskViewSet.perform_create` now calls `check_object_permissions` before saving
  (DRF does not call it automatically on create actions).
- Security: non-member users could create dependencies by supplying known task UUIDs —
  same `check_object_permissions` guard added to `DependencyViewSet.perform_create`.
- Security: soft-deleted project memberships were incorrectly treated as active in all
  permission checks — `is_deleted=False` filter is now applied consistently to every
  `ProjectMembership` query in the RBAC layer.
- Security: `partial_update` role-change was vulnerable to a TOCTOU race where a
  concurrent demotion of the actor could allow assigning a role equal to or higher than
  the actor's effective role at save time — fixed with `SELECT FOR UPDATE` inside
  `transaction.atomic()`.
