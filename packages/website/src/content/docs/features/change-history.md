---
title: Change History
description: Every change to a task, project, or dependency is recorded with a field-level diff, so you can see what changed, when, and (as an admin) who changed it.
---

:::note[Shipped in 0.2 (alpha)]
Change history shipped in **TruePPM 0.2**, available since the `0.2.0-alpha.1`
pre-release (May 31, 2026). 0.2 is an alpha release.
:::

TruePPM records a **change history** for tasks, projects, dependencies, sprints, and more. Each edit
captures a field-level diff — the old value, the new value, and when it happened — so you
can answer "when did this task's finish date slip, and why?" without a spreadsheet.

:::note[Edition]
Change history is part of the **Community (OSS)** edition. It is built on
django-simple-history and records changes for tasks, projects, dependencies, sprints,
risks, programs, and more.
:::

## Viewing a task's history

Open a task in the Schedule view and switch to the **History** tab. You'll see a reverse
chronological list of changes, each tagged with its type:

- **`+` Created** — the object was added.
- **`~` Updated** — one or more fields changed; the diff lists each field with its old and
  new value.
- **`−` Deleted** — the object was removed.

Each entry shows how long ago the change happened. **Project admins** also see *who* made
the change; Members and Viewers see the change itself but not the user, by design. Long
histories paginate with a **Load more** control.

## What is and isn't tracked

History deliberately excludes **CPM-derived fields** (early/late start and finish, float,
critical-path flag) and **sync bookkeeping** (`server_version`, tombstone versions). Those
recompute automatically on every schedule run, so recording them would bury the changes
you actually care about — duration, status, percent complete, planned dates, assignee, and
notes — under recalculation noise.

## API

| Method & path | Returns |
|---|---|
| `GET /api/v1/projects/{id}/tasks/{taskId}/history/` | Paginated field-level diffs for one task |
| `GET /api/v1/projects/{id}/history/` | Project-level field changes |
| `GET /api/v1/projects/{id}/history/summary/?window=7d` | Aggregate mutation counts by field and object type over a window (`1d`, `7d`, `30d`, `90d`) |

Any project Member or above can read history. The identity of the editing user
(`history_user`) is included only for Admins. The summary endpoint is cached for five
minutes; pass `?refresh=1` to recompute.

## Retention

History rows are bounded by a nightly purge governed by `HISTORY_RETENTION_DAYS`
(default **90** days). See [Outbox & Record Retention](/administration/retention/) to tune
or disable it.
