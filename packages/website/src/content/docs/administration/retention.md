---
title: Outbox & Record Retention
description: How TruePPM bounds its transactional outbox and audit tables with nightly purges, and how to tune or disable each retention window.
---

TruePPM runs several **transactional outbox** tables (schedule requests, MS Project
imports, webhook deliveries, sprint-close requests) plus historical records (object
history, task runs). Each is kept bounded by a nightly Celery Beat purge so the tables
stay small, index scans on the drain paths stay fast, and backups don't bloat.

Every retention window is an operator-tunable Django setting. Setting a window to
**`None`** disables that purge entirely (unbounded retention) — useful where an external
archival policy owns the data, at the cost of unbounded table growth. `None` is set via a
settings override (see [Disabling a purge](#disabling-a-purge-safely)); the environment
variable itself must be a positive integer or left unset (it falls back to the default).

## Retention settings

| Setting | Default | What it bounds | Purge (UTC) |
|---|---|---|---|
| `HISTORY_RETENTION_DAYS` | `90` | django-simple-history object-change records | 02:00 |
| `TASK_RUN_RETENTION_DAYS` | `30` | Completed/failed/cancelled `TaskRun` records | 02:30 |
| `TRUEPPM_IMPORT_RETENTION_DAYS` | `7` | Terminal (`DONE`/`DEAD`) `ImportRequest` rows, including their multi-MB `file_content_b64` blobs | 02:45 |
| `TRUEPPM_WEBHOOK_RETENTION_DAYS` | `7` | Terminal (`SUCCESS`/`FAILED`) `WebhookDelivery` rows | 03:30 |
| `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` | `24` (hours) | Drained mobile-sync upload batches | 03:45 |
| `WORKFLOW_HISTORY_RETENTION_DAYS` | `30` | Terminal durable-workflow history records | 04:00 |
| `IDEMPOTENCY_RETENTION_HOURS` | `24` (hours) | Expired idempotency keys | hourly |

Each value is read from the matching environment variable at startup. To change a
window, set the env var (or the corresponding Helm value) and restart the API/worker
pods. Example:

```bash
# Keep webhook deliveries for 30 days. The env var takes a positive integer;
# leave it unset to fall back to the default (7). An empty value is invalid.
TRUEPPM_WEBHOOK_RETENTION_DAYS=30
```

## What is never purged

- **Non-terminal rows.** `PENDING` webhook deliveries and `PENDING`/`DISPATCHED`
  import requests are still in flight — the drain may re-dispatch them — so they are
  excluded from the purge regardless of age. Only terminal rows are eligible.
- **Active business data.** Retention purges target *outbox and audit* tables only.
  Projects, tasks, schedules, and baselines are never touched by these jobs.

## Why two prefixes?

The older retention knobs (`HISTORY_RETENTION_DAYS`, `TASK_RUN_RETENTION_DAYS`) are
unprefixed; the newer ones (`TRUEPPM_IMPORT_RETENTION_DAYS`,
`TRUEPPM_WEBHOOK_RETENTION_DAYS`) carry the `TRUEPPM_` prefix for env-var namespacing in
shared Kubernetes ConfigMaps and Secrets (see ADR-0081). The unprefixed names are kept
as-is — renaming them would break existing deployments.

## Disabling a purge safely

To disable a purge, set its Django setting to `None` in a settings override (the same
mechanism as the older `HISTORY_RETENTION_DAYS` / `TASK_RUN_RETENTION_DAYS` knobs) — for
example in a custom settings module layered on `trueppm_api.settings.prod`:

```python
TRUEPPM_IMPORT_RETENTION_DAYS = None  # never purge MS Project imports
```

The corresponding environment variable cannot express `None` — it must be a valid
integer or left unset — so disabling is a settings-level decision, not an env toggle.

Disabling a purge means the table grows without bound. For `ImportRequest` in particular,
each retained row can hold a multi-megabyte base64 blob; a team running monthly imports
with the purge disabled will accumulate gigabytes of dead rows. If you disable a purge,
pair it with an external archival or `VACUUM`/retention policy at the PostgreSQL layer.
