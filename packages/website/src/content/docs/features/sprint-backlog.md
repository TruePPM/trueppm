---
title: Sprint backlog table
description: Active-sprint tasks grouped by board status, with CP flags and owner avatars.
documentedFor: "0.4"
---

The bottom panel of the Sprints view. Every task in the active sprint, grouped by board status (Done · In Review · In Progress · Not Started · Backlog), with CP flags on critical-path tasks and owner avatar chips.

## Where this lives in the story

Step 6 ([Execute](/the-story/#6-execute--daily-cadence-two-worlds-in-sync)) of the [hybrid PM flow](/the-story/) — the table Tom and Maya scan during standup; the table Raj never opens but whose contents drive his Gantt re-forecast.

## What you see

- **Section header** — `SPRINT BACKLOG · {N} tasks · grouped by board status · {N} pts committed`
- **Group headers** — `Done`, `In Review`, `In Progress`, `Not Started`, `Backlog` — collapsible, state persists in `sessionStorage`
- **Per-row columns** — short id, name, points, CP flag (semantic-critical outlined), owner avatars, board status chip
- **`c` to add task** keyboard hint — opens the create-task modal pre-targeted at the active (or planned) sprint. Rebound from `⌘K`, which is reserved for the global command palette
- **`Open in board`** link — navigates to `/projects/:id/board?sprint=:sprintId`
- **`Pull from backlog →`** button (planned sprints only) — while a sprint is still being planned, this opens the **story picker** in place: a multi-select list of the project's backlog stories, with the sprint's capacity preflight and committed-points readout staying live as stories are selected. An empty planned sprint surfaces it as the primary call-to-action, so a freshly created sprint points the team at where work is pulled in rather than showing a dead-end empty table.

:::note[Ships in 0.4]
The **in-place picker** described above ships in **TruePPM 0.4**. The latest
released version is `v0.3.0-alpha.3`, where `Pull from backlog →` is a plain
link that navigates to the [Product Backlog](/features/product-backlog/) page —
existing stories are committed one at a time from there via the per-row commit
toggle, and the sprint's own context (goal, capacity, committed points) is left
behind for the round trip.
:::

### Story picker

Opens as a dialog over the Sprints page. Every backlog story shows its points and
[Definition of Ready](/features/product-backlog/#definition-of-ready) state:

- **Ready only** (default) — the picker's starting view, so a story missing an
  estimate or an unmet acceptance criterion is not offered by default. A count
  ("N not-ready stories are hidden") plus a **Show all** toggle always reveals
  the rest — sorted ready-first, dimmed, with the specific reason each is
  blocked (`needs an estimate`, `add at least one acceptance criterion`, `all
  acceptance criteria must be met`) — so a story is never silently absent.
- **Selecting a not-ready story** is never blocked. It surfaces an inline
  advisory note ("N selected stories are not marked Ready — you can still pull
  them into the sprint") and the commit button stays enabled — the same
  advisory-only READY gate every other backlog surface uses.
- **Commit** applies to every selected story in one action (`PATCH` each
  story's `sprint`), closing the picker on success. The default "Ready only"
  starting filter is a per-project, per-program, or per-workspace setting
  (**General → Sprint planning**, inherited workspace → program → project) —
  overridable per session in the picker regardless of the configured default.

## Where to find it in the app

- Route: `/projects/:projectId/sprints` (below the timeline strip)

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/tasks/?project={pid}&sprint={sid}` | Sprint-filtered task list |

The `sprint=none` filter returns the project backlog (sprint-less tasks).

## Why the order is reverse-flow (Done first)

Reads right-to-left through the board flow — the team's most recent wins are top of the panel, the not-yet-started work is at the bottom. Mirrors how a Scrum Master reviews progress at standup ("what shipped, what's in flight, what's next").

## Related ADRs

- [ADR-0037](/architecture/decisions/) — Sprint task FK + story_points + filtering
- [ADR-0039](/architecture/decisions/) — Board column config (used for status chip colors)

## If you are…

- **Tom (engineer)** — the rows assigned to you with CP flags are the work that delays the project end date. Treat them first.
- **Maya** — collapse Done at standup so the active rows dominate the screen.
