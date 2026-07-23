# ADR-0603: "No committed start" remediation — chip popover, shared mutation hook, and the #2314/#2315 boundary

## Status
Accepted

## Context
A Schedule task-list row shows an amber chip when a task is `IN_PROGRESS` /
`REVIEW` / `COMPLETE` but has no PM-committed `planned_start`. CPM auto-fills
`early_start`, so the grid and drawer render dates that *contradict* the flag.
#2312 (in flight) reworded the chip to **"no committed start"**. #2313 makes the
chip a point-of-fix, #2314 adds a drawer fix-home, and both share one mutation
hook. A VoC panel scored the current (dead-affordance) state **2.6/10, five 🔴** —
all trust-related: the tooltip prescribes fixes that exist nowhere.

An approved Claude Design ("No Committed Start Remediation", project `e01d4825`,
source `td2-remediation.jsx`) specifies all three surfaces and offers the
warning **vocabulary as two variants** — A ("committed start") and B ("planned
start yet") — leaving the choice open.

**P3M layer:** Programs and Projects (single-project schedule UX). Trivially OSS —
this is core scheduling interaction, not cross-program governance. `grep -r
"trueppm_enterprise"` unaffected.

## Decision

### 1. Vocabulary — ship variant A in 0.4; defer methodology-aware copy to 0.5
Ship **variant A** ("no committed start" / "Set committed start" / "Move to To
Do") across all three surfaces in 0.4. Reasons: (a) it is already the shipped
#2312 chip label — a second vocabulary now would make the chip and its own
popover disagree; (b) a methodology translation layer is an abstraction we cannot
yet scope correctly (there is no per-view methodology signal wired to this
surface); (c) "committed start" is accurate for every methodology — the objection
is tone, not correctness. File a **0.5 follow-up** for methodology-aware copy
keyed off project methodology (variant B for agile/contributor views), tracked
against the design's variant-B strings which are already authored. This resolves
the open question flagged in both #2313 and #2314.

### 2. Mutation shapes — both are single-field `useUpdateTask` PATCHes
`useCommitStartOrTodo(task, projectId)` exposes two instant-commit handlers
(web-rule 217 DurationCell carve-out — no deferred Save bar), each `navigator.onLine`
-guarded (rule 29, pattern from `EditableStrip.commitDuration`):

- **Set committed start:** `updateTask.mutate({ id, projectId, planned_start: task.start })`.
  The task is already `IN_PROGRESS`, so the server's date-gated auto-promote
  (`_apply_date_gated_start_transition`, requires `instance.status == NOT_STARTED`)
  does **not** fire; `_sync_early_start_to_planned` prevents Gantt snap-back.
- **Move to To Do:** `updateTask.mutate({ id, projectId, status: 'NOT_STARTED' })`.
  Confirmed against `TaskSerializer.update`: this sticks — the date-gated promote
  needs `planned_start <= today` (null here) and no explicit status (we send one),
  so it never re-bumps. `usePromoteTask` is the *promote*-direction hook and is
  **not** used here (this is a demote).

**Stale `actual_start`:** `_apply_transition_actuals` has no `NOT_STARTED` branch,
so an `actual_start` stamped at `IN_PROGRESS` is retained after the demote. This is
**consistent with the existing board column-move demote** (In Progress → To Do
already PATCHes status only), so it is acceptable for 0.4 and must **not** be
patched client-side in this one hook. If we want To Do to always clear actual
dates, the fix belongs **server-side** in `_apply_transition_actuals` (add a
`NOT_STARTED` branch clearing `actual_start`/`actual_finish`) so every demote path
benefits uniformly — filed as a 0.5 data-integrity follow-up, not a #2313 blocker.

### 3. Ownership boundary with #2315 (lockstep)
- **#2313 (this WT)** ships: the chip → `<button>` conversion + the anchored
  popover (in `TaskListRow.tsx`, task-list row only) **and** the shared hook
  `features/schedule/useCommitStartOrTodo.ts`. Zero changes to `TaskScheduleStrip`
  / the drawer → **no conflict with #2315**.
- **#2314** is **folded into #2315**. #2315 is already rebuilding the drawer's
  schedule block ("delete the duplicate vitals strip; one authoritative Schedule
  block") and its scope says "coordinate the advisory with #2312–#2314, do not
  double-implement." So the drawer advisory banner + computed-START-cell marking
  land **inside #2315's redesign, consuming the #2313 hook** rather than
  reimplementing the mutation. #2314 is updated to a coordination/tracking issue;
  #2315 gets a note that the hook lands in #2313's MR.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Methodology translation layer now (Q1) | Satisfies agile personas immediately | No per-view methodology signal wired here; unscoped abstraction; chip/popover would disagree with shipped #2312 |
| Clear `actual_start` client-side in the hook (Q2) | To Do always "clean" | Diverges from existing board demote; one-off client fix for a server-side invariant |
| #2314 builds the drawer banner independently (Q3) | Ships sooner | Guaranteed merge conflict with #2315 on `TaskScheduleStrip`; double-implements the advisory |

## Consequences
- **Easier:** one hook is the single write path for both surfaces; #2315 imports it.
  #2313 is self-contained and mergeable without waiting on #2315.
- **Harder:** agile-persona copy stays in the 0.5 backlog (accepted trade).
- **Risks:** the shared hook's export path must be stable before #2315 consumes it
  — keep it at `features/schedule/useCommitStartOrTodo.ts`.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: web (only)
- Migration required: no
- API changes: no (reuses `PATCH /tasks/{id}/` via `useUpdateTask`)
- OSS or Enterprise: **OSS**

### Durable Execution
1. Broker-down behaviour: N/A at this layer — the hook calls `PATCH /tasks/{id}/`;
   the CPM recompute it triggers is already dispatched through the existing
   `scheduling/services.py::enqueue_recalculate` outbox path (ADR-0515/0151). No
   new async work is introduced by the frontend.
2. Drain task: N/A — reuses the existing schedule-recalc drain.
3. Orphan window: N/A (no new outbox category).
4. Service layer: reuses `enqueue_recalculate` via the existing task-update view.
5. API response: synchronous `PATCH` 200 with the updated task (existing contract).
6. Outbox cleanup: N/A (no new rows).
7. Idempotency: setting `planned_start`/`status` is naturally idempotent — the same
   PATCH twice yields the same task state.
8. Dead-letter / failure handling: on PATCH failure the optimistic update rolls back
   (existing `useUpdateTask` behavior) and the surface shows an inline error; offline
   is pre-guarded (rule 29) so no doomed write is queued.

## Blockers
None 🔴. #2313 is cleared to implement. #2315 must import the hook from the path
above (coordination note, not a blocker for #2313).
