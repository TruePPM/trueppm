---
title: Computed, not guessed
description: Every date and forecast in TruePPM is calculated by a deterministic engine, with the derivation to show for it. One capability with four parts — compute, cite, refuse, reproduce — that a language model can query but never corrupt.
documentedFor: "0.4"
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
- **Reproduce** — what an agent read, and the refusals it was handed, are **attributable and
  re-derivable**: each one appends a row to a hash-chained agent-action log recording the
  acting token, the accountable human behind it, the capability used and the verdict — and
  `manage.py audit_verify` re-derives the whole chain on your own instance. What that chain
  covers today is stated precisely [below](#what-the-reproduce-chain-records-today); it is
  narrower than "everything that happens in TruePPM", deliberately.

The arc is the whole point. An agent that can only *compute*, *cite*, *be refused*, and
*reproduce* cannot quietly corrupt the record — it never supplies a number the engine did not
compute, and never commits a change the engine did not allow. The 0.4 beta will close that arc
the strongest way available: the agent surface ships **read-only**, so there is no agent write
to corrupt anything with. The gated write path (0.5 – 0.6) is where the arc has to hold under
mutation, and it is being built against the same rulebook.

### What the reproduce chain records today

Precision here matters more than a bigger claim, because this is the sentence a governance
buyer will test in a demo.

**Recorded.** Every request made with an `mcp:read`-scoped API token — the read the
[MCP server](/features/mcp-server/) performs — appends one row, whether it was allowed or
refused, and so does every rejection of a revoked, expired or deleted token. Each row is
hash-chained to its predecessor, so a removed or altered row breaks the chain that
`audit_verify` recomputes.

**Not recorded.** A human working in the UI is not an agent and is not in this log — that is
[deliberate](/features/agent-oversight/), not a gap. Neither are calls made with a
broadly-scoped legacy token, which is why an agent integration should be given an
`mcp:read`-scoped token and not a general one. Engine feasibility refusals — the cycle and
infeasible-dependency rejections under *Refuse* above — are enforced for every caller but
leave no agent-action row; they join the chain with the gated write surface, when there is a
proposed change worth recording the refusal of.

**Inside the hash, and outside it.** The verdict, the refusal reason, the actor, the
capability, the payload fingerprint and the timestamp are all inside the hashed body. The
finer *constraint code* and the *projected impact* of a refusal ride alongside as a
non-hashed side-car — an
[explicit, documented trade-off](/architecture/decisions/) (ADR-0421) that keeps the chain
format stable while the write-side producers are still being built, and one we would rather
state than let you discover. A signed engine-version and input-hash stamp on each answer is
a separate piece of work and follows at 0.9.

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

:::note[Ships in 0.4]
The deterministic engine behind all four verbs is **shipped today** — CPM, Monte Carlo, and the
feasibility refusal that applies to every caller are all in the current release. The
**AI-facing** surface this page describes is not: on the latest tagged release there is no MCP
server, no agent-action log and no Agents tab, so none of the *reproduce* behavior above is
something you can exercise on it yet. Those parts are merged to `main` and ship with the 0.4
beta. The [roadmap](/overview/roadmap/) is the authoritative shipped-vs-planned status.

- **Compute / cite** — the read-only [MCP server](/features/mcp-server/) and the provenance
  graph (the *cite* derivation) **ship with the 0.4 beta**; both are already merged to `main`.
- **Reproduce** — the Phase-0 agent-action audit foundation (hash-chained record, chain
  verification, an `identity`/`policy` refusal taxonomy) also **ships with the 0.4 beta** and is
  already in `main`; its governing decision, [ADR-0112](/architecture/decisions/), is Accepted.
  Its scope on arrival is the one described above — `mcp:read` calls and identity refusals. A
  signed engine-version + input-hash *answer stamp* follows at 0.9.
- **Refuse** — feasibility refusal is in the engine today and applies to every caller; it
  reaches the agent **write** path in two steps: plan mode at 0.5 (`dry_run` proposals —
  verdict + impact, committing nothing) and the committing write surface at 0.6. Recording
  those engine refusals in the agent-action chain arrives with them.
- The natural-language query layer and local-model adapter are planned for 0.5.
:::

## Where the line falls — OSS vs Enterprise

**The engine's ability to refuse is never Enterprise-gated.** The feasibility checks, RBAC, the
read-only guards, and the agent-action audit chain are all Apache-2.0: the first three apply
identically to every caller, and the chain records agent calls for every self-hoster on the
same terms — a self-hosted team gets the full compute / cite / refuse / reproduce contract with
no paid tier and nothing withheld behind a licence check. The Enterprise overlay is **governance at scale**: signed
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
