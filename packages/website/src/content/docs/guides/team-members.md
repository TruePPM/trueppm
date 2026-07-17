---
title: For Team Members
description: How TruePPM keeps you focused on your work — board, sprints, tasks, and updates — without PM overhead.
---

You want to know what you're working on, move things forward, and stay in sync with your team. TruePPM is designed to minimize the overhead of project management for people doing the actual work.

## Where to start: the board

The board is your primary view. Five columns: **Backlog → To Do → In Progress → Review → Done**. Your sprint's stories are here. Move a card to the right when its status changes.

When you move a card, that update propagates everywhere automatically — the PM's Gantt re-forecasts, the Scrum Master's burndown updates, and any connected clients see the change in real time. You did one thing. Everything else updated.

### What's on a card

Each card shows the task name, your avatar (if assigned), story points, the sprint it belongs to, and a progress ring. Cards with a red border have an unresolved dependency — check with your Scrum Master before pulling them into active work.

### WIP limits

Each column has a WIP limit. When a column is over its limit, it turns amber or red. This is intentional — the limit is there to stop work from piling up in one state. If you see a red column, the right move is to help finish something already in flight before starting something new.

→ See [Board](/features/board/), [WIP overload detection](/features/wip-overload/)

## Sprints

Your sprint is the two-week (or whatever length your team uses) window of committed work. At the start of each sprint, you and your team have agreed on what to build. At the end, the Scrum Master runs a retrospective.

### Sprint backlog

The sprint backlog table shows all tasks in the active sprint, grouped by board column (Done / In Review / In Progress / Not Started / Backlog). You can update status and see the critical path indicator for each task from here.

### Subtasks

Stories can have subtasks — a depth-1 checklist of smaller steps. Each subtask can have its own assignee. Progress on subtasks rolls up to the parent story automatically. Use subtasks for internal to-do lists within a story, not for work that needs to be independently scheduled.

→ See [Sprint backlog](/features/sprint-backlog/), [Subtasks](/features/subtasks/)

## Updates that matter

When you complete work, TruePPM doesn't just record it — it recalculates:

1. The sprint burndown (remaining story points drops immediately)
2. The work package your story rolls up into (remaining work recalculated)
3. The CPM schedule (if the work package is on the critical path, re-forecast propagates)
4. Every connected browser (WebSocket push, no refresh needed)

This is why you don't need to fill in status reports. Your board moves **are** the status.

## Your assignments

To see everything assigned to you across all your projects and sprints, use the **My Work** view. It surfaces your active sprint tasks first, then any tasks not yet in a sprint. You can update status directly from My Work without opening the full project.

→ See [My Work](/features/my-work/)

## Real-time and offline

Changes you make appear instantly for everyone on the project. Changes others make appear instantly for you. No manual refresh.

The sync protocol supports offline clients — it is built for the 0.5 mobile app, which will queue updates locally and replay them when the connection returns. The web app today requires a connection for writes.

→ See [Real-time collaboration](/features/real-time/), [Offline sync](/features/offline-sync/)

## Your role and what you can do

As a **Member**, you can:
- View all project data (tasks, dependencies, resources, calendars)
- Move cards on the board
- Update task status and log progress
- Pull delta sync for offline/mobile access
- Connect to the real-time WebSocket

You can't accidentally modify the schedule structure or break dependencies. That requires the **Scheduler** role or above.

## API access

If you live in the terminal, the REST API is the primary interface. The OpenAPI schema documents every endpoint, and JWT auth means you can script anything.

```bash
# Get your tasks in the active sprint
curl -s "http://localhost:8000/api/v1/tasks/?project=$PROJECT_ID&sprint=$SPRINT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.results[] | {name, status, story_points, is_critical}'
```

→ See [API reference](/api/reference/), [Quickstart](/getting-started/quickstart/)

## Evaluate it yourself (~5 minutes)

Seed the demo (`seed_demo_project --with-personas`) and sign in as **`tom`** — the team-member persona (password `demo`). The only question that matters: does this remove a click, or add one?

1. **Open My Work.** Everything assigned to you, across every project, active-sprint tasks first. Update status right here — you never have to open the full project.
2. **Move a card on the board.** That one action updates the burndown, the work package, the schedule, and every other open browser. You did one thing; everything else followed.
3. **Notice what you don't have to do.** No status report, no Friday-afternoon timesheet, no project-management vocabulary to learn.

The two things you'd want that aren't here yet — automatic Jira sync so you never double-enter (lands in **0.4**) and mobile time entry (offline-capable time entry via the installable PWA lands in **0.5**; the native app's 15-second capture in **0.6**).

## Getting started

1. Get your credentials from your project admin
2. Log in to the web UI at the URL your admin provides
3. Find the active sprint on the board or in the Sprints workspace
4. Seed the demo: `seed_demo_project --with-personas` — log in as `tom` to see the team member view
