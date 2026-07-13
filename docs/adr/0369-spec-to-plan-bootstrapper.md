# ADR-0369: Spec-to-Plan Bootstrapper — One Governed Draft Substrate, Pluggable Dissectors (OSS)

## Status
Proposed

## Context

### The problem
Starting a project from a written specification is a cold-start grind: someone reads a
spec and hand-builds the backlog (epics + issues) and an initial plan before work can
begin. We can compress that with an LLM that dissects the spec into a draft backlog, asks
a few planning questions (team size, velocity, quality gates), and produces a first-cut,
sprint-flexible plan — one humans and, later, AI agents execute together.

This is the concrete realization of **ADR-0362 (Plan-Grounded Governance — Proposed)**:
"spec → plan → agent execution" as the governance surface. It is the first user-facing
feature to exercise the ADR-0112 agent substrate end-to-end.

### The core decision: substrate, not pipeline
The load-bearing insight (validated by a Voice-of-Customer comparison of three
architectures — see below) is that **the governed write substrate is the product, and
the "dissector" that turns a spec into draft items is a pluggable front-end.** We define
one substrate and two interchangeable adapters onto it:

- **Substrate (the invariant):** a `PlanDraft` aggregate — generated epics/issues +
  spec→work-item provenance + a coverage/reconciliation view + a draft schedule + a
  velocity-based release forecast — that the **team grooms** and a **configurable single
  approver (defaulting to the team)** promotes into a real single Project/Program via the
  existing seed importer. The promoted result is a **sprint-flexible backlog, not a
  locked CPM schedule**.
- **Adapter (a): web-upload dissector** — the operator configures an **in-boundary,
  self-hostable, EU-pinnable** bring-your-own-LLM endpoint (no external fallback); a user
  uploads a spec in the web UI; the server's LLM populates the draft with human-authored
  writes. **Depends on nothing unbuilt → near-term (0.5).**
- **Adapter (b): client-agent dissector** — the user's own MCP-connected agent holds the
  spec, dissects it off-server, and populates the draft via a **narrow new
  `mcp:write:draft` capability scope** (per-project, draft-only, never touches the live
  schedule, independently revocable). The agent can **request** promotion but a human
  approver performs it — never self-promote. **Depends on a small MCP-write scope →
  0.5-stretch / 0.6.**

Both doors land the same PlanDraft, so neither is throwaway.

### P3M layer
**Programs and Projects (OSS).** One team bootstrapping one project/program. It does not
aggregate across programs or roll up to Portfolio — that is the Enterprise upscale,
out of scope here.

### Boundary (settled by two enterprise-check passes)
**OSS, single-program.** The C-prime refinements *strengthen* the OSS case. The
governance line and its four load-bearing invariants:

1. **`mcp:write:draft` is OSS-default-grantable because a draft-write is NOT a durable
   write.** A PlanDraft has zero effect on the live schedule until a human promotes it —
   its blast radius equals `schedule:simulate` (an OSS default). This holds **only if
   enforced in code, not convention** (🔴 #1): the scope reaches PlanDraft rows only;
   drafts fire **no live side-effects** (no schedule recompute, broadcast, or
   notification) until promotion; promotion is the sole durable write and stays **human
   single-approver**. "Silent until promotion" is load-bearing for the classification,
   not just UX.
2. **In-boundary BYO-LLM is OSS** — the ADR-0187 bring-your-own-IdP pattern applied to
   models: the operator points TruePPM at their *own* endpoint; TruePPM ships the adapter,
   not the model. Gating it is a "model tax" like the SSO tax.
3. **The audit records a *team-readable* provenance record** (input-hash + model/endpoint/
   version per item), **not** an externally-attestable compliance evidence pack. The
   attestable/immutable-audit SKU is Enterprise (🔴 #3 — keep the wording honest).
4. **Single approver only.** A second approver / segregation-of-duties / multi-step chain
   is Enterprise (🔴 #4 — the OSS ADR must forbid a chain).

Enterprise extension points registered on top (must NOT be built in OSS): org-wide AI/
model policy; cross-program spec intake / portfolio plan generation; multi-step approval
workflows / SoD; the executive always-on no-login digest across drafts; cross-program
provenance/compliance rollup + attestation pack; org-locked approver policy.

### VoC trail (three panels)
- **Panel 1** (original server-upload framing, 10 personas, avg 4.1) surfaced the
  "AI imposes a plan the PM approves" flaw (Morgan/Alex/Jordan 🔴) and the BYO-LLM ops
  burden (Omar 🔴).
- **Panel 2** (A server-upload vs B client-agent vs C substrate, 8 differentiating
  personas): **C won, avg 6.6** — but carried two 🔴s that were *sequencing/residency*,
  not architecture: Sarah (no door in an agent-first ship) and Marcus (spec leaving his
  boundary via an ungoverned client agent).
- **Panel 3** (C-prime, full 10-persona panel): **avg 6.0 overall, 7.8 with the target
  audience** (Jordan 8, Alex 7, Morgan 8, Priya 8, Nadia 9, Omar 7). **Every actionable
  🔴 cleared**: Marcus's residency NO gone (in-boundary EU-pinnable adapter), Priya's
  notification NO gone (silent-until-promotion + digest), Sarah's "no door" NO gone
  (web door is co-equal, near-term). The only remaining 🔴s are the *documented*
  release-window NOs (David pre-0.5 allocation, Sarah pre-0.4 mobile) — expected by
  design, not rescope signals.

C-prime's actionable 🟡s are folded into the Decision below.

## Decision

Build a new OSS Django app, **`planbootstrap`**, holding the `PlanDraft` substrate, with
two dissector adapters and the co-drafting constraints the panel required.

### 1. Substrate — new app, three models
A dedicated `planbootstrap` app (not bloating the ~5,900-line `projects/models.py`).

- **`PlanDraft`** — plain `models.Model` (UUID PK), not `VersionedModel` (a web-authoring
  artifact, no mobile-offline requirement — matches `VelocitySuggestion`/`AgentAction`).
  Holds: nullable `program` scope; `source_spec_text` + `source_spec_hash` (idempotency);
  persisted elicitation inputs (`team_size`, `team_velocity_per_day`, `quality_gates`);
  generation provenance (`generating_model`, `_version`, `generation_payload_hash`);
  `draft_schedule` (advisory forecast snapshot); a `status` state machine; review/approve/
  promote actor+timestamp columns; `promoted_program` (OneToOne, SET_NULL).
- **`PlanDraftItem`** — one row per generated item (not a JSON blob), mirroring the
  `BacklogItem` promotion pattern: `item_type` (reuse `BacklogItemType`), `title`,
  `description`, `story_points`, `confidence`, `order`, and
  `promoted_task = OneToOneField(Task, on_delete=SET_NULL)` set on promotion.
- **`SpecProvenance`** — traceability edge, polymorphic via `object_type`/`object_id`
  (the repo convention — no `GenericForeignKey`): `span_start`/`span_end` (+ denormalized
  `span_excerpt`), `generating_model[_version]`, `confidence`.

`PlanDraftStatus`: `DRAFTING → GENERATING → GENERATED → REVIEW → APPROVED / REJECTED / FAILED`.

**Extension-point stability (🔴 #2):** the `PlanDraft` status/forecast serializer and the
`SpecProvenance` serializer are declared **stable ADR-0029/0030 slots** from day one —
Enterprise registers cross-program rollup + attestation against them, so their shape is a
compatibility contract. Decide the shape now.

### 2. Co-drafting constraints (Morgan/Alex/Priya)
- The draft forms in **`REVIEW`** as a **proposal to the team**. For the agent adapter,
  the agent proposes items **turn-by-turn over the existing WebSocket board channel** and
  the team shapes them *as they form*.
- That channel is **hard-walled to team+approver** — PMO/exec see only the promoted
  Project/Tasks after approval, never the in-progress draft stream.
- **Zero notifications until promotion.** On promotion, a **single, default-off,
  user-channel-selectable digest** ("5 tasks added — synced to Jira") — never per-item
  pings. Generated items flow through the normal Jira sync; "My Tasks" strips CPM/WBS
  vocabulary.
- **Configurable approver defaults to the team** for team-scoped drafts. Changing the
  approver *off* the team default **notifies the team** (Morgan's guardrail). No path lets
  an org mandate this as the only way to plan.

### 3. Velocity → forecast (Jordan/Alex)
Elicited `team_velocity_per_day` + `team_size` **seed** a velocity-based release forecast
(reusing `compute_team_velocity_per_day()` / `get_release_forecast`). The seed is
**superseded by the rolling computed velocity** once the project runs and is
auto-reconciled after each sprint close — it is never frozen as "the" velocity (closes
Alex's "manual velocity" concern).

### 4. Adapter (a) — web-upload dissector (near-term, 0.5)
- **BYO-LLM config**: a workspace singleton `LlmProviderSettings` (templated on
  `WorkspaceEmailSettings`): `api_base_url` (SSRF-validated), `model_name`,
  `api_key_ciphertext` (Fernet via shared `encrypt_secret`), `timeout_seconds`, `enabled`,
  rotate-or-keep write semantics. In-boundary / EU-pinnable, no external fallback.
  Surfaced as documented Helm values. Feature disabled until configured (ADR-0187 pattern).
- **BYO-LLM credential model (supported auth paths)**: because a *server* makes the
  outbound call, the supported credentials are an **Anthropic API key**, **Amazon Bedrock**
  (AWS IAM), **Google Vertex AI** (GCP ADC), or any **OpenAI-compatible local/self-hosted
  endpoint** (e.g. a local OSS model — the true zero-egress option). A **Claude.ai
  consumer subscription (Pro/Max/Team) is NOT a usable credential** for a headless server
  and must not be offered as a config option — there is no supported programmatic path for
  it, and it would violate the consumer terms. `LlmProviderSettings` docs must state this
  explicitly so an implementer doesn't design a subscription field that can't exist. The
  **subscription-friendly path is adapter (b)** — see §5.
- **Flow**: `POST /plan-drafts/` (spec) → `PlanDraft(status=GENERATING)` + outbox row;
  async LLM call (modeled on `integrations.external_sync`) writes `PlanDraftItem`s +
  `SpecProvenance` + `draft_schedule`, sets `GENERATED`; permanent failure → `FAILED`.
- **Go-live kill-switch (Omar 🔴, made a mechanism not a promise)**:
  `webUpload.enabled: false` by default; a startup/CI check **refuses to enable it** unless
  the ops package is present — dead-letter view + Prometheus metrics/alert rules for the
  LLM queue + liveness/readiness probes for the ingestion worker + a documented sizing
  worksheet + a tested backup/restore for the new tables.

### 5. Adapter (b) — client-agent dissector (0.5-stretch / 0.6)
- A new **`mcp:write:draft`** capability scope on `ApiToken`: per-project, **draft-rows-
  only**, independently revocable. Write-capable MCP tools (`create_plan_draft`,
  `add_plan_draft_items`, `attach_spec_provenance`, `request_plan_promotion`). The agent
  acts as its own token-scoped actor; every call mints an `AgentAction` (hash-chained).
- **Non-durability enforced in code (🔴 #1)**: a permission class restricts the scope to
  PlanDraft tables; a guard guarantees no schedule recompute / broadcast / notification
  fires from a draft write. The agent sets a "promotion requested"
  (`verdict=REQUIRES_APPROVAL`) flag; a **human** promotes via normal RBAC.
- **This deliberately does not need the 0.7 durable-write gate** — promotion is a human
  action, so the agent door's only real dependency is the `mcp:write:draft` scope + write
  tooling, not the full ADR-0112 approval machinery.
- **Subscription-friendly by construction**: the LLM runs in the user's *own* MCP client
  (Claude Desktop / Claude Code, authenticated by their Pro/Max subscription), so TruePPM
  holds **no model credential at all** and bears no inference cost. This is the path for
  users who want to use a Claude subscription rather than an API key — the server-upload
  adapter (§4) cannot use a subscription, this door needs none.

### 5a. Discoverability — MCP prompt + next-step affordances

The client-agent door is a *sequence* (`create_plan_draft → add_plan_draft_items →
attach_spec_provenance → request_plan_promotion`). Four layered mechanisms mean neither the
user nor the agent has to remember it — weakest-to-strongest guarantee:

1. **An MCP prompt as the front door** — a server-defined `bootstrap_plan_from_spec`
   **prompt** (an MCP protocol primitive distinct from tools/resources; FastMCP
   `@server.prompt()`). MCP prompts surface in clients (e.g. Claude Desktop) as
   **user-selectable, slash-command-like entries** — the user *picks* the workflow instead
   of remembering a tool name, and it hands the agent the full ordered sequence in one go.
   This is the direct "don't forget the command" answer. (Note: an MCP **prompt** ships
   *with the server* and works for any MCP client; an Anthropic **Agent Skill** is a
   client-side Claude-only concept and is not part of MCP — the prompt is the right layer.)
2. **`SERVER_INSTRUCTIONS`** — TruePPM's MCP server already carries one (today "read-only by
   design"); extend it to describe the draft-write workflow so it is in the agent's context
   from the first turn.
3. **Next-step hints in every tool result** — builds on the inline-"why" pattern
   (ADR-0368): `create_plan_draft` returns *"draft created — next call
   `add_plan_draft_items`."* The server *states* the next command rather than hoping the
   agent recalls it.
4. **State-machine rejection (strongest guard)** — the `PlanDraftStatus` machine lets the
   server **refuse out-of-order calls with a named next step**: `request_plan_promotion` on
   an item-less draft → `refused: draft has no items; call add_plan_draft_items first`.
   "Forgot a step" becomes an impossible-to-miss, self-correcting error — and it doubles as
   the ADR-0112 `verdict=REFUSED` audit entry already required.

Tool descriptions are additionally **prescriptive about *when* to call** (per Anthropic tool
guidance: recent models reach for tools conservatively, so trigger conditions in the
description give measurable lift).

### 6. Promotion (shared by both adapters)
On approve, `projects/seed/importer.py::import_seed(payload, owner=…)` runs in one
transaction — Program/Project + Tasks (in `BACKLOG` status) + Sprints seeded from the
elicited velocity, `seed/reldates.py` resolving durations to dates. `promoted_program` /
`promoted_task` record the promotion. `enqueue_recalculate(project_id)` fires once
(the msproject/jira bulk-import precedent). Output is a **groomable, sprint-flexible
backlog**; `draft_schedule` is advisory only.

### 7. API surface (Nadia)
- REST endpoints (session/JWT + RBAC) in the **versioned OpenAPI from day one**, with
  documented error shapes, **rate-limit/throttle headers**, an `Idempotency-Key` on
  ingest, pagination on generated items, and a written deprecation policy for the
  draft-write tool surface.
- Read surfaces (`get_plan_draft`, `list_plan_drafts`, `get_plan_draft_coverage`) via
  `McpReadableViewMixin` + `mcp:read`.
- The `bootstrap_plan_from_spec` **MCP prompt** (§5a) plus the four `mcp:write:draft`
  tools; both ship with the client-agent adapter increment.
- A **durable signed webhook** (`plan_draft.generated`, `draft.updated`,
  `promotion.requested`, `promotion.completed`) with a dead-letter queue, *alongside* the
  WebSocket, so a fire-and-forget CI bot needn't hold a socket.

## Alternatives Considered

| Option | Verdict | Why |
|--------|---------|-----|
| **A. Server-side upload only** | Rejected as sole shape | VoC avg 4.75, zero champions; not API-first; risks being throwaway once MCP writes land; owns the whole BYO-LLM ops burden upfront |
| **B. Client-agent (R/W MCP) only** | Rejected as sole shape | VoC avg 4.88 but **two 🔴** — Sarah (no door without an agent) and Marcus (spec egress to an ungoverned client agent); strands non-agent users |
| **C. Substrate + pluggable dissectors, agent-first** | Superseded by C-prime | VoC avg 6.6 but inherited B's Sarah + Marcus 🔴s because it deferred the web door |
| **C-prime. Substrate + two co-equal adapters + co-drafting (chosen)** | **Chosen** | VoC 6.0/7.8-target, **zero unexpected 🔴**; both doors on one substrate; in-boundary LLM is the compliance path (not throwaway); web door has no unbuilt dependency → ships 0.5 |
| Agent writes straight to live Tasks (no draft) | Rejected | Loses provenance/coverage/idempotency; auto-commits AI output; resurrects Morgan/Priya 🔴s |
| Bespoke approval gate now (skip phasing) | Rejected | Forks the ADR-0112/#1312 gate the platform is standardizing; risks an OSS approval-workflow engine (Enterprise-line violation) |

## Consequences

**Easier**: cold-start collapses to review-and-groom; first real exercise of the ADR-0112
write substrate; BYO-LLM config becomes reusable; the in-boundary adapter is a permanent
compliance-grade path (not a stopgap).

**Harder / new surface**: a new external-call failure domain in adapter (a) — gated behind
the ops kill-switch; a new `mcp:write:draft` scope to secure (needs `rbac-check` +
`security-review`); the spec-egress question for adapter (b) (needs `threat-model`).

**Risks**: LLM drops/hallucinates a requirement → mitigated by the coverage/reconciliation
view + per-item confidence + mandatory human grooming (never auto-promote). Re-ingest
duplication → `(program, source_spec_hash)` correlation + `promoted_program` OneToOne.
Boundary creep (Janet's exec digest, Marcus's cross-program rollup) → both are Enterprise;
OSS exposes only the per-draft facts as stable slots.

## Implementation Notes
- **P3M layer**: Programs and Projects (OSS).
- **Affected packages**: `api` (new `planbootstrap` app; `LlmProviderSettings`; seed-importer
  reuse; `mcp:write:draft` scope), `web` (upload wizard, review/groom UI, co-drafting view,
  `WorkspaceLlmPage` admin), `mcp` (3 read tools + 4 draft-write tools + the
  `bootstrap_plan_from_spec` prompt + `SERVER_INSTRUCTIONS` + next-step hints), `helm`
  (BYO-LLM values, sizing, kill-switch flag), `scheduler` (no engine change). `mobile`: none
  initially.
- **Migration required**: yes — new app, 3 models + `LlmProviderSettings`. Additive,
  reversible, no destructive ops.
- **API changes**: yes — REST + 3 MCP read + 4 MCP draft-write tools + webhooks; versioned
  OpenAPI regenerated.
- **OSS or Enterprise**: **OSS** (`trueppm-suite`). Enterprise counterparts filed separately
  (see Context).

### Roadmap / milestones

**Target: 0.5.** 0.4 is shipping and is **not** a target for this feature. The MVP is
scoped so its entire critical path rides *already-built* primitives (seed importer,
`external_sync` outbox, `WorkspaceEmailSettings` config, `AgentAction` audit) with
human-RBAC promotion — so it has **no dependency on the 0.7 durable-write gate** and can
start clean at the top of 0.5.

| Increment | Milestone | Gating dependency |
|---|---|---|
| Substrate (`PlanDraft`/`PlanDraftItem`/`SpecProvenance`) + provenance/coverage + team grooming + promotion via `import_seed` + **web-upload adapter** + ops kill-switch | **0.5 (MVP)** | None unbuilt |
| Client-agent adapter — `mcp:write:draft` scope + 4 draft-write tools + `bootstrap_plan_from_spec` MCP prompt + next-step hints + co-drafting | **0.5-stretch / 0.6** | A *narrow* MCP-write scope only — **not** the 0.7 gate (promotion stays human) |
| Retro→next-draft auto-seeding; Enterprise exec-digest + cross-program rollup (register against the OSS ADR-0029/0030 slots) | **0.6+ / Enterprise** | — |

**0.5 workstream — issues to file (each carries its own gate chain):**

| # | Issue (file into the 0.5 milestone) | Gate chain before MR |
|---|---|---|
| 1 | `planbootstrap` app: `PlanDraft`/`PlanDraftItem`/`SpecProvenance` models + migrations | `data-model` → `migration-check` → `test-scaffold` |
| 2 | `LlmProviderSettings` config + `WorkspaceLlmPage` admin (BYO-LLM, credential-model docs) | `security-review` (SSRF/secret) → `rbac-check` → `docs` → `test-scaffold` |
| 3 | Web-upload ingestion: `POST /plan-drafts/` + outbox + drain + dead-letter (ADR-0084) | `perf-check` → `security-review` → `broadcast-check` → `test-scaffold` |
| 4 | Coverage/reconciliation view + velocity→forecast seed | `test-scaffold` (unit + API) |
| 5 | Review/groom UI + team-default approver setting + silent-until-promotion digest | `ux-design` → `ux-review` → `test-scaffold` (+ Playwright) |
| 6 | Promotion via `import_seed` + `AgentAction` audit on generation/promotion | `regression-check` → `broadcast-check` → `test-scaffold` |
| 7 | Ops package + `webUpload.enabled` kill-switch (probes, metrics, sizing, backup/restore) | `devops` → `docs` |

**0.5-stretch / 0.6 workstream** (file now, tag for the later milestone): `mcp:write:draft`
scope + permission class (non-durability guard) · the 4 draft-write MCP tools · the
`bootstrap_plan_from_spec` prompt + `SERVER_INSTRUCTIONS` + next-step hints · co-drafting
over the WebSocket channel · the `plan_draft.*` webhooks. Gate chain: `rbac-check` +
`security-review` (the scope) → `threat-model` (spec egress) → `ai-review` → `test-scaffold`.

**Design gates run now, in parallel with 0.4** (they precede code, so they don't move the
0.5 milestone — they let 0.5 start without a design phase): the four boundary 🔴 invariants,
`ai-review`, `rbac-check` + `security-review` (on `mcp:write:draft`), `threat-model` (spec
egress).

### Durable Execution
1. **Broker-down**: transactional outbox — a `PlanDraftGenerationRequest` row (shape from
   `ExternalSyncRequest`: PENDING/DISPATCHED/DONE/DEAD, `celery_task_id`, `last_error`,
   partial-unique one-PENDING-per-draft) written atomically with `status=GENERATING`;
   best-effort `.delay()`; drain re-dispatches. (Adapter (a) only; adapter (b) writes are
   synchronous DRF and need no outbox.)
2. **Drain task**: new `planbootstrap.drain_generation_queue`, Beat 30 s,
   `@idempotent_task(on_contention="skip")`; #1693 split-update pattern.
3. **Orphan window**: 5 min PENDING pickup; ~15 min DISPATCHED-reclaim (LLM calls are slow).
4. **Service layer**: new `planbootstrap/services.py::enqueue_plan_generation(draft_id)`;
   promotion via `import_seed()`; recalculation via `enqueue_recalculate()`.
5. **API response on best-effort dispatch**: `202 {"queued": true, "plan_draft_id": "…"}`;
   clients poll `GET /plan-drafts/{id}/` or subscribe to `plan_draft.generated`.
6. **Outbox cleanup**: nightly `_do_purge` of DONE/DEAD rows, 7-day retention.
7. **Idempotency**: `@idempotent_task(lock_key_template="plan_generation:{0}")`;
   `(program, source_spec_hash)` correlation coalesces re-ingest; the task check-and-sets
   on `status==GENERATING`; promotion guarded by the `promoted_program` OneToOne.
8. **Dead-letter**: permanent (malformed/oversized spec, model auth failure → `FAILED`,
   no retry) vs transient (timeout/429/5xx → DEAD, drain re-enqueues to a retry limit).
   On exhaustion `record_failed_task()` → `celery_task_permanently_failed` → the ADR-0084
   dead-letter receiver → Omar's alert. `FAILED` is human-actionable on the draft.

## Open questions / follow-ups to file before coding
1. **Approver default & change-notification** — new project setting; default = team;
   changing it off-team notifies the team. One-line `/ux-design` confirmation.
2. **`LlmProviderSettings` scope** — admin-wide singleton (chosen, OIDC/email precedent)
   vs per-user (`IntegrationCredential`, ADR-0097). Confirm; also the home for `#1061`
   BYO-local-model adapter.
3. **Decision memory (#1059)** — feed elicitation answers + de-scoped requirements to the
   decision store, or note as an explicit 0.5 non-goal.
4. **Extension-point shape** — freeze the `PlanDraft` status/forecast + `SpecProvenance`
   serializer shapes (ADR-0029/0030) before Enterprise builds against them.
5. **MCP prompt args** — settle the `bootstrap_plan_from_spec` prompt's parameters (spec
   text/file, target program, elicitation defaults) and the next-step-hint copy during
   `ai-review` of the agent-write path.
