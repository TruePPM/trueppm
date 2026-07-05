---
title: System Health
description: The workspace-admin System Health console — inspect durable-execution health, the Celery Beat heartbeat, and the dead-letter queue from the UI, without shelling into the cluster.
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4.
:::

TruePPM runs scheduling, notifications, webhooks, MS Project imports, and retention
purges as background work via Celery and a transactional outbox. The **System Health**
console gives a workspace administrator a read-only operator view of that machinery —
without shelling into the cluster or scraping Prometheus by hand.

Find it at **Settings → Workspace → System health**.

:::note[Edition]
System Health is part of the **Community edition** (Apache 2.0). Compliance-grade
retention governance — locked SOC 2 / HIPAA floors, a policy-change audit trail, and an
immutable audit-log retention row — is an Enterprise overlay and is not part of this
console.
:::

:::caution[Access]
These pages require a **staff (admin) account** (`is_staff`). They expose operational
internals — including failed-task payloads — and are intentionally **not** gated by the
per-project 5-role RBAC. A project Owner is not, by itself, a workspace operator.
:::

## Overview dashboard

The landing page is live: it refreshes every 10 seconds while the tab is focused.
**Force refresh** reloads immediately; **Open runbook** links to this page.

### Component status

Five cards summarize the durable-execution layer. Each shows a status dot —
green (healthy), amber (needs attention), red (broken), or a **gray hollow ring
(not measured)**.

| Component | What it watches | Healthy means |
|---|---|---|
| Outbox dispatcher | CPM + workflow transactional outbox rows | no `dead` rows, nothing stuck dispatched > 10 min |
| Celery Beat | the Beat heartbeat singleton | heartbeat younger than the stale threshold |
| Dead-letter alerting | permanently-failed Celery tasks | no parked (`dead`) tasks |
| Notification dispatcher | pending notification emails | nothing failed-and-pending beyond 1 hour |
| Retention purge | the most recent purge run | last run succeeded (`ok`) |

**Retention purge.** The card reports the outcome of the most recent purge run — `ok`,
`partial`, or `failed`. Before any run has been recorded it shows a gray hollow
*unknown* ("not measured") state rather than an error. Configure windows, schedule, and
on-demand runs at **System health → Retention & purge** (see
[Retention](/administration/retention/)).

### Celery Beat heartbeat

The heartbeat panel shows seconds since the last recorded beat and the stale threshold
(`TRUEPPM_BEAT_STALE_SECONDS`, default 120 s). Below it, the **Scheduled tasks** table
lists every job Beat runs and its cadence (e.g. `every 30s`, `daily 04:00 UTC`), grouped
by category (heartbeat, drain, purge, snapshot).

This list is the **configured** schedule, not per-task last-run status — TruePPM tracks a
single global heartbeat, not per-task execution times. Overall Beat liveness is answered
by the seconds-since-beat figure; if Beat dies, every drain and purge stops, so a stale
heartbeat is the signal that matters.

### Dead-letter & retention summaries

The **dead-letter** card shows the parked count, the age of the oldest parked task, the
most common failure cause, and an **Open inspector** link. The **retention** card shows
the current per-table retention windows (read-only here) with a **Manage retention** link
to the editor, where admins tune windows, schedule, and on-demand runs; see
[Retention](/administration/retention/) and ADR-0081.

## Dead-letter inspector

Reached from the overview's **Open inspector** link. A split view over
permanently-failed Celery tasks (the `FailedTask` records that back
[Dead-letter Alerting](/administration/dead-letter-alerting)) — inspect a task on the
left/detail, then requeue or drop it (see [Triaging dead-lettered tasks](#triaging-dead-lettered-tasks)).

- **Filter** by status, task name (substring), and time window; sorted newest-failure-first.
- **Detail pane** for a selected task:
  - **Attempt summary** — failure count, first/last failed timestamps, exception type.
    TruePPM records a single failure count, not a per-attempt log, so this is a summary
    rather than a blow-by-blow retry history.
  - **Last error** — exception type, message, and the full traceback (collapsible).
  - **Payload** — the pretty-printed task `args` and `kwargs`.

## Triaging dead-lettered tasks

From the detail pane you can act on a parked task; both actions are workspace-admin
gated and each opens a confirmation before it runs.

- **Requeue** re-enqueues the original task with its stored `args`/`kwargs` after an
  operator-chosen **backoff** (immediately, or in 5 minutes / 30 minutes / 1 hour).
  The requeue does **not** re-dispatch on a side channel — it round-trips through the
  durable workflow backend, so a broker outage at the moment you click cannot silently
  lose the re-enqueue (the workflow outbox drain re-dispatches it). Only `dead` and
  `pending_retry` tasks are requeueable. The backoff is applied as a best-effort delay
  on the re-dispatched task; the guarantee that the re-enqueue *happens* is durable,
  while the delay itself is not yet durable across a broker restart.
- **Drop** removes a parked task from the active queue with an optional **note**. A
  drop is a *soft* remove: the task moves to `dismissed` and the record — including the
  note, the operator, and the timestamp — is **retained** for audit (nothing is
  hard-deleted; see the "no silent discards" principle in
  [Dead-letter Alerting](/administration/dead-letter-alerting)). Dropped rows are
  reclaimed by the normal retention purge.

The audit line for a requeued or dropped task (who, when, and any drop note) appears in
the detail pane once the action has run.

### Bulk actions over the current filter

The list header offers **Requeue all** and **Drop all**, which apply the same action to
**the current filter set** — for example, filter by task name to "all seven tasks routed
to the vendor relay" and requeue them in one confirmation. Bulk actions are **bounded**:
each run processes up to a fixed maximum (500 by default,
`FAILED_TASK_BULK_ACTION_MAX`), oldest-first, so a "drop all" over a large parked queue
cannot overload the database. When more tasks match than the cap, the result reports how
many were processed and that the batch was capped — repeat the action to continue.

## API

The console is API-first; every surface is admin-only (`IsAdminUser`):

- `GET /api/v1/health/system/` — the aggregated overview payload (component statuses,
  Beat panel, configured schedule, dead-letter summary, retention config).
- `GET /api/v1/admin/failed-tasks/` — the dead-letter list, filterable with
  `?status=`, `?task_name=`, `?failed_after=`, and `?failed_before=`.
- `GET /api/v1/admin/failed-tasks/{id}/` — a single failed-task record, including its
  payload, traceback, and (once acted on) the `resolution_note` / `resolved_at` audit.
- `POST /api/v1/admin/failed-tasks/{id}/requeue/` — re-enqueue the task through the
  durable workflow backend with an optional `{ "backoff_seconds": N }` (0–86400).
- `POST /api/v1/admin/failed-tasks/{id}/drop/` — soft-remove the task (→ `dismissed`)
  with an optional `{ "note": "…" }`.
- `POST /api/v1/admin/failed-tasks/requeue_all/` and `.../drop_all/` — the bulk actions
  over the current filter set (same query params as the list); bounded, returning
  `{ processed, matched, capped }`.

See the API reference for full schemas.

## Related

- [Dead-letter Alerting](/administration/dead-letter-alerting) — the structured alert log
  and Prometheus gauge this UI complements.
- [Retention](/administration/retention) — the environment/settings the retention
  summary reflects.
- [Durability](/administration/durability) — the transactional outbox the dispatchers run.
