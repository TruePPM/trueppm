# ADR-0913: "Seed from a brief" is local-only and non-egressing, and ships behind the agent-write gate

## Status

Accepted (2026-08-28)

Closes the design question in issue #2720. Constrains a future endpoint and the
Start-sheet way-in card that would call it; no endpoint ships with this ADR.

## Context

The Start sheet (#2728) offers peer ways into a new project — same size, same row,
no way privileged over another. A fourth was drafted for the Project Designer v5
handoff: **Seed from a brief**, captioned *"Describe the work; the plan API drafts a
skeleton you edit. Same endpoint agents use."*

It was cut before it shipped, and the reason it was cut is the reason this ADR
exists: **the card did not say where the text goes.** For a self-hosted,
air-gap-capable product, plan data leaving the instance is a hard NO, and silence
is not compliance. A self-hoster reading that caption cannot tell whether typing an
unreleased product roadmap into the box emits an outbound request. There is no
sentence on the card, no setting to inspect, and no endpoint to read the source of.

Two questions were open, and both have to be answered for the card to be shippable:

1. **Where does the brief go?** Parsed on the instance, or sent to a hosted model?
2. **Does an agent-writable authoring endpoint ship before or after the agent audit
   record and the agent-write off-switch?**

What exists today, verified against the tree:

- `packages/api/src/trueppm_api/apps/agents/` implements the ADR-0112 RC1
  hash-chained `AgentAction` record — but for the **read** surface only.
  `AgentActorKind`'s docstring scopes it to *"token acting on the MCP read
  surface"*, and `RefusalConstraint` carries values explicitly *"reserved for the
  0.6 gated-write producers (ADR-0362 §7)"*.
- `TRUEPPM_MCP_ENABLED` ([ADR-0497](0497-mcp-administration-controls.md)) is the
  operator's off-switch for agent **reads**.
- There is **no agent write path**, and therefore no agent-write off-switch.

So the ordering question is not hypothetical. An authoring endpoint whose own
caption advertises *"same endpoint agents use"* would be the first agent-writable
surface on the instance, landing ahead of both the verdict record that would log an
agent's writes and the switch that would stop them.

**P3M layer:** Programs and Projects — a planner drafting the skeleton of their own
project on their own instance.

## Decision

**1. Local and heuristic. Zero egress.**
When the endpoint ships it parses the brief **in-process** and returns a task
skeleton. No model call, no outbound request, no host to configure, no credential to
store. The setting whose off state a self-hoster would otherwise have to trust does
not exist, because the on state does not exist.

**2. The card says so, in those terms.**
The way-in card and the endpoint's OpenAPI description state that the brief is
parsed on this instance and nothing leaves it. A privacy posture a reader has to
infer from the *absence* of a setting is the same silence that got the card cut —
the fix is a sentence, not a missing knob.

**3. This is a decision about this endpoint, not a ban on local models.**
[ADR-0112](0112-ai-layer-oss-extension-points.md) keeps a BYO-local-model adapter
(#1061) inside OSS scope, and this ADR does not repeal that. It says the
seed-from-a-brief **way-in** is not the surface that introduces model inference, and
must not become one by drift: routing this endpoint through a model — local or
otherwise — requires a new ADR, not a settings change and not a follow-up MR.

**4. Ordering: after the write gate, never before it.**
Because the endpoint is agent-writable by its own description, it ships **no earlier
than** the 0.6 gated-write surface — the agent-write verdict producers whose
`RefusalConstraint` values [ADR-0362](0362-plan-grounded-governance-one-surface.md)
§7 already reserves, and an agent-**write** off-switch that is to writes what
`TRUEPPM_MCP_ENABLED` is to reads. Shipping an agent-writable authoring endpoint
ahead of them is precisely the ordering the AI-actor hard NO exists to prevent.

**5. Until then the card stays cut, not disabled.**
Three ways in, not four with one greyed out. A way-in card that dead-ends is worse
than one that is absent — a disabled card advertises a capability and then refuses
to explain itself, which is a worse version of the problem that cut it.
`StartWayCards.test.tsx` keeps pinning the fourth card's absence.

**6. The endpoint returns a proposal; it never persists on its own.**
The response body is a drafted skeleton. Persistence happens on the caller's own
subsequent bulk write, under the caller's own role. This matters concretely: a
drafted skeleton that includes dependency edges hits `task_bulk`'s second, higher
permission floor (edges are checked per-edge at `IsProjectScheduler`, see #3037), so
a Member seeding from a brief gets rows and not edges. Returning a proposal rather
than writing one keeps that refusal on the write, where the caller can already see
it, instead of inventing a second authoring path with its own floor.

**7. The brief is bounded on the way in and the draft is bounded on the way out.**
An in-process synchronous parse of untrusted free text inside the request cycle is a
CPU-bound path with a user-controlled input size. The endpoint declares a maximum
brief length and a maximum drafted-row count, both refusals rather than truncations
— a silently truncated brief is a plan with rows missing and nothing saying so.
Without these, "no egress" is satisfied and the endpoint is still a denial-of-service
surface reachable by any authenticated Member.

**8. Zero egress is enforced, not merely asserted.**
`apps/integrations/http` is the single request-cycle egress chokepoint
([ADR-0049](0049-external-integration-extension-points.md) §3,
[ADR-0590](0590-egress-allowlist-for-trusted-internal-hosts.md)). The seed module
must not import it, and a test asserts that it does not. An ADR that claims no
outbound request with nothing checking the claim is the same shape as the card that
claimed nothing at all — the failure this issue was filed about.

**9. The brief text never reaches a log line or a refusal body.**
Brief text is confidential plan data by assumption — that assumption is the whole
reason for decision 1. A parse failure reports *what* was wrong structurally and
never echoes the input, and no log statement in the parse path takes the brief as an
argument. Otherwise the text a self-hoster was promised would not leave the instance
leaves it in the log shipper instead.

**10. When the endpoint becomes agent-reachable, it emits a verdict row.**
Decision 4 orders this endpoint after the agent-write gate. The obligation that
ordering exists to create is stated here so it is not lost in the sequencing: an
agent-initiated seed writes an `AgentAction` row with a verdict, like any other
agent write. Being an authoring *draft* rather than a commit does not exempt it —
the draft is the point at which an agent's intent enters the plan.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Local / heuristic, zero egress** (chosen) | One sentence fully describes the data path. No setting, no credential, no off-state contract to honor. Nothing to misconfigure into a leak. No interaction with the [ADR-0590](0590-egress-allowlist-for-trusted-internal-hosts.md) egress chokepoint. Ships in an air-gapped install unchanged. | A heuristic parse drafts a weaker skeleton than a model would. |
| **B. Pluggable endpoint, self-hosted default, disable-able with zero egress** | A better draft where an operator has a model to point at. Matches ADR-0112's BYO-local-model direction. | Every self-hoster now has to *verify* the off state rather than read one sentence. Adds a URL setting, a credential, a threat-model surface for outbound plan text, and an interaction with the SSRF egress guard. The default being safe does not help the operator who inherits a configured instance. Correct eventually; wrong as the thing a **way-in card** depends on. |
| **C. Ship the card disabled, with a "coming in 0.X" tooltip** | Preserves the four-peer-ways layout the designer drew. | A dead-end card is the failure this issue reports, dressed as progress. Rejected in #2720 on its own terms. |
| **D. Leave undecided; card stays cut indefinitely** | Zero work. | The question then gets re-answered by whoever next reads the design handoff, with no record of why the card is missing — which is how it comes back with a hosted-model call attached. |

## Consequences

**Easier**
- The card's copy can be written, because there is a true sentence to write.
- No new setting, no credential storage, no off-state contract, no egress-guard
  interaction. The [ADR-0590](0590-egress-allowlist-for-trusted-internal-hosts.md)
  chokepoint is untouched.
- The feature is air-gap-safe by construction rather than by configuration.

**Harder**
- The drafted skeleton is weaker than a model's. This is the accepted trade: an
  honest weaker draft the planner edits beats a better one whose data path a
  self-hoster cannot verify. The skeleton is a *starting outline*, not an answer —
  the planner edits it either way.
- The card is blocked on 0.6 work, so the Start sheet carries three ways for longer
  than the design handoff shows.

**Risks**
- *"Local heuristic" erodes into "configurable model URL"* by a well-meaning MR.
  Mitigated by decision 3 — that change needs a new ADR — and by this ADR being
  named from the source that implements the card, so `check-adr-status.sh` keeps the
  citation live.
- *The zero-egress claim decays into folklore.* Prose in an ADR is not a control.
  Decision 8 makes it a test, so the claim fails loudly rather than quietly becoming
  untrue during a refactor by someone who never read this file.
- *The ordering constraint binds a 0.4/0.5 surface to a 0.6 dependency.* That is the
  intent, and it is written down here rather than left in a handoff document so the
  card is not re-added by someone reading only the design.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `web` (card copy and the docstrings that record the cut); `api`
  when the endpoint itself ships
- Migration required: no
- API changes: none in this ADR — it constrains a future endpoint
- OSS or Enterprise: **OSS**. A planner drafting their own project's outline on
  their own instance is squarely the adoption surface; nothing here aggregates
  across programs or governs anyone else's agents.

### Durable Execution

1. **Broker-down behaviour:** N/A — no code ships with this ADR. When the endpoint
   lands it is a synchronous in-process parse with no async side effects: a draft the
   caller then edits has nothing to queue, so there is no dispatch to lose.
2. **Drain task:** N/A — no async dispatch, so no drain.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** when the endpoint ships, the skeleton it drafts is persisted
   through the existing bulk task write path (`apps/projects/task_bulk.py`), and any
   resulting recompute goes through `scheduling/services.py::enqueue_recalculate()`
   — never `recalculate_schedule.delay()`.
5. **API response on best-effort dispatch:** N/A — synchronous. The endpoint returns
   the drafted skeleton in the response body; there is nothing queued to report.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** the draft is a pure function of the brief text and the parser
   version. Calling it twice returns the same skeleton and persists nothing on its
   own; persistence happens on the caller's subsequent bulk write, whose idempotency
   is ADR-0772's (client-minted ids, `id_unavailable` / `tombstoned` guards).
8. **Dead-letter / failure handling:** N/A — a synchronous parse either returns a
   skeleton or a 4xx. An unparseable brief is a refusal to the caller, not a
   retryable job.
