---
name: voice-of-customer
model: sonnet
description: >
  Simulate feedback from TruePPM's eight core P3M-layer personas: Project Manager, PMO
  Director / Portfolio Manager, Team Member / Contributor, Resource Manager, Executive
  Sponsor (C-Suite), Scrum Master / Agile Delivery Lead, Product Owner, and Agile Coach /
  Transformation Lead — plus two conditional specialist evaluators (integration/API
  developer and self-hosting operator) and the AI-agent actor constraint. Use when
  evaluating features, prioritizing backlog, writing user stories, reviewing UX designs,
  or testing whether a feature resonates with the target market.
---

# Voice of Customer Skill

**Before producing any output, read `.claude/personas.md`** — that file is the single
source of truth for all ten persona definitions (eight P3M-layer personas plus two
specialist evaluators), the AI-agent actor note, P3M layer mappings, feature resonance
rules, and the VoC scoring rubric. Do not use any persona content defined outside that
file.

## How to use this skill

The core panel is Personas 1–8 (the P3M-layer human roles). Personas 9 (Nadia —
integration/API developer) and 10 (Omar — self-hosting operator) are **specialist
evaluators** that join the panel **only when the feature touches their surface** — the
API/integration surface for Nadia, the deployment/operations surface for Omar (see the
specialist-panelist note in the personas file's VoC rubric). The **AI-agent actor** is
never a panel seat; it is a cross-cutting constraint applied to any feature an agent
could reach via the API (check its hard NOs against the change). Add the specialists as
extra parallel sub-agents when relevant; omit them with a one-line note when the feature
is neither API- nor ops-facing.

The personas are independent — there is no reason to evaluate them serially. This
skill **delegates each persona to a parallel Sonnet sub-agent** and aggregates the
verdicts in the main context. Same total cost as serial inline evaluation, ~8× faster
wall-time, and the main conversation context stays clean.

### Step 1 — Spawn 8 parallel Sonnet sub-agents

Using the `Agent` tool, in a **single message** with **8 tool calls in parallel**, spawn
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
Janet → Marcus → David → Sarah → Jordan → Alex → Morgan → Priya, followed by any
conditional specialists (Nadia, Omar) when the feature touches their surface. The Agent
tool handles parallelism when calls are issued in a single message.

### Step 2 — Aggregate in main context

Once all sub-agents return, write the panel verdict in the main context. Do not
delegate aggregation — synthesizing across personas is the value-add of this skill.

```
### Panel Verdict
| Persona | Score | Verdict |
|---|---|---|
| Janet (COO) | N/10 | … |
| Marcus (PMO) | N/10 | … |
| David (Resource Manager) | N/10 | … |
| Sarah (PM) | N/10 | … |
| Jordan (Product Owner) | N/10 | … |
| Alex (Scrum Master) | N/10 | … |
| Morgan (Agile Coach) | N/10 | … |
| Priya (Team Member) | N/10 | … |
| Nadia (API Developer) † | N/10 | … |
| Omar (Self-Hosting Operator) † | N/10 | … |

† Include only when the feature touches the API/integration surface (Nadia) or the
deployment/operations surface (Omar); otherwise omit the row with a one-line note.
The AI-agent actor is not scored — apply its hard NOs (personas.md) as a cross-cutting
constraint and surface any violation as a 🔴 in "Key constraints surfaced".

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

Note: Jordan (Product Owner) and Morgan (Agile Coach) are most relevant to features
touching backlog management, sprint sovereignty, team health, and the hybrid bridge.
For pure PMO/portfolio features, they can be omitted from the panel with a note.

Note: Nadia (integration/API developer) and Omar (self-hosting operator) are the
inverse — omitted by default, *added* only when the feature touches their surface. Add
Nadia for any new/changed endpoint, webhook, token scope, OpenAPI schema, or
agent-as-actor behavior; add Omar for any Helm-values, migration, health-probe,
observability, backup/restore, sizing, or dead-letter change. For every feature an agent
could reach via the API, also apply the AI-agent actor hard NOs as a cross-cutting
constraint (personas.md) — it is checked, not scored.

## What this skill does NOT do

- It does not commit to a build decision — that's the architect's call after VoC + UX design
- It does not generate user stories — use the architect or a dedicated story-writing pass
- It does not weight persona scores by market size or revenue — those are GTM decisions, not product decisions
