# ADR-0372: Delivery-Loop Adapter Framework — Normalized Event Contract for User-Scoped Poll-Out Ingest

## Status

Proposed (2026-07-12).

This is a **framework/contract ADR**: it fixes the shape of a normalized delivery
event and the extension-point seam it is emitted on — the OSS half of the
"Delivery loop" row in [ADR-0362](0362-plan-grounded-governance-one-surface.md) §6
— **ahead of** the 0.5+ implementation. It builds directly on
[ADR-0097](0097-user-scoped-external-task-sync.md) (the `EXTERNAL_TASK_SOURCES`
user-scoped read-only pull) and **reuses that poll mechanism rather than forking
it**; it consumes the engine-as-referee framing of
[ADR-0112](0112-ai-layer-oss-extension-points.md) (#1062) as the arbiter that a
future write surface routes through; and it is the follow-up the ADR-0362 §Tracking
list named ("delivery-loop adapter framework ADR"). It is resolving OSS issue #1851
(ADR-0362 follow-up #4). Only the Phase 0 substrate is real on `main` today (§7 of
ADR-0362); everything this ADR contracts is forward work.

## Context

**P3M layer:** Programs and Projects / Operations. A contributor connecting their
*own* single external account to feed their *own* assigned work into the schedule's
readiness signal is the team's data for the team's work — OSS. Org-wide, admin-
configured, bidirectional connectors that route many agents' writes across programs
roll *upward* to Portfolio/Senior-Leadership governance — Enterprise.

**What ADR-0362 named, and what it deferred to here.** ADR-0362 §3 established that
governance (writes: verdicts, gates, refusals) and oversight (reads: dashboards,
forecasts) are two projections of one substrate — the deterministic CPM + Monte
Carlo engine and the hash-chained `AgentAction` record. §4 established that the
"refusal moment" ships on **engine-as-referee (#1062) alone** and that any CEL/
policy-rule layer is a *separate, explicitly decoupled* ADR. Its §6 open-core split
gave the Delivery loop one line:

> **Community** — Adapter framework + normalized event contract (extension point),
> user-scoped single-provider connection, poll-out, CPM-aware `schedule.next_ready`
> dispatch. **Enterprise** — Org-wide, admin-configured, bidirectional connectors;
> central credential vaulting; org policy on which agents write where.

That line is a positioning commitment, not a contract. This ADR turns it into one:
the *shape* of the normalized event, the *seam* Enterprise's Integration Hub
registers against, and the invariants that keep the seam OSS and one-way. ADR-0362
§Tracking lists "delivery-loop adapter framework ADR" as an explicit follow-up, and
its Consequences ("instrumenting every refusal during the OSS build-out — poll-out
adapter, event seam, CPM dispatcher") presumes exactly the three pieces this ADR
names.

**What already exists (from the codebase scan).** The poll transport is built and
shipped — this ADR adds a normalization layer on top, it does not re-lay track:

- `EXTERNAL_TASK_SOURCES` + `ExternalTaskSource` ABC (`apps/integrations/external_sources.py`,
  ADR-0097 §1) — a user-scoped, single-provider, one-way, read-only poll. A source's
  `fetch_assigned_items(base_url, secret, config) -> list[ExternalWorkItemDTO]` is a
  *pure read of a snapshot*. OSS owns `jira` here; Enterprise registers richer sources
  against the same registry with no `trueppm_enterprise` import in OSS.
- `ExternalWorkItemDTO` — the per-item transport shape: `external_id`, `external_url`,
  `title`, `external_status`, `display_bucket` (∈ `todo | in_progress | done`),
  `due_date`, with a `sanitized()` boundary that length-caps and scheme-checks untrusted
  provider data.
- `ExternalWorkItem` — the per-user read-only Postgres cache (plain `models.Model`, **not**
  `VersionedModel`), with `is_stale` soft-removal, a `(user, source, external_id)` unique
  constraint, and a **test-enforced invariant that it never crosses the WS broadcast or the
  project sync delta and can never mint a `Task`** (ADR-0097 §2).
- `ExternalSyncRequest` outbox + `enqueue_external_sync()` service + `external_sync` worker
  + `drain-external-sync` Beat (300 s) — the canonical transactional-outbox durable-dispatch
  shape (ADR-0097 §Durable Execution).

**The gap.** ADR-0097's poll produces a *snapshot* and renders it read-only in My Work.
The delivery loop needs *events* — "this item became ready", "…changed", "…closed" — to
feed the CPM-aware `schedule.next_ready` dispatch (ADR-0362's durable asset #3: real at
program level). A poll-out transport has no push channel and no provider-side event stream,
so the events must be **derived**, by diffing each fresh snapshot against the last-known
cache. Nothing in the codebase does that today, and `schedule.next_ready` itself is a
forward concept (referenced only in ADR-0362) — this ADR fixes the contract that will feed
it before either lands, so the boundary is stable before implementation, exactly as
ADR-0029/0112 insist ("building the widgets before the frame is defined guarantees a
rewrite").

**The forces.** (1) Preserve the Apache-2.0 boundary and the one-way enterprise→core
dependency. (2) Do **not** fork ADR-0097's poll — one poll, fanned out to two consumers
(My Work cache + delivery normalizer). (3) Do **not** make the org project-mapping decision
(which external project → which TruePPM project) in OSS — that is the governance surface
ADR-0097 §2 reserved for Enterprise. (4) Carry **no** policy layer — this is the ingest
seam, not the referee; the refusal moment ships on engine-as-referee alone. (5) Do **not**
mutate the durable schedule or mint a `Task` from an inbound event — the write surface is
the decoupled 0.6 workstream, gated by the single-approver gate (ADR-0112 RC4).

## Decision

Define **one new normalized contract** (`DeliveryEvent`) and **one new stable seam**
(`delivery_event_emitted`), layered over the *existing* ADR-0097 poll — no second poll
mechanism, no second registry. The "delivery-loop adapter framework" is the OSS
normalization-and-emission layer plus these two contracts; a "delivery-loop adapter" **is**
an `ExternalTaskSource` (ADR-0097) viewed through the delivery-loop lens.

### 1. No new registry: a delivery-loop adapter is an `ExternalTaskSource`

The ADR-0362 §6 phrase "adapter framework" invites a new `DELIVERY_LOOP_ADAPTERS` registry.
We reject that (Alternative B): it would fork ADR-0097 and force a second per-provider poll,
second credential path, and second SSRF guard for the same Jira account. Instead, an adapter
that participates in the delivery loop is an existing `ExternalTaskSource` that **opts in**
with one additive class flag:

```python
class ExternalTaskSource(abc.ABC):
    key: ClassVar[str]                          # "jira"           (ADR-0097, unchanged)
    label: ClassVar[str]                        # "Jira"           (ADR-0097, unchanged)
    requires_credential: ClassVar[bool] = True  #                  (ADR-0097, unchanged)
    emits_delivery_events: ClassVar[bool] = False   # NEW — opt-in to the delivery loop
```

`emits_delivery_events` defaults to `False`, so every source registered before this ADR
(the OSS `jira` source; any Enterprise-registered source) keeps working unchanged and is
simply not loop-eligible until it opts in — additive, non-breaking. When `True`, the
framework runs that source's *existing* `fetch_assigned_items` snapshot through the
normalizer (§3). **No new abstract method is added** to `ExternalTaskSource`: a source
stays a pure snapshot read (the property ADR-0097 §1 depends on), and event derivation is
provider-agnostic framework code, so there is no per-provider event code to maintain or
diverge. Adding the flag is the entire change to the ADR-0097 surface.

One poll, two consumers: the `external_sync` worker upserts `ExternalWorkItem` (My Work,
ADR-0097) **and** — when the source opts in — hands the pre/post snapshot pair to the
normalizer (this ADR). The fan-out is inside the worker; the transport is single-sourced.

### 2. The normalized event contract — `DeliveryEvent` (the load-bearing decision)

A `DeliveryEvent` is one *state transition* of one external work item, normalized across
providers. It is a frozen dataclass — the stable cross-repo contract, versioned exactly
like `AgentActionEvent` (ADR-0112 §1.3):

```python
class DeliveryTransition(models.TextChoices):
    APPEARED  = "appeared",  "Entered the assigned set"
    READY     = "ready",     "Became actionable (→ in_progress-ish)"
    CHANGED   = "changed",   "Status/fields changed within the set"
    CLOSED    = "closed",    "Reached a terminal/done bucket"
    WITHDRAWN = "withdrawn", "Left the assigned set (soft-removed)"

@dataclass(frozen=True)
class DeliveryEvent:
    schema_version: int          # bump on any field change; receivers branch on it
    provider: str                # EXTERNAL_TASK_SOURCES key — "jira" (NOT a new namespace)
    external_id: str             # provider-stable id — "RIV-482"  (from ExternalWorkItemDTO)
    external_url: str            # https?:// deep link             (from ExternalWorkItemDTO)
    external_status: str         # raw provider status — "In Review" (from ExternalWorkItemDTO)
    owner_id: int                # credential owner = user PK (int, per ADR-0097 §2) — the scope
    transition: str              # DeliveryTransition value
    from_bucket: str | None      # display bucket before (todo|in_progress|done), None on APPEARED
    to_bucket: str               # display bucket after   (todo|in_progress|done)
    linked_task_id: str | None   # USER-asserted personal link (§4), else None — never org-mapped
    project_id: str | None       # derived from the linked task, else None
    occurred_at: datetime        # provider-reported change time if available, else observed_at
    observed_at: datetime        # UTC — when the poll observed the transition (poll-out has no push ts)
    poll_cursor: str             # provenance — the ExternalSyncRequest id that produced this event
    dedup_key: str               # sha256(owner_id ‖ provider ‖ external_id ‖ transition ‖ to_bucket ‖ poll_cursor)
```

Three deliberate reconciliations with ADR-0097's vocabulary, so this is an **extension, not
a fork**:

- The item-identity fields (`external_id`, `external_url`, `external_status`) and the bucket
  vocabulary (`todo | in_progress | done`, the `DISPLAY_BUCKETS` in `external_sources.py`)
  are **verbatim** from `ExternalWorkItemDTO`. `DeliveryEvent` embeds the item's identity
  and wraps it in a transition envelope; it does not invent a parallel item shape.
- `owner_id` is the `(user, source)` scope key that already scopes `ExternalWorkItem` and
  `ExternalSyncRequest` (user PKs are **integers**, ADR-0097 §2 — not UUIDs).
- `provider` is the same `EXTERNAL_TASK_SOURCES` key (`jira`), **not** a new provider
  namespace and **not** the reserved `TASK_LINK_PROVIDERS` `jira` (ADR-0049/0097 §1 keep
  those distinct).

`READY` is the transition that feeds `schedule.next_ready`: it fires when an item enters an
actionable bucket (a `todo → in_progress` bucket transition, or a source-declared "ready"
signal). `CLOSED` (→ `done`) is the actuals signal the CPM-aware dispatch consumes to learn
that linked work finished. `WITHDRAWN` reuses ADR-0097's `is_stale` soft-remove semantics —
an item that vanishes from a *successful* poll, never from a transient partial one.

### 3. The normalizer — provider-agnostic event derivation

The framework adds one OSS service, `derive_delivery_events(*, owner_id, provider, previous, current, poll_cursor)`
in `apps/integrations/delivery.py`, called by the `external_sync` worker *after* it upserts
`ExternalWorkItem` and *before* commit. `previous` is the pre-poll cache state for
`(owner_id, provider)`; `current` is the sanitized snapshot the source just returned. It
computes the set diff and emits one `DeliveryEvent` per transition:

- id in `current` \ `previous` → `APPEARED` (and `READY` if it lands directly in an
  actionable bucket);
- id in both, bucket changed → `READY` / `CHANGED` / `CLOSED` per the destination bucket;
- id in `previous` \ `current`, poll succeeded → `WITHDRAWN`.

Because derivation is a pure function of two snapshots and lives in exactly one place, every
provider gets identical, testable event semantics with zero per-provider event code — the
same single-source discipline ADR-0112 applied to `stamp_answer`. The events are appended to
a bounded per-user log (§Durable Execution item 6) and dispatched on the seam (§5).

### 4. Linkage is user-asserted and optional — the org project-mapping stays Enterprise

The dispatch needs *some* correlation between an external item and a TruePPM task, but
ADR-0097 §2 is emphatic that **which external project maps into which TruePPM project is an
org/admin decision that belongs to the Enterprise Hub** — personal pull must never make it.
We honor that line verbatim:

- `linked_task_id` is populated **only** from a user-owned, self-scoped
  `ExternalWorkItemLink` — the contributor themselves asserting "this Jira issue is the work
  behind *my* task X" (a personal association, the same trust scope as their own connection).
  It is never derived from an org rule, a project-key mapping, or another user's data.
- When the user has asserted no link, `linked_task_id` and `project_id` are `None`: the event
  is still normalized and emitted (it feeds My Work context and is visible to the owner), but
  it correlates to no task and drives no dispatch.
- **Org-wide, rule-based mapping of external projects to TruePPM projects is Enterprise** —
  it is exactly the "multi-provider mapping rules" ADR-0049 and the "org project-mapping"
  ADR-0097 §2 reserved. OSS ships the user-asserted single-item link only.

This keeps every field on `DeliveryEvent` sourced from the owning user's own data — no
cross-user, no org-policy input — which is what keeps the whole contract on the OSS side of
the boundary.

### 5. The extension-point seam — `delivery_event_emitted`

OSS exposes one stable Django signal, mirroring `agent_action_recorded` (ADR-0112 §1.3) and
`agent_action_prune_requested` (ADR-0361 §3):

```python
# OSS — apps/integrations/signals.py
delivery_event_emitted = django.dispatch.Signal()   # the stable hook; kwarg: event: DeliveryEvent
```

Dispatched **inside the same `transaction.on_commit()`** that commits the poll's cache
upsert, so an event fires exactly when (and only when) the observation durably landed. The
seam has two consumers, on the two sides of the boundary:

- **OSS consumer — the CPM-aware dispatch.** `schedule.next_ready` (forward work) reads
  `DeliveryEvent`s as **advisory readiness signals**: a `CLOSED` on a linked task's external
  item tells the dispatcher the work behind that task finished, so its CPM successors may now
  be offerable. The event is *input to a read-model recomputation*, not a schedule mutation
  (see §6). If no dispatcher is wired yet (0.5 pre-implementation), events accumulate in the
  log and drive nothing — OSS runs unchanged.
- **Enterprise consumer — the org-wide Integration Hub.** Enterprise registers a receiver on
  `delivery_event_emitted` at app-ready to route normalized events into its bidirectional
  connector subsystem (writeback, conflict resolution, org project-mapping, per-tenant rate
  budgets). It **reads the frozen `DeliveryEvent`; it never reaches into OSS internals**, and
  OSS has no knowledge that a receiver exists. The Hub is an *orthogonal subsystem* — it does
  not fork the poll, it consumes its normalized output. If no receiver is registered
  (community edition), the signal dispatches to the OSS dispatcher only.

**Stability guarantee.** `DeliveryEvent`, the `DeliveryTransition` values, the
`emits_delivery_events` flag, and the `delivery_event_emitted` signal name are a **public
cross-repo contract** under the same rule as ADR-0112 §1.3: adding a field or a transition is
additive/non-breaking (receivers branch on `schema_version`); renaming/removing any of them,
or changing a field's meaning, is a **major-version breaking change** for Enterprise
customers (CLAUDE.md boundary rule 3), must bump `schema_version`, and is recorded in
`packages/api/CHANGELOG.md` under the "Enterprise extension contract" heading.

### 6. Decoupling — this is the ingest seam, not a policy layer or a write surface

Three explicit decouplings, so the framework is not confused with the layers around it:

- **No CEL/policy layer.** The framework normalizes and emits; it makes **no**
  allow/refuse/route decision. Per ADR-0362 §4, the refusal moment ships on
  **engine-as-referee (#1062) plus the existing invariant guards** alone; a CEL-style rule
  layer is a separate, explicitly decoupled ADR. `DeliveryEvent` carries no policy verdict —
  a `verdict` is what the *dispatch/write* path records on the `AgentAction` chain (ADR-0112),
  downstream of and independent from this seam.
- **No schedule mutation, no `Task` minting.** An inbound event is **advisory input** to the
  `schedule.next_ready` read-model; it does not write the durable schedule and — honoring
  ADR-0097 §2's test-enforced invariant — **can never mint a `Task`**. Acting on an event to
  *mutate* the schedule (mark a task complete because its external item closed) is the **0.6
  gated write surface** (#505/#604), which routes through the single-approver gate (ADR-0112
  RC4) and the engine-as-referee. That surface is a separate workstream; this ADR is the seam
  that feeds work *in*, decoupled from what consumes it.
- **Poll-out only.** OSS ingest is **pull** (poll-out). Provider-push **webhook ingest with
  HMAC/replay protection** is Enterprise (ADR-0097 §Threat Model line, ADR-0049 Enterprise
  tier). The normalized `DeliveryEvent` shape is identical whichever way the Hub later
  observes a transition, so Enterprise's push path emits the same contract — the seam is
  transport-agnostic by construction.

### 7. The boundary, stated

Restating ADR-0362 §6 and ADR-0097's line as the contract for this seam:

| Concern | Community (Apache 2.0) — this ADR | Enterprise |
|---|---|---|
| Connection scope | User-scoped, single-provider, one per `(user, source)` | Org-wide, admin-configured, many connectors |
| Direction | One-way, read-only **poll-out** (pull) | **Bidirectional** — writeback + push webhook ingest (HMAC/replay) |
| Credentials | Per-user Fernet `IntegrationCredential` (ADR-0097 §3) | Central credential vaulting |
| Event contract | Owns `DeliveryEvent` + normalizer + `delivery_event_emitted` seam | Registers a receiver; emits the *same* contract from its push path |
| Task linkage | User-asserted single-item personal link | Org rule-based project→project mapping |
| Dispatch | Feeds OSS CPM-aware `schedule.next_ready` (advisory) | Org policy on which agents write where |

The one-sentence test (CLAUDE.md Two-Repo Rule, ADR-0097 spirit): **a contributor connecting
their own account to pull their own work in, read-only, is OSS; provisioning connectors,
writing back, and governing which agents write where across the org is Enterprise.**

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Normalizer + `DeliveryEvent` contract + `delivery_event_emitted` seam layered on ADR-0097's poll (chosen)** | No forked poll/credential/SSRF path; one contract, provider-agnostic derivation; Enterprise Hub registers against a stable seam; honors the "no org mapping, no Task, no policy" invariants | Adds a derived-event concept and a bounded per-user event log; `schema_version` becomes load-bearing cross-repo surface |
| B. New `DELIVERY_LOOP_ADAPTERS` registry + `DeliveryLoopAdapter` ABC with its own poll | Literal reading of ADR-0362's "adapter framework"; clean conceptual separation | **Rejected.** Forks ADR-0097 — second poll, second credential path, second SSRF guard for the *same* Jira account; two registries to keep from colliding; violates the explicit "don't invent a parallel mechanism" constraint |
| C. Add an abstract `fetch_events()` to `ExternalTaskSource` (per-provider event code) | Providers could emit richer native events | **Rejected.** Breaks ADR-0097's "a source is a pure snapshot read" property; per-provider event code diverges and is untestable in one place; a poll-out provider has no native event stream anyway — the events must be *derived* |
| D. Feed the dispatch by minting/updating canonical `Task`s from inbound items | Items join CPM directly; simplest dispatch wiring | **Rejected.** Violates ADR-0097 §2's test-enforced "never a `Task`, never CPM, never writeback" invariant; forces the org project-mapping decision into OSS; *is* the Enterprise bidirectional sync |
| E. Bake a policy/routing verdict into the event ("which agent, allow/refuse") | One-stop ingest+govern | **Rejected.** Conflates the ingest seam with the referee; ADR-0362 §4 keeps the CEL/policy ADR decoupled and ships refusal on engine-as-referee alone; policy in the event would couple the seam to a layer that does not exist yet |
| F. Transient events (derive + dispatch, never persist) | No new table, no retention | **Rejected.** A broker/worker restart between derive and consume silently drops a dispatch signal; oversight/refusal telemetry (#1850) needs a durable projection; the bounded log is cheap and re-derivable |

## Consequences

**Easier:**
- The CPM-aware dispatch and the Enterprise Hub both build against one fixed, versioned event
  shape instead of negotiating a surface per provider — the ADR-0029/0112 slot-registry
  discipline extended to the delivery loop.
- One poll feeds two consumers (My Work + delivery normalizer) with no duplicated transport,
  credential, or SSRF surface — the smallest net-new footprint over ADR-0097.
- Refusal-telemetry instrumentation (ADR-0362 follow-up #2, OSS issue #1850) has a concrete,
  durable `DeliveryEvent` stream to correlate refusals against from day one of dogfooding.
- Enterprise's push (webhook) path later emits the *same* `DeliveryEvent`, so the dispatch
  and oversight code is transport-agnostic — poll-out today, push tomorrow, one contract.

**Harder:**
- `DeliveryEvent`, its transitions, and the seam name are now public cross-repo surface —
  additive changes are fine, renames/removals/semantic changes are major breaks for
  Enterprise and must bump `schema_version`.
- A new per-user append log needs a retention lever (a bounded ring + nightly purge, or the
  manual-prune posture of ADR-0361); getting the bound right at v1 matters (caps are easy to
  raise, hard to retrofit — the ADR-0097 lesson).
- Two consumers on one signal means the dispatch and the Enterprise receiver must both be
  resilient to unknown additive fields and to each other's absence.

**Risks:**
- **Boundary creep toward writeback.** The day someone lets an event auto-complete a `Task`
  "to close the loop", the seam becomes the Enterprise bidirectional sync. Mitigation: the
  ADR-0097 §2 "never a `Task`" invariant is restated as a hard contract here and is
  test-enforced; the write surface is the decoupled, single-approver-gated 0.6 workstream.
- **Boundary creep toward org mapping.** Deriving `linked_task_id` from anything but a
  user-asserted personal link imports org policy into OSS. Mitigation: `linked_task_id` is
  sourced only from `ExternalWorkItemLink` (owner-scoped); org rule-based mapping is Enterprise.
- **Policy leaking into the event.** A `verdict`/`route` field would couple the seam to the
  not-yet-existing CEL layer. Mitigation: `DeliveryEvent` carries no verdict; `ai-review`
  (ADR-0112) gates any change that adds policy semantics to the ingest seam.
- **Derived events drift from provider truth.** Poll-out infers transitions from snapshot
  diffs, so a missed poll can coalesce two transitions into one. Mitigation: `poll_cursor`
  provenance + idempotent `dedup_key` make re-derivation convergent; `WITHDRAWN` fires only
  on a *successful* poll (never a partial), reusing ADR-0097's soft-remove guard.

## Implementation Notes

- **P3M layer:** Programs and Projects / Operations — a contributor's own single-provider
  connection feeding their own work into the schedule readiness signal. Cross-program,
  org-wide, bidirectional routing rolls upward to Enterprise.
- **Affected packages (forward):** `api` (OSS — `apps/integrations`: the `emits_delivery_events`
  flag on `ExternalTaskSource`, `delivery.py::derive_delivery_events`, `signals.py::delivery_event_emitted`,
  the bounded `DeliveryEvent` log model, the `ExternalWorkItemLink` user-asserted link, and the
  `external_sync` worker fan-out); `scheduler`/`scheduling` (OSS — the `schedule.next_ready`
  dispatch that consumes the events, a separate 0.5+ workstream); `trueppm-enterprise` (registers a
  receiver + its push path). No `web`/`mobile`/`helm` change in *this* contract; the My Work surface
  (ADR-0097) is unaffected. `grep -r "trueppm_enterprise" packages/` stays zero.
- **Migration required:** Not for this ADR (it defines contracts). The implementing issues add
  additive `CreateModel` migrations (`DeliveryEvent` log, `ExternalWorkItemLink`) and one additive
  class attribute (no migration); pin the `DeliveryTransition` enum via `ENUM_NAME_OVERRIDES` to
  avoid an `api:schema-drift` "Removed schemas" regression.
- **API changes:** Not in this ADR. The implementing issues add the user-asserted link endpoint
  (`POST/DELETE /api/v1/me/work/{item}/link/`, `IsAuthenticated`, self-scoped) and the dispatch's own
  surface; `api-docs` sync required when those land.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). The `DeliveryEvent` contract, the normalizer,
  the `delivery_event_emitted` seam, the poll-out reuse, and the user-asserted link are OSS.
  The bidirectional Hub, push/webhook ingest, central credential vaulting, and org project-mapping
  are Enterprise, registered against this seam.

### Durable Execution

These answers are concrete for the future adapter's poll-out dispatch posture — they **ride
ADR-0097's existing outbox**, they are not "N/A by construction".

1. **Broker-down behaviour:** No new broker dispatch is introduced. Event derivation runs
   *inside* the existing `external_sync` worker (already reached via the `ExternalSyncRequest`
   transactional outbox), and `delivery_event_emitted` is dispatched in the same
   `transaction.on_commit()` that commits the poll's cache upsert — so events fire exactly when
   the observation durably lands. If the broker is down at poll-trigger time, the
   `ExternalSyncRequest` row stays `PENDING` and the existing drain recovers it (ADR-0097 §DE 1);
   no event is derived until the poll actually runs, so there is no derive-without-commit gap.
2. **Drain task:** **Reuses** `drain-external-sync` (300 s) — event derivation is a step *within*
   the poll worker, not a new category of async work, so it inherits that drain's semantics. The
   `schedule.next_ready` dispatch that *consumes* events is a separate workstream and will declare
   its own drain if it enqueues async work; this ADR introduces none.
3. **Orphan window:** Inherited from `drain-external-sync` (2 min PENDING filter, ADR-0097 §DE 3).
   The `on_commit` dispatch of `delivery_event_emitted` is not an outbox row, so there is no
   separate in-flight-commit race to filter for the emission itself.
4. **Service layer:** New OSS functions in `apps/integrations`: `derive_delivery_events(...)`
   (pure snapshot-diff → `list[DeliveryEvent]`) and `emit_delivery_events(events)` (persist to the
   bounded log + `on_commit` dispatch of `delivery_event_emitted`). The `external_sync` worker calls
   both; nothing calls `.delay()` for events directly. `enqueue_external_sync` (ADR-0097) is unchanged.
5. **API response on best-effort dispatch:** Unchanged from ADR-0097 — `POST /me/connections/{source}/sync/`
   still returns `202 {"queued": true}`. Event derivation is a server-side side effect of the poll, not a
   separately-triggered endpoint; the user-asserted link endpoint is a synchronous `200/204`.
6. **Outbox cleanup:** The `DeliveryEvent` log is **not** an outbox — it is a bounded per-user
   append log (append at derivation, consumed by the dispatch). It is bounded like `ExternalWorkItem`:
   a per-`(user, provider)` cap plus a nightly purge of consumed/aged rows (7-day retention, the
   existing convention; add `_do_purge_delivery_events` + a Beat entry). It is re-derivable from the
   `ExternalWorkItem` cache diff if lost, so purge is lossless for dispatch. It is **not** the
   `AgentAction` audit chain (that records the downstream dispatch *verdict*, ADR-0112) and carries no
   hash-chain, so purging it never breaks `audit_verify`.
7. **Idempotency:** Each event carries a deterministic `dedup_key = sha256(owner_id ‖ provider ‖
   external_id ‖ transition ‖ to_bucket ‖ poll_cursor)`; a unique constraint on it makes a re-run of
   the same poll (broker retry, manual re-trigger) converge to the same log state — a duplicate
   derivation is a no-op upsert, mirroring ADR-0097's `(user, source, external_id)` cache upsert.
   `derive_delivery_events` is a pure function of two snapshots, so identical inputs yield identical
   events.
8. **Dead-letter / failure handling:** No new failure surface. A failed poll leaves the last-good
   `ExternalWorkItem` cache and derives **no** events (the ADR-0097 §5 "keep last-good, mark
   `ExternalSyncRequest` FAILED, surface staleness/reconnect" path is unchanged) — no partial or
   phantom transitions. `WITHDRAWN` is emitted only on a *successful* poll, so a transient outage
   never fabricates a spurious close. No DLQ: a dropped derivation is recovered by the next
   successful poll re-diffing against the cache. An Enterprise receiver that fails on
   `delivery_event_emitted` handles its own retry/DLQ and must not roll back the OSS poll (receivers
   run after commit, in `on_commit`, isolated from the OSS transaction — the ADR-0112 §DE 8 rule).

## Tracking

Builds on: ADR-0097 (user-scoped read-only poll, `EXTERNAL_TASK_SOURCES`/`ExternalTaskSource`/
`ExternalWorkItemDTO`/`ExternalWorkItem`/`ExternalSyncRequest`), ADR-0112 (agent substrate,
engine-as-referee, `agent_action_recorded` signal precedent, `schema_version` cross-repo
discipline), ADR-0362 §4/§6 (delivery-loop open-core split, refusal-on-engine framing),
ADR-0049 (external-integration extension-point/registry conventions), ADR-0029/0030 (slot-registry
+ edition-detection precedent this extends to the delivery loop), ADR-0361 (`Signal`-veto and
bounded-log/manual-prune retention posture). Inputs: *MCP Implementation Audit & Governed Agent
Control Plane Roadmap* (2026-07-10), *TruePPM × Agentic Delivery* thread (2026-07-11, §8 — dispatch
is durable asset #3, the loop itself is commoditized). Constrained issues: #1062 (engine-as-referee,
the decoupled referee), #505/#604 (0.6 gated writes — the decoupled write surface), #1312/#1313
(single-approver gate). Constrains/enables follow-ups: `schedule.next_ready` CPM-aware dispatch
(OSS, 0.5+, consumes this seam), refusal-telemetry instrumentation (#1850, correlates against this
event stream), the Enterprise Integration Hub receiver + push path (registers against
`delivery_event_emitted`). Resolves: #1851 (ADR-0362 follow-up #4).
