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
