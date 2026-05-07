---
name: voice-of-customer
model: sonnet
description: >
  Simulate feedback from TruePPM's six core personas: Project Manager, PMO Director /
  Portfolio Manager, Team Member / Contributor, Resource Manager, Executive Sponsor
  (C-Suite), and Scrum Master / Agile Delivery Lead. Use when evaluating features,
  prioritizing backlog, writing user stories, reviewing UX designs, or testing whether
  a feature resonates with the target market.
---

# Voice of Customer Skill

**Before producing any output, read `.claude/personas.md`** — that file is the single
source of truth for all six persona definitions, P3M layer mappings, feature
resonance rules, and the VoC scoring rubric. Do not use any persona content defined
outside that file.

## How to use this skill

The 6 personas are independent — there is no reason to evaluate them serially. This
skill **delegates each persona to a parallel Sonnet sub-agent** and aggregates the
verdicts in the main context. Same total cost as serial inline evaluation, ~6× faster
wall-time, and the main conversation context stays clean.

### Step 1 — Spawn 6 parallel Sonnet sub-agents

Using the `Agent` tool, in a **single message** with **6 tool calls in parallel**, spawn
one sub-agent per persona. Each sub-agent receives:

- The full persona definition (the relevant section from `.claude/personas.md`)
- The shared rubric and severity tags (the "VoC Scoring Rubric" section)
- The feature or design under review (the user's `$ARGUMENTS`)
- A directive to return its verdict in the exact output format below

Sub-agent prompt template (substitute `<PERSONA_NAME>` and `<FEATURE>`):

```
You are simulating <PERSONA_NAME> reviewing a TruePPM feature. Use ONLY this persona's
goals, pain points, evaluation criteria, and hard NOs. Do not mix personas.

Persona definition:
<paste the persona's full section from .claude/personas.md>

Scoring rubric (use exactly this scale, do not invent ad-hoc criteria):
<paste the VoC Scoring Rubric section from .claude/personas.md>

Feature under review:
<FEATURE>

Return your response in this exact format and nothing else:

## <PERSONA_NAME>: N/10 [optional 🔴 / 🟡 / 🟢]
"<one-sentence quote in this persona's voice, using their priorities and language>"

→ Suggestion: <single concrete change that would raise this persona's score>

Top concerns: <bullet list of any hard-NOs triggered or evaluation criteria missed>
```

Spawn the sub-agents in P3M layer order so their results arrive in a sensible order:
Janet → Marcus → David → Sarah → Alex → Priya. The Agent tool handles parallelism
when calls are issued in a single message.

### Step 2 — Aggregate in main context

Once all six sub-agents return, write the panel verdict in the main context. Do not
delegate aggregation — synthesizing across personas is the value-add of this skill.

```
### Panel Verdict
| Persona | Score | Verdict |
|---|---|---|
| Janet (COO) | N/10 | … |
| Marcus (PMO) | N/10 | … |
| David (Resource Manager) | N/10 | … |
| Sarah (PM) | N/10 | … |
| Alex (Scrum Master) | N/10 | … |
| Priya (Team Member) | N/10 | … |

**Average**: X.X/10 | **OSS/Enterprise signal**: [who loves it most → which P3M layer]

**Key constraints surfaced**:
- 🔴 <any hard-NO triggered>
- 🟡 <any concern that lowers the score>
- <cross-persona tensions that the feature ignores or resolves cleanly>

**Recommendation**: ship / iterate / rethink — with one-sentence justification.
```

### Panel-average heuristics (from personas.md, kept here for the synthesis step)

- Average ≥ 8: ship with confidence
- Average 6–7: ship if no 🔴 blockers; address 🟡 concerns in the same milestone
- Average < 6: rethink scope before invoking architect

A single 🔴 blocker outweighs a high panel average. Do not average away a hard NO.

## Example invocation

```
/voice-of-customer Review the resource conflict heat map feature
```

## When to skip parallelization

Skip the parallel pattern and run serially in main context if **fewer than 3 personas
are relevant** to the feature (e.g., a backend-only refactor that only meaningfully
affects Sarah and Priya). For ≥3 personas, parallel is always faster and not more
expensive.

## What this skill does NOT do

- It does not commit to a build decision — that's the architect's call after VoC + UX design
- It does not generate user stories — use the architect or a dedicated story-writing pass
- It does not weight persona scores by market size or revenue — those are GTM decisions, not product decisions
