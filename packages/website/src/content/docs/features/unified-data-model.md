---
title: Unified data model
description: How one task hierarchy powers Waterfall, Agile, and Hybrid workflows without translation layers or duplicate data.
---

Most "hybrid" project management tools are two tools bolted together. TruePPM is not. Every view — Schedule, Board, Sprints, WBS — reads and writes the same rows in the same database. There is no sync, no translation, no eventual consistency.

This page explains the data model that makes this possible.

## The core entity: Task

Every item of work in TruePPM — a WBS phase, a deliverable task, a sprint story, a milestone — is a single `Task` row. The row carries fields that are relevant in different contexts, and different views surface different subsets of those fields.

```
Task
 ├── Identity
 │     id            UUID primary key
 │     name          string
 │     wbs_path      ltree  (e.g. "1.2.3" — position in WBS hierarchy)
 │     project       FK → Project
 │
 ├── Scheduling (CPM — Waterfall + Hybrid)
 │     duration          integer  (working days)
 │     planned_start     date     (PM's committed start — gates CPM early_start)
 │     early_start       date     (CPM forward-pass output)
 │     early_finish      date     (CPM forward-pass output)
 │     late_start        date     (CPM backward-pass output)
 │     late_finish       date     (CPM backward-pass output)
 │     total_float       integer  (working days of schedule slack)
 │     free_float        integer
 │     is_critical       boolean  (on the critical path)
 │     is_milestone      boolean  (zero-duration gate event)
 │
 ├── Monte Carlo (probabilistic forecasting)
 │     optimistic_duration     integer  (3-point estimate, working days)
 │     most_likely_duration    integer
 │     pessimistic_duration    integer
 │
 ├── Execution (Board — all methodologies)
 │     status          BACKLOG | NOT_STARTED | IN_PROGRESS | REVIEW | COMPLETE
 │     assignee        FK → User
 │     percent_complete  integer
 │     actual_start    date     (auto-set on IN_PROGRESS transition)
 │     actual_finish   date     (auto-set on COMPLETE transition)
 │
 ├── Agile (Sprints — Agile + Hybrid)
 │     sprint          FK → Sprint  (null = project backlog)
 │     story_points    integer      (nullable — agile estimate)
 │     remaining_points integer     (live burndown signal)
 │
 └── Flags
       is_milestone    boolean  (zero-duration gate)
       is_subtask      boolean  (depth-1 checklist item, no independent schedule)
       notes           text
```

No methodology owns any field. A waterfall PM fills in `duration` and leaves `story_points` null. A scrum team fills in `story_points` and uses `duration` to let CPM compute a delivery date. A hybrid team fills in both — the PM owns duration and the team owns points — and both views stay live simultaneously.

## The WBS hierarchy

Tasks are arranged into a tree using a PostgreSQL `ltree` column (`wbs_path`). A path of `"1.2.3"` means: first top-level phase → second child → third grandchild.

```
Project
  └── 1       Phase: Discovery          (duration auto-rolled up from children)
        ├── 1.1   Task: Stakeholder interviews
        ├── 1.2   Task: Requirements doc
        └── 1.3   Milestone: Discovery sign-off
  └── 2       Phase: Build
        ├── 2.1   Task: API design       ← sprint FK set → Sprint 3
        ├── 2.2   Task: Frontend         ← sprint FK set → Sprint 3
        └── 2.3   Task: Integration test ← sprint FK set → Sprint 4
  └── 3       Phase: Deploy
```

The **same tree** is the source for every view:

| View | Reads from the WBS tree | Key fields used |
|------|------------------------|----------------|
| **WBS / Table** | Full tree, indented | `wbs_path`, `name`, `status`, `duration` |
| **Gantt / Schedule** | Committed tasks (non-BACKLOG) | `early_start`, `early_finish`, `total_float`, `is_critical`, dependency edges |
| **Board** | Working columns by status (To Do → In Progress → Review → Done) with Backlog in a side rail; optional phase swimlanes | `status`, `assignee`, `sprint`, `story_points` |
| **Sprints** | Tasks where `sprint_id = current_sprint` | `story_points`, `remaining_points`, `status` |
| **Overview** | Aggregate rollups | burndown, velocity, CPM forecast, Monte Carlo P80 |

No data is copied between views. When the Board is grouped into phase swimlanes (an optional grouping), those lanes are WBS phases. The Schedule view's bars are the same rows the Board's cards render. The sprint burndown reads `remaining_points` from the same rows the Schedule view uses for float.

## How each methodology uses the model

### Waterfall

A waterfall PM works entirely with `duration`, `planned_start`, dependencies, and CPM output fields. The Board is still available but secondary. Story points are left null. Sprints are not created.

```
Typical waterfall task:
  name:           "Develop payment API"
  duration:       10
  planned_start:  2026-02-03
  early_start:    2026-02-03   ← CPM output
  early_finish:   2026-02-14   ← CPM output
  total_float:    0            ← on the critical path
  is_critical:    true
  sprint:         null         ← not sprint-managed
  story_points:   null         ← not estimated in points
  status:         NOT_STARTED  ← board column
```

The Schedule view renders the bar from `early_start`/`early_finish`. The Board shows the task card in the NOT_STARTED column. Neither view requires any duplicate row.

### Agile

An agile team works entirely with `sprint`, `story_points`, `remaining_points`, and `status`. The Schedule view is hidden (via the Agile methodology preset). CPM is still computed in the background — `duration` defaults to 1 day for backlog items — but the team never looks at it. The WBS is flat or minimal.

```
Typical agile task ("story"):
  name:           "User can reset password"
  duration:       1            ← default; CPM runs but results ignored
  sprint:         Sprint 4     ← sprint membership
  story_points:   5            ← agile estimate
  remaining_points: 3          ← updated daily by assignee
  status:         IN_PROGRESS
  early_start:    null or ignored by the team
```

The Board renders this as a card in the IN_PROGRESS column. The sprint burndown consumes `remaining_points`. No separate "agile database" exists.

### Hybrid

A hybrid team uses both sets of fields on the same rows. The PM sets `duration` and `planned_start`; the team sets `story_points`. A task can live in Sprint 3 (agile planning) and also be on the critical path (CPM scheduling). The Monte Carlo engine uses `optimistic_duration` / `most_likely_duration` / `pessimistic_duration` to compute delivery confidence.

```
Typical hybrid task:
  name:              "Implement auth service"
  duration:          8          ← PM's scheduling estimate
  optimistic_duration:  5
  most_likely_duration: 8
  pessimistic_duration: 13
  planned_start:     2026-03-10
  early_start:       2026-03-10  ← CPM
  total_float:       0           ← critical
  sprint:            Sprint 5    ← team's execution context
  story_points:      13          ← team's complexity estimate
  remaining_points:  8           ← current burndown
  status:            IN_PROGRESS
```

Raj sees a Schedule-view bar with float and critical-path coloring. Maya sees a sprint card with story points and remaining effort. They're looking at the same database row. When Maya moves the card to COMPLETE, `actual_finish` is set, CPM re-runs, and Raj's Schedule view updates in real time via WebSocket — without either of them touching a sync button.

## Why no translation layer

Most hybrid tools are integrations: Jira ↔ MS Project, Azure DevOps ↔ Project Online, Smartsheet ↔ Jira. These have three failure modes:

| Failure | Integration tool | TruePPM |
|---------|-----------------|---------|
| **Eventual inconsistency** | "Gantt is as of last sync, 4 hours ago" | Same row — always live |
| **Lossy translation** | Epic → Project task loses story points; Project task → Jira loses float | No translation; both fields on the same row |
| **Permission divergence** | Tom has Jira access; Sarah has Project access. Information leaks both ways. | One RBAC check per request, one role per user per project |

The data model is the integration. There is nothing to sync.

## The methodology preset is a view filter

Setting a project to Waterfall, Agile, or Hybrid hides tabs in the UI — it does not change, migrate, or delete any data. A project can be switched from Agile to Hybrid and back without consequence. API routes are never gated by methodology; the preset is purely a UI signal.

See [Methodology preset](/features/methodology-preset/) for the tab visibility matrix.

## Related

- [Scheduler](/features/scheduler/) — how CPM and Monte Carlo consume the task fields
- [Methodology preset](/features/methodology-preset/) — which views are shown per methodology
- [The Story](/the-story/) — the eight-step hybrid flow, end-to-end
- [Architecture overview](/architecture/overview/) — versioned models, real-time broadcasts, and the sync protocol
