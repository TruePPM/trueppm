# ADR-0050: Task Detail Drawer Section Extension Points

## Status: Accepted

## Amendment (2026-06-11, #1046) — `userRole` in `DrawerSectionProps`

`DrawerSectionProps` gains an **optional** `userRole?: number | null` field (the
viewer's project role ordinal from `@/lib/roles`, `null` while it resolves). The
drawer computes it once via `useCurrentUserRole(projectId)` and threads it to every
registered section. Sections that render write controls (OSS `ExternalLinksSection`,
`AttachmentSection`, and the inline Description field) hide those controls from
Viewers via the shared `canEditTask(role)` helper instead of surfacing affordances
that 403 on submit.

This is **backward-compatible** with the extension-point contract: the field is
optional, so every existing OSS and Enterprise section registration that does not
read it is unaffected. The server still enforces permission on write — this is the
UX gate only. No change to the slot priority ladder or registration shape.

## Context

The redesigned `TaskDetailDrawer` (issue [#306](https://gitlab.com/trueppm/trueppm/-/work_items/306), per the May 2026 design handoff) hosts seven OSS sections — Overview, Dependencies, Activity, Subtasks, Attachments, Comments, Recurring tasks — plus the existing Estimates / History / Baseline tabs that survive the redesign, plus at least one Enterprise section (Custom Fields, [`trueppm/trueppm-enterprise#59`](https://gitlab.com/trueppm/trueppm-enterprise/-/work_items/59)).

The current drawer (`packages/web/src/features/schedule/TaskDetailDrawer.tsx`, ADR-0032) hardcodes its tabs and panel content (TABS array at lines 11–16; rendering at 253–307). The Apache 2.0 boundary forbids OSS from importing `trueppm_enterprise`, so Enterprise sections must register themselves *into* the OSS drawer rather than the drawer reaching out.

ADR-0029 already established the `WidgetRegistry` pattern (`packages/web/src/lib/widget-registry.ts`) for cross-edition slot extension. ADR-0049 reused it for task links, outgoing channels, and notifications. This ADR extends the same registry to drawer sections — no new infrastructure.

P3M layer: **Programs and Projects** (single-task scope on both sides of the boundary). The registry mediates the edition boundary, not the data scope.

## Decision

Add a single new slot to the existing `WidgetRegistry`:

```ts
// packages/web/src/lib/widget-registry.ts
export type SlotId =
  | …existing slots…
  | 'task_detail.section'   // sections inside TaskDetailDrawer
```

Define a typed registration shape for drawer sections (extends the existing `SlotRegistration`):

```ts
export interface DrawerSectionRegistration {
  id: string                                   // unique within the slot, e.g. 'custom-fields'
  title: string                                // tab label or collapsible header
  priority: number                             // ascending = earlier
  component: ComponentType<{ taskId: string; projectId: string }>
  canRender?: (ctx: { user: User; task: Task }) => boolean   // default: always render
}
```

The redesigned drawer reads `registry.get('task_detail.section')` and renders sections in priority order. The shell (tabbed vs collapsible single-scroll) is decided in #306's `ux-design` step — the registration shape is layout-agnostic; both shells consume the same `{ title, component }` pair.

OSS sections register at module init (`packages/web/src/features/schedule/sections/index.ts`, side-effect import from `TaskDetailDrawer.tsx`). The Enterprise package registers its sections in its own init module when installed.

### Priority allocation (OSS reserves multiples of 100)

| Priority | Section | Issue |
|----------|---------|-------|
| 100 | Overview | #306 |
| 200 | Dependencies | #306 |
| 300 | Subtasks | #308 |
| 400 | Attachments | #310 |
| 500 | Comments | #311 |
| 600 | Activity | #307 |
| 700 | Recurring | #312 |
| 800 | Estimates | preserved (ADR-0032) |
| 900 | History | preserved |
| 1000 | Baseline | preserved |

Enterprise picks priorities between OSS values (e.g. Custom Fields at 250, between Dependencies and Subtasks). Reserve multiples of 100 for OSS; Enterprise uses any other integer.

### Open questions resolved

1. **Registry mechanism** — reuse `WidgetRegistry` (ADR-0029). No new mechanism. Avoids module federation, plugin manifests, dynamic imports.
2. **Data plumbing** — sections own their fetchers. The drawer passes only `taskId` and `projectId`. Each section runs its own TanStack Query hook against its own API endpoint. Enterprise endpoints live in `trueppm-enterprise`. Matches how `useTaskHistory` / `useTaskBaseline` already work.
3. **Ordering** — numeric priority (existing `WidgetRegistry` field). Documented OSS / Enterprise convention above.
4. **Mobile** — out of scope for milestone 0.1. Mobile drawers (`RiskDrawer`, `ResourceOverallocationDrawer`) share content components between desktop side-panel and mobile bottom-sheet shells; extending that pattern to `TaskDetailDrawer` is a separate refactor. When mobile picks up, it will read from the same `WidgetRegistry` — no second registry. File a follow-up against milestone 0.2.
5. **Permission gating** — section-internal by default. The optional `canRender(ctx)` predicate hides a section entirely when it shouldn't appear at all (e.g. unlicensed feature). Control-level gating (`+ Add field` visible only to admins) is the section's own responsibility.

### Fetcher contract (what an extension-point section must declare)

"Sections own their fetchers" (Q2) requires a contract so that registry-driven sections
remain API-first and cache-coherent. A section that fetches data must declare:

1. **Endpoint** — a named REST path it reads from, expressed in the API-first form
   `<METHOD> /api/v1/...` (e.g. the History section reads
   `GET /api/v1/projects/{projectId}/tasks/{taskId}/history/`; the Baseline section reads
   the baseline detail route). A section may not invent an implicit data source — if the
   data is not behind a REST endpoint, it does not exist (CLAUDE.md API-first principle).
   Enterprise sections name endpoints that live in `trueppm-enterprise`.
2. **Cache key** — a stable, documented TanStack Query key namespaced by the section so
   two sections never collide and invalidation is predictable, e.g.
   `["task-history", projectId, taskId]`, `["task-baseline", projectId, taskId]`. The key
   must include `taskId` (and `projectId` where the endpoint is project-scoped) so the
   drawer can invalidate per-task on mutation.

The drawer passes only `taskId` and `projectId` into the section; everything else (auth
headers, base URL) flows through the shared API client. Sections that only render props
already in the drawer context declare no fetcher.

### Error containment

Each registered section is wrapped in a React error boundary in the drawer. A render failure in one section produces a contained "Section unavailable" message and reports to the existing client error sink; the rest of the drawer remains usable.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Extend existing `WidgetRegistry`** (chosen) | Zero new infrastructure. Matches ADR-0029 / 0049. Single registry across edition surfaces. | `SlotRegistration` shape grows to support drawer-specific fields (`title`, `canRender`). |
| New `DrawerSectionRegistry` | Strong typing for drawer-specific concerns. | Two registries to learn. Direct contradiction of ADR-0029's "one registry" stance. |
| Module federation / dynamic import | Enterprise could ship as a runtime-loaded chunk. | Vite + module federation is brittle; complicates dev/test/build infra; Enterprise is bundled at build time anyway via path-dep (E-0005). |
| `DrawerSlot` React-context render-prop | Idiomatic React. | Re-implements the registry; harder to introspect ("what sections exist?"). |

## Consequences

**Easier**
- Adding a new section (OSS or Enterprise) = one `register` call.
- Re-ordering = changing one priority number.
- Conditional visibility = `canRender` predicate.
- The new redesign in #306 directly consumes this — no parallel mechanism, no future "extension point retrofit" issue.

**Harder**
- Sections cannot share state directly — must go through TanStack Query cache or Zustand stores. (This was already the case; named here for clarity.)
- Priority collisions if Enterprise picks an OSS-reserved value. Mitigated by the convention table above and a code comment on the SlotId.

**Risks**
- **Registration timing.** Enterprise must register before the drawer first renders. Mitigated by the existing `WidgetRegistry` pattern — `HeatmapPage` already relies on init-time registration (ADR-0042).
- **Buggy Enterprise section.** Mitigated by per-section React error boundary; never crashes the drawer.

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** `web`
- **Migration required:** no
- **API changes:** no — sections add their own endpoints in their own packages (separate ADRs as needed)
- **OSS or Enterprise:** OSS. The mechanism is OSS; Enterprise consumes it.
- **Files touched on implementation of #309:**
  - `packages/web/src/lib/widget-registry.ts` — add `task_detail.section` to `SlotId`; extend or specialize `SlotRegistration` for drawer sections
  - `packages/web/src/features/schedule/TaskDetailDrawer.tsx` — replace hardcoded `TABS` and panel rendering with `registry.get('task_detail.section')` driven loop, wrapped in error boundaries
  - `packages/web/src/features/schedule/sections/index.ts` — new file; OSS section registrations
  - Vitest unit test demonstrating a sample registered section without enterprise code (per #309 acceptance criteria)

### Durable Execution

Frontend-only registration mechanism. No server-side dispatch.

1. **Broker-down behaviour:** N/A — pure client-side React registry; no Celery dispatch.
2. **Drain task:** N/A — no async work.
3. **Orphan window:** N/A — no DB-backed outbox.
4. **Service layer:** N/A — registry is a singleton in `packages/web/src/lib/widget-registry.ts`; ADR-0029 documents its API.
5. **API response on best-effort dispatch:** N/A — section data fetches are owned by individual sections; their durability is in scope for those features' ADRs.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** registry registrations are idempotent by `id` — re-registering the same `id` replaces the prior entry (existing `WidgetRegistry` behaviour).
8. **Dead-letter / failure handling:** each registered section is wrapped in a React error boundary. Render failure produces a contained per-section "Section unavailable" message and reports to the existing client error sink; the drawer remains usable. No retry; user can refresh.
