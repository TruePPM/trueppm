# ADR-1153: User-Editable Actual Dates, and the REVIEW Finish Stamp

## Status

Accepted (2026-09-11)

> **Implementation status (2026-09-11):** ships with this ADR — the drawer Actual
> dates section (`packages/web/src/features/schedule/sections/ActualDatesSection.tsx`),
> the serializer guard `TaskSerializer._validate_actual_dates`, and the REVIEW branch of
> `TaskSerializer._apply_transition_actuals`
> (`packages/api/src/trueppm_api/apps/projects/serializers.py`). `actual_finish_source`
> is explicitly **deferred** — see Alternatives Considered.

## Context

**P3M layer:** Programs and Projects (OSS). Single-project task actuals and
single-project CPM placement; no cross-project or portfolio aggregation.

Two verified gaps (#3529):

1. **No user can state or correct an actual date anywhere in the product.** Every
   reference to `actual_start` / `actual_finish` in `packages/web/src` is a read
   surface — `ActivityTimeline` (a display set), `BaselineTab` (variance columns), a
   comment in `TaskScheduleStrip`. `useTaskMutations.ts` has declared
   `actual_start?` / `actual_finish?` in `UpdateTaskPayload` since it was written and
   no component has ever populated either. A PM who closes a task a week late has no
   affordance to say so; the dates become whatever the server stamped, and the only
   ways to change one are an MSP/CSV re-import or a direct API call.

2. **The contributor completion path records nothing.** `percent_complete = 100` with
   no explicit status routes `role >= ADMIN → COMPLETE`, everyone else `→ REVIEW`
   (`_apply_percent_complete_auto_status`). The `REVIEW` branch of
   `_apply_transition_actuals` stamps **neither** field. Contributors are the
   highest-frequency completers, so the highest-volume completion path leaves no
   actuals at all.

This matters because actuals are load-bearing. ADR-0132/ADR-0136 make a recorded
`actual_finish` the **pin** for a completed task's CPM placement, and every downstream
forecast reads that placement.

### What the engine already does with these two fields

Read directly from `packages/scheduler/src/trueppm_scheduler/engine.py`:

- `_is_complete()` (`engine.py:494`) — a task counts as finished when
  `actual_finish is not None` **or** `percent_complete >= 100`. The dataclass has no
  `status`, so completion is read from these two facts alone.
- `_pinned_placement()` (`engine.py:1017`) — a complete task with an `actual_finish`
  is pinned at `[actual_start or (full duration back from finish), actual_finish]`.
  A complete task with **no** actuals returns `None` and takes a full-duration
  *planning* position through the network instead.
- `_validate_task_actual_order()` (`engine.py:1931`) — `actual_start > actual_finish`
  raises `InvalidScheduleInput`. The API accepts that pair today, and the row then
  detonates at compute time: `models.py:43` records the consequence — *"then every
  recalculate_schedule throws InvalidScheduleInput → the run goes …"*. One bad PATCH
  poisons the whole project's recompute, not just its own row.

### Why REVIEW is already "complete" to the engine

`Task._coerce_signoff_percent()` (`models.py:3767`) forces `percent_complete = 100`
whenever `status` is `REVIEW` or `COMPLETE`. So a REVIEW task *already* satisfies
`_is_complete()` — it is already laid out at full duration. What it lacks is a pin.
Today it takes the **planning** position; with a stamped `actual_finish` it takes its
**real** position. This is a correction in the direction ADR-0136 already argues for,
not a new semantic.

### Why not a "Mark complete" dialog

The panel that produced #3529 was convened on a dialog proposal and converged against
it. Completion has three entry points — inline `percent_complete`, a `BoardView`
drag onto a `${phaseId}:${status}` droppable, and `POST /projects/{pk}/tasks/bulk/` —
one of which is a drag gesture and one a batch. A modal either interrupts a gesture
mid-motion, fires N times on a batch, or is silently bypassed on two of three paths,
which makes any claim that completed tasks carry actuals *a field that reads like a
constraint and enforces nothing*. The two 🔴 blockers this design answers, with the
observations that would falsify each:

- **A modal on the drag-to-Done path is a hard NO.** Falsified if contributor daily
  completion volume, read from the status-change audit log, does not drop in the two
  weeks after a dialog-gated completion ships to a beta cohort, and skip/abandonment
  on drag-completions stays low. Confirmed by a measurable completion-volume dip or
  high abandonment on the drag path.
- **A per-row modal violates "the same edit forty times, one motion".** Falsified if a
  beta PM uses bulk-complete regularly after such a change with no drop in usage and
  no complaint. Confirmed by a beta PM reporting the modal firing per-row, or by
  bulk-complete usage dropping.

A 🟡 also stands and is not resolved by this ADR: mandated actuals produce performative
data — falsified if a spot-check of entered actual dates shows real variance from the
completion timestamp, confirmed if they cluster on it. This design does not mandate
anything, so it does not create that pressure; it also does not measure it.

A separate constraint, raised independently from the integration and agent angles: if
an actuals requirement is ever implemented as a **server-side required field** on the
`COMPLETE` transition rather than a client-side prompt, an agent or integration with no
real start date is pushed toward supplying a fabricated one. **Keep any such
requirement client-side.** Nothing in this ADR is server-required.

These observations come from a simulated persona panel reasoning from domain knowledge.
No user was interviewed, surveyed, or observed, and nothing here may be reported as
customer feedback.

## Decision

**1. Editable actual dates live in a new registered drawer section, not a prompt.**

A new OSS `task_detail.section` registration, `ActualDatesSection`, at **priority 150**
on the Details tab (ADR-0050; 225 "Related tasks" is the existing precedent for a
non-multiple-of-100 OSS slot). It renders two `<input type="date">` controls,
`Actual start` and `Actual finish`, each committing a single `PATCH` on change.

It carries an `isPopulated` predicate (ADR-0605 progressive disclosure) that is true
when the task has either actual recorded **or** its status is `IN_PROGRESS` / `REVIEW`
/ `COMPLETE` — read from the task object alone, firing no query. A `NOT_STARTED` or
`BACKLOG` card therefore collapses the section behind "Add detail": no contributor tax,
and the drawer does not grow a permanently-open section that is empty for most rows.

The drawer is the right surface precisely because it is **low-frequency**. It is where
a PM or scheduler goes to inspect and correct one task, and it is not on any of the
three completion paths. **No completion path — inline, board drag, or `tasks/bulk/` —
gains a blocking dialog.**

**2. Server-side validation of the pair, in `TaskSerializer.validate()`.**

`_validate_actual_dates(attrs)`, wired into the existing `validate()` helper chain,
mirroring `_validate_three_point_order` in both shape and policy:

- It runs **only when the write touches `actual_start` or `actual_finish`**, so an
  unrelated PATCH to a task carrying pre-existing invalid actuals (legacy rows, MSP
  imports) is not blocked. Same policy as the project-span and three-point guards.
- It resolves each field from **payload-else-instance**, so a partial PATCH that
  crosses the invariant against a stored value is still rejected.
- **Ordering:** with both present, `actual_start <= actual_finish`. This mirrors the
  engine's own `_validate_task_actual_order` so the API can never accept a pair that
  detonates the project's next recompute. The error is raised on `actual_finish` and
  names both values.
- **Upper bound:** neither field may exceed
  `max(resolve_cpm_status_date(project.status_date), today)`. The data date is
  `Project.status_date`, resolved through the single existing helper
  (`scheduling/services.py:54`), which floors a null at today.
- **Sign-off gate on `actual_finish`:** it may only be set on a task whose **effective**
  status — payload-else-instance, so one `PATCH` may carry both — is `REVIEW` or
  `COMPLETE`. `actual_start` carries no status restriction.
- Half-populated rows — an `actual_finish` with no `actual_start` — remain **valid and
  by design** (ADR-0136). Neither field is required, ever.

**Why the sign-off gate exists (`ai-review` check 3, write safety).** The engine reads
completion as `actual_finish is not None or percent_complete >= 100` (`engine.py:494`).
So `PATCH {actual_finish: …}` on a 40%-complete `IN_PROGRESS` task makes the engine pin
it as finished while the board still shows it in flight — an impossible state an agent
or integration can reach in one write, and one the new drawer section would otherwise
*offer*. The invariant is not new intent: `_apply_transition_actuals` already clears
`actual_finish` when a task is reopened out of `COMPLETE`, and `_coerce_signoff_percent`
already treats `REVIEW`/`COMPLETE` as the two states that mean "delivered". The gate
just states the same rule on the write path instead of only on the reopen path.

It does not block the issue's motivating cases. A PM correcting a late close edits a
`COMPLETE` task. A contributor who finished Friday and updated the board Monday drags to
Done/Review — status becomes `REVIEW`/`COMPLETE`, the finish auto-stamps Monday — then
corrects it to Friday in the drawer. And because the check resolves the status
payload-else-instance, an agent or offline client can send
`{status: "COMPLETE", actual_finish: "2026-09-04"}` as **one** write. The one path it
does narrow is a client sending `actual_finish` alone for a task the server still holds
at `IN_PROGRESS`; that now returns `400` with a reason naming the field, rather than
silently producing the contradictory state. `actual_start` is left unrestricted on
purpose — `_apply_date_gated_start_transition` legitimately back-stamps it on a task
`validate()` still sees as `NOT_STARTED`, and ADR-0136's whole argument is that
`actual_start` is the permissive, derivable half of the pair.

`TaskSerializer` is reused by the sync upload path (`sync/upload.py`) and per-row by
`task_bulk.py`, so one guard covers REST, bulk, and sync. That is deliberate: the
invariant is about the row, not the transport.

**Why `max(data date, today)` and not the data date alone.** `status_date` is a PM's
explicit data date and is frequently **stale** — a project last statused in January
still carries January. Bounding at the raw data date would reject a PM recording a
finish of *today*, which is the single most common legitimate entry, and would also
invalidate the serializer's own `today` auto-stamps. Bounding at
`max(data date, today)` rejects what the acceptance criterion actually targets — a
date in the future — while honoring a deliberately **forward**-dated data date. The
auto-stamps are additionally out of reach by construction: `validate()` runs before
`update()`, and the auto-stamp helpers write into `validated_data` inside `update()`,
so a server-written `today` is never re-validated.

**3. Stamp `actual_finish` on the `→ REVIEW` transition; do not touch `actual_start`.**

`REVIEW` means "work is done, awaiting sign-off", so the finish date is known at that
moment, and the engine already treats the row as complete via the forced
`percent_complete = 100`. Stamping gives it a real pin instead of a planning position.

`actual_start` stays untouched. **ADR-0136 is unchanged and this ADR does not argue
against it**: a card that jumped to done without ever being `IN_PROGRESS` never
recorded a start, and stamping "today" would collapse its bar to a single day. Leaving
it null lets `_pinned_placement` derive the historical span backward from the finish.
Half-populated rows stay by design.

**4. Clear `actual_finish` when a task is reopened *from* `REVIEW`, not only from
`COMPLETE`.** The existing clear in `_apply_transition_actuals` keys on
`old_status == COMPLETE`. Stamping on REVIEW without widening that key would strand a
stale `actual_finish` on a `REVIEW → IN_PROGRESS` reopen — a task pinned as finished
while it is being worked. The condition becomes
`old_status in (COMPLETE, REVIEW)`. This is a direct consequence of decision 3 and is
not separable from it.

**5. The web `Task` type gains `actualStart` / `actualFinish`, carried by `mapTask`
only — not by `applyTaskDatesDelta`.** Actuals are *inputs* to CPM, not outputs of it.
`TaskDatesDelta` (the `task_dates_updated` WebSocket payload) carries early/late/float/
`planned_start` and no actuals, so splicing them there would mean inventing a value.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Editable fields in a drawer section** (chosen) | No modal on any completion path; the only correction path; low-frequency surface, so no contributor tax; one write path to test | Discoverability depends on the drawer; does not increase actuals *capture* rate on its own |
| B. "Mark complete" dialog capturing both dates | Highest capture rate at the moment of completion | Interrupts the board drag gesture; fires per-row on a bulk edit; silently bypassed on two of three paths, so it enforces nothing while reading as a guarantee. Both 🔴 blockers land here |
| C. Fields inside the existing `OverviewSection` | No new registration; dates sit beside status and progress | `OverviewSection` is always-open and already 405 lines; two date inputs would show permanently on every `BACKLOG` card, which is exactly the contributor tax this issue exists to avoid. Loses the ADR-0605 predicate |
| D. Server-side required `actual_finish` on `COMPLETE` | Guarantees the field is populated | Pushes an agent or integration with no real date toward fabricating one. Explicitly rejected — any such requirement stays client-side |
| E. Model-level `CheckConstraint` for the ordering | DB-enforced, unbypassable | The table is populated and legacy/imported rows may already violate it, so it needs a `RunPython` repair on an upgrade path that runs at container start (see the migration-discipline rule). It would also reject the half-populated rows' neighbours no more effectively than the serializer, while blocking every non-serializer writer including the MSP importer. Deferred; the serializer guard plus the engine's own check is the proportionate answer |
| F. Ship `actual_finish_source` in this issue | Makes "a human verified this date" an API-readable fact | Needs a model field, a migration, and a design answer for who counts as `user-confirmed` across three write paths plus the importer. **Deferred to a follow-up issue** — it is separable and was marked so in #3529 |

## Consequences

**Easier**
- A PM or scheduler can state and correct an actual date. It is the only such path.
- A contributor's completion now records a finish date, so the highest-volume
  completion path stops producing unplaced completed work.
- A `REVIEW` task moves from a planning position to its real pin, so forecasts
  downstream of it read a truthful placement.
- The API can no longer accept an inverted pair that kills the project's recompute.

**Harder**
- One more condition in `_apply_transition_actuals`. The REVIEW branch stops being a
  documented no-op, so its comment must now explain what it *does* and why
  `actual_start` is still left alone.
- The reopen-clear condition now covers two source statuses, and a future sixth status
  would have to decide which set it joins.

**Risks**
- **Stale `status_date` upper bound.** Mitigated by `max(data date, today)`, above.
- **Legacy invalid rows.** The guard runs only when the write touches an actual field,
  so existing bad rows stay editable through every other field — but they also stay
  bad, and the engine will still reject them at compute time. Correcting them is what
  the new drawer section is for.
- **`REVIEW → IN_PROGRESS` reopen.** Covered by decision 4; it is the one path that
  decision 3 would otherwise break, and it is the thing to check first if a task
  appears pinned while in flight.
- **Source attribution is not available.** An agent reading `actual_finish` cannot tell
  an auto-stamp from a human statement *from the field*. It is derivable from the task
  history — an auto-stamp changes in the same revision as the `status` that triggered
  it — but only by reasoning over revisions, and only inside the 90-day
  `HistoricalTask` retention window. Making it a first-class fact is exactly what the
  deferred `actual_finish_source` would do. Recorded here as a known limitation rather
  than left implied by the deferral.
- **Adoption is unmeasured.** The recommendation's own falsification line: falsified if,
  six months after it ships, the edit endpoint shows near-zero use; confirmed by
  recurring use, or by a beta user asking how to fix a wrong completion date. Nothing
  in this ADR instruments that.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: **api**, **web**. `scheduler` is **unchanged** — the engine
  already reads, pins on, and validates both fields; this ADR only changes what the API
  writes into them.
- Migration required: **no**. Both columns already exist on `Task`, and both are
  already in `TaskSerializer.Meta.fields` and absent from `read_only_fields` — the REST
  API has always accepted writes to them. The gap was validation and a UI, not storage.
- API changes: **no new endpoint**. `PATCH /api/v1/tasks/{id}/` gains two validation
  rules (`400` on an inverted pair or a future date) and one new auto-stamp on the
  `→ REVIEW` transition. `docs/api/openapi.json` regenerates unchanged in shape.
- OSS or Enterprise: **OSS**. Recording when a task actually started and finished is
  what a single PM and team need to run one program. No cross-program aggregation, no
  org policy, no compliance evidence.

### Durable Execution

1. **Broker-down behaviour:** unchanged. A task write already enqueues a CPM recompute
   through the transactional outbox via
   `scheduling/services.py::enqueue_recalculate()`; an actuals edit is an ordinary task
   write and rides that same path. No new dispatch site.
2. **Drain task:** reuses the existing `ScheduleRequest` outbox drain. Semantics match
   exactly — the work queued is a project recompute, which is what that drain exists to
   re-dispatch.
3. **Orphan window:** N/A — no new outbox category. The schedule-request drain's
   existing 10-minute filter applies unchanged.
4. **Service layer:** `scheduling/services.py::enqueue_recalculate()`, already called by
   the task write path. No new function.
5. **API response on best-effort dispatch:** N/A — `PATCH /tasks/{id}/` is synchronous
   and returns the updated task; the recompute it triggers was already asynchronous and
   its contract does not change.
6. **Outbox cleanup:** N/A — no new outbox rows beyond the schedule requests already
   produced by any task write, which the existing nightly 7-day purge covers.
7. **Idempotency:** the write is a `PATCH` setting absolute date values, so replaying it
   is a no-op. The `→ REVIEW` stamp is guarded by `new_status != old_status`, so
   re-saving a task already in `REVIEW` does not re-stamp, and by
   `"actual_finish" not in validated_data`, so an explicit client value always wins over
   the auto-stamp.
8. **Dead-letter / failure handling:** N/A — no new task. A recompute that fails
   permanently already surfaces through the existing `ScheduleRequest` failure status.

### On Acceptance

- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1153` — **0 issues**
      (this ADR is new with #3529 and no issue predates it).
- [x] Any issue carrying pre-ADR scope rewritten — **0**. #3529 was written against the
      panel finding, and this ADR implements its recommendation without rejecting any
      option the issue proposed; `actual_finish_source` was already marked separable in
      the issue body and is deferred, not rejected.
