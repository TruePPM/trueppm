# ADR-0074: Sprint → Milestone Rollup (OSS, 0.2)

## Status
Accepted (2026-05-19) — implemented on main; status corrected 2026-06-30 after ADR audit (verified: batch_compute_milestone_rollup)

## Context

`Sprint.target_milestone` (ADR-0037) links a sprint to a Gantt milestone task.
Today this link is display-only — the `AdvancingToMilestoneCard` (SprintsView)
shows the milestone name + planned date, but the milestone's `percent_complete`
and date variance are not updated as the sprint progresses. The PM in the
Gantt view sees the milestone sit at whatever value was last manually entered;
the Scrum Master in the sprint view sees burndown that never propagates upward.

ADR-0036 (hybrid PM philosophy) and ADR-0065 (hybrid bridge v1.1) both promise
that sprint completion auto-advances the schedule view "without a reconciliation
step." Closing the rollup gap is the lowest-cost realisation of that promise
and the strongest OSS-adoption signal per VoC: Jordan (PO) and Alex (SM) both
scored 8/10 🟢 — the rule from `personas.md` says when a PO + SM both delight
on the same feature, it belongs in OSS without further debate.

**P3M layer**: Programs and Projects → Operations. Single-project scope.
Cross-program or portfolio rollup is out of scope (Enterprise).

**VoC panel** (avg 5.6/10, no 🔴 blockers): Jordan 8 🟢, Alex 8 🟢, Morgan 7 🟢,
Marcus 6 🟡, Janet 4 🟡, Sarah 4 🟡, David 4 🟡, Priya 4 🟡. The four 4-6
scores are all about *additional surfaces* (portfolio digest, resource conflict
detection, mobile/offline, Jira sync) — not about this rollup being wrong.
Address those in their own features.

## Decision

Add a centralised milestone-rollup service that recomputes a milestone Task's
`percent_complete` and a sprint-vs-milestone `variance_days` from the set of
sprints targeting it (`Task.targeting_sprints` reverse relation). Surface the
result via a new `MilestoneRollupSerializer` attached to the milestone task and
through a single new WebSocket event type (`milestone_rollup_updated`). No new
fields on the Task model — the rollup is **computed on serialize and on broadcast**
from the existing `Sprint.committed_*` / `Sprint.completed_*` snapshots.

### Rollup formula

```python
# Sum across all sprints with target_milestone = milestone_id
committed_points  = sum(s.committed_points or 0 for s in targeting_sprints)
completed_points  = sum(s.completed_points or 0 for s in targeting_sprints)
committed_tasks   = sum(s.committed_task_count or 0 for s in targeting_sprints)
completed_tasks   = sum(s.completed_task_count or 0 for s in targeting_sprints)

if committed_points > 0:
    percent_complete = min(100.0, (completed_points / committed_points) * 100)
    rollup_basis     = "points"
elif committed_tasks > 0:
    percent_complete = min(100.0, (completed_tasks / committed_tasks) * 100)
    rollup_basis     = "tasks"  # throughput fallback for #NoEstimates teams
else:
    percent_complete = None    # N/A — falls back to manual value
    rollup_basis     = "none"

# Variance: positive = sprints will finish AFTER the milestone (slip)
latest_sprint_finish = max(
    (s.finish_date for s in targeting_sprints if s.state in {ACTIVE, PLANNED}),
    default=None,
)
variance_days = (latest_sprint_finish - milestone.early_finish).days if both present else None

# Scope-change indicator (computed once per recompute, not stored)
active_sprint_points_now = sum(t.story_points for t in active_sprint.tasks.committed())
sprint_scope_changed = (active_sprint_points_now != committed_points_of_active_sprint)
```

The percent is **capped at 100** to handle the "team over-delivered against
committed scope" case (Alex 🟡 concern: committed denominator goes silent
when scope is added mid-sprint). The cap plus the `sprint_scope_changed` flag
makes the math honest without forcing a redenominator on every commit.

### Trigger points

The rollup runs on three event paths, all centralised through
`services.recompute_milestone_rollup(milestone_id)`:

1. **Sprint state transitions** (`activate`, `cancel`, and the `apply_close`
   block inside `drain_sprint_close_requests`). Inside the same transaction
   that already runs `snapshot_committed_metrics` / `snapshot_completed_metrics`.
   This is the **authoritative** path — guaranteed-correct numbers settle here.
2. **Task `post_save` signal** for tasks where `task.sprint_id IS NOT NULL`
   AND the sprint has a `target_milestone_id`. Filter early to avoid scanning
   non-sprint tasks. This gives the **live** experience during an active
   sprint — moving a task to COMPLETE on the Board immediately bumps the
   milestone in the Gantt.
3. **Sprint create/update/delete** when `target_milestone_id` changes
   (re-link). Recomputes both the OLD and NEW milestones so neither holds
   a stale roll-up.

The signal path is **best-effort** — it dispatches `transaction.on_commit()`
and tolerates broker failure silently. The authoritative path on sprint close
runs inside the existing `SprintCloseRequest` drain (ADR-0037), so any signal
that was missed during an outage is healed on the next sprint state transition.

### Read-only enforcement

When a Task has `targeting_sprints.filter(is_deleted=False).exists()`,
`TaskSerializer.validate_percent_complete()` rejects user writes:

```json
{ "percent_complete": "This milestone's progress is rolled up from its linked sprint(s) and cannot be edited manually. Close or unlink the sprint to edit." }
```

No override path in v1. PMs who need to override (Alex's 🟡 "quarter-end
override" concern) close the sprint first; subsequent edits unlock automatically
when no targeting sprints remain. The audit trail comes for free —
`HistoricalTask` already tracks `percent_complete` (ADR-0011); rollup-driven
updates show up in history attributed to the system user, with the source sprint
inferred from co-located historical rows on the linked sprints.

### Broadcast payload shape

A single new event type, `milestone_rollup_updated`, fired via
`broadcast_board_event()` after every recompute that actually changed the
rolled-up value:

```json
{
  "milestone_id": "<uuid>",
  "percent_complete": 73.5,
  "rollup_basis": "points",
  "variance_days": 3,
  "sprint_scope_changed": false
}
```

**Aggregated only**. No per-assignee task lists, no raw committed/completed
point counts, no velocity history. This is Morgan's 🟡 concern: the broadcast
must not become a side-door surveillance pipe leaking team internals to
anyone with project-read access. Raw sprint metrics remain on the
SprintSerializer, gated by the existing project membership permission.

### Variance computation

`variance_days = latest_sprint_finish - milestone.early_finish`, where
`latest_sprint_finish` is the max `finish_date` across ACTIVE + PLANNED
sprints targeting the milestone. The COMPLETED state is excluded — once a
sprint is closed its dates are historic, not predictive. Positive value =
sprints will finish *after* the milestone = slip.

For milestones, `early_finish == early_start` (zero-duration task); use
`early_finish` consistently. Variance is `None` when no active/planned
sprint has a finish date or when the milestone has no CPM date yet.

### Multi-sprint case

A milestone can be the `target_milestone` of any number of sprints (e.g.
"MVP launch" sums across 3 sprints over a quarter). The rollup sums across
**all** targeting sprints (COMPLETED + ACTIVE + PLANNED) for the denominator
and numerator. This reflects cumulative progress toward the milestone, which
matches Jordan's "when does feature X ship?" intent more naturally than
showing only the active sprint.

Closed sprints contribute their snapshotted `completed_*` values; active
sprints contribute their currently-completed task count (re-summed live);
planned sprints contribute only to the denominator (committed = expected work,
completed = 0). The serializer documents this in its docstring.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Store rollup as new Task fields (`rollup_percent_complete`, `rollup_basis`, `variance_days`)** | Single-query reads; no serializer cost; easy to filter portfolio queries by it later | New migration on the hottest table; every sprint mutation must thread the rollup write through `update_fields`; stale-state risk across 6+ write paths; ADR-0024 already establishes that summary rollups compute on serialize |
| **B. Compute on serialize from `targeting_sprints` reverse relation** (chosen) | No migration; impossible to drift; single recompute path; reuses existing `committed_*`/`completed_*` snapshots; matches ADR-0024 summary-task convention | Adds a `prefetch_related("targeting_sprints")` cost to milestone serialize; broadcast must compute server-side rather than read a field |
| **C. Trigger only on sprint close** | Simplest implementation; one trigger point | Loses live experience during an active sprint — Alex 🟡 "PM sees stale milestone for 2 weeks then a sudden jump"; ADR-0036 promises auto-advance, not eventual auto-advance |
| **D. Trigger on every task save (no filter)** | Maximally live | O(every task save) recompute even for non-sprint projects; rejected as gratuitous query load |
| **E. Surface variance as variance bar on the Gantt with auto-shift opt-in** | Most powerful; closes loop fully | Reversed the issue's explicit "no automatic date mutation" guardrail; punted to a future ADR |
| **F. Include per-sprint breakdown in broadcast payload** | Richer UI without a second round-trip | Morgan 🔴-adjacent: leaks per-team velocity to any project-read user; rejected as governance hazard |

## Consequences

**What becomes easier:**
- The sprint → milestone bridge is *live*, closing the longest-standing gap in
  the hybrid model promised since ADR-0036.
- Jordan can answer "when does feature X ship?" by looking at the milestone
  in the Gantt — same number Sarah sees, no spreadsheet reconciliation.
- Alex's "promote sprint commitment to schedule milestone" pain (his exact
  wording from `personas.md`) is solved without him copy-pasting.
- The audit trail on milestone progress comes for free via `HistoricalTask` —
  no extra wiring.

**What becomes harder:**
- Milestone tasks are no longer freely editable when sprint-linked — PMs must
  unlink or close sprints to override. Documented as a deliberate constraint;
  Morgan's "sprint sovereignty" concern depends on this lock holding.
- The `TaskSerializer.to_representation` for milestone tasks now does a
  `targeting_sprints` aggregate fetch. Mitigated by `prefetch_related` on the
  list endpoint and the fact that milestones are <5% of typical task counts.
- The web `useProjectWebSocket` consumer must handle a new event type and
  invalidate `['tasks', projectId]` on receipt. Existing routing already
  invalidates on `task_updated`; the new event triggers the same invalidation.

**Risks:**
- **Recompute storm during sprint close**: closing a sprint touches every
  task in it via `apply_close` carry-over. The `post_save` signal would fire
  N times before the authoritative `apply_close` recompute. Mitigation: the
  signal handler does a fast `select_related("sprint__target_milestone")`
  check and bails out early when called from inside the drain transaction
  (sets a thread-local guard). The drain recomputes once at the end.
- **Multi-sprint milestone broadcast amplification**: a single task save in
  sprint A may broadcast a milestone_rollup_updated event that updates a
  milestone also targeted by sprints B and C. Same payload shape, no
  multiplication; existing WS fan-out handles it correctly.
- **Race on rapid status flips**: a task flipped COMPLETE → IN_PROGRESS →
  COMPLETE in quick succession could emit out-of-order broadcasts. Mitigation:
  the rollup payload is idempotent (any recompute produces the truth), so
  out-of-order delivery converges within one tick.

## Implementation Notes

- **P3M layer**: Programs and Projects → Operations
- **Affected packages**: `api` (models stay untouched; new service + serializer + signal); `web` (new event handler + UI surface in `AdvancingToMilestoneCard` + milestone tooltip on the Gantt)
- **Migration required**: **No** — rollup is computed on serialize. The
  `targeting_sprints` reverse relation and existing Sprint metric fields are
  sufficient.
- **API changes**:
  - New nested `milestone_rollup` field on `TaskSerializer.to_representation()`,
    populated only when `task.is_milestone AND task.targeting_sprints.exists()`.
    Shape: `{ percent_complete, rollup_basis, variance_days, sprint_scope_changed }`.
  - `TaskSerializer.validate_percent_complete()` rejects writes when
    `targeting_sprints.filter(is_deleted=False).exists()`.
  - New WS event type `milestone_rollup_updated` (payload shape above).
  - `SprintTargetMilestone` nested type on SprintSerializer gains the
    rolled-up `percent_complete` so `AdvancingToMilestoneCard` reflects the
    same value the Gantt shows.
- **OSS or Enterprise**: OSS — pure single-project scope. Portfolio-level
  milestone aggregation is the Enterprise next-bundle (matches Marcus's 🟡).

### Durable Execution

1. **Broker-down behaviour**: The Task `post_save` signal path is best-effort.
   It schedules `broadcast_board_event()` via `transaction.on_commit()` —
   broker failures result in a missed live update but never a stale stored
   value (nothing is stored). The authoritative path on sprint state
   transitions runs inside the existing `SprintCloseRequest` outbox drain
   (ADR-0037) and inherits its broker-down behaviour: if the broker is down
   when the close is dispatched, the request stays PENDING and the drain
   re-tries every 30 s. A subsequent state-transition or task save heals the
   missed broadcast.
2. **Drain task**: **Reuses** `drain_sprint_close_requests` (ADR-0037) — the
   `recompute_milestone_rollup` call is appended to `apply_close` after
   `snapshot_completed_metrics` and before the existing `sprint_closed`
   broadcast. No new drain needed; the rollup is on the close happy path.
3. **Orphan window**: N/A — no new outbox table. The reused
   `SprintCloseRequest` drain already filters to rows older than 5 minutes
   (ADR-0037).
4. **Service layer**: **New function**: `services.recompute_milestone_rollup(milestone_id, *, broadcast=True)`.
   Reads `targeting_sprints`, computes the payload, broadcasts via
   `transaction.on_commit()`. Signal handlers, view actions, and the drain
   all call this single entry point.
5. **API response on best-effort dispatch**: N/A — the recompute is a side
   effect of writes that already have their own response contract (POST
   /sprints/{id}/activate, POST /sprints/{id}/close → 202, PATCH /tasks/{id}
   → 200). The rollup does not change those.
6. **Outbox cleanup**: N/A — no new outbox table.
7. **Idempotency**: `recompute_milestone_rollup(id)` is pure — every call
   produces the same payload from the same state. Multiple firings against
   the same milestone within one transaction collapse into one broadcast via
   a `transaction.on_commit()` dedupe (keyed on `("milestone_rollup", id)`).
8. **Dead-letter / failure handling**: A recompute that raises is logged at
   ERROR with `milestone_id` + `triggering_sprint_id` and swallowed — the
   rollup is a cosmetic side effect of the underlying write, which must
   succeed. The next state transition or task save recomputes; no
   dead-lettering needed. Errors above the alerting threshold flow through
   the existing Sentry pipeline.

## VoC Concerns Resolved

| Concern | Resolution |
|---|---|
| 🟡 Scope-change handling (Jordan/Alex) | Cap at 100% + `sprint_scope_changed` boolean in broadcast; honest math without re-denominating |
| 🟡 Throughput fallback (Alex) | `rollup_basis: "tasks"` when committed_points==0; labelled in the payload so UI can show "by tasks" |
| 🟡 Read-only enforcement, server-side (Morgan/Jordan) | `TaskSerializer.validate_percent_complete()` rejects writes; no UI-only suppression |
| 🟡 Broadcast payload shape (Morgan) | Aggregated only — no per-assignee or raw point counts; explicit field list above |
| 🟡 Variance display, no auto-date-shift (issue acceptance) | Variance is read-only `variance_days` int; no schedule mutation |
| 🟡 Multi-sprint milestone (open question) | Cumulative sum across COMPLETED+ACTIVE+PLANNED targeting sprints |
| 🟡 Audit trail (Morgan) | `HistoricalTask` already tracks `percent_complete`; rollup-driven changes flow through existing audit channel |

## Deferred to follow-up

- **Portfolio-level milestone health surface** (Marcus 🟡, Janet 🟡) —
  belongs in `trueppm-enterprise`. Cross-program rollup, RAG status, board-deck PDF.
- **Mobile milestone variance card** (Sarah 🟡) — mobile is a separate
  release theme (0.3/0.4 per memory `project_milestone_slotting`).
- **PM override path with audit** (Alex 🟡) — wait for real evidence of
  the quarter-end-override pain after this ships; sprint-close-to-unlock
  may be sufficient.
- **Sprint scope-change events on the burndown** (Jordan 🟡) — separate
  feature; `sprint_scope_changed` boolean here is the minimal signal.

## Tracking

Tracking: deferred — not yet filed. Distinct from #860 (bridge demo: promote a sprint
commitment to a *new* schedule milestone + reforecast) — this ADR rolls
`percent_complete` / `variance_days` up to an *existing* `Sprint.target_milestone`.
