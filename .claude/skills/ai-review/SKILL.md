---
name: ai-review
model: sonnet
description: >
  AI-readiness design gate for TruePPM features. Use after `architect`, paired with
  `enterprise-check`, before implementing any new or changed feature. Verifies that
  every value an AI/MCP client might need is a first-class server fact, that computed
  values are explainable, that agent writes are safe and audited, and that the
  team-level AI capability stays OSS while its org-governance counterpart is filed
  Enterprise. Stops a feature from quietly stranding domain logic where an agent can
  never reach it.
---

# AI Review Skill

You are reviewing a TruePPM feature **at design time** to ensure AI is treated as a
first-class consumer, not an afterthought. This is the design-time enforcement of
CLAUDE.md Principle #1 (**API-first**): if a value isn't a server-side fact, a
headless/MCP/agent client can't see it — and "the AI can't answer that" is a product
gap, not a model limitation.

The strategic frame: TruePPM's durable advantage in the AI era is being the
**deterministic engine of record that agents defer to** — never an LLM guess, computed
server-side, on the user's own box. The OSS core must stay genuinely useful to a team
that *uses* AI (team-level usefulness = adoption); AI *governance* at org scale is the
Enterprise conversion layer. Every feature should deepen the first and respect the
boundary with the second.

## When to use

- After `architect`, before implementation, on any new or changed feature that adds or
  changes a **user-visible value, computed result, or write/mutation**.
- Pair with `enterprise-check` — the AI boundary (below) is an AI-flavored extension of
  the OSS/Enterprise classification.

## When NOT to use

- Pure styling / copy tweaks, dependency bumps, CI config, docs-only changes.
- Changes with no new server-computed value and no new mutation (the AI surface is
  unaffected).

## The five checks

Run all five. Each is PASS / GAP. A GAP is a design change to make **before** coding —
not a follow-up issue.

### 1. API-first / MCP-reachable
- Is every new computed/displayed value a **server-side field or endpoint**, not a
  browser-side derivation? (The #986 audit pattern: read-time aggregates and
  verdict/threshold classifications computed in the client that an MCP adapter can
  never see.)
- Is the value (or should it deliberately *not* be) exposed over **read MCP** (#504 /
  #603)? If a mutation, over **write MCP** (#505 / #604)?
- Smell test: "If a headless client GETs the REST surface, can it reconstruct what the
  web UI shows without re-implementing logic?" If no → GAP.

### 2. Provenance
- For a computed value (date, float, percentile, verdict): can an agent get the **why**
  — the driving constraint / derivation — not just the number? (See the provenance
  graph, #1058.)
- A value an agent can cite is trustworthy; a bare number invites the LLM to
  rationalize it. If the value is decision-grade and has no derivation path → GAP.

### 3. Write safety
- If the feature adds a mutation reachable (now or later) by an agent: is it guarded by
  a **server-side invariant** so an agent write can't create an impossible/illegal
  state (engine-as-referee, #1062; existing scheduling invariants; RBAC; broadcast
  safety)?
- Is the action recorded in the **team-readable, hash-chained audit** with a `verdict`
  (`allowed`/`refused`/`requires-approval`) and, on refusal, an `identity`-vs-`policy`
  reason (agent-as-audited-actor #1063; audit substrate #1805, ADR-0112 §1.3)?
- Silent coercion of a bad write is a GAP — reject with a structured reason and record a
  `refused` audit entry instead.

### 4. Decision memory
- Does this feature produce a **decision** worth remembering — a rebaseline reason, a
  scope change, a retro action, a slip cause, an override?
- If so, does it feed the structured decision/forecast memory store (#1059) so an agent
  reasoning over the plan later has the *why*? An un-captured decision is institutional
  memory lost → GAP (or a deliberate, noted non-goal).

### 5. AI boundary (extends `enterprise-check`)
- Does the **team-level** AI capability stay in OSS (a single team using AI needs it to
  work), while its **org-governance** counterpart is filed in `trueppm-enterprise`?
- Apply the split the way the existing pillars do (ADR-0112, ratified 2026-07-11):
  - team-readable, **hash-chained** audit + per-instance `audit_verify` integrity
    self-check (OSS, RC1) vs externally **notarized / signed / retained**, org-wide
    cross-instance compliance evidence (Enterprise). The line is *detect* local
    tampering (OSS) vs *prove* non-tampering to an auditor (Enterprise) — hash-chaining
    is **not** Enterprise-only.
  - engine referee + **single-approver** human-in-the-loop gate (OSS, RC4) vs
    **multi-step approval chains / delegated authority / notification routing**
    (Enterprise). A one-human-approves-one-write gate is OSS table-stakes safety;
    the workflow engine on top is Enterprise.
  - decision store + read (OSS) vs cross-program calibration/scoring (Enterprise)
  - ephemeral what-if primitive (OSS) vs persisted/named/portfolio scenarios (Enterprise)
  - local-model adapter (OSS) vs org model-governance/egress policy (Enterprise)
  - single-program one-way pull (OSS, ADR-0097) vs org-wide bidirectional hub (Enterprise)
- New OSS capability/extension points that Enterprise will register against (agent
  identity/capability token #1063, signed-answer stamp #1065) follow the ADR-0029/0030
  slot pattern — flag for an ADR if one doesn't exist.

## Output format

State an overall verdict: **AI-ready** or **GAPS FOUND**.

Then a compact table — one row per check, PASS or GAP, and for each GAP the concrete
design change required before implementation:

```
| Check                | Verdict | Required change (GAPs only)                 |
|----------------------|---------|---------------------------------------------|
| 1 API-first/MCP      | GAP     | Move <value> from client derivation to a    |
|                      |         | server field on <serializer>; expose on MCP |
| 2 Provenance         | PASS    |                                             |
| 3 Write safety       | ...     |                                             |
| 4 Decision memory    | ...     |                                             |
| 5 AI boundary        | ...     |                                             |
```

If check 5 surfaces an Enterprise counterpart, name it and confirm it is (or should be)
filed in `trueppm-enterprise` — do not implement the governance half in OSS.

If any check implies an architecture change (new endpoint shape, new extension point,
new audit surface), flag it so `architect` is (re)invoked before implementation.
