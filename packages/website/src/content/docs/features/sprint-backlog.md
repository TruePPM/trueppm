---
title: Sprint backlog table
description: Active-sprint tasks grouped by board status, with CP flags and owner avatars.
---

The bottom panel of the Sprints view. Every task in the active sprint, grouped by board status (Done · In Review · In Progress · Not Started · Backlog), with CP flags on critical-path tasks and owner avatar chips.

## Where this lives in the story

Step 6 ([Execute](/the-story/#6-execute--daily-cadence-two-worlds-in-sync)) of the [hybrid PM flow](/the-story/) — the table Tom and Maya scan during standup; the table Raj never opens but whose contents drive his Gantt re-forecast.

## What you see

- **Section header** — `SPRINT BACKLOG · {N} tasks · grouped by board status · {N} pts committed`
- **Group headers** — `Done`, `In Review`, `In Progress`, `Not Started`, `Backlog` — collapsible, state persists in `sessionStorage`
- **Per-row columns** — short id, name, points, CP flag (semantic-critical outlined), owner avatars, board status chip
- **`⌘K to add task`** keyboard hint — placeholder until the task creation command palette ships
- **`Open in board ↗`** link — navigates to `/projects/:id/board?sprint=:sprintId`
- **`Pull from backlog →`** link (planned sprints only) — while a sprint is still being planned, the panel links across to the [Product Backlog](/features/product-backlog/), where existing stories are committed into the sprint. An empty planned sprint surfaces it as the primary call-to-action, so a freshly created sprint points the team at where work is pulled in rather than showing a dead-end empty table.

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
