# ADR-0112: AI-Layer OSS Extension Points — Agent-as-Actor and Signed-Answer Provenance

## Status
Accepted (2026-07-11, amended — see **Ratification amendments** below). Supersedes the
original **Proposed** state. Ratified at 0.4 because the Phase 0 audit substrate (#1805)
and Phase 1 identity work (finding F7) require an accepted source of truth for the
agent-governance architecture before code lands.

## Ratification amendments (2026-07-11, #1810)

The ADR is accepted with four amendments to the original proposal. Each is folded into
the section bodies below; this block is the change summary.

- **RC1 — Hash-chained, tamper-evident OSS audit record.** The team-readable
  `AgentActionLog` (§1.3) is upgraded to an **append-only, hash-chained** `AgentAction`
  record carrying (actor, human principal, operation + payload hash, verdict
  `allowed`/`refused`/`requires-approval`, engine `server_version`, and a **per-instance
  monotonic sequence** hash-chained to its predecessor), verifiable by a
  `manage.py audit_verify` chain-integrity command. This is what #1805 implements.
  Per-instance hash-chained **integrity self-check** is OSS (a team using AI must be able
  to trust its own log on its own box — the audit-log analog of the OSS answer-stamp hash
  in §2.3). Enterprise's value-add is narrowed to **org-scale compliance evidence**:
  external notarization, a cryptographic *signature* over the chain for legal evidence,
  retention policy, the org-wide cross-instance trail, and SAML/SCIM-attributed
  identities (#146). This corrects the original §1.3/§3 wording ("OSS does not promise
  tamper-evidence"), which conflated *detecting local tampering* (cheap, OSS) with
  *notarized org compliance evidence* (Enterprise).

- **RC4 — Single-approver human-in-the-loop gates are OSS.** The original "approval
  workflow → Enterprise" pair (§3) is split. A **single-approver** gate — an agent write
  is held as `requires-approval` until **one** human with the requisite role approves it —
  is **OSS** table-stakes safety (without any in-loop gate an AI-native team cannot let an
  agent write safely and churns to a tool that can; the parallel is 5-role RBAC in OSS vs
  custom roles in Enterprise). **Multi-step approval chains, delegated approval authority,
  and notification routing/escalation** remain **Enterprise**. OSS issues #1312/#1313
  are filed against this OSS gate. `ai-review` check 5 is aligned to this split.

- **RC5 — Intersection semantics for delegation.** An agent's **effective** permissions
  are the **intersection** of its own capability scope (§1.2) and its human principal's
  role scope at the moment it acts — an agent can never exceed the human it acts for.
  This formalizes the weaker §1.2 statement (an agent token can never exceed the role of
  the human who *provisioned* it) into the per-request FSI-defensible invariant
  `effective = agent_scope ∩ principal_scope`. OSS.

- **RC2 — Single-tenant framing.** The monotonic sequence and hash chain (RC1) are
  **per-instance / per-workspace**, not per-tenant — TruePPM is single-tenant/self-hosted;
  multi-tenant governance sequencing is Enterprise (1.0+).

The **RC1** hash-chained audit record (with its RC2 single-tenant sequencing) is **0.4
scope** — it is exactly what #1805 implements, and ratifying it is what unblocks that
work. The **RC4** approval-gate boundary and the **RC5** delegation semantics concern
Phase 1/3 (agent writes, #1312/#1313, #1063); they are **ratified as boundary decisions
now** so the audit record's `verdict`/`requires-approval` vocabulary and the intersection
invariant are fixed, but the finalized *shape* of the single-approver gate and per-request
delegation is carried to the **0.5 planning agenda**. The load-bearing point is only that
the ADR is Accepted (not Proposed) before the 0.4 audit substrate lands. _Source: MCP
audit & governance roadmap, 2026-07-10 — finding F7, RC1/RC2/RC4/RC5._

## Context

TruePPM is evolving for the AI era. The product strategy splits AI capabilities into two layers that map cleanly onto the existing open-core boundary:

- An OSS **team-AI layer** (the adoption surface). A team that *uses* AI needs trust, safety, working memory, simulation, and the option of a local model — and the same deterministic scheduling engine must serve humans and agents identically (the engine is the referee, not a chatbot bolt-on). This lives in `trueppm/trueppm` (Apache 2.0). It is what makes an AI-native team fully functional without paying.
- An Enterprise **AI-governance layer** (the conversion surface). An organization that wants to *govern* agent activity needs an immutable, tamper-evident audit of agent actions, human-in-the-loop approval workflows for agent writes, custom agent roles and org capability policy, cross-program AI memory/calibration, and compliance-evidence export. This lives in `trueppm/trueppm-enterprise` (proprietary).

The adoption-vs-governance line that already separates OSS from Enterprise (CLAUDE.md Two-Repo Rule; the P3M layer model in the architect skill) applies without modification to AI surfaces: *the team using AI to get work done is OSS; the org governing what agents may do is Enterprise.*

This split only holds if the OSS side exposes the AI surfaces as **stable extension points** that Enterprise registers against — exactly the pattern ADR-0029 (frontend slot registry) and ADR-0030 (edition routing) established for the React shell, and the Django-signal pattern (ADR-0010/0011/0013) established for the backend. The lesson of ADR-0029 is explicit and load-bearing here: *building enterprise widgets before the extension mechanism is defined guarantees a rewrite.* The same is true of agent identity and answer provenance. If Enterprise's audit trail, approval workflow, and compliance export are written against an undefined or ad-hoc OSS surface, the only paths available are (a) forking the OSS AI code into Enterprise — boundary leakage — or (b) reaching into OSS internals, which makes every OSS refactor a breaking change for paying customers. Both are precisely what the slot-registry precedent exists to prevent.

Two OSS backend surfaces must therefore be defined now, as contracts, **before** the AI features that depend on them are implemented:

1. **Agent-as-Actor** (OSS issue trueppm/trueppm#1063): agent identity as a first-class actor, a capability-scoped token (extending the `ApiToken` scopes of #601), and a **team-readable** audit log of agent actions. Enterprise registers against this to add an immutable/tamper-evident **org** audit trail (#146), human-in-the-loop **approval workflows** for agent writes (#147), and **custom agent roles & org capability policy** (#148).

2. **Signed-Answer / Answer-Provenance** (OSS issue trueppm/trueppm#1065): computed API/MCP responses carry an engine-version + canonical input-hash stamp so any answer is independently reproducible. Enterprise registers against this to add a **compliance evidence export / signed-answer archive with retention** (#152).

**Related OSS AI issues** (cross-referenced, designed against these two extension points but out of scope for this ADR's contract definition): #1058 provenance graph, #1059 decision/forecast memory (store + read), #1060 NL→query compiler, #1061 BYO-local-model adapter, #1062 engine-as-referee. **Related Enterprise issues:** #146–#153.

**P3M layer.** Programs and Projects / Operations. An agent acting on a team's project, and the provenance of a computed answer about that project, are the team's own data for its own work — OSS. Cross-program agent-memory calibration and org-wide audit/compliance roll *upward* to Portfolio/Senior-Leadership governance — Enterprise.

This ADR formalizes an already-decided strategy into two stable contracts. It does not re-litigate the split; it pins the shapes Enterprise will build against and states the stability guarantee so that changing those shapes is, by definition, a breaking change.

## Decision

Define two backend OSS extension points — `agent-as-actor` and `signed-answer` — as the **single sanctioned boundaries** between the OSS team-AI layer and the Enterprise AI-governance layer. OSS owns the actor model, the capability-scoped token, the team-readable audit hook, and the answer-stamp envelope. Enterprise registers receivers/policies against these points; it never imports OSS AI internals and OSS never imports `trueppm_enterprise`.

Both extension points follow the established TruePPM extension model:
- **Backend signal/registry hooks** — the Django-signal precedent (ADR-0010/0011/0013), mirrored for AI surfaces. OSS defines a named hook and dispatches to it; Enterprise registers a receiver at app-ready.
- **Edition gating** — the `TRUEPPM_EDITION` setting and `GET /api/v1/edition/` endpoint (ADR-0029/0030) already distinguish `community` from `enterprise`. No new edition mechanism is introduced.

### 1. Agent-as-Actor extension point (#1063)

#### 1.1 Actor identity model

Agent identity is a first-class actor, **not** a second user table and **not** an impersonated human. The contract is a stable `Actor` value object that every audited operation resolves to:

```
class ActorKind(models.TextChoices):
    HUMAN  = "human",  "Human user"
    AGENT  = "agent",  "AI agent"
    SYSTEM = "system", "System / scheduled"

# OSS — apps/agents/models.py  (Apache 2.0)
class AgentActor(VersionedModel):       # UUID PK, server_version (TruePPM convention)
    id            = UUIDField(primary_key=True, default=uuid.uuid4)
    display_name  = CharField()              # "Planning Assistant", shown in the audit log
    created_by    = FK(User, on_delete=PROTECT)   # the human who provisioned the agent
    project       = FK(Project, null=True)        # null ⇒ program-scoped (still OSS)
    is_active     = BooleanField(default=True)
    # capability scope lives on the token (§1.2), not the actor — an actor may hold
    # several tokens of differing scope over its lifetime.
```

The resolved actor passed through the audit hook is a frozen value object, **the stable contract**:

```
@dataclass(frozen=True)
class Actor:
    kind: ActorKind            # "human" | "agent" | "system"
    id: str                    # User PK (int→str) for HUMAN; AgentActor UUID for AGENT
    display_name: str
    on_behalf_of: str | None   # human PK when an agent acts under a human's delegation
    token_id: str | None       # ApiToken PK that authenticated the request, if any
```

`on_behalf_of` is the delegation field: an agent invoked from a human's session records *both* the agent (`id`, `kind=agent`) and the delegating human (`on_behalf_of`). This is what makes the team-readable log answer "which human stood behind this agent action" without Enterprise, and is the hook Enterprise approval workflows (#147) key off.

**OSS provisions and reads agents; OSS does not enforce org policy on them.** Custom agent roles and org capability policy (#148) are an Enterprise concern that *constrains* which scopes an `AgentActor` may be granted — but the OSS `AgentActor` + scoped token is fully functional standalone (a team can provision an agent, scope it, and read its actions with no Enterprise present).

#### 1.2 Capability-scoped token claims (extends #601)

Agent tokens are `ApiToken` rows (the existing #601 scoped-token model) with an additional `actor` linkage and an **agent-capability scope vocabulary**. The token's scope claim is the stable contract; the vocabulary is additive (new scopes are non-breaking, renames/removals are breaking):

```
# Token scope claim shape (stable):
{
  "actor_kind": "agent",
  "actor_id": "<AgentActor UUID>",
  "on_behalf_of": "<User PK or null>",
  "capabilities": [                  # additive vocabulary, ADR-versioned
    "task:read", "task:write",
    "schedule:read", "schedule:simulate",   # simulate = ephemeral what-if (§ non-goals)
    "sprint:read",
    "answer:read"                            # read computed/signed answers (§2)
  ],
  "project_scope": ["<Project UUID>", ...]   # object-level floor; empty ⇒ all of actor.project
}
```

The capability check is enforced in OSS by a permission class `HasAgentCapability("<cap>")` that composes with the existing 5-role RBAC. **Delegation is intersection (RC5):** an agent's *effective* permissions on a request are the **intersection** of its own capability scope and the role scope of its human principal (`on_behalf_of`, or `created_by` when acting autonomously) at the moment it acts — `effective = agent_scope ∩ principal_scope`. An agent can therefore never exceed the human it acts for: narrowing the principal's role narrows the agent in the same request, and a capability the agent holds but the principal lacks is unusable. This is the FSI-defensible invariant, stronger than "cannot exceed who *provisioned* it" because it re-evaluates against the *acting* principal per request. `schedule:write` is deliberately **absent** from the default agent vocabulary in OSS: an agent may *simulate* (ephemeral, §non-goals) but a write that mutates the durable schedule routes through the OSS single-approver gate (§3, RC4) — held as `requires-approval` until one authorized human approves. Enterprise's multi-step approval workflow (#147) registers to *extend* that gate into chains/delegation/routing under org policy; OSS ships safe-by-default (read + simulate, single-approver gate on write).

#### 1.3 Team-readable audit hook and event schema

OSS owns a **team-readable, append-only, hash-chained** audit of agent actions (RC1). Every project member can read what the team's agents did *and* verify the log's own integrity on their own instance. The OSS/Enterprise dividing line is **per-instance integrity self-check (OSS) vs org-scale compliance evidence (Enterprise)**, not "plain log vs tamper-evident log":

- **OSS provides per-instance tamper-*evidence*.** Each record is hash-chained to its predecessor (a per-instance monotonic sequence; each row stores `sha256(prev_hash ‖ canonical(this_record))`), and `manage.py audit_verify` walks the chain and reports the first break. A team can detect whether its own log was altered on its own box. This is the audit-log analog of the OSS answer-stamp hash (§2.3) — cheap, local, reproducible, and required for a team to *trust* an agent it runs.
- **Enterprise provides org-scale compliance *evidence*.** External notarization, a cryptographic *signature* over the chain (as opposed to the OSS hash), retention policy, the org-wide cross-instance trail, and SAML/SCIM-attributed identities are the Enterprise value-add and the thing customers convert for (#146). OSS hashes so you can detect tampering; Enterprise signs and notarizes so you can *prove* to an auditor it was not tampered.

The earlier framing — "OSS does not promise tamper-evidence" — conflated these two and is superseded by RC1: OSS ships the hash-chained integrity self-check; Enterprise ships the notarized, signed, retained compliance archive.

The contract is a Django signal + an event dataclass:

```
# OSS — apps/agents/signals.py
agent_action_recorded = django.dispatch.Signal()   # the stable hook name

@dataclass(frozen=True)
class AgentActionEvent:                # the stable event schema (additive only)
    schema_version: int                # bump on any field change; receivers branch on it
    actor: Actor                       # §1.1 frozen value object
    action: str                        # "task.update", "sprint.close", "schedule.simulate"
    object_type: str                   # "task" | "sprint" | "schedule" | ...
    object_id: str | None
    project_id: str
    capability_used: str               # the scope that authorized it (§1.2)
    verdict: str                       # RC1: "allowed" | "refused" | "requires-approval"
    refusal_reason: str | None         # RC1: "identity" | "policy" — set when verdict=refused
    payload_hash: str                  # RC1: sha256 over the canonical operation payload
    engine_version: str                # RC1: trueppm-scheduler server_version at decision time
    sequence: int                      # RC1: per-instance monotonic sequence (RC2 — not per-tenant)
    prev_hash: str                     # RC1: hash of the predecessor record (chain link)
    summary: str                       # human-readable, team-facing
    answer_stamp: AnswerStamp | None   # §2 — set when the action emitted a signed answer
    occurred_at: datetime              # UTC
```

OSS writes one `AgentAction` row per event (RC1 — a plain, append-only `models.Model`, not synced, matching the `SprintBurnSnapshot`/`SprintScopeChange`/`SprintTaskOutcome` precedent in ADR-0176; the team reads it online via `GET /projects/{id}/agent-actions/`, it does not sync to mobile). The row is **hash-chained**: it stores the `sequence`, `payload_hash`, `verdict`, `engine_version`, and `record_hash = sha256(prev_hash ‖ canonical(record))`, where `prev_hash` is the `record_hash` of the immediately preceding row in the **per-instance** sequence (RC2 — the sequence and chain are per-instance/per-workspace, not per-tenant). The `sequence` allocation and the chain append happen inside the operation's atomic block so two concurrent writes cannot interleave the chain (a `select_for_update` on the per-instance chain head, or a DB sequence + unique constraint on `(instance, sequence)`; the implementing issue #1805 pins the exact mechanism). `manage.py audit_verify` recomputes each `record_hash` from `prev_hash ‖ canonical(record)` and reports the first divergence — the OSS integrity self-check. Because immutability + append-only makes it plain that `server_version` is unnecessary here, the record has none. OSS then dispatches `agent_action_recorded.send(...)` **inside the same `transaction.on_commit()`** that commits the underlying write, so the event fires exactly when (and only when) the action durably happened and its chain link is committed.

`verdict` and `refusal_reason` are recorded from day one (RC1): a `requires-approval` verdict is what the OSS single-approver gate (§3, RC4) writes when it holds an agent write, and `refused` distinguishes an `identity` failure (no/invalid actor) from a `policy` failure (actor known, capability or approval denied) so the log answers *why* a write did not happen, not merely *that* it didn't.

**Enterprise registers a receiver on `agent_action_recorded`** at app-ready to: append to its immutable/tamper-evident org audit trail (#146), feed the approval-workflow engine (#147), and evaluate org capability policy (#148). Enterprise reads the frozen `AgentActionEvent`; it never reaches into OSS internals. If no receiver is registered (community edition), the signal dispatches to nobody and OSS runs unchanged — the team-readable log is complete on its own.

**Stability guarantee.** `Actor`, `AgentActionEvent`, the token scope-claim shape, and the `agent_action_recorded` signal name are a **public contract between the two repos**. Adding a field, an `ActorKind`, or a capability scope is additive/non-breaking (Enterprise branches on `schema_version`). Renaming or removing any of them, or changing a field's meaning, is a **major-version breaking change** for Enterprise customers (CLAUDE.md boundary rule 3) and must bump `schema_version` and be documented in `packages/api/CHANGELOG.md`.

### 2. Signed-Answer / Answer-Provenance extension point (#1065)

#### 2.1 The stamp envelope

Every *computed* API/MCP response (a schedule result, a forecast, a velocity figure, a Monte-Carlo distribution — anything the engine derives rather than echoes from storage) carries a provenance **stamp** so the answer is independently reproducible. The stamp is the stable contract:

```
@dataclass(frozen=True)
class AnswerStamp:
    schema_version: int          # additive-only contract version
    engine_version: str          # trueppm-scheduler package version that produced it
    api_version: str             # API semver that assembled the response
    input_hash: str              # sha256 over the canonical input (§2.2)
    computed_at: datetime        # UTC
    actor: Actor | None          # §1.1 — who/what requested it (agent stamps carry actor)
```

Serialized into computed responses under a reserved `_provenance` key:

```jsonc
{
  "...": "the computed payload",
  "_provenance": {
    "schema_version": 1,
    "engine_version": "0.3.0a1",
    "api_version": "0.3.0-alpha.1",
    "input_hash": "sha256:9f86d0…",
    "computed_at": "2026-06-10T12:00:00Z"
  }
}
```

#### 2.2 What is hashed — the canonical input

`input_hash` is a SHA-256 over a **canonical, deterministic serialization** of the *engine inputs*, not the output:

- For a schedule/CPM result: the task graph, dependency set (type + lag), calendars, constraints, and project start floor — the exact inputs the `trueppm-scheduler` pure function received.
- For a Monte-Carlo result: the above plus the sampling parameters (iteration count, seed, distribution assumptions).

Canonicalization rules (the contract): keys sorted, UUIDs lowercased, timestamps in UTC ISO-8601, floats fixed-precision, no insignificant whitespace (JCS-style). The same inputs hash identically across processes and machines; the same `(engine_version, input_hash)` therefore proves *this engine version, given these exact inputs, produces this answer* — reproducible by re-running the pinned `trueppm-scheduler` version. This rides the engine-as-referee principle (#1062): because the scheduler is a deterministic pure function (architect skill constraint — zero Django deps, data-in/data-out), the stamp is sufficient to reproduce, no replay log required for the OSS guarantee.

The stamping logic lives in a single OSS service helper `stamp_answer(payload, *, engine_inputs, actor=None)` in `apps/provenance/services.py`, so every computed endpoint and the MCP wrapper stamp identically and the canonicalization exists in exactly one place.

#### 2.3 The extension hook

OSS exposes `signed_answer_emitted` — a Django signal carrying the `AnswerStamp` and a reference to the stamped payload:

```
# OSS — apps/provenance/signals.py
signed_answer_emitted = django.dispatch.Signal()   # stable hook
```

OSS itself only *stamps and returns* answers (and records the stamp on the matching `AgentActionEvent`, §1.3). **Enterprise registers a receiver** to persist the stamp + payload into a **compliance evidence archive with retention** and to produce signed-answer **exports** (#152). The cryptographic *signing* (as opposed to hashing) — a tamper-evident signature over the stamp for legal evidence — is the Enterprise value-add; OSS provides the reproducible hash stamp, Enterprise provides the notarized archive. If no receiver is registered, answers are still stamped and reproducible — OSS is fully functional; only the archived/exported evidence is absent.

**Stability guarantee.** `AnswerStamp`, the `_provenance` envelope key/shape, the canonicalization rules, and the `signed_answer_emitted` signal are a public cross-repo contract under the same rule as §1.3: additive-only without a major bump; any change to the canonicalization is a breaking change because it changes every hash Enterprise has archived.

### 3. Non-negotiable boundary invariants

These are stated explicitly because they are the contract, not aspirations:

- **OSS never imports `trueppm_enterprise`.** `grep -r "trueppm_enterprise" packages/` must return zero. Both extension points are signals/registries OSS dispatches to; Enterprise imports OSS, never the reverse.
- **The dependency is one-way: enterprise → core.** Enterprise registers receivers against OSS hooks; OSS has no knowledge of any receiver's existence.
- **OSS must be fully functional without Enterprise.** With no receiver registered: agents can be provisioned and scoped, agent actions are written to a team-readable log, and computed answers are stamped and reproducible. Nothing in the AI team layer requires Enterprise to function.
- **Per-instance integrity self-check (OSS) vs org-scale compliance evidence (Enterprise) — RC1.** OSS gives the team an append-only, member-visible, **hash-chained** record and a `manage.py audit_verify` command to detect tampering on its own instance. External notarization, a cryptographic *signature* over the chain, retention policy, the org-wide cross-instance trail, and directory-attributed identity are Enterprise (#146). The dividing line is *detect* local tampering (OSS) vs *prove* non-tampering to an auditor with retained, notarized evidence (Enterprise) — not "plain log vs tamper-evident log."
- **Single-approver gate (OSS) vs multi-step approval workflow (Enterprise) — RC4.** OSS lets the deterministic engine arbitrate (simulate, compute, stamp) and holds an agent write as `requires-approval` until **one** authorized human approves it — a single-approver human-in-the-loop gate is OSS table-stakes safety (#1312/#1313), the same way 5-role RBAC is OSS and custom roles are Enterprise. **Multi-step approval chains, delegated approval authority, and notification routing/escalation** are the org-governance workflow — Enterprise (#147), registered to extend the OSS gate. Without RC4 an AI-native team could not let an agent write safely and would churn; with it, the safe write path is complete in OSS and Enterprise adds the governance workflow on top.

### 4. OSS non-goals (the two enterprise-check refinements)

These carve-outs are baked into the contract so the boundary is not re-litigated later:

- **Decision/forecast memory is OSS as store + read only (#1059).** OSS stores a team's past decisions/forecasts and reads them back — a team's own record of what it decided and predicted. **Calibration and scoring** of that memory (was the forecast right? adjust future confidence accordingly) is **Enterprise (#149)** — it is cross-sprint/cross-program learning and org-level model tuning. The OSS `signed_answer_emitted` and decision-memory store provide the raw material Enterprise calibrates against; OSS does not score itself.
- **What-if / simulation is OSS as an ephemeral primitive only.** OSS exposes `schedule:simulate` — an in-request, throwaway CPM/Monte-Carlo run that returns a stamped answer and persists nothing. **Persisted, named, comparable, or portfolio-level scenarios** (saving a what-if, naming it, diffing scenarios, cross-program scenario modeling) are **Enterprise**. The line is identical to the existing OSS/Enterprise scenario split: ephemeral compute = OSS; durable scenario as a governed artifact = Enterprise.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: Define `agent-as-actor` + `signed-answer` as stable OSS extension points; Enterprise registers receivers (chosen)** | Preserves the adoption flywheel — AI-native teams are fully functional in OSS; one-way enterprise→core dependency; mirrors the proven ADR-0029/0030 slot/edition pattern at the backend; the boundary is a documented, versioned contract | Two new public cross-repo contracts to maintain; Enterprise must branch on `schema_version`; the canonicalization rules become load-bearing and hard to change later |
| B: Put the whole AI layer in Enterprise | Simplest boundary — no OSS AI surface to maintain | **Rejected.** Breaks the adoption flywheel for AI-native teams: a team that cannot use AI safely without paying never starts the flywheel, and Enterprise never sells. Directly contradicts the adoption-vs-governance line in CLAUDE.md |
| C: No formal extension point — Enterprise forks/reaches into OSS AI code | No contract to design up front | **Rejected.** This is exactly the boundary leakage ADR-0029 was written to prevent ("building enterprise widgets before the extension mechanism is defined guarantees a rewrite"). Every OSS AI refactor becomes a breaking change for paying customers; `grep -r "trueppm_enterprise"` discipline cannot save a fork |
| D: Defer — ship OSS AI features now, formalize the boundary later | Faster to first AI feature | **Rejected.** Moving the boundary after implementation is painful (the explicit lesson of the enterprise-check discipline). The actor model, token claims, audit schema, and stamp envelope are foundational — every downstream AI issue (#1058–#1062, #146–#153) depends on their shape. Defining them late forces a rewrite of both repos |

## Consequences

**Easier:**
- AI-native teams get trust, safety, a readable agent-action audit, local-model support, and reproducible answers entirely within OSS — the adoption surface is complete.
- Enterprise builds its audit trail (#146), approval workflows (#147), agent-role policy (#148), memory calibration (#149), and compliance export (#152) against two documented hooks, with zero OSS-internal coupling.
- Every downstream AI issue (#1058–#1062) designs against a fixed actor + stamp contract instead of inventing its own surface — no per-feature boundary negotiation.
- Provenance is enforced in one place (`stamp_answer`), so the MCP surface (0.6) and the REST surface stamp identically — every fact a client shows remains a first-class, reproducible API fact (the API-first standing contract).

**Harder:**
- Two new public cross-repo contracts must be kept stable. `Actor`, `AgentActionEvent`, the token scope claim, `AnswerStamp`, and the canonicalization rules are now versioned API surface — additive changes are fine, renames/removals/semantic changes are major breaks for Enterprise.
- The canonical-input hashing is load-bearing and effectively immutable once Enterprise archives stamps: changing canonicalization invalidates every archived hash, so it must be right at v1.
- OSS must dispatch the audit and answer-stamp signals at exactly the right transaction point (`on_commit`), and must keep dispatching them even though community-edition has no receiver.

**Risks:**
- A future OSS refactor that changes an event/stamp field without bumping `schema_version` silently breaks Enterprise receivers. Mitigation: the contract dataclasses are frozen and version-stamped; a CI guard asserts `schema_version` bumps when the dataclass changes (mirrors the `SlotId` breaking-change discipline of ADR-0029).
- Scope creep across the OSS/Enterprise line — post-RC1 the risk is no longer "hash-chaining in OSS" (that is now deliberately OSS) but adding the *compliance* layer (external notarization, cryptographic signing, retention policy, org-wide cross-instance trail) or memory *scoring* to the OSS side. Mitigation: the `ai-review` skill (below) enforces the §3/§4 invariants at design time; `enterprise-check` is the backstop.
- The default agent capability vocabulary could be set too permissively (e.g. shipping `schedule:write` by default), undermining the engine-referee split. Mitigation: OSS ships read + simulate by default; a write capability is exercised only through the OSS single-approver gate (RC4), and Enterprise extends that gate into multi-step chains/delegation under org policy.

### Contract migration & versioning

- The two contracts are versioned by their `schema_version` integer and the API/engine semver they reference. Additive changes increment nothing structural; receivers tolerate unknown additive fields by branching on `schema_version`.
- Breaking changes (rename/remove/semantic change, or any canonicalization change) require a major bump and a `packages/api/CHANGELOG.md` entry under a dedicated "Enterprise extension contract" heading, mirroring the ADR-0029 `SlotId` discipline.
- No data migration is implied by this ADR itself — it defines contracts. The implementing OSS issues (#1063, #1065, and the #1805 audit substrate) add their own additive `CreateModel` migrations (`AgentActor`, `AgentAction`); pin any new enums (`ActorKind`, the `verdict` choices) via `ENUM_NAME_OVERRIDES` to avoid the `api:schema-drift` "Removed schemas" regression.

### How `ai-review` enforces this at design time

The `ai-review` skill is the design-time gate for any work touching an AI surface (agent actors, agent writes, computed-answer provenance, agent memory, what-if). It enforces this ADR's contract before code is written, the same way `rbac-check`/`broadcast-check` gate their domains:

- **Boundary check:** does the change keep agent identity, the hash-chained audit hook (per-instance integrity is OSS, RC1), the single-approver gate (RC4), and the stamp envelope on the OSS side of §3, and does any *compliance* behavior (external notarization / signing / retention / org-wide trail), any *multi-step* approval chain/delegation/routing, or any memory scoring / persisted-scenario behavior route to Enterprise (§4)? Flags any OSS code that would import `trueppm_enterprise`, add notarization/signing/retention to the OSS log, or add a multi-approver chain to the OSS gate.
- **Contract-stability check:** does the change alter `Actor`, `AgentActionEvent`, the token scope claim, or `AnswerStamp` without bumping `schema_version`? If so, it is a breaking change for Enterprise — block until versioned and changelog'd.
- **Provenance check:** does every new computed endpoint route through `stamp_answer`, and does every agent write dispatch `agent_action_recorded` inside `on_commit`? A computed answer without a stamp, or an agent write without an audit event, fails the gate.
- **Capability-default check:** does the change grant an agent token a write capability by default rather than through the Enterprise approval gate? Flags any default-permissive scope.

`ai-review` is mandatory for any MR touching `apps/agents/`, `apps/provenance/`, the MCP surface, or any agent-capability permission class, and pairs with `architect` and `threat-model` on agent-write features (an agent acting as an actor crosses a trust boundary).

## Implementation Notes

- **P3M layer:** Programs and Projects / Operations — single-team agent actions and single-project answer provenance. Cross-program agent memory/calibration and org-wide audit/compliance roll upward to Portfolio/Senior-Leadership governance (Enterprise).
- **Affected packages:** `api` (OSS — `apps/agents` actor/token/audit hook, `apps/provenance` stamp service + signal, capability permission classes, read endpoints); `scheduler` (OSS — engine version surfaced for the stamp; pure-function determinism is what makes the hash reproducible); `web`/`mobile` (consumers — read the team-readable log and `_provenance`, separate issues); `trueppm-enterprise` (registers receivers — #146/#147/#148/#149/#152). No `helm` change.
- **Migration required:** Not for this ADR (it defines contracts). The implementing issues (#1063, #1065) add additive `CreateModel` migrations; pin new enums via `ENUM_NAME_OVERRIDES`.
- **API changes:** Yes (in the implementing issues) — agent token scopes extend #601; `GET /projects/{id}/agent-actions/` (team-readable log, Viewer+); computed responses gain the additive `_provenance` envelope. `api-docs` sync required when those land.
- **OSS or Enterprise:** The actor model, capability-scoped token, team-readable audit hook, stamp envelope, and both signals are **OSS** (`trueppm-suite`). The immutable org audit, approval workflows, custom agent roles/policy, memory calibration, and compliance export are **Enterprise** (`trueppm-enterprise`), registered against these hooks. `grep -r "trueppm_enterprise" packages/` stays zero.
- **Breaking-change surface:** `Actor`, `AgentActionEvent`, the token scope claim, `AnswerStamp`, the `_provenance` envelope, the canonicalization rules, and the `agent_action_recorded` / `signed_answer_emitted` signal names are the public cross-repo contract. Document every change in `packages/api/CHANGELOG.md`; treat renames/removals/semantic/canonicalization changes as major.

### Durable Execution

1. **Broker-down behaviour:** The audit hook (`agent_action_recorded`) is dispatched inside the same `transaction.on_commit()` as the underlying write, so it fires exactly when the write durably commits — no separate broker dispatch, no durability gap, for the OSS path. Where an Enterprise receiver does async work (e.g. notarizing into an immutable store), that receiver is responsible for using the transactional-outbox pattern on its own side; OSS makes no synchronous broker call. `signed_answer_emitted` fires synchronously during response assembly (a pure read). **No new OSS async dispatch is introduced by this ADR.**
2. **Drain task:** None new in OSS. The OSS hooks are synchronous signal dispatch on commit. Any Enterprise receiver that enqueues work owns its own drain per ADR-0037.
3. **Orphan window:** N/A for OSS — the audit row and signal are written/dispatched inside the committing transaction's `on_commit`, not as an outbox row, so there is no in-flight-commit race to filter against.
4. **Service layer:** New OSS functions — `record_agent_action(actor, action, ...)` in `apps/agents/services.py` (allocates the per-instance `sequence`, computes `record_hash` over the predecessor's hash, writes the append-only `AgentAction` row, and dispatches `agent_action_recorded` on commit) and `stamp_answer(payload, *, engine_inputs, actor=None)` in `apps/provenance/services.py` (canonicalizes, hashes, stamps, dispatches `signed_answer_emitted`). All computed endpoints and the MCP wrapper go through `stamp_answer`; all agent writes go through `record_agent_action`.
5. **API response on best-effort dispatch:** Synchronous. The team-readable log read is a `200`. Computed responses return their payload with the `_provenance` envelope inline at `200`. Agent writes return their normal status (and, where the underlying write is itself async — e.g. CPM recalc via `enqueue_recalculate` — the existing `202 {"queued": true}` contract is unchanged; the audit event fires on that write's commit).
6. **Outbox cleanup:** N/A for OSS. `AgentAction` rows are **permanent team-readable audit** (like `SprintTaskOutcome`, ADR-0176) — not outbox rows, never purged; purging one would also break the hash chain (RC1), which `audit_verify` would then correctly report as a break. Provenance stamps are returned in-response and not stored by OSS at all (Enterprise's archive owns its own retention, #152).
7. **Idempotency:** The audit write is keyed to the underlying operation's transaction — it commits exactly once with the operation (it is part of the same atomic block + `on_commit`), so it cannot double-write. `stamp_answer` is a pure function of `(engine_version, canonical_input)` — re-stamping identical inputs yields the identical `input_hash`, so it is idempotent by construction.
8. **Dead-letter / failure handling:** If `record_agent_action` fails inside the operation's transaction, the whole operation rolls back (the audit is part of the action's definition of done, matching the un-wrapped membership-snapshot precedent in ADR-0176) — there is no partial "action happened but wasn't audited" state. `stamp_answer` failure fails the computed response (an unstamped computed answer must never be returned). Enterprise receivers that fail handle their own retry/DLQ; a failing Enterprise receiver must not roll back the OSS operation (receivers run after commit, in `on_commit`, isolated from the OSS transaction).

## Tracking

Tracking: OSS extension points #1063 (agent-as-actor) and #1065 (signed-answer / answer-provenance). Enterprise registrations: #146 (immutable audit trail), #147 (approval workflows), #148 (custom agent roles & capability policy), #149 (memory calibration), #152 (compliance evidence export). Related OSS AI issues: #1058–#1062. Extends the slot-registry/edition-detection precedent of ADR-0029 and ADR-0030 to the backend AI surface.
