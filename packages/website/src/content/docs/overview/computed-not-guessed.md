---
title: Computed, not guessed
description: Every date and forecast in TruePPM is calculated by a deterministic engine, with the derivation to show for it. A language model may ask your schedule but never invents your dates.
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

## Why it holds

It is an architectural commitment, not a feature toggle. It holds because of two design
choices TruePPM already makes:

- **The scheduling engine is a separate, deterministic package** ([`trueppm-scheduler`](/features/scheduler/)
  on PyPI) — the same math draws the Gantt, answers the API, and would answer an agent.
- **Every feature is an API fact first.** If a value is computed server-side and reachable
  over the API, an agent can retrieve it and cite it; if it lived only in a chat prompt, the
  agent could only guess at it.

The human stays in the loop: the engine computes, the AI translates and explains, and the
human decides.

:::note[Version status]
The deterministic engine that makes this possible is **shipped today**. The AI-facing surface
is on the roadmap: the read-only [MCP server](/features/mcp-server/) and the first piece of the
provenance graph land with the **0.4 beta**, a natural-language query layer is planned for 0.5,
and safe agent writes (with the engine as referee) for 0.6. Treat the AI capabilities as
forward-looking — the [roadmap](/overview/roadmap/) is the authoritative status.
:::

## Go deeper

- [**AI-native by design**](/architecture/ai-native/) — the full architecture: discoverable
  API, the MCP entry point, the anti-hallucination substrate, provenance, and the OSS vs
  Enterprise line for AI.
- [**Guiding principles**](/overview/principles/) — how this fits with the other three
  commitments.
- [**The Story**](/the-story/) — the same truth, now answerable by an agent, in context.
