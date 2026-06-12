---
title: My Work
description: A contributor's personal task list across every project, with zero project-management vocabulary.
---

:::note[0.1]
My Work shipped in 0.1.
:::

:::note[0.3]
In 0.3 My Work will group your tasks into **Today / This Sprint / Upcoming** instead of by sprint, and will flag **blocked** work with a badge.
:::

**My Work** is the contributor's page. It lists every task assigned to you, across every project you're on, grouped into what needs your attention today, what's committed to this sprint, and what's coming up. There's no Gantt chart, no work-breakdown tree, no critical-path math — just a flat list of what's yours, what's due, what's blocked, and what you can update with a tap.

Open it from **My Work**, pinned at the top of the sidebar (with a due-today count badge when there's something actionable), or from your avatar menu. The route is `/me/work`.

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

Tasks are grouped into three sections, computed on the server so every client groups them the same way:

1. **Today** — anything due today or overdue (and not yet done). What you should pick up first.
2. **This Sprint** — your remaining work committed to the current active sprint.
3. **Upcoming** — everything else assigned to you.

Within each section, **blocked** tasks sort first, then by due date and priority. A blocked task shows a red **Blocked** badge with the reason a teammate gave — so you can see what's stuck without opening it.

:::note[0.3]
The Today / This Sprint / Upcoming grouping and the blocked badge land in 0.3. Before 0.3, My Work groups by active sprint.
:::

## Status updates

Tap the status chip on any row. A small picker opens with four choices. Pick one and the task updates immediately — the change is sent to the server in the background and other people who have the project open see the new status within a couple of seconds.

If the update fails (server unreachable, conflict with someone else's change), the chip rolls back and a toast explains what happened.

## Working offline

The page is cacheable and the mobile app keeps it available without a signal. Status taps queue while you're offline and replay when the connection comes back. A banner at the top of the page tells you when you're working offline so changes aren't a surprise.

## Where tasks come from

Tasks appear in My Work when:

- A **project manager assigns** you to a task in their project.
- You **create a task** in a project you're a member of and put yourself on the assignee field.
- **An external tool pushes** a task into the project via [Inbound task sync](/features/inbound-task-sync/) — Jira, Linear, GitHub Issues, or any custom source. The payload's assignee email is resolved to a TruePPM user, so a pushed task that's yours lands here automatically.

Separately, [Connected accounts](/features/connected-accounts/) let you attach your own GitLab/GitHub credentials to see live MR, PR, and issue status on the tasks themselves.

## What you don't see

This page deliberately omits:

- The schedule chart and dependency tree (those live in the project's Schedule view — click a task name to jump there)
- The work-breakdown structure tree and phase hierarchy
- Float, baseline, and other PM-only fields
- Other people's tasks — even your project manager only sees their own tasks on this surface

The PM-facing "My Tasks" view inside each project is a different surface. It shows tasks due this calendar week and is part of the project overview; My Work is your cross-project list and includes everything assigned, not just the immediate week.

## Notifications and settings

Two changes will land in 0.3 to make the contributor experience quieter and less PM-heavy:

- **Signal-only notifications.** Your notification preferences will offer a one-click **Signal-only** profile — you'll only hear about blocked work and deadline changes, with everything else turned off. A "Show all notification types" link expands the full matrix if you want finer control. Project managers keep the full matrix by default.
- **A focused settings view.** If you don't administer any project or workspace, Settings will show just **Notifications** and **Profile** — the methodology, workflow, roles, and groups pages stay with the people who manage them.

## What's planned

- A `Blocked` indicator derived automatically when a predecessor task is incomplete — distinct from the explicit, teammate-raised blocker badge that lands in 0.3 (that one is a human signal, not computed from dependencies).
- Two-way status sync that pushes a status change back to the external tool the task came from. The OSS edition is import-only; the enterprise connector handles two-way sync.
- A "Team work" view for scrum masters who need the same list for everyone on their team — open as a sibling endpoint when the work is prioritized.

## API

`GET /api/v1/me/work/` returns the same data the page consumes. Limit/offset paginated (default page size 100, max 200). The response is a deliberately flat shape with no CPM fields. See the [API reference](/api/reference/) for the schema.

Status updates use the standard task PATCH endpoint with a `X-Source: my_work` header so downstream webhook subscribers can distinguish a status flip from My Work from a status flip from the schedule canvas.
