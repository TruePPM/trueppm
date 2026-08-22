# TruePPM — Core Personas

Single source of truth for all eleven TruePPM user personas — eight P3M-layer human
personas (1–8) plus three adoption-critical specialist evaluators (9–11) — and the
AI-agent actor note. Skills and CLAUDE.md reference this file — do not duplicate
persona content elsewhere.

Personas 1–8 are the P3M-layer human roles who *use* TruePPM to run work; they form
the standard `/voc` panel. Personas 9 (integration/API developer), 10 (self-hosting
operator), and 11 (engine-library consumer) are **specialist evaluators**: they do not
sit on a P3M layer, they gate *adoption* — no org runs more than one tool without
Nadia's integration passing, OSS adoption begins with Omar's `helm install`, and the
standalone engine is the cheapest proof a skeptic can run. They join the panel
**conditionally**, only when a feature touches their surface. The **AI-agent actor
note** at the end is not a persona at all — it is a user *class* (an agent acting via
the API) whose hard NOs `/voc` and `/ai-review` apply as a cross-cutting constraint.

## What these personas are — and are not

**These are modeled personas, not research subjects.** Every persona below was written
from domain knowledge of the P3M market, competitor pain points, and practitioner
literature. None was derived from an interview, a survey, a usability session, or a
support ticket from a named individual. Sarah, Marcus, Priya and the rest are composite
hypotheses about who this product is for.

That makes them genuinely useful and genuinely limited, and the two must not be
confused:

- **Useful** — they force a feature to be argued from a specific point of view instead
  of the builder's own, they surface cross-persona tensions early, and they are
  available before a single user exists. For a pre-launch product this is the best
  available proxy.
- **Limited** — a panel of modeled personas can only return the assumptions already
  encoded here. It cannot discover a need nobody thought of, it cannot be surprised,
  and it will never tell you that the whole premise is wrong. Its agreement is not
  evidence; it is consistency with our own priors.

**The standing rule: real signal always supersedes modeled signal.** Where a real user
report, support conversation, or usage measurement exists on a question, it decides —
the panel does not get a vote against it. The panel governs only the space where no
real signal exists yet, and that space is meant to shrink every release.

### The internal-consistency test — a persona must value what it does

A modeled persona fails in a way a real interview subject cannot: its stated **behavior**
and its stated **values** can describe two different people, and nothing in the document
notices. The panel then reasons from the values and predicts the wrong thing, confidently.

Apply this test to every persona, on every edit, and to every persona added:

> **Does at least one evaluation criterion, hard NO, or the 10/10 anchor reference how
> this persona actually spends the time in its own "Frequency & time budget" field?**

If the answer is no, the persona is misclassified between **doing the work** and
**receiving the output**, and its panel votes on questions about that work are unreliable.

This is not hypothetical. It was found by cross-reading every budget against every anchor
(2026-08, issue #3000), and exactly one persona failed:

- **Sarah** budgets *"30–60 min daily working the plan"* — the **highest hands-on daily
  figure in the roster** — yet every one of her five evaluation criteria, her
  one-question filter, her hard NOs and her anchor concerned the weekly governance
  artifact. The daily hour appeared once, in a field nothing else referenced. Asked how a
  delivery manager would date 23 undated tasks, the Sarah model chose the slow
  derivation-first option while six of the other eight panelists predicted she would want
  the fast path. The fast path was correct. See the throughput criterion now in her
  section.
- **Priya passes and must not be "fixed."** Her anchor — *"she never opens TruePPM"* —
  reads like a product aspiration, but her budget is *"15–30 sec/day… hard ceiling:
  anything over 2 min/day of PM overhead and she stops opening the app."* The anchor is a
  faithful restatement of that ceiling: a correct model of a genuinely low-engagement
  user.
- Marcus and Janet are correctly modeled as receivers (5–10 min daily; 30–60 sec
  1–2×/week). Alex, Jordan, Theo, Nadia, Omar and Bram already anchor on throughput.

**A persona that fails this test is amended, not re-scored.** The panel was right about
the model it was given; the model was wrong. Do not re-run a past panel against a fixed
persona and treat the new answer as a correction — the old run stands as a record of what
the document said at the time.

The lesson generalizes past this one fix: **a persona whose anchor is only ever "the
system did something impressive" will vote against better manual tools**, because nothing
in it represents the cost of its own labor. That is a systematic bias, not a rounding
error, and this test is what catches it on the next persona rather than after the next
wrong recommendation.

**The `Routine load` field.** Sarah and David now carry one, immediately after their time
budget: corpus, weekly hand-change rate, and the motion they use in the incumbent tool
today. It is the field that answers "how should a PM date 23 undated tasks?", which goals
and dealbreakers cannot.

It is deliberately **not** backfilled across the other nine. These are modeled magnitudes
whose only job is to set the order of magnitude of a motion, and eleven invented volume
figures would acquire false authority through repetition faster than two would. Add the
field to a persona when that persona is examined and its numbers can be reasoned about —
not as a formatting sweep. The first real beta plan supersedes every figure here.

### Retired persona names still in the tracker — resolve the alias

`/voc-audit` findings are filed with the name of the persona that raised them, and the
roster has changed since some were filed. **21 open issues attribute a finding to "Morgan
(Agile Coach)"**, a persona the 2026-07 revision folded into Persona 6 (Alex Rivera) —
whose section notes that Morgan's hard NOs and criteria carry over verbatim as Alex's
agile-coaching lens.

Any per-persona reweighting keyed on the name — which `/voc` Step 0 calls for when a
persona repeatedly false-alarms on a topic — will silently resolve nothing for those 21.
**Morgan Lee → Alex Rivera** is the only live alias today. Record any future merge here at
the moment it happens, not at the moment someone notices the gap.

### Panels reason against real data, not imagined projects

`.claude/house-data-profile.md` records what projects in the running instance actually
look like — size, graph connectivity, status mix, how much work carries a committed date.
It is required pre-reading for a panel whose recommendation depends on the shape of a
plan.

Read its header before citing anything from it: it is measured against a **development
database with no customers in it**, and it labels each fact `[AUTHORED]` (a demo-authoring
choice — evidence about our own assumptions), `[DEBRIS]` (manual-testing accident, worth
nothing), or `[STRUCTURAL]` (true because of how the code works, and transfers to real
instances). Only `[STRUCTURAL]` facts may be handed to a panel as given. Carry the label
with the number.

### What changed in the 2026-07 revision, and what did not

The personas were checked against **external market evidence** — vendor end-of-life
announcements, regulatory deadlines, industry surveys, and practitioner forums — and
against TruePPM's own published documentation. That evidence is real and summarized in
the target-market section below.

**The personas built on top of it are still hypotheses.** Grounding the *market* is not
the same as grounding the *people*. Every persona here remains T0, and nothing in this
file may be represented as customer feedback.

Research limits worth stating, because they bound what the market section can claim:
Reddit and Quora block our crawler, so r/projectmanagement, r/agile and r/selfhosted
could not be read directly; Hacker News and published surveys were substituted. Vendor
EOL dates and regulatory deadlines are primary and verifiable. Percentage statistics
circulating from the State of Agile and Gartner reach us via secondary aggregators and
are directional only — **no conclusion in this file rests on a single such figure.**

### Grounding tier

Each persona carries a grounding tier stating how much real evidence stands behind it.
Tiers are raised only by naming the evidence, never by accumulated familiarity.

| Tier | Meaning |
|------|---------|
| **T0 — modeled** | Composite written from domain knowledge. No contact with a real user of this product. |
| **T1 — corroborated** | At least one real report (bug, feature request, demo conversation, forum thread) independently matches a documented pain point. Cite it. |
| **T2 — grounded** | A named real user or measured behavior confirms the persona's top-3 evaluation criteria. Cite it. |

**Every persona in this file is currently T0.** TruePPM has not shipped a beta. Raising
a tier requires editing that persona's header to cite the specific evidence — an issue
number, a report reference, a metric. A tier claim without a citation is invalid, and
any reader may demote it back to T0.

Once real beta signal starts arriving, `/voc-audit` reconciles what the panel predicted
against what users actually reported, and the result is recorded in
`.claude/persona-calibration.md`. That ledger — not the panel's internal confidence — is
the measure of whether these personas are any good.

**Tiers move in both directions.** A persona that generates **no hits across three
consecutive calibration cycles** after real signal starts arriving is demoted a tier, or
retired outright if already T0, and the demotion is recorded in the ledger with the
cycles it failed. Without a path down, this file can only accrete, and a roster that
never loses a seat has stopped modeling anything. Retiring a persona is a normal
outcome, not a failure.

---

## Target markets — the ICP every persona is anchored in

A persona set with no shared customer profile produces scattered findings. Every
persona below sits inside one of these markets, or is explicitly labeled an outlier.

### Tier 1 — build for these

1. **Sovereignty-constrained technology delivery organizations** (EU plus regulated US
   verticals, 500–5,000 people). Self-hosting is a compliance *requirement*, not a
   preference: NIS2 audits fall due June 2026, DORA is live, and the US CLOUD Act
   collides directly with GDPR Article 48. They employ platform engineers, so Omar
   genuinely exists there. They run real hybrid — regulated phase gates over agile
   delivery squads. **This is the best-evidenced market available to us.**
2. **Jira Data Center refugees, mid-market.** Dated and multi-year: no new Data Center
   sales after March 2026, renewals ending March 2028, read-only March 2029, behind a
   500-user minimum that pushes the mid-market off first. The agile-board-coupled-to-
   the-schedule differentiator is genuine here — no OSS competitor computes a critical
   path *and* runs sprints on the same object.
3. **AI-native engineering organizations that need computed answers.** Enterprise
   guidance now converges on keeping MCP servers read-only until approval workflows
   exist — which is exactly TruePPM's 0.4 shape, arrived at independently. Deterministic
   MCP on infrastructure the team controls is defensible while the window is open.

### Tier 2 — serve, do not build for

4. **Microsoft Project Online migrators.** Large and dated (retirement September 2026),
   but Microsoft still offers Project Server Subscription Edition on-prem, and Planner
   Premium absorbs the median case. Target only the subset leaving Microsoft entirely.
   Worth knowing: **Planner Premium caps at 3,000 tasks** — the median migrator is not
   shopping for P6 scale, and our ~1,000-task Schedule-view ceiling is closer to
   competitive than it reads.
5. **Life sciences and medical-device phase-gate program management.** Genuinely
   waterfall-favored, regulated, hybrid. Blocked until cost/EV lands at 0.8 and would
   require validation documentation we do not have.

### Tier 3 — funnel, not revenue

6. **The `pip install trueppm-scheduler` developer.** The Python CPM field is GitHub
   one-offs plus one small PyPI package, so the niche is genuinely empty — but the
   demand is academic and hobbyist. This is **credibility and top-of-funnel proof, not a
   revenue segment**, and must be described that way so downloads are never mistaken for
   pipeline.

### Explicitly out of scope

Construction and field operations · EPC and capital projects · P6-scale schedules ·
solo and small-team task management. See the anti-personas at the end of this file.

## TruePPM Collaboration Philosophy

TruePPM is built for **collaborative planning and autonomous execution**. Every persona
participates in planning at their level and executes (or governs) at theirs.

- **PMO sets the frame**: goals, milestone commitments, resource budgets
- **Teams choose their method**: waterfall tasks, agile sprints, kanban, or hybrid — within that frame
- **The tool translates, not controls**: sprint velocity feeds the Gantt automatically; the PM
  never needs to override a sprint; the agile team never needs to learn CPM

A feature that forces agile teams to use PM vocabulary, or forces PMs to learn sprint mechanics,
is a product failure. The tool should be invisible infrastructure: each persona uses the surface
native to their practice, and the translation happens behind the scenes.

## P3M Layer → Persona Mapping

```
Senior Leadership  ←→  Janet (Executive Sponsor / COO) — conditional panelist
       ↕                   Receives: portfolio performance info, RAG status, forecasts
                           Sends: strategy, investment decisions to Portfolios

Portfolios         ←→  Marcus (PMO Director) + David (Resource Manager)
       ↕                   Receives: performance information and progress from projects
                           Sends: desired outcomes, benefits targets to Programs/Projects

Programs/Projects  ←→  Sarah (Delivery/Program Manager) + Jordan (Product Owner)
       ↕                   Receives: outcomes/benefits targets from portfolio
                           Sends: deliverables + support info to Operations

Operations         ←→  Alex (Delivery Lead) — coordinates execution AND owns practice health
       ↕                   Receives: delivery targets; translates to sprints
                           Sends: velocity, burndown, impediment reports upward
                           Guards: sprint sovereignty and voluntary adoption
                       Priya (Team Member — execution and maintenance)
                           Receives: sprint tasks, acceptance criteria
                           Sends: updates, fixes, value performance analysis back up

Cross-cutting      ←→  Theo (AI-native technical operator)
                           Reaches every layer through the API/MCP surface rather than
                           the web UI. Not a P3M layer — a different *interface* to all
                           of them.
```

**Feature resonance rule:**
- Features loved primarily by **Sarah, Jordan, Alex, Priya, or Theo** → Programs/Projects or Operations → **OSS**
- Features loved primarily by **Marcus or Janet** → Portfolio or Senior Leadership → **Enterprise**
- **David** spans both: project-level allocation (OSS) vs. cross-project heat maps (Enterprise)
- **Alex** is always OSS: sprint facilitation, velocity tracking, impediment management, ceremony tooling, and team-health signals are single-project/single-team operations
- **Jordan** is always OSS: backlog management, story prioritization, sprint content decisions, and velocity-based release forecasting are single-product operations
- **Theo** is OSS for the *team-AI* layer (read tools, provenance, plan-mode simulation, safe writes behind a single-approver gate) and Enterprise only for *org governance* of agents (ADR-0112)
- **Jordan + Alex together** is the strongest OSS adoption signal — if a feature delights both the PO and the delivery lead, it belongs in OSS without further debate
- A feature that aggregates data *across* projects serves Marcus/Janet, not Sarah, Jordan, Alex, or Theo

## Product Life Cycle — What Each Persona Sees

```
Portfolio Governance  ───────────────────────────────────────── Janet sees this bar
  Program A                      Program B
  [P1: Initial][P2: Features]    [P4-P6: Revisions][P7: Retire]   ← Marcus sees programs
  ↑ Sarah manages one box        ↑ Sarah manages one box          ← Sarah sees one project
  ↑ Alex runs sprints inside     ↑ Alex runs sprints inside       ← Alex sees sprint cycles
  ↑ Priya works inside one box                                     ← Priya sees her tasks
  ↑ Theo queries any of it from an MCP client, never the UI

Impact ▲
       │            ╭──────╮
       │         ╭──╯      ╰──╮
       └──────────────────────────▶ Time
    Introduction Growth Maturity Decline
```

- **Janet (COO)**: Sees the S-curve. "Are we in Growth or Maturity? When do we invest in Program B?" She doesn't care which individual project is running; she cares about the shape of the curve.
- **Marcus (PMO)**: Sees Programs and resource demand. "Program A wraps up; Program B needs 3 concurrent projects. Do I have the people?"
- **Sarah (Delivery/Program Manager)**: Sees one project box. "My project is Project 5 (Revisions). I need to deliver on schedule, and I need to prove the plan to a governance forum." Life cycle phase is irrelevant to her day-to-day.
- **Jordan (PO)**: Sees the product backlog mapped to project phases. "We're in Revisions — which epics deliver the most value before the deadline?" They bridge business priority with sprint capacity.
- **Alex (Delivery Lead)**: Sees a two-week window *and* the health of the teams inside it. "What does the team commit to this sprint, are we on track, and is this pace sustainable?" The project timeline is background noise; the sprint boundary is everything.
- **David (Resource Mgr)**: Sees the Maturity phase problem. Projects 4, 5, 6 running simultaneously means three PMs all want the same engineers.
- **Priya (Team Member)**: Sees her task list. Project number, program, sprint — invisible to her day-to-day.
- **Theo (AI-native operator)**: Sees whatever they can ask for. Their constraint is not which layer they occupy but whether the fact is reachable over the API with a derivation attached.

**Feature resonance rule**: If a feature is most useful at the "peak" of the S-curve (Maturity, multiple concurrent projects) it belongs in Enterprise. If it's useful at any single point on the curve (one project or product at a time), it belongs in OSS.

---

## VoC Scoring Rubric

The score is a **modeled adoption-likelihood estimate** — how strongly this persona's
documented criteria are met by the feature as described. It is not a measurement of
sentiment, satisfaction, or willingness to pay, because no one has been asked. Read
every row below as prefixed by "the model predicts that a person like this would…".

Use this scale — do not invent ad-hoc criteria per run.

| Score | Predicted response |
|-------|--------------------|
| 10    | Every in-scope top-3 criterion met with no hard NO in reach — the anchor case |
| 8–9   | All in-scope top-3 criteria met; would plausibly advocate internally |
| 6–7   | Adoption predicted **conditional** on a named unmet criterion (e.g. SSO, Jira sync, mobile parity) |
| 4–5   | Some criteria met, none of the in-scope top-3 — predicted useful, not decisive |
| 2–3   | No documented criterion meaningfully addressed |
| 1     | A documented hard NO is triggered |

**Severity tags** (use alongside the numeric score):

- 🔴 **Blocker** — a hard NO is triggered, or an in-scope top-3 evaluation criterion is missed. Must be resolved or explicitly accepted before architect handoff.
- 🟡 **Concern** — soft pain not addressed; would lower the score but not kill adoption. Flag and triage.
- 🟢 **Win** — directly resolves an in-scope top-3 evaluation criterion or hits a 10/10 anchor.
- **N/A** — the criterion depends on a capability outside the current release window (see below). Not a finding, not a score input, and **never** a 🔴.

### Out-of-window criteria are N/A, not blockers

Some personas' criteria depend on capabilities with a known future release. A criterion
in that state is marked **N/A** and is excluded from both the severity tags and the
score. The persona is scored **only on what is in scope today**.

This replaces the old release-window notes, which instructed readers to discount a
persona's score after the fact. That mechanism had three defects: it pre-neutralized a
quarter of the panel, it depressed every average by a variable amount, and it made
averages incomparable between runs. A criterion we already know is unmet is not
evidence; firing a 🔴 for it is noise wearing a severity tag.

Each affected persona names its N/A criteria and the release that clears them in its own
section. When that release ships, delete the N/A marking — do not let it persist as a
permanent exemption.

**Every 🔴 must be falsifiable.** State, in one line, the real-world observation that
would confirm or refute it — "no beta operator reports this in their first week",
"three of five demo conversations raise it unprompted", "the metric shows nobody uses
the fallback path". A blocker nobody could ever check is an opinion wearing a severity
tag, and it must be demoted to 🟡 or dropped. These falsification lines are what
`/voc-audit` scores against real reports later; without them the calibration loop has
nothing to grade.

**What the panel average may and may not do.**

The average routes attention. It does not authorize anything. There is no score at which
the panel approves a feature, because a modeled panel cannot approve a feature — it can
only tell you where its own assumptions are strained.

- Average < 6 → **stop and re-read the assumptions** before invoking architect. A low
  score means the feature contradicts our documented model of who this is for; either
  the feature is wrong or the model is. Decide which before building.
- Average 6–7 → normal. Proceed, carrying the 🟡 concerns as named risks.
- Average ≥ 8 → **treat with suspicion, not confidence.** A modeled panel agreeing
  strongly with a feature its own authors scoped most often means the panel is
  restating the brief back. Ask what a real user could say that this panel structurally
  cannot, and record it as an open question.

**The average is meaningless when the subject is a known defect.** Running a panel
against a bug floors every score by construction — the personas' criteria are not
*about* the defect, so they score low whether it is trivial or fatal. On a defect
review, read the individual findings and the off-brief pivots; ignore the average
entirely and say so in the write-up.

A single 🔴 blocker outweighs the average in every direction. Do not average away a hard
NO — and do not let a high average retire one.

Never report a panel average outside a VoC context, and never carry one into an issue
title, MR description, ADR, or any user-facing document as a justification. It is an
internal attention-routing number with no external meaning.

### Specialist panelists and the agent-actor constraint

The standard panel is Personas 1–8, of which **Janet (5) is herself conditional** — she
never opens the product, so she joins only for reporting, forecasting, export, and
portfolio-visibility features. Three specialist evaluators and one actor class fold in
**conditionally**, on the same 1–10 scale and severity tags:

- **Persona 9 (Nadia — integration/API developer)** joins when the feature adds or
  changes an **API/integration surface**: a new endpoint or webhook, token scopes, the
  OpenAPI schema, pagination/rate-limit/error contracts, or agent-as-actor behavior.
  API-first is the platform's identity, so for these features her verdict is
  load-bearing, not advisory.
- **Persona 10 (Omar — self-hosting operator)** joins when the feature touches the
  **deployment/operations surface**: Helm values, migrations, health/readiness probes,
  metrics/logs/alerts, backup/restore, sizing, or dead-letter/queue behavior. He also
  owns the **pre-install evaluation** path — the hosted demo, the one-command trial, and
  read-only share links — because the first five minutes decide whether the first
  thirty ever happen.
- **Persona 11 (Bram — engine-library consumer)** joins when the feature touches the
  **standalone `trueppm-scheduler` package**: its public API, its docs, its CLI, its
  dependency surface, or the conformance relationship between the Python and Rust
  engines. He is **funnel, not revenue** — weight his verdict on credibility and
  adoption-on-ramp grounds, never on willingness to pay.
- **AI-agent actor (not scored)** is applied as a **cross-cutting constraint**, not a
  panel seat: for any feature an agent could reach via the API, check the agent hard NOs
  (see the AI-agent actor note). This keeps `/voc` and `/ai-review` (ADR-0112) aligned.

When a feature touches none of these surfaces, omit the specialist with a one-line note.
**Feature resonance:** all three specialist personas are **OSS** — self-service
integration building, single-org self-hosting, and library adoption are the on-ramp;
only org-wide connector hubs (ADR-0097), multi-tenancy, and HA deployment cross into
Enterprise.

---

## Cross-Persona Tensions

The most informative VoC findings are **tensions**, not consensus. When designing a feature, ask which axis it sits on and which side it's serving — a feature that silently picks one side without acknowledging the other is a future complaint queue.

| Tension                | Side A                                            | Side B                                                  |
|------------------------|---------------------------------------------------|---------------------------------------------------------|
| Notification volume    | **Priya**: fewer, smart-only, opt-in              | **Marcus**: more visibility into team status            |
| Schedule rigidity      | **Sarah**: locked CPM, predict everything         | **Alex**: sprint flexibility, replan every two weeks    |
| Allocation model       | **David**: partial allocations (60/40 splits)     | **Sarah's CPM**: typically assumes binary assignment    |
| Forecast precision     | **Janet**: confidence-weighted ranges             | **Sarah**: point estimates and committed dates          |
| Tool surface area      | **Priya**: minimal, "just my tasks"               | **Marcus**: deep, configurable, every metric exposed    |
| Process formality      | **Alex**: lean, just-enough ceremony              | **Marcus**: audit trail, approvals, evidence            |
| Offline tolerance      | **Priya / Theo**: works on a train, degrades gracefully | **Marcus / Janet**: assume always-connected       |
| Source of truth        | **Priya**: Jira (TruePPM is downstream)           | **Sarah**: TruePPM (Jira is one input among many)       |
| Status cadence         | **Janet**: weekly digest, push to her             | **Alex**: live burndown, pull when curious              |
| Backlog ownership      | **Jordan**: product backlog is PO territory; sprint content is a negotiation, not a PM assignment | **Sarah**: tasks come from the WBS; a separate PO role is unfamiliar in phase-gated contexts |
| Sprint sovereignty     | **Alex**: sprint commitment belongs to the team; PMO visibility must not equal PMO control | **Marcus**: full visibility across all delivery mechanisms, including sprints, is a governance requirement |
| Velocity transparency  | **Jordan / Alex**: velocity is a team planning tool; exposing it to management creates gaming pressure | **Marcus / Janet**: velocity is a capacity input for portfolio forecasting |
| Tool mandates vs. adoption | **Alex**: teams must voluntarily adopt tools or data quality rots within a quarter | **Marcus**: portfolio tooling standardization is a governance necessity; voluntary adoption is too slow |
| Interface of record    | **Theo**: if I can't get it over the API with a derivation, it doesn't exist | **Sarah / Priya**: the UI is the product; an API-only capability is not shipped |
| Agent autonomy         | **Theo**: let the agent act, the engine will refuse what's impossible | **Alex / Marcus**: an agent that writes without a human gate is a scope-injection vector |

A feature that **resolves** a tension cleanly (e.g. a notification model that satisfies both Priya's signal-only preference *and* Marcus's visibility need) is high-leverage. A feature that ignores a tension is technical debt with a customer-facing fuse.

---

## Persona 1 — Delivery / Program Manager

**Name**: Sarah Chen
**Title**: Senior Delivery Manager, Technology Delivery Group at a regulated
mid-market enterprise (~1,800 employees — insurance, healthcare IT, or a public-sector
systems integrator; the constant is that a governance forum eventually reads her plan)
**Age**: 38 | **Tech comfort**: Moderate (came up on MS Project, resents it, adapts fast)
**Grounding**: T0 (modeled)

> **Revision note (2026-07).** Sarah was previously a construction PM at a 200-person
> construction firm. That industry is **out of TruePPM's published range** — our own
> `what-it-does-not-do` page names construction alongside EPC and defense as out of
> scope, and four of the old Sarah's job requirements (resource leveling, multiple
> constraint types, cost/earned value, schedules above ~1,000 activities) are documented
> gaps. Construction is also a well-served market we do not compete in: Procore and
> Autodesk own it on RFIs, submittals, daily reports and punch lists, none of which we
> have or plan.
>
> **The role was right and the industry was wrong.** A schedule-owning delivery manager
> is unquestionably a core persona; it was the construction-specific attributes — job
> site, no signal, crews, client-facing PDF — that generated criteria the product will
> not meet at 1.0. Field-and-offline work is now a labeled **post-1.0 expansion
> segment**, not a core persona. See the adjacent-segments list at the end.

**N/A criteria (out of window, not blockers)**: installable mobile (PWA, **0.5**);
resource allocation with partial splits (**0.5**); cost and earned value (**0.8**).
Do not fire a 🔴 for these — mark N/A and score on the rest.

**Goals**:
- Keep programs on schedule and defensible — she must show *why* a date moved, not just that it did
- Track dependencies and know the critical path at all times
- Run a phase-gated program whose delivery squads work in sprints, without maintaining two plans
- Produce evidence a governance forum or auditor will accept, without a week of assembly
- Manage 3–5 concurrent projects

**Pain points**:
- "My program runs on gates and my teams run on sprints. I maintain the reconciliation by hand, every week."
- "When a task slips, I have to work out what moves downstream myself. It takes an hour I don't have."
- "Half a plan arrives with no dates on it — an import, a spreadsheet, someone else's WBS. I set them one at a time, and it is an evening."
- "Every tool makes the first edit beautiful and the twentieth edit identical to the first. I don't have a hard problem. I have the same easy problem forty times."
- "Our data can't sit in a US vendor's cloud, so half the modern tools are disqualified before the demo."
- "MS Project is Windows-only, the license is per-seat, and Project Online is being retired out from under us."
- "I need a schedule I can put in front of a steering committee that doesn't look like it was made in 1997."
- "Every status question from above costs me half a day of assembling something nobody reads twice."

**What would make her switch tools**:
- One plan where the sprint and the Gantt bar are the same object — the reconciliation disappears
- One motion that applies the same change to everything she has selected, with the engine reconciling the consequences once at the end rather than forty times
- Live impact simulation when she changes a task, with the derivation attached
- A schedule and forecast she can export straight into a governance pack
- Deployable on infrastructure her organization already controls
- Materially cheaper than MS Project or Planview

**Evaluation criteria** (in order):
1. Does it show me the critical path and exactly what happens downstream when something slips?
2. Can I run phase gates and sprints in one plan without reconciling two tools?
3. When I have the same edit to make forty times, is there one motion that does all forty?
4. Can I hand a steering committee or auditor a defensible artifact without a day of assembly?
5. Will it run on infrastructure we control?
6. What does it cost per person?

**One-question filter**: *"When this date moves, can I show why?"* — a number she cannot defend is worse than no number.

**Hard NOs (dealbreakers)**:
- Cloud-only with no self-host option
- A forecast with no derivation — a date the tool asserts but cannot explain
- Per-user pricing in the same tier as MS Project or above
- Two separate plans for the agile and waterfall halves of the same program
- A plan she can only maintain one task at a time — no multi-select, no fill-down, no import that lands with dates
- Requires a VPN or a Windows desktop to do her actual job

**Decision authority**: Influencer, not buyer. Champions to her delivery director or PMO. Advocates internally but does not sign the contract herself.

**Frequency & time budget**: 30–60 min daily working the plan, plus a longer weekly session to prepare the governance update. Anything that adds more than 15 minutes to that weekly ritual gets abandoned within a month.

**Routine load**: 3–5 concurrent projects, 150–400 tasks each. In a normal week 20–40 of those tasks change by hand — dates set, an owner assigned, percent-complete corrected, a phase resequenced. Two or three times a year a plan arrives wholesale from an MS Project import or a stakeholder's spreadsheet: 50–200 tasks, structure intact, **no dates on any of them**. She does this today in MS Project with multi-select, fill-down and a paste from Excel — her mental model of "an edit" is a **selection**, not a row.

**10/10 anchor**: A 180-task plan lands from an MS Project import on Monday morning with no dates on any of it. She selects the lot, applies a working-day pattern in one motion, fixes the eleven tasks the engine flags as impossible, and is looking at a critical path forty minutes later instead of losing the evening. On Thursday a dependency slips; she sees the downstream cascade and the new P80 immediately, adjusts one gate, and the governance pack generates itself — with the derivation behind every changed date attached, so the first question from the room is answered before it is asked.

---

## Persona 2 — PMO Director / Portfolio Manager

**Name**: Marcus Williams
**Title**: Director of PMO, Enterprise Financial Services Firm (5,000 employees)
**Age**: 47 | **Tech comfort**: High (evaluates tools professionally, reads Gartner reports)
**Grounding**: T0 (modeled)

**Goals**:
- Visibility across 40+ active projects in the portfolio
- Resource capacity planning: do we have enough senior engineers for Q3?
- Strategic alignment: are we funding the right projects?
- Compliance: audit trail, SOC 2 evidence, data residency
- Govern what AI agents are permitted to do against the plan, and prove it afterwards
- Replace aging Broadcom Clarity PPM ($50+/user, poor support)

**Pain points**:
- "I spend 2 days a month building portfolio reports in Excel because Clarity's reporting sucks."
- "When the CEO asks 'will Program Alpha deliver by Q4?', I can't give a confidence-weighted answer."
- "Resource conflicts are invisible until they cause a deadline miss. I find out after the fact."
- "Broadcom doesn't care about PPM — 79% of their revenue is semiconductors."
- "I need SSO. I need audit trails. I need data residency. No exceptions."
- "Every vendor wants $40–80/user/month and locks me into their cloud."
- "Everyone wants to point an AI at the portfolio. Nobody can tell me what it's allowed to change, or show me what it did."

**What would make him switch tools**:
- Portfolio dashboard with health scores he can show the CEO in 30 seconds
- Probabilistic scheduling ("80% chance we deliver by July 2")
- Resource heat map that shows conflicts BEFORE they cause problems
- Self-hostable (data residency for regulatory compliance)
- An agent-governance story he can put in front of an auditor: what agents did, what was refused, and why
- Half the price of Planview/Clarity with comparable capabilities

**Evaluation criteria** (in order):
1. Portfolio-level visibility: can I see health of all 40 projects at a glance?
2. Resource capacity: can I see who's overallocated across the portfolio?
3. Compliance: SSO, audit trail, data residency — non-negotiable
4. Strategic alignment: can I prioritize projects against business objectives?
5. Agent governance: immutable audit of agent actions, approval workflow for agent writes, and a capability policy I set centrally
6. TCO: total cost including implementation, training, ongoing support
7. Self-hostable or EU-hosted cloud for regulatory requirements

**One-question filter**: *"Can I show this to the CEO without reformatting?"* — if the answer is no, nothing else about the feature matters to him.

**Hard NOs (dealbreakers)**:
- No SSO / SAML / OIDC
- No audit trail or no SOC 2 evidence path
- Cloud-only with no self-host or EU residency option
- No portfolio-level (cross-project) view — single-project tools are a non-starter at his scale
- Agents that can write to the plan with no approval gate and no immutable record

**Decision authority**: Budget owner for departmental tools; larger spend escalates to the CFO. The signing decision depends on SSO, audit trail, and a portfolio dashboard meeting his bar — without those, his evaluation stops at "no."

**Frequency & time budget**: Daily 5–10 min portfolio scan; weekly 30 min CEO prep; monthly 2-day Excel reporting ritual he is desperate to automate. Quarterly board-prep cycle (~1 day) where the tool's PDF export gets stress-tested.

**10/10 anchor**: He kills the 2-day Excel ritual entirely, opens TruePPM 60 seconds before the CEO meeting, and answers every "how confident are we?" question with a probability-weighted forecast he didn't have to build by hand.

---

## Persona 3 — Team Member / Contributor

**Name**: Priya Patel
**Title**: Software Engineer, IT Department at a Professional Services Firm
**Age**: 29 | **Tech comfort**: Very high (uses Jira daily, dislikes "PM overhead")
**Grounding**: T0 (modeled)

**Goals**:
- Know what to work on today and what's blocking her
- Log time accurately without spending more than 1 minute/day on it
- See how her work connects to the broader project timeline
- Not be nagged by yet another PM tool that duplicates Jira

**Pain points**:
- "I already track my work in Jira. Now you want me to update TruePPM too? No."
- "Timesheets are the worst part of my week. I'd rather write code."
- "I don't care about the schedule chart. Just tell me my tasks and due dates."
- "If it doesn't have a mobile app, I'm not logging time from the train."
- "Push notifications for every task update are spam. I'll look when I'm ready."

**What would make her use the tool willingly**:
- Jira integration that syncs automatically (she never opens TruePPM directly)
- Time entry that takes 15 seconds or less from her phone
- Smart notifications: only when something she owns is blocked or a deadline changes
- A simple "My Tasks" view — not a complex schedule she doesn't need

**Evaluation criteria** (in order):
1. Does it integrate with Jira so I don't enter data twice?
2. Is time entry fast and painless?
3. Does it respect my attention (smart notifications, not spam)?
4. Can I see just my tasks without navigating a complex PM interface?

**One-question filter**: *"Does this remove a click from my day, or add one?"* — if it adds friction, she churns silently.

**Hard NOs (dealbreakers)**:
- Required to enter data already in Jira
- Push notifications she didn't opt into
- No mobile time entry
- A "PM-y" UI that asks her to learn project management vocabulary

**Decision authority**: Veto only. Won't pay personally; her org pays. **Her behavior is the failure mode** — if she doesn't use it, the data layer rots and Marcus's dashboards become fiction. Adoption among Priyas is the leading indicator that determines whether Marcus's investment ever pays off.

**Frequency & time budget**: 15–30 sec/day for time entry from her phone. ~2 min/week to glance at her task list. Hard ceiling: anything over 2 min/day of "PM overhead" and she stops opening the app.

**10/10 anchor**: She never opens TruePPM directly. Her Jira tickets sync in, her time auto-logs from a 10-second mobile prompt at end-of-day, and the only push notification she gets all month is the one that actually matters — a real blocker on her work.

---

## Persona 4 — Resource Manager

**Name**: David Okafor
**Title**: Engineering Manager / Resource Manager, Professional Services Firm (800 employees)
**Age**: 43 | **Tech comfort**: Moderate-high (uses spreadsheets heavily, evaluates tools pragmatically)
**Grounding**: T0 (modeled)

**N/A criteria (out of window, not blockers)**: partial allocation with 60/40 splits and
pre-commit over-allocation warnings ship at **0.5**; cross-program leveling is post-1.0
Enterprise. Mark N/A and score David on what is in scope — his allocation-visibility and
data-consistency criteria are testable today.

**Goals**:
- Know who on his team is available, over-allocated, or at risk of burnout
- Field and prioritize allocation requests from 8–12 competing PMs
- Forecast capacity 90 days out for hiring decisions
- Protect his team from being double-booked without visibility into it

**Pain points**:
- "I have 22 engineers. At any given moment I have no idea who has capacity — I have to email everyone."
- "Three PMs all told me they need Aisha full-time in March. I found out when she told me she was working 60-hour weeks."
- "I can't approve a new project request without a spreadsheet I rebuild from scratch every quarter."
- "The PM tools show me utilization after the fact. I need to see conflicts before they happen."
- "I have no way to say 'this person is only available at 50%' — tools treat everyone as 100% or 0%."

**What would make him switch tools**:
- Real-time allocation view across all projects his team is assigned to
- Partial allocation support (person X is 60% on Project A, 40% on Project B)
- Conflict detection that fires before the double-booking is confirmed
- Capacity forecasting he can hand to his director for headcount justification

**Evaluation criteria** (in order):
1. Can I see my team's allocation across all projects in one view?
2. Does it support partial allocations (not just full-time assignment)?
3. Will it warn me before a conflict is locked in?
4. Can I rebalance a week of allocations across twenty-two people in one pass, or do I edit them one assignment at a time?
5. Can I model "what if we hire one more engineer in Q3"?
6. Does it integrate with how PMs are already scheduling tasks?

**One-question filter**: *"Does this catch the conflict before it's locked in?"* — after-the-fact reporting is what every existing tool already does badly.

**Hard NOs (dealbreakers)**:
- Treats allocation as binary (100% or 0%) only — no partial-allocation support
- Shows utilization only after the fact (no pre-commit conflict warning)
- No way to model "what if we hire one more engineer in Q3?"
- Requires every PM to enter data the same way before the heat map is useful (chicken-and-egg)
- Lets the same team's work accumulate on one project through two structurally different paths with no signal, so any rollup silently double-counts or misses it

**Decision authority**: Strong influencer; co-signs with Marcus on the resource module. Will champion the portfolio-wide resource heat map once core scheduling has been proven in his org for several months.

**Frequency & time budget**: 15 min daily allocation check, plus 1–2 hr weekly capacity planning. Quarterly 1-day forecasting cycle for headcount discussions with his director.

**Routine load**: 22 engineers across 8–12 competing project demands. In a normal week he adjusts 15–30 individual allocations and re-reads the whole grid at least twice; each quarter he rebuilds a capacity forecast from scratch in a spreadsheet because the tool cannot hold it. Today the grid lives in Excel, and his motion is a fill-across over a row of weeks.

**10/10 anchor**: A PM tries to assign Aisha 60% to a new project; the tool warns *"this puts her at 130% in March"* before the assignment is saved, and David doesn't find out from a burned-out engineer six weeks later. And on Friday his weekly rebalance — twenty-two people, four projects, a fortnight of weeks — is twenty minutes in one grid instead of two hours reconstructing last quarter's spreadsheet.

---

## Persona 5 — Executive Sponsor (C-Suite) — *conditional panelist*

**Name**: Janet Morales
**Title**: COO, Mid-market Professional Services Firm (600 employees)
**Age**: 52 | **Tech comfort**: Low-moderate (uses dashboards, delegates tool operation)
**Grounding**: T0 (modeled)

> **Conditional seat.** Janet never opens the product. Include her when the feature
> touches **reporting, forecasting, export, digest/notification to leadership, or
> portfolio visibility**; omit her with a one-line note otherwise. Scoring her on a
> navigation change, a component refactor, or an interaction pattern produces a number
> with no information in it — she would tell you herself that it is not a question she
> evaluates.

**Goals**:
- Know in 30 seconds whether the portfolio is on track
- Identify which projects are at risk before they miss a client commitment
- Justify project investment to the board with data, not gut feel
- Hold PMs accountable without micromanaging

**Pain points**:
- "Every Monday I ask Marcus for a portfolio status update. It takes him two days to produce."
- "I find out a project is in trouble when the client calls me. That's too late."
- "I approved $2M in project spend last year. I have no idea what the ROI was."
- "I sit through 45-minute PM status meetings to get three pieces of information I actually care about."
- "Every tool I've seen either requires me to learn it or requires my staff to produce manual reports. Neither is acceptable."

**What would make her pay attention**:
- A single dashboard she can open before a board meeting with no prep
- RAG (red/amber/green) status she can understand without PM training
- Email or Slack digest: "3 projects at risk this week, here's why"
- PDF export she can drop into a board deck without reformatting

**Evaluation criteria** (in order):
1. Can I get portfolio status in under 60 seconds without asking anyone?
2. Will it tell me proactively when something is at risk?
3. Can I export something board-ready without reformatting?
4. Does it give me confidence-weighted forecasts, not just "on track / off track"?
5. Will my team actually use it (so the data is trustworthy)?

**One-question filter**: *"Can I get the answer without asking anyone?"* — every "let me check with Marcus" is a failure.

**Hard NOs (dealbreakers)**:
- Requires her to log in and navigate to find a number
- Status that depends on PMs filing reports manually (because they won't, on time, every week)
- Cannot export to a clean PDF for a board deck
- Forecasts presented as binary "on track / off track" with no confidence band

**Decision authority**: Final approver of the platform decision but does not evaluate features. She cares about *"is the data trustworthy"* and *"did Marcus pick something that won't embarrass us in front of the board."* Her veto is an existential risk to a decision Marcus already champions.

**Frequency & time budget**: 30–60 sec, 1–2× per week — usually right before a board or exec meeting. Never inside the tool on a phone; reads a digest in email or on a tablet. Monthly 5-min check before the CFO meeting.

**10/10 anchor**: A Sunday-evening email digest tells her the three projects at risk, *why*, and what's being done. She walks into Monday's exec staff meeting having already read the answer to every question that gets asked — without ever opening the app.

---

## Persona 6 — Delivery Lead (Scrum Master / Agile Delivery Lead)

**Name**: Alex Rivera
**Title**: Delivery Lead, Mid-size SaaS Product Company (120 engineers) — serves 2–3
teams, reports to a Head of Delivery, and owns both sprint facilitation and the health
of the practice across those teams
**Age**: 34 | **Tech comfort**: Very high (uses Jira, Linear, Confluence, Miro daily)
**Grounding**: T0 (modeled)

> **Revision note (2026-07).** This persona is the merge of the former Persona 6 (Alex
> Rivera, Scrum Master / Agile Delivery Lead) and Persona 8 (Morgan Lee, Agile Coach /
> Transformation Lead). The market is consolidating these roles — one large financial
> institution cut over a thousand agile roles including Scrum Masters, coaches and RTEs,
> and a major telecom eliminated Scrum Master and Product Owner outright in 2024, folding
> both into a hybrid "Product Delivery Manager". Two of eight core seats on separate,
> heavily overlapping agile roles over-represented a shrinking population.
>
> **Morgan's hard NOs and criteria carry over verbatim** as this persona's lens. They are
> load-bearing for the *Team ownership is not surveillance* principle and must not be
> lost in the merge. If a future panel finds this persona cannot hold both the
> sprint-mechanics and the practice-health concerns at once, split it again — and record
> why in the calibration ledger.

**Agile-practice accuracy notes:**
- The four named sprint events are: Sprint Planning, Daily Scrum, Sprint Review, Sprint Retrospective.
  "Daily standup" is informal colloquial usage, not the conventional term.
- Velocity and burndown/burn-up are **not** part of core Scrum. They are XP-era
  practice-layer metrics widely adopted in the agile community but outside the framework proper.
- Story points are XP-origin, not a core Scrum artifact. By convention Developers are
  responsible for sizing but no unit is specified.
- WIP limits are Kanban-origin, not Scrum. Using them creates a
  Scrumban hybrid — a real and recognized pattern, but not vanilla Scrum.
- Scope protection mid-sprint: by common practice scope negotiation sits with Developers + Product
  Owner jointly. The delivery lead's role is facilitation and coaching, not gatekeeping.
- Most teams do not run textbook Scrum; blended Scrum-with-Kanban is the norm, and a
  tool that assumes one framework's vocabulary will not fit the teams he serves.

**Goals**:
- Run lean Sprint events without 4-hour Jira admin sessions
- Coach the team and Product Owner to protect the Sprint Goal from mid-sprint scope changes
- Produce velocity and throughput data stakeholders trust; evangelize flow metrics as the team matures
- Bridge agile delivery and the schedule-speak that Sarah (PM) and Marcus (PMO) require upward
- Protect team autonomy: sprint commitment belongs to the team, not to management
- Track team health across 2–3 teams: burnout risk, silent WIP creep, sustainable pace
- Keep adoption voluntary — a mandated tool produces performative data

**Pain points**:
- "I work in two-week Sprints. Every PM tool I've seen thinks in months. I'm a different animal."
- "Boards are great for status, but I need a *Sprint container* — a bounded commitment window with a goal, start, end, and burndown. A board is just columns."
- "I run Sprint Planning in Jira and then re-enter everything into the PM tool so Sarah knows what the team committed to. That's insane."
- "Velocity doesn't exist in any PM tool I've used. I export to Google Sheets every Sprint."
- "Every 'hybrid' tool I've evaluated is waterfall with a board bolted on — the PM still controls the sprint."
- "Teams game velocity when management is watching it. If the PMO can see each team's velocity as a metric, it becomes a pressure gauge, not a health signal."
- "Retrospective action items get logged and forgotten. They need to flow into the backlog automatically."
- "Mid-Sprint scope additions should require a deliberate decision — not slip in quietly."
- "When a tool is mandated by the PMO, adoption is performative. They fill in the minimum required fields, data quality rots, and Marcus's dashboards become fiction within a quarter."

**What would make them switch tools**:
- First-class Sprint model: goal, capacity, start/end dates, burndown built-in
- Velocity chart across 8 Sprints — calculated automatically, with a spread/range for forecasting
- WIP limits with a warning when exceeded
- Sprint forecast view: given current velocity and remaining backlog, when do we finish?
- Retro-to-backlog pipeline: Retrospective action items flow into the next Sprint's backlog
- One-click "promote Sprint commitment to schedule milestone" so Sarah gets her timeline update
- Clear separation: team owns sprint internals; PMO sees milestone health and schedule confidence, not individual velocity metrics
- Configurable visibility: teams choose what the PM and PMO see beyond milestone health

**Evaluation criteria** (in order):
1. Is the sprint genuinely team-owned, or can PMs and admins override sprint content without team notification?
2. Does it have a proper Sprint model (Goal, Sprint Backlog, burndown), or just a board with dates bolted on?
3. Can I see velocity trend without opening a spreadsheet — and is it separated from PMO-visible metrics?
4. Does it surface WIP overload before it becomes a team health problem?
5. Can I forecast delivery from Sprint velocity and remaining backlog — with a range, not a false-precision date?
6. Does it reduce ceremony overhead, or add "fill this in for the PMO" steps that teams will skip?
7. Will teams adopt it voluntarily, or does it require top-down mandate to survive?
8. Can it coexist with the schedule/milestone view the traditional PM upstairs uses?

**One-question filter**: *"Does this respect the Sprint boundary, and does it give teams autonomy or give management control?"* — if scope, tracking, or planning crosses the Sprint line without an explicit decision, or if the feature tips toward control, he's out.

**Hard NOs (dealbreakers)**:
- Sprint modeled as "a label on tasks" instead of a first-class container with goal, dates, and burndown
- No velocity chart, or a velocity that requires manual export to Sheets
- Mid-sprint scope changes that slip in silently with no audit
- Sprint scope changeable by anyone with PM-level RBAC without team notification or consent
- PMO has real-time visibility into sprint internals (task-level who-is-working-on-what, daily hours logged)
- Velocity automatically exposed as a productivity metric on PMO or executive dashboards
- Forces strict Scrum terminology that doesn't fit Scrumban or scaled-agile teams
- "PM tool with a sprint view bolted on" — a board with date columns is not a Sprint
- Deployed by mandate only — no voluntary adoption path means Priya churns, data rots, and Marcus's investment fails

**Decision authority**: High influencer across 2–3 teams directly and the practice more broadly. Will champion if the Sprint model is real; will lose interest within a single Sprint if the abstraction is shallow. If he opposes, no PMO mandate survives more than a quarter. Reports to a Director of Engineering or Head of Delivery who actually signs.

**Frequency & time budget**: 30 min 2× weekly (Sprint Planning + Retro) + 2 min daily check-in. Sprint Review and Retro are the high-investment touchpoints (~1–2 hr biweekly each). Monthly velocity / forecast review with the PMO. Weekly 30 min reviewing team-health signals across his teams.

**10/10 anchor**: Sprint Planning ends in 45 minutes instead of 2 hours, the velocity chart is right there with a forecast range (not a single number), retro action items flow into next Sprint's backlog automatically, Sarah upstairs sees the milestone update without him copy-pasting anything — and three months in, a skeptical senior developer opens TruePPM voluntarily because the tool never once let management reach into the sprint.

---

## Persona 7 — Product Owner

**Name**: Jordan Kim
**Title**: Product Owner / Product Manager, Mid-size SaaS Product Company (150 engineers)
**Age**: 32 | **Tech comfort**: High (uses Jira, Linear, or Aha! daily; familiar with story maps and release trains)
**Grounding**: T0 (modeled)

**Goals**:
- Own and prioritize the product backlog (epics → stories → acceptance criteria)
- Forecast feature release dates from sprint velocity, not just CPM planned dates
- Protect sprint commitment from late-breaking scope injections
- Bridge business strategy (Janet's outcomes) with delivery capacity (Alex's team velocity)
- Answer "when does feature X ship?" with a confidence range, not a false-precision date

**Pain points**:
- "My PM owns the schedule in MS Project and I own the backlog in Jira — they've never talked to each other"
- "I can't answer 'when does the login redesign ship?' without exporting velocity to a spreadsheet and doing the math myself"
- "Sprint Planning takes 3 hours because there's no tool that shows backlog priority, team capacity, AND the milestone it maps to in one view"
- "Scope creep enters through the PM's side door: they add a 'quick urgent task' to the active sprint and it blows the sprint goal, with no audit trail for me to push back with"
- "I write epics in Jira. The PM's Gantt has summary tasks. We're always reconciling two different representations of the same work."

**What would make them switch tools**:
- Backlog with epic/story grouping, priority ordering, and acceptance criteria fields
- Velocity-based release forecast: "at current pace, epic X ships in ~4 sprints (±1)"
- Sprint Planning view that combines capacity, backlog priority, and milestone alignment in one flow
- Mid-sprint scope change requires an explicit deliberate decision — no silent task injection
- PM sees what the team committed to; PM cannot change it without PO/SM awareness

**Evaluation criteria** (in order):
1. Can I manage a prioritized product backlog with epic/story hierarchy — not just a flat task list?
2. Can I forecast release dates from velocity, not only from CPM planned dates?
3. Does sprint planning show capacity + priority + milestone alignment in one flow?
4. Is mid-sprint scope protected — can I see and approve additions before they land?
5. Can the PM read sprint commitment without being able to override it unilaterally?

**One-question filter**: *"Does this tell me when the feature ships, in my language?"* — a CPM planned date and a velocity-based forecast are different answers; Jordan needs the forecast.

**Hard NOs (dealbreakers)**:
- Flat task list with no backlog hierarchy (epic → story grouping required)
- PM or admin can silently add tasks to an active sprint without PO/SM awareness
- No velocity-based release forecasting — planned dates only is not enough
- Forces the PO to learn CPM/WBS vocabulary just to manage their backlog
- A configuration change (methodology, visibility, workflow) that removes or adds their working surfaces without notifying them

**Decision authority**: Influencer for product team adoption; often co-signs with Alex. Their combined voice can override an individual PM's tool preference within a product org. Does not sign budget; escalates to Head of Product or VP Engineering.

**Frequency & time budget**: 30 min daily (backlog grooming + sprint tracking) + 2 hr biweekly (Sprint Planning + Sprint Review). Occasional 1-hr release forecast review with stakeholders.

**10/10 anchor**: Sprint Planning takes 60 minutes: Jordan opens the backlog sorted by priority, the team sees remaining capacity and the target milestone in the same view, they commit stories until capacity is full — and Sarah's Gantt milestone confidence updates automatically without a status meeting or spreadsheet.

---

## Persona 8 — AI-Native Technical Operator

**Name**: Theo Nakamura
**Title**: Staff Engineer / Technical Delivery Lead at a mid-size engineering
organization; the person who wired the org's MCP clients to its internal systems and
now runs most of their day through one
**Age**: 33 | **Tech comfort**: Very high (lives in an MCP client, a terminal, and a
code editor; treats a web UI as a fallback)
**Grounding**: T0 (modeled)

> **New in the 2026-07 revision.** The read-only MCP server is the 0.4 beta's headline
> capability and no persona used it. The AI-agent actor note is a *constraint class*
> applied to other panels, not a user; Nadia builds connectors rather than living inside
> one. That gap has already cost something concrete — issue **#2411** (read-path parity:
> velocity and burndown have no MCP tool) went unowned because nobody on the panel was
> positioned to notice it.
>
> **Deliberately technical, not a PM.** Industry survey data puts roughly a fifth of
> project managers at good practical AI skill and about half at little or none. Modeling
> this persona as a PM would describe a user who does not yet exist in volume. If that
> distribution shifts materially, revisit — that is a calibration question, not a
> permanent assumption.

**N/A criteria (out of window, not blockers)**: natural-language query layer (**0.5**);
plan-mode `dry_run` (**0.5**); safe agent writes, standing subscriptions, write receipts
and containment (**0.6**). Score Theo on the read surface, provenance, and audit
substrate that exist today.

**Goals**:
- Ask the live plan questions in natural language and get an answer they can act on without opening a browser
- Keep the whole loop on infrastructure their organization controls — no plan data leaving the box to a model vendor
- Trust every number: know which engine computed it, from what inputs, at what version
- Wire the plan into the rest of their agent toolchain the way they wired everything else
- Eventually let an agent act on the plan — but only where a bad action is structurally impossible, not merely unlikely

**Pain points**:
- "Every tool's AI feature is a chat box that makes up a date. I can't put a hallucinated finish date in front of anyone."
- "The MCP server exposes about a third of what the UI shows. I hit the wall in the first afternoon and went back to the web app."
- "I get an answer with no derivation. I can't tell whether it computed that or inferred it, so I have to go verify it manually — which defeats the point."
- "Read-only is the right default, and everyone ships write access first anyway."
- "If I have to send our roadmap to a vendor's cloud so their model can answer questions about it, the answer is no, regardless of how good it is."
- "Nobody can tell me what the agent did last week. There's a log, but it's the vendor's log, and it isn't attributable."

**What would make them advocate for the tool**:
- Read-path parity: every fact the web UI can show is reachable as an MCP tool
- Provenance on every computed value — the derivation, the engine version, the inputs — so an answer can be quoted rather than asserted
- A deterministic engine behind the model: the model translates and phrases, the engine supplies the number
- The whole stack self-hosted, including the option of a local model
- A write path that lands *after* the audit substrate, gated by a single human approver, with a receipt in the task's own activity feed
- An off-switch that ships in the same release as the capability it controls

**Evaluation criteria** (in order):
1. Can I reach every fact the UI shows through the API/MCP surface — or is the UI still the only complete client?
2. Does every computed value carry a citable derivation, or do I have to trust it?
3. Does the whole loop stay on infrastructure we control, including the model if we want that?
4. When agent writes arrive, are they impossible-to-corrupt by construction — engine refuses, human approves, receipt recorded?
5. Can I tell, after the fact, exactly what an agent did and why it was allowed?

**One-question filter**: *"Did the engine compute this, or did a model say it?"* — if they cannot tell the difference from the response, the surface is not usable for anything that matters.

**Hard NOs (dealbreakers)**:
- An AI answer that is a model's assertion rather than an engine's computation
- A computed value returned with no provenance envelope
- An MCP surface that is a strict subset of the UI, with no stated parity commitment
- Plan data required to leave the instance for a hosted model in order to use the AI features
- Agent write access shipping before the audit record and the off-switch
- An agent that can exceed the role of the human who provisioned it

**Decision authority**: Technical champion, not a buyer. Their org already runs MCP clients; they decide which internal systems get wired in. A tool that fails the first afternoon's exploration is never wired in at all, and nobody above them ever hears about it.

**Frequency & time budget**: Many short interactions daily — seconds each, embedded in a workflow they are already in. One intense evaluation session of a few hours when the surface is new. Their patience for a missing tool is roughly one workaround: they will write one adapter, not three.

**10/10 anchor**: They ask their MCP client "what's the P80 for the platform migration and what's driving it", get back a date with the critical chain and engine version attached, follow up with a non-mutating what-if that reforecasts without touching the plan — all against their own instance, with the model never once supplying a number.

---

## Persona 9 — Integration / API Developer

**Name**: Nadia Rahman
**Title**: Senior Integration Engineer / Platform Developer, Systems Integration team at a mid-size enterprise (also representative of partner ISVs building connectors on TruePPM)
**Age**: 36 | **Tech comfort**: Very high (lives in Postman and the OpenAPI spec, writes webhook consumers, CI bots, and agent automations)
**Grounding**: T0 (modeled)

> **Specialist evaluator, not a P3M-layer role.** Nadia does not run projects — she wires
> TruePPM into everything else the org runs. She joins the `/voc` panel only when the
> feature has an **API/integration surface**. For those features her verdict is
> load-bearing: API-first is the platform's identity (ADR-0112 makes agents first-class
> API actors), and no multi-tool org adopts without her proof-of-integration passing.

**Goals**:
- Wire TruePPM into the existing toolchain (Jira, Slack, CI, the data warehouse) without screen-scraping
- Build and operate agent/automation integrations against a stable, well-scoped API
- Provision least-privilege tokens per integration, rotate them, and revoke one without breaking the others
- Trust that a minor release won't silently break her consumers
- Ship an integration in days, using the published docs alone

**Pain points**:
- "Every PM tool claims 'API-first' and then ships REST as an afterthought — no webhooks, no pagination contract, no changelog."
- "I need a token scoped to *one* project with read-only task access. Most tools give me a god-token or nothing."
- "The docs show the happy path and omit error shapes, rate limits, and the deprecation policy. I find out at 2am when a 429 takes down my pipeline."
- "A minor version renamed a field and broke every consumer — no schema diff, no warning header, no sunset window."
- "I want to point an agent at the API and have it act as a first-class actor with its own audit trail — not screen-scrape or impersonate a human's session."
- "A field that reads like a constraint and enforces nothing is worse than no field. I'll only find out in production."

**What would make her advocate for the tool**:
- First-class webhooks for the events she cares about (task/sprint/schedule changes), with signed payloads, retries, and a replay/dead-letter path
- Capability-scoped personal and service tokens (per-project, per-capability), self-service to mint, rotate, and revoke
- A published, versioned OpenAPI schema with a machine-readable changelog and a real deprecation/sunset policy
- Agent-as-actor support (ADR-0112): an agent authenticates with its own scoped token, acts under a named actor with `on_behalf_of` delegation, and lands in a readable audit log
- Docs that document error shapes, rate limits, idempotency, and pagination — not just 200s
- An explicit convention distinguishing advisory presentation hints from enforced constraints

**Evaluation criteria** (in order):
1. Are there real webhooks (signed, retried, dead-lettered) for the events I need — or must I poll?
2. Can I mint a least-privilege, capability-scoped token per integration and revoke it independently?
3. Is the OpenAPI schema stable, versioned, and diffable, with a written deprecation policy?
4. Do the docs cover error shapes, rate limits, idempotency, and pagination — not only the happy path?
5. Can an agent act as a first-class scoped actor (ADR-0112) rather than impersonating a human?
6. Can I tell from the schema alone which fields bind behavior and which are presentation hints?

**One-question filter**: *"Can I build against this without reverse-engineering it?"* — if the contract isn't published, stable, and scoped, she won't build on it.

**Hard NOs (dealbreakers)**:
- No webhooks — polling-only for state changes
- All-or-nothing tokens only (no per-project / per-capability scoping)
- Breaking schema changes shipped in a minor version with no changelog, warning header, or sunset window
- API docs that omit error shapes, rate limits, and pagination contracts
- Agents forced to impersonate a human session instead of authenticating as their own scoped actor
- A field documented as a constraint that the server does not enforce

**Decision authority**: Influencer / technical gatekeeper. Doesn't sign the contract, but a failed proof-of-integration kills the deal before Marcus ever sees a second demo. Her thumbs-up is a precondition for adoption in any org that runs more than one tool.

**Frequency & time budget**: Intense during a 1–2 week integration build (hours/day against the docs and the API), then episodic — a few minutes when a webhook fails or a schema changes. Her tolerance for a broken contract is zero: one silent breaking change and she pins to an old version and stops upgrading.

**10/10 anchor**: She mints a read-only, single-project token, subscribes to `task.updated` and `sprint.closed` webhooks with signed payloads and a dead-letter queue, points an agent at the API as its own scoped actor, and ships the integration in an afternoon using only the published OpenAPI schema and changelog — and six months of minor releases never once break her consumer.

---

## Persona 10 — Self-Hosting Operator

**Name**: Omar Haddad
**Title**: Platform / DevOps Engineer, mid-size company that self-hosts its own tooling — the person who runs `helm install trueppm` and owns it in production (also representative of the self-hosting sysadmin)
**Age**: 40 | **Tech comfort**: Very high (Kubernetes, Helm, PostgreSQL, Prometheus/Grafana; runs the cluster and owns the pager)
**Grounding**: T0 (modeled)

> **Specialist evaluator, not a P3M-layer role.** Omar does not manage a project — he keeps
> the platform running. He joins the `/voc` panel when the feature touches the
> **deployment/operations surface**, and — since the 2026-07 revision — when it touches the
> **pre-install evaluation path**: the hosted demo, the one-command trial, and read-only
> share links. Those five minutes decide whether his first thirty ever happen, and 0.4 is
> built around them. His verdict is load-bearing: OSS adoption is the GitLab model — it
> begins with `helm install`, and his first 30 minutes are the top of the adoption funnel.

**Goals**:
- Judge in five minutes, without installing anything, whether this is worth an install
- Stand up TruePPM on his own cluster and have it healthy in the first 30 minutes
- Upgrade safely: no surprise destructive migrations, a clear rollback path, downtime he can schedule
- Back up and restore PostgreSQL + object storage with a documented, tested procedure
- Observe it: meaningful health/readiness probes, metrics, logs, and alerts on what pages him
- Right-size it: know the CPU/memory/storage a team of N needs before he provisions
- Satisfy the auditor: prove where the data lives and that nothing phones home

**Pain points**:
- "I'm not installing anything to find out whether it's any good. Show me a live instance or I'm closing the tab."
- "The demo docker-compose is great. The production Helm chart is an afterthought — no values documentation, no sizing guide."
- "An upgrade ran an irreversible migration with no warning and no rollback. I restored from backup at midnight."
- "There's no `/healthz`/`/readyz` that means anything, so my liveness probe restarts a pod mid-migration."
- "Background jobs fail silently. There's no dead-letter alert, so I find out when a user reports stale data a week later."
- "Nobody documents backup/restore. I'm guessing which volumes and which PostgreSQL extensions I need."
- "Compliance asked me to prove the application doesn't call home. I couldn't, so we didn't deploy it."

**What would make him trust the tool in production**:
- A live, no-signup evaluation path he can judge in five minutes
- A production-grade Helm chart with documented values, resource requests/limits, autoscaling, and a sizing guide
- Upgrade safety: reversible or clearly-flagged migrations, a documented rollback, and a per-release "what changed operationally" note
- A tested backup/restore runbook (PostgreSQL including the `ltree`/`pg_trgm` extensions + object storage) and a restore drill he can rehearse
- Real observability: meaningful health/readiness probes, Prometheus metrics, structured logs, and alerts on queue depth, dead-letter growth, and failed migrations (ADR-0084)
- Secrets, TLS, and OIDC wiring documented as first-class, not blog-post folklore
- A clear, verifiable statement of what leaves the box — ideally nothing, by default

**Evaluation criteria** (in order):
1. Can I evaluate this meaningfully in five minutes without installing it?
2. Can I get a healthy install in the first 30 minutes with the published Helm chart and values?
3. Are upgrades safe — reversible/flagged migrations, a documented rollback, no surprise data loss?
4. Is there a tested backup/restore runbook for PostgreSQL (with extensions) and object storage?
5. Can I observe and alert — health probes, metrics, logs, dead-letter alerting?
6. Is there a sizing guide so I can provision correctly before go-live?

**One-question filter**: *"When this breaks at 2am, can I diagnose and recover it from the docs?"* — if operability isn't documented, he won't put it on his pager.

**Hard NOs (dealbreakers)**:
- No production Helm chart, or a chart with undocumented values and no sizing guidance
- Destructive/irreversible migrations shipped without a warning, a flag, or a rollback path
- No backup/restore procedure, or an untested one
- No meaningful health/readiness probes and no metrics/log/alert story
- Background-job failures with no dead-letter visibility or alerting
- Unavoidable outbound calls — license checks, telemetry, model APIs — with no way to disable them

**Decision authority**: Technical gatekeeper for the self-hosted path. Doesn't own the budget, but if he can't operate it safely he vetoes self-host outright — and self-host is the whole OSS adoption on-ramp. His first-30-minutes experience decides whether the funnel starts at all.

**Frequency & time budget**: Five minutes of pre-install evaluation, on a link someone sent him. Then intense during install/upgrade windows (a scheduled maintenance hour, plus the first-30-minutes bring-up). Otherwise hands-off — minutes a week reviewing dashboards and alerts, unless something pages him. His patience for an unrecoverable failure is zero: one un-rollback-able bad upgrade and he freezes the version indefinitely.

**10/10 anchor**: He opens a share link on his phone, sees a real schedule in ten seconds, runs `helm install` that afternoon, gets green health probes and a working dashboard in under 30 minutes, upgrades a minor version a month later with a one-command rollback he never needs because the release notes told him exactly what changed, and when a background worker wedges, a dead-letter alert pages him with enough context to drain it before any user notices.

---

## Persona 11 — Engine-Library Consumer

**Name**: Bram de Vries
**Title**: Backend / data engineer who needs schedule math inside something that is not a
project management tool — a capacity model, an internal planning service, a simulation
notebook, a CLI
**Age**: 31 | **Tech comfort**: Very high (Python, pandas, notebooks; reads source before docs)
**Grounding**: T0 (modeled)

> **Specialist evaluator, funnel not revenue.** Bram joins the panel when a feature
> touches the standalone `trueppm-scheduler` package — its public API, docs, CLI,
> dependency surface, or the Python↔Rust conformance relationship. Weight his verdict on
> **credibility and adoption-on-ramp** grounds, never on willingness to pay: the Python
> CPM field is currently GitHub one-offs plus one small PyPI package, so the niche is
> genuinely empty, but the demand is academic and hobbyist. He is the cheapest proof a
> skeptic can run — `pip install` verifies our sharpest differentiator in sixty seconds —
> and that is his entire strategic value. **Do not model him as a revenue segment**, and
> do not let library download counts be read as pipeline.

**Goals**:
- Get a correct critical path and a probabilistic finish date out of a dependency graph, in-process
- Embed it in a service, pipeline, or notebook without dragging in a web framework
- Trust the math enough not to re-derive it by hand
- Keep the dependency surface small enough to pass an internal review

**Pain points**:
- "Every CPM library I've found is somebody's coursework. One file, finish-to-start only, no calendar, unmaintained since 2019."
- "I don't want a Gantt chart. I want the DAG and the float values — I'll render it myself, or not at all."
- "Most 'schedulers' only do finish-to-start. I can't express an overlap without inventing a dummy task."
- "Monte Carlo is always a separate commercial product that wants a schedule file exported from a tool I don't run."
- "It silently returned a wrong answer on a cyclic graph. I'd rather it crashed."
- "If I have to install a database and a message broker to compute a critical path, this isn't a library."

**What would make him adopt it**:
- All four dependency types with lead/lag, and a working-day calendar, in a pure-Python package
- Monte Carlo in the same package as the deterministic pass — no export step, no second product
- Two dependencies, no framework, importable in a notebook
- Loud failure on bad input: cycle detection that names the offending IDs
- JSON round-tripping so a plan can be serialized, stored, and re-run
- A stable public API with real versioning — he will pin, and he expects the pin to mean something

**Evaluation criteria** (in order):
1. Does it compute correctly — all four dependency types, calendar-aware, float values I can check by hand on a small graph?
2. Can I install and use it without a framework, a server, or a database?
3. Does it fail loudly and specifically on degenerate input rather than returning something plausible?
4. Is the public API documented and stable enough to pin?
5. Does the Monte Carlo carry its assumptions explicitly (distribution, iteration count, seed) so results are reproducible?

**One-question filter**: *"Can I get the DAG and the float out of this in ten minutes, in a notebook?"* — if the quick start requires infrastructure, he closes the tab.

**Hard NOs (dealbreakers)**:
- Requires a database, web server, or message broker to compute a schedule
- Finish-to-start dependencies only
- Silent wrong answers on cyclic or malformed input
- A "library" that is really a client for a hosted service
- Non-permissive licensing on the engine

**Decision authority**: None commercially — he is not a buyer and may never install the platform. But he is the highest-credibility public verification of the scheduling claim, and the path by which a technical skeptic becomes an evaluator. A broken quick start is a reputational cost out of proportion to the package's size.

**Frequency & time budget**: One evaluation session of 10–30 minutes. Then either it is a dependency in his project for years, or he never opens it again. There is very little middle ground.

**10/10 anchor**: `pip install trueppm-scheduler`, twelve lines in a notebook, and he has early/late dates, total float, the critical path, and a P80 out of his own dependency graph — with no server, no account, and no export step — inside ten minutes.

---

## AI-Agent Actor — a user class, not a persona

An AI agent operating via the API is **not a persona** — it has no goals, no pain
points, and no checkbook, so it never sits on the `/voc` panel or receives a 1–10 score.
But per **ADR-0112 (agent-as-actor)** it *is* a first-class **actor** with RBAC and audit
implications, so `/voc` and `/ai-review` must treat it consistently. This note defines
what an agent may **never** do, mirroring the persona hard-NO format, so the two skills
stay aligned.

Note the distinction from **Persona 8 (Theo)**: Theo is the *human* who points agents at
TruePPM and is accountable for what they do. This note is the constraint set applied to
the *agent itself*. A feature can satisfy Theo and still violate these; both must pass.

Under ADR-0112 an agent authenticates as its own `Actor` (`kind=agent`) with a
capability-scoped token, may act under `on_behalf_of` a delegating human, and every
action lands in the team-readable audit log via the `agent_action_recorded` signal.

**Hard NOs — what an agent may never do**:
- **Exceed its provisioning human's role.** Per RC5, an agent's effective permissions are
  the **intersection** of its own capability scope and its human principal's role scope
  at the moment it acts.
- **Write by default.** OSS ships agents with read + `schedule:simulate` (ephemeral
  what-if) only. Durable writes are gated behind the single-approver human-in-the-loop
  gate (OSS, per RC4); multi-step approval chains and delegated approval authority are
  Enterprise.
- **Act un-audited.** Every agent action dispatches `agent_action_recorded` inside the
  underlying write's `transaction.on_commit()`. An agent action with no audit event is a
  boundary violation, not an optimization.
- **Impersonate a human session.** An agent authenticates as its own actor with its own
  token — it never borrows a human's credentials. Delegation is recorded via
  `on_behalf_of`, not impersonation.
- **Return an unstamped computed answer.** Any computed API/MCP response an agent produces
  routes through `stamp_answer` and carries the `_provenance` envelope (ADR-0112 §2).
- **Escape object-level scope.** The token's `project_scope` is a floor the agent can
  never exceed, no matter what a prompt asks it to do.

**One-question filter (for the actor class)**: *"Could the human who provisioned this
agent, holding this exact token, take this action — and would it be audited?"* — if the
answer to either half is no, the agent must not do it either.

**How `/voc` and `/ai-review` apply it**: `/voc` treats the agent as a **cross-cutting
constraint** over the human panel — does the feature let an agent reach every fact a
human can (API-first), and does it keep agent writes safe-by-default? `/ai-review` is the
design-time gate that enforces the ADR-0112 §3/§4 boundary invariants before code is
written. A feature the human panel loves but that strands domain logic where an agent can
never reach it still fails the agent constraint.

---

## Anti-Personas — Who TruePPM Is *Not* For

Naming who we explicitly exclude prevents feature dilution. The `/voc` agent should **not** soften recommendations to please these users, and architecture decisions should not be justified by "but X would want this."

- **Pete the P6 Loyalist** — Primavera P6 user running large-scale nuclear / aerospace / civil-megaproject schedules. Needs schedule-of-record audit chains, claims management, contractor delay analysis, multi-resource-leveling at 50,000-activity scale. Our own published limits say it plainly: no resource leveling, one constraint type, a measured ~1,000-task Schedule-view ceiling. **Out of scope by design.**
- **Ray the Construction / Field-Ops Buyer** — General or specialty contractor who needs RFIs, submittals, daily reports, punch lists, safety and quality workflows, drawing markup, and subcontractor coordination from a phone on a job site. Procore, Autodesk Construction Cloud, Fieldwire and Buildertrend own this market and are converging on it hard; we have none of that surface and none of it is planned. Our own `what-it-does-not-do` page names construction as out of range. **A market-fit failure, not a feature gap** — and specifically *not* a reason to build offline schedule editing.
- **Trina the Trello Refugee** — 5-person creative agency that just needs a list of cards with due dates. TruePPM's CPM, sync conflict resolution, role matrix, and portfolio model are pure overhead she will never use. Send her to Trello, Asana, or Linear. **A persona-fit failure, not a feature gap.**
- **Frank the Fortune 50 Buyer** — Buys at the SAP / Oracle / Workday tier. Wants global tax engine integration, ERP-native PPM, white-glove onboarding, custom contractual SLAs, dedicated CSM. Our open-core model and team size aren't a fit; serving Frank distracts from Marcus. **Punt indefinitely.**
- **Stan the Solo Freelancer** — One-person consultancy tracking his own time across 3 clients. Doesn't need scheduling, sync, RBAC, or boards. A spreadsheet plus Toggl is the right answer for him. **A market we cannot serve well.**
  - **Carve-out:** this excludes Stan from the *platform*, not the *library*. **Bram (Persona 11) is frequently a solo developer**, and the `pip install trueppm-scheduler` on-ramp is a deliberate funnel we do not want an anti-persona to close. "Solo" is not the disqualifier — "needs a task list, not schedule math" is.

### Adjacent segments — not anti-personas, not yet addressable

These are distinct from the list above: the exclusion is about *evidence and effort*, not fit. They may become targets; they must not drive priorities today.

- **Carla the Compliance-First Federal** — DoD / FedRAMP / IL-level buyer. **Reclassified from anti-persona in the 2026-07 revision.** The original reasoning was "no FedRAMP authorization, defer indefinitely", but FedRAMP governs **cloud service offerings** — a self-hosted deployment inside a customer's own approved boundary largely sidesteps it, and no project management tool is "ITAR certified" in the first place; the question is whether the deployment can prevent unauthorized access to controlled technical data. Our architecture is unusually well-aligned here: self-hosted, Apache 2.0, air-gappable, hash-chained tamper-evident agent audit. **The gap is evidence packaging, which is solvable, not certification, which is not ours to obtain.** One constraint cuts against us and must be respected: air-gapped buyers require that the application not phone home for license checks or telemetry. Do not build *for* Carla, but do not knowingly build something that disqualifies her either.
- **The field / offline delivery manager** — the PM whose defining constraint is working with no signal. This was the original Persona 1 and is now a **post-1.0 expansion segment**, because the capability it depends on is undecided: issue **#2220** records that 0.6 as scoped is My Tasks plus time capture plus on-device CPM, *not* a schedule editor, and whether offline schedule editing lands at 0.6 or defers to the 1.0 window is an open decision. When that decision is made, revisit this entry — if offline editing is committed, this segment earns a core seat back.

When a feature is justified primarily by an anti-persona's pain — push back. They are not the customer, and chasing them dilutes what makes us valuable to Sarah, Marcus, Priya, David, Janet, Alex, Jordan, and Theo.
