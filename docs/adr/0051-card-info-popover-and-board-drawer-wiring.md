# ADR-0051: Card Information Popover and Board Drawer Wiring

## Status

Accepted (2026-05-05) — supersedes the unimplemented ADR-0032 click-target portion of issue #265.

## Context

Issue #304 introduces a new primary interaction on board cards: clicking a card opens
a quick-summary popover anchored to the card. The popover surfaces readiness, critical-path,
WBS, status, dates, duration, float, assignees, and (variation B) a "blocked by" list.
Footer actions: **Open detail** → `TaskDetailDrawer`, **Edit** → task drawer in edit mode
(variation B adds a **Move** status picker).

Today `BoardCard.tsx` has no `onClick` on its root — `role="button"` is decorative.
`BoardView` does not render `TaskDetailDrawer` at all (the drawer is currently only
mounted in `ScheduleView`); the click target promised by issue #265 was never wired.
This batch reaches both: (a) introduce the popover, (b) lift the drawer into
`BoardView` via the standard registry-backed entry path so the popover's "Open detail"
CTA has somewhere to land.

**P3M layer**: Programs and Projects (single-project execution surface). **Repo**: OSS.

### Forces

- **No floating-UI library is in the repo today.** Every popover is hand-rolled
  (`DepPopover` #182, `BoardViewDropdown` #191, `BoardSettingsPanel` #170, `RiskPopover`
  #188, `AllocationEditPopover`, drawer ··· menu). Adding `@floating-ui`/Radix for one
  surface is a disproportionate dependency.
- **`BoardCard` root is the @dnd-kit drag handle.** A click handler on the root must
  coexist with `useDraggable` listeners and not collide with the existing child
  interactive surfaces (chain/risk/··· buttons) which already use `stopPropagation()`.
- **Mobile (`< md`, 768px) cannot anchor a popover to a card** — at 375px the popover
  would obscure the card and adjacent cards. The RiskDrawer / ResourceOverallocationDrawer
  pattern (shared content, shell swap by Tailwind breakpoint, see ADR-0040 / ADR-0050 §4)
  is the prescribed solution.
- **Status mutations from the popover (variation B Move) must hit the audited write path.**
  The `PATCH /api/v1/tasks/{id}/` endpoint already writes a `HistoricalTask` row via
  `django-simple-history` (ADR-0011), fires `task_status_changed` (ADR-0013), bumps
  `server_version`, and broadcasts via `transaction.on_commit()`. No new server work.
- **`TaskDetailDrawer` is registry-backed (ADR-0050).** Opening it from the board must
  go through the same `taskId/projectId` invocation path used by the Schedule view —
  the popover is *not* a registered drawer section.
- **Variation A vs B is a `ux-design` decision.** The architecture must support either
  body without rework — A (label/value rows) and B (hero header + meta strip + progress
  ring) compile to the same shell.

## Decision

### 1. Component structure

```
features/board/
  BoardCardPopover/
    index.tsx                  // public export
    CardPopoverShell.tsx       // shell: positioning (desktop) | bottom-sheet (mobile)
    CardPopoverBodyA.tsx       // variation A — structured rows
    CardPopoverBodyB.tsx       // variation B — hero header + meta strip + ring
    CardPopoverFooter.tsx      // Open detail · Edit · (B) Move picker
    useCardPopoverPosition.ts  // anchor-element + viewport-clamp positioning
    BoardCardPopover.test.tsx
```

`BoardCardPopover` accepts `{ task, anchorEl, onOpenDetail, onEdit, onClose, variant }`.
`variant` defaults to `'A'` (production choice deferred to `ux-design`; one-line swap).

### 2. State ownership

Lift `popoverTask: Task | null` and `popoverAnchor: HTMLElement | null` to
**`BoardView`**. Single popover at a time (mirrors the existing `depTask` /
`riskTask` state already in `BoardView`). No Zustand store — the lifecycle is
local to the board page and must clear on route change.

`BoardView` also gains `selectedTaskId: string | null` for the drawer (the
state that #265 spec'd but was never implemented). Set by the popover's
**Open detail** action. Cleared by the drawer's `onClose`.

### 3. Positioning library

**Hand-rolled. No new dependency.** Mirror `BoardViewDropdown` (#191):

- `useRef` + `getBoundingClientRect()` on the anchor element to compute desktop position.
- Default placement `bottom-start`; flip to `top-start` if clipped by viewport;
  clamp `left` within `[8, viewportWidth − popoverWidth − 8]`.
- Recompute on `resize`, `scroll` (capture-phase, throttled), and on `task` change.
- Close on `Escape`, `pointerdown` outside, and route change (subscribe to
  `useLocation()` and clear when `pathname` differs from the open-time pathname).

A focused `@floating-ui/react` adoption is a future-debt option (ADR follow-up if
two more popover surfaces land); not justified by this single feature.

### 4. dnd-kit interop

`@dnd-kit/core`'s `useDraggable` does not synthesize `onClick`; the browser fires `click`
naturally on `pointerup` when no drag occurred (drag activation requires its
configured distance/delay threshold to be exceeded). Therefore:

- Add `onClick={(e) => { if (!e.defaultPrevented) setPopoverTask(task, e.currentTarget) }}`
  to the existing root `<div>` in `BoardCard.tsx` (alongside `{...listeners} {...attributes}`).
- Existing child buttons (chain icon, risk icon, ··· menu) already call
  `e.stopPropagation()` — their behavior is unchanged.
- Add `onPointerDown={(e) => e.stopPropagation()}` inside the popover so clicks within it
  don't propagate to a parent card and re-open it.
- Keyboard parity: `Enter` and `Space` on the focused card open the popover (the
  card already has `tabIndex={0}` and `role="button"`); the same `onClick` handler
  fires.

### 5. Mobile responsiveness

One component, two shells:

```tsx
// CardPopoverShell.tsx
return (
  <>
    {/* Desktop: anchored popover */}
    <div className="hidden md:block fixed z-popover ..." style={{ left, top }} role="dialog" aria-modal="false">
      {body}
    </div>
    {/* Mobile: bottom sheet */}
    <div className="md:hidden fixed inset-x-0 bottom-0 z-popover h-auto max-h-[85vh] ..." role="dialog" aria-modal="true">
      <div className="drag-handle" />
      {body}
    </div>
    {/* Scrim — mobile only */}
    <div className="md:hidden fixed inset-0 z-popover-scrim bg-black/40" onPointerDown={onClose} aria-hidden />
  </>
)
```

Body components (`A`/`B`) are reused across shells. The pattern mirrors `RiskDrawer.tsx`
(L143–157) — bespoke, but `RiskDrawer` is the canonical reference per ADR-0050 §4 until a
generic `<BottomSheet>` is extracted (out of scope for this batch).

Desktop popover is `aria-modal="false"` (non-blocking, board remains interactive
for keyboard); mobile bottom sheet is `aria-modal="true"` because the scrim blocks
the rest of the screen — consistent with ADR-0044's existing pattern.

### 6. Drawer wiring (#265 obligations folded in)

`BoardView` adds:

```tsx
const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null

// ... existing JSX ...

<TaskDetailDrawer
  task={selectedTask}
  projectId={projectId}
  onClose={() => setSelectedTaskId(null)}
/>
```

The drawer is invoked exactly as `ScheduleView` invokes it (registry-backed; ADR-0050
unaffected). Issue #265 is closed by this MR — the popover IS the new card-click
interaction; the drawer is reachable via "Open detail".

### 7. "Edit" footer action

Routes to the **same drawer** opened in an editing affordance. The redesigned
create/edit modal (#305, next batch) replaces this target with a one-line swap once it
lands. **No** routing to the existing `AddTaskModal` — that surface is create-only.

### 8. Move picker (variation B)

If `ux-design` selects variation B, the Move picker calls the existing
`useUpdateTaskStatus({ taskId, projectId, status })` from `useBoardTasks`. No new
hook, no new endpoint. The popover closes on success (cache invalidation triggers
the card re-render via the existing query subscription); failure surfaces a toast
via the existing `useUpdateTaskStatus` error handler — no new error UI.

### 9. Sprint chip

Render a Sprint chip when `task.sprintId != null`, regardless of variation. The chip
sources the sprint name from the existing `useSprints(projectId)` query already used
elsewhere on the board. No new hook.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Adopt `@floating-ui/react`** | Smart placement, collision detection, no edge-case math | New dep for one surface; codebase has no other consumer; bundle cost unjustified |
| **Adopt Radix `Popover`** | Accessibility primitives free; widely used | New dep tree; we already have hand-rolled `role="dialog"` patterns; mismatched style cost |
| **Hand-rolled positioning (chosen)** | Zero new deps; matches `BoardViewDropdown`/`DepPopover`; ~80 LOC | Manual viewport clamp + flip logic; we own edge cases (revisit if 3+ more popovers land) |
| **Single popover state in Zustand** | Cross-component access | Lifecycle is page-local; route-change cleanup is more natural with `useState` + `useLocation` |
| **Lift `selectedTaskId` to a `BoardDrawerContext`** | Multiple openers (popover, keyboard, future surfaces) share state | Premature abstraction — only one opener today (the popover). Refactor when a second arrives |
| **"Edit" → existing `AddTaskModal`** | Already present | `AddTaskModal` is create-only; would force a refactor inside this batch and pre-empt #305 |
| **Reuse drawer as the popover (skip popover entirely)** | Less code | Defeats the `/voc` Sarah-priority "glance without losing place" — drawer is heavyweight |
| **Mobile = same anchored popover** | Less conditional code | Card popover at 375px obscures siblings — UX trap; rule 89 / RiskDrawer precedent |

## Consequences

### Becomes easier
- The board click target is finally wired. Issue #265 closes as folded into this MR.
- `BoardView` gets the same drawer entry that `ScheduleView` has — task detail is
  symmetric across the two views.
- Future popover-style surfaces on the board (e.g. a hover summary, a milestone tip)
  reuse the same hand-rolled shell.

### Becomes harder
- Adding a third board-anchored popover may finally tip the cost-benefit toward
  adopting `@floating-ui` — track this. The bar should be: 3+ surfaces with
  flip-on-clip and collision avoidance needs.
- Variation A vs B both ship code; the unselected variant lingers until ux-design
  picks (one is removed in the same MR; do not ship dead code).

### Risks
- **dnd-kit click-vs-drag race** at low activation distances. Mitigation: keep
  `useDraggable`'s default activation constraint; verify in the e2e spec that a 3px
  pointer wiggle followed by release still opens the popover (no false drag).
- **Click swallowed by child surfaces** (e.g. ··· menu opens but card click also
  fires). Mitigation: existing `stopPropagation()` pattern at L272–285 in
  `BoardCard.tsx` is the contract — verify no child surface forgot it.
- **Route change does not always clear popover state.** Mitigation: `useEffect`
  watching `useLocation().pathname` calls `onClose()` when it changes from the
  open-time value.
- **Mobile bottom-sheet scrim** — the existing RiskDrawer pattern is bespoke; if a
  generic `<BottomSheet>` lands later, this component refactors to it. Acceptable
  duplication for now.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project board surface)
- **Affected packages**: `web` only
- **Migration required**: no
- **API changes**: no — frontend-only batch (confirmed by API survey: `PATCH /tasks/{id}/`
  already writes `HistoricalTask`, fires `task_status_changed`, bumps `server_version`,
  broadcasts via `transaction.on_commit()`)
- **OSS or Enterprise**: OSS (`grep -r "trueppm_enterprise" packages/` returns zero)

### Files touched
- `packages/web/src/features/board/BoardCard.tsx` — add root `onClick` invoking the
  popover from `BoardView` props (`onCardClick(task, anchorEl)`); no other behavior
  change.
- `packages/web/src/features/board/BoardView.tsx` — add `popoverTask`, `popoverAnchor`,
  `selectedTaskId` state; render `<BoardCardPopover>` and `<TaskDetailDrawer>`; route
  change cleanup in `useEffect`.
- `packages/web/src/features/board/BoardCardPopover/*` — new component (5 files
  including test).
- `packages/web/src/types/index.ts` — confirm `Task.sprintId` already present (yes,
  line 101); no change required.
- `packages/web/e2e/wave3-card-info-popover.spec.ts` — new spec (board.spec.ts gets
  one new top-level case; the new spec covers the popover's lifecycle in isolation).
- `changelog.d/304.added.md` — fragment in the same commit as the code.

### Test layers (per CLAUDE.md feedback_test_coverage)
- **vitest unit**: `BoardCardPopover.test.tsx` — variant A renders rows; variant B
  renders hero; sprint chip when `sprintId` set; "Open detail" calls the prop;
  "Edit" calls the prop; (B) Move calls `useUpdateTaskStatus` once with the new
  status; closes on Esc.
- **vitest hook**: positioning helper covered if non-trivial; otherwise exercised
  through the component test.
- **Playwright e2e**: `wave3-card-info-popover.spec.ts` — click card → popover
  visible; Esc → popover hidden; click outside → hidden; Open detail → drawer
  opens; route change → popover hidden; mobile viewport (`375x667`) renders the
  bottom-sheet shell, not the anchored popover.
- **No pytest changes** — no API surface changes.

### Durable Execution
1. Broker-down behaviour: **N/A** — frontend-only feature; no Celery dispatch.
2. Drain task: **N/A** — no async work added.
3. Orphan window: **N/A** — no outbox row created.
4. Service layer: **N/A** — `PATCH /tasks/{id}/` is the existing path; no new
   service function.
5. API response on best-effort dispatch: **N/A** — synchronous PATCH, response is
   the updated task; status change side-effects (CPM recalc, broadcast,
   HistoricalTask write) are queued by the *existing* viewset's `perform_update`.
6. Outbox cleanup: **N/A** — no outbox row.
7. Idempotency: a duplicate Move (user clicks twice) issues two PATCHes with the
   same status; the existing `Task.save()` is idempotent for status (the second
   write is a no-op for `_old_status == self.status` — the signal does not refire
   per `models.py` L476–483). Acceptable.
8. Dead-letter / failure handling: **N/A** for the popover; the existing
   `useUpdateTaskStatus` error path surfaces a toast and rolls back optimistic UI.
   No retry policy needed at the popover layer.
