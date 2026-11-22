# ADR-1461: Capacity pools and resourcing asks — a consent-bounded approval write

## Status

Proposed (2026-11-22)

> **Implementation status (2026-11-22):** design only. Verified on `main`: there is no pool
> or ask model. `ProjectResource` (`related_name="resource_pool"`) is the per-project
> roster from ADR-0033, not a pool. `TaskResource` is the assignment row. The over-allocation
> warning is `resources/views.py::_check_overallocation` and `projects/utilization.py`.

## Context

Layer: **Programs and Projects**. #3362 and #3122 cover the PM's ask for capacity, the resource manager's decision, and an explained date change or explained refusal.

Pass 4 (canvas section 2) settled several things:
- Asks are addressed to a **pool** (Q2.1).
- Covered tasks are required, and approval **assigns** pool members to them, which is what lets CPM move the date (Q2.2).
- Counter-offers name people, dates and impact.
- A decline names the constraint that fired.
- Pending asks appear as **holds** on the heat map, and the queue supports batch approval of asks that fit.

Constraints:
- **ADR-0033** says the roster is project-scoped, so a pool is a new concept and must not reuse that name.
- **ADR-0774** says a `TaskResource` write happens at task-content authority. A pool manager may hold no role on the requesting project.
- **ADR-0963** says cross-project booking is a bounded disclosure (`ok`, `none` or `unknown`, plus a count).
- **ADR-0112** says an agent's durable writes go through a single-approver gate, and committing agent writes arrive in 0.6.
- **The Two-Repo Rule:** coordination within one program is OSS, and across programs is Enterprise.

## Decision

1. **`CapacityPool`** (app `resources`, core layer) has `name`, `program` (FK, **required in OSS**), `managers` (M2M User) and `members` (M2M Resource).
   - Only projects in the pool's program may ask it. Cross-program pools are an **Enterprise extension point**: OSS validates that `pool.program == project.program` through a provider hook, and enterprise may widen it. This resolves Q2.3, pending `enterprise-check`.
   - The name avoids any collision with `resource_pool`.
2. **`ResourceAsk`** records the pool, the project, the role or skill, `count`, `units`, `start` and `duration_wd`, `covered_tasks` (M2M Task, at least 1, all in the project), the state, `requested_by`, `actor_kind`, the decision fields and `decline_constraint` (JSON).
   - **`AskOfferLine`** records the resource, units, window and a proposed `task` (Q2.9).
   - **`AskEvent`** is the append-only trail of transitions.
3. **A consent-bounded write.** Approval, or accepting a counter, runs one service, `resources/services.py::apply_ask()`, inside a transaction with `select_for_update` on the ask. It checks four things:
   - the actor is a manager of the pool;
   - the requester **still** holds plan-authoring authority on the project, re-checked at approval;
   - every assigned resource is a pool member;
   - every task is one of the ask's covered tasks, within the asked window and units, or within the offer lines.

   Anything else is refused. The `TaskResource` rows are written by this service, not by an endpoint that takes arbitrary task IDs. This is how ADR-0774 is honored: the requester's ask is the task-content authority, and the manager supplies pool authority.
4. **D5, resolved:** approval writes are **attributed to the pool manager**, with `via_ask=<id>` on the assignment history and the `AskEvent`. Accountability stays with a person, and the ask link carries the consent chain.
5. **D6, resolved:** a requesting PM sees **fit verdicts only** (✓ Fits, ◆ Partly, ▲ Over, in words). Never other people's per-person load. This reuses ADR-0963's bounded disclosure. Pool managers, members (their own rows) and workspace admins see the full load and the holds.
6. **Holds are computed, never stored.** `GET /capacity-pools/{id}/load/` returns per-person weekly load plus `holds[{week, asked_fte, free_fte, ask_ids}]`, summed over the pool's open asks. Holds never count as bookings.
7. **Batch approve** rechecks fit for each item inside the transaction. It approves only items whose fit is still `fits` and returns a per-ID result list. ◆ and ▲ items are refused with their reason.
8. **Outcome as a server fact.** After commit:
   - The CPM recompute goes through `scheduling/services.py::enqueue_recalculate()`.
   - `GET /resource-asks/{id}/outcome/` returns `kind`, `run_id`, `metrics`, `chain[]`, `sprint_impacts[]` (sprint, tasks and who was notified), `recompute` (pending, done or failed), and, for a refusal, `earliest_fit_date`.
   - `sprint.scope_changed` fires through its existing dispatch for tasks in an active sprint, and the sprint's PO and SM are notified.
9. **Agents:** an agent actor may create only a `draft`. `send`, `approve`, `counter`, `decline` and batch approve refuse agent actors (ADR-0112). Until #1063 lands, "agent actor" means any request authenticated by an MCP token.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Address asks to a named person | No new model | The PM must know the org chart, and nothing scales past one resource manager. Rejected in Q2.1. |
| Approval allocates to the project only, and the PM assigns tasks later | No cross-project write | CPM can't move the date at approval, so the #3122 loop isn't closed. Rejected in Q2.2. |
| Workspace-wide pools in OSS | Simpler | That is cross-program coordination, which is Enterprise under the Two-Repo Rule. |
| Store holds as tentative bookings | Fast reads | Two truths about load, and a risk of counting a hold as booked. |

## Consequences

- Easier: the staffing loop closes with an explained date change. Asks that collide are visible before approval.
- Harder:
  - A new state machine and a cross-project write path need careful tests: authority recheck, a stale requester, race conditions.
  - Direct assignment remains a second path. Q2.10 proposes showing direct assignments of pool members on the load view as booked.
- Risks:
  - The pool model drifting into a portfolio feature. This is held by the program FK and the Enterprise hook.
  - Holds disclosing load to PMs. This is held by D6.

## Implementation Notes

- P3M layer: Programs and Projects.
- Affected packages: api, web, mcp (read tools for asks and outcomes with `_provenance`), docs.
- Migration: yes. Three `CreateModel` plus M2M tables, all expand-only.
- API changes: yes. `/capacity-pools/`, `/resource-asks/` and its transitions, `/resource-asks/preview/` (non-mutating), `/batch-approve/` and `/outcome/`. Events: `resource_ask.transitioned`, IDs only on WS.
- Layering: `resources` and `projects` are both core and lateral, so the `Task` FK is allowed (`app-layering.toml`).
- OSS, with an Enterprise extension point for cross-program pools.

### Durable Execution
1. Broker-down behavior: the recompute goes through `enqueue_recalculate()` (schedule-request outbox). Webhooks and notifications go through their existing outboxes.
2. Drain task: reuses the existing schedule-request, webhook and notification drains.
3. Orphan window: 10 minutes (schedule requests) and 5 minutes (webhooks).
4. Service layer: new `resources/services.py::apply_ask()`, `decline_ask()` and `batch_approve()`.
5. API response: the transition is synchronous (200 with the updated ask). The outcome reports `recompute: pending` until the run lands, so the UI shows "Recomputing" rather than guessing.
6. Outbox cleanup: existing 7-day purges.
7. Idempotency: state transitions check-and-set under `select_for_update`. A repeated `/approve` on an already-approved ask returns the existing result. `IdempotencyMixin` applies to the transition endpoints.
8. Dead-letter: a recompute failure follows the existing schedule-request handling, and the outcome endpoint shows `recompute: failed` with a retry affordance for the PM.

### AI-review amendments (2026-11-22)
- **Provenance of fit:** the fit verdict (`fits`, `partly`, `over`) is a server field with a derivation the requester may see without per-person disclosure (D6): `{constraint: "pool_capacity", window, asked_fte, free_fte, short_weeks[]}`. Pool managers additionally get `per_person[]`. Preview, outcome and fit all carry `_provenance` (engine version, `run_id`, inputs hash).
- **Write safety:** every refused transition by an agent actor (`send`, `approve`, `counter`, `decline`, `batch-approve`) is recorded as an `AgentAction` (verdict `refused`, reason `policy: agent_draft_only`). A transition that violates the consent bound (a task outside the ask, a non-member, a stale requester) is rejected with a structured reason and is never coerced.
- **MCP:** read tools `list_resource_asks`, `get_resource_ask` (trail included), `get_ask_outcome` and `get_pool_load`. The last returns, at most, what D6 allows the caller to see.
- **Decision memory:** approve, counter and decline, with their reason and `decline_constraint`, are decisions. `AskEvent` holds them now, and they are written to the #1059 store when it lands (kind `staffing`).

### Enterprise-check (2026-11-22)
**Split: an OSS basic version plus an Enterprise hook.**
- **OSS:** a capacity pool scoped to **one program**, with asks, approval, counter-offers, decline-with-constraint, holds and batch approval among that program's projects. This is coordination within a program, which the Two-Repo Rule assigns to OSS. It also passes the adoption test, since a team with one resource manager can't staff without it.
  - Non-goals: no pool spanning programs, no leveling, and no portfolio heat map.
- **Enterprise:** pools spanning programs, through the provider hook that validates `pool.program == project.program`. Enterprise replaces that check. It sits beside cross-program resource leveling and the cross-portfolio heat map, which are both Enterprise.
- **The hook must be guarded:** a provider that raises must fail **closed**, refusing the cross-program ask, and must not break the OSS approval path. It runs in its own savepoint, with a test where the provider raises a `DatabaseError`.

### On Acceptance
- [ ] Sweep `--adr 1461` (#3362, #3122) and record the count.
- [x] `enterprise-check`, 2026-11-22. Verdict above.
- [x] Enterprise counterparts filed 2026-11-22: trueppm-enterprise#208 (cross-program pools, through the provider hook) and trueppm-enterprise#209 (multi-step and delegated ask approval). #209 also notes that trueppm-enterprise#46's request/approval section should narrow to those two.
