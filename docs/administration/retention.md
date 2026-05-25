# Outbox and record retention

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

| Setting | Default | What it bounds | Nightly purge (UTC) |
|---|---|---|---|
| `HISTORY_RETENTION_DAYS` | `90` | django-simple-history object-change records | 02:00 |
| `TASK_RUN_RETENTION_DAYS` | `30` | Completed/failed/cancelled `TaskRun` records | 02:30 |
| `TRUEPPM_IMPORT_RETENTION_DAYS` | `7` | Terminal (`DONE`/`DEAD`) `ImportRequest` rows, including their multi-MB `file_content_b64` blobs | 02:45 |
| `TRUEPPM_WEBHOOK_RETENTION_DAYS` | `7` | Terminal (`SUCCESS`/`FAILED`) `WebhookDelivery` rows | 03:30 |
| `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` | `24` | `SyncBatch` mobile-upload idempotency rows past the dedup window (ADR-0082) | 03:45 |

!!! note "`TRUEPPM_SYNC_BATCH_RETENTION_HOURS` is in hours, not days"
    Unlike the other knobs, this window is measured in **hours** because it
    doubles as the mobile sync upload **dedup window**: a re-uploaded batch
    carrying the same `client_batch_id` replays its stored response only while
    its `SyncBatch` row is within this window. Past it, the same id is allowed
    to re-run and the nightly purge reaps the row. Lengthening it widens the
    safe-retry window at the cost of more retained rows; shortening it does the
    reverse. The default of 24h comfortably covers a device that was offline
    overnight.

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
- **Active business data.** Retention purges target *outbox and history* tables only.
  Projects, tasks, schedules, and baselines are never touched by these jobs.
- **API-token audit log.** `ApiTokenAuditEntry` rows (project- and
  program-scoped token mint/revoke events) are **never** purged — they are kept
  indefinitely as compliance evidence and have no retention window.

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
