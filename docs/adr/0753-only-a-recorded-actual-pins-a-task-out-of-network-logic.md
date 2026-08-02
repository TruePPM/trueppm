# ADR-0753: Only a Recorded Actual Pins a Task, and Completed Work Cannot Finish in the Future

## Status

Proposed — amends ADR-0023 (field independence), ADR-0136 (completed-task layout), and
ADR-0132 (§ edge cases); extends ADR-0752 (span vs remaining window, Accepted).
Resolves #2664.

## Context

**P3M layer:** Programs and Projects (single-project CPM and the schedule surface a PM
uses daily). **OSS** — core scheduling IP; no cross-program aggregation.

Setting a task's progress to 100% moves its bar **backward**, in the reported case 13 days,
landing it entirely before the finish of its own FS predecessor. Verified on a live dev
project (`status_date` NULL, today 2026-07-31):

| name | status | pct | dur | planned_start | actual_start | actual_finish | early_start | early_finish |
|---|---|---|---|---|---|---|---|---|
| first task | COMPLETE | 100 | 4 | 2026-07-19 | 2026-07-19 | 2026-07-31 | 2026-07-19 | 2026-07-31 |
| second task | REVIEW | 100 | 4 | 2026-07-19 | 2026-07-19 | *(null)* | 2026-07-19 | 2026-07-22 |
| third task | REVIEW | 100 | 10 | 2026-07-18 | *(null)* | *(null)* | 2026-07-24 | 2026-08-06 |

`first task —FS(0)→ second task —FS(0)→ third task`, default Mon–Fri calendar.

### The engine is behaving correctly on bad input

`_pinned_placement` (`engine.py:947-953`, mirrored byte-for-byte in
`wasm-scheduler/src/forward.rs:181-204`) sees `actual_start` set and `actual_finish` null,
lays the full duration forward from the actual, and **leaves network logic entirely**. That
is exactly what ADR-0136 specifies. The defect is upstream: nobody recorded that actual.

### How a fabricated actual gets into the row

**ADR-0023** is explicit that this must not happen:

> `planned_start` and `actual_start` are **independent fields** that serve different
> purposes and must not be conflated […] `planned_start` — the SNET constraint fed into the
> CPM forward pass. It is the PM's intent, not a record of what happened. Updated when the
> PM explicitly changes the constraint; **never auto-set from work events**.

`_apply_date_gated_start_transition` (`serializers.py:4383-4405`, #336) sets
`actual_start = planned_start`. That is the same conflation in the other direction. Its own
test records the reasoning:

```python
# Past date must be preserved, not overwritten by the auto-`actual_start = today`
assert task.actual_start == date.fromisoformat(past)
```

A PM back-dates `planned_start`; the rule auto-starts the task; stamping `actual_start =
today` would be wrong; so #336 substituted the past date. Locally reasonable — but it
accepts the premise that an auto-detected transition must record an actual at all.

### ADR-0136 already rejected that premise, and its fix expired

ADR-0136 removed the other fabricated-actual source and named this exact failure in its
Context:

> **Contributor completion** — marking 100 % as a non-admin auto-promotes to `REVIEW`,
> which sets `actual_start = today` but never `actual_finish`.

Its write-path amendment:

> On the `COMPLETE` and `REVIEW` transitions, **stop auto-filling `actual_start = today`
> when the task has no prior start.** […] A genuine `actual_start` recorded at
> `IN_PROGRESS` is still preserved.

The load-bearing word is **genuine**. ADR-0136 drew its line at the *transition*, on the
premise that an `IN_PROGRESS` transition is a human act. #336 (date-gated auto-start) and
#362 (`_apply_progress_auto_promote`, `:4407-4427`) subsequently made `IN_PROGRESS`
**auto-detected**. The actual is now auto-derived from an auto-transition — two layers of
inference — and ADR-0136's premise silently expired. The same defect returned through a
different door, with `planned_start` substituted for `today`.

### The second, independent defect: nothing bounds a completed task's finish

`third task` is 100% complete with no actuals. It takes ADR-0136's "neither" row — network
position, full duration, unfloored — and lands **Jul 24 → Aug 6**, six days past today.
Nothing anywhere says that work reported done cannot be scheduled to finish in the future.

These two defects pull in opposite directions and **must be fixed together**: once the
fabricated `actual_start` stops pinning `second task`, it falls to the network branch and
lands Aug 3 → Aug 6 — a completed task sitting entirely in the future. The start-side fix
*manufactures* instances of the finish-side defect from data already in the database, with
no user edit involved.

### The constraint that shapes the answer

ADR-0132 has already decided a neighbouring case, and it must not be overturned:

> *Completed task, `actual_finish` in the future* → pinned to the given date (actuals are
> trusted); it floors successors accordingly.
> *Completed task, `actual_finish` before predecessors* → pinned anyway; successor float may
> go negative. **Not an error.**

So "clamp a completed task's finish to the data date" cannot be a blanket rule — it would
overturn ADR-0132 for recorded actuals. The line that preserves both: **a recorded actual is
an assertion and is trusted unclamped; a task complete by percent alone has asserted
nothing.**

### Scope boundary

**#1445** (0.7) is the full data-date update cycle — retained logic vs progress override,
selectable modes. This ADR does **not** pre-empt it. The rule below is not a mode: it is a
correctness bound that holds under both retained logic and progress override, because
neither mode implies that finished work may be scheduled in the future.

## Decision

### 1. Only a *recorded* actual pins a task out of network logic

The engine's contract is unchanged — an actual is truth (ADR-0136). What changes is that
the API stops manufacturing actuals. Provenance is a write-path concern and never reaches
the engine, so `_pinned_placement` and its Rust mirror need **no change** for this half and
carry **no conformance risk**.

| Trigger | `actual_start` |
|---|---|
| Explicit `actual_start` in the payload | recorded — truth, pins (unchanged) |
| Explicit `status: IN_PROGRESS` in the payload | `today` — a human asserted work began (unchanged, ADR-0023) |
| **Injected** status from #336 date-gating (`:4401-4405`) | **null** (changed) |
| **Injected** status from #362 progress-promote (`:4426-4427`) | **null** (changed) |

This is ADR-0136's own remedy — *leave it null and let the engine derive* — extended to the
two transitions ADR-0136 did not reach. It reinstates ADR-0023's field independence.

**No provenance column.** The codebase's established convention for this distinction is
**absence, not a flag**: ADR-0136 made `actual_start IS NULL` mean "no genuine actual was
recorded" and required consumers to fall back to the engine's derived start. A column would
also not help retroactively (see Consequences), so it buys nothing the null does not.

### 2. A completed task with no recorded actuals cannot finish after the data date

Let `T` be the resolved data date and `dur` the task's full working-day duration.

For a task that is complete (`percent_complete >= 100` or `actual_finish` set) **and has
neither actual recorded**, ADR-0136's "neither" row still positions it — predecessor /
`planned_start` / project start, unfloored — and then a **ceiling** applies:

> If `early_finish > T`, set `early_finish = T` and `early_start =
> _start_from_finish(T, dur, calendar)`.

Full duration is preserved; the bar keeps its shape (ADR-0136's core rule). Tasks with a
recorded actual are **exempt** — ADR-0132's future-actual and out-of-sequence rulings stand
untouched.

**This collapses the three cases #2664 proposed into one rule.** With `[S, F]` the
pre-clamp window: `F < T` → the ceiling does not bind, nothing changes (case 1);
`S ≤ T ≤ F` → pulled back to `[T−dur+1, T]` (case 2); `S > T` → pulled back to the same
place (case 3). Case 3 was the open question in #2664 and it is not a special case at all —
it is the ceiling binding harder.

### 3. The REVIEW-vs-COMPLETE question dissolves

ADR-0136's binding constraint:

> The scheduler package has zero Django dependencies […] Completion must be detected from
> `percent_complete`/`actual_finish`, **never `status`**.

The rule in §2 is therefore stated in engine terms, and the status question answers itself.
In practice: a `COMPLETE` task always carries `actual_finish = today`
(`serializers.py:4504-4505`), so it is exempt and its finish is already `T`. The ceiling
bites `REVIEW` tasks (100%, no `actual_finish` by deliberate design, `:4491-4501`) and
imported or seeded data. Both observed cases, and no new coupling to `status`.

### 4. The clamped finish is CPM layout — it is **not** persisted as `actual_finish`

Writing the clamp back as an actual would fabricate an actual to fix a bug caused by
fabricated actuals. `early_start`/`early_finish` are already CPM outputs written by the
existing `bulk_update` with no `server_version` bump (ADR-0091); the clamp changes their
values and nothing else. This also keeps §2 idempotent and keeps #2664 out of #2639's write
path.

### 5. A resolved data date is a hard prerequisite

`T` must exist. On the CPM path it currently does not: `cpm_status_date =
project.status_date` is passed raw (`scheduling/views.py:1021-1022`) and is NULL on
essentially every project. **ADR-0752 §4 already decides this** — null resolves to today in
the shared input builder, and the resolved date is echoed on the payload. This ADR does not
re-decide it; it **depends** on it. Without §4, the ceiling has no `T` to bind against on
the deterministic path and would silently no-op.

The Monte Carlo path already resolves `status_date or timezone.localdate()`
(`views.py:550, 1022`) and needs no change. `_completed_dates` (`engine.py:2761-2833`) runs
a throwaway forward pass and reads the result back, so MC inherits the ceiling for free.

### 6. ADR-0752's span table survives unchanged

Because §2 preserves full duration, a completed task's `early_start..early_finish` remains
its full span, so ADR-0752 §2's row — *Complete → `scheduled_start` = `early_start`* — still
holds. No amendment needed.

(Noted in passing, not decided here: ADR-0752 §1 says `early_*` is "the remaining-work
window — always", while its own table relies on completed tasks carrying a full-duration
`early_*`. For a completed task the remaining window is empty, so §1's "always" already has
a documented exception. That is ADR-0752's to reconcile before it is Accepted.)

### 7. Conformance

Both engines must implement §2 identically. **`wasm:conformance` cannot validate this
change on its own** — it compares the engines to each other, and they currently share the
divergence, so agreement proves nothing. Fixtures must assert against §2's rule directly, in
each engine's own suite as well as the shared set.

ADR-0136 stated that the shared fixtures "carry **no** progress fields and must stay that
way." **That constraint is already superseded in practice** — `packages/wasm-scheduler/fixtures/`
carries `progress_completed_pin.json`, `progress_in_progress_remaining.json`,
`progress_status_date_floor.json`, `progress_completed_percent_only_constraints.json`,
`progress_completed_successor_no_backward_constraint.json`, `progress_out_of_sequence.json`,
and `progress_weekend_finish_late_seed.json`. Adding progress fixtures is consistent with
current practice; ADR-0136's sentence should be marked superseded rather than worked around.

Required new fixtures, one per row:

- complete, no actuals, `F < T` → unchanged (the inertness regression fixture)
- complete, no actuals, `S ≤ T ≤ F` → `[T−dur+1, T]`, full duration preserved
- complete, no actuals, `S > T` → same, ceiling binding harder
- complete, `actual_finish` in the future → **not** clamped (ADR-0132 preserved)
- complete, `actual_start` only, recorded → **not** clamped, pins as today (ADR-0136 preserved)
- milestone (`dur = 0`), complete, no actuals → `early_start == early_finish == T`
- no progress anywhere → byte-identical to today's output

`derive.py:_completed_forward_contribs` (`:193-238`) mirrors `_pinned_placement`'s branches
for the explainability graph and must gain the ceiling as a named contribution, or
"why is this task's finish this date?" will answer with the pre-clamp network date.
ADR-0218 already defines `data_date` as an anchor kind, so no new vocabulary is needed.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Recorded-actuals-only pin + data-date ceiling (chosen)** | Fixes both defects with one rule each; three cases collapse to one; engine contract for actuals untouched; no schema change | Two-part change across write path and both engines; existing fabricated actuals are not cleaned retroactively |
| Keep `S`, clamp `F = T` (as proposed in #2664 case 2) | Preserves the network-derived start; smaller visual movement | Shrinks the bar below `dur` — reintroduces precisely the defect ADR-0136 exists to fix ("completed work loses its span"). And `S` carries no evidentiary weight when no actual was recorded; it is only where CPM put it |
| Reject the 100% edit unless actuals are supplied | Refuses to invent history; strongest data quality | Cannot be the whole answer — §2's condition arises from *existing rows* with no edit at all. Also hostile to the common, legitimate "I finished it early" case. Viable later as an *additional* prompt (ADR-0057 deferred exactly this "progress-anchor gate" to #362) |
| Collapse the completed task to a point at `T` | Trivial | Discards duration; re-runs ADR-0136's original bug |
| Leave it in the future and flag it in the UI | No engine change | A schedule that shows finished work in the future is wrong, not merely unlabeled. A badge does not make the Gantt or the API correct, and utilization (#2623) would still window off future dates |
| Add `actual_start_source` provenance enum (`RECORDED`/`INFERRED`) | Explicit; `DurationChangeSource` and `TimeEntrySource` are precedents | Solves nothing the null does not; cannot disambiguate rows already written (an inferred `actual_start == planned_start` is indistinguishable from a genuine on-time start); adds a column, a migration, and a field both engines must learn |
| Revert #336 entirely (no date-gated auto-start) | Removes the conflation at its source | Throws away a wanted behavior — back-dating `planned_start` *should* start the card. Only the fabricated actual is wrong |
| Floor completed tasks at the data date instead of a ceiling | Symmetric with the in-progress floor | Backwards: ADR-0136 is explicit that completed work is historical and must *not* be floored. The bound needed is an upper one |

## Consequences

**Easier**

- Marking work done stops moving its bar to a date nobody asserted.
- Completed work can no longer be scheduled to finish in the future — on the Gantt, in the
  API, and in resource utilization (#2623 windows off these same dates).
- `actual_start` regains the meaning ADR-0023 gave it: a record of what happened. Consumers
  that already fall back to `early_start` on null (required by ADR-0136) need no change.
- #2664's three-case table becomes one rule, so there is one thing to test and explain.

**Harder / risks**

- **Existing fabricated actuals are not cleaned up, and cannot safely be.** An
  `actual_start` equal to `planned_start` is exactly what a genuine on-time start looks
  like; no migration can tell them apart, and a blanket backfill would erase real data.
  **The write-path fix is forward-only.** The reported `second task` keeps its bad pin until
  someone clears the actual. This is a deliberate refusal to guess, and it must be stated in
  the changelog rather than discovered. ADR-0603 already tracks a sibling residue (demoting
  a task to `NOT_STARTED` leaves a stale `actual_start`) as a 0.5 follow-up; these should be
  resolved together, and clearing an actual needs a UI affordance, not just a PATCH.
- **Completed tasks with no actuals pile up against the data date.** A chain of three such
  tasks all end at `T`, losing their relative order. This is the honest rendering of "we
  know only that this is done" — but it will read as a stack, and the remedy is to record
  actuals. Surfacing a missing-anchor cue (ADR-0603's "no committed start" chip is the
  existing pattern) belongs with this change, not after it.
- **Out-of-sequence overlap becomes more visible, not less.** Post-fix, `second task` lands
  Jul 28–31 against a predecessor finishing Jul 31. That overlap is real and ADR-0132 says
  surface it. Users will read it as a bug at first; `docs/features/` must say why it is not.
- **Core-IP change to both engines**, with a gate that structurally cannot catch a shared
  divergence (§7). New fixtures must be written from the ADR text.
- Two engine behaviors now depend on the resolved data date, so §5's prerequisite is load
  bearing: if ADR-0752 §4 does not land first, this ADR ships as a silent no-op on the
  deterministic path.

**Rejected as out of scope**

A `NOT_STARTED`-demotion cleanup for `actual_start` (ADR-0603's 0.5 item), a progress-anchor
input gate (ADR-0057 → #362), and retained-logic/progress-override mode selection (#1445).

## Implementation Notes

- **P3M layer:** Programs and Projects
- **Affected packages:** `scheduler` (forward pass + `derive.py`), `wasm-scheduler`
  (`forward.rs`), `api` (`TaskSerializer` write path), `web` (none required — the bar reads
  CPM output; the missing-anchor cue is a separate, recommended follow-up)
- **Migration required:** **no** — no schema change. §1 changes what is written to existing
  columns; §2 changes computed CPM output.
- **API changes:** behavioral only. `actual_start` is no longer auto-stamped on an
  *injected* status transition; `early_start`/`early_finish` on completed no-actuals tasks
  are bounded by the data date. OpenAPI surface unchanged.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). `make enterprise-boundary-check` — zero
  imports; the six `trueppm_enterprise` matches under `packages/` are all prose.
- **Tests that encode the current behavior and must be re-decided, not merely updated:**
  `test_actual_dates.py::test_planned_start_past_promotes_and_pins_actual_start` (asserts
  #336's conflation directly) and `test_progress_gate.py::test_auto_promote_sets_actual_start`.

### Sequencing

1. **ADR-0752 §4** — resolved data date on the CPM path. Hard prerequisite (§5).
2. **§1 write path** — injected transitions stop writing `actual_start`; re-decide the two
   tests above.
3. **§2 engine half** — the ceiling in Python and Rust, plus `derive.py` contributions and
   the §7 fixtures.
4. Changelog fragment stating the forward-only cleanup posture and the one-time date shift.
5. Follow-ups, filed separately: missing-anchor cue, ADR-0603's demotion residue.

### Durable Execution

1. **Broker-down behaviour:** N/A — no new async work. Both halves ride the existing CPM
   recompute, dispatched through `scheduling/services.py::enqueue_recalculate()` (the
   transactional outbox, ADR-0027), never a bare `.delay()`.
2. **Drain task:** Reuses the existing schedule-request drain. No new category of async work
   — §2 changes what an existing job computes, §1 changes a synchronous serializer path.
3. **Orphan window:** N/A — no new outbox rows; the existing 10-minute schedule-request
   threshold applies unchanged.
4. **Service layer:** Existing. `build_sched_tasks()` (`scheduling/services.py:426`) remains
   the single mapping layer and is **unchanged** — it keeps passing `actual_start` verbatim,
   which is correct once §1 stops fabricating the value. The data-date resolution lands in
   the shared builder per ADR-0752 §4, not at the call sites.
5. **API response on best-effort dispatch:** N/A — no new dispatch path. A task PATCH returns
   synchronously; CPM recompute remains the existing async follow-up.
6. **Outbox cleanup:** N/A — no new outbox category.
7. **Idempotency:** Unchanged and strengthened. The ceiling is a pure function of
   `(task state, calendar, network, resolved data date)`; §4's refusal to persist the clamp
   as an actual is what keeps it so — a persisted clamp would feed back as input and drift on
   every recompute. As in ADR-0752 §7, "the same inputs" now includes the resolved data date,
   so two runs on different days legitimately differ; the echoed date discloses it.
8. **Dead-letter / failure handling:** Unchanged — inherits existing CPM retry/DLQ behavior
   (ADR-0017/0084). `_start_from_finish` is already on the completed-task path, so its
   calendar-scan bound (#908, surfaced as `InvalidScheduleInput` → 400) introduces no new
   failure mode.
