---
title: "The story — bridging two worlds"
description: How TruePPM bridges agile sprint cadence and waterfall schedule rigor on a single data model.
sidebar:
  order: 1
---

Most P3M tools force a choice. Jira speaks Agile and translates poorly to a Gantt chart. MS Project speaks Waterfall and ignores the team's actual cadence. **TruePPM is built so a Scrum Master and a Program Manager look at the same data — and each sees the view they need.**

This is the end-to-end flow, the personas it serves, and the gaps still on the roadmap.

## The two worlds problem

In every mid-to-large organization that ships software, infrastructure, or regulated programs, two parallel project management cultures coexist. They speak different languages, optimize for different metrics, and use different tools. The cost is friction at every handoff and a portfolio view the executive team simply does not believe.

| | Agile world | Waterfall world |
|---|---|---|
| **Unit of work** | User story, story points, acceptance criteria | WBS task with duration, predecessor, resource assignment |
| **Cadence** | 1–3 week sprints, daily standup, retro | Phase gates, milestones, baseline reviews |
| **Truth source** | The board (To Do / In Progress / Done) | The Gantt and the critical path |
| **Forecast** | Velocity-based, "we'll get to it when we get to it" | Deterministic dates, EVM, schedule variance |
| **Owner** | Scrum Master / Team Lead | Project Manager / PMO |
| **Tooling DNA** | Jira, Linear, ClickUp | MS Project, Primavera, Smartsheet |

:::caution[Why this matters]
The Project Manager has to write a status report on Monday. The team finished 23 story points last sprint. What does that translate to in CPM days remaining? In every existing tool, the answer is a spreadsheet, a meeting, and a margin of error wide enough to drive a portfolio off a cliff. **TruePPM's wedge is that the same task is both a story and a WBS node — no translation, no spreadsheet, no reconciliation meeting.**
:::

## The six personas

Hybrid PM is not abstract. It happens because six specific humans need different views of the same work. Build for all six and the tool wins. Build for any one of them and you become someone else's incumbent — the thing the next-generation tool will replace.

:::note[Persona names]
The six characters below are the narrative protagonists for this walkthrough — and the demo login names created by `seed_demo_project --with-personas` (Maya, Raj, Diana, Sarah, Carlos, Tom). TruePPM's [full product persona set](/overview/) expands these six to eight roles with more precise naming (Alex for Scrum Master, Sarah for PM, etc.). The story characters map directly to those eight personas.
:::

### Maya — Scrum Master
> "I just want my team to focus on this sprint. I don't want to fill in 14 fields every time the PM panics."

- **Cares about:** sprint health, blockers, WIP limits, velocity stability, retro actions
- **Hates:** status meetings, reporting overhead, anything that pulls eyes off the board
- **Won't tolerate:** a tool slower than Jira; won't open a Gantt voluntarily
- **Reads next:** [Sprints workspace](/features/sprints/), [Burndown](/features/sprint-burndown/), [Retrospective](/features/retrospective/)

### Raj — Project Manager
> "I have a contractual milestone October 15th. I need to know — today — whether we're going to make it."

- **Cares about:** critical path, milestone dates, schedule variance, dependency risk, EVM
- **Hates:** sprint reports that don't translate to a date; "on track" with no math behind it
- **Won't tolerate:** a tool that can't produce a baselined Gantt his exec sponsor recognizes
- **Reads next:** [Gantt](/features/schedule/), [Scheduler engine](/features/scheduler/), [Velocity panel](/features/velocity/)

### Diana — PMO Director
> "I need to know which two projects are about to slip and where to move resources before they do."

- **Cares about:** portfolio health, resource contention, dependency cascades, governance
- **Hates:** per-project status decks, stale data, "it depends" answers
- **Won't tolerate:** a view that takes 20 minutes to assemble from 6 spreadsheets
- **Reads next:** [Multi-team Sprints lens](/features/multi-team-lens/), [Methodology preset](/features/methodology-preset/)

### Sarah — Resource Manager
> "Three PMs just told me they need Priya next week. She has 12 hours."

- **Cares about:** allocation conflicts, utilization, skills coverage, hiring forecast
- **Hates:** every PM running their own resource plan in their head
- **Won't tolerate:** a capacity tool that doesn't reflect actual sprint commitments
- **Reads next:** [Capacity preflight](/features/capacity-preflight/), [Multi-team lens](/features/multi-team-lens/)

### Carlos — Executive Sponsor
> "Are we shipping the platform migration on time? One sentence."

- **Cares about:** outcomes, confidence intervals, financial exposure, go/no-go signals
- **Hates:** watermelon reports (green outside, red inside), false precision
- **Won't tolerate:** reading a 40-page status; will check on phone, in the elevator, twice a week
- **Reads next:** [Velocity panel](/features/velocity/), [Burndown](/features/sprint-burndown/)

### Tom — Team Member
> "Just tell me what I'm doing today. Don't make me hunt for it across three tools."

- **Cares about:** today's tasks, what's blocking him, what's actually due
- **Hates:** logging time, updating status fields, anything that isn't building
- **Won't tolerate:** an app that's slow on his phone or asks him to "fill in the WBS code"
- **Reads next:** [Sprint backlog](/features/sprint-backlog/), [WIP overload detection](/features/wip-overload/)

## The hybrid flow — eight steps from charter to close

This is the actual sequence of events from the day a program is chartered through the day a sprint demo informs an executive forecast. At each step, the agile and waterfall views diverge in presentation but stay anchored to the same underlying data.

### 1. Charter & decompose — the PM builds the WBS

**Actors:** Raj (PM), Diana (PMO)

Raj kicks off the platform-migration project. He builds a Work Breakdown Structure using TruePPM's `ltree`-backed hierarchy. Top-level phases (Discovery, Build, Migration, Cutover) become summary tasks. Each phase decomposes into deliverables, then into work packages.

The WBS is not stored in a separate "schedule" object that the team never sees. Every node is a row in `projects_task` — same table, same UUID, same `server_version` for sync. The team's future stories will live as leaf descendants of these work packages.

→ See [Scheduler engine](/features/scheduler/), [Methodology preset](/features/methodology-preset/)

### 2. Schedule the skeleton — CPM, milestones, baseline

**Actors:** Raj (PM)

Raj enters durations and dependencies on the work packages — not the leaves yet. The scheduler runs a forward and backward pass; the critical path lights up. He sets contractual milestones (UAT signoff, Cutover) and baselines the schedule.

- **Raj's view:** Gantt with critical path highlighted, baseline overlay, slack visualized per task, milestone diamonds on the contractual dates.
- **Maya's view:** Nothing yet. Stories don't exist. The board is empty. She sees a project name in the sidebar and ignores it.

→ See [Gantt](/features/schedule/), [Scheduler engine](/features/scheduler/)

### 3. Capacity preflight — the Resource Manager vetoes

**Actors:** Sarah (RM), Raj (PM)

Raj assigns roles (not people yet) to work packages. Sarah sees the demand land in her capacity heat map and immediately flags a contention: the migration phase needs two senior database engineers in October, but one is committed to a different program and the other is on PTO. Raj reschedules the phase or escalates for hire — before the sprint team has touched a single story.

:::tip[This is the win]
Capacity contention is caught at plan time, not discovered three sprints in. Most agile-first tools have no notion of this. Most waterfall-first tools don't reflect actual sprint commitments. TruePPM models both, so Sarah's view is real.
:::

→ See [Capacity preflight](/features/capacity-preflight/)

### 4. Decompose to stories — hand off to the team

**Actors:** Maya (SM), Raj (PM)

Raj walks Maya through the work packages in the Build phase. Maya breaks each package down into user stories — but here's the twist: every story she creates is a child task in TruePPM, automatically inheriting the work package as its parent in the WBS. Story points get assigned. Acceptance criteria are written on the story itself.

A story is just a leaf task with a `sprint` FK, a `story_points` field, and a parent pointing to a work package. Roll-ups happen automatically: the work package's remaining work is the sum of its story descendants. CPM keeps working because the work package still has its dependencies and a duration that is now forecast rather than estimated.

→ See [Sprints workspace](/features/sprints/)

### 5. Sprint planning — the team pulls work

**Actors:** Maya (SM), Tom (engineer)

Sprint 1 opens. Maya runs sprint planning on the board view. She drags stories from the backlog into the sprint. The team discusses, splits, estimates. Tom and his peers commit to 38 points based on a 3-sprint rolling average velocity of 41.

- **Maya's view:** standard Scrum board with WIP limits per column, daily standup view, [Plan Sprint dialog](/features/plan-sprint/) for the next iteration.
- **Raj's view:** the same stories, rolled up to their parent work package, appear on his Gantt with their forecast completion date based on velocity. TruePPM suggests a revised CPM duration for the work package, non-destructively — Raj reviews and applies it in one click. (As of 0.3, closing a sprint reforecasts the master schedule automatically.) If sprint commitment is materially off the work package's baseline, his schedule variance indicator turns yellow.

→ See [Sprints workspace](/features/sprints/), [Sprint backlog](/features/sprint-backlog/), [Plan Sprint dialog](/features/plan-sprint/)

### 6. Execute — daily cadence, two worlds in sync

**Actors:** Tom, Maya, Raj, Sarah

During sprint execution, Tom moves cards across the board. He never opens the Gantt. Maya runs standup against the board. Sarah watches actual hours roll up against allocated capacity. Raj watches the schedule view as velocity-based duration suggestions land on his work packages from real velocity and burndown.

When Tom marks a story done, the API:

```
1. Update task.status, task.actual_finish, task.server_version
2. Recompute parent work_package.remaining_points
3. Recompute the velocity-based forecast (velocity × remaining_points)
   and surface a non-destructive duration suggestion for the PM
4. If the forecast drifts > X days from baseline:
     mark schedule_variance flag, broadcast WS event
5. Recompute critical path if dependencies cross the threshold
6. Push WS event to all subscribed views
```

The reforecast is a suggestion loop by default — Raj reviews the velocity-suggested
durations and applies them non-destructively — and as of 0.3, closing a sprint
applies the reforecast to the master schedule automatically.

:::note[One source of truth]
Tom updated one card. Maya's burndown moved. Raj's Gantt picked up a fresh forecast. Sarah's capacity reconciled. Diana's portfolio dashboard updates the same way (roadmap: Enterprise portfolio dashboard), as will Carlos's exec view (roadmap: mobile exec view). **Zero status meetings to keep them consistent.**
:::

→ See [Sprint backlog](/features/sprint-backlog/), [Burndown chart](/features/sprint-burndown/), [WIP overload detection](/features/wip-overload/), [Real-time sync](/features/real-time/)

### 7. Forecast — Monte Carlo across both worlds

**Actors:** Raj, Diana, Carlos

Mid-program, Raj runs a Monte Carlo on the milestone forecast. The simulation pulls historical sprint velocity (real, not estimated) for the team-driven nodes and PERT-style three-point estimates for the deterministic ones. The result is a probability distribution on the milestone date.

**P50: Oct 12. P80: Oct 22. P95: Nov 1.** Carlos opens his exec view on his phone (roadmap: the mobile exec view will ship with the mobile app). He sees a single sentence: *"82% likely to make Oct 15. Risk: velocity has been declining 4 sprints running."* No watermelon. No false precision. A defensible probability backed by the team's actual history.

→ See [Velocity panel](/features/velocity/), [Scheduler engine](/features/scheduler/)

### 8. Close — retro, lessons learned, baseline variance

**Actors:** Maya, Raj, Diana

Sprint retros feed into the team's continuous improvement. Project closeout captures schedule variance against the baseline, cost variance against the budget, and a structured lessons-learned set. Diana's PMO archive is the next program's velocity prior.

Because every story, work package, milestone, and decision is in the same relational store, the closeout report is a query, not a content-creation exercise.

→ See [Retrospective panel](/features/retrospective/), [Multi-team Sprints lens](/features/multi-team-lens/)

## The translation layer — one data model, two views

The reason this works is structural, not cosmetic. A "translation layer" between Jira and MS Project is a brittle integration. TruePPM has no translation because there are not two systems — there is one task hierarchy, exposed through two rendering modes.

**Why this beats integration.** Most "hybrid" tools today are integrations: Jira talks to MS Project via Zapier, or Jira's Advanced Roadmaps loosely syncs to a third-party EVM tool. These integrations have three failure modes that TruePPM avoids by design:

- **Eventual inconsistency.** Two databases drift. The Gantt is "as of last sync, 4 hours ago." Decisions are made on stale data.
- **Lossy translation.** A Jira epic doesn't have a CPM duration. A Project task doesn't have story points. Each side fills in defaults that nobody trusts.
- **Permission divergence.** The agile tool and the schedule tool have separate user/role models. Tom has access to Jira but not Project; Raj has the inverse. Information leaks both ways.

TruePPM has one Postgres row per task, one permissions check per request, one `server_version` for sync, one outbox for real-time broadcast. Maya and Raj are looking at the same row from two angles.

## Visibility wins by persona

The proof of hybrid PM is what each persona *doesn't* have to do anymore.

| Persona | Pain in today's stack | What TruePPM gives them | Time saved / week |
|---|---|---|---|
| Maya | Re-entering sprint summary into a status doc the PMO requested. Explaining velocity to a PM who just wants a date. | Board view she lives in. Velocity automatically informs a forecast date her PM can read. No status doc. | ~3 hours |
| Raj | Reconciling sprint progress to his Gantt every Monday. Estimating "done-ness" of stories he can't see. | Real-time forecast on his Gantt, driven by actual sprint velocity. Critical path auto-recomputes. | ~5 hours |
| Diana | Begging 12 PMs for status decks every other Friday. Drift between what the deck says and what the team is actually doing. | Live portfolio dashboard (roadmap: Enterprise portfolio dashboard). Health computed, not reported. Drill-through to any team's actual board. | ~6 hours + meetings |
| Sarah | Maintaining a separate spreadsheet of who's allocated where, never trusting any PM's number. | Demand auto-aggregated from sprint commitments + waterfall assignments. Conflicts surfaced before they happen. | ~8 hours |
| Carlos | Reading watermelon decks. Asking "how confident?" and getting a shrug. | Phone view: 3 programs, P50/P80 confidence, one-line risk. Trend arrows on velocity, scope, burn (roadmap: mobile exec view). | Meetings he doesn't have to take |
| Tom | Three tools, two of which his manager's manager makes him update. | One mobile-first card view. Updates propagate everywhere. He never opens the Gantt. | ~2 hours + frustration |

## See it for yourself

The [`seed_demo_project`](/getting-started/quickstart/) management command bootstraps the data for the eight-step flow against a coherent "Platform Migration" project — WBS, CPM schedule, baseline, closed-sprint velocity history, an active sprint with mid-sprint burndown, risks, and a retro. Every step whose surface ships today (Schedule, Board, Sprints, Velocity, Retrospective) is walkable end-to-end; the Enterprise portfolio dashboard and mobile exec view are still on the roadmap. With `--with-personas` it also creates the six persona logins above.

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
```

Then sign in as `maya`, `raj`, `diana`, `sarah`, `carlos`, or `tom` (password: `demo`) and walk the story end-to-end on your own machine.

## The wedge — why this is the bet

Every existing P3M tool was born on one side of the line. Jira was a bug tracker that grew up. MS Project was a Gantt printer that learned to network. Smartsheet was a spreadsheet that added timelines. Each carries the assumptions of its origin into every release. Their hybrid stories are bolted on, never load-bearing.

TruePPM's bet is that the next generation of P3M is built on a single hierarchical task model — UUID-keyed, ltree-structured, sync-versioned — and exposes it through views that respect each persona's mental model. The Scrum Master gets a board. The Project Manager gets a Gantt. The Resource Manager gets a heat map. The Executive gets a phone. The Team Member gets a today list. None of them know they're looking at the same Postgres rows.

:::tip[The product wedge in one sentence]
A Scrum Master and a Project Manager can disagree on how to plan, but they should never disagree on what's true. **TruePPM makes truth a structural property of the system — not a status meeting.**
:::
