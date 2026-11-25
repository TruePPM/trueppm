# ADR-1485: Schedule redesign — server surfaces (what-if verdict, variance, commitment-slip gate, headline forecast kind)

## Status
Accepted (2026-11-24)

> **Implementation status (2026-11-24, #5125):** design only. **No endpoint, model, field, or webhook event described here exists yet**: verified 2026-11-24 against `packages/api/src/trueppm_api/apps/scheduling/views.py` (only the Monte Carlo what-if exists), `apps/projects/models.py` (`SprintScopeChange` covers injection only, and `Sprint` has no owner field), and `apps/projects/people_load_views.py`. One D1 decision **reverses current behavior**: today an `api:full` token *can* accept and reject scope changes. `scope-changes/<pk>/accept|reject/` and `sprints/<pk>/scope-changes/accept|reject/` are on the pinned token write surface (`packages/api/tests/apps/access/token_write_surface.txt` lines 276–277, 294–295), and `SprintScopeChangeViewSet` has no token refusal.

## Context

Issue #5125 redesigns the Schedule (canvas Gantt) for PMs migrating from MS Project, Planview and Smartsheet. The design lives on a canvas, the redesign is summarized in the issue, and a STRIDE threat model ran before this ADR. This ADR settles the **server** side: what the redesigned Schedule reads and writes, and where each rule is enforced. It amends no shipped behavior on its own. Web child issues implement the canvas against it.

**P3M layer: Programs and Projects.** Every surface here is scoped to one project or program: the schedule, its baseline, its sprints, its people's load as visible to the viewer. Nothing aggregates across programs, so everything here is **OSS**. The portfolio roll-up the design deliberately left out (a cross-program steering page) would be Enterprise and is out of scope.

Facts this ADR builds on (all verified in code, 2026-11-24):

- **ADR-0102 already has a sprint accept gate, but only for *injection*.** A task linked into an ACTIVE sprint after activation writes a `SprintScopeChange` (PENDING) and sets `Task.sprint_pending`, so it contributes nothing to commitment math until a human accepts. The only writers of ACCEPTED/REJECTED are the human-invoked `accept_scope_change` / `reject_scope_change` services behind a project-role ≥ Admin gate. There is no auto-accept path by design, and `sprint_scope_changed` is notify-only.
- **Nothing gates a date change that pushes committed work past the sprint end.** That is the event the redesign calls a "commitment slip". `task_bulk.py` and the task PATCH path write dates with no sprint check.
- **`Sprint` has no owner field.** The design's "sprint owner" would be a new authorization principal.
- **Per-person load is already privacy-gated.** `/me/people-load/` computes over the viewer's schedulable projects, filtered by `can_read_signal_for_projects(…, "capacity")` (ADR-0104), using `compute_people_load` (ADR-1314). A fully suppressed view returns `all_withheld`.
- **The velocity audience is enforced server-side** (`can_read_signal(…, "velocity")`). Below it, the sprint release forecast (`/projects/{id}/sprint-forecast/`, `ProjectSprintForecastView`, wrapped by the MCP tool `get_release_forecast`) returns `velocity_suppressed: true` with its values nulled.
- **Webhooks** already Fernet-encrypt their signing secrets, allocate a per-subscription sequence number, run retry chains with a circuit breaker, and only `webhooks:manage` may create or update one (#4461).
- **API tokens** are scoped to one project or program. `mcp:read` is safe-methods-only on the MCP read viewsets. A token caller is judged by its minting user's role.
- **Client-side preview is legitimate** (ADR-0599): the WASM engine previews a drag locally, and the server has the last word on commit.

Inputs from the design stage:
- **Threat model.** Its top three risks: a guard enforced only in the UI, the what-if as a people-load oracle and CPU sink, and self-promotion to a new owner principal.
- **A simulated VoC panel** (no real-user signal; persona falsification lines carried in #5125): scope must not change without consent, acknowledgment must not become a bottleneck, the headline forecast kind must never switch silently, and experimental endpoints need a written contract.

## Decision

### D1. No new "sprint owner" principal. Commitment slips extend the ADR-0102 accept gate.

The design's "sprint owner" maps to **the existing ADR-0102 accept authority: project role ≥ Admin**. There is no `Sprint.owner` field and no deputy delegation. Any member holding the authority can decide, which covers time off without a delegation mechanism and removes the self-promotion path the threat model ranked third.

A **commitment slip** is a write that moves the finish of a task that is *committed* in an ACTIVE sprint (a member of `committed_sprint_tasks()`, so `sprint_pending=False`) past that sprint's end date. The finish moves through `planned_start` and `duration`, including the task serializer's write-only `planned_finish` input, which derives `duration`. `Task` has no stored `planned_finish` field. It becomes a new kind of `SprintScopeChange`:

- `SprintScopeChange.kind`: `injection` (existing rows, default) | `slip` (new). A slip row stores the **proposed** start and finish and the requester.
- **The caller holds the accept authority:** the write applies, and a `slip` row is recorded as ACCEPTED immediately with a required reason. Same transaction.
- **The caller lacks it:** the write is **not applied**. The service records a PENDING `slip` row with the proposed dates and returns `409 {"code": "commitment_slip_requires_acceptance", "scope_change_id": …}`. Accepting applies the stored dates through the same write service. Rejecting discards them and returns the reason to the requester.
- **Batching:** all slips produced by one request (a multi-select drag, a bulk placement) share one `batch_id`. Accept or reject can act on a batch or on single rows.
- **Acceptance becomes human-only. This is a new requirement that amends ADR-0102.** ADR-0102 forbids an *auto*-accept path but says nothing about tokens, and today an `api:full` token can accept and reject (see the status blockquote). This ADR changes that: the accept and reject endpoints, for both kinds, refuse `ApiToken` authentication of any scope (session/JWT only). Tokens and agents may *cause* PENDING rows and may read them, never decide them. This is a breaking change for any integration that auto-accepts scope through a token. It removes four routes from `token_write_surface.txt`, needs a role-route-matrix oracle update, and needs an upgrade note in that release.

**Where it is enforced: the task date-write service, not the UI.** Every path that writes `planned_start` or `duration` on a task (directly, or through the serializer's `planned_finish` input) goes through one guard function, `projects/services.py::guard_commitment_slip(...)`. That covers the task PATCH, the Build-mode bulk edit (`task_bulk.py`), "Schedule selected…" placement (D5), the offline sync push (which returns a conflict carrying the same code so the client keeps the row pending), and agent writes. A role-route-matrix test asserts every date-writing route returns the 409 for a non-authority caller.

**Known limit, stated:** the guard is synchronous and covers **direct** writes to committed tasks. A slip caused *downstream* by CPM recalculation (an upstream task moves, and the recalculation pushes a committed task past the end) cannot block, because recalculation is asynchronous (`enqueue_recalculate`). Downstream slips are detected after recalculation and surface as *at risk* in `commitment-status` (D3) plus a `sprint.commitment_at_risk` notice, never silently. The drag verdict (D2) warns about them *before* release, which is where the design puts the decision.

### D2. `POST /api/v1/projects/{id}/schedule/whatif/`: read-only, two modes

The verdict a drag shows has two parts with very different costs. They are split rather than paying full server CPM every 400 ms.

- **`mode: "evaluate"`** (default, what the canvas calls on pointer idle): the client sends the **proposed dates of the tasks its WASM preview moved** (≤ 500 tasks per call, a new cap set here; the local preview that produces them is the ADR-0599 carve-out). The server runs **no CPM**. It returns only the server-authoritative facts the client can't compute:
  - `people_load` for the resources assigned to the moved tasks, per affected week, via `compute_people_load` over the caller's schedulable projects gated by the `capacity` signal (the same scoping as `/me/people-load/`). It is limited to the moved tasks' resources, so the endpoint can't be used as a general load oracle.
  - `sprint_commitment`: which committed tasks would finish after their sprint's end, and whether the caller holds the accept authority (so the chip can say "Release to apply" or "Release to review").
  - `constraints_added`: the Start-no-earlier-than each moved task would receive.
- **`mode: "recompute"`** (for API/MCP clients without a local engine): the server runs CPM through `trueppm_scheduler` (never reimplemented, per principle 5) on the downstream subgraph of the moves. It returns `tasks_moved`, `finish.delta_working_days`, `critical_path.joins/leaves`, plus everything in `evaluate`. It is throttled separately and refused above a live-preview ceiling.

Common rules:
- **One schema for every caller.** `people_load` is always `{visibility: "full" | "count_only", over_allocated_count, items: [...]}`, with `items: []` when count-only. Each item carries `{resource, week, load_pct}`, the same computation as Resources utilization, summing `TaskResource.units`, never `Task.assignee`. A test pins the what-if figure equal to `/utilization/` for the same person-week.
- **Never persists.** A test asserts no write and no outbox row from either mode.
- **Throttles:** `ScopedRateThrottle` scopes `schedule_whatif_evaluate` (per user, burst-friendly, initial 120/min) and `schedule_whatif_recompute` (per user, initial 10/min), following `MonteCarloRunThrottle`. A 429 carries `Retry-After`.
- **Ceiling:** `recompute` returns `200 {verdict: null, reason: "project_above_live_preview_ceiling"}` above a configurable task count (`TRUEPPM_WHATIF_RECOMPUTE_MAX_TASKS`, initial 1,000, to be measured against a p95 budget of 300 ms before shipping). `evaluate` has no CPM cost, so no ceiling.
- **Cache:** results are cached in Valkey for 60 s under (project schedule version, caller visibility class, sorted moves hash).
- **Scopes:** allowed for `mcp:read` (it is a safe read despite the POST verb) and `api:full`. An MCP tool `get_schedule_whatif` wraps it. Published as `x-experimental` (D7).
- **Provenance:** every response carries the `_provenance` envelope (engine version, inputs, `as_of`).

### D3. New reads

- **`GET /api/v1/projects/{id}/baselines/{baseline_id}/variance/?min_days=1`:** signed working-day start and finish Δ per task against that baseline, plus `added` and `removed` counts. Paginated. Same permission as the existing baseline reads (any project member). MCP tool `get_baseline_variance`.
- **`GET /api/v1/sprints/{id}/commitment-status/`:** committed tasks at risk of finishing after the sprint end (from the last recalculation), and open scope changes of both kinds (`injection` | `slip`) with batch, requester, age and proposed dates. Project members read it; the accept/reject actions keep the ADR-0102 role gate. MCP tool `get_sprint_commitment_status`.
- Both are `mcp:read`-reachable and `x-experimental` at first.

### D4. `headline_forecast_kind`: server-chosen, per caller

`GET /api/v1/projects/{id}/forecast/` (the endpoint `get_schedule_summary` already reads), and through it the export, gains:

- `headline_forecast_kind`: `cpm_monte_carlo | team_velocity`, plus `headline_forecast_reason`.
- **Rule:** `team_velocity` when the project has sprints, enough velocity history for `ProjectSprintForecastView` to return non-null values, **and** fewer than half of its scheduled tasks touch a dependency edge. Otherwise `cpm_monte_carlo`. The thresholds live in one server function and are covered by unit tests.
- **Per caller:** a caller below the velocity audience gets `cpm_monte_carlo` with reason `velocity_withheld`, so the field never leaks velocity. "Every client headlines the same forecast" therefore holds per visibility class.
- **Never silent:** a change of kind for the project emits `schedule.finish_changed` with `headline_forecast_kind` and the reason. The UI always labels the kind ("Schedule:" / "Team forecast:").

### D5. "Schedule selected…" placement

A new action on the existing bulk endpoint (`task_bulk.py`): `place_by_dependencies {floor_date, unlinked: "leave" | "chain_in_list_order" | "start_on_floor"}`.

- Sets a start floor on the selected tasks, applies the `unlinked` choice, and triggers **one** recalculation through `enqueue_recalculate`.
- Every task goes through `guard_commitment_slip` (D1), so a placement can produce one batched PENDING slip request.
- **Idempotency** reuses the foundation-layer `idempotency` app. It uses the existing model unchanged: a key is unique per (user, key), the path and request hash are stored for conflict checks, and retention is `IDEMPOTENCY_RETENTION_HOURS` (24 h). A reused key with a different body hash returns 422; a reused key with the same body returns the stored response.
- Batch size is capped at the existing bulk limit.
- The response lists placed tasks, tasks left undated, and unplaceable tasks with a reason.
- The last `unlinked` choice per project is a **client-side** per-user, per-project preference: no server field. Per rule 431, it is read and written only when the login is one person's (not the read-only demo or a shared credential). Verified 2026-11-24: there is no server-side Schedule view-preference store to reuse.

### D6. Webhook events

New events on the existing webhook model and delivery path: `schedule.finish_changed`, `schedule.change_undone`, `sprint.scope_changed` (accept, reject, or direct-with-reason for both kinds), `sprint.scope_change_requested`, and `sprint.commitment_at_risk`.

- **Payloads are ids plus deltas only**: task, sprint and scope-change ids, finish Δ in working days, `headline_forecast_kind`, actor and `on_behalf_of`. **No `people_load`, no names beyond the actor, and no velocity figures.** Consumers fetch details with their own token, which applies their own visibility.
- `schedule.change_undone` references the `event_id` it reverses.
- **Delivery:** at-least-once, using the existing sequence number per subscription. A stable `delivery_id` is exposed for consumer idempotency.
- **Dead-letter list and replay:** permanently failed deliveries remain listable. `POST /webhooks/{id}/deliveries/{delivery_id}/replay/` is allowed **only** for `webhooks:manage`, matching the reasoning in #4461. Retention is 14 days.

### D7. Stability contract for the new reads

**This is a new convention. Neither extension key exists anywhere in the tree today,** so the schema generator needs a small hook to emit them, and the API docs need a page that defines them. What-if, variance and commitment-status ship in `openapi.json` with `x-experimental: true` and a `x-stability-window` stating at least two minor releases' notice before a breaking change. Responses carry `Deprecation`/`Sunset` headers when one is scheduled, and every change gets a changelog fragment. The public parity table marks each drawn mark as exists / experimental / not built. The UI depends on none of these until the schema is published.

### D8. Notifications

`sprint.scope_change_requested` and `sprint.commitment_at_risk` notify every member holding the accept authority:
- **In-app notice: unmutable**, so a commitment change cannot pass silently. **This needs a new mechanism.** The nearest existing one, `DND_BYPASS_EVENTS`, only bypasses do-not-disturb, not a user's mute, so child 8 adds a non-mutable flag for these two in-app event types. First it confirms whether any per-event in-app mute exists at all: the comment on the `DND_BYPASS_EVENTS` model calls them "signals a muted bell must never swallow", but `notifications/services.py` uses the set only for DND. If no per-event mute exists, the flag reduces to adding these events to the bypass set.
- Email and other channels follow each member's preferences.
- Everyone else, including the requester when the decision lands, follows their preferences, with in-app as the default.
- One batch produces one notice.

### D9. Amends ADR-0067 (pull-to-commit)

ADR-0067 made Confirm the only commit path for a canvas reschedule or resize. This ADR amends it to a **hybrid** model, because the drag verdict (D2) can now say when a drop is consequence-free:
- **Clean drop:** no critical-path change, no over-allocation, no commitment slip, and the people-load check has returned. It commits on release, with Undo.
- **Every other drop** keeps ADR-0067's Confirm.
- An added Start-no-earlier-than constraint is shown on the chip but doesn't by itself force Confirm.

ADR-0067's status gains an "Amended by ADR-1485 (hybrid commit)" note when this ADR is accepted. The web change ships in child 10.

### D10. AI-readiness additions (ai-review, 2026-11-24, after acceptance)

These come from the `ai-review` gate run on #5125 after acceptance. There is no new endpoint shape, so architect was not re-invoked. `enterprise-check` on the same day classified all 18 child issues OSS. Both results are recorded on #5125.

1. **The commit classification is a server field.** The what-if response (D2) carries `commit_mode: "apply" | "review"` and `review_reasons: ["critical_path_change" | "over_allocation" | "commitment_slip" | "people_load_unchecked"]`. The canvas chip and D9's routing read it, with no client threshold logic, so an agent learns the same answer from the same call. Child: #5128.
2. **Provenance on rows.** Variance rows (D3) and commitment-status at-risk rows carry `cause` (the server's one-line derivation summary, the same text the steering export prints) and `derivation_ref` (task id plus baseline id, for `get_schedule_derivation`). Children: #5129, #5127.
3. **Agent writes are audited.** Token-originated activity lands in the hash-chained `AgentAction` audit (ADR-0112 §1.3):
   - a token-caused slip records `requires_approval`;
   - a token calling accept or reject records `refused` with reason `identity`;
   - a token placement (D5) records one entry per batch, with per-task outcomes.

   Children: #2563, #5132.
4. **Decision memory.** Slip accept and reject reasons, direct-with-reason slips, and PM re-estimate notes feed the project Decisions view (ADR-0167), and the structured store (#1059) when it lands. Visibility follows `can_read_decisions`. Child: #2563.
5. **AI boundary.** Single-approver gate, ephemeral what-if and single-project webhooks are all OSS. The Enterprise counterpart is **multi-approver chains or delegated authority for commitment slips**. It is not built here, and nothing in OSS anticipates it beyond the existing notify-only `sprint_scope_changed` signal.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. New `Sprint.owner` + deputy delegation (the canvas's wording)** | Matches the design copy; one named person | A new principal with no grantor: the threat model's #3 self-promotion risk. Duplicates ADR-0102's authority with different semantics. A single owner is a bottleneck; delegation adds a time-bounded grant model to build and audit |
| **B. Extend ADR-0102's accept gate to slips (chosen)** | One authority, one audit table, one no-auto-accept invariant. Time off is covered by role, not delegation | Copy changes from "sprint owner" to "someone who can accept scope changes". Alex's "team consent" is met at Admin+, the same bar injection already uses |
| **C. Guard in the Schedule UI only** | Cheapest | Bypassed by bulk edit, the API, sync replay and agents: the threat model's #1 risk |
| **D. Apply the slip immediately and mark it pending (like `sprint_pending`)** | The bar moves at once | CPM would schedule against unaccepted dates; downstream tasks move on a change nobody accepted |
| **E. Server CPM on every pointer idle (single-mode what-if)** | One code path | About 1 ms per task per call at a 400 ms cadence: a CPU sink at 1,000+ tasks. The client already has the dates from WASM |
| **F. Headline kind global per project, ignoring the velocity audience** | "Same headline everywhere" literally | Leaks velocity to callers below the audience |

## Consequences

- **Easier:** commitment protection is one mechanism for injection and slip. Integrators and agents get typed, throttled reads and ordered webhooks. The drag preview stays fast because CPM stays on the client.
- **Harder:** every date-writing path must call `guard_commitment_slip`, and a new path that forgets it reopens the hole. The role-route-matrix test is the mitigation. The offline sync client must handle the new conflict code.
- **Risks:**
  - Acceptance latency could stall PMs. Measure "time to decision" on `SprintScopeChange`. The panel's falsification line: refuted if requests are answered within a day.
  - Downstream slips are warned about but not blocked (the stated limit).
  - The evidence thresholds in D4 are guesses until real projects exist (house data is authored demo only).
- **Accepted cost of D1:** a caller who holds the accept authority can apply their own slip directly, with a required reason. That is transparency (a recorded event plus an unmutable notice to the other accept-authority members), not the team's consent. A "different person must approve" rule was rejected for now because it would block single-admin projects.
- **Revisit triggers for D1.** Add a per-sprint "decider" designation that *narrows* the authority (additive, not a reversal) if beta shows either:
  - a team member learning of a change to their committed sprint work only after it committed, or
  - the people who should decide sprint scope (PO, delivery lead) not holding Admin on their projects.
- **Canvas copy amended (2026-11-24):** "sprint owner" became "people who can accept scope changes (Admin+)", and deputy delegation was removed. The design otherwise stands.

## Child-issue split (filed 2026-11-24, all 0.5)

Filed issues by row:
- 1 → #2563 (rewritten)
- 2 → #5127
- 3 → #5128
- 4 → #5129
- 5 → #5130
- 6 → #5131
- 7 → #5132, plus #2991 for the phone path
- 8 → #5133
- 9 → #5134, plus #5065 for summary and milestone marks
- 10 → #5135, plus #4314 for the Confirm content and #481 for tap-to-pin
- 11 → #2417 (rewritten)
- 12 → #5136
- 13 → #5137
- 14 → #5138

The six pre-existing issues carry dated fidelity notes. The epic #5125 holds the same map.

| # | Child | Package | Depends on |
|---|---|---|---|
| 1 | Commitment-slip gate: `SprintScopeChange.kind`, `guard_commitment_slip` on every date-write path, 409 contract, batch accept/reject. Also token refusal on accept/reject (a behavior change: update `token_write_surface.txt`, the role-route-matrix oracle, and the release's upgrade note) | api | — |
| 2 | `commitment-status` read + MCP tool + at-risk detection after recalculation | api | 1 |
| 3 | Schedule what-if (`evaluate` + `recompute`), throttles, cache, ceiling, MCP tool | api, scheduler (call only) | — |
| 4 | Baseline variance read + MCP tool | api | — |
| 5 | `headline_forecast_kind` + reason; summary, export, MCP | api | — |
| 6 | Webhook events, `delivery_id`, dead-letter replay under `webhooks:manage` | api | 1, 5 |
| 7 | "Schedule selected…" `place_by_dependencies` with Idempotency-Key | api, web | 1 |
| 8 | Notifications for scope requests and at-risk: a new non-mutable in-app flag (`DND_BYPASS_EVENTS` covers DND only) | api, web | 1, 2 |
| 9 | Canvas layers, density, baseline halo-where-changed, whiskers, minimap, stubs | web | 4 |
| 10 | Hybrid commit + touch drag (amends ADR-0067; closes #481) | web | 1, 3 |
| 11 | Steering snapshot export preset with "why the dates moved" | web | 5 |
| 12 | Phone flows, Mine lens, dark mode | web | 9, 10 |
| 13 | Parallel DOM listbox → tree: needs its own ADR superseding the ADR-0776 listbox decision | web | — |
| 14 | Agent-task fields (executor kind, agent state, `on_behalf_of`): data model before the glyph; extends ADR-0112 | api | — |

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api, web, mcp (new read tools); scheduler is called, not changed
- Migration required: yes. `SprintScopeChange.kind` (default `injection`, a populated table: add with a default, no constraint), the proposed-date fields, and `batch_id`. Per migration rule 7, no unique constraint is added to the populated table.
- API changes: yes. Three new reads, one new bulk action, a 409 contract on date writes, new summary fields, five webhook events, and one replay endpoint.
- OSS or Enterprise: **OSS** (single project/program). `sprint_scope_changed` keeps firing through `dispatch_extension_signal()` for Enterprise audit receivers. No new extension point.

### Durable Execution
1. **Broker-down behaviour:** notices and webhook events are written as outbox rows in the same transaction as the scope-change or date write (CLAUDE.md principle 6), using the existing webhook and notification outbox helpers. Recalculation uses `enqueue_recalculate`. The what-if and the three reads are pure reads with no async side effects.
2. **Drain task:** reuses the existing webhook delivery drain and notification drain. Semantics match: one event per row. The new `sprint.commitment_at_risk` detection runs inside the existing post-recalculation hook, so no new drain is needed.
3. **Orphan window:** inherits the existing drains' thresholds (5 min webhooks, 10 min schedule requests).
4. **Service layer:** new functions `projects/services.py::guard_commitment_slip`, `record_commitment_slip`, `decide_scope_change_batch`; `scheduling/services.py::evaluate_whatif`, `recompute_whatif`. Placement goes through `task_bulk.py` and then `enqueue_recalculate`.
5. **API response on best-effort dispatch:** date writes and placement return synchronously (200, or the 409 for a slip). Recalculation follows the existing `{"queued": true}` convention where it already applies.
6. **Outbox cleanup:** the existing 7-day purge. Dead-lettered webhook deliveries are kept 14 days for replay, then purged.
7. **Idempotency:** placement by Idempotency-Key (D5). Scope decisions are guarded by `select_for_update` on the `SprintScopeChange` rows and a status check (PENDING only), so a double accept is a no-op 200. Webhook consumers dedupe on `delivery_id`.
8. **Dead-letter / failure handling:** the existing webhook retry chain and circuit breaker; permanent failures go to the dead-letter list, replayable by `webhooks:manage`. Notification failures follow the existing notification retry policy.

### On Acceptance
- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1485` → **0** flagged (1104 open issues scanned, 2026-11-24).
- [x] Any issue carrying pre-ADR scope rewritten (title and body), led by a dated correction note: **1**. #5125 was re-read by hand because the sweep ranks by date and the issue was filed the same day. It had already been rewritten on 2026-11-24: the title went from "sprint-owner guard" to "commitment-slip gate", and the body got a dated correction note removing D1's rejected owner and deputy scope.
- [x] Amendment notes added under the Status of ADR-0067 (hybrid commit, D9) and ADR-0102 (token refusal on accept/reject, D1). #5125's body was already corrected on 2026-11-24 (dated note; D1's rejected "sprint owner + deputy" scope removed). Re-read it on acceptance anyway, together with any child issue filed before acceptance.
