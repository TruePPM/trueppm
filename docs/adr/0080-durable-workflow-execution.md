# ADR-0080: Durable Workflow Execution

## Status

Proposed

## Context

TruePPM has growing async orchestration needs across the OSS and Enterprise editions: notification fan-out, multi-step resource request workflows (basic in OSS, approval chains in Enterprise), Enterprise stage-gate approvals, Enterprise license metering aggregation. Today's durability surface is a transactional outbox plus Celery tasks (see [[project_durable_execution.md]]) — strong for single-shot dispatch ("commit the DB write, reliably enqueue one task"), but it does not natively express multi-step orchestrations that hold state, receive signals, sleep on timers, or compensate on failure.

Writing every new workflow directly against Celery + handcrafted state machines would (a) duplicate orchestration boilerplate, (b) leak Celery semantics into business logic, and (c) make any future engine swap a rewrite. Adopting a heavyweight engine (Temporal) on day one is also wrong — every additional infrastructure dependency is a real cost at security review and ops onboarding for an on-prem PMO product, and the v1 workload is well within "Django state machine + Celery + Postgres" territory.

The strategic frame is "boring v1, pluggable v2": ship a clean engine on the existing stack, but **build it behind a backend interface from day one** so future engine substitution is a backend implementation, not a rewrite. The OSS/Enterprise classification of each component, and the milestone slotting, were worked through with the `enterprise-check` and `architect` skills.

P3M layer: **infrastructure** (cross-layer). The interface and engine are foundational plumbing under Programs and Projects (OSS) and Portfolios (Enterprise) consumers.

## Decision

### A. v1 architecture (OSS, 0.4)

A workflow execution interface (Python package `trueppm_api.workflows`) is introduced as the **only** import surface for new workflow code. The v1 default backend is a thin layer over the existing transactional outbox + Celery — the engine is **additive** to the outbox, not a replacement. Workflow steps that produce side effects enqueue outbox rows exactly like today's `services.py` functions.

**Public interface — 8 primitives:**

```python
# trueppm_api/workflows/interface.py

def start_workflow(name: str, input: dict, *, wait_for_completion: bool = False) -> str: ...
def signal_workflow(workflow_id: str, signal: str, payload: dict) -> None: ...
def query_workflow(workflow_id: str, query: str, args: dict) -> Any: ...
def get_workflow_state(workflow_id: str) -> WorkflowState: ...
def cancel_workflow(workflow_id: str, reason: str = "") -> None: ...
def sleep(workflow_id: str, duration: timedelta) -> None: ...           # first-class timer
def run_activity(name: str, input: dict, retry_policy: RetryPolicy) -> Any: ...  # side-effect boundary
def get_history(workflow_id: str) -> list[HistoryEvent]: ...
```

**Deliberately excluded from the interface:** child workflows, continue-as-new, deterministic-replay guarantees. These are Temporal-specific primitives that would leak engine-specific semantics into workflow code and break the abstraction.

**Default behaviour:** `start_workflow` defaults to fire-and-forget (`wait_for_completion=False`). Workflows that block the caller defeat the durability point.

**Authoring model — workflows are declarative, the imperative primitives are engine-internal.** A workflow is authored as a registered `WorkflowDefinition` whose `build_steps(input)` returns an ordered list of `WorkflowStep(activity, compensate)` — the `TaskChain` shape from #65. The engine advances the chain step-by-step (each step-advance writes an outbox row per §D), compensating completed steps in reverse on failure. The eight interface methods (`run_activity`, `sleep`, `signal_workflow`, …) are the primitives the *engine* uses to drive a definition and the verbs *callers* use to interact with a running workflow — they are **not** an imperative authoring surface where a workflow is a Python function resumed by replay.

This is a deliberate neutrality decision, not just a simplicity one. A declarative step list is backend-portable: the default Celery+outbox backend, the DBOS adapter, and a future Temporal adapter can each execute the *same* `WorkflowDefinition`. An imperative durable-function model, by contrast, can only run on a replay-capable backend — and deterministic replay is explicitly excluded above — so it would couple every workflow author to a class of backend, which is exactly the leak §E forbids. The default backend threads `workflow_id` explicitly through each step (matching the codebase's explicit-context convention); it never reaches for ambient/replay state. The engine model lives entirely behind the 8-method ABC, so it does not constrain the interface the #654 DBOS spike validates — the contract is the ABC plus the `WorkflowDefinition` registry, never the `TaskChain` internals.

### B. OSS / Enterprise classification

Per `enterprise-check` verdict, each component is independently classified:

| Component | Repo | Reasoning |
|---|---|---|
| v1 engine (state machine + Celery + Postgres) | **OSS** | Foundational plumbing; boundary requires it (Enterprise depends one-way on OSS) |
| Workflow interface abstraction | **OSS** | Extension point per ADR-0029 |
| DBOS adapter | **OSS** | DBOS targets the OSS adopter profile (mid-market on-prem, lean infra, Postgres-native library, MIT license). The natural OSS durability upgrade path. |
| Temporal adapter | **Enterprise** | Commercial reasoning, not boundary. The buyer profile that wants Temporal (already operates a Temporal cluster, FSI scale, Temporal Cloud subscriber) is the Enterprise buyer. Maintenance cost (cluster in CI, version-compat matrix) sits with the SKU whose buyers exercise it. |
| Notification fan-out (use case) | **OSS** | Every PM needs reliable notification delivery |
| Resource request — basic (assign teammate to task within program) | **OSS** | Adoption-anchor; no governance overlay |
| Resource request — approval chain / cross-program contention | **Enterprise** | Governance overlay |
| Stage-gate approvals | **Enterprise** | Explicit "Approval workflows" entry in the OSS/Enterprise classification table |
| License metering aggregation | **Enterprise** | OSS has no commercial license to meter; removed from the v1 OSS engine brief |

The engine ships in OSS **even though stage-gate approvals — a marquee consumer — is Enterprise.** The engine is plumbing; consumers are independent classification questions. OSS-side notification fan-out exercises the engine; Enterprise registers approval workflows against the same extension point.

### C. Milestone slotting

| Milestone | Scope |
|---|---|
| **0.4** | Interface + default outbox-composing backend + **DBOS spike (prototype only, not shipped)** to validate the interface design against a real second backend |
| **0.5** | Migrate notification fan-out onto the interface as the first real workload, feature-flagged with rollback |
| **1.0** | Engine maturity (dead-letter, history surface, observability, idempotency) + **ship the DBOS adapter** as the second OSS backend |
| **Post-1.0 Enterprise** | Temporal adapter (gated on first FSI design partner ask), stage-gate approvals, license metering aggregation |

**DBOS is shipped, not deferred-on-ask.** A single-implementation interface is unfalsifiable; the only way to know the 8-method surface translates across backends is to build the second backend. Without DBOS, the abstraction silently calcifies around Celery's quirks. DBOS is also the OSS adopter's only durability upgrade path inside the OSS edition — gating it on customer ask would re-create the adoption-flywheel break that the OSS classification was supposed to avoid.

**The DBOS spike in 0.4 is not shipped scope** — it is design validation. The 0.4 deliverable is "interface that round-trips against both the default backend and a working DBOS prototype." The shipped adapter follows in 1.0 after the interface is hardened on the notifications workload in 0.5.

### D. Relationship to the existing transactional outbox

The workflow engine **composes with** the outbox; it does not replace it. The two solve different problems:

- **Outbox**: atomic DB write + reliable async dispatch of a single task ("commit and enqueue")
- **Workflow engine**: orchestration of multi-step state machines that receive signals, sleep on timers, run activities with retry policies, and produce queryable history

In the v1 default backend, advancing a workflow step writes an outbox row inside the same transaction; the outbox drain executes the step's Celery task; on completion, a signal advances the workflow. Existing outbox usage (board events, sync notifications) stays as-is — it is single-shot dispatch, not multi-step orchestration, and there is no reason to migrate it onto the workflow interface.

### E. Enforcement of backend-neutrality

The abstraction's value depends entirely on workflow code not leaking backend-specific semantics. Three layers of enforcement:

1. **Import discipline**: workflow code under `packages/api/src/trueppm_api/workflows/consumers/` imports only from `trueppm_api.workflows`. Never from `celery`, `dbos`, `temporalio`, or any other engine module.
2. **Ruff rule** in `packages/api/pyproject.toml` banning direct imports of `celery.shared_task`, `dbos.*`, `temporalio.*` from anything under `workflows/consumers/`. Catches the obvious failure cases at lint time.
3. **Pytest contract test** that runs every registered workflow against an in-memory backend which intentionally violates replay-determinism assumptions (reorders activities, double-fires timers, delays signals). Workflows that pass on the default backend but break under this adversarial backend would also break under a future Temporal swap. This is the real teeth.

**No `_backend` parameter on any public method.** If workflow code ever needs to know which backend it's running on, the abstraction has already failed.

### F. Deferral rule for additional backends

After DBOS ships in 1.0, additional pluggable backends are added **only when a real design partner asks**. Speculative backends (Restate, others) carry ongoing test and maintenance cost without proportional value. Recorded here so the rule survives future re-litigation.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Ship Temporal in v1** | Battle-tested; aligned with FSI buyers from day one | Heavy infrastructure (cluster + Cassandra/Elasticsearch); kills on-prem adoption; vendor risk (relicensing pattern); enormous test surface for ~zero v1 workloads that actually need it |
| **Ship DBOS in v1 (no interface)** | Postgres-native; clean OSS fit; less infra than Temporal | No hedge for buyers who later want Temporal alignment; can't validate that DBOS primitives are sufficient until real workloads land; locks in DBOS-shaped code |
| **No engine; everyone writes Celery state machines** | Zero new abstraction | Re-implements orchestration in every workflow; locks workflow code to Celery; makes future swap a true rewrite; orchestration bugs are recurring |
| **Build the interface but defer DBOS to "when a customer asks"** (original architect recommendation) | Conservative; minimizes 1.0 scope | Interface is unfalsifiable without a real second backend; abstraction silently calcifies around Celery quirks; OSS adopter has no durability upgrade path inside OSS |
| **Chosen: interface + default backend (0.4), DBOS shipped (1.0)** | Hedge present from day one; abstraction validated against a real second backend by 1.0; OSS adopter has a clean upgrade path; Enterprise can plug Temporal in later | Two backends to maintain in OSS by 1.0; DBOS-specific bugs are now an OSS support burden |

## Consequences

**Easier:**
- New workflow code is concise and consistent — no handcrafted state machines per feature
- Migrating to a different engine becomes a backend implementation, not a workflow rewrite
- OSS adopters hitting Celery durability limits have a clear in-edition upgrade (DBOS) instead of an Enterprise paywall
- Enterprise stage-gate approvals can ship against a mature, validated engine instead of inventing orchestration ad-hoc
- Reasoning about durability is centralized in one package instead of scattered across services.py callsites

**Harder:**
- The interface design has one chance to be right. Co-designing it against DBOS via the 0.4 spike is mandatory, not optional.
- Two backends in OSS by 1.0 means doubled test surface and a DBOS support obligation for the project
- Workflow authors have to learn the abstraction's vocabulary instead of dropping into raw Celery
- The contract test must actually catch backend-specific assumptions, or the hedge silently fails on the first leaky workflow

**Risks:**
- **Interface design risk**: if the 8-method surface is wrong, we discover it at notification migration (0.5) and have to redesign before 1.0. Mitigated by the DBOS spike in 0.4 — the spike's job is to expose surface mismatches before the interface is frozen.
- **DBOS bus factor**: DBOS is younger and smaller than Celery or Temporal. Mitigated by the interface itself — if DBOS fails as a project, the OSS edition still has the default Celery backend and a clean swap path.
- **Scope creep in 0.4**: "interface + default backend + DBOS spike" is real work. The discipline is that the spike is *not shipped scope* — it exists to inform interface design, then is set aside until 1.0. Shipping the spike accidentally would import 1.0 scope into 0.4.
- **Outbox/engine confusion**: developers may not know whether to write a workflow or an outbox-dispatched task. Mitigated by a docs page in `docs/architecture/` documenting "workflow vs outbox: which do I need?" — landing alongside the 0.4 release.

## Implementation Notes

- P3M layer: infrastructure (cross-layer; serves Programs and Projects in OSS, Portfolios in Enterprise)
- Affected packages: `api` (new `workflows/` package, default backend, DBOS spike in 0.4 and adapter in 1.0); `helm` (no infra changes for default or DBOS backends — both run inside the existing Django process and Postgres); `docs` (architecture page for workflow-vs-outbox guidance, API docs for the interface)
- Migration required: yes — new `workflows_*` tables for workflow state, history, and timers. Schema is owned by the default backend; DBOS adapter manages its own tables in the same Postgres instance.
- API changes: no direct REST surface in 0.4. Workflows are an internal mechanism; HTTP endpoints that *use* workflows return `{"workflow_id": "..."}` (202) for async starts, following the existing best-effort pattern.
- OSS or Enterprise: **OSS** for engine, interface, default backend, DBOS adapter, notification fan-out, basic resource request. **Enterprise** for Temporal adapter, stage-gate approvals, approval-chain resource workflows, license metering aggregation.

### Durable Execution

1. **Broker-down behaviour**: outbox pattern. Workflow state transitions are written inside `transaction.on_commit()`; the default backend's "advance step" writes an outbox row atomically with the workflow state update. If the broker is down at dispatch, the drain re-dispatches.
2. **Drain task**: new `workflows_outbox_drain` Beat task, every 30s, `@idempotent_task(on_contention="skip")`. Distinct from the existing event outbox drain because the row schema and dispatch target differ (workflow step vs. event consumer).
3. **Orphan window**: drain filters to workflow outbox rows older than 5 minutes to avoid racing with in-flight commits, matching the webhook outbox convention.
4. **Service layer**: new `trueppm_api.workflows.services` module wraps the public interface. All workflow starts and signals from view code go through it; never call backend methods directly. New consumer workflows live under `trueppm_api.workflows.consumers/` and register via the workflow registry.
5. **API response on best-effort dispatch**: `202 {"workflow_id": "..."}` for async starts; `200 {...result...}` only when `wait_for_completion=True` and the workflow is bounded-short.
6. **Outbox cleanup**: completed workflow outbox rows purged on the existing nightly 7-day retention schedule. Workflow history retained per backend policy (default: 30 days; configurable). DBOS adapter follows DBOS's own retention model.
7. **Idempotency**: every workflow start accepts an optional `idempotency_key` (default: deterministic hash of `name + input`) so a retried HTTP request does not start a duplicate workflow. Activity execution is idempotent at the activity-name + input level — duplicate executions detected via unique constraint on `(workflow_id, activity_name, input_hash)`.
8. **Dead-letter / failure handling**: workflows that exhaust their retry policy enter status `failed` with the exception recorded in history. Operators can re-trigger via management command (`manage.py workflow_retry <id>`) after fixing the underlying cause. Permanent failures fire a structured log event consumable by the existing alert pipeline. No silent discards.
