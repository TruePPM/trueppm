# TruePPM — Core Personas

Single source of truth for all six TruePPM user personas. Skills and CLAUDE.md
reference this file — do not duplicate persona content elsewhere.

## P3M Layer → Persona Mapping

```
Senior Leadership  ←→  Janet (Executive Sponsor / COO)
       ↕                   Receives: portfolio performance info, RAG status, forecasts
                           Sends: strategy, investment decisions to Portfolios

Portfolios         ←→  Marcus (PMO Director) + David (Resource Manager)
       ↕                   Receives: performance information and progress from projects
                           Sends: desired outcomes, benefits targets to Programs/Projects

Programs/Projects  ←→  Sarah (Project Manager)
       ↕                   Receives: outcomes/benefits targets from portfolio
                           Sends: deliverables + support info to Operations

Operations         ←→  Alex (Scrum Master / Agile Delivery Lead) — coordinates execution
       ↕                   Receives: delivery targets; translates to sprints
                           Sends: velocity, burndown, impediment reports upward
                       Priya (Team Member — execution and maintenance)
                           Receives: sprint tasks, acceptance criteria
                           Sends: updates, fixes, value performance analysis back up
```

**Feature resonance rule:**
- Features loved primarily by **Sarah, Alex, or Priya** → Programs/Projects or Operations → **OSS**
- Features loved primarily by **Marcus or Janet** → Portfolio or Senior Leadership → **Enterprise**
- **David** spans both: project-level allocation (OSS) vs. cross-project heat maps (Enterprise)
- **Alex** is always OSS: sprint facilitation, velocity tracking, impediment management, and ceremony tooling are single-project operations
- A feature that aggregates data *across* projects serves Marcus/Janet, not Sarah or Alex

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
- **Alex (Scrum Master)**: Sees a two-week window. "What does the team commit to this sprint, and are we on track to finish it?" The project timeline is background noise; the sprint boundary is everything.
- **David (Resource Mgr)**: Sees the Maturity phase problem. Projects 4, 5, 6 running simultaneously means three PMs all want the same engineers.
- **Priya (Team Member)**: Sees her task list. Project number, program, sprint — invisible to her day-to-day.

**Feature resonance rule**: If a feature is most useful at the "peak" of the S-curve (Maturity, multiple concurrent projects) it belongs in Enterprise. If it's useful at any single point on the curve (one project at a time), it belongs in OSS.

---

## Persona 1 — Project Manager

**Name**: Sarah Chen
**Title**: Senior Project Manager, Mid-size Construction Firm (200 employees)
**Age**: 38 | **Tech comfort**: Moderate (uses MS Project reluctantly, loves mobile apps)

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

---

## Persona 4 — Resource Manager

**Name**: David Okafor
**Title**: Engineering Manager / Resource Manager, Professional Services Firm (800 employees)
**Age**: 43 | **Tech comfort**: Moderate-high (uses spreadsheets heavily, evaluates tools pragmatically)

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

---

## Persona 6 — Scrum Master / Agile Delivery Lead

**Name**: Alex Rivera
**Title**: Scrum Master & Agile Delivery Lead, Mid-size SaaS Product Company (120 engineers)
**Age**: 34 | **Tech comfort**: Very high (uses Jira, Linear, Confluence, Miro daily; PSM I certified — Professional Scrum Master, scrum.org)

**⚠️ Internal use only:** Persona credential names (PSM I, SAFe®, Release Train Engineer®)
are descriptive background for simulation purposes. They must not be reproduced in
product marketing, landing pages, or UI copy — doing so risks trademark claims.
SAFe® and Release Train Engineer® are registered trademarks of Scaled Agile, Inc.
PSM and Professional Scrum Master are trademarks of Scrum.org.

**Scrum Guide accuracy notes** *(Scrum Guide 2020 © Ken Schwaber and Jeff Sutherland,
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/))*:
- The four named Sprint events are: Sprint Planning, Daily Scrum, Sprint Review, Sprint Retrospective.
  "Daily standup" is informal colloquial usage, not the official term.
- Velocity and burndown/burn-up are **not** defined in the Scrum Guide 2020. They are XP-era
  practice-layer metrics widely adopted in the Scrum community but outside the framework proper.
- Story points are XP-origin (Ron Jeffries), not a Scrum artifact. The Guide says Developers are
  responsible for sizing but specifies no unit. (~61% of teams use story points per Parabol 2024.)
- WIP limits are Kanban (Kanban Method, David Anderson), not Scrum. Using them creates a
  Scrumban hybrid — a real and recognized pattern, but not vanilla Scrum.
- Scope protection mid-sprint: the Scrum Guide assigns scope negotiation to Developers + Product
  Owner jointly. The SM's role is facilitation and coaching, not gatekeeping.
- At 120 engineers (~12–15 Scrum Teams), Alex serves 2–3 teams. "Agile Delivery Lead" reflects
  multi-team scope and PMO-bridge responsibility closer to Agile Coach or Release Train Engineer.

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
