# ADR-0030: P3M Navigation Shell Split — OSS Single-Program vs. Enterprise Portfolio Landing

## Status
Proposed

## Context

The current OSS frontend has no project overview/dashboard page. After login, users are
redirected to `/gantt` (`router.tsx` catch-all). There is no `/projects/:id/overview` route,
no KPI summary, and no "Needs your attention" surface.

The P3M UI proposal (docs/ux/p3m-vs-oss-views.md, 2026-04-14) defines two intentionally
distinct homepages:

1. **OSS Single-Program view** (`/projects/:id/overview`) — optimised for a PM running
   one project. Medium density, mobile-first. Answers "what's late, who's overloaded,
   what's next" within 5 seconds.

2. **Enterprise P3M Portfolio view** (`/portfolios/:id`) — optimised for a PMO director
   coordinating many projects, shared resources, and demand intake. High density, desktop-first.

The VoC panel (score 7.2/10), UX Review, and UX Design reviews surfaced five open questions
that must be resolved at architecture time (not implementation time). This ADR resolves all five
and specifies the routing strategy, landing decision tree, breadcrumb model, drill-down
interaction model, and mobile portfolio strategy.

This ADR depends on ADR-0029 (Frontend Slot Registry) for the Enterprise portfolio route
injection mechanism. It does not depend on any Enterprise data model — Portfolio and Program
entities are Enterprise concerns specified separately.

## Decision

### 1. OSS: add `/projects/:id/overview` as the single-program dashboard

A new route is added to `router.tsx`:

```
/projects/:id/overview   →  ProjectOverviewPage
/projects/:id/schedule   →  (existing Schedule view, renamed from current default)
/projects/:id/tasks      →  (existing task list)
/projects/:id/board      →  (existing board)
/projects/:id/           →  redirect to /projects/:id/overview
```

The default authenticated redirect changes from `/schedule` to `/projects/:lastVisitedId/overview`
(or to the project selection screen if no project exists yet).

`ProjectOverviewPage` is an OSS component in `packages/web/src/features/project/`. It renders:
- 4 KPI cards: Schedule health (CPI/SPI — two metrics on one card; SPI takes priority if worse),
  Tasks late, Next milestone, Team utilization
- Hero row (2/3): 4-week Schedule mini-preview (read-only; "Open full Schedule →" link required)
- Hero row (1/3): "Needs your attention" panel
- Bottom row: "My tasks this week" (60%) | "Recent activity" (40%)
- Slot: `project_overview.kpi_row` — enterprise can inject additional KPI cards to the right
- Slot: `project_overview.hero_right` — enterprise can replace/extend the attention panel
- Slot: `project_overview.below_hero` — enterprise can inject rows below the hero

The sidebar gains a top-level "Overview" item (active on this route) and the project switcher
moves from the nav foot to the top of the sidebar, below the project name.

### 2. Enterprise: register `/portfolios/:id` via the slot registry

The Enterprise overlay registers a route for the portfolio view via
`registry.register('routes', ...)` (ADR-0029). The portfolio view is entirely an Enterprise
concern and is implemented in `trueppm-enterprise:packages/enterprise-web/`.

### 3. Landing decision tree (post-login redirect)

```
if edition === 'enterprise'
    AND user has access to ≥ 1 portfolio
    AND that portfolio has ≥ 2 active projects
  → redirect to /portfolios/:defaultPortfolioId
else if user has ≥ 1 project
  → redirect to /projects/:lastVisitedProjectId/overview
else
  → redirect to /projects/new  (onboarding)
```

The `≥ 2 projects` threshold is configurable via `TRUEPPM_PORTFOLIO_LANDING_MIN_PROJECTS`
Django setting (default: 2). Enterprise customers can set it to 1 to always land on the
portfolio view.

This resolves **open question 1** (should a single-project enterprise user land on OSS or
portfolio view? → OSS, with configurable override).

### 4. Breadcrumb: portfolio context when OSS view accessed from enterprise

When a user navigates from the Enterprise portfolio view into a specific project (via
drill-down drawer — see §5 below), the OSS `ProjectShell` receives an optional
`portfolioContext: { id, name, url }` prop injected by the Enterprise drill-down component.

The `TopBar` renders a breadcrumb when `portfolioContext` is present:

```
[Portfolio Name]  /  [Project Name]  ·  Active
```

The portfolio name is a link back to `/portfolios/:id`. The breadcrumb is purely navigational
chrome — no enterprise data is fetched by OSS components. The `portfolioContext` prop is
passed via React Router state (`location.state.portfolioContext`), so it is present only when
navigating from the portfolio view and is absent on direct URL access.

This resolves **open question 3** (does OSS show a breadcrumb when accessed from enterprise?
→ yes, via router state, no enterprise imports in OSS).

### 5. Drill-down: inline drawer with URL parameter

Portfolio-to-project drill-down uses an **inline drawer** with a URL change:

```
/portfolios/:portfolioId?project=:projectId
```

The drawer is 480px wide on desktop (leaves the portfolio bubble chart readable and interactive
behind it). On tablet (768–1024px) the drawer is full-width. The URL change ensures the state
is shareable, bookmarkable, and that browser Back works correctly.

The drawer renders a scoped project summary (health score, critical path, next milestone,
"Needs attention" list) — **not** the full OSS `ProjectShell`. A "Open project" button in the
drawer header navigates to `/projects/:projectId/overview` (full page) with portfolio context
in router state (for the breadcrumb in §4).

The focused bubble/row in the portfolio view is highlighted (2px ring, brand indigo) while
the drawer is open. Clicking a second project while a drawer is open replaces the drawer
content without closing and reopening it.

This resolves **open question 2** (full-page nav or inline drawer? → drawer with URL change).

### 6. Mobile portfolio: decision queue + health chip

On screens ≤ 768px, the Enterprise portfolio view renders:

- A health summary chip strip: `[3 red] [5 amber] [16 green]` — tap any chip to filter
  the decision queue below it
- A scrollable decision queue (full screen width)
- An "Approve" / "Defer" action button on each decision queue item (not read-only)
- A "View full dashboard →" nudge at the top (opens desktop URL)

The bubble chart, resource heat map, cross-project dependency table, and demand capacity
bars are hidden on mobile (≤ 768px). The health chip strip provides enough situational
context to ground decision approvals. The decision queue is **not** read-only on mobile —
approving decisions is the primary mobile workflow.

This resolves **open question 4** (mobile portfolio = decision queue + health chip, with
approve/defer actions, not read-only).

### 7. Enterprise widget plugin hooks: ADR-0029 is the mechanism

The extension mechanism is fully specified in ADR-0029. This ADR references it but does not
re-specify it. The Enterprise portfolio route, nav section, and any OSS overview slot
registrations all use the slot registry from ADR-0029.

This resolves **open question 5** (enterprise widgets via OSS plugin hooks → ADR-0029 slot
registry; an ADR now exists).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Slot registry route injection (chosen)** | Clean OSS boundary; Enterprise owns its route | Requires ADR-0029 implementation first |
| Two separate apps (OSS and Enterprise are different Vite entry points) | Complete isolation | No shared component code; double maintenance burden |
| Single configurable shell with edition flag | Simple | `if (edition === 'enterprise')` checks in OSS — violates boundary |
| Full-page nav for portfolio drill-down | Simpler implementation | Destroys portfolio context; back-button confusion |
| iframe embed for enterprise widgets | Maximum isolation | Terrible performance; broken shared state; z-index nightmares |

## Consequences

**Easier:**
- OSS users get a proper project dashboard landing (currently missing entirely)
- Enterprise portfolio view has a clear, specified interaction model before implementation
- All five UX design open questions are resolved — implementation can begin without design ambiguity
- The breadcrumb model is zero-cost for OSS (router state, no extra API calls)

**Harder:**
- Two new pages must be designed and built (OSS overview + Enterprise portfolio landing)
- The slot system (ADR-0029) must ship before any enterprise widget can be implemented
- The landing redirect logic has an API dependency (`useEdition()` + portfolio project count)
  — this adds a fetch on first load. Mitigate with aggressive caching (SWR, stale-while-revalidate)

**Risks:**
- The `≥ 2 projects` landing threshold is a product decision with UX consequences. If the
  threshold is wrong (e.g., a 1-project enterprise customer always lands on a near-empty
  portfolio view), it will hurt adoption. Make the threshold configurable from day one.
- Drawer state (`?project=`) adds URL complexity. If a user shares a URL with `?project=`
  to someone without enterprise access, the OSS app receives a URL param it does not handle.
  OSS must silently ignore the `?project` param.
- Mobile decision queue approve/defer actions require the Enterprise decision queue to have
  a mobile-responsive action design. This must be specced in the Enterprise UX design pass
  for that feature.

## Implementation Notes

- **P3M layer:**
  - OSS overview page: Programs and Projects layer
  - Enterprise portfolio view: Portfolios layer
  - Landing decision tree: spans both (reads edition + portfolio project count)
- **Affected packages:**
  - `packages/web` (OSS): new `ProjectOverviewPage`, updated `router.tsx`, updated
    `TopBar.tsx` (breadcrumb), updated `Sidebar.tsx` (project switcher position + Overview item)
  - `packages/api` (OSS): no changes beyond ADR-0029's edition endpoint
  - `trueppm-enterprise:packages/enterprise-web`: portfolio route, drawer component,
    mobile decision queue, widget registrations
- **Migration required:** No
- **API changes:** New OSS endpoints required for the overview page:
  - `GET /api/v1/projects/:id/overview/` — aggregated KPIs (CPI/SPI, late task count, next
    milestone, utilization). Must be ≤ 200 ms at p95 for 500 tasks; use `select_related` +
    `annotate` — no N+1.
  - `GET /api/v1/projects/:id/attention/` — attention list items (at-risk tasks, overallocated
    resources, unassigned tasks near start date, baseline drift). Curation rule: ordered by
    severity (critical path impact > resource conflict > unassigned > drift).
  - `GET /api/v1/projects/:id/my-tasks/` — tasks assigned to the requesting user, due within
    the current calendar week (Mon–Sun), ordered by due date.
- **OSS or Enterprise:** OSS for the overview page and API endpoints. Enterprise for the
  portfolio view and drill-down drawer.
- **Durable execution:** N/A (all read-only API calls)
- **OSS boundary verification:** After implementing, confirm `grep -r "trueppm_enterprise" packages/`
  returns zero. The portfolio breadcrumb uses only `location.state` (no enterprise import).
- **Charting library:** The Schedule mini-preview in the OSS overview must use the existing
  canvas renderer (`GanttRenderer.ts`) in a constrained/read-only mode, not a new library. The Enterprise
  bubble chart and heat map require Recharts (already approved in ADR-0022 for burn charts).

## Tracking

Tracking: deferred — not yet filed.
