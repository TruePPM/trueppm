# ADR-0348: Mobile-first Schedule surface (DOM list-timeline)

## Status
Proposed

## Context

On a phone (`< md`, matchMedia `max-width: 767px`) the Schedule view renders the
exact same desktop canvas Gantt forced into full-width Timeline mode. Issue #1670
(and its follow-up quick-win #1787 / MR !1211) made that *usable* — the canvas now
fits-to-project on open and the toolbar collapses so nothing clips — but it is still
the desktop canvas: tiny bars, horizontal-pan-only, 12px labels, no touch affordances,
and no row context (you cannot read a task name and its dates at a glance without
panning). #1670's own follow-up, #1671, asks for a **dedicated mobile-first Schedule
surface** in the spirit of `MobileBoard` (web-rule 193): a reflow gated behind
`isMobile`, not the desktop split-pane.

**P3M layer:** Programs and Projects (single project schedule) → **OSS**. This is
execution-surface work a PM/contributor needs to run one program from a phone; it
aggregates nothing across projects, so it does not approach the Enterprise boundary.

**VoC gate (8-persona panel, run on #1787):** average 3.6/10, but the low scores are
portfolio/backlog/allocation/native-offline personas (Marcus, Janet, Jordan, David,
Sarah's offline hard-NO) correctly scoring a single-project read surface low — all
discounted per the release-window notes (portfolio → Enterprise; native offline →
0.4 native app). The one load-bearing blocker is **Sarah's read-only 🔴** ("if I can
see it on my phone I will try to fix a date on my phone, and if it silently fails
that's worse than read-only") and **Morgan's 🟡** (explicit read-only, no per-person
hours on the schedule). Both are resolved by decision #3 below.

**Forces:**
- The desktop canvas engine (`GanttEngineImpl`, `GanttRenderer`, `GanttScaleData`,
  three-canvas stack) is a large, dirty-rect / virtualization-tuned system (web-rules
  59–85) built for a mouse: hover chains, double-click-to-open, pixel pan/zoom. None
  of that is touch-native, and its rules are canvas-specific.
- Every datum a phone needs is already a **server fact** surfaced by the existing
  `useScheduleTasks()` hook (task dates, `%complete`, `isCritical`, `isMilestone`,
  `isSummary`, `status`, `canEdit`, `plannedStart`) and `useMonteCarloResult()`
  (P50/P80/P95). Nothing a phone needs is computed only inside the canvas engine.
- TruePPM is mobile-first and mobile is on the 1.0 critical path.

## Decision

Build a **new DOM/CSS list-timeline component**, `features/schedule/mobile/MobileSchedule`,
gated behind the existing `isMobile` flag as a mutually-exclusive sibling to the desktop
canvas tree (exactly the `MobileBoard` pattern, web-rule 193). **The canvas engine stays
desktop-only and is not touched.**

The surface is a vertically-scrolling, WBS-ordered task list. Each row is a ≥44px touch
target showing: WBS-indented task name, planned start→finish (via `fmtUtcShort`,
ADR-0144), a compact inline **mini-timeline strip** (bar position/width proportional to
a single shared project-window scale), `%complete` progress fill, and a
grayscale-safe critical indicator on the bar's **border, not fill** (web-rules 234/235).
Milestones render as a diamond marker; summary tasks as a span bracket. An
**Unscheduled tray** (reusing the `useUnscheduledTasks` filter) is a collapsible section
at the top. The mobile **Monte Carlo card/sheet** (`MobileMonteCarloCard`, already
`md:hidden`) stays pinned at the bottom, labeled as a **CPM-based** confidence forecast
(Jordan 🟡), schedule-confidence-only with **no per-person logged hours** (Morgan 🟡,
ADR-0104 privacy).

**Data source (decision #2): API-first, no new endpoint.** The surface reads the same
server facts the canvas reads — `useScheduleTasks()` (`GET /tasks/`, `GET /dependencies/`)
and `useMonteCarloResult()` (`GET /projects/{id}/monte-carlo/latest/`). "Unscheduled" is
the existing client rule (`useUnscheduledTasks`: status NOT_STARTED|BACKLOG ∧
`plannedStart == null` ∧ not summary ∧ not sprint-committed). No datum a phone needs is
canvas-only.

**Read/navigate with delegated online edits (decision #3 — resolves Sarah's 🔴).** The
mobile schedule surface is **read/navigate**: it does not offer inline reschedule or
drag-to-schedule (honors Morgan's explicit-read-only 🟡 and avoids fat-finger date
corruption). Editing is delegated to the **existing `TaskDetailDrawer`**, which already
ships a mobile 85vh bottom-sheet shell and is already mounted in `ScheduleView` driven by
`scheduleStore.selectedTaskId`. A row tap calls `setSelectedTaskId(task.id)` → the drawer
opens → edits there are `canEdit`-gated and go through the normal optimistic
`useUpdateTask` path **when online**. This also fixes a real gap: today the drawer opens
**only** via canvas double-click (`GanttEngineImpl` `task-open`), so on a phone there is
currently no way to open it at all. Additionally, a leaf task offers an optional **one-tap
complete** control (`useToggleComplete`, checkpop + warm toast wired at the call site per
web-rule 184, INTO-complete only). **Offline schedule writes are deferred to the 0.4
native app** — duplicating an IndexedDB schedule-write queue on web is wasted effort
against the native offline story and the ADR-0217 conflict surface, and Sarah's offline
hard-NO is a known, accepted pre-native gap.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. New DOM list-timeline (chosen)** | Touch-native, accessible (real DOM nodes, screen-reader rows), simple, reuses all data + the drawer; canvas untouched so zero desktop-regression risk | Duplicates a *little* timeline-math (a single shared scale to place bars) |
| B. Reuse the canvas engine, reconfigured/scaled for mobile | No timeline-math duplication | The engine's virtualization/dirty-rect rules (59–85) are canvas-and-mouse-specific; touch pan/zoom, hit-testing, and label density would need a parallel touch path *inside* the engine — far more complex and couples mobile to the desktop renderer's regression surface. Rejected. |
| C. Keep #1787's fitted-canvas quick-win, do nothing more | Zero new code | Still tiny bars, pan-only, no row context, no tap-to-open; #1671 remains open; fails the mobile-first 1.0 bar |
| D. Read-only, no edit delegation at all | Smallest scope; trivially honors Sarah/Morgan | Leaves the "I can see it but can't even open it" gap; a contributor on a job site can't mark their task done — misses the one write that matters most on a phone |

## Consequences

**Easier:**
- A PM/contributor can read the whole schedule at a glance on a phone (row context:
  name + dates + progress + critical, no panning), open any task, and complete their own.
- The canvas engine is now unambiguously desktop-only; mobile changes can never regress it.
- The drawer's mobile tap-to-open gap is closed for the schedule surface.

**Harder / risks:**
- A second, DOM-based timeline placement math exists alongside the canvas scale. Mitigated
  by keeping it deliberately dumb: one shared linear scale over
  `[min(start), max(finish)]`, no zoom, no per-row scale — placement is a percentage, not a
  pixel engine.
- Two schedule code paths to keep in sync when the data shape changes. Mitigated because
  both read the identical `useScheduleTasks` `Task[]` — a field change flows to both.
- MR !1211's mobile fit-to-project + toolbar-collapse (on `ScheduleView`'s canvas mobile
  branch) becomes **dead on the mobile path** once this lands, because mobile no longer
  renders the canvas. This is expected and fine (it stays as the `< md` desktop-canvas
  fallback if the mobile tree is ever disabled); note it at merge so it isn't re-litigated.

## Implementation Notes

- **P3M layer:** Programs and Projects (single-project execution) — OSS.
- **Affected packages:** web only.
- **Migration required:** no.
- **API changes:** none — reuses `GET /tasks/`, `GET /dependencies/`,
  `GET /projects/{id}/monte-carlo/latest/`. Confirms API-first; the surface is a pure
  consumer, no privileged path.
- **OSS or Enterprise:** OSS (`trueppm-suite`).
- **Mount:** in `ScheduleView`, branch the timeline region on the existing `isMobile`:
  render `<MobileSchedule … />` instead of the canvas scroll container + `UnscheduledGutter`
  (mobile owns its own unscheduled tray); suppress the desktop Gantt toolbar on mobile and
  render a minimal mobile action row (+ Task, gated `!readOnly`). Keep the shared mounts
  (`TaskDetailDrawer`, `MobileMonteCarloCard`, toasts, dialogs) outside the branch. Desktop
  render path is byte-for-byte unchanged (new tree behind `isMobile`, never restyle the
  canvas — web-rule 193 discipline).
- **File tree:** `packages/web/src/features/schedule/mobile/MobileSchedule.tsx` (+ a small
  `MobileScheduleRow` and a shared-scale helper), colocated `*.test.tsx`, and a Playwright
  spec `packages/web/e2e/mobile-schedule.spec.ts` at 375px.

### Durable Execution
1. **Broker-down behaviour:** N/A — the surface is read + it delegates writes to existing
   mutation hooks (`useUpdateTask`, `useToggleComplete`) that already own their durability
   story (optimistic + 409 conflict handling, ADR-0217). No new dispatch path is introduced.
2. **Drain task:** N/A — no new async category; edits reuse the existing task-mutation path.
3. **Orphan window:** N/A — no outbox rows written by this surface.
4. **Service layer:** N/A — no server-side code. Client writes go through the existing
   `useTaskMutations` hooks; CPM recalculation (if a delegated edit changes dates) is
   already enqueued server-side by the task PATCH endpoint via
   `scheduling/services.py::enqueue_recalculate()`, unchanged.
5. **API response on best-effort dispatch:** N/A — no new endpoint; the reused PATCH
   returns its existing synchronous response.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** N/A for new server work. The delegated `useToggleComplete` /
   `useUpdateTask` are already idempotent (LWW / ADR-0217 field-level merge keyed on
   `baseVersion`); a duplicated toggle-to-complete is a no-op (status already COMPLETE).
8. **Dead-letter / failure handling:** N/A — no new task. A failed delegated edit surfaces
   through the existing optimistic-rollback + toast path; offline schedule writes are
   deferred to native (accepted gap), so there is no queued-write failure mode on this
   surface.
