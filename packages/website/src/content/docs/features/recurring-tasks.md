---
title: Recurring tasks
description: Repeat a task on a calendar cadence — standups, weekly walks, monthly reviews — without it ever touching the critical path.
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is in alpha; the stable 0.2.0 release targets Jun 8, 2026.
:::

Recurring tasks let you repeat a task on a calendar cadence — a daily standup, a weekly safety walk, a monthly steering review — without hand-creating each instance. You configure the cadence once on a template task, and TruePPM spawns the upcoming occurrences for you.

The defining rule: **a recurring task never enters the schedule's CPM compute.** A recurrence is a parallel, calendar-driven activity, not a node in the project's logical network. A 365-occurrence daily standup has no business swamping the critical path, float, or the Monte Carlo P50/P80/P95 forecast — so recurring templates and every occurrence they generate are excluded from the scheduling engine entirely.

## Setting up a recurrence

Open a task's detail drawer and expand the **Recurrence** section. A task that doesn't repeat shows an **Add recurrence** button (visible to Resource Manager and above — see [permissions](#permissions)). The setup panel has:

| Field | What it does |
|---|---|
| **Repeats** | Daily, Weekly, Monthly, or Custom |
| **Every** | The interval — "every 2 weeks", "every 3 months". Custom is "every N days". |
| **On** | Weekly only: which weekdays the task repeats on |
| **Day of month** | Monthly only: the day (1–31; clamped to the month length, so 31 still fires in February) |
| **Time** | Time of day and an IANA timezone |
| **Ends** | Never, On a date, or After N occurrences |

As you edit, a **Next 4 occurrences** preview updates live so you can see exactly when the task will land before you save. A banner reminds you the task is excluded from the critical path and Monte Carlo while it recurs.

Click **Save recurrence** to attach the rule. The task immediately leaves the CPM graph and the schedule recomputes without it; **Stop recurring** detaches the rule (existing occurrences are kept) and the task rejoins the schedule.

## What each occurrence inherits

Per-occurrence inheritance is controlled by toggles on the rule:

- **Inherit assignees** — each occurrence is assigned to the same person as the template.
- **Inherit attachments** — the template's attachments are copied onto each occurrence (referencing the same stored file, not a duplicated upload).
- **Inherit subtasks** and **Notify assignees the morning of** are shown but **labeled "Not active yet"** — they are stored on the rule for a future release and have no effect today.

## How occurrences are generated

Occurrences are generated **lazily**, not all at once. An hourly job materializes only the occurrences due within a look-ahead window (`TRUEPPM_RECURRENCE_HORIZON_DAYS`, default 14 days) — a never-ending daily rule never creates an unbounded backlog of rows. Each generated occurrence is an ordinary task (status _Not started_), flagged as recurring so it stays out of the schedule, and is not placed in the WBS.

## Permissions

Reading a task's recurrence is open to any project member. **Creating, editing, or stopping** a recurrence requires **Resource Manager or above** — the same gate as editing dependencies, because attaching or detaching a rule changes what the scheduler computes. Members see a read-only summary of the rule.

## Recurring tasks vs. subtasks vs. child tasks

| Mechanism | CPM participation | Use when |
|---|---|---|
| **Recurring task** | No — excluded entirely | The work repeats on a calendar cadence (ceremonies, recurring reviews) |
| **[Subtasks](/features/subtasks/)** | No — the parent is the CPM node | Internal checklist for a single deliverable |
| **Child tasks under a phase** | Yes | The items need sequencing, separate resourcing, or Gantt visibility |
