# ADR-1462: Non-labor expenses, and a pool-scoped Rate editor grant

## Status

Proposed (2026-11-22)

> **Implementation status (2026-11-22):** design only. Verified on `main`: there is no
> expense, budget-ledger or grant model. `Resource.cost_rate` is read only by workspace
> admins (`resources/serializers.py`, popped for non-admins) and written only through
> `POST /resources/{id}/rate/`. That endpoint uses `IsNotTokenAuthenticated` and writes an
> `AuditEvent` of type `RESOURCE_RATE_CHANGED` (ADR-1324 §4).

## Context

Layer: **Programs and Projects** (project cost). The issues are #4905 (fixed and recurring expenses) and #4849 (a resource manager setting rates without being a project admin).

**ADR-1324** is the product cost model:
- One current hourly rate per resource, with no history.
- `Project.budget` as BAC.
- A single workspace currency.
- Actual cost from time entries.
- The L1–L17 leak matrix.
- Non-labor cost **deferred to #2557**.

Pass 4 (canvas section 3) shows expenses beside labor, and a grant in Roles & grants (Q3.1, decided). Workspace admins see and edit all rates. Project Owners and Admins see totals only. Grantees see and edit their pools. Everyone else sees nothing, with the reason shown.

## Decision

1. **This ADR resolves ADR-1324's non-labor deferral (#2557)** with **`Expense`** (app `projects`, core layer), holding:
   - `project`;
   - `category` ∈ {rental, cloud, license, agent_tokens, travel, other}, an open-enum convention per ADR-1291;
   - `kind` ∈ {one_time, recurring};
   - `amount` (Decimal, at least 0);
   - `date`, or `start`, `end` and `cadence` ∈ {weekly, monthly, quarterly};
   - an optional `task` FK and a `note`.
   
   There is **no currency field**: amounts are in `Workspace.currency` (ADR-1324 §3, no FX; Q3.4 deferred).
2. **Occurrences are computed, never stored.** `projects/cost.py` gains expense occurrences to date and at completion, so the cost summary returns `expenses_to_date` and `expenses_at_completion` beside labor. Each has its definition and `as_of`, and EVM's actual cost includes them (Q3.6).
3. **Expense visibility follows ADR-1324's budget gate.** Expense amounts are readable by project Admin and above (the same rule as `budget`, leak row L1-class), and writable by project Admin and Owner.
   - Viewers and Members see that expenses exist, but not their amounts.
   - Program rollups stay `cost_restricted`.
   - `expense.*` events carry IDs only.
4. **`RateEditorGrant`** (app `access`, core layer) holds `user`, `scope_all` or `pools` (M2M `CapacityPool`, ADR-1461), `granted_by` and `granted_at`.
   - It is a **grant, not a role**, so the five-role matrix is unchanged.
   - Grant writes require `IsWorkspaceAdminStrict` and write an `AuditEvent`.
5. **The grant widens ADR-1324's rate gate, and widens nothing else.** A grantee reads and writes `cost_rate` only for resources in their pools, through the **same** `POST /resources/{id}/rate/` endpoint, with the same preview-then-save, the same `IsNotTokenAuthenticated`, and the same audit event. Agent tokens still can't write rates.
   - The grantee does **not** gain budget, expense or project-admin visibility.
   - Every other rate path stays as it is: serializer omission, WS broadcast, exports, MCP and errors.
   - Add a test that asserts the rate is absent on each path for a non-grantee.
6. **`bill_rate` is not added** (Q3.7). Nothing computes revenue, and an unused field would invite a privacy surface with no consumer.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| A sixth role, “Rate manager” | Shows in the role picker | Changes the 5-role RBAC matrix and every permission test, for one field |
| Expenses as negative time entries | Reuses actual cost | Wrong semantics: expenses have no person and no hours, and they would corrupt utilization |
| Stored expense occurrences | Simple queries | Two truths when a recurring expense is edited, and a backfill on every edit |
| Date-effective rate cards | Accurate history | Enterprise (#45, ADR-1324). Out of scope. |

## Consequences

- Easier:
  - Cost at completion reflects real spend, including agent token bills.
  - A resource manager can keep rates current without being made project admin.
- Harder: the leak matrix grows by one grant dimension, and each leak path needs a test.
- Risks:
  - A total revealing one person's rate on a single-resource project (Q3.2). This is accepted for 0.5, because Owners already see assignments.
  - Manual agent-token bills don't reconcile with the agent audit log (Q3.3, deferred to 0.6).

## Implementation Notes

- P3M layer: Programs and Projects.
- Affected packages: api, web, mcp (cost summary reads, rates still omitted), docs (`administration/` for the grant, `features/` for expenses).
- Migration: yes. Two `CreateModel` (`Expense`, `RateEditorGrant`) plus an M2M, all expand-only.
- API changes: yes. `/projects/{id}/expenses/` and `/grants/rate-editor/`. Cost summary fields added. Rate visibility rule extended.
- Layering: `access` (core) → `CapacityPool` in `resources` (core, lateral) is allowed.
- OSS.

### Durable Execution
1. Broker-down behavior: N/A for the writes, which are synchronous DB writes. `expense.*` and grant webhooks go through the existing webhook outbox.
2. Drain task: reuses the webhook drain.
3. Orphan window: 5 minutes (webhooks).
4. Service layer: new `projects/cost_services.py::create_expense()` and related functions. The rate write reuses `resources/services.py` (ADR-1324).
5. API response: synchronous 201 or 200.
6. Outbox cleanup: existing purge.
7. Idempotency: `IdempotencyMixin` on the expense and grant writes. Grant uniqueness is per user.
8. Dead-letter: existing webhook dead-letter handling.

### AI-review amendments (2026-11-22)
- **Write safety:** expense and grant writes require `IsNotTokenAuthenticated` in 0.5, the same as ADR-1324's rate write, until agent writes arrive (0.6, ADR-0112 gate). Token attempts are recorded as `refused` `AgentAction` rows.
- **Provenance:** `expenses_to_date` and `expenses_at_completion` carry their occurrence list (`[{expense_id, date, amount}]`) on request (`?explain=1`), so an agent can cite the sum.
- **MCP:** `get_project_cost` gains the expense fields under ADR-1324's existing visibility rules. Rates stay omitted for every MCP caller, because grants are human-only.

### Enterprise-check (2026-11-22)
- **Expenses: OSS.** Project cost (ADR-1324) is OSS, and non-labor spend is part of one project's reality.
- **Rate editor grant: OSS**, under two constraints. It is **one fixed, product-defined grant**, not a user-definable permission, and it **narrows** an existing privilege. Today a resource manager must be made workspace admin to set rates, so the grant reduces over-privilege for a single team (the adoption test).
  - It adds no audit trail beyond ADR-1324's existing `RESOURCE_RATE_CHANGED`, no policy enforcement, and no role editor.
  - **Non-goal:** user-defined grants or roles, or any grant catalog an org can extend. That is “Custom roles (beyond the 5-role model)”, which is **Enterprise**, and it may register further grants through an extension point. OSS ships exactly this one.
- Cited: `overview/the-oss-enterprise-line.md`.

### On Acceptance
- [ ] Sweep `--adr 1462` (#4905, #4849, #2557) and record the count. #2557's deferral is now answered here, so correct its body.
- [x] `enterprise-check`, 2026-11-22. Verdict above.
