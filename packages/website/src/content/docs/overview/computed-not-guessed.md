---
title: Computed, not guessed
description: Every date and forecast in TruePPM is calculated by a deterministic engine, with the derivation to show for it. One capability with four parts — compute, cite, refuse, reproduce — that a language model can query but never corrupt.
---

> Every date and forecast is calculated by the engine, with the derivation to show for it; a
> language model may *ask* your schedule but never *invents* your dates.

This is the one principle TruePPM states positively rather than as a line against something —
because it is the architectural commitment the other three rest on.

## The stance

Every incumbent is bolting a language model onto a project database and letting the model
guess dates. TruePPM takes the opposite stance: an AI-surfaced answer is never the model's
opinion — it is a CPM or Monte Carlo computation the engine performed, carrying a server-side
derivation you can cite. The model's only job is to translate a question into an engine call
and to phrase the engine's answer back in natural language. It never supplies the number.

```
Incumbent — the LLM is the answer:

    question ─▶ LLM ─▶ asserted answer
                       (a plausible guess; no derivation to check)


TruePPM — the engine is the answer: "computed, not guessed"

    question ─▶ NL layer ─▶ engine call ─▶ provenance-carrying answer
                (translates   (CPM / Monte    ("P80 is Oct 22, derived from
                 to a call)    Carlo computes)  this critical chain" — citable)
```

## Compute, cite, refuse, reproduce

"Computed, not guessed" is one capability with four parts — the contract every AI-facing
surface honors, described with the same four verbs everywhere so it reads as one capability,
not a scattered feature list:

- **Compute** — an AI client gets an answer the engine *calculated* (critical path, a P80
  date, a non-mutating what-if), never a number the model made up.
- **Cite** — every computed value carries a server-side **derivation** the agent quotes
  instead of asserting: *"P80 is Oct 22, derived from this critical chain."*
- **Refuse** — the engine rejects any change that would violate the plan's own rules — an
  impossible dependency, a cycle, a broken rollup — and it refuses **identically for a human
  and an agent**. There is one rulebook, not a softer one for automation.
- **Reproduce** — every answer and every refusal is **attributable and re-derivable**: the
  agent-action record captures the actor, the verdict, and the engine version behind each
  decision in a hash-chained, tamper-evident log you can replay.

The arc is the whole point. An agent that can only *compute*, *cite*, *be refused*, and
*reproduce* cannot quietly corrupt the record — it never supplies a number the engine did not
compute, and never commits a change the engine did not allow.

## Why it holds

It is an architectural commitment, not a feature toggle. It holds because of three design
choices TruePPM already makes:

- **The scheduling engine is a separate, deterministic package** ([`trueppm-scheduler`](/features/scheduler/)
  on PyPI) — the same math draws the Gantt, answers the API, and answers an agent.
- **Every feature is an API fact first.** If a value is computed server-side and reachable
  over the API, an agent can retrieve it and cite it; if it lived only in a chat prompt, the
  agent could only guess at it.
- **Refusal is enforced in the engine, for every caller.** Feasibility, RBAC, and the
  read-only guards sit below the API, so a human write and an agent write hit the same checks —
  the refusal is not a policy bolted onto the agent, it is a property of the record.

The human stays in the loop: the engine computes, the AI translates and explains, and the
human decides.

:::note[Version status]
The deterministic engine behind all four verbs is **shipped today**. The AI-facing surface
arrives across releases, and the [roadmap](/overview/roadmap/) is the authoritative
shipped-vs-planned status:

- **Compute / cite** — the read-only [MCP server](/features/mcp-server/) and the provenance
  graph (the *cite* derivation) **land with the 0.4 beta**; both are already merged to `main`.
- **Reproduce** — the Phase-0 agent-action audit foundation (hash-chained record, chain
  verification, an `identity`/`policy` refusal taxonomy) also **lands with the 0.4 beta** and
  is already in `main`; its governing decision, [ADR-0112](/architecture/decisions/), is
  Accepted. A signed engine-version + input-hash *answer stamp* follows at 0.9.
- **Refuse** — feasibility refusal is in the engine today and applies to every caller; it
  reaches the agent **write** path in two steps: plan mode at 0.5 (`dry_run` proposals —
  verdict + impact, committing nothing) and the committing write surface at 0.6.
- The natural-language query layer and local-model adapter are planned for 0.5.
:::

## Where the line falls — OSS vs Enterprise

**The engine's ability to refuse is never Enterprise-gated.** The feasibility checks, RBAC,
the read-only guards, and the agent-action audit chain are all Apache-2.0 and apply identically
to every caller — a self-hosted team gets the full compute / cite / refuse / reproduce contract
with no paid tier. The Enterprise overlay is **governance at scale**: signed
compliance-evidence bundles, retention and legal hold, cross-team approval chains, and org
policy — the things an organization adds *on top of* an already-grounded practice, never the
grounding itself.

## For the compliance-minded evaluator

Two ideas live here, one scroll down, because they matter to a governance buyer and would only
distract the practitioner who just wants a schedule:

- **This is not a probabilistic guardrail.** The market's default answer to "can I trust an
  agent against my system of record" is an LLM-as-judge that *scores* plausibility — "the
  guardrail model was 94% confident." That is not defensible to an auditor. TruePPM's refusal
  is **non-probabilistic**: it computes the correct answer from a formal model and refuses
  violations with certainty plus a derivation. In model-risk terms (SR 11-7), the deterministic
  engine is an *effective challenge* to probabilistic agent behavior.
- **One pipeline, many rule domains — a hypothesis, not yet a claim.** Today the engine grounds
  exactly one domain: scheduling feasibility. Whether the *same* verdict / refusal / audit path
  can ground a **second** domain — a budget cliff, a DORA control, a data-residency rule —
  behind a domain-agnostic `Invariant → Verdict` registry is a **backlog item to prove** (the
  instance-#2 experiment on the [roadmap](/overview/roadmap/)), not a shipped capability. We
  name it so the roadmap stays honest, and we will not describe TruePPM as a general "grounding
  engine" until that test passes.

## Go deeper

- [**AI-native by design**](/architecture/ai-native/) — the full architecture: discoverable
  API, the MCP entry point, the anti-hallucination substrate, provenance, and the OSS vs
  Enterprise line for AI.
- [**Guiding principles**](/overview/principles/) — how this fits with the other three
  commitments.
- [**The Story**](/the-story/) — the same truth, now answerable by an agent, in context.
