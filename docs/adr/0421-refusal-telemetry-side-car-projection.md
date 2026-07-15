# ADR-0421: Refusal-Telemetry as a Non-Hashed Side-Car Projection of the AgentAction Chain

## Status
Proposed

## Context

ADR-0362 §4 makes the "refusal moment" — *write rejected: schedule-infeasible, here
is the constraint and the projected impact* — the smallest demonstration of commitment
governance, and puts it squarely in OSS. Follow-up #2 (**issue #1850**) asks us to
**instrument refusals from day one** so that every real-world refusal accumulates as
both a scheduling-engine bug report and demo material, recorded so it is queryable for
engineering triage and demo capture.

The audit substrate already exists (ADR-0112 RC1, #1805). Every governance verdict —
`allowed` / `refused` / `requires_approval` — is one append-only, hash-chained
`AgentAction` row, carrying `verdict` and a coarse `refusal_reason` (`identity` |
`policy`). Two refusal producers are live today:

- **Policy refusal** — an MCP token rejected by a scope guard (`apps/access/permissions.py`
  `_record_mcp_agent_action`, `refusal_reason=policy`).
- **Identity refusal** — a revoked/expired/deleted token (`apps/projects/authentication.py`
  `_audit_identity_refusal`, `refusal_reason=identity`).

What #1850 additionally wants — **which constraint fired** (finer than the two-value
`refusal_reason`) and the **projected schedule impact** — has a hard sequencing problem:
the load-bearing producers of a "commitment refusal with projected impact" are the
**gated write surface (0.6)** and ADR-0372's durable `DeliveryEvent` stream (also 0.6,
not yet in code). Neither of today's two producers has a schedule "projected impact."

**P3M layer:** Programs and Projects / Operations — single-project agent governance.
This is OSS (ADR-0362 §4/§6: the refusal engine is never Enterprise-gated).

The forces:

1. The `AgentAction` record is the **cross-repo hashed contract** (ADR-0112 §1.3):
   `verdict`, `refusal_reason`, `payload_hash`, `sequence`, `prev_hash` feed
   `canonical(record)` → `record_hash`, which `manage.py audit_verify` recomputes.
   Anything hashed is tamper-evident but also chain-format-load-bearing; adding hashed
   fields is a `schema_version` bump and a documented breaking change.
2. `projected_impact` has **zero producers today**. Bumping the chain schema and hashing
   a field that is empty on every row we can currently write is speculative — the exact
   objection that had #1850 parked until 0.6.
3. But the refusal *signal* (`verdict=refused` + a constraint classification) is real
   now, and #1849's oversight panel (Refusals sub-view) needs rows to render from day
   one. ADR-0372 already names #1850 as a **durable projection** that *correlates*
   `DeliveryEvent` (trigger) against `AgentAction` (verdict) downstream — i.e. a
   consumer of the chain, not a change to the chain link.

## Decision

Record refusal detail in a **non-hashed 1:1 side-car table**, `AgentActionRefusalDetail`,
keyed by the `AgentAction` it explains — **not** in the hashed chain record.

1. **Storage — side-car, not chain fields (resolves DECISION 1).** New model
   `AgentActionRefusalDetail` with `action = OneToOneField(AgentAction,
   primary_key=True, on_delete=CASCADE, related_name="refusal_detail")`. It is a plain
   `models.Model` (never synced, no `server_version`, matching `AgentAction`). It is
   **outside** `canonical_fields()` — `audit_verify` and the chain are byte-for-byte
   unchanged, `AGENT_ACTION_SCHEMA_VERSION` stays `1`, and the "not tamper-evident"
   boundary is **structural** (a separate table) rather than a silent exclusion inside
   `canonical_fields` that a future edit could accidentally reverse. `on_delete=CASCADE`
   is correct and intended: a chain-aware prune (ADR-0361) that deletes an `AgentAction`
   should take its explanatory detail with it — the detail is worthless without its row
   and, being unhashed, cascading it never affects `audit_verify`.

2. **`constraint` — a stable enum (resolves DECISION 2).** `RefusalConstraint`
   `TextChoices`, a finer axis than `refusal_reason`, forward-compatible by addition:
   - `capability_scope` — MCP scope/capability denial (today's `policy` producer)
   - `token_identity` — revoked/expired/deleted token (today's `identity` producer)
   - `graph_validation` — cycle / self-reference guard (#1665) *(0.6 producer)*
   - `sprint_sovereignty` — guardrail block (#1313) *(0.6 producer)*
   - `rollup_lock` — milestone/phase rollup lock (#1753) *(0.6 producer)*
   - `engine_referee` — engine-infeasible write (#1062) *(0.6 producer)*

   Free text was rejected: the value must be aggregatable for triage ("show me all
   `graph_validation` refusals"). New codes are additive and non-breaking.

3. **`projected_impact` — structured JSON, legitimately empty now (resolves DECISION 3).**
   `JSONField(default=dict, blank=True)` matching the `projects_api_token_audit.detail`
   convention. Documented (not DB-enforced) shape for when 0.6 producers populate it:
   `{"affected_task_count": int, "slip_days": number,
   "critical_path_delta_days": number, "affected_task_ids": [uuid, …]}`. For both
   current producers it is `{}` — an honest empty, not a fabricated impact.

4. **Wire both live producers now (resolves DECISION 4).** `record_agent_action` gains
   two optional kwargs, `refusal_constraint: str = ""` and
   `projected_impact: dict | None = None`, and — when `verdict == REFUSED` and a
   constraint is given — creates the side-car row **inside the same `transaction.atomic`
   block** as the chain append, so the detail and its row commit together. The policy
   producer passes `capability_scope`; the identity producer passes `token_identity`;
   both pass no impact. This makes "refusals from day one" literally true and gives the
   oversight panel real rows.

5. **Read exposure — nested, same endpoint (resolves DECISION 5).**
   `AgentActionSerializer` gains a read-only nested `refusal_detail`
   (`{constraint, projected_impact}` or `null` when absent). `AgentActionViewSet`
   `select_related("refusal_detail")` to avoid an N+1, and gains an optional
   `?constraint=` filter alongside the existing `?verdict=` / `?project=`. It stays
   `GET /api/v1/agent-actions/?verdict=refused` — membership-scoped exactly as today; the
   nested detail is reachable only through the already-scoped parent queryset, so no new
   authorization surface is introduced.

6. **Honest scope (resolves DECISION 6).** The 0.4 deliverable is the side-car + the two
   producers + nested read + `?constraint=` filter. **Deliberately not built now**
   (speculative until 0.6): populating `projected_impact` (needs the gated write surface),
   the `DeliveryEvent` correlation join (needs ADR-0372 in code), recording agent actions
   from the invariant guards that don't yet emit them, and any policy/CEL rule engine.
   The enum reserves the 0.6 constraint codes so those producers slot in without a schema
   change.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **(a) Non-hashed 1:1 side-car (chosen)** | Chain untouched; no `schema_version` bump; "unhashed" boundary is a structural table split, not a hidden exclusion; absent when no detail; prunes cleanly via CASCADE | One extra table + a `select_related` join |
| (b) Non-hashed nullable columns on `AgentAction` | No join | Nullable columns empty on ~every row (allowed reads dominate); requires `canonical_fields` to *deliberately exclude* them — a latent footgun where a later edit silently hashes them and breaks every chain |
| (c) Hash new fields / bump `AGENT_ACTION_SCHEMA_VERSION` to 2 | Constraint code becomes tamper-evident | Speculative bump with zero `projected_impact` producers; a documented cross-repo breaking change (ADR-0112 §1.3); every allowed-read row carries empty new hashed fields. This is exactly what parked #1850 until 0.6 |

## Consequences

- **Easier:** #1849's Refusals sub-view has queryable rows now; refusals are triageable
  by `constraint` from day one; 0.6 write-surface producers add a code + populate
  `projected_impact` with no migration to the chain and no `audit_verify` risk.
- **Harder:** the constraint/impact detail is **not tamper-evident**. This is an accepted
  trade-off: the load-bearing decision (`verdict`, `refusal_reason`) remains hashed on the
  chain; the finer explanation is telemetry. If a future requirement needs the constraint
  code to be tamper-evident, it graduates into the hashed record via a deliberate
  `schema_version=2` bump **once real producers exist** — not speculatively now.
- **Risk:** a producer could set a `constraint` that disagrees with the hashed
  `refusal_reason`. Mitigated by wiring only inside `record_agent_action` (the single
  writer) and asserting the mapping in tests; the coarse `refusal_reason` on the chain
  remains the source of truth for the two-value axis.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: api (web consumes via #1849, no web change in this MR)
- Migration required: yes — new `AgentActionRefusalDetail` model, no seed row needed
  (append-only detail table, unlike the singleton `AgentActionChainHead`), depends on
  `("agents", "0002_agentactioncheckpoint")`
- API changes: yes — additive nested `refusal_detail` field + optional `?constraint=`
  filter on the existing `GET /api/v1/agent-actions/`; no breaking change
- OSS or Enterprise: **OSS** (`trueppm-suite`) — the refusal engine and its telemetry are
  never Enterprise-gated (ADR-0362 §4/§6); org-wide notarization of the trail remains the
  Enterprise value-add (ADR-0112 §3, #146)

### Durable Execution
1. **Broker-down behaviour:** N/A. The side-car row is written **synchronously** inside
   the existing `record_agent_action` `transaction.atomic` block, in the same DB
   transaction as the chain append. There is no `.delay()`, no broker, no async side
   effect — a broker outage cannot lose it.
2. **Drain task:** N/A — no async work, so no drain.
3. **Orphan window:** N/A — the write is synchronous within the request's atomic block,
   not an `on_commit` dispatch (the only `on_commit` here is the pre-existing
   `agent_action_recorded` signal, unchanged by this ADR).
4. **Service layer:** `record_agent_action` (existing single chain writer,
   `apps/agents/services.py`) — extended with `refusal_constraint` / `projected_impact`
   kwargs; it remains the only writer of the side-car.
5. **API response on best-effort dispatch:** N/A — the read endpoint is synchronous; the
   write side is not a request the user waits on (it is audit instrumentation on another
   request's refusal path).
6. **Outbox cleanup:** N/A — no outbox. The side-car is pruned via `on_delete=CASCADE`
   when its `AgentAction` is pruned (ADR-0361); it is otherwise permanent alongside the
   chain row.
7. **Idempotency:** Guaranteed by the `OneToOneField` PK. Each `AgentAction` is a fresh
   row created once by the single writer, and its side-car is created once in the same
   atomic block — a duplicate side-car for one action is structurally impossible. The
   identity producer's own at-most-once-per-dead-token gate (unchanged) bounds how often
   the whole path runs.
8. **Dead-letter / failure handling:** Inherits the producer's existing posture. On the
   **policy** path the audit is fail-closed (an audit-write failure rolls the request
   back — a side-car failure inside the same atomic block rolls back the chain append
   too, so the two never diverge). On the **identity** path the audit is best-effort and
   swallows exceptions (a failed audit must never turn a 401 into a 500); a side-car
   failure there rolls back the whole `record_agent_action` and is swallowed identically.
   No DLQ — an audit substrate never retries a refusal write onto the hash chain.
