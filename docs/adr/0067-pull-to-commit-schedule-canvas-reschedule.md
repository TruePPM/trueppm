# ADR-0067: Pull-to-Commit Pattern for Schedule Canvas Reschedule and Resize

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: useScheduleCommit)

## Context

The Schedule canvas (`packages/web/src/features/schedule/engine/`) accepts a
task-bar reschedule the moment the pointer moves past the 4 px FSM threshold
(`DRAG_THRESHOLD_PX` in `GanttDragFSM.ts`). On `drag-task-end`
(`ScheduleView.tsx:593–610`), `useRescheduleTask` fires a `PATCH /tasks/{id}/`
that commits the new `planned_start`. The same shape applies to `resize-task-end`,
which adjusts `duration`. Both paths commit silently — no confirmation, no
explicit affordance to undo before the mutation lands.

On a dense schedule this makes accidental drags trivially easy: a single
mis-click on a bar plus a few pixels of pointer drift commits a new
`planned_start` PATCH. Sarah (PM) filed this in #492 during manual testing
of !282 on 2026-05-17. Her concern is the same survival need from the
opposite direction of her existing "I can't update the schedule" pain —
*"I can't accidentally corrupt it either."*

The Schedule canvas is desktop-only per ADR-0064 (`hidden lg:block`). Touch
drag is deferred to #481. Keyboard reschedule (#34) is already intentional
by construction — keyboard arrow gestures require explicit modifier keys
and have no mis-click failure mode.

### VoC panel verdict (8 personas)

Unanimous pick: Option C (pull-to-commit). Panel average 7.25/10. Sarah
(PM, 8/10 🟢) + Alex (Scrum Master, 8/10 🟢) + Jordan (PO, 7/10) — the
strongest OSS adoption triple per `personas.md`. Morgan (Agile Coach,
7/10 🟡) flagged a 🔴 blocker: Option C still has a "silent override" path
if Confirm fires the PATCH with no audit trail or team-visible record on
sprint-committed tasks. **That blocker dissolves once the existing
django-simple-history infrastructure (ADR-0011) is acknowledged: every
PATCH on `planned_start` already creates a `HistoricalTask` row with the
user, timestamp, and field-level diff. The audit trail is not missing — it
is already automatic.** What was missing was the *deliberate-decision
moment* before the PATCH fires; that is what #492 adds.

## Decision

Adopt **Option C — pull-to-commit** for both `drag-task-end` and
`resize-task-end` on the Schedule canvas:

1. **During drag/resize**: the existing `useDragCpm.ts` ghost-bar preview
   path is preserved unchanged. CPM-worker preview, critical-path
   highlighting, and `+N more` cap all continue to behave per ADR-0040.
2. **On pointerup** (drag-end / resize-end): the FSM transitions to a new
   `PREVIEW_PENDING` state. The PATCH is **not** fired. The ghost bar
   stays rendered and a Confirm/Cancel popover is anchored above the
   pending bar position.
3. **Confirm** (mouse click on Confirm, or Enter key when popover is
   focused): fires `useRescheduleTask` / `useResizeTask` via the existing
   mutation path. On mutation success the FSM returns to IDLE.
4. **Cancel** (mouse click on Cancel, Esc key, or click-outside): the
   ghost bar dismounts, the FSM returns to IDLE, and a toast surfaces
   *"Reschedule cancelled — change not saved"* (resize uses parallel
   copy). No PATCH fires.
5. **Sprint-aware copy**: when `task.sprint?.state === 'ACTIVE'`, the
   popover surfaces a non-blocking notice — *"Committed in Sprint
   <name>"* — directly above the Confirm/Cancel pair. The visual style
   matches the active-sprint warning pattern established in ADR-0066 Q2
   for the Duplicate action.
6. **Esc priority**: when the popover is open, Esc cancels the pending
   commit first. Only after the popover is dismissed do downstream Esc
   handlers fire (hover-chain reset per ADR-0066, build-mode focus
   rollback per ADR-0054, context-menu close per the !282 fix). This
   extends but does not break the existing Esc cascade.
7. **Desktop-only**: the popover follows ADR-0064 — rendered with
   `hidden lg:block`, same convention as the Schedule legend and the
   right-click menu from !282. Touch tap-to-pin is out of scope (#481).

The change is localized in `packages/web`. No API changes, no Django
migration, no scheduler-engine changes. The existing `TaskViewSet.partial_update`
→ `TaskSerializer.update` → `services.enqueue_recalculate(project_id)`
path is reused unchanged.

### Audit trail (resolves Morgan's 🔴)

Per ADR-0011, `Task` is registered with `django-simple-history` via
`history = HistoricalRecords(excluded_fields=_HISTORY_EXCLUDED_TASK)` in
`packages/api/src/trueppm_api/apps/projects/models.py:319+`. CPM outputs
(early_start, early_finish, late_*, total_float, free_float, is_critical)
are excluded; `planned_start` is **tracked**. Every Confirmed PATCH
therefore creates a `HistoricalTask` row capturing user, timestamp, and
`planned_start` field diff. The `GET /tasks/{id}/history/` endpoint
already surfaces this; the `History` tab in `TaskDetailDrawer` per
ADR-0032 already renders it. **No new audit infrastructure is required.**

Sprint-committed work that gets rescheduled is captured in the team-visible
history surface — Morgan's "side-door silent override" anti-pattern does
not apply once Confirm is the only commit path and history is already
populated.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| A — Modifier-required drag (Alt-held) | Zero accidental drags possible; minimal code change | Discoverability: users try to drag, nothing happens until they learn the modifier. David called this a hard NO for less technical PMs (7/10 🟡 with this caveat). No VoC support. |
| B — Long-press threshold (250 ms) | Forgiving, self-teaching, mobile-conventional | 250 ms feels sluggish on desktop. PMs read the delay as "tool is slow," not as "tool is protecting me." Still commits silently on success — Morgan's 🔴 survives. No VoC support. |
| **C — Pull-to-commit (chosen)** | Unanimous VoC support; reuses existing `useDragCpm` ghost-bar; matches MS Project mental model (Sarah's anchor); makes Confirm the only commit path, which resolves Morgan's 🔴 in combination with existing ADR-0011 audit trail | Adds one click to every legitimate reschedule. Mitigated by Enter-confirms-keyboard binding (no mouse reach for power users). |
| Defer #492 | Save the build cost | Sarah's filed concern stays open; the schedule corruption mode persists |

## Consequences

### Becomes easier
- Recoverable misclicks: every accidental drag is now visible and
  dismissable before it lands in the database.
- Sprint sovereignty: schedule edits on active-sprint-committed tasks
  carry an explicit acknowledgment, surfacing Morgan's "deliberate
  decision" requirement without blocking the PM.
- Audit traceability: the existing django-simple-history trail is now
  *meaningful* — every entry corresponds to a deliberate PM decision
  rather than a mix of intentional changes and 4-px drift artifacts.
- Future extensibility: the popover is the natural mount point for
  David's allocation-impact hint (deferred), the touch tap-to-pin
  affordance (#481), and the sprint blast-radius hint (#480).

### Becomes harder
- The drag FSM gains one more state (`PREVIEW_PENDING`) and one more
  Esc-priority rule. Future canvas-FSM work must respect both.
- The popover is a new desktop-only canvas overlay; ADR-0064 compliance
  must be verified in every new schedule UI affordance going forward.
- One additional click on every reschedule. Power-user friction is
  mitigated by the Enter keyboard binding but not eliminated.

### Risks
- **Popover positioning** under viewport edge cases (last task in the
  scroll buffer, popover would clip): must mirror the right-click menu's
  flip-to-stay-inside-viewport logic from !282.
- **Drag-while-already-dragged** state: if the user cancels and
  immediately initiates a new drag, the previous popover must dismount
  cleanly before the new FSM cycle starts. Test in implementation.
- **Resize-end parity**: applying the same gate to resize doubles the
  test surface but is essential to avoid shipping a half-solution where
  drag is safe and resize is not.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project schedule edit UX)
- **Affected packages**: `web` only. No api, scheduler, mobile, or helm changes.
- **Migration required**: no
- **API changes**: no (existing `PATCH /tasks/{id}/` is reused unchanged;
  serializer fires `early_start` re-floor and CPM recompute via the
  existing on_commit chain)
- **OSS or Enterprise**: OSS — single-project safety affordance per
  feature-resonance rule (Sarah/Alex/Jordan champion → OSS)

### Resolution of the 9 architect questions

1. **Confirm Option C** — yes. FSM addition is one new state
   (`PREVIEW_PENDING`); no existing transition is invalidated. Cost is
   linear in the existing surface, not multiplicative.
2. **Audit trail scope** — **no new infrastructure**. ADR-0011 +
   django-simple-history already capture the `planned_start` diff on
   every PATCH. The History tab in `TaskDetailDrawer` (ADR-0032) already
   renders it. Morgan's 🔴 dissolves; document the existing trail in the
   ux-design (e.g., a "View history" affordance in the Confirm popover
   is *optional* polish, not load-bearing).
3. **Sprint-aware popover copy** — yes, in-scope for v1. Single
   conditional render on `task.sprint?.state === 'ACTIVE'`. Style mirrors
   ADR-0066 Q2 active-sprint warning.
4. **Assignee notification** — out of scope for #492. File follow-up:
   *"feat(api+web): targeted in-app notification to assignee when their
   task's `planned_start` changes via canvas reschedule."* This is a
   notification-channel design question, not a canvas-UX question.
5. **Allocation-impact hint (David)** — out of scope for v1. Keep
   popover layout extensible (additional row slot below the active-sprint
   notice). Tied to #489 partial-allocation work.
6. **Drag vs Resize** — **both gated** by the same popover. Resize is
   the same corruption-risk shape with a different mutation field
   (`duration`). Shipping drag safety without resize safety is a
   half-solution. Confirm-popover copy adapts: *"Reschedule from <old>
   to <new>"* vs *"Resize from <duration> to <duration>"*. Single FSM
   state, two action labels. **Progress-drag**: the engine FSM survey
   shows no progress-drag state on the canvas today (`percent_complete`
   is edited via Task drawer or Board). Confirmed not in scope; if added
   later it should use the same gate.
7. **Drag-while-already-dragged** — Cancel → FSM transitions to IDLE,
   popover dismounts via React unmount, ghost-bar render cleared by
   `useDragCpm` state reset. New drag starts a fresh HOVER_WAIT cycle.
   Test in implementation.
8. **Inline-edit conflict** — no conflict. Inline-edit is double-click
   from build mode (ADR-0054), which transitions
   `RowFocused → CellEdit` via `useScheduleFocus` reducer and never
   enters the drag FSM. Drag/resize originates from a single-click
   mousedown + pointer move past 4 px. The two surfaces don't share
   pointer-event paths.
9. **ADR or design note?** — own ADR (this one, 0067). The "preview
   before commit" pattern will be referenced by #481 (touch tap-to-pin
   commits the same way after a tap-and-hold), #480 (sprint blast-radius
   hint mounts in the same popover slot), and any future canvas edit
   affordance. The Esc-priority addition must be written down somewhere
   durable.

### Open scope decisions for ux-design

- Popover copy: "Reschedule" vs "Confirm" vs "Save". MS Project uses a
  modeless preview without verb-on-button (Sarah's reference); ux-design
  picks. Recommend "Confirm reschedule" / "Cancel" for clarity on
  hover.
- Popover anchor point: above the new bar position vs above the original
  bar position. Above the new bar matches gutter drag-to-promote
  (ADR-0040); recommend that.
- Toast text for click-outside cancel: *"Reschedule cancelled — change
  not saved"* / *"Resize cancelled — change not saved"*. Mirrors the
  "Drag cancelled" copy in the issue acceptance criteria.

### Durable Execution

1. **Broker-down behavior**: N/A — #492 changes when an existing PATCH
   fires (on Confirm vs on pointerup) but not the API path. The PATCH
   continues to flow through `TaskViewSet.partial_update` → CPM
   recompute via existing `services.enqueue_recalculate(project_id)`
   chain established in ADR-0027.
2. **Drain task**: N/A — no new async category. CPM recompute uses the
   existing scheduling drain.
3. **Orphan window**: N/A — no new outbox row written by this feature.
4. **Service layer**: `scheduling/services.py::enqueue_recalculate()`
   (existing, no change).
5. **API response on best-effort dispatch**: existing
   `PATCH /tasks/{id}/` returns 200 with the updated Task. No change.
6. **Outbox cleanup**: N/A — no new outbox usage.
7. **Idempotency**: Frontend — the `useRescheduleTask` mutation cancels
   in-flight queries on `onMutate` and rolls back on `onError`. If the
   user double-clicks Confirm, the second click hits a popover that has
   already dismounted (FSM is no longer in PREVIEW_PENDING after the
   first click triggers transition to COMMITTING). Backend — the PATCH
   is naturally idempotent: same field, same value, same row.
8. **Dead-letter / failure handling**: existing — the mutation's
   `onError` rolls back the optimistic cache update and surfaces a toast
   via the existing error path. No change.

### Acceptance criteria (updates and additions vs the issue)

- [ ] Drag-end no longer fires PATCH directly — opens Confirm/Cancel
      popover at the new bar position (above the new bar, mirroring
      ADR-0040 gutter pattern)
- [ ] Resize-end is gated by the same Confirm/Cancel popover
- [ ] Esc cancels and reverts the ghost bar
- [ ] Click-outside cancels with a "Reschedule cancelled — change not
      saved" toast ("Resize cancelled — change not saved" for resize)
- [ ] Enter commits without mouse reach
- [ ] Confirm commits via the existing `useRescheduleTask` /
      `useResizeTask` paths
- [ ] `useDragCpm` ghost-bar preview reused — no double rendering of
      the bar
- [ ] When `task.sprint?.state === 'ACTIVE'`, popover surfaces
      "Committed in Sprint <name>" notice above the Confirm/Cancel pair
- [ ] Popover follows ADR-0064 `hidden lg:block` rule
- [ ] Popover-open Esc cancels the pending commit *first*, before
      hover-chain or build-mode Esc handlers fire
- [ ] After Cancel, a new drag works cleanly with no state leakage
- [ ] vitest: drag-end no longer auto-commits; only Confirm fires the
      mutation; Cancel surfaces the toast
- [ ] Playwright: drag → cancel → bar reverts; drag → confirm → PATCH
      fires; resize → confirm → PATCH fires
- [ ] No regression in the existing E2E specs:
      `schedule-build-mode.spec.ts`, `schedule-dep-milestone-ux.spec.ts`,
      `schedule-render-parity.spec.ts`

### Out of scope (file follow-ups)

- **Touch drag-reschedule / tap-to-pin** — deferred to #481
- **Assignee notification on Confirmed PATCH** — new issue; broadcast
  to assignee channel on schedule-touching task changes
- **Allocation-impact hint** in popover — tied to #489 partial-allocation work
- **Progress-drag gate** — not on canvas today; if added later, must
  use the same gate
- **Bar visual variant** for the pending-preview ghost (dashed vs
  dimmed) — ux-design picks; render-pipeline slot per ADR-0063

## References

- #492 — feat(web): require intentional gesture before task-drag commits a reschedule
- ADR-0011 — Object Change History (django-simple-history; provides the audit trail this ADR relies on)
- ADR-0014 — Schedule Canvas Rendering Fixes and Task Planned-Start Constraint
- ADR-0027 — Incremental CPM Recompute (recompute path consumed unchanged)
- ADR-0032 — Task Detail Drawer — Estimates, History, and Baseline Comparison (History tab already renders the diff)
- ADR-0036 — Hybrid PM Philosophy and Sprint Model
- ADR-0037 — Sprint Model — Data, API, and Board Integration (Sprint.state = ACTIVE semantics)
- ADR-0040 — Wave 3 Schedule (gutter drag-to-promote: direct design precedent)
- ADR-0054 — Schedule Build Mode v1 (`useScheduleFocus` Esc contract)
- ADR-0063 — Gantt Dependency Arrow Routing Rules (render pipeline)
- ADR-0064 — Schedule Legend Overlay (desktop-only `hidden lg:block` rule)
- ADR-0066 — Schedule Canvas Interactivity (Esc-priority cascade; right-click menu)

## Tracking

Tracking (follow-up): the allocation-impact hint (David persona) is deferred — not yet
filed.
