---
title: Timesheet
description: A keyboard-fast weekly grid to review and submit your logged time across every project.
---

:::note[0.5]
The weekly timesheet ships in 0.5.
:::

**Timesheet** is where you review and submit a whole week of logged time in one place. Where the inline quick-log and the running timer capture single entries fast, the timesheet is the grid you fill gaps in and submit at the end of the week — every project and task you logged against, laid out Monday to Sunday.

Open it from **Timesheet** in the sidebar's Personal group, or go straight to `/me/timesheet`.

## The grid

- **Rows are your tasks, across every project.** Each row shows the task and its project; the grid spans all the projects you're a member of, so a cross-project week is one screen, not a tab per project.
- **Columns are the seven days** of the selected week (Mon … Sun). Each cell is the hours you logged on that task that day; an empty cell reads as a muted `·`.
- **Type hours however is fastest** — `2`, `2.5`, or `2:30` all mean two-and-a-half hours. `Tab` moves between cells, `Enter` saves the cell, `Esc` discards the edit. Clearing a cell removes that day's entry.
- **Totals update as you type** — a row total per task, a daily total under each day, and the week total in the header. A daily total over eight hours is flagged amber so an over-long day is obvious.
- **Weekends are shaded** and today's column is tinted, so you can orient at a glance.

Step between weeks with the `‹ … ›` stepper, and start logging against a task that isn't in the grid yet with **Add project or task**.

### Days with more than one entry

If you logged two separate sessions against the same task on the same day, that cell shows the **sum** and is read-only in the grid — a single number can't be split back into the individual entries without losing their notes and provenance. Edit those entries from [My Work](/features/my-work/), where each one is listed on its own.

## Submitting your week

**Submit week** marks the week as done. It's a signal, not a lock: your entries stay fully editable after you submit, and you can **Reopen** the week at any time. There is no approver and no manager view — submitting is just you telling yourself (and, later, an approval workflow) that the week is complete.

Manager approval, non-project time categories (PTO, admin, training), and the earned-value actuals feed are a separate, later track — they are not part of this grid.

## Your own time only

The timesheet is a personal, individual-contributor surface: it shows and submits **your** logged time on tasks you can access. It carries no cross-project rollup, no per-person visibility for managers, and no portfolio or governance scope — a contributor reviewing their own week is squarely community-edition functionality.
