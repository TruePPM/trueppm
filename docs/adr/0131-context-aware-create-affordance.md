# ADR-0131: Context-Aware, Role-Aware "+ New" Affordance + Create-Intent Dispatch

## Status
Accepted (2026-06-15)

## Context

Epic #1163 (v2 redesign) deferred the **"+ New"** action out of the context bar (#1177 /
ADR-0127) because a *generic* create button tested badly with the VoC panel: a create from
program-level chrome could **silently inject scope into an active sprint** (Alex/Morgan
hard-NO), it read as "PM-y UI" (Priya), and it was ambiguous (Jordan wanted a
*context-aware* create, not a generic task/WBS dialog). #1179 adds it back — but
**context-aware, role-aware, and sprint-safe**.

**P3M layer:** Programs and Projects / Operations (per-user create of project-level work
items) → **OSS**. No portfolio aggregation; no cross-program surface.

**The crux (already scoped).** The `ContextBar` always renders and has a trailing slot, but
**no create flow is imperatively launchable today** — `NewProjectModal`, `TaskFormModal`
(task & milestone), the backlog story quick-add, and the risk drawer are each owned by local
`useState` inside their views. So the central decision is *how a chrome-level button triggers
a create that lives inside (or independent of) a view*.

**VoC** (5 OSS personas this serves): Alex 8🟢, Morgan 7🟢, Jordan 7🟡, Priya 6🟡, Sarah 6🟡
— avg 6.8, no in-scope 🔴. Drivers: the sprint-safe gate must be *real, visible, team-owned*
(satisfied by ADR-0102); **suppress + New on My Work** and use plain labels, no WBS jargon
(Priya); backlog→story must respect the existing epic/story hierarchy (Jordan); show which
project it creates into (Sarah — the breadcrumb already does).

## Decision

### A. Dispatch mechanism — a centralized create-intent store + `<CreateDispatcher>` (chosen)

A tiny Zustand store is the single entry point for "create X", and a single
`<CreateDispatcher>` mounted once in `AppShell` owns the **self-contained** create modals.
**View-coupled** create flows (inline backlog quick-add) subscribe to the same store.

```ts
// stores/createIntentStore.ts
type CreateIntent =
  | { kind: 'task'; projectId: string; isMilestone?: boolean }
  | { kind: 'project'; programId?: string }
  | { kind: 'story'; projectId: string };
interface CreateIntentState {
  intent: CreateIntent | null;
  open(intent: CreateIntent): void;   // replaces any prior intent
  close(): void;                       // cleared on modal close / consume
}
```

- **`<CreateDispatcher>` (AppShell) owns the modal targets** — `task`/`isMilestone` →
  `TaskFormModal` (`task={null}`, **no `defaultSprintId`** — see §D); `project` →
  `NewProjectModal` (with `programId` when present). These modals are already self-contained
  (props only), so the dispatcher renders them driven by the store — no need to lift the
  views' own local create state (their inline "+ Add task" buttons stay untouched). This is
  **additive**, not a rip-out.
- **View-coupled target** — `story` is the inline `createBacklogStory` quick-add (no modal).
  `ProductBacklogPage` subscribes to the store: when `intent.kind === 'story'` for the
  mounted project, it focuses (and scrolls to) its existing quick-add input. The ContextBar,
  on a non-backlog route, navigates to `…/product-backlog` first, then sets the intent (the
  store persists it until the newly-mounted page consumes it).
- **Why not the alternatives:** navigate-and-auto-open (B) forces a navigation even when
  already on the right view and spreads "read an open-create signal" logic across every view;
  ContextBar-owns-the-modals (C) couples the shell chrome to every feature modal. (A) is the
  lowest-coupling, and the store is **reusable by the ⌘K command palette** (#1166, already
  shipped) to register "Create task/story/project" commands later.

### B. Route → create-target resolver + button shape

A pure `resolveCreateIntent(pathname, { projectId, programId })` → `CreateTarget[] | null`:

| Route | Target(s) | Button |
|---|---|---|
| `/projects/:id/board`, `/grid`, `/sprints` | Task | "New task" (single) |
| `/projects/:id/schedule` | Task, Milestone | "New ▾" → menu (Task / Milestone) |
| `/projects/:id/product-backlog` | Story | "New story" (single) |
| `/programs/:id/*` | Project | "New project" (single) |
| **everything else** | — | **suppressed** |

**Suppress list** (button renders nothing): `overview`, `calendar`, `resources/*`, `reports`,
`settings/*`, `/me/*` (Priya — My Work is read/contributor surface), `/risk` (see §E),
unscoped workspace root (the Sidebar owns workspace project-create), and any route with no
resolved target. A single primary button when one target resolves; a `role="menu"` dropdown
only when >1 (Schedule = Task/Milestone). Labels are **plain language** ("New task" / "New
story" / "New project"), never "Add to WBS" or sprint jargon (Priya).

### C. RBAC gate per target — hidden, never disabled

The button is **absent from the DOM** when the user can't create the resolved target or no
target resolves (conditional-affordance rule — never a dimmed dead control). Gate per target:

| Target | Gate (hook) |
|---|---|
| Task / Milestone | `canEditTask(role)` = `role >= MEMBER` (`useCurrentUserRole`) |
| Story | `useCanManageBacklog` (ADMIN+ or PO) |
| Project (program route) | program-management capability — `useCanManageScope`-equivalent at program level; if no clean program-role hook exists, match the Sidebar's existing project-create gate and file a shared follow-up (do **not** ship an ungated 403-prone create) |

While the role query is loading (`role === null`), the button is hidden (pessimistic — same
posture as `ViewTabs`' Team gate).

### D. Sprint-safe contract

The ContextBar **never pre-assigns a sprint**: a `task` intent carries no sprint, so
`TaskFormModal` opens with `defaultSprintId` undefined → the task is created **unassigned** →
**no injection**, on every route including `/sprints`. The *deliberate-decision path* is the
user explicitly picking the active sprint in the form's own sprint selector → the server
creates a **pending `SprintScopeChange`** (ADR-0102) that surfaces as the team-visible
`PendingAcceptanceChip` + `BoardScopeInjectionBanner`, accept/reject gated by
`useCanManageScope`. This makes the affordance sprint-safe by construction — it cannot become
the silent PM side-door the panel feared, because it has no path that pre-selects a sprint.

### E. Out of scope (kept tight)

- **Risk create** — the Risk view already has a prominent "New risk" toolbar button + mobile
  FAB; a ContextBar duplicate is low-value. `/risk` is on the suppress list; revisit as a
  follow-up if VoC asks.
- **My Work create** — suppressed (Priya). Cross-project create needs a project picker; out
  of scope.
- **"Story under the focused epic"** (Jordan 🟡) — v1 routes to the existing quick-add (which
  creates a story respecting the existing epic/story hierarchy); auto-parenting to a focused
  epic is a backlog-page nicety, a follow-up.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Create-intent store + `<CreateDispatcher>` (chosen)** | Lowest coupling; create launchable from anywhere; reusable by ⌘K; additive (views untouched) | One new store + dispatcher component; story is a view-subscribe special case |
| B. Navigate-to-view + auto-open signal | No new modal ownership | Forces navigation even when already on-view; spreads open-create logic into every view; awkward for Project (no single view) |
| C. ContextBar owns all the modals | No store | Couples shell chrome to every feature modal; ContextBar balloons; not reusable |

## Consequences
- **Easier:** one place to launch any create; the ⌘K palette can reuse it; sprint-safety is
  structural (no sprint pre-assignment path exists).
- **Harder:** a new store + dispatcher to maintain; `ProductBacklogPage` gains a small store
  subscription for the story target.
- **Risks:** *partial gating* — every target's button must derive visibility from its gate
  (ux-review gating-completeness); the resolver+gate are pure and unit-tested. *Stale intent*
  — the store clears on modal close/consume so a dismissed create can't re-fire. *Project
  gate ambiguity* — addressed in §C (match Sidebar + follow-up rather than ship ungated).

## Implementation Notes
- **P3M layer:** Programs and Projects / Operations.
- **Affected packages:** web only.
- **Migration required:** no.
- **API changes:** no — composes existing create endpoints (`useCreateProject`, the
  `TaskFormModal` POST, `createBacklogStory`) and existing RBAC hooks.
- **OSS or Enterprise:** OSS. Per-user create affordance; no portfolio/cross-program surface.
- **Relationship to ADR-0127:** extends the context bar with the create slot ADR-0127
  explicitly deferred; does not change ADR-0127's breadcrumb/theme/rail decisions.

### Durable Execution
1. Broker-down behaviour: **N/A** — frontend-only; the underlying create endpoints own their
   own durability (unchanged by this ADR).
2. Drain task: **N/A** — no new async work.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — reuses existing create mutations.
5. API response on best-effort dispatch: **N/A** — no new endpoint; creates are synchronous
   as today.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — the resolver/gate are pure; the store holds at most one intent and
   clears on consume, so a create can't double-fire from a stale intent.
8. Dead-letter / failure handling: **N/A** — a failed create surfaces in its existing
   modal's error state (unchanged).
