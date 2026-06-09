# ADR-0036: Hybrid PM Philosophy and Sprint Model

## Status
Accepted

## Context

TruePPM has strong coverage of traditional P3M: CPM scheduling, Schedule view, WBS, baselines,
MS Project import/export, resource allocation, Monte Carlo forecasting. The Kanban board
(ADR-0013) added agile-friendly task tracking. But a real gap exists: there is no first-class
sprint model, no velocity tracking, and no burndown chart.

A Voice-of-Customer panel (2026-04-28, Persona 6 only — Alex Rivera, Scrum Master)
scored TruePPM 3/10 against agile use cases. Core finding: "The board is a Kanban
view. It is not a Scrum tool." Three blocking gaps:

A second full-panel VoC session (2026-04-28, all six personas) evaluated the
proposed sprint model from ADR-0037. Panel average: 5.8/10. Alex rose from 3 → 8.
Strongest signal: the hybrid positioning earns explicit endorsement from the persona
it was designed for. Biggest risk: sprint UI bleed into non-agile projects
(addressed by `Project.agile_features` gate in ADR-0037). Secondary risk: Jira
duplication concern from Priya (addressed by Jira ingest open question in ADR-0037).

Initial three blocking gaps that motivated this ADR:

1. No sprint container — commitment window with goal, capacity, start/end, and sprint backlog
2. No velocity tracking — teams export to spreadsheets at the end of every sprint
3. No burndown chart — no signal to act on mid-sprint

The session also surfaced a product strategy question: is supporting both traditional PM
(Schedule view, CPM, milestones) and agile delivery (sprints, velocity, retrospectives) too
ambitious? Could TruePPM become a "Swiss Army knife" without becoming mediocre at everything?

## Decision

### Philosophy: hybrid PM, not methodology-agnostic sprawl

TruePPM's position is **not** "one tool that does everything." It is the tool for teams
that already run hybrid — a PM who reports Schedule milestones to a client or PMO, and a
Scrum Master who runs two-week sprints with the delivery team, on the same project.

This is a real, underserved segment. Most teams in professional services, software
delivery, and product engineering live in this tension every day. The wrong solutions:

- Jira forces the agile frame upward. The PM exports a roadmap PDF and pretends it's a Gantt.
- MS Project forces the waterfall frame downward. The Scrum Master ignores it.
- ClickUp/Monday try to do everything but treat agile and waterfall as separate modules with
  no shared data model. Sprint completion has no effect on the Schedule view.

TruePPM's opportunity is the **integration point**: a completed sprint automatically
advances the project schedule. A slipping sprint raises a flag on the Schedule milestone.
A velocity trend informs the CPM engine's duration estimates. The two delivery modes
are views of the same underlying task graph, not separate modules.

### Design principle: decompose waterfall to agile, not replace it

Traditional project management produces a plan: phases, milestones, dependencies, a
critical path. Agile delivery executes that plan in iterative increments. These are
not competing philosophies — they are different levels of resolution on the same work.

TruePPM's sprint model follows this decomposition rule:

```
Phase (waterfall)
  └── Milestone (waterfall — a committed delivery point)
        └── Sprint (agile — a two-week execution window toward the milestone)
              └── Task / Story (shared — the atomic unit of work)
```

A sprint "belongs to" the phase/milestone it is progressing toward. When a sprint closes,
its completed tasks advance the Schedule view. The PM sees milestone progress; the Scrum Master
sees sprint velocity. Same data, two views, no reconciliation step.

This means:
- **Do not** require teams to choose a "mode" (waterfall vs agile). Both views are always
  available. A team that runs pure Kanban ignores sprints. A team that runs pure Scrum
  ignores the Schedule view. A hybrid team uses both.
- **Do not** build a separate "agile project type." Sprints are a first-class feature of
  every TruePPM project, alongside the Schedule view and the board.
- **Do not** store sprint data in a silo. Sprint tasks are project tasks. Sprint capacity
  draws from the project's resource assignments. Sprint completion feeds CPM recalculation.

### Accessibility principle: real work over methodology theater

TruePPM must not impose Scrum certification as a prerequisite. The target user is a
small team that has been running "sort of agile" in Jira or Trello — they know what a
sprint is, they want to track velocity, but they do not want to configure a 40-field
ceremony workflow before they can drag a card.

Concrete rules:
- Sprint creation requires three fields: name, start date, end date. Everything else optional.
- Story points are optional — tasks can be tracked by count if the team hasn't adopted
  point estimation. (Story points are XP-origin, not part of core Scrum; by common
  practice Developers are responsible for sizing but no unit is specified.)
- The four Sprint events (Sprint Planning, Daily Scrum, Sprint Review, Sprint Retrospective)
  are lightweight checklists in TruePPM, not enforced workflows. "Daily standup" is informal
  colloquial usage; "Daily Scrum" is the conventional term.
- WIP limits are Kanban-origin, not Scrum. Enabling them in
  a sprint context creates a Scrumban hybrid — a recognised and common pattern. They are
  warnings by default, not hard blocks (can be hardened per project).
- Velocity and burndown are XP/practice-layer tools, not core Scrum artifacts. They are
  widely treated as optional forecasting tools. TruePPM exposes them as
  practice-layer features, not framework mandates — teams that prefer flow metrics (cycle time,
  throughput) are not disadvantaged.
- The sprint model must be fully functional via the REST API with no UI dependency — teams
  that integrate from Jira or Linear via webhook should be able to push sprint data in.

### Anti-lock-in principle: Apache 2.0 and no methodology moat

Every agile feature in TruePPM is OSS (Apache 2.0). Sprint management is single-project
work — it belongs in the community edition alongside the Schedule view and CPM.

Proprietary PM tools (Jira, VersionOne, Rally) build moats by making their agile
artifacts non-portable. TruePPM's sprint, velocity, and burndown data must be:
- Fully exportable (included in the MS Project export and future CSV/JSON export)
- Accessible via the public REST API with no enterprise paywall
- Defined in terms of open standards where they exist (e.g. story points as integer fields,
  not opaque "Jira story points" format)

### Scope of this ADR

This ADR establishes the philosophy and decomposition model. The data model, API design,
and UI implementation for sprints are resolved in the architect review that follows
(see linked issues). This document is the "why" that should be consulted whenever a
sprint feature decision trades off against an existing Schedule view/CPM feature.

## Product Story

The clearest way to explain TruePPM's hybrid positioning is through a port analogy.

**The container ship and the dock**

A port operates at two speeds simultaneously. On the water, a container ship moves
slowly — course corrections are expensive, routes are planned months in advance, and
the shipping company's executives care only about one thing: did the cargo arrive at
the right port, on the right date, at the right cost? They steer the container ship from
the bridge. They do not visit the dock.

On the dock, the work is intense and time-boxed. A ship arrives and the clock starts.
The dock foreman has a two-week window to unload 3,000 containers before the berth is
needed for the next ship. They organize the crew into shifts, track throughput, protect
the team from being pulled off to a different berth mid-shift, and report up to the
port manager: "on track / behind / I need another crane."

The dock workers don't read the shipping manifest. They receive instructions from the
foreman and execute. The shipping company never speaks to them directly.

**How this maps to TruePPM's personas**

```
The Shipping Company (PMO / Janet / Marcus)
    — sets the route, signs the contracts, watches the S-curve
    — speaks in: program health, portfolio RAG, quarterly forecasts
    — does not care how the dock is organized

The Port Manager / Captain (Sarah, PM)
    — responsible for one voyage: depart date A, arrive by date B
    — bridges the shipping company's schedule and the dock floor
    — speaks both languages: Schedule milestones upward, sprint progress downward

The Dock Foreman (Alex, Scrum Master)
    — runs the dock floor in two-week sprints
    — tracks throughput (velocity), scope injection ("no, we can't add 500 containers
      mid-shift"), and team health (is anyone working 60-hour weeks?)
    — reports upward in dock language: burndown, velocity, impediments

The Dock Workers (Priya, Team Members)
    — load and unload containers; receive instructions from the foreman
    — don't care about the container ship's route or the shipping contract
    — need to know: which container, which crane, where does it go?
```

**The translation problem every hybrid team has today**

The port manager (PM) sits between two worlds that speak different languages. The
shipping company wants Schedule milestones. The foreman runs sprints. Today, the PM
manually translates between them — she attends the PMO steering committee with a
Schedule view export, then separately asks the foreman for sprint progress, converts that
into schedule language, and hopes the math is right.

If Sprint 3 closed at 80% completion, she adjusts the milestone forecast manually,
presents it at the Monday status meeting, and the PMO trusts the number because
they trust her — not because the data flows automatically.

**What TruePPM changes**

TruePPM connects the dock floor to the bridge. The foreman runs sprints natively.
The PM sees Schedule milestones. When Sprint 3 closes 20% short, the milestone
confidence updates automatically — AMBER appears on Marcus's portfolio dashboard
before the Monday meeting, not because the PM filed a manual status report, but
because the dock floor data and the project schedule are the same data model viewed
at different resolutions.

The shipping company never looks at a burndown chart. The dock workers never see
the Schedule view. But the burndown is the reason the Schedule view is trustworthy, and the
Schedule view is the reason the shipping company can make investment decisions. Each layer sees
exactly what they need, in the language they already speak, with no translation step
in the middle.

**The guard rails this story implies**

- The PMO layer (Marcus, Janet) must never be forced to configure or understand
  sprints. Their view is milestone health and portfolio RAG. Sprint data informs
  that view silently.
- The dock floor (Alex, Priya) must never be forced to maintain a Schedule view or speak
  in milestone language. Their view is the board, the burndown, and the sprint goal.
- The PM (Sarah) is the bridge — TruePPM must give her a single tool that speaks
  both, with no reconciliation step. That is the product's core promise.
- If a feature requires the dock foreman to understand the container ship's route, or
  requires the shipping company to understand the dock's shift patterns, the feature
  is designed wrong. It will be rejected by both.

## Consequences

**Positive:**
- TruePPM becomes the tool that hybrid teams have been waiting for — no methodology forcing
- Sprint completion auto-advances the Schedule view, eliminating the most common reconciliation pain
- Velocity provides probabilistic duration inputs to CPM, improving forecast accuracy
- Alex Rivera (Scrum Master persona) score rises from 3/10 to a projected 8/10 with full sprint model
- OSS positioning: the sprint model is a differentiator against proprietary agile tools

**Negative / risks:**
- Scope creep risk: "hybrid" can become an excuse to build everything. Guard: every sprint
  feature must answer "does this reduce ceremony overhead, or add to it?" If it adds
  overhead without proportional value, defer or drop.
- UI complexity: two delivery modes in one tool means more surface area. Mitigate by
  ensuring the Schedule view and sprint views are independently usable — a user who only uses one
  should not be confronted with the other.
- CPM integration is non-trivial: feeding sprint velocity back into the scheduling engine
  requires careful sequencing. This is a stretch goal for v1 of the sprint model; start
  with the sprint container and charts, add CPM feedback in a follow-on ADR.

## Alternatives considered

**Alt 1: Agile-only project type**
Build a separate project mode that replaces the Schedule view with a backlog and velocity view.
Rejected: forces teams to choose a methodology and destroys the hybrid value proposition.

**Alt 2: External integration only (Jira sync)**
Don't build native sprints — just sync from Jira. Rejected: most hybrid teams want a
single tool. Sync is additive (should still be built) but not a substitute for native
sprint management.

**Alt 3: Defer sprints to Enterprise tier**
Sprint management is a single-project feature. There is no cross-project aggregation
argument for enterprise classification. Rejected: would undermine OSS credibility and
hand the agile market to Jira permanently.

## Tracking

Tracking: design-only artifact (no implementation issue) — this ADR sets the hybrid PM
philosophy and sprint-model framing that downstream sprint/board ADRs and their issues
implement (e.g. ADR-0037, ADR-0073, ADR-0101).
