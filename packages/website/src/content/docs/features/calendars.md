---
title: Calendars
description: Working-day calendars define which days and hours count toward task durations, so the schedule reflects real availability — weekends, holidays, and part-time hours included.
---

A **calendar** defines which days are working days and how many hours a working day holds.
The scheduling engine uses it to convert a task's duration (expressed in working days) into
real calendar dates — skipping weekends and holidays so your finish dates reflect actual
availability.

:::note[0.1]
Calendars shipped in 0.1 and are part of the **Community (OSS)** edition.
:::

## What a calendar contains

| Setting | Meaning |
|---------|---------|
| **Working days** | Which days of the week count as working (default Monday–Friday). |
| **Hours per day** | Length of a working day. Accepts fractions — set `6.0` for a six-hour day. |
| **Time zone** | The zone the calendar's dates are interpreted in (default UTC). |
| **Exceptions** | Date ranges that override the weekly pattern — public holidays, company shutdowns, or one-off non-working spans. |

Because **hours per day** is a decimal, part-time and custom-hour teams are first-class:
a calendar with a 6-hour day stretches the same task duration across more elapsed days
than a standard 8-hour calendar.

## How calendars attach

A calendar attaches to a **project** — every task in that project schedules against it by
default. A **resource** can carry its own calendar to model an individual's availability
(for example, someone who doesn't work Fridays); where a resource has no calendar, the
project's calendar applies.

## Composable working calendars

:::note[0.4]
Applying **multiple** calendars to one project — the overlay described here — ships in
0.4 in the **Community (OSS)** edition.
:::

A project's effective non-working time will be the **overlay (union)** of every calendar
applied to it, not just a single calendar. A project will apply:

- a **base project calendar** — the org standard work week and hours;
- a reusable **holidays calendar** — public holidays, created once and applied to many
  projects; and
- an optional **workspace / shutdown calendar** — for an org-wide winter shutdown.

A day counts as **non-working if *any* applied calendar marks it so**: the weekly
patterns compose by intersection (a weekday is working only when every applied calendar
treats it as working) and the holiday/shutdown exceptions compose by union. Because the
overlay is a union, the order calendars appear in is a display grouping only — it never
changes the computed schedule.

A **Working calendars** panel in Project Settings will let anyone with the Resource
Manager (Scheduler) role or above apply and reorder a project's calendars and preview the
**effective working time** day-by-day — each non-working day showing *which* applied
calendar blocked it. Reading the applied set and its preview will be open to any project
member; changing it will require the Scheduler role, the same gate as editing the
schedule.

Applying calendars to a project draws only on the shared calendar **library** — the same
calendars managed below. Per-resource / PTO calendars that make a task's duration depend
on *who* is assigned, holiday-feed (iCal) import, and cross-program calendar governance
are **not** part of this release.

| Method & path | Purpose |
|---|---|
| `GET /api/v1/projects/{id}/calendars/` | The calendars applied to a project (base + overlays) |
| `PUT /api/v1/projects/{id}/calendars/` | Replace the applied set (base calendar + ordered overlays) |
| `GET /api/v1/projects/{id}/calendars/preview/?start=&end=` | Per-day effective working time, with the source that blocked each non-working day |

## Effect on the schedule

During the CPM forward and backward passes, non-working days — weekends, plus any day
inside a calendar exception — are skipped entirely. A task with a 5-day duration starting
on a Thursday finishes the following Wednesday on a Monday–Friday calendar, not the
following Monday. Add a holiday exception in that span and the finish slides another day.

## Managing calendars

Calendars are managed via the REST API (a visual settings editor is planned):

| Method & path | Purpose |
|---|---|
| `GET /api/v1/calendars/` | List calendars |
| `POST /api/v1/calendars/` | Create a calendar |
| `GET /api/v1/calendars/{id}/` | Retrieve (with exceptions) |
| `PATCH /api/v1/calendars/{id}/` | Update |
| `DELETE /api/v1/calendars/{id}/` | Delete |

Any authenticated user can read calendars; creating and editing them requires the
Project Manager or Project Admin role on at least one project.

## Managing exceptions

Exceptions — the holiday and shutdown date ranges that override a calendar's weekly
pattern — are managed through a nested sub-resource on the calendar. The exceptions
sub-resource **lands in 0.4**.

| Method & path | Purpose |
|---|---|
| `GET /api/v1/calendars/{id}/exceptions/` | List a calendar's exceptions |
| `POST /api/v1/calendars/{id}/exceptions/` | Add an exception |
| `GET /api/v1/calendars/{id}/exceptions/{exc_id}/` | Retrieve one exception |
| `PATCH /api/v1/calendars/{id}/exceptions/{exc_id}/` | Edit an exception |
| `DELETE /api/v1/calendars/{id}/exceptions/{exc_id}/` | Remove an exception |

An exception carries a start date (`exc_start`), an end date (`exc_end`), and an
optional `description`. Set `exc_start` equal to `exc_end` for a single non-working
day; `exc_end` must fall on or after `exc_start`. Overlapping ranges are allowed —
the scheduler treats their union as non-working.

The parent calendar is taken from the URL, never the request body: an exception
always belongs to the calendar it was created under and cannot be reassigned. Any
authenticated user can read exceptions; creating, editing, and deleting them requires
the Project Manager or Project Admin role — the same gate as editing the calendar
itself.

Adding, editing, or removing an exception recomputes every project scheduled against
the calendar — whether the calendar is that project's base or one of its overlays — so
dependent task dates stay true to the new working time. The change also rides the
calendar's sync delta to offline clients, keeping critical-path math holiday-aware
offline. (Offline recompute composes against a project's base calendar only until the
overlay set flows through the sync delta — a tracked follow-up; the server always
computes against the full composed set.)
