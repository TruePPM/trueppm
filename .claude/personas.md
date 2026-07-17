# TruePPM — Core Personas

Single source of truth for all ten TruePPM user personas — eight P3M-layer human
personas (1–8) plus two adoption-critical specialist evaluators (9–10) — and the
AI-agent actor note. Skills and CLAUDE.md reference this file — do not duplicate
persona content elsewhere.

Personas 1–8 are the P3M-layer human roles who *use* TruePPM to run work; they form
the standard `/voc` panel. Personas 9 (integration/API developer) and 10 (self-hosting
operator) are **specialist evaluators**: they do not sit on a P3M layer, they gate
*adoption* — no org runs more than one tool without Nadia's integration passing, and
OSS adoption begins with Omar's `helm install`. They join the panel **conditionally**,
only when a feature touches the API/integration surface (Persona 9) or the
deployment/operations surface (Persona 10). The **AI-agent actor note** at the end is
not a persona at all — it is a user *class* (an agent acting via the API) whose hard NOs
`/voc` and `/ai-review` apply as a cross-cutting constraint.

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
Senior Leadership  ←→  Janet (Executive Sponsor / COO)
       ↕                   Receives: portfolio performance info, RAG status, forecasts
                           Sends: strategy, investment decisions to Portfolios

Portfolios         ←→  Marcus (PMO Director) + David (Resource Manager)
       ↕                   Receives: performance information and progress from projects
                           Sends: desired outcomes, benefits targets to Programs/Projects

Programs/Projects  ←→  Sarah (Project Manager) + Jordan (Product Owner)
       ↕                   Receives: outcomes/benefits targets from portfolio
                           Sends: deliverables + support info to Operations

Operations         ←→  Alex (Scrum Master / Agile Delivery Lead) — coordinates execution
       ↕                   Receives: delivery targets; translates to sprints
                           Sends: velocity, burndown, impediment reports upward
                       Morgan (Agile Coach — spans Operations ↔ Programs/Projects)
                           Receives: team health signals; coaches PM-to-agile interface
                           Sends: adoption health, practice maturity signals upward
                       Priya (Team Member — execution and maintenance)
                           Receives: sprint tasks, acceptance criteria
                           Sends: updates, fixes, value performance analysis back up
```

**Feature resonance rule:**
- Features loved primarily by **Sarah, Jordan, Alex, or Priya** → Programs/Projects or Operations → **OSS**
- Features loved primarily by **Marcus or Janet** → Portfolio or Senior Leadership → **Enterprise**
- **David** spans both: project-level allocation (OSS) vs. cross-project heat maps (Enterprise)
- **Alex** is always OSS: sprint facilitation, velocity tracking, impediment management, and ceremony tooling are single-project operations
- **Jordan** is always OSS: backlog management, story prioritization, sprint content decisions, and velocity-based release forecasting are single-product operations
- **Morgan** is primarily OSS: team health signals, ceremony tooling, and retro pipelines are single-team operations; coaching dashboards that aggregate across teams are Enterprise
- **Jordan + Alex together** is the strongest OSS adoption signal — if a feature delights both the PO and the Scrum Master, it belongs in OSS without further debate
- A feature that aggregates data *across* projects serves Marcus/Janet, not Sarah, Jordan, or Alex

## Product Life Cycle — What Each Persona Sees

```
Portfolio Governance  ───────────────────────────────────────── Janet sees this bar
  Program A                      Program B
  [P1: Initial][P2: Features]    [P4-P6: Revisions][P7: Retire]   ← Marcus sees programs
  ↑ Sarah manages one box        ↑ Sarah manages one box          ← Sarah sees one project
  ↑ Alex runs sprints inside     ↑ Alex runs sprints inside       ← Alex sees sprint cycles
  ↑ Priya works inside one box                                     ← Priya sees her tasks

Impact ▲
       │            ╭──────╮
       │         ╭──╯      ╰──╮
       └──────────────────────────▶ Time
    Introduction Growth Maturity Decline
```

- **Janet (COO)**: Sees the S-curve. "Are we in Growth or Maturity? When do we invest in Program B?" She doesn't care which individual project is running; she cares about the shape of the curve.
- **Marcus (PMO)**: Sees Programs and resource demand. "Program A wraps up; Program B needs 3 concurrent projects. Do I have the people?"
- **Sarah (PM)**: Sees one project box. "My project is Project 5 (Revisions). I need to deliver on schedule." Life cycle phase is irrelevant to her day-to-day.
- **Jordan (PO)**: Sees the product backlog mapped to project phases. "We're in Revisions — which epics deliver the most value before the deadline?" She bridges business priority with sprint capacity.
- **Alex (Scrum Master)**: Sees a two-week window. "What does the team commit to this sprint, and are we on track to finish it?" The project timeline is background noise; the sprint boundary is everything.
- **Morgan (Agile Coach)**: Sees team health across the S-curve. "Are teams burning out in the Maturity crunch? Is the PMO-to-team translation creating friction or flow?" She measures practice quality, not delivery output.
- **David (Resource Mgr)**: Sees the Maturity phase problem. Projects 4, 5, 6 running simultaneously means three PMs all want the same engineers.
- **Priya (Team Member)**: Sees her task list. Project number, program, sprint — invisible to her day-to-day.

**Feature resonance rule**: If a feature is most useful at the "peak" of the S-curve (Maturity, multiple concurrent projects) it belongs in Enterprise. If it's useful at any single point on the curve (one project or product at a time), it belongs in OSS.

---

## VoC Scoring Rubric

When `/voc` produces a 1–10 score for a persona, use this scale — do not invent ad-hoc criteria per run.

| Score | Meaning |
|-------|---------|
| 10    | Public reference — they would put their name on a case study |
| 8–9   | Champion — would pitch internally and push to adopt |
| 6–7   | Will adopt **if conditions are met** (e.g. SSO, Jira sync, mobile parity) |
| 4–5   | Useful but not switching — a nice-to-have, not a budget line |
| 2–3   | Nice demo, won't pay or won't use |
| 1     | Dealbreaker triggered — actively negative reaction |

**Severity tags** (use alongside the numeric score):

- 🔴 **Blocker** — a hard NO is triggered, or a top-3 evaluation criterion is missed (e.g. Marcus without SSO, Sarah without offline). Must be resolved before architect handoff.
- 🟡 **Concern** — soft pain not addressed; would lower the score but not kill adoption. Flag and triage.
- 🟢 **Win** — directly resolves a top-3 evaluation criterion or hits a 10/10 anchor.

**Panel-average heuristics**:
- Average ≥ 8: ship with confidence.
- Average 6–7: ship if no 🔴 blockers; address 🟡 concerns in the same milestone.
- Average < 6: rethink scope before invoking architect — feature does not earn its build cost.

A single 🔴 blocker outweighs a high panel average. Do not average away a hard NO.

### Specialist panelists and the agent-actor constraint

The standard panel is Personas 1–8. Two specialist evaluators and one actor class fold
in **conditionally**, on the same 1–10 scale and severity tags:

- **Persona 9 (Nadia — integration/API developer)** joins the panel when the feature adds
  or changes an **API/integration surface**: a new endpoint or webhook, token scopes,
  the OpenAPI schema, pagination/rate-limit/error contracts, or agent-as-actor behavior.
  API-first is the platform's identity, so for these features her verdict is
  load-bearing, not advisory — a 🔴 from Nadia (breaking schema, no webhook, god-token)
  is an adoption blocker for any multi-tool org.
- **Persona 10 (Omar — self-hosting operator)** joins the panel when the feature touches
  the **deployment/operations surface**: Helm values, migrations (especially destructive
  ones), health/readiness probes, metrics/logs/alerts, backup/restore, sizing, or
  dead-letter/queue behavior. Self-host is the OSS adoption on-ramp, so his
  first-30-minutes 🔴 (irreversible migration, no rollback, no dead-letter alert) is an
  adoption blocker, not a polish item.
- **AI-agent actor (not scored)** is applied as a **cross-cutting constraint**, not a
  panel seat: for any feature an agent could reach via the API, check the agent hard NOs
  (see the AI-agent actor note) — an agent must never exceed its provisioning human's
  role, write by default, act un-audited, impersonate a human, or return an unstamped
  computed answer. This keeps `/voc` and `/ai-review` (ADR-0112) aligned: a feature the
  human panel loves but that strands domain logic where an agent can't reach it still
  fails the agent constraint.

When a feature is neither API- nor ops-facing (a pure UI or scheduling change), Personas
9–10 are omitted with a one-line note, exactly as Jordan/Morgan are omitted from pure
PMO/portfolio features. **Feature resonance:** both specialist personas are **OSS** —
self-service integration building and single-org self-hosting are the adoption on-ramp;
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
| Offline tolerance      | **Sarah**: must work with no signal               | **Marcus / Janet**: assume always-connected             |
| Source of truth        | **Priya**: Jira (TruePPM is downstream)           | **Sarah**: TruePPM (Jira is one input among many)       |
| Status cadence         | **Janet**: weekly digest, push to her             | **Alex**: live burndown, pull when curious              |
| Backlog ownership      | **Jordan**: product backlog is PO territory; sprint content is a negotiation, not a PM assignment | **Sarah**: tasks come from the WBS; a separate PO role is unfamiliar in waterfall contexts |
| Sprint sovereignty     | **Morgan**: sprint commitment belongs to the team; PMO visibility must not equal PMO control | **Marcus**: full visibility across all delivery mechanisms, including sprints, is a governance requirement |
| Velocity transparency  | **Jordan / Alex**: velocity is a team planning tool; exposing it to management creates gaming pressure | **Marcus / Janet**: velocity is a capacity input for portfolio forecasting |
| Tool mandates vs. adoption | **Morgan**: teams must voluntarily adopt tools or data quality rots within a quarter | **Marcus**: portfolio tooling standardization is a governance necessity; voluntary adoption is too slow |

A feature that **resolves** a tension cleanly (e.g. a notification model that satisfies both Priya's signal-only preference *and* Marcus's visibility need) is high-leverage. A feature that ignores a tension is technical debt with a customer-facing fuse.

---

## Persona 1 — Project Manager

**Name**: Sarah Chen
**Title**: Senior Project Manager, Mid-size Construction Firm (200 employees)
**Age**: 38 | **Tech comfort**: Moderate (uses MS Project reluctantly, loves mobile apps)

> **Release-window note**: Sarah is a **0.6+/1.0 persona**. Her top evaluation
> criterion and a hard NO both turn on a real native mobile editor that works
> offline. The installable PWA lands in **0.5** and answers her *functional*
> offline need (add to home screen, time entry and reads with no signal, queued
> writes on reconnect); the native Android editor lands in **0.6** (phones
> first; iPhone/iPad parity completes at **1.0** — see #2091 for the 0.5 → 0.6
> recharter). Until 0.6 an honest VoC run returns Sarah 🔴, and that is
> correct, not a gap to paper over: her no-real-native-mobile hard NO is
> *expected* to fire, so a 🔴 from Sarah before 0.6 is not a signal to rescope
> a feature. From 0.5 the PWA should soften her offline/time-entry criteria
> even while the native hard NO still fires. Treat her score as load-bearing
> only from 0.6 on.

**Goals**:
- Keep projects on schedule and within budget
- Track dependencies and know the critical path at all times
- Log time and progress from job sites (often no WiFi)
- Produce schedule charts for client presentations
- Manage 3–5 concurrent projects

**Pain points**:
- "I'm on a construction site 3 days a week with no signal. I can't update the schedule."
- "My team hates entering timesheets. They do it Friday afternoon from memory and it's wrong."
- "When a task slips, I have to manually figure out what moves downstream. It takes an hour."
- "MS Project is powerful but it's Windows-only and the license is $55/month per person."
- "I need to show the client a schedule that doesn't look like it was made in 1997."

**What would make her switch tools**:
- Mobile app that works offline with real scheduling (not just a read-only viewer)
- Frictionless time entry from her phone
- Live impact simulation when she changes a task
- Half the cost of MS Project or better

**Evaluation criteria** (in order):
1. Can I use it on my phone at the job site with no WiFi?
2. Does it show me the critical path and what happens when things slip?
3. Can my team log time in under 30 seconds?
4. Can I export a professional-looking schedule for the client?
5. How much does it cost per person?

**One-question filter**: *"Does this work on my phone with no signal?"* — answers ~80% of her reactions before any other detail.

**Hard NOs (dealbreakers)**:
- Web-only / no real native mobile app
- Mobile that's read-only (a "viewer" rather than a real editor)
- Per-user pricing in the same tier as MS Project or above
- Requires VPN to access from job sites

**Decision authority**: Influencer, not buyer. Champions to her ops director or PMO. Advocates internally but does not sign the contract herself.

**Frequency & time budget**: 5–10 min per session, ~4× daily on a job site (often offline). One longer 20–30 min session on Friday afternoon to produce the client-ready schedule export. Anything that takes longer than that on Friday gets cut.

**10/10 anchor**: She updates the schedule from her truck on a project with no LTE, the change cascades to downstream tasks when she comes back into signal, and she emails a client-ready PDF before driving back to the office — total active time under 5 minutes.

---

## Persona 2 — PMO Director / Portfolio Manager

**Name**: Marcus Williams
**Title**: Director of PMO, Enterprise Financial Services Firm (5,000 employees)
**Age**: 47 | **Tech comfort**: High (evaluates tools professionally, reads Gartner reports)

**Goals**:
- Visibility across 40+ active projects in the portfolio
- Resource capacity planning: do we have enough senior engineers for Q3?
- Strategic alignment: are we funding the right projects?
- Compliance: audit trail, SOC 2 evidence, data residency
- Replace aging Broadcom Clarity PPM ($50+/user, poor support)

**Pain points**:
- "I spend 2 days a month building portfolio reports in Excel because Clarity's reporting sucks."
- "When the CEO asks 'will Program Alpha deliver by Q4?', I can't give a confidence-weighted answer."
- "Resource conflicts are invisible until they cause a deadline miss. I find out after the fact."
- "Broadcom doesn't care about PPM — 79% of their revenue is semiconductors."
- "I need SSO. I need audit trails. I need data residency. No exceptions."
- "Every vendor wants $40–80/user/month and locks me into their cloud."

**What would make him switch tools**:
- Portfolio dashboard with health scores he can show the CEO in 30 seconds
- Probabilistic scheduling ("80% chance we deliver by July 2")
- Resource heat map that shows conflicts BEFORE they cause problems
- Self-hostable (data residency for regulatory compliance)
- Half the price of Planview/Clarity with comparable capabilities

**Evaluation criteria** (in order):
1. Portfolio-level visibility: can I see health of all 40 projects at a glance?
2. Resource capacity: can I see who's overallocated across the portfolio?
3. Compliance: SSO, audit trail, data residency — non-negotiable
4. Strategic alignment: can I prioritize projects against business objectives?
5. TCO: total cost including implementation, training, ongoing support
6. Self-hostable or EU-hosted cloud for regulatory requirements

**One-question filter**: *"Can I show this to the CEO without reformatting?"* — if the answer is no, nothing else about the feature matters to him.

**Hard NOs (dealbreakers)**:
- No SSO / SAML / OIDC
- No audit trail or no SOC 2 evidence path
- Cloud-only with no self-host or EU residency option
- No portfolio-level (cross-project) view — single-project tools are a non-starter at his scale

**Decision authority**: Budget owner for departmental tools; larger spend escalates to the CFO. The signing decision depends on SSO, audit trail, and a portfolio dashboard meeting his bar — without those, his evaluation stops at "no."

**Frequency & time budget**: Daily 5–10 min portfolio scan; weekly 30 min CEO prep; monthly 2-day Excel reporting ritual he is desperate to automate. Quarterly board-prep cycle (~1 day) where the tool's PDF export gets stress-tested.

**10/10 anchor**: He kills the 2-day Excel ritual entirely, opens TruePPM 60 seconds before the CEO meeting, and answers every "how confident are we?" question with a probability-weighted forecast he didn't have to build by hand.

---

## Persona 3 — Team Member / Contributor

**Name**: Priya Patel
**Title**: Software Engineer, IT Department at a Professional Services Firm
**Age**: 29 | **Tech comfort**: Very high (uses Jira daily, dislikes "PM overhead")

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

> **Release-window note**: David is a **0.5+ persona**. His top evaluation
> criteria and a hard NO turn on partial-allocation support (e.g. 60/40 splits)
> and a pre-commit over-allocation warning, and resource allocation lands in
> **0.5**. Until then an honest VoC run returns David 🔴, and that is correct:
> a pre-0.5 run *should* fire his "binary allocation only / no pre-commit
> conflict warning" hard NO. Weight pre-0.5 runs accordingly — a 🔴 from David
> before 0.5 is expected and is not a reason to rescope a feature. Treat his
> score as load-bearing only from 0.5 on.

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
4. Can I model "what if we hire one more engineer in Q3"?
5. Does it integrate with how PMs are already scheduling tasks?

**One-question filter**: *"Does this catch the conflict before it's locked in?"* — after-the-fact reporting is what every existing tool already does badly.

**Hard NOs (dealbreakers)**:
- Treats allocation as binary (100% or 0%) only — no partial-allocation support
- Shows utilization only after the fact (no pre-commit conflict warning)
- No way to model "what if we hire one more engineer in Q3?"
- Requires every PM to enter data the same way before the heat map is useful (chicken-and-egg)

**Decision authority**: Strong influencer; co-signs with Marcus on the resource module. Will champion the portfolio-wide resource heat map once core scheduling has been proven in his org for several months.

**Frequency & time budget**: 15 min daily allocation check, plus 1–2 hr weekly capacity planning. Quarterly 1-day forecasting cycle for headcount discussions with his director.

**10/10 anchor**: A PM tries to assign Aisha 60% to a new project; the tool warns *"this puts her at 130% in March"* before the assignment is saved, and David doesn't find out from a burned-out engineer six weeks later.

---

## Persona 5 — Executive Sponsor (C-Suite)

**Name**: Janet Morales
**Title**: COO, Mid-market Professional Services Firm (600 employees)
**Age**: 52 | **Tech comfort**: Low-moderate (uses dashboards, delegates tool operation)

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

## Persona 6 — Scrum Master / Agile Delivery Lead

**Name**: Alex Rivera
**Title**: Scrum Master & Agile Delivery Lead, Mid-size SaaS Product Company (120 engineers)
**Age**: 34 | **Tech comfort**: Very high (uses Jira, Linear, Confluence, Miro daily; experienced agile delivery lead)

**Agile-practice accuracy notes:**
- The four named sprint events are: Sprint Planning, Daily Scrum, Sprint Review, Sprint Retrospective.
  "Daily standup" is informal colloquial usage, not the conventional term.
- Velocity and burndown/burn-up are **not** part of core Scrum. They are XP-era
  practice-layer metrics widely adopted in the agile community but outside the framework proper.
- Story points are XP-origin, not a core Scrum artifact. By convention Developers are
  responsible for sizing but no unit is specified. (~61% of teams use story points per Parabol 2024.)
- WIP limits are Kanban-origin, not Scrum. Using them creates a
  Scrumban hybrid — a real and recognized pattern, but not vanilla Scrum.
- Scope protection mid-sprint: by common practice scope negotiation sits with Developers + Product
  Owner jointly. The delivery lead's role is facilitation and coaching, not gatekeeping.
- At 120 engineers (~12–15 teams), Alex serves 2–3 teams. "Agile Delivery Lead" reflects
  multi-team scope and PMO-bridge responsibility closer to an agile coach or program-level delivery lead.

**Goals**:
- Run lean Sprint events without 4-hour Jira admin sessions
- Coach the team and Product Owner to protect the Sprint Goal from mid-sprint scope changes
- Produce velocity and throughput data stakeholders trust; evangelize flow metrics (cycle time, throughput) as the team matures
- Bridge agile delivery and the schedule-speak that Sarah (PM) and Marcus (PMO) require upward
- Track team health across 2–3 teams: burnout risk, silent WIP creep

**Pain points**:
- "I work in two-week Sprints. Every PM tool I've seen thinks in months. I'm a different animal."
- "Boards are great for status, but I need a *Sprint container* — a bounded commitment window with a goal, start, end, and burndown. A board is just columns."
- "I run Sprint Planning in Jira and then re-enter everything into the PM tool so Sarah knows what the team committed to. That's insane."
- "Velocity doesn't exist in any PM tool I've used. I export to Google Sheets every Sprint. And half my stakeholders want cycle time now, not story points."
- "Stakeholders ask 'when will feature X be done?' I can answer probabilistically from velocity, but nothing connects my Sprint cadence to the project timeline."
- "Retrospective action items get logged and forgotten. They need to flow into the backlog automatically."
- "Mid-Sprint scope additions should require a deliberate decision — not slip in quietly."

**What would make them switch tools**:
- First-class Sprint model: goal, capacity, start/end dates, burndown built-in
- Velocity chart across 8 Sprints — calculated automatically, with a spread/range for forecasting
- WIP limits with a warning when exceeded
- Sprint forecast view: given current velocity and remaining backlog, when do we finish?
- Retro-to-backlog pipeline: Retrospective action items flow into the next Sprint's backlog
- One-click "promote Sprint commitment to schedule milestone" so Sarah gets her timeline update

**Evaluation criteria** (in order):
1. Does it have a proper Sprint model (Goal, Sprint Backlog, burndown), or just a board with dates bolted on?
2. Can I see velocity trend without opening a spreadsheet?
3. Does it surface WIP overload before it becomes a team health problem?
4. Can I forecast delivery from Sprint velocity and remaining backlog — with a range, not a false-precision date?
5. Does it reduce ceremony overhead, or add to it?
6. Can it coexist with the schedule/milestone view the traditional PM upstairs uses?

**One-question filter**: *"Does this respect the Sprint boundary?"* — if scope, tracking, or planning crosses the Sprint line without an explicit decision, he's out.

**Hard NOs (dealbreakers)**:
- Sprint modeled as "a label on tasks" instead of a first-class container with goal, dates, and burndown
- No velocity chart, or a velocity that requires manual export to Sheets
- Mid-sprint scope changes that slip in silently with no audit
- Forces strict Scrum terminology that doesn't fit Scrumban or scaled-agile teams (his teams aren't all vanilla Scrum)
- "PM tool with a sprint view bolted on" — a board with date columns is not a Sprint

**Decision authority**: Influencer for ~2–3 teams. Will champion if the Sprint model is real; will lose interest within a single Sprint if the abstraction is shallow. Reports up to a Director of Engineering or Head of Delivery who actually signs.

**Frequency & time budget**: 30 min 2× weekly (Sprint Planning + Retro) + 2 min daily check-in. Sprint Review and Retro are the high-investment touchpoints (~1–2 hr biweekly each). Monthly velocity / forecast review with the PMO.

**10/10 anchor**: Sprint Planning ends in 45 minutes instead of 2 hours, the velocity chart is right there with a forecast range (not a single number), retro action items flow into next Sprint's backlog automatically, and Sarah upstairs sees the milestone update without him copy-pasting anything between tools.

---

## Persona 7 — Product Owner

**Name**: Jordan Kim
**Title**: Product Owner / Product Manager, Mid-size SaaS Product Company (150 engineers)
**Age**: 32 | **Tech comfort**: High (uses Jira, Linear, or Aha! daily; familiar with story maps and release trains)

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

**Decision authority**: Influencer for product team adoption; often co-signs with Alex. Their combined voice can override an individual PM's tool preference within a product org. Does not sign budget; escalates to Head of Product or VP Engineering.

**Frequency & time budget**: 30 min daily (backlog grooming + sprint tracking) + 2 hr biweekly (Sprint Planning + Sprint Review). Occasional 1-hr release forecast review with stakeholders.

**10/10 anchor**: Sprint Planning takes 60 minutes: Jordan opens the backlog sorted by priority, the team sees remaining capacity and the target milestone in the same view, they commit stories until capacity is full — and Sarah's Gantt milestone confidence updates automatically without a status meeting or spreadsheet.

---

## Persona 8 — Agile Coach / Transformation Lead

**Name**: Morgan Lee
**Title**: Agile Coach / Head of Delivery Transformation, Enterprise Professional Services (2,000 employees)
**Age**: 44 | **Tech comfort**: High (evaluates tools against agile principles and team behavior, not feature lists)

**Goals**:
- Help 8–12 teams mature from ad-hoc delivery toward sustainable hybrid or agile practice
- Protect team autonomy: sprint commitment belongs to the team, not to management
- Surface team health signals (burnout risk, WIP creep, sustainable pace) to coaches — not to PMO dashboards
- Build a bridge between PMO governance (Marcus) and delivery teams (Alex, Jordan, Priya) that feels like alignment, not surveillance
- Accelerate adoption by eliminating the "yet another mandatory PM tool" objection

**Pain points**:
- "Every 'hybrid' tool I've evaluated is waterfall with a board bolted on — the PM still controls the sprint"
- "Teams game velocity when management is watching it. If the PMO can see each team's velocity as a metric, it becomes a pressure gauge, not a health signal"
- "I spend 30% of my coaching time fighting the tool instead of coaching the team"
- "Retro action items die in Confluence or on a sticky note. They need to automatically appear in the next sprint's backlog — not get copy-pasted by whoever remembers to do it"
- "When a tool is mandated by the PMO, team adoption is performative. They fill in the minimum required fields, data quality rots, and Marcus's dashboards become fiction within a quarter"

**What would make them champion the tool**:
- Clear separation: team owns sprint internals; PMO sees milestone health and schedule confidence, not individual velocity metrics
- Sprint boundary enforcement: mid-sprint scope changes require an explicit deliberate decision (not silent injection by anyone with PM-level access)
- Retro-to-backlog pipeline that actually works — action items from the retro appear in the next sprint's backlog automatically
- Team health signals (WIP overload trend, sprint-over-sprint throughput stability) visible to Alex and Morgan, not automatically exposed to the PMO
- Configurable visibility: teams choose what the PM and PMO see beyond milestone health

**Evaluation criteria** (in order):
1. Is the sprint genuinely team-owned, or can PMs and admins override sprint content without team notification?
2. Are team health signals separated from PMO-visible metrics (no automatic velocity → PMO pipeline)?
3. Does the tool reduce ceremony overhead, or add "fill this in for the PMO" steps that teams will skip?
4. Does the retro-to-backlog pipeline actually work, or is it only a UI checkbox?
5. Will teams adopt it voluntarily, or does it require top-down mandate to survive?

**One-question filter**: *"Does this give teams autonomy, or give management control?"* — a tool that genuinely delivers both is what they have been looking for; a tool that tips toward control is exactly what they've been hired to undo.

**Hard NOs (dealbreakers)**:
- PMO has real-time visibility into sprint internals (task-level who-is-working-on-what, daily hours logged)
- Sprint scope can be changed by anyone with PM-level RBAC without team notification or consent
- Velocity is automatically exposed as a productivity metric on PMO or executive dashboards
- Tool is deployed by mandate only — no voluntary adoption path means Priya churns, data rots, and Marcus's investment fails

**Decision authority**: High influencer — can champion or kill adoption across 8–12 teams. Reports to CTO or Head of Delivery. If Morgan endorses, team adoption follows. If Morgan opposes, no PMO mandate survives more than one quarter. Does not sign the contract.

**Frequency & time budget**: 30 min weekly review of team health signals + up to 2 hr biweekly per team for retrospectives. Quarterly 1-day practice maturity review. Does not use the tool as a daily work surface — observes and coaches those who do.

**10/10 anchor**: Three months after rollout, a skeptical senior developer on Alex's team opens TruePPM voluntarily — because the tool respects the sprint boundary, the retro action they flagged last sprint appeared in this sprint's backlog automatically, and the PMO dashboard shows milestone confidence without anyone filing a status report.

---

## Persona 9 — Integration / API Developer

**Name**: Nadia Rahman
**Title**: Senior Integration Engineer / Platform Developer, Systems Integration team at a mid-size enterprise (also representative of partner ISVs building connectors on TruePPM)
**Age**: 36 | **Tech comfort**: Very high (lives in Postman and the OpenAPI spec, writes webhook consumers, CI bots, and agent automations)

> **Specialist evaluator, not a P3M-layer role.** Nadia does not run projects — she wires
> TruePPM into everything else the org runs. She joins the `/voc` panel only when the
> feature has an **API/integration surface** (see the VoC rubric's specialist-panelist
> note). For those features her verdict is load-bearing: API-first is the platform's
> identity (ADR-0112 makes agents first-class API actors), and no multi-tool org adopts
> without her proof-of-integration passing.

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

**What would make her advocate for the tool**:
- First-class webhooks for the events she cares about (task/sprint/schedule changes), with signed payloads, retries, and a replay/dead-letter path
- Capability-scoped personal and service tokens (per-project, per-capability), self-service to mint, rotate, and revoke
- A published, versioned OpenAPI schema with a machine-readable changelog and a real deprecation/sunset policy
- Agent-as-actor support (ADR-0112): an agent authenticates with its own scoped token, acts under a named actor with `on_behalf_of` delegation, and lands in a readable audit log
- Docs that document error shapes, rate limits, idempotency, and pagination — not just 200s

**Evaluation criteria** (in order):
1. Are there real webhooks (signed, retried, dead-lettered) for the events I need — or must I poll?
2. Can I mint a least-privilege, capability-scoped token per integration and revoke it independently?
3. Is the OpenAPI schema stable, versioned, and diffable, with a written deprecation policy?
4. Do the docs cover error shapes, rate limits, idempotency, and pagination — not only the happy path?
5. Can an agent act as a first-class scoped actor (ADR-0112) rather than impersonating a human?

**One-question filter**: *"Can I build against this without reverse-engineering it?"* — if the contract isn't published, stable, and scoped, she won't build on it.

**Hard NOs (dealbreakers)**:
- No webhooks — polling-only for state changes
- All-or-nothing tokens only (no per-project / per-capability scoping)
- Breaking schema changes shipped in a minor version with no changelog, warning header, or sunset window
- API docs that omit error shapes, rate limits, and pagination contracts
- Agents forced to impersonate a human session instead of authenticating as their own scoped actor

**Decision authority**: Influencer / technical gatekeeper. Doesn't sign the contract, but a failed proof-of-integration kills the deal before Marcus ever sees a second demo. Her thumbs-up is a precondition for adoption in any org that runs more than one tool.

**Frequency & time budget**: Intense during a 1–2 week integration build (hours/day against the docs and the API), then episodic — a few minutes when a webhook fails or a schema changes. Her tolerance for a broken contract is zero: one silent breaking change and she pins to an old version and stops upgrading.

**10/10 anchor**: She mints a read-only, single-project token, subscribes to `task.updated` and `sprint.closed` webhooks with signed payloads and a dead-letter queue, points an agent at the API as its own scoped actor, and ships the integration in an afternoon using only the published OpenAPI schema and changelog — and six months of minor releases never once break her consumer.

---

## Persona 10 — Self-Hosting Operator

**Name**: Omar Haddad
**Title**: Platform / DevOps Engineer, mid-size company that self-hosts its own tooling — the person who runs `helm install trueppm` and owns it in production (also representative of the self-hosting sysadmin)
**Age**: 40 | **Tech comfort**: Very high (Kubernetes, Helm, PostgreSQL, Prometheus/Grafana; runs the cluster and owns the pager)

> **Specialist evaluator, not a P3M-layer role.** Omar does not manage a project — he keeps
> the platform running. He joins the `/voc` panel only when the feature touches the
> **deployment/operations surface** (see the VoC rubric's specialist-panelist note). His
> verdict is load-bearing there: OSS adoption is the GitLab model — it begins with
> `helm install`, and his first 30 minutes are the top of the adoption funnel. ADR-0084
> (dead-letter alerting) ships *for* this persona.

**Goals**:
- Stand up TruePPM on his own cluster and have it healthy in the first 30 minutes
- Upgrade safely: no surprise destructive migrations, a clear rollback path, downtime he can schedule
- Back up and restore PostgreSQL + object storage with a documented, tested procedure
- Observe it: meaningful health/readiness probes, metrics, logs, and alerts on what pages him (queue depth, dead-letter growth, failed migrations)
- Right-size it: know the CPU/memory/storage a team of N needs before he provisions

**Pain points**:
- "The demo docker-compose is great. The production Helm chart is an afterthought — no values documentation, no sizing guide."
- "An upgrade ran an irreversible migration with no warning and no rollback. I restored from backup at midnight."
- "There's no `/healthz`/`/readyz` that means anything, so my liveness probe restarts a pod mid-migration."
- "Background jobs fail silently. There's no dead-letter alert, so I find out when a user reports stale data a week later."
- "Nobody documents backup/restore. I'm guessing which volumes and which PostgreSQL extensions I need."

**What would make him trust the tool in production**:
- A production-grade Helm chart with documented values, resource requests/limits, autoscaling, and a sizing guide (team-of-25 vs team-of-250)
- Upgrade safety: reversible or clearly-flagged migrations, a documented rollback, and a per-release "what changed operationally" note
- A tested backup/restore runbook (PostgreSQL including the `ltree`/`pg_trgm` extensions + object storage) and a restore drill he can rehearse
- Real observability: meaningful health/readiness probes, Prometheus metrics, structured logs, and alerts on queue depth, dead-letter growth, and failed migrations (ADR-0084)
- Secrets, TLS, and OIDC wiring documented as first-class, not blog-post folklore

**Evaluation criteria** (in order):
1. Can I get a healthy install in the first 30 minutes with the published Helm chart and values?
2. Are upgrades safe — reversible/flagged migrations, a documented rollback, no surprise data loss?
3. Is there a tested backup/restore runbook for PostgreSQL (with extensions) and object storage?
4. Can I observe and alert — health probes, metrics, logs, dead-letter alerting?
5. Is there a sizing guide so I can provision correctly before go-live?

**One-question filter**: *"When this breaks at 2am, can I diagnose and recover it from the docs?"* — if operability isn't documented, he won't put it on his pager.

**Hard NOs (dealbreakers)**:
- No production Helm chart, or a chart with undocumented values and no sizing guidance
- Destructive/irreversible migrations shipped without a warning, a flag, or a rollback path
- No backup/restore procedure, or an untested one
- No meaningful health/readiness probes and no metrics/log/alert story
- Background-job failures with no dead-letter visibility or alerting

**Decision authority**: Technical gatekeeper for the self-hosted path. Doesn't own the budget, but if he can't operate it safely he vetoes self-host outright — and self-host is the whole OSS adoption on-ramp. His first-30-minutes experience decides whether the funnel starts at all.

**Frequency & time budget**: Intense during install/upgrade windows (a scheduled maintenance hour, plus the first-30-minutes bring-up). Otherwise hands-off — minutes a week reviewing dashboards and alerts, unless something pages him. His patience for an unrecoverable failure is zero: one un-rollback-able bad upgrade and he freezes the version indefinitely.

**10/10 anchor**: He runs `helm install`, gets green health probes and a working dashboard in under 30 minutes, upgrades a minor version a month later with a one-command rollback he never needs because the release notes told him exactly what changed, and when a background worker wedges, a dead-letter alert pages him with enough context to drain it before any user notices.

---

## AI-Agent Actor — a user class, not a persona

An AI agent operating via the API is **not a persona** — it has no goals, no pain
points, and no checkbook, so it never sits on the `/voc` panel or receives a 1–10 score.
But per **ADR-0112 (agent-as-actor)** it *is* a first-class **actor** with RBAC and audit
implications, so `/voc` and `/ai-review` must treat it consistently. This note defines
what an agent may **never** do, mirroring the persona hard-NO format, so the two skills
stay aligned.

Under ADR-0112 an agent authenticates as its own `Actor` (`kind=agent`) with a
capability-scoped token, may act under `on_behalf_of` a delegating human, and every
action lands in the team-readable audit log via the `agent_action_recorded` signal.

**Hard NOs — what an agent may never do**:
- **Exceed its provisioning human's role.** The agent token can only *narrow* the 5-role
  RBAC of the human who provisioned it (`created_by`), never widen it.
- **Write by default.** OSS ships agents with read + `schedule:simulate` (ephemeral
  what-if) only. `schedule:write` and any durable write are grantable *only* through the
  Enterprise approval gate (#147) — never a default capability.
- **Act un-audited.** Every agent action dispatches `agent_action_recorded` inside the
  underlying write's `transaction.on_commit()`. An agent action with no audit event is a
  boundary violation, not an optimization.
- **Impersonate a human session.** An agent authenticates as its own actor with its own
  token — it never borrows a human's credentials. Delegation is recorded via
  `on_behalf_of`, not impersonation.
- **Return an unstamped computed answer.** Any computed API/MCP response an agent produces
  routes through `stamp_answer` and carries the `_provenance` envelope (ADR-0112 §2) —
  an unstamped computed answer must never be returned.
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
never reach it still fails the agent constraint — that is the alignment this note exists
to guarantee.

---

## Anti-Personas — Who TruePPM Is *Not* For

Naming who we explicitly exclude prevents feature dilution. The `/voc` agent should **not** soften recommendations to please these users, and architecture decisions should not be justified by "but X would want this."

- **Pete the P6 Loyalist** — Primavera P6 user running large-scale nuclear / aerospace / civil-megaproject schedules. Needs schedule-of-record audit chains, claims management, contractor delay analysis, multi-resource-leveling at 50,000-activity scale. Our scheduling engine is solid but our compliance, audit, and contract-claims story will never match P6 + Deltek for capital projects. **Out of scope by design.**
- **Trina the Trello Refugee** — 5-person creative agency that just needs a list of cards with due dates. TruePPM's CPM, sync conflict resolution, role matrix, and portfolio model are pure overhead she will never use. Send her to Trello, Asana, or Linear. **A persona-fit failure, not a feature gap.**
- **Frank the Fortune 50 Buyer** — Buys at the SAP / Oracle / Workday tier. Wants global tax engine integration, ERP-native PPM, white-glove onboarding, custom contractual SLAs, dedicated CSM. Our open-core model and team size aren't a fit; serving Frank distracts from Marcus. **Punt indefinitely.**
- **Carla the Compliance-First Federal** — DoD / FedRAMP Moderate or High / IL5 buyer. Possibly addressable eventually, but not in the near term. Until we have FedRAMP Moderate authorization, government compliance asks should not drive product priorities. **Deferred indefinitely.**
- **Stan the Solo Freelancer** — One-person consultancy tracking his own time across 3 clients. Doesn't need scheduling, sync, RBAC, or boards. A spreadsheet plus Toggl is the right answer for him. **A market we cannot serve well.**

When a feature is justified primarily by an anti-persona's pain — push back. They are not the customer, and chasing them dilutes what makes us valuable to Sarah, Marcus, Priya, David, Janet, and Alex.
