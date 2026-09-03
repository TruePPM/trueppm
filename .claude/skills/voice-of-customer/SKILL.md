---
name: voice-of-customer
model: sonnet
description: >
  Simulate feedback from TruePPM's eight core P3M-layer personas: Delivery / Program
  Manager, PMO Director / Portfolio Manager, Team Member / Contributor, Resource Manager,
  Executive Sponsor (C-Suite, conditional), Delivery Lead (Scrum Master / Agile Delivery
  Lead), Product Owner, and AI-Native Technical Operator — plus three conditional
  specialist evaluators (integration/API developer, self-hosting operator, and
  engine-library consumer) and the AI-agent actor constraint. Grounds the panel
  before convening it by searching for real evidence — our own tracker first, then
  external practitioner discourse about the functional category — and records the
  evidence tier it reached. Use when evaluating features, prioritizing backlog, writing
  user stories, reviewing UX designs, or testing whether a feature resonates with the
  target market. For a removal question, use sunset-check instead — this skill scores
  predicted adoption of an addition and cannot answer whether to delete something.
---

# Voice of Customer Skill

**Before producing any output, read `.claude/personas.md`** — that file is the single
source of truth for all eleven persona definitions (eight P3M-layer personas plus three
specialist evaluators), the AI-agent actor note, the target-market ICP, P3M layer
mappings, feature resonance rules, and the VoC scoring rubric. Do not use any persona content defined outside that
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
   evidence already exists on the question (Step 0a). Where it does, it decides, and the
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

The core panel is Personas 1–8 (the P3M-layer human roles), of which **Janet (5) is
itself conditional** — she never opens the product, so include her only for reporting,
forecasting, export, digest-to-leadership, or portfolio-visibility features and omit her
with a one-line note otherwise. Personas 9 (Nadia — integration/API developer), 10 (Omar
— self-hosting operator) and 11 (Bram — engine-library consumer) are **specialist
evaluators** that join **only when the feature touches their surface**: the
API/integration surface for Nadia, the deployment/operations *and pre-install evaluation*
surface for Omar, and the standalone `trueppm-scheduler` package for Bram (see the
specialist-panelist note in the personas file's VoC rubric). The **AI-agent actor** is
never a panel seat; it is a cross-cutting constraint applied to any feature an agent
could reach via the API (check its hard NOs against the change). Add the specialists as
extra parallel sub-agents when relevant; omit them with a one-line note otherwise.

**Out-of-window criteria are N/A, never 🔴.** Several personas name criteria that depend
on a capability with a known future release. Those are marked N/A in the personas file
and are excluded from both the severity tags and the score — the persona is scored only
on what is in scope today. Do not let a known-unmet future capability fire a blocker.

The personas are independent — there is no reason to evaluate them serially. This
skill **delegates each persona to a parallel Sonnet sub-agent** and aggregates the
verdicts in the main context. Same total cost as serial inline evaluation, ~8× faster
wall-time, and the main conversation context stays clean.

### Step 0 — Ground the panel before convening it

Two grounding checks run before a single sub-agent is spawned. Both exist to change the
panel's **inputs**; neither is a caveat to be written up afterwards. A panel reasoning
from an unexamined guess about the data produces a confident recommendation about a world
that does not exist, and the write-up cannot repair that — by then the recommendation is
already made.

#### Step 0a — Establish what evidence already exists

Modeled opinion is the fallback, not the default. Three sources are checked, in ascending
order of cost. Record which of them produced anything — the answer sets the run's
**evidence tier**, which goes in the banner.

**(i) Our own tracker** — has anyone real already spoken on this question?

```bash
# Real reports and requests touching this surface
glab issue list --repo trueppm/trueppm --search "<feature keywords>" -P 20

# In-product feedback reports (the "Report a bug" link, #2392) and community threads
glab issue list --repo trueppm/trueppm --label "user-report" -P 20
```

**(ii) External practitioner evidence** — what do people who do this job for a living say
about this *class* of functionality?

This is the step that keeps the skill honest pre-beta. Our tracker is structurally empty
until a beta lands, so (i) alone returns nothing on every run and the panel proceeds on
pure simulation while the banner reports "no real signal" as though the world had been
searched. Public practitioner discourse about the category is real human speech, and it
costs two or three `WebSearch` calls.

Search the **functional category, never the product** — nobody outside this repo has heard
of TruePPM, so a product-name search returns zero and that zero reads as "no evidence":

- ✅ "do agile teams use facilitated live planning sessions", "collaborative estimation
  tool complaints", "why teams stopped using <category>"
- ❌ "TruePPM workshop mode", "TruePPM reviews"

Where to look, and the known limits. These are recorded in `.claude/personas.md`
("What changed in the 2026-07 revision, and what did not") and are repeated here so that
nobody rediscovers them one wasted search at a time:

- **Reddit and Quora block our crawler.** r/projectmanagement, r/agile, r/scrum and
  r/selfhosted cannot be read directly. Do not spend searches on them.
- **Substitutes that do work**: Hacker News threads, published practitioner surveys (State
  of Agile, Scrum.org, PMI), vendor review sites (G2, Capterra) where a reviewer describes
  their workflow rather than scores it, engineering blogs, and **competitor changelogs and
  deprecation notices** — a competitor removing the same capability is strong evidence and
  is usually a public post.
- **Percentage statistics reaching us through secondary aggregators are directional only.**
  No recommendation may rest on a single such figure.

**(iii) The calibration ledger** — read `.claude/persona-calibration.md`. If a prior cycle
recorded that a persona mispredicted this class of question, weight that persona's verdict
down and say so in the panel verdict. A persona with a bad track record on a topic does not
get to keep its full voice on it.

##### Record the evidence tier

The old binary — "real signal found" or "none found" — collapsed *"we looked in the one
place that is structurally empty pre-beta"* into *"there is no evidence anywhere."* Record
a tier instead, and carry it into the banner:

| Tier | Meaning | Effect on the run |
|---|---|---|
| **E0** | Nothing found in (i) or (ii) | Full panel. State the tier plainly — this is the honest pre-beta position, not a failure |
| **E1** | External category evidence only — practitioners discussing this class of functionality, nobody speaking about TruePPM | Panel runs; E1 findings enter as **established facts** (Step 0b) and the panel may not reason against them |
| **E2** | Our tracker carries a real report bearing on this question | Real signal supersedes the panel — scope the panel to the residue only |
| **E3** | A named real user or a measured behavior answers the question | Do not convene. Report the evidence and stop |

At **E2 or E3** the real signal decides, and the panel may not contradict it; where it
does, the real signal wins and the contradiction is logged to
`.claude/persona-calibration.md` as a miss. Running a simulation over an answered question
manufactures false corroboration.

##### External evidence may not raise a grounding tier

This is the rule that stops E1 from quietly becoming corroboration.

A forum thread, a survey figure, or a competitor's deprecation notice is evidence about
**the category**. It is not a report from a user of this product. It may inform the panel,
and it may be quoted in the write-up with its source. It may **not**:

- raise any persona's grounding tier in `.claude/personas.md`. T0 → T1 requires a real
  report *about TruePPM*, cited, and recorded in `.claude/persona-calibration.md` — that
  ledger is the only place a tier moves;
- be described as corroborating a persona, or as a persona having been "validated";
- be represented outside a VoC context as customer feedback, exactly as the modeled
  verdicts may not be.

Cite it as what it is — *"practitioners on \<source\> describe X"* — never *"our users say
X."* The distinction is the whole reason the tier ladder exists.

#### Step 0b — Name the empirical unknowns, then answer the cheap ones

A panel does not know the shape of the data it is reasoning about unless somebody tells
it. Before spawning, write down the **empirical unknowns** — the facts that, if known,
would change a recommendation — and answer the ones that are cheap.

1. **List the unknowns.** For each, state in one line what recommendation it would move.
   The test is exactly that: *would knowing this change a recommendation?* If the answer
   is no, it does not go on the list. This step is a short grounding pass, not a research
   project, and a panel that turns into one has failed a different way.
2. **Mark each as cheaply answerable or not**, and from which source: the running
   database (one SQL or ORM query), the codebase (a grep, a serializer, a `models.py`),
   telemetry and CI artifacts, or the issue tracker. "Cheap" means minutes, not hours.
3. **Answer the cheap ones and put the answers in front of the panel** — in the same
   brief as the feature, above the persona definitions, as established fact. Facts
   delivered to the panel constrain it; facts discovered after it merely annotate it.
4. **Read `.claude/house-data-profile.md`** — the factual appendix of observed project
   shapes and distributions (row counts, dependency density, status mixes, how much of
   the tree CPM actually touches). It is required pre-reading when it exists. Two
   conditions on using it, both enforced by its own header, which you must read before
   quoting a single number from it: it is a point-in-time measurement and may be stale,
   and it labels which of its facts follow from how the code works — and therefore
   transfer to a real instance — versus which are artifacts of our own demo authoring or
   test debris. Hand the panel only what the file says transfers, and hand it the label
   with the number. If the file is absent, or silent or stale on the question in hand,
   run the query yourself and say which of the three it was — never read its silence as
   a "no".
5. **If a question was answerable and you did not answer it, say so in the write-up** —
   name the question and the query that would have answered it. That is a defect in the
   run, not a caveat on it, and it is reported separately from the things a panel is
   structurally unable to see (Step 2).

Why this is Step 0 and not a closing section: a panel on #2987 produced a clean
"what this panel could not see" list whose top item — the composition of the unscheduled
tasks — was one query and about two minutes away. The answer (95% of unscheduled rows
carry no dependency edges; 82% are CPM-excluded `BACKLOG`) overturned the panel's own
leading recommendation. The list was correct and arrived after it could change anything.

### Step 1 — Spawn 8 parallel Sonnet sub-agents

Using the `Agent` tool, in a **single message** with **8 tool calls in parallel**, spawn
one sub-agent per persona. Each sub-agent receives:

- The full persona definition (the relevant section from `.claude/personas.md`)
- The shared rubric and severity tags (the "VoC Scoring Rubric" section)
- The feature or design under review (the user's `$ARGUMENTS`)
- The **established facts** from Step 0 — the real signal and the answered empirical
  unknowns — presented as given, not as background reading
- A directive to return its verdict in the exact output format below

Sub-agent prompt template (substitute `<PERSONA_NAME>` and `<FEATURE>`):

```
You are simulating <PERSONA_NAME> reviewing a TruePPM feature. Use ONLY this persona's
own section — its goals, pain points, evaluation criteria, hard NOs, N/A criteria,
**Frequency & time budget**, **Routine load** (where present), and **10/10 anchor**. Do not mix personas.

Weigh the time budget as heavily as the criteria. It is the only field describing what
this persona actually *does* all day, and reasoning purely from their stated values
predicts the wrong thing: a persona who spends 30-60 minutes a day maintaining a plan
cares about the cost of that hour even when every criterion they articulate is about
the artifact they hand upward. If your answer would change depending on whether this
persona touches the product for 20 seconds or an hour a day, the budget decides it.

Persona definition:
<paste the persona's full section from .claude/personas.md>

Scoring rubric (use exactly this scale, do not invent ad-hoc criteria):
<paste the VoC Scoring Rubric section from .claude/personas.md>

Feature under review:
<FEATURE>

Established facts (checked before this panel convened — treat these as given; do not
reason against them or restate them as open questions):
<paste the Step 0 findings: the evidence tier and what each source returned, each item
of external practitioner evidence with its source, and each answered empirical unknown
with its answer. Label external evidence as being about the category, not about TruePPM
users — a persona reasoning from it must not treat it as somebody having reviewed this
product. Write "none established" if Step 0 found nothing worth answering.>

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

Falsification: <for each 🔴 and each 🟡 you raised, one line naming the real-world
observation that would confirm or refute it — a report, a demo conversation, a usage
metric. Tag each line with the finding it belongs to, because these lines travel out of
this panel and into the issue that gets filed. A line that names a code check ("falsified
if the serializer already exposes the field") is NOT a falsification line — it predicts
nothing about a user. If you cannot name one for a 🔴, downgrade it to 🟡 and say why; if
you cannot name one for a 🟡, mark it `unscoreable` and say why.>

Blind spot: <one line — what could a real person in this role tell us that you,
reasoning only from the persona definition above, structurally cannot?>
```

Spawn the sub-agents in P3M layer order so their results arrive in a sensible order:
Janet → Marcus → David → Sarah → Jordan → Alex → Theo → Priya, followed by any
conditional specialists (Nadia, Omar, Bram) when the feature touches their surface. The Agent
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
> **Evidence tier:** <E0 | E1 | E2 | E3> — <what each source in Step 0a returned. At E1,
> name the sources and cite them as evidence about the *category*, never as reports from
> TruePPM users. At E2/E3, summarize the real signal and note that it supersedes the panel
> wherever they disagree.>
> **Grounding:** <each empirical unknown Step 0b answered, with its answer and its
> source, as put in front of the panel — or "no unknown identified would have changed a
> recommendation">

### Panel Verdict
| Persona | Score | Verdict |
|---|---|---|
| Janet (Executive Sponsor) † | N/10 | … |
| Marcus (PMO) | N/10 | … |
| David (Resource Manager) | N/10 | … |
| Sarah (Delivery/Program Manager) | N/10 | … |
| Jordan (Product Owner) | N/10 | … |
| Alex (Delivery Lead) | N/10 | … |
| Theo (AI-Native Technical Operator) | N/10 | … |
| Priya (Team Member) | N/10 | … |
| Nadia (API Developer) † | N/10 | … |
| Omar (Self-Hosting Operator) † | N/10 | … |
| Bram (Engine-Library Consumer) † | N/10 | … |

† Conditional. Include Janet only for reporting/forecasting/export/portfolio-visibility
features; Nadia only for an API/integration surface; Omar only for a
deployment/operations or pre-install-evaluation surface; Bram only for the standalone
`trueppm-scheduler` package. Otherwise omit the row with a one-line note.
The AI-agent actor is not scored — apply its hard NOs (personas.md) as a cross-cutting
constraint and surface any violation as a 🔴 in "Key constraints surfaced".

**Average**: X.X/10 | **OSS/Enterprise signal**: [who loves it most → which P3M layer]

**Key constraints surfaced**:
- 🔴 <any hard-NO triggered> — *raised by:* <persona> — *would be refuted by:* <the
  falsification line, copied verbatim from that sub-agent>
- 🟡 <any concern that lowers the score> — *raised by:* <persona> — *would be refuted
  by:* <line, or `unscoreable` and why>
- <cross-persona tensions that the feature ignores or resolves cleanly>

**What this panel could not see**: <synthesize the sub-agents' blind-spot lines into 1–3
open questions that only a real user can answer. Carry these into the architect handoff
as named unknowns, not as solved points. These are the *structurally* unanswerable ones —
if a question here could have been answered by a query, it belongs in the line below and
Step 0b failed.>

**Answerable and unanswered** (Step 0b): <any empirical unknown that was cheap to answer
and was not answered, each with the query that would have answered it — or "none". This
is a defect in the run and is reported as one.>

**Suggested next step**: proceed / scope down / re-examine assumptions — with a
one-sentence justification. This is a recommendation to a human, not a decision.
```

### Step 3 — Carry the falsification lines out of the panel

The falsification line is produced here and consumed a release later, by
`/voc-audit --calibrate`, which can only score a finding that carried one. A line left in
the transcript is a finding that will be graded `unscoreable` — counting *against* the
panel — no matter how right it turned out to be. So the line travels with the finding
wherever the finding goes:

- **To the architect handoff**: each 🔴, with its raising persona and its falsification
  line. Not the score, not the average, not the table.
- **To any issue filed off this panel**: use the `VoC-Finding` issue template
  (`.gitlab/issue_templates/VoC-Finding.md`), which has a required field for the line and
  for the persona that raised it. Filing a panel finding through `Bug.md` or `Feature.md`
  drops both.
- **Nowhere else.** The provenance rules above are unchanged: the finding is filed on its
  own merits, plainly labeled as surfaced by a simulated panel, and the average never
  leaves this context.

**Code verification is not falsification.** "I verified this against `main` at `<sha>`"
proves the defect exists; it does not predict what a user would say, which is the only
thing calibration can score. Both belong in the issue, in separate fields, and they must
never be conflated: verification grounds the finding in the code, while the falsification
line stakes a claim about the world that a later real report can confirm or refute. A
finding whose "falsification line" restates a code check is `unscoreable` — it counts
against the panel, not for it.

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

Note: Jordan (Product Owner) and Alex (Delivery Lead) are most relevant to features
touching backlog management, sprint sovereignty, team health, and the hybrid bridge —
Alex carries the practice-health and team-autonomy lens that the former Morgan (Agile
Coach) persona held before the two were merged. For pure PMO/portfolio features, they can
be omitted from the panel with a note. Theo (AI-native technical operator) is most
relevant to anything touching the MCP/API read surface, provenance, or agent behavior.

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
- **It does not convene on unexamined data.** An empirical unknown that is cheap to
  answer and would move a recommendation gets answered *before* the panel, not listed
  after it (Step 0b)
- **It does not let a falsification line die in the transcript.** Every finding that
  leaves this panel carries its line and the persona that raised it; a finding filed
  without them is `unscoreable` at calibration and counts against the panel
- **It does not treat external category evidence as corroboration.** Practitioner forums,
  survey figures and competitor deprecation notices inform the panel and are cited as
  evidence about the category; they never raise a persona's grounding tier, which moves
  only in `.claude/persona-calibration.md`
- **It does not decide whether to remove something.** Its rubric scores predicted adoption
  of a proposed *addition*, so on "should we delete this?" a low score is ambiguous — it
  cannot separate "removing this would be bad" from "this thing is bad". Use
  `sunset-check`, which inverts the question and carries removal verbs
- **It does not validate itself.** Whether these personas predict anything is measured by `/voc-audit` against real reports and recorded in `.claude/persona-calibration.md`. A panel's own confidence is not evidence about the panel
