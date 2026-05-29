---
title: System Health
description: The workspace-admin System Health console — inspect durable-execution health, the Celery Beat heartbeat, and the dead-letter queue from the UI, without shelling into the cluster.
---


:::note[0.2 — in progress]
This page documents functionality that ships in **TruePPM 0.2** (target Jun 8, 2026). It is not available on the current 0.1 release.
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

Reached from the overview's **Open inspector** link. A read-only split view over
permanently-failed Celery tasks (the `FailedTask` records that back
[Dead-letter Alerting](/administration/dead-letter-alerting)).

- **Filter** by status, task name (substring), and time window; sorted newest-failure-first.
- **Detail pane** for a selected task:
  - **Attempt summary** — failure count, first/last failed timestamps, exception type.
    TruePPM records a single failure count, not a per-attempt log, so this is a summary
    rather than a blow-by-blow retry history.
  - **Last error** — exception type, message, and the full traceback (collapsible).
  - **Payload** — the pretty-printed task `args` and `kwargs`.

The inspector **UI** is read-only — retry and dismiss buttons in the console are a
planned follow-up. The actions themselves are available today via the API (below):
`retry` re-enqueues the original task with its stored args/kwargs, and `dismiss`
acknowledges a dead-lettered task without retrying it.

## API

The console is API-first; both surfaces are admin-only (`IsAdminUser`):

- `GET /api/v1/health/system/` — the aggregated overview payload (component statuses,
  Beat panel, configured schedule, dead-letter summary, retention config).
- `GET /api/v1/admin/failed-tasks/` — the dead-letter list, filterable with
  `?status=`, `?task_name=`, `?failed_after=`, and `?failed_before=`.
- `GET /api/v1/admin/failed-tasks/{id}/` — a single failed-task record, including its
  payload and traceback.
- `POST /api/v1/admin/failed-tasks/{id}/retry/` — re-enqueue the original task with its
  stored args/kwargs.
- `POST /api/v1/admin/failed-tasks/{id}/dismiss/` — mark a dead-lettered task as
  dismissed (acknowledged, no retry).

See the API reference for full schemas.

## Related

- [Dead-letter Alerting](/administration/dead-letter-alerting) — the structured alert log
  and Prometheus gauge this UI complements.
- [Retention](/administration/retention) — the environment/settings the retention
  summary reflects.
- [Durability](/administration/durability) — the transactional outbox the dispatchers run.
