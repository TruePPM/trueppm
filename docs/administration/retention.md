# Outbox and record retention

TruePPM runs several **transactional outbox** tables (schedule requests, MS Project
imports, webhook deliveries, sprint-close requests) plus historical records (object
history, task runs). Each is kept bounded by a nightly Celery Beat purge so the tables
stay small, index scans on the drain paths stay fast, and backups don't bloat.

Every retention window is an operator-tunable Django setting. Setting a window to
**`None`** disables that purge entirely (unbounded retention) — useful where an external
archival policy owns the data, at the cost of unbounded table growth.

## Retention settings

| Setting | Default | What it bounds | Nightly purge (UTC) |
|---|---|---|---|
| `HISTORY_RETENTION_DAYS` | `90` | django-simple-history object-change records | 02:00 |
| `TASK_RUN_RETENTION_DAYS` | `30` | Completed/failed/cancelled `TaskRun` records | 02:30 |
| `TRUEPPM_IMPORT_RETENTION_DAYS` | `7` | Terminal (`DONE`/`DEAD`) `ImportRequest` rows, including their multi-MB `file_content_b64` blobs | 02:45 |
| `TRUEPPM_WEBHOOK_RETENTION_DAYS` | `7` | Terminal (`SUCCESS`/`FAILED`) `WebhookDelivery` rows | 03:30 |

Each value is read from the matching environment variable at startup. To change a
window, set the env var (or the corresponding Helm value) and restart the API/worker
pods. Example:

```bash
# Keep webhook deliveries for 30 days; never purge MS Project imports.
TRUEPPM_WEBHOOK_RETENTION_DAYS=30
TRUEPPM_IMPORT_RETENTION_DAYS=    # empty → None → purge disabled
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

Disabling a purge (`None`) means the table grows without bound. For `ImportRequest` in
particular, each retained row can hold a multi-megabyte base64 blob; a team running
monthly imports with the purge disabled will accumulate gigabytes of dead rows. If you
disable a purge, pair it with an external archival or `VACUUM`/retention policy at the
PostgreSQL layer.
