# ADR-0515: Editable task duration in the detail drawer

## Status
Proposed

## Context

In the task detail drawer, the schedule "vitals" strip (`TaskScheduleStrip.tsx`)
renders **Start · Finish · Duration · Float** as four read-only cells. The only
ways to change a task's duration today are:

- **dragging the Gantt bar's resize handle** (imprecise, snap-to-day, and absent
  entirely on the read/navigate mobile schedule surface, ADR-0348), or
- opening **Build mode** and editing the `Dur` column inline.

Duration is a **primary CPM input** — Start/Finish are *computed from it* — so
typing a duration is the natural, precise way to schedule (MS Project and
Planview both let you type it directly). A PM reviewing "Performance tuning — 7d"
in the drawer has no field to type into (#2106).

**P3M layer:** Programs and Projects (single project, task/schedule CRUD) → OSS.
This is core scheduling; there is no enterprise boundary.

### Forces (established by codebase research)

1. **`duration` is already writable** on `PATCH /tasks/{id}/` (`TaskSerializer`).
   Server enforces the cumulative project-span cap (#1862) and returns a
   `{duration: [...]}` `ValidationError` on overflow. No new API surface needed.
2. **Baselining does NOT lock duration.** "baselined" is a computed *readiness
   label* (`get_readiness()` → `baseline_start is not null`); no write-guard in
   `TaskSerializer.validate()`/`update()` keys off baseline state. A baselined
   task's `duration` is fully PATCHable. The header `ReadinessChip`'s lock glyph
   is presentational only.
3. **Duration is nowhere *staged* today.** Both existing edit paths commit
   immediately: Gantt resize sends `planned_finish` via `useRescheduleTask` (the
   server derives working-day duration, #951); build-mode `Dur` sends `duration`
   via `useUpdateTask`. Start/Finish/Float are server-computed and only meaningful
   *after* the CPM recompute.
4. **The recalc-% prompt (ADR-0151) is a post-commit follow-up.** `recalcPercentPrompt.ts`
   (`buildRecalcPrompt`/`shouldPromptRecalc`/`proratedPercent`) is owned by
   `TaskListRow` and triggered *only* by the build-mode `Dur` cell's `onCommit`,
   which fires an immediate `updateTask.mutate({duration})` and *then* builds the
   prompt from `oldDuration`/`oldPercent`. Accept issues a second client PATCH
   (`percent_complete`). It is suppressed on coarse pointers (mobile → `confirm`
   behaves as `keep`).
5. **`useUpdateTask` invalidates `['tasks', projectId]`** on success (plus
   `['task-history']`), so the vitals strip refreshes Start/Finish/Float after the
   CPM recompute. It also applies an optimistic `duration` patch with rollback/409
   handling.
6. The drawer's staged scalar contract (`useDirtyDraft<ScalarDraft>` →
   `buildScalarPatch` → shared `DialogFooter` Save bar, web-rules 217/264,
   ADR-0439/0437) carries `name`, `notes`, and the three-point estimates. It is a
   non-modal inspector on desktop.

## Decision

**Make the Duration cell in `TaskScheduleStrip` an inline click-to-edit field that
commits IMMEDIATELY via `useUpdateTask({ duration })` — an instant commit, NOT a
staged field on the drawer's Save-bar batch.** This is the rule-217 instant-toggle
carve-out, and it mirrors the build-mode `Dur` cell verbatim.

Rationale for instant over staged:

- **Duration's downstream fields are server-computed.** Start/Finish/Float only
  become correct after the CPM recompute. A *staged* duration would leave the
  strip showing stale Start/Finish until Save — the user changes 7d → 10d but
  Finish still reads "Aug 3" — the opposite of the "review my schedule" value.
  An instant commit lets the strip refresh to the true recomputed dates.
- **No other surface stages duration.** Both existing edit paths commit
  immediately; a "pending duration" state would be a novel concept with no
  precedent, and would have to interact with the unsaved-changes guard.
- **The recalc-% prompt composes cleanly only with an immediate commit** — it is
  architecturally a post-commit follow-up that reads the pre-edit
  `oldDuration`/`oldPercent`. Reusing it verbatim requires the commit-then-prompt
  shape, exactly as `TaskListRow` does today.

Duration therefore stays **out of** `ScalarDraft`/`buildScalarPatch`; the
name/notes/estimates staged contract is untouched.

### Composition specifics

- The editable Duration cell owns a local `RecalcPromptState` (mirroring
  `TaskListRow`), reading `useEffectiveDurationPolicy(projectId)` and coarse-pointer
  suppression, and renders `RecalcPercentChip` inline on a qualifying edit. Accept
  fires the follow-up `percent_complete` PATCH.
- The cell reuses `parseDurationInput` (build-mode's `EditableCell`) so `"5"`/`"5d"`
  parse identically. Invalid input is rejected inline and does not commit (web-rule 225).
- A server span-cap rejection (#1862) surfaces the `{duration: [...]}` message
  inline via the mutation's `onError`, and the optimistic patch rolls back.
- **Editability gates on `canEdit`** (the drawer's existing ADR-0133 role gate) —
  a Viewer sees the read-only cell. **Milestones** (`is_milestone`) render no
  Duration cell at all (unchanged suppression).
- **Baselined tasks are editable** (no lock); the edit creates schedule variance
  against the baseline snapshot, which is the intended behavior.
- Works on mobile (the drawer bottom sheet) — this closes the "no way to change
  duration on mobile schedule" gap. The recalc chip stays coarse-pointer-suppressed
  per ADR-0151.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Instant commit (chosen)** | Strip refreshes to true recomputed dates; reuses build-mode + recalc-% wiring verbatim; consistent with every existing duration-edit path; no guard interaction | A second "instant" affordance on a strip that's otherwise read-only; must thread `projectId`/`canEdit` into the strip |
| B. Staged into `ScalarDraft` Save bar | Consistent with name/description/estimates | Leaves Start/Finish stale until Save (confusing); invents a "pending duration" state with no precedent; awkward recalc-% composition (prompt must fire post-batch-save); more code |
| C. Open the full TaskFormModal / build mode | Zero new drawer code | Defeats the purpose — the whole point is to not leave the drawer |

## Consequences

- **Easier:** precise duration entry from the drawer (desktop + mobile) without
  the Gantt bar; parity with build mode; the recalc-% policy is honored on a new
  surface for free.
- **Harder:** `TaskScheduleStrip` gains a small amount of client state (mutation +
  recalc prompt) — it is no longer purely presentational. Keep the edit logic in a
  focused `DurationCell` (or an `editable` branch) so the read-only render path is
  unchanged for callers that pass no `projectId`/`canEdit`.
- **Risks:** low. No API/model/migration change. The main risk is UI-only —
  interaction affordance and focus/keyboard/touch parity, which the ux-design gate
  resolves.

## Implementation Notes

- **P3M layer:** Programs and Projects (Operations-adjacent scheduling).
- **Affected packages:** web only.
- **Migration required:** no.
- **API changes:** no — `duration` is already a writable `TaskSerializer` field;
  span-cap validation (#1862) and the ADR-0151 duration-change policy already exist.
- **OSS or Enterprise:** OSS (`trueppm-suite`). Core scheduling, no boundary.

### Durable Execution
1. **Broker-down behaviour:** N/A to this feature — the duration PATCH triggers a
   CPM recompute through the *existing* `scheduling/services.py::enqueue_recalculate`
   path (transactional outbox + drain), unchanged by this UI addition. No new
   dispatch path is introduced.
2. **Drain task:** Reuses the existing schedule-recompute drain — semantics are
   identical (a duration write already enqueues a recompute from build mode / drag).
3. **Orphan window:** N/A — no new outbox category.
4. **Service layer:** Reuses `scheduling/services.py::enqueue_recalculate` (invoked
   server-side on the task write, as today). The recalc-% follow-up is a second
   client `PATCH percent_complete`, again through the same task-write path.
5. **API response on best-effort dispatch:** N/A — `PATCH /tasks/{id}/` responds
   synchronously with the updated task; the recompute is enqueued server-side as
   it already is for every duration write.
6. **Outbox cleanup:** N/A — no new outbox rows.
7. **Idempotency:** The duration PATCH is naturally idempotent (sets an absolute
   `duration` value; last-write-wins with `baseVersion`/409 field-merge per
   ADR-0217). The recalc-% follow-up sets an absolute `percent_complete`.
8. **Dead-letter / failure handling:** N/A — reuses the existing recompute failure
   handling. A UI-level PATCH failure (span-cap 400, 409 conflict, offline) rolls
   back the optimistic patch and surfaces an inline error; no new server failure mode.

### Open questions for ux-design (non-blocking)
- Exact affordance: inline click-to-edit cell (matching the strip's typographic
  grid) vs. a small stepper vs. a pencil-reveal — given the strip is a 4-up
  read-only vitals grid today.
- Where the recalc-% chip renders relative to the strip.
- Keyboard/touch commit gestures and the mobile bottom-sheet variant.
