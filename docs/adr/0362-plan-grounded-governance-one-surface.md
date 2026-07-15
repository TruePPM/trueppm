# ADR-0362: Plan-Grounded Governance — Governance and Oversight Are One Surface

## Status

Accepted (2026-07-15 — ratified; see **Ratification amendments** below). Originally
Proposed (2026-07-11).

This is a **positioning ADR**: it decides product shape, vocabulary, and the
open-core boundary for the agent-governance surface — not code. It builds on
[ADR-0112](0112-ai-layer-oss-extension-points.md) (Accepted 2026-07-11, RC1–RC5),
consumes the *MCP Implementation Audit & Governed Agent Control Plane Roadmap*
(2026-07-10) and the *TruePPM × Agentic Delivery* exploration thread (2026-07-11)
as inputs, pre-answers that roadmap's **Phase 6 extraction decision gate**, and
constrains three downstream workstreams: the fleet-oversight dashboard design,
the Enterprise compliance-evidence SKU, and every artifact that describes
TruePPM's governance story.

### Ratification amendments (2026-07-15)

Ratified alongside the positioning-update pass (#1997), which applies this ADR's
frame across the README, GitLab description, milestones, docs, and public site. Three
points are recorded explicitly so downstream copy cannot drift from them:

1. **Layer, don't invert — the positioning rule.** TruePPM stays a P3M product and the
   front door people adopt; grounding ("computed, not guessed") is promoted to the named
   through-line and the moat, but it **never displaces the hero** on any surface. The
   grounding-engine spec's "engine, not planner" framing (its §2) is an *internal center
   of gravity*, not public positioning: no surface leads with "grounding engine," and the
   README/description/landing hero stay adoption-first. The compliance/SR 11-7
   ("effective challenge," non-probabilistic) framing lives one scroll down, in docs and
   enterprise/design-partner material — never up-funnel.

2. **The audit/refusal-record foundation is landed — claim it at its correct status.**
   The agent-action audit substrate is in `main` as of the 0.4 beta: `apps/agents/` carries
   the `AgentAction` hash chain (`record_hash = sha256(prev_hash ‖ canonical(record))`),
   `AgentActionChainHead`, `AgentActionCheckpoint`, `audit_verify`, `audit_prune`, a
   per-instance monotonic sequence, and the `AgentActionRefusalReason = IDENTITY | POLICY`
   taxonomy; `record_agent_action` is wired into `authentication.py` (identity) and
   `access/permissions.py` (verdict/policy, refusals included). [ADR-0112](0112-ai-layer-oss-extension-points.md)
   is **Accepted**. Roadmap and docs therefore frame this as a **0.4-landed foundation**,
   and 0.6 as the write path built *on top of* it — not a 0.6 build of the foundation.

3. **Instance #2 is the single open falsification — keep it live.** The general claim
   ("one engine, many faces": grounding engine + compliance-evidence plane + DORA/FSI
   plays) rests on one unproven hypothesis: that the same verdict → refusal → audit path
   grounds a **second, non-scheduling** domain. Tracked as #1998 with the definition of
   done — one concrete DORA or data-residency control expressed as an `Invariant`, run
   through the existing path, refusing-with-derivation and writing a clean `AgentAction`
   entry with no knowledge of tasks/schedules. Until it passes, no surface describes
   TruePPM as a general "grounding engine," and the `Invariant → Verdict` registry is a
   backlog abstraction to prove, not a shipped capability. This item must not be quietly
   retired by the softer "layer" framing — it is the one thing here that is *building*
   rather than naming.

## Context

### What is already decided

Three artifacts, produced within two days of each other, converge on this ADR:

1. **ADR-0112 is ratified.** The agent-as-actor substrate is an accepted contract:
   capability-scoped tokens with intersection delegation semantics (RC5), a
   hash-chained, team-readable, append-only `AgentAction` audit record with
   `audit_verify` chain integrity (RC1, landed on `main` in #1805), and a
   single-approver human-in-the-loop gate in OSS with multi-step chains reserved
   for Enterprise (RC4).

2. **The governed-agent-control-plane roadmap (2026-07-10) sequences six phases
   onto dot releases**: Phase 0 audit substrate (0.4, landed), Phase 1 agent
   identity and delegation (0.5), Phase 2 write-capable MCP with gated mutations
   (0.6 — #505/#604, plan-mode first), Phase 3 approval gates (0.7 — #1312/#1313),
   Phase 4 budgets, quotas, and the stop button (0.8), Phase 5 compliance evidence
   packs (1.0/Enterprise, extending #152), and Phase 6 — a post-GA **decision
   gate** on whether to extract the governance layer as a standalone product.

3. **The agentic-delivery exploration (2026-07-11) reached a priority
   correction (its §8).** The agent execution loop (issue → agent → PR → CI →
   close) is commoditizing fast — Devin, Linear's agent, Factory, and GitHub
   Copilot's cloud agent all ship it — so TruePPM consumes that loop rather than
   competes for it. The durable stack, in order: **(1) the human oversight
   surface** (reporting, visualization, exception views — where humans live once
   agents execute), **(2) the forecast that ingests agent actuals** (a
   probabilistic finish date for a program where agents do a measured share of
   the work — a question no execution tool can answer), **(3) CPM-aware
   dispatch** (real at program level), **(4) the loop itself** (commoditized).

### The gap this ADR closes

Those artifacts treat two conclusions as *adjacent*: the oversight/reporting
layer is the #1 durable asset, and the governance write surface is the
acceptance test for ADR-0112. Left unnamed, that adjacency produces three
predictable drifts:

- The fleet dashboard gets specified as a *reporting feature* — disconnected
  from the audit chain and the verdict vocabulary it should be rendering.
- The governance surface gets specified as *compliance middleware* — RBAC,
  rate limits, and log export, indistinguishable from every behavioral
  AI-governance tool shipping in 2026.
- The Phase 6 gate gets answered ad hoc, under pressure, by whoever is asking
  that quarter.

The synthesis this ADR names: **governance and oversight are not adjacent
features — they are one surface, and TruePPM's is the only one grounded in a
real schedule model.**

### Market forces

The 2026 AI-governance field — policy platforms (Credo AI, Holistic AI) and
agent-observability vendors (LangSmith, Braintrust, Arize) — governs
**behavior**: did the agent follow policy, was the output acceptable, did it
stay in budget. None of them can govern **commitments**, because none of them
has a model of the plan. Symmetrically, the execution-loop products dispatch
off flat backlogs (labels, priority, assignment) — none selects work through a
critical-path engine, and none closes the loop into a probabilistic schedule
forecast. Both gaps are the same gap seen from two sides, and TruePPM's engine
(CPM with four dependency types, calendar-aware lag, Monte Carlo P50/P80/P95,
baselines) sits exactly in it.

There is also a timing hook: delivery organizations in regulated industries are
entering 2026–2027 with EU AI Act human-oversight obligations (Article 14),
model-risk expectations shaped by SR 11-7, and DORA ICT-risk evidence demands —
while their agent adoption is accelerating and their audit artifact for "what
are our agents doing, and who approved it" does not exist.

## Decision

### 1. The positioning, named

**TruePPM is the governance and oversight control plane for agent-assisted
delivery, where the plan is the policy substrate.** Not "PPM with agent
features." Not another agent-governance dashboard. The pitch in one sentence:

> Your coding agents already have an issue tracker. They don't have a chain of
> command. TruePPM is the chain of command — plan-grounded permissions, human
> gates, and auditor-ready evidence for everything your agent fleet does.

The intended buyer for the paid tier is one level above the dev team: PMO,
head of delivery, or transformation office in regulated industries, plus the
model-risk and operational-risk functions that now co-sign agent adoption. The
dev-team motion (agent loop + tracker) is already owned by the execution-loop
vendors; TruePPM does not contest it.

### 2. Commitment governance vs behavioral governance — normative vocabulary

Two terms become normative in every TruePPM artifact (docs, decks, website,
issue descriptions):

- **Behavioral governance** — policy evaluated against *conduct*: output
  toxicity, budget ceilings, tool allowlists, rate limits. What the 2026
  platform and observability vendors own, and will keep owning.
- **Commitment governance** — policy evaluated against *the plan*: is this
  write schedule-feasible, does it violate a baseline or a sprint boundary,
  what is its projected P50/P80 impact, who must approve it, and what evidence
  proves the gate held. Requires a deterministic schedule model; this is
  TruePPM's side of the line.

The line is a survival rule, not a tagline: the moment TruePPM's governance
copy is indistinguishable from a behavioral-governance vendor's, the
positioning has failed. Every artifact keeps it bright.

### 3. One surface, one substrate

Governance (the write side: verdicts, gates, refusals, approvals) and oversight
(the read side: dashboards, forecasts, exception views, drill-downs) are **two
projections of the same substrate**: the deterministic CPM + Monte Carlo engine
and the hash-chained `AgentAction` audit record (ADR-0112 RC1).

Concretely, the coupling is structural, not thematic:

- Every governance verdict (`allowed` / `refused` / `requires-approval`) is an
  audit-chain row — so every oversight view that shows agent activity is a
  *projection of the chain*, drill-down terminating in records `audit_verify`
  can validate.
- The oversight fan chart (P50/P80/P95 forecast conditioned on agent actuals —
  durable asset #2) is the same Monte Carlo engine the refusal gate consults
  for projected schedule impact in plan mode (`dry_run`, #505).
- The refusal explanation ("which constraint fired, what the impact would have
  been") is served by the same derivation surface (`get_schedule_derivation`,
  ADR-0218) that powers the oversight drill-down and the 0.8 auto-narrative.

Design rule that follows: **no oversight view may be specified without naming
the chain/engine queries it projects, and no governance verdict may be added
without specifying how oversight renders it.** A dashboard disconnected from
the chain, or a verdict invisible to the dashboard, is a boundary bug.

### 4. The refusal is the demo; the schedule is the moat

The "refusal moment" — *write rejected: schedule-infeasible, here is the
constraint and the projected impact* — is the smallest demonstration of
commitment governance, and it is **OSS** (the roadmap's load-bearing principle:
the engine's ability to refuse is never enterprise-gated). It must be
experienceable by a solo self-hoster within minutes of connecting an agent,
because it is the wedge that makes the category claim credible.

Refusal-engine v1 is **engine-as-referee (#1062) plus the existing invariant
guards** (graph validation #1665, sprint sovereignty #1313, rollup locks
#1753) — per the 2026-07-10 audit's RC1 finding, no CEL/policy-rule engine
exists in the codebase, and the refusal moment does not wait for one. A
CEL-style rule layer is a separate, explicitly decoupled ADR and workstream;
when it lands, authoring and evaluating rules is OSS, while **curated policy
packs and org-wide policy distribution are Enterprise**.

### 5. The Phase 6 gate is answered: no standalone extraction

The governance roadmap left "extract a standalone governance product?" as a
post-GA decision gate. This ADR answers it now, because the answer constrains
architecture and go-to-market today: **the default is no.** Standalone, the
governance layer is a generic entrant in a crowded behavioral-governance field
with no moat; embedded, it is the reason the paid tier exists. The schedule
engine is what makes the governance defensible — separating them destroys the
differentiation on both sides.

Two qualifications keep this honest:

- The **clean-interface discipline stands** (verdict pipeline, audit chain,
  delegation layer behind interfaces with no P3M semantics leaking in). It is
  good architecture regardless, and it preserves the option at near-zero cost —
  the `packages/mcp` standalone-adapter pattern is the in-house proof the team
  can hold such a boundary.
- The gate's criteria (≥2 design-partner asks for "just the governance part,"
  demonstrable standalone inbound, a stability point) remain as the *burden of
  proof to overturn this default* — not as an open question revisited each
  quarter.

### 6. The open-core split, applied to both halves of the surface

The existing classification test (CLAUDE.md Two-Repo Rule: what one PM/team/
program needs → OSS; cross-program coordination, org policy, compliance
evidence → Enterprise) applies to governance *and* oversight without a new
rule. The split, consolidating ADR-0112 RC1/RC4, the roadmap's delineation
table, and the delivery-loop boundary (ADR-0097 line):

| Surface | Community (Apache 2.0) | Enterprise |
|---|---|---|
| **Delivery loop** | Adapter framework + normalized event contract (extension point), user-scoped single-provider connection, poll-out, CPM-aware `schedule.next_ready` dispatch | Org-wide, admin-configured, bidirectional connectors; central credential vaulting; org policy on which agents write where |
| **Audit** | Full append-only hash-chained `AgentAction` record, team-readable, `audit_verify` integrity CLI, raw JSON export | Notarized/signed chain, retention policy and legal hold, org-wide cross-instance trail, SIEM/CEF streaming |
| **Gates & refusals** | The refusal engine itself (engine-as-referee + invariants), plan-mode `dry_run`, typed mutations, single-approver gate (#1312/#1313) | Multi-step approval chains, delegated authority, notification routing/escalation (#147); curated policy packs |
| **Containment** | Per-agent suspend, instance-wide agent freeze, basic rate limits | Per-agent budgets/quotas per period, anomaly auto-suspend, freeze policies |
| **Oversight** | The team's read on **its own** agents: per-program agent-action views, refusal log, agent-actuals-vs-forecast on the program's own schedule | **Fleet dashboard**: cross-program exception-first views, fleet fan chart (agent actuals vs portfolio forecast), trust/verification panel, drill-down to the chain across programs |
| **Compliance** | Raw audit export | **Evidence packs** — generated, versioned, auditor-ready bundles framed for EU AI Act Art. 14/26 record-keeping, SR 11-7-style model-risk documentation (the deterministic engine as effective challenge), DORA ICT-risk evidence |

Two deliberate choices inside that table:

- **The refusal engine goes OSS**, counterintuitive but correct: the refusal
  moment is the marketing, and it must be reachable by a self-hoster in the
  first session. Monetization lives *around* refusals at org scale — who may
  approve overrides, evidence that gates were enforced, fleet-level visibility.
  This is the GitLab pattern (runners free, compliance frameworks paid) and it
  is already how RC1/RC4 drew the line.
- **Evidence packs are the anchor Enterprise SKU.** A regulated-industry head
  of delivery in late 2026 has an oversight obligation, an examiner, and a
  board question — and no artifact. Evidence packs sell survival-of-an-audit
  while adopting agents: a compliance budget, not a tooling budget. Framing
  discipline holds: "supports your compliance program," never "makes you
  compliant."

Oversight follows the same line as everything else: a team seeing its own
agents is adoption (OSS, and consistent with the team-readable log ADR-0112
already ships); an organization seeing a fleet across programs is governance
(Enterprise). No oversight capability a single program needs is paywalled.

### 7. Guardrails imported, not renegotiated

Three standing constraints from the positioning and privacy work apply to this
surface and are restated here so no downstream spec relitigates them:

- **Agents are governed; people are not surveilled.** Fleet oversight renders
  *agent* actors and their verdicts. Wherever a view would aggregate human
  signals (review-queue depth, reviewer pace), the team-owned, opt-in-upward,
  RBAC-enforced consent model applies (ADR-0104; sprint-sovereignty stance —
  velocity is never auto-exposed as a management gauge). The de-surveillance
  reframe that cleared the third-pillar VoC blocker is a constraint on every
  oversight view this ADR motivates.
- **The brand does not lead with AI.** This positioning is the governance tier
  and the regulated-delivery go-to-market — the deck's third act, the paid-tier
  page, the design-partner conversation. The global hero remains
  anchors-first (*Plan like MS Project. Run like Jira.*); the hybrid/agent
  story stays a scoped section per the third-pillar positioning (v2.1). Every
  claim must be true for an all-human team first.
- **Honest tense.** As of this ADR only the Phase 0 substrate is real on
  `main` (#1805: hash-chained audit, verdict vocabulary, `audit_verify`) plus
  the read-only MCP surface with `whatif` and `get_schedule_derivation`.
  Gated writes land in 0.6, approval gates in 0.7, containment in 0.8,
  evidence packs at 1.0/Enterprise. Public copy follows the version-status
  tense rule against the roadmap page — the credibility claim leads with the
  shipped substrate and roadmaps the rest.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: One surface — plan-grounded governance + oversight as the product, embedded in TruePPM (chosen)** | Names the moat (only governance grounded in a schedule model); Phase 6 answered; dashboard and gate work reinforce each other structurally; evidence packs get a defensible anchor | Demands discipline: every governance artifact must stay plan-grounded, every oversight view chain-grounded; positioning must be kept coherent with the team-level third-pillar doc |
| B: Extract a standalone governance product (Phase 6 "yes") | Bigger nominal TAM; rides the 2026 AI-governance wave | **Rejected.** Standalone = generic behavioral-governance entrant against funded incumbents, minus the engine that makes it different; destroys the paid tier's reason to exist inside TruePPM |
| C: "PPM with agent features" framing | Lowest effort; no new category claim | **Rejected.** Feature-list framing concedes the category to the platform vendors and reduces the audit chain, gates, and fleet views to checkbox parity items |
| D: Compete on behavioral governance (budgets, output policy, observability parity) | Buyers already have line items for it | **Rejected.** The platform and observability vendors own behavior; TruePPM cannot out-instrument them and does not need to — commitments are the uncontested ground |
| E: Defer positioning until the 0.6 write surface ships | Decide with more information | **Rejected.** The positioning constrains what to build *now* — the dashboard spec, refusal telemetry, design-partner recruiting, the deck. Deferring repeats the mistake ADR-0029 exists to prevent: building the widgets before the frame is defined |

## Consequences

**Easier:**
- The Phase 6 question stops consuming decision energy; the clean-interface
  discipline continues for architectural reasons with the strategic default
  settled.
- The fleet-oversight dashboard can be specified precisely: a projection of
  (schedule state × audit chain), composed almost entirely from existing
  assets — canvas Gantt, Monte Carlo fan chart, derivation drill-down, the
  `AgentAction` chain. It is a composition exercise, not a platform build.
- Dogfooding compounds: instrumenting every refusal during the OSS build-out
  (poll-out adapter, event seam, CPM dispatcher) produces both scheduling-engine
  bug reports and the demo reel for the paid tier.
- Evidence-pack design partners can be recruited against a named category and a
  shipped substrate, before Phase 5 is built — validating the compliance
  artifact against a real auditor's requirements list instead of speccing it in
  a vacuum.

**Harder:**
- Two positioning documents must stay coherent: the third-pillar doc (team-level
  hybrid scheduling, adoption tier) and this one (org-level governance tier).
  The division of labor: third pillar sells the team on honest hybrid planning;
  this ADR sells the org on the chain of command above it.
- Every future governance/oversight issue carries a boundary test at *two*
  layers now: OSS-vs-Enterprise and commitment-vs-behavioral.

**Risks:**
- **Timing.** Evidence-pack demand may be 6–12 months early — enforcement
  timelines slip and much regulated-industry agent adoption is pilot-stage.
  Mitigation: design partners now, GA push later; every phase stands alone as
  product value if the compliance wedge is late (the roadmap's own slip
  posture).
- **The platform land grab.** Model vendors and observability players all want
  agent governance at the platform layer. Defense = differentiation: they own
  behavioral governance, TruePPM owns commitment governance. The §2 vocabulary
  is the tripwire — copy that stops mentioning the plan has crossed the line.
- **AI-washing perception.** Mitigation is the honest-tense guardrail (§7) and
  leading with the verifiable substrate (#1805 is real, `audit_verify` runs on
  any self-hosted box).
- **Surveillance drift.** A fleet dashboard that quietly starts aggregating
  human throughput re-creates the blocker the third-pillar VoC killed.
  Mitigation: the ADR-0104 consent model is a stated constraint on every
  oversight view, including Enterprise ones — consent re-applies at each
  aggregation level.

## Implementation Notes

- **P3M layer:** Spans deliberately — team agent operations (Programs and
  Projects / Operations, OSS) up to Portfolio / Senior-Leadership governance
  (Enterprise). The split in §6 is the layer boundary.
- **Affected packages:** None directly — this ADR changes no code. It
  constrains: the Phase 2/3 specs (#505/#604, #1312/#1313), the fleet-oversight
  dashboard design (issue to be filed; see follow-ups), the Enterprise
  evidence-pack SKU (extends #152), the delivery-loop adapter ADR (to be
  drafted per the agentic-delivery thread), and website/deck copy when the
  governance tier goes public.
- **Migration required:** No.
- **API changes:** No.
- **OSS or Enterprise:** The ADR lives in the OSS repo (it defines the
  boundary); the work it constrains lands on both sides per §6.
- **Follow-ups (sequenced):**
  1. Fleet-oversight dashboard design note (`/ux-design` + dataviz pass):
     OSS per-program agent panel + Enterprise cross-program fleet view, each
     view annotated with the chain/engine queries it projects (§3 design rule).
  2. Instrument refusals from day one of dogfooding the OSS delivery loop
     (poll-out GitLab adapter → event seam → `schedule.next_ready`), so refusal
     telemetry accumulates as both bug reports and demo material.
  3. Recruit 2–3 regulated-industry design partners for evidence packs against
     a real auditor requirements list, before Phase 5 build.
  4. Keep the CEL/policy-rule ADR decoupled from the 0.6 write surface (per the
     2026-07-10 roadmap's immediate actions) — the refusal moment ships on
     engine-as-referee alone.

### Durable Execution

<!-- Positioning ADR — no code, no async work. Answers are N/A by construction. -->
1. **Broker-down behaviour:** N/A — no dispatch introduced; this ADR changes no runtime behavior.
2. **Drain task:** N/A — no async work introduced.
3. **Orphan window:** N/A — no outbox.
4. **Service layer:** N/A — no new service functions; the constrained workstreams carry their own ADRs (ADR-0112 already pins `record_agent_action` / `stamp_answer`).
5. **API response on best-effort dispatch:** N/A — no endpoints.
6. **Outbox cleanup:** N/A — no outbox.
7. **Idempotency:** N/A — no operations.
8. **Dead-letter / failure handling:** N/A — no failure modes introduced.

## Tracking

Builds on: ADR-0112 (agent-as-actor, RC1–RC5), ADR-0097 (user-scoped
external-source line), ADR-0157 (workspace audit + enterprise signing seam),
ADR-0186 (read-only MCP), ADR-0218 (derivation surface), ADR-0104 (team-signal
privacy/consent), ADR-0361 (chain-aware audit pruning). Inputs: *MCP
Implementation Audit & Governed Agent Control Plane Roadmap* (2026-07-10),
*TruePPM × Agentic Delivery* thread (2026-07-11, §8 priority correction),
*Third Pillar* positioning v2.1 (2026-07-11). Constrained issues: #505/#604
(gated writes), #1312/#1313 (approval gate), #1062 (engine-as-referee), #1063
(agent-as-actor), #1065 (signed answers), #152/#146–#148 (Enterprise
registrations), #1805 (Phase 0 substrate, landed). New issues to file: fleet-
oversight dashboard (OSS panel + Enterprise fleet view), refusal-telemetry
instrumentation, evidence-pack design-partner program, delivery-loop adapter
framework ADR.
