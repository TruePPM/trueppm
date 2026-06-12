# ADR-0120: Cross-Project Dependencies Within a Program — Program-Scoped CPM Pass

## Status
Proposed

**Tracking:** [#1150](https://gitlab.com/trueppm/trueppm/-/issues/1150) — cross-project dependencies within a program (program-scoped CPM pass). Demo on-ramp: [#1151](https://gitlab.com/trueppm/trueppm/-/issues/1151) (the "1.0 GA Launch" sample program, `docs/specs/ga-launch-sample-program.spec.md`).

## Context

TruePPM's P3M story requires a critical path that can cross project boundaries
*within one program*: "GA announcement go-live" (Marketing project) gated by
"Security sign-off" (Security project). Today this is impossible at three layers:

1. **Serializer wall** — `DependencySerializer.validate()` rejects
   `predecessor.project_id != successor.project_id`
   (`apps/projects/serializers.py:2256-2261`, comment: "CPM engine assumes a
   single-project DAG"). There is **no DB constraint** — the wall is
   serializer-only.
2. **Scheduling trigger** — `_run_schedule()` gathers
   `Dependency.objects.filter(predecessor__project_id=project_id)` and drops
   any edge whose endpoint is outside the project's task set
   (`apps/scheduling/tasks.py:438,450`). A cross-project row, if it existed,
   would be silently ignored.
3. **Engine input shape** — `trueppm_scheduler.schedule(project)` takes a
   single `Project` dataclass with **one Calendar** for the whole pass. The
   engine has no algorithmic single-project assumption (task IDs are a flat
   namespace; cycle detection, forward/backward passes, and float math are all
   graph-generic) — the only real gap is one-calendar-per-pass.

The 0.3 "1.0 GA Launch" sample program (primary demo on-ramp) showcases a
cross-project critical path as its visual centerpiece. A SNET-faked version
(static `planned_start` mirroring) was rejected: the first thing an evaluator
does is drag a task, and a static fake collapses at the moment of maximum
attention — the same trust failure class as the #1094/#1099 forecast-honesty
cluster.

**VoC panel (2026-06-11, avg 4.6/10)** produced one convergent 🔴 cluster that
this ADR treats as hard constraints:

- **C1 — Sprint boundary firewall** (Alex 🔴, Morgan 🔴, Priya 🔴, Jordan 🟡):
  a cross-project ripple must never silently alter what a team committed to.
- **C2 — Downstream consent gate** (Morgan 🔴, Jordan 🟡, Alex 🔴): an edge
  whose successor sits in another team's project is a scope-injection vector;
  the downstream side must accept before the edge binds.
- **C3 — Minimal visibility card** (all): a user blocked by a task in a
  project they can't access needs a human-readable minimal card, not
  "blocked by [redacted]" and not full data leakage.
- 🟡 slips on the cross-project critical path should feed the existing program
  health / reforecast surfaces (ADR-0106 `ForecastSnapshot`, ADR-0108 rollup).

**P3M layer**: Programs and Projects (a single PM's program) → **OSS**.
Sarah (PM) scored highest (7/10) — Programs-layer resonance confirms OSS per
the persona resonance rule. Cross-**program** edges remain rejected; portfolio
coordination is Enterprise (ADR-0070 boundary unchanged).

Prior art this ADR composes with:

- **ADR-0027** — `enqueue_recalculate()` is the sole CPM entry point;
  `ScheduleRequest` outbox, drain coalescing.
- **ADR-0055** — cycle detection in `trueppm_scheduler.find_cycle()` at
  serializer validate time; must widen to the program graph.
- **ADR-0070** — Program entity; `ProgramMembership` ≠ `ProjectMembership`;
  no cross-program aggregation in OSS.
- **ADR-0101/0102** — team-owned guardrails; scope-injection approve gate
  (`Task.sprint_pending`, no auto-accept, management-inert). C2 reuses this
  consent pattern shape.
- **ADR-0106** — `ForecastSnapshot.unmodeled_dependency` is the current cheap
  heuristic for cross-project feasibility; #372 (0.5) is the full seam
  feasibility service. This ADR is the **substrate** both build on.
- `Program.risk_slip_propagation` (NONE/WARN/BLOCK, default WARN) already
  exists on the Program model — it becomes the policy input for conflict
  surfacing severity.

## Decision

### D1 — Edges: same-program cross-project edges become valid

`DependencySerializer.validate()` relaxes from "same project" to "same project
**or** same non-null `Project.program_id`". Cross-program edges remain a 400.
No DB constraint is added (none exists today; serializer + viewset remain the
enforcement boundary, consistent with current design).

Cycle detection at validate time builds the **program-scoped** graph (all
member projects' deps + cross edges) and calls the existing `find_cycle()` —
the engine helper is already project-agnostic.

### D2 — Consent gate (C2): proposed → accepted lifecycle

New fields on `Dependency`:

- `pending_acceptance: BooleanField(default=False)` (boolean deliberately, to
  avoid a drf-spectacular enum-name collision)
- `accepted_by: FK(User, SET_NULL, null)` / `accepted_at: DateTimeField(null)`

Rules:

- Creator holds `SCHEDULER+` on **both** endpoint projects → edge is created
  accepted (they already have schedule authority on both sides).
- Creator holds `SCHEDULER+` on only one side → edge is created with
  `pending_acceptance=True`. A pending edge is **inert**: excluded from the
  CPM gather, excluded from cycle-blocking of *other* writes (but still
  cycle-checked at accept time), rendered dashed in UI.
- Accept/reject endpoints (`POST /dependencies/{id}/accept|reject/`) gated
  `SCHEDULER+` on the *counterpart* project. No auto-accept path exists
  (ADR-0102 precedent). Reject soft-deletes the edge. History rows audit both
  acts.
- If the successor task is in an ACTIVE sprint at accept time, acceptance
  additionally emits the sprint-conflict evaluation (D4) immediately.

### D3 — Program-scoped CPM pass (merged graph)

When the dispatch path detects that a project's program has ≥1 accepted
cross-project edge, the recalculation escalates to **program scope**:

- **Gather**: all tasks + deps of all member projects, plus cross edges, merged
  into one engine input.
- **Engine change** (`packages/scheduler`): `Project` dataclass gains
  `calendars: dict[str, Calendar] | None` and `Task` gains
  `calendar_id: str | None`. Each task uses its own project's calendar for
  duration arithmetic; falls back to the pass-level calendar when absent
  (fully backward-compatible). **Lag convention: lag on any edge is counted on
  the successor's calendar** (the constraint lands where the wait is consumed);
  documented in the package docs. This stays a pure-Python, zero-Django change
  and is an independently valuable package feature (per-task calendars).
- **Criticality and float are program-true**: the backward pass runs over the
  merged graph, so an upstream task gating another project's milestone shows
  `is_critical=True` and correct floats — the honest cross-project critical
  path is the whole point. Per-project passes with boundary propagation were
  rejected for exactly this (see Alternatives B).
- **Lock**: `schedule_lock:program:{program_id}` replaces the per-project lock
  for program-scoped runs; a program run also acquires nothing per-project —
  sibling `ScheduleRequest` rows are coalesced (all PENDING rows for member
  projects marked done by the one run). Projects in programs with no cross
  edges keep today's per-project path and lock untouched.
- **Write-back**: per-project `bulk_update` batches; `recalculated_at` set on
  every member project; broadcasts (`cpm_complete`, `task_dates_updated`) fan
  out to **each affected project's** channel group (no program channel in 0.3;
  the program schedule view subscribes per member project).
- `ScheduleRequestReason` gains `CROSS_PROJECT_DEPENDENCY`.
  `DependencyViewSet.perform_create/destroy` enqueues recalc for **both**
  endpoint projects (the drain coalesces them into one program run).

### D4 — Sprint boundary firewall (C1): honest math, team-owned surfaces, acknowledged conflicts

The firewall is **not** date-freezing. CPM fields (`early_*`, `late_*`,
floats, `is_critical`) are engine outputs — forecasts, not commitments
(they already bypass `server_version` and history; ADR-0036 separates the
sprint layer from the schedule layer). Freezing them would make the schedule
lie — the same trust failure the SNET fake was rejected for.

What the team owns — and what a ripple can therefore **never** mutate:
`Sprint.start_date/finish_date`, task↔sprint membership, `sprint_rank`,
task `status`, points, and all commitment math (`committed_*`,
burndown, velocity).

The firewall:

1. The program pass computes honestly, including dates of tasks in active
   sprints.
2. Post-pass, for every task in an ACTIVE sprint whose new `early_finish`
   exceeds `sprint.finish_date` **and** whose push is attributable to a
   cross-project edge (BFS from cross-edge successors), the run upserts a
   **`CrossProjectSlipConflict`** row: `{sprint, task, dependency, pushed_to,
   detected_at, acknowledged_by, acknowledged_at, resolution}` (plain
   `models.Model`, not synced — same class as `SprintBurnSnapshot`).
3. The conflict requires acknowledgment by a member of the *downstream*
   project with the SM/PO facet or `SCHEDULER+` role. Acknowledgment is an
   audit act ("seen, handling it"), not a schedule mutation; resolution
   happens through the team's own surfaces (move task out of sprint, extend
   sprint, accept risk). No actor outside the project can acknowledge on the
   team's behalf (management-inert, ADR-0102 pattern).
4. `Program.risk_slip_propagation` modulates surfacing: `NONE` = conflict rows
   only (pull); `WARN` (default) = notification to SM/PO facets + sprint
   header badge; `BLOCK` is **not honored as a hard block against a sprint**
   in OSS — per ADR-0101 Tier-2, an externally-set block on sprint composition
   is inert until team-acknowledged; it renders as WARN plus a "policy
   requests block" annotation.
5. Unacknowledged conflicts feed `ForecastSnapshot` via the existing
   reforecast path: the bound milestone's snapshot sets
   `unmodeled_dependency=False` (the edge IS modeled now) but the conflict
   state surfaces in the program health rollup (ADR-0108 computed-on-read) —
   this is the 🟡 Janet/Marcus hook, satisfied with already-shipped surfaces.

Note for ADR-0106 integration: accepted cross-project predecessors are
*modeled* — the `unmodeled_dependency` heuristic must stop flagging them.
Pending (unaccepted) edges still count as unmodeled.

### D5 — Minimal visibility card (C3)

New server-side read shape `ExternalTaskCard`: `{id, title, project_id,
project_name, is_milestone, early_start, early_finish, is_critical}` — no
description, assignee, points, status, or comments.

- Any member of either endpoint project, and any `ProgramMembership` holder
  on the shared program, may read the card for a cross-edge counterpart task
  they cannot otherwise access.
- Exposed wherever a dependency endpoint is serialized today (dependency list,
  task detail predecessor/successor expansion, blocker surfaces incl.
  ADR-0118 `blocked_reason` / My Work) — the API answers "what is blocking
  me" in one round trip (API-first; an MCP client gets the same fact).
- Object-permission checks in `DependencySerializer.validate()` widen
  accordingly: creator needs read access to both tasks under the rules above,
  not full membership in both projects.

### D6 — Program schedule view (web, separate issue)

New `ProgramSchedulePage` feeding the existing canvas Gantt engine a merged
task+link array with project-lane grouping; `TaskLink` gains `projectId`
attribution; cross-project links render with a distinct treatment and the
program-true critical path highlights across lanes. Pending edges render
dashed with an accept affordance for authorized users. No engine rewrite —
`drawDependencyArrows` is already scope-unaware.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Merged program-scoped pass (chosen)** | Program-true floats and criticality (the demo's promise is honest); one engine run; reuses outbox/drain wholesale | Engine needs per-task calendars; program-wide lock granularity; pass cost grows to Σ(member tasks) |
| B. Per-project passes + fixed-point boundary propagation (cross edges become server-managed SNET floors on successors) | Zero engine change; per-project locks unchanged | Floats/criticality are program-FALSE (upstream backward pass can't see downstream demand → A5 shows float while actually program-critical); convergence loop machinery; the headline visual would be subtly wrong |
| C. SNET-faked seed data only (no engine work) | Cheapest; demo *looks* right in screenshots | Collapses interactively (drag upstream → nothing moves); #1094-class trust failure; zombie data risk (importer can create rows the API forbids) |
| D. Defer to 0.5 with #372 as planned | No 0.3 scope growth | 0.3 is the final alpha and must carry the major components; the GA-launch sample program loses its centerpiece; #372 itself needs this substrate anyway |

Consent-gate alternative considered: requiring `SCHEDULER+` on both sides
always (no pending state). Rejected — it forces dual-membership grants as a
prerequisite to proposing coordination, which in practice means program leads
hand out cross-project Scheduler roles broadly (RBAC erosion) or the feature
goes unused. The pending state is the cheaper, auditable middle.

## Consequences

**Easier:**
- The agile/waterfall bridge story becomes demonstrable end-to-end; #372
  (seam feasibility, 0.5) gets its substrate; the GA-launch sample program
  (separate issue) ships on real math with no fallback section.
- Per-task calendars in `trueppm-scheduler` are an independently valuable
  package feature (task calendars are a standard P3M expectation).

**Harder:**
- Program-scoped lock serializes recalcs across sibling projects — acceptable
  at program scale (one PM's projects), revisit if a program exceeds ~10k
  merged tasks.
- Cycle detection at validate time loads the program graph — still O(V+E),
  but V,E are program-sized now.
- Two scheduling code paths (project-scoped, program-scoped) must stay
  semantically identical for the no-cross-edge case; the escalation predicate
  ("program has ≥1 accepted cross edge") must be cheap and correct.

**Risks:**
- Migration-number collision: `projects` migrations are a known 3-way collision
  zone right now (#851/#1106/#924 all hold 0070 in flight) — renumber at
  rebase.
- Schema additions (`pending_acceptance` etc.) touch the synced `Dependency`
  entity → OpenAPI regen + mobile sync compatibility check (additive,
  default-false: old clients keep working; sync delta carries the new fields).
- Lag-calendar convention (successor's calendar) is a semantic choice that
  must be documented in the scheduler package before anyone depends on the
  old single-calendar behavior cross-project.

## Implementation Notes

- P3M layer: **Programs and Projects** (single PM's program)
- Affected packages: **scheduler** (per-task calendars), **api** (serializer,
  viewsets, scheduling tasks/services, new conflict model, visibility card),
  **web** (program schedule view, accept/conflict UI) — phased as 3 issues
- Migration required: **yes** — `Dependency.pending_acceptance/accepted_by/
  accepted_at`, `CrossProjectSlipConflict`, `ScheduleRequestReason` choice
- API changes: **yes** — dependency create relaxation, accept/reject actions,
  `ExternalTaskCard` read shape, program schedule read endpoint, conflict
  list/acknowledge endpoints
- OSS or Enterprise: **OSS** (`trueppm-suite`). Cross-program edges remain
  rejected; the Enterprise seam is unchanged. Enterprise consumers continue
  to use `milestone_forecast_recomputed` (ADR-0106) and
  `get_shared_team_signals` (ADR-0104); no velocity crosses a project boundary
  through this feature (CPM dates and criticality only).

### Durable Execution
1. Broker-down behaviour: reuses the **`ScheduleRequest` transactional outbox**
   (ADR-0027) unchanged — dependency writes enqueue rows for both endpoint
   projects inside the request transaction; no bare `.delay()`.
2. Drain task: **reuses the existing schedule drain**; scope escalation
   (project → program) is resolved at dispatch time inside the drain, which
   already coalesces — semantics match because a program run is a superset
   recompute of every coalesced member request.
3. Orphan window: existing **10-minute** schedule-request threshold unchanged.
4. Service layer: `scheduling/services.py::enqueue_recalculate(project_id, …)`
   remains the **sole** entry point; callers never choose program scope
   (dispatch decides). No new service function needed.
5. API response on best-effort dispatch: unchanged pattern — dependency
   mutations return the resource synchronously; recalculation is queued
   side-effect (existing behavior, documented).
6. Outbox cleanup: existing nightly `ScheduleRequest` purge (7-day retention)
   unchanged; `CrossProjectSlipConflict` rows are kept while unresolved,
   purged 90 days after acknowledgment (new `_do_purge` entry in Beat).
7. Idempotency: program pass is a pure recompute (safe to run twice);
   `schedule_lock:program:{id}` prevents concurrent program runs; the
   existing one-PENDING/one-DISPATCHED partial-unique constraints per project
   are unchanged; conflict upsert keyed on `(sprint, task, dependency)`
   unique constraint so re-runs update rather than duplicate.
8. Dead-letter / failure handling: existing `recalculate_schedule` retry +
   `FailedTask` dead-letter path applies as-is; on permanent failure all
   coalesced member rows enter FAILED and the existing alerting fires; manual
   re-trigger via the existing MANUAL reason path.
