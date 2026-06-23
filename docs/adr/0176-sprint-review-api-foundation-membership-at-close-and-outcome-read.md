# ADR-0176: Sprint Review API Foundation — Membership-at-Close and the Consolidated Outcome Read

## Status
Accepted (2026-06-09) — Kelly affirmed API-first as the standing contract and signed off on all five questions below with the recommended answers: (1) null `didnt_ship[].story_points` for the suppressed management band; (2) no data-migration backfill, optional operator command + `outcome_recorded` flag; (3) `/outcome/` serves all states with a `provisional` flag; (4) store exact `TaskStatus` as `final_status`; (5) build order #982 → #983/#984 → #985 → #567 UI. Implementation may begin with #982.

## Context

#567 builds a closed-sprint **review** UI (state-aware sprint workspace). The
review must answer, for a closed sprint: *what did we commit to, what shipped,
what didn't ship and where did it go, did we hit the goal, and how did our pace
move?* Per the CLAUDE.md API-first principle (and the 0.6 MCP plan, which wraps
the REST surface — every fact a client shows must be a first-class API fact, not
client-derived), the review's data must be a server-owned read, not assembled
from raw task lists in the browser.

**The critical gap (#982).** "What didn't ship" — the set of tasks that were in a
sprint at the moment it closed but were not `COMPLETE` — is **destroyed at close
today**. The close drain (`apps/projects/tasks.py::close_sprint`) snapshots
`completed_*` (`tasks.py:128`), advances the sprint to `COMPLETED`, then calls
`apply_carry_over(sprint, carry_over_to)` (`tasks.py:140`), which **mutates the
`sprint` FK** on every incomplete task — moving it to the next sprint or nulling
it to backlog (`services.py:674-712`). After that line runs, querying
`Task.objects.filter(sprint_id=closed_sprint)` no longer returns the carried-over
work. The membership-at-close set exists only:

- transiently, in `HistoricalTask` rows (`models.py:1192`, `HistoricalRecords`),
  which retain the `sprint` FK value as of each save — but for **90 days only**,
  and only reconstructable via a temporal "rows as-of `closed_at`" query, which is
  not a first-class read and is unavailable once the retention window passes; and
- nowhere else: `SprintScopeChange` is `plain models.Model` (not synced) and its
  docstring (`models.py:2441`) states rows are cleared at close — and even when
  present they record *injections*, not the closing membership set.

`Sprint` already snapshots the **aggregates** that survive retention —
`committed_points`/`committed_task_count` (snapshotted on activate,
`models.py:2036`), `completed_points`/`completed_task_count` (snapshotted on
close, `models.py:2040`). What is missing is the **per-task line item**: the list
of tasks and their disposition (completed / carried / dropped). #982 fills that
gap; #985 composes it with the aggregates and the sibling-issue fields into one
read.

**Sibling issues (assumed to land as their own fields/services):**
- **#983** — `Sprint.goal_outcome` (an enum + optional note recording whether the
  goal was met). This ADR composes it; it does not define the field.
- **#984** — server-computed velocity delta and burn status (the *server* owns the
  `velocity_delta` vs prior sprints and a `burn_status` classification, rather than
  the client deriving them). This ADR composes them; it does not define the math.

**Durable-execution baseline.** Sprint close is async via a transactional outbox
(ADR-0037 §Durable; ADR-0080). The view (`views.py:5492`) writes a
`SprintCloseRequest` row inside `transaction.atomic()` via
`enqueue_sprint_close()` and returns `202 {"queued": true, "request_id": ...}`.
The `close_sprint` Celery task applies the transition inside one
`transaction.atomic()` block under `Sprint.objects.select_for_update()`
(`tasks.py:98-105`); a Beat drain `drain_sprint_close_requests` (every 30 s,
`@idempotent_task(on_contention="skip")`, `tasks.py:253`) re-dispatches stranded
rows, with a 5-minute orphan window and a 7-day purge. #982's new write **must
fit inside this existing transaction**, before `apply_carry_over` mutates the FKs.

**P3M layer.** Programs and Projects / Operations — single-project agile
execution. Membership-at-close, sprint outcome, goal, and velocity are all the
team's own data for its own sprint. **OSS.** No cross-program aggregation here;
the cross-team rollup that consumes `velocity` lives in Enterprise and only ever
reads via the ADR-0104 `get_shared_team_signals` opt-in extension point.

**Relationship to #871 and #865.** #871 (0.4) is a *writeback* refactor of the
carry-over move itself; #865 is the carry-over *preview*. This ADR is the
**read/audit half** — it records what the carry-over moved, after the fact. It
must **not** block on, or presuppose, the #871 redesign: it observes the existing
`apply_carry_over` behavior and snapshots it. If #871 later changes how carry-over
works, #982's capture point (the same transaction, before the FK move) still
holds — it records whatever disposition the move produces.

## Decision

Introduce a per-task **membership-at-close** record written inside the close
transaction, and a single read endpoint that composes it with the existing
aggregates and the sibling-issue fields, gated by ADR-0104 velocity privacy.

### 1. `SprintTaskOutcome` model (#982)

A new model in `apps/projects/models.py`. One row per task that was a member of
the sprint at the instant of close (i.e. linked to the sprint *before*
`apply_carry_over` runs). It is an **immutable historical snapshot** of the
closing membership set.

```
class SprintTaskDisposition(models.TextChoices):
    COMPLETED = "completed", "Completed in sprint"
    CARRIED   = "carried",   "Carried to another sprint"
    DROPPED   = "dropped",   "Dropped to backlog"

class SprintTaskOutcome(models.Model):
    id = UUIDField(primary_key=True, default=uuid.uuid4)
    sprint = FK(Sprint, on_delete=CASCADE, related_name="task_outcomes")
    task   = FK(Task, on_delete=SET_NULL, null=True, related_name="sprint_outcomes")
    # Denormalized snapshot — survives task deletion and the 90d history window:
    task_short_id  = CharField()        # e.g. "T-128", for display if task later deleted
    task_title     = CharField()        # title at close
    story_points   = PositiveIntegerField(null=True)   # points at close (may be null)
    final_status   = CharField(choices=TaskStatus.choices)  # status at close
    disposition    = CharField(choices=SprintTaskDisposition.choices)
    next_sprint    = FK(Sprint, on_delete=SET_NULL, null=True, related_name="+")  # for CARRIED
    was_pending    = BooleanField(default=False)   # ADR-0102 sprint_pending at close
    created_at     = DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [UniqueConstraint(fields=["sprint", "task"], name="uniq_sprint_task_outcome")]
        indexes = [Index(fields=["sprint", "disposition"])]
```

**Design decisions on the model shape:**

- **`models.Model`, not `VersionedModel`, and NOT synced.** No
  `server_version`. Rationale, matching the precedent of `SprintBurnSnapshot`
  (`models.py:2093`, "immutability makes server_version unnecessary") and
  `SprintScopeChange` (`models.py:2441`, "not synced to mobile; display
  metadata"): these rows are an append-only audit written once at close and
  never edited. The mobile client gets membership-at-close by reading the
  `/outcome/` endpoint (online review action), not by syncing rows. Adding
  `server_version` would imply mutability and an offline-write path that does not
  exist. **UUID PK yes** (TruePPM convention), **`server_version` no**.

- **Denormalized `task_short_id` / `task_title` / `story_points` / `final_status`.**
  The whole point is to survive what destroys the live data: the FK move, the 90d
  `HistoricalTask` window, and even task deletion. `task` FK is `SET_NULL` so a
  later hard-delete of the task does not cascade away the audit row; the
  denormalized columns keep the review readable. This mirrors
  `SprintScopeChange.subtask_name` denormalization ("survive subtask deletion so
  the audit trail is complete").

- **`disposition` is derived at write time** from `final_status` and the
  carry-over decision: `COMPLETE` → `completed`; incomplete + moved to a sprint →
  `carried` (with `next_sprint` set); incomplete + moved to backlog (or
  `carry_over_to="none"`) → `dropped`. `was_pending` records the ADR-0102
  `sprint_pending` flag so the review can distinguish "committed work that didn't
  ship" from "uncommitted injected work that didn't ship".

### 2. Capture point in the close drain (#982) — exact integration

The capture must run **inside the existing `transaction.atomic()` block** in
`close_sprint` (`tasks.py:98`), **after** `snapshot_completed_metrics(sprint)`
(`tasks.py:128`) and **before** `apply_carry_over(sprint, ...)` (`tasks.py:140`).
At that point: the sprint is `COMPLETED`, `completed_*` is snapshotted, and every
task still carries its closing `sprint` FK. The new service helper reads the
membership set there, then `apply_carry_over` returns the moved IDs which let us
fill in `disposition` / `next_sprint`.

Concretely, a new service function in `apps/projects/services.py`:

```
def snapshot_sprint_task_outcomes(sprint, *, carry_over_to: str) -> None:
    """Write SprintTaskOutcome rows for every task in `sprint` at close.

    MUST be called inside the close transaction, AFTER snapshot_completed_metrics
    (so final_status is read from the same task state the velocity snapshot used)
    and BEFORE apply_carry_over (which mutates Task.sprint and would otherwise
    erase the membership set). Idempotent: bulk_create(ignore_conflicts=True)
    against the (sprint, task) unique constraint, so a drain re-run is a no-op.
    """
```

The drain orchestration changes to:

```
snapshot_completed_metrics(sprint)
sprint.state = COMPLETED; sprint.closed_at = now(); sprint.save(...)
snapshot_sprint_task_outcomes(sprint, carry_over_to=req.carry_over_to)  # NEW — reads membership BEFORE the move
carried_task_ids = apply_carry_over(sprint, req.carry_over_to)
```

**Disposition resolution without a second pass.** `snapshot_sprint_task_outcomes`
reads every non-deleted task with `sprint_id == sprint.pk` and writes a row per
task with `disposition` computed from `final_status` + the *policy* (`carry_over_to`):
incomplete tasks get `carried` (with `next_sprint = carry_over_to` when it is a
sprint UUID) or `dropped` (when `carry_over_to in {"backlog", "none"}`). This
matches exactly what `apply_carry_over` will do next (it uses the same
`_CARRY_OVER_INCOMPLETE_STATUSES` filter, `services.py:671`), so the recorded
disposition is faithful without depending on `apply_carry_over`'s return value.
(We deliberately compute disposition from the policy rather than post-hoc from the
moved-ID list, so the two never drift if #871 later restructures the move.)

**Idempotency (outbox at-least-once).** The drain can re-run after a worker crash
between commit and the request-status update; `@idempotent_task` plus the
`select_for_update` sprint lock guard the transition, but the row write must also
be re-entrant. `bulk_create(..., ignore_conflicts=True)` against the
`(sprint, task)` unique constraint makes a second pass a no-op. The
already-`COMPLETED` short-circuit (`tasks.py:104`) means a fully-committed close
never re-enters the body at all; the unique constraint is the belt-and-braces for
the partial-commit edge.

**Failure isolation.** Unlike the velocity-calibration and reforecast steps
(which are wrapped in try/except so a bug can't strand a close, `tasks.py:160`,
`tasks.py:185`), `snapshot_sprint_task_outcomes` runs **un-wrapped inside the
atomic block** — it is the durable record of the close itself, so if it raises,
the whole close transaction must roll back and the request goes `FAILED` for the
drain to retry. Capturing the audit is not best-effort; it is part of the close's
definition of done.

### 3. `GET /sprints/{id}/outcome/` read (#985)

A new `@action(detail=True, methods=["get"], url_path="outcome")` on
`SprintViewSet` (`views.py:5257`), served by a read-only `SprintOutcomeSerializer`.
It composes existing snapshot fields + #982 rows + #983/#984 fields.

**Availability across states.** The endpoint works for **any** sprint state, but
its payload is shaped by what exists:
- `CLOSED` — full payload: aggregates, `didnt_ship[]` from `SprintTaskOutcome`,
  goal_outcome, velocity_delta, burn_status, retro summary.
- `ACTIVE` — a *live* outcome: aggregates computed from current task state
  (`committed_*` snapshot + live completed count), `didnt_ship` derived from
  current incomplete tasks (clearly flagged `provisional: true`), no
  `goal_outcome` yet, velocity_delta/burn_status best-effort. This lets the #567
  workspace use one endpoint for both the active burndown header and the review.
- `PLANNED` — minimal: committed snapshot if present, empty `didnt_ship`,
  `provisional: true`.

This is preferable to a CLOSED-only endpoint because #567's workspace is
state-aware; one read contract that the client switches presentation on beats two
near-identical endpoints.

**Response shape (200):**

```jsonc
{
  "sprint_id": "…",
  "state": "completed",
  "provisional": false,                 // true for ACTIVE/PLANNED (live, not snapshotted)
  "outcome_recorded": true,             // false ⇒ closed before vX (see §Migration)
  "name": "Sprint 7",
  "start_date": "…", "finish_date": "…", "closed_at": "…",

  "goal": "…",
  "goal_outcome": {                     // #983; null if unset or pre-field sprint
    "status": "met" | "partially_met" | "missed" | "unset",
    "note": "…"
  },

  "commitment": {
    "committed_points": 34,             // Sprint.committed_points snapshot
    "committed_task_count": 12,
    "completed_points": 28,             // Sprint.completed_points snapshot
    "completed_task_count": 9,
    "completion_ratio_points": 0.82,    // computed from the two above
    "completion_ratio_tasks": 0.75
  },

  "velocity": {                         // #984 — ADR-0104 GATED (see below)
    "completed_points": 28,
    "velocity_delta_points": +4,        // vs prior closed sprint(s); server-computed
    "rolling_avg_points": 25.5,
    "burn_status": "on_track" | "ahead" | "behind" | "no_data"
  },

  "didnt_ship": [                       // #982 — SprintTaskOutcome where disposition != completed
    {
      "task_id": "…" | null,            // null if task later hard-deleted
      "task_short_id": "T-128",
      "task_title": "Wire export button",
      "story_points": 5,
      "final_status": "in_progress",
      "disposition": "carried" | "dropped",
      "next_sprint_id": "…" | null,     // set for carried
      "next_sprint_name": "Sprint 8" | null,
      "was_pending": false
    }
  ],
  "didnt_ship_summary": {               // cheap rollup for the header chip
    "carried_count": 3, "carried_points": 8,
    "dropped_count": 1, "dropped_points": 2
  },

  "retro_summary": {                    // null when no retro / not visible
    "retro_id": "…",
    "action_item_count": 4,
    "has_notes": true                   // free-text gated by RetroVisibility (ADR-0104 §1)
  }
}
```

**`outcome_recorded`** is the explicit "membership not recorded for sprints closed
before vX" flag (see §Migration). When `false`, `didnt_ship` is `[]` and the
client renders "Per-task membership was not recorded for this sprint" rather than
implying nothing was carried.

**RBAC.** `get_permissions` returns `[IsAuthenticated, IsProjectMember,
IsProjectNotArchived]` for `action == "outcome"` — same Viewer+ floor as
`retrieve` / `burndown` (`views.py:5285`). Object-level membership is enforced via
the project FK; a non-member gets 404 from the project-scoped queryset.

**ADR-0104 velocity-privacy gating.** The `velocity` block carries exactly the
data ADR-0104 §2.1 suppresses (`completed_points` series + rolling points + the
delta). The serializer **must** consult the gate before assembling it:

- Compute `tier = requester_signal_tier(request, project_id)` and
  `audience_can_read(policy, "velocity", tier)` (ADR-0104 §2 helpers).
- If the reader's band is **outside** the `velocity` audience (`tier > audience` —
  by default the PM/ADMIN band and any non-member), **omit the entire `velocity`
  block** (suppress, don't 403). The `commitment.completion_ratio_*` aggregates
  **stay** — they are completion percentages, the "milestone-health % stays"
  carve-out of ADR-0104 §2.1, not the velocity series.
- The **team band** (MEMBER / VIEWER / the Scrum Master) passes at the `TEAM`
  default, so an ordinary member's review is byte-for-byte unchanged from a world
  without the gate (no regression — ADR-0104 §1 hard requirement).
- `didnt_ship[].story_points`: these are *per-task* points on the team's own
  closed sprint, not the velocity *series*. They are part of the team's
  commitment audit and are **not** velocity-gated for the team band. They are
  gated identically to `velocity` only for the **management band** — i.e. when
  `velocity` is suppressed, `story_points` in `didnt_ship` is nulled too (so the
  PM cannot reconstruct the suppressed point total by summing line items). Counts
  and titles remain. This closes the obvious side-channel.

This is the single most important 🔴 below: confirm that the *point columns* in
`didnt_ship` ride the `velocity` gate for the management band (the side-channel),
while titles/counts/dispositions stay visible (the aggregate carve-out).

### 4. Migration plan and historical sprints

- **Migration `0064`** (latest is `0063`,
  `projects/migrations/0063_historicalsprint_wip_limit_sprint_wip_limit.py`):
  `CreateModel SprintTaskOutcome` + `SprintTaskDisposition` choices. Pure
  additive create — **no `NOT NULL` column added to an existing table**, so
  migration-check is clean. `bulk_create` is the only writer.
- **drf-spectacular enum collision guard.** `SprintTaskDisposition` and the
  `final_status` / `disposition` fields introduce new enum names; pin them via
  `ENUM_NAME_OVERRIDES` to avoid the `api:schema-drift` "Removed schemas"
  regression (project memory `drf_enum_name_collision`).
- **Sprints closed before this ships have no rows.** The endpoint reports this
  honestly via `outcome_recorded: false` (derived: `state == COMPLETED` and zero
  `SprintTaskOutcome` rows ⇒ pre-feature close). The client shows "membership not
  recorded for sprints closed before vX".
- **Backfill: chosen = no backfill, with an opt-in management command.** A naive
  data migration cannot reconstruct membership for sprints closed >90 days ago
  (the `HistoricalTask` rows are gone), so a blanket backfill would be
  *inconsistent* — full for recent sprints, empty for old ones, with no signal of
  which is which. We instead ship **no data migration** and an **optional
  management command** `backfill_sprint_task_outcomes` that, for `COMPLETED`
  sprints with no outcome rows, queries `HistoricalTask` rows as-of `closed_at`
  within the retention window and writes rows with a `backfilled=True` marker (add
  this nullable boolean to the model). Operators who want best-effort history for
  recently-closed sprints run it; the default install does not, and
  `outcome_recorded` stays the source of truth either way. Rationale: a data
  migration that silently produces partial data is worse than an explicit,
  documented, operator-invoked best-effort backfill.

### Durable Execution

1. **Broker-down behaviour:** N/A for a *new* dispatch — #982 adds **no new async
   dispatch**. It is an extra synchronous write inside the **existing** sprint-close
   outbox transaction (`SprintCloseRequest`, ADR-0037). If the broker is down at
   close-request time, the existing outbox + `drain_sprint_close_requests` drain
   already covers it; the new row write rides that same durability. #985 is a pure
   read endpoint — no async side effects.
2. **Drain task:** Reuses the existing `drain_sprint_close_requests`
   (`tasks.py:253`). The new write lives inside `close_sprint`'s existing atomic
   block; its semantics (exactly-once per close, retried on partial failure) match
   the close transition exactly, so no new drain is warranted.
3. **Orphan window:** N/A for the new write — it is not its own outbox category.
   The close request's existing 5-minute orphan window (ADR-0037 §Durable 3,
   `tasks.py` drain filter) governs re-dispatch.
4. **Service layer:** New function `snapshot_sprint_task_outcomes(sprint, *,
   carry_over_to)` in `apps/projects/services.py`, called from
   `tasks.py::close_sprint` between `snapshot_completed_metrics` and
   `apply_carry_over`. The read endpoint's composition logic lives in a new
   `sprint_outcome_payload(sprint, request)` service helper (so the serializer
   stays thin and the ADR-0104 gate is applied in one place).
5. **API response on best-effort dispatch:** Unchanged — `close` still returns
   `202 {"queued": true, "request_id": ...}` (`views.py:5567`). `/outcome/` is a
   synchronous `200` read.
6. **Outbox cleanup:** N/A for the new rows — `SprintTaskOutcome` rows are
   **permanent audit**, not outbox rows; they are not purged (they are the durable
   history the feature exists to preserve). The `SprintCloseRequest` rows continue
   to purge nightly at 7 days (ADR-0037 §Durable 6); when a request row is purged,
   its `SprintTaskOutcome` rows are unaffected (no FK between them).
7. **Idempotency:** `(sprint, task)` `UniqueConstraint` +
   `bulk_create(ignore_conflicts=True)`. A drain re-run after a crash either
   short-circuits on the already-`COMPLETED` guard (`tasks.py:104`) or no-ops on
   the unique constraint. The idempotency key is `(sprint_id, task_id)`.
8. **Dead-letter / failure handling:** If `snapshot_sprint_task_outcomes` raises,
   it is **inside** the close `transaction.atomic()` and **un-wrapped**, so the
   whole transaction rolls back, the `SprintCloseRequest` goes `FAILED` with the
   error message (`tasks.py:230`), and the drain's existing stranded-row recovery
   re-dispatches it. There is no separate DLQ — the close request *is* the
   actionable failure record, re-triggerable by the existing drain. (Contrast the
   velocity/reforecast steps which are best-effort try/except; the membership
   snapshot is not best-effort because it is the audit of the close itself.)

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: `SprintTaskOutcome` snapshot rows written in the close transaction before `apply_carry_over`; consolidated read composes snapshot + #982 + #983/#984 (chosen)** | First-class, retention-proof, survives task deletion; one transaction; idempotent; no new async machinery; works for ACTIVE/PLANNED too | A new table; the capture point is a load-bearing ordering constraint in the drain that future edits must respect (mitigated by a test asserting the snapshot precedes the FK move) |
| B: Reconstruct "didn't ship" on read from `HistoricalTask` as-of `closed_at` | Zero new tables | Only works for 90 days; a temporal as-of query per sprint is expensive and fragile; loses data for older sprints with no signal; not a first-class fact — exactly the API-first violation #985 exists to fix |
| C: Stop `apply_carry_over` from moving the FK (keep membership live) | No snapshot needed | This is the #871 writeback redesign — out of scope, riskier, and would still need a snapshot for the "next sprint it went to" disposition; couples this read/audit work to an unscheduled refactor |
| D: Add `server_version` and sync `SprintTaskOutcome` to mobile | Offline review | These rows are immutable audit with no offline-write path; `server_version` implies mutability that doesn't exist; matches no precedent (SprintBurnSnapshot/SprintScopeChange are both unsynced). Review is an online action |
| E: CLOSED-only `/outcome/` endpoint | Simpler contract | #567's workspace is state-aware and needs a live outcome for ACTIVE; a CLOSED-only endpoint forces a second near-identical read path |
| F: Blanket data-migration backfill from history | History "just appears" | Produces silently-partial data (full <90d, empty older) with no marker; an explicit operator command + `outcome_recorded` flag is more honest |

## Consequences

**Easier:**
- "What didn't ship" becomes a permanent, first-class API fact that survives the
  90-day history window, the carry-over FK move, and task deletion.
- The #567 review UI and the 0.6 MCP surface read one endpoint; no client-side
  reconstruction.
- Velocity privacy is enforced once, server-side, on the composed read (ADR-0104),
  including the point-column side-channel in `didnt_ship`.
- Decoupled from #871/#865 — the read/audit half ships independently.

**Harder:**
- The close drain gains a hard ordering invariant (snapshot before
  `apply_carry_over`); a future drain refactor that reorders these silently breaks
  the audit. Mitigated by a regression test asserting outcome rows exist with
  pre-move membership after a close.
- One more table on the sprint hot path at close (single `bulk_create`,
  negligible).

**Risks:**
- If a sprint is somehow closed by a path that bypasses `close_sprint`, no rows
  are written — but `close_sprint` is the only close path (the view only enqueues).
- ADR-0104 gate must be applied to *both* the `velocity` block and the
  `didnt_ship` point columns; missing the second is a velocity side-channel for
  the PM band. Flagged 🔴 below; covered by an explicit gate test.
- #983/#984 are assumed-present siblings; if their field/service shapes differ
  from the placeholders here, the serializer composition adjusts — the #982 model
  and capture point are independent of them.

## Implementation Notes

- **P3M layer:** Programs and Projects / Operations (single-project agile execution).
- **Affected packages:** api (model, migration, service, viewset action,
  serializer, management command); web (#567 consumes the read — separate issue);
  no scheduler, no mobile-sync change.
- **Migration required:** yes — `0064` (additive `CreateModel`, no NOT-NULL on
  existing tables). Pin new enums via `ENUM_NAME_OVERRIDES`.
- **API changes:** yes — new `GET /sprints/{id}/outcome/` (Viewer+); new
  `SprintTaskOutcome` write inside `close_sprint`; `api-docs` sync required.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). Cross-team velocity rollup that
  consumes this stays Enterprise via the ADR-0104 `get_shared_team_signals`
  opt-in extension point; this ADR adds no cross-program surface. `grep -r
  "trueppm_enterprise" packages/` stays zero.
- **Tests (three layers):** pytest — capture-before-move ordering, idempotent
  re-drain (no duplicate rows), disposition resolution for each `carry_over_to`
  policy, `outcome_recorded=false` for pre-feature sprints, ADR-0104 suppression
  for the management band incl. `didnt_ship` point nulling, Viewer+ RBAC,
  ACTIVE/PLANNED provisional payloads. vitest — outcome read hook + the
  suppressed-velocity branch. Playwright — closed-sprint review golden path +
  pre-feature "membership not recorded" empty state.

## 🔴 Questions needing Kelly's sign-off

1. **Velocity side-channel in `didnt_ship` (the load-bearing privacy call).**
   Confirm: when the ADR-0104 `velocity` gate suppresses the `velocity` block for
   the management/PM band, the `story_points` column inside `didnt_ship[]` is
   **also nulled** for that band (titles, counts, dispositions stay), so the PM
   cannot reconstruct the suppressed point total by summing line items. The
   alternative (per-task points are commitment-audit, not velocity, and stay
   visible to the PM) is defensible but reopens the upward-exposure surface
   Morgan 🔴'd in ADR-0104. Recommended: **null the points for the suppressed band.**

2. **Backfill posture.** Sign off on **no data-migration backfill** + an optional
   operator command `backfill_sprint_task_outcomes` (best-effort from
   `HistoricalTask` within 90d, `backfilled=True` marker) + `outcome_recorded`
   flag — vs. an automatic best-effort data migration. Recommended: **no
   migration, optional command.**

3. **Endpoint breadth.** Confirm `/outcome/` serves **ACTIVE/PLANNED** (provisional
   live payload) and not CLOSED-only — i.e. #567's one-endpoint, state-aware
   review is the desired contract. Recommended: **all states, `provisional` flag.**

4. **`final_status` granularity in the snapshot.** Confirm we store the *exact*
   `TaskStatus` at close (`in_progress` / `review` / `not_started` / `backlog`)
   rather than a coarse `incomplete` — the review can then show "in review when the
   sprint ended" vs "never started", at the cost of a wider stored enum.
   Recommended: **store exact `TaskStatus`.**

5. **#983/#984 field/service contract.** This ADR assumes `Sprint.goal_outcome`
   (#983) and server `velocity_delta` / `burn_status` (#984) exist as composable
   fields/services. Confirm those two issues land their fields **before** #985's
   read, or that #985 ships with those blocks behind a feature check until they do.
