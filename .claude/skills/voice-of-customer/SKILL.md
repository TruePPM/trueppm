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

## What this skill produces — read this before using its output

This skill produces **simulated feedback from modeled personas**. It is not user
research. Nobody is asked anything. Every verdict is a language model reasoning from the
composite personas in `.claude/personas.md`, which were themselves written from domain
knowledge rather than from interviews (see that file's "What these personas are — and
are not" section and the grounding tiers).

Three rules follow, and they are not optional:

1. **Every output carries the provenance banner** in Step 2. No exceptions, no
   abbreviating it for a short run, no dropping it because "everyone here knows". The
   banner exists for the reader who is *not* in this conversation — the person reading
   the issue it generated six weeks from now.
2. **Real signal supersedes the panel.** Before convening it, check whether real
   evidence already exists on the question (Step 0). Where it does, it decides, and the
   panel's role shrinks to the residue it does not cover. Never run the panel *against*
   a real report to argue the report away.
3. **The panel never authorizes a shipping decision.** It routes attention and surfaces
   assumptions. Approval is a human decision made with the panel as one input among
   others.

Nothing this skill emits may be quoted outside a VoC context — in an issue, an MR, an
ADR, a roadmap entry, a commit message, or anything user-facing — as though it were
customer feedback. If a persona finding is worth filing as an issue, file it on its
own merits and say plainly that a simulated panel surfaced it.

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

### Step 0 — Check for real signal first

Before spawning a single persona, spend one search establishing whether anyone real has
already spoken on this question. Modeled opinion is the fallback, not the default.

```bash
# Real reports and requests touching this surface
glab issue list --repo trueppm/trueppm --search "<feature keywords>" -P 20

# In-product feedback reports (the "Report a bug" link, #2392) and community threads
glab issue list --repo trueppm/trueppm --label "user-report" -P 20
```

Also read `.claude/persona-calibration.md`. If a prior cycle recorded that a persona
mispredicted this class of question, weight that persona's verdict down and say so in
the panel verdict — a persona with a bad track record on a topic does not get to keep
its full voice on it.

Record the result as one of:

- **Real signal exists and covers the question** — do not convene the panel. Report the
  real evidence and stop. Running a simulation over an answered question manufactures
  false corroboration.
- **Real signal exists and covers part of the question** — state what it says, then run
  the panel scoped to the remainder only. The panel may not contradict the real signal;
  where it does, the real signal wins and the contradiction is logged to
  `.claude/persona-calibration.md` as a miss.
- **No real signal** — run the full panel, and say so explicitly in the banner. This is
  the normal pre-beta case and it is fine; it just has to be stated.

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

You are modeling a composite persona, not reporting what a real person said. Your score
is a predicted adoption likelihood derived from this persona's documented criteria — not
a measurement of sentiment. Do not invent biographical detail, usage history, or events
("last quarter she…") that is not in the persona definition; invented specifics read as
evidence and are the main way this output gets mistaken for research.

Return your response in this exact format and nothing else:

## <PERSONA_NAME>: N/10 [optional 🔴 / 🟡 / 🟢]
"<one-sentence quote in this persona's voice, using their priorities and language>"

→ Suggestion: <single concrete change that would raise this persona's score>

Top concerns: <bullet list of any hard-NOs triggered or evaluation criteria missed>

Falsification: <for each 🔴 you raised, one line naming the real-world observation that
would confirm or refute it — a report, a demo conversation, a usage metric. If you
cannot name one, downgrade the 🔴 to 🟡 and say why.>

Blind spot: <one line — what could a real person in this role tell us that you,
reasoning only from the persona definition above, structurally cannot?>
```

Spawn the sub-agents in P3M layer order so their results arrive in a sensible order:
Janet → Marcus → David → Sarah → Jordan → Alex → Morgan → Priya, followed by any
conditional specialists (Nadia, Omar) when the feature touches their surface. The Agent
tool handles parallelism when calls are issued in a single message.

### Step 2 — Aggregate in main context

Once all sub-agents return, write the panel verdict in the main context. Do not
delegate aggregation — synthesizing across personas is the value-add of this skill.

```
> **Simulated panel — not user research.** Every verdict below is a language model
> reasoning from the composite personas in `.claude/personas.md`. No user was
> interviewed, surveyed, or observed. All personas are currently grounding tier T0
> (modeled, no real-user contact). Scores are predicted adoption likelihood against
> documented criteria, not measured sentiment.
> **Real signal:** <none found | summarize what Step 0 found and note that it supersedes
> the panel wherever they disagree>

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
- 🔴 <any hard-NO triggered> — *would be refuted by:* <the falsification line>
- 🟡 <any concern that lowers the score>
- <cross-persona tensions that the feature ignores or resolves cleanly>

**What this panel could not see**: <synthesize the sub-agents' blind-spot lines into 1–3
open questions that only a real user can answer. Carry these into the architect handoff
as named unknowns, not as solved points.>

**Suggested next step**: proceed / scope down / re-examine assumptions — with a
one-sentence justification. This is a recommendation to a human, not a decision.
```

### Panel-average heuristics (from personas.md, kept here for the synthesis step)

The average routes attention; it authorizes nothing.

- Average < 6: stop and re-read the assumptions before invoking architect — either the
  feature contradicts our documented model of the user, or the model is wrong
- Average 6–7: normal; proceed carrying the 🟡 concerns as named risks
- Average ≥ 8: treat with suspicion, not confidence — a modeled panel agreeing strongly
  with a feature its own authors scoped usually means it is restating the brief back

A single 🔴 blocker outweighs the average in either direction: do not average away a hard
NO, and do not let a high average retire one.

Never carry the average out of the VoC context. It does not belong in an issue title, an
MR description, an ADR, or anything user-facing.

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
- **It does not produce user research, and its output may never be represented as such** — not in an issue, an MR, an ADR, a roadmap entry, or any public document
- **It does not overrule a real user report.** Where real signal exists, the panel is scoped to what the report does not cover, or skipped entirely
- **It does not validate itself.** Whether these personas predict anything is measured by `/voc-audit` against real reports and recorded in `.claude/persona-calibration.md`. A panel's own confidence is not evidence about the panel
