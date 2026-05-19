---
title: My Work
description: A contributor's personal task list across every project, with zero project-management vocabulary.
---

:::caution[Roadmap — 0.2]
This feature is designed and documented but not yet shipped. Target release: **0.2**.
:::

**My Work** is the contributor's page. It lists every task assigned to you, across every project you're on, grouped by your active sprints. There's no Gantt chart, no work-breakdown tree, no critical-path math — just a flat list of what's yours, what's due, and what you can update with a tap.

Open it from the **Me** section in the sidebar (`My Work`) or from your avatar menu. The route is `/me/work`.

## What you see

Each row shows:

- **Task name** — clicks open the task in its project's Schedule view
- **Project · sprint** — the project the task belongs to, and the active sprint if it's in one
- **Status chip** — tap to change between `Not started`, `In progress`, `In review`, and `Complete`
- **Story points** — `5pts` or `5pts · 2 left` when remaining points differ
- **Due date** with a source label so you know what the date means:
  - `Due May 30 (planned)` — the project manager committed to this date
  - `Due May 30 (estimated)` — the scheduling engine computed this date from the project's dependencies
  - `Ends with sprint` — the task doesn't have its own due date; it ends when the sprint ends
  - `Done May 28` — the task is already complete

A `⚠` icon to the left of the row appears when the task is on the schedule's critical path — a delay on that task delays the whole project. The icon's tooltip explains it in plain English; the words "critical path" never appear on the page.

## Groupings

Tasks are grouped from the top down:

1. **Active sprints first.** Each active sprint where you have at least one task gets its own section with a header showing the sprint name, the project, days remaining, and how many of your tasks are in that sprint.
2. **Not in a sprint** — a single group at the bottom for tasks that aren't currently in any sprint.

Within each group, tasks are ordered by start date (planned or estimated) and then by priority.

## Status updates

Tap the status chip on any row. A small picker opens with four choices. Pick one and the task updates immediately — the change is sent to the server in the background and other people who have the project open see the new status within a couple of seconds.

If the update fails (server unreachable, conflict with someone else's change), the chip rolls back and a toast explains what happened.

## Working offline

The page is cacheable and the mobile app keeps it available without a signal. Status taps queue while you're offline and replay when the connection comes back. A banner at the top of the page tells you when you're working offline so changes aren't a surprise.

## Where tasks come from

Tasks appear in My Work when:

- A **project manager assigns** you to a task in their project.
- You **create a task** in a project you're a member of and put yourself on the assignee field.
- A future release adds **external sync** from Jira, Linear, or GitHub — tasks pushed from those tools land here automatically once the inbound webhook is configured.

External sync is a planned follow-up (issue [#500](https://gitlab.com/trueppm/trueppm/-/issues/500)). Until it ships, the only way to land work in My Work is through TruePPM itself.

## What you don't see

This page deliberately omits:

- The schedule chart and dependency tree (those live in the project's Schedule view — click a task name to jump there)
- The work-breakdown structure tree and phase hierarchy
- Float, baseline, and other PM-only fields
- Other people's tasks — even your project manager only sees their own tasks on this surface

The PM-facing "My Tasks" view inside each project is a different surface. It shows tasks due this calendar week and is part of the project overview; My Work is your cross-project list and includes everything assigned, not just the immediate week.

## What's planned

- A `Blocked` indicator when a predecessor task is incomplete (deferred to a later release to avoid an N+1 query on the cross-project endpoint).
- Two-way status sync that pushes a status change back to the external tool the task came from. The OSS edition is import-only; the enterprise connector handles two-way sync.
- A "Team work" view for scrum masters who need the same list for everyone on their team — open as a sibling endpoint when the work is prioritized.

## API

`GET /api/v1/me/work/` returns the same data the page consumes. Cursor paginated (default page size 100, max 200). The response is a deliberately flat shape with no CPM fields. See the [API reference](/api/) for the schema.

Status updates use the standard task PATCH endpoint with a `X-Source: my_work` header so downstream webhook subscribers can distinguish a status flip from My Work from a status flip from the schedule canvas.
