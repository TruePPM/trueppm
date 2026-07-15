# ADR-0437: Task detail drawer — non-modal desktop modality

## Status
Accepted

Amends the drawer-modality decision embedded in **ADR-0051** (Card Information Popover
and Board Drawer Wiring) and the `#962` "Direction B" redesign. ADR-0051 set the board
*popover* to `aria-modal="false"`; this ADR extends the same non-modal contract to the
`TaskDetailDrawer` itself on desktop. The web-rule modality contract (rules 89/164/185)
is likewise reconciled — rule 185 already asserted the task drawer has *no desktop
scrim*, which the pre-#1978 code contradicted.

## Context

The desktop `TaskDetailDrawer` (`packages/web/src/features/schedule/TaskDetailDrawer.tsx`)
shipped as a **contradiction**: `aria-modal="true"` with an active Tab focus-trap, yet
**no scrim/backdrop**. So it *behaved* modal (focus trapped; the keyboard could not reach
the Gantt/Board behind it) while it *looked* non-modal (the canvas was fully visible and
appeared interactive). Users read this as "the drawer doesn't flow" (#1978): opening a task
to read its dates froze the plan it lives in, defeating the inspector's whole point — walking
the critical path bar by bar, glancing at each task, without losing your place.

Every sibling detail drawer is the opposite — non-modal, no focus-trap, no scrim, the
list/canvas stays usable: `StoryDetailDrawer`, `EpicDetailDrawer`, the Risk drawer (web-rules
89/164/185, ADR-0051's popover). `TaskDetailDrawer` was the lone quasi-modal outlier.

A `/voice-of-customer` panel (avg 6.5/10, firmly OSS) and a `/ux-design` gate examined the
two load-bearing decisions the conversion forces:

1. **Swap-while-dirty.** Non-modal enables clicking another bar/card to **swap** the drawer's
   task without closing it. But the existing reseed effect (`useEffect([taskId]) →
   commit(toDraft(task))`) **silently clobbered an in-progress dirty draft** on any identity
   change — a latent bug the "click-to-swap" framing makes reachable by design. The VoC panel
   *unanimously* rejected a blocking dialog on *every* swap ("ceremony tax"), but equally
   rejected silent auto-commit or silent discard. The ux-design gate resolved the tension: the
   guard fires **only on a dirty swap**, and per the #1977 contract a draft is dirty *only*
   when the user has typed an unsaved **name or notes** edit (status, progress, assignees,
   labels, estimates, dependencies all commit immediately via their own endpoints, rule 217).
   So during the rapid cross-referencing the non-modal is built for, every swap is clean and
   instant; the prompt appears only when unsaved typing would otherwise be lost.

2. **Focus-restore on close.** The drawer's triggering element is ephemeral on every host:
   a Schedule bar is canvas-drawn (no DOM node), the Board "Open detail" popover unmounts
   before the drawer opens, the ⌘K palette input unmounts on close. A precise per-host restore
   is undeliverable for 2 of 3 hosts; doing nothing (sibling parity) strands keyboard focus on
   `<body>` (a WCAG 2.4.3 regression). Best-effort with a guaranteed non-`<body>` fallback is
   the deliverable middle.

## Decision

**On desktop, `TaskDetailDrawer` is a true non-modal inspector; mobile stays modal.**

1. **Modality.** Desktop: `aria-modal="false"`, no focus-trap, no scrim — the Gantt/Board
   behind stays live and keyboard-reachable, and clicking another bar/card swaps the drawer's
   task. Mobile (`sm` breakpoint): unchanged 85vh bottom sheet, `aria-modal="true"` +
   `useFocusTrap` + backdrop. The trap engages solely at `sm`, mirroring `StoryDetailDrawer`.

2. **Swap-while-dirty — the drawer-local `pendingTask` latch.** The drawer renders a local
   `renderedTask` that normally tracks the `task` prop but deliberately *lags* it during a
   dirty swap. On an identity change: a **clean** swap (or open) adopts the incoming task and
   reseeds instantly; a **dirty** swap parks the incoming task as `pendingTask`, keeps the
   current task + draft on screen, and raises a **three-verb guard** — **Keep editing**
   (Escape), **Discard & open**, **Save & open** (primary, autofocused). All three resolve the
   pending swap; a failed Save holds the dialog with an inline `role="alert"` error and keeps
   the pending task. Because the host moved its selection *before* the drawer saw the swap,
   Keep editing invokes `onSwapCanceled(keptTaskId)` so the host restores the prior selection
   (Schedule/Board/Sprints wire it to `setSelectedTaskId(keptId)`). **Never auto-save on swap.**

3. **Focus-restore — best-effort ladder, never `<body>`.** On open the drawer captures the
   opener; on close it walks: captured opener if still connected/visible → optional host
   `getRestoreTarget(taskId)` (a precise node — Board card, focusable canvas viewport) → the
   app `<main>` (made `tabIndex=-1`) → never `<body>`. Desktop only; mobile restore is the
   bottom-sheet trap's job. `getRestoreTarget` is an optional host extension point; unwired,
   the captured-opener → `<main>` fallback still never strands focus.

4. **Primitive reuse.** The three-verb guard is the shared `UnsavedChangesDialog` (rule 217)
   extended with an optional `onSaveAndContinue` + `saving`/`error`/title/label overrides —
   not a forked dialog. The two-verb close/expand guards are unchanged.

## Consequences

- The drawer joins the sibling non-modal contract; the a11y announcement now matches reality
  (non-modal on desktop, modal on mobile). Codified as web-rule **264**.
- A latent silent-discard-on-swap bug is fixed: an in-progress rename/note can no longer be
  lost by clicking another task.
- Hosts that drive swaps (`ScheduleView`, `BoardView`, `SprintsView`) gain one optional prop
  (`onSwapCanceled`); the `GlobalTaskDrawer`/⌘K host needs nothing (swaps don't originate
  there). `getRestoreTarget` is left unwired initially (captured-opener + `<main>` fallback);
  wiring a precise Board-card / canvas-viewport target is a follow-up enhancement, not a
  correctness requirement.
- The `DrawerSectionProps` registry contract Enterprise registers against is untouched — this
  is a container-modality change only.

## Alternatives considered

- **Hard two-verb guard on dirty swap (Keep editing / Discard).** Rejected: it forces the user
  to abandon their *navigation* intent to preserve their *edit* intent and, on a canvas where
  the target bar has no DOM anchor, re-finding it is real friction. The three-verb guard honors
  both intents.
- **Optimistic swap + Undo snackbar.** Rejected: auto-discards the edit by default and recovery
  depends on catching a fading toast on a busy canvas.
- **Auto-save on swap.** Rejected: violates the #1977 no-auto-flush contract and could push an
  empty/invalid `name`.
- **In-layout persistent sidebar / centered modal + scrim.** Rejected per #1978: the sidebar has
  no spare column on Board/palette and recomputes the canvas; a scrim blocks the cross-
  referencing that is the drawer's whole point. Full-page expand is retained as the escalation
  path, not a replacement.
- **Regenerating a bespoke `SwitchWithUnsavedChangesDialog`.** Rejected: keeps one source of
  truth for the discard prompt (rule 217) by extending `UnsavedChangesDialog` instead.
