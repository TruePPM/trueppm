---
title: Outbox & Record Retention
description: How TruePPM bounds its transactional outbox and audit tables with purges, and how to tune, run on demand, or disable each retention window.
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4.
:::

TruePPM runs several **transactional outbox** tables (schedule requests, MS Project
imports, webhook deliveries, sprint-close requests) plus historical records (object
history, task runs). Each is kept bounded by a Celery Beat purge so the tables stay
small, index scans on the drain paths stay fast, and backups don't bloat.

You can tune retention two ways: from the **System health → Retention & purge** editor in
the UI (workspace admins), or via Django settings / environment variables (the default,
applied when no UI override exists). The UI is the fast path for a running deployment; the
settings remain the source of the defaults.

## Editing retention from the UI

Workspace admins (Django `is_staff`) manage retention at **Settings → Workspace → System
health → Retention & purge**. From there you can, without editing env/settings or
restarting pods:

- **Edit each retention window** and **enable/disable** a purge per table.
- **Configure the purge schedule** (frequency, time of day, on-failure behavior).
- **Run a purge now** or **dry-run** it.
- **Review the last several purge runs**.

A UI change writes a **`RetentionPolicy` override** that takes precedence over the
matching Django setting. The settings below remain the **defaults** — a deployment that
never opens the editor behaves exactly as it did before (ADR-0173).

:::caution[Lowering a window is irreversible]
Lowering a retention window makes more data **immediately purge-eligible** on the next
run. The editor shows how many rows (and roughly how much space) become eligible *before*
you save, but the deletion itself **cannot be undone**. Saving a lower value only changes
the window — the next scheduled or manual run enforces it.
:::

## Retention settings

| Setting | Default | Unit | What it bounds |
|---|---|---|---|
| `HISTORY_RETENTION_DAYS` | `90` | days | django-simple-history object-change records |
| `TASK_RUN_RETENTION_DAYS` | `30` | days | Completed/failed/canceled `TaskRun` records |
| `TRUEPPM_IMPORT_RETENTION_DAYS` | `7` | days | Terminal (`DONE`/`DEAD`) `ImportRequest` rows, including their multi-MB `file_content_b64` blobs |
| `TRUEPPM_WEBHOOK_RETENTION_DAYS` | `7` | days | Terminal (`SUCCESS`/`FAILED`) `WebhookDelivery` rows |
| `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` | `24` | hours | `SyncBatch` mobile-upload idempotency rows past the dedup window (ADR-0082) |

**One purge coordinator, not five nightly jobs.** These five tables were previously purged
by five separate nightly Beat jobs at staggered UTC times. As of ADR-0173 they are purged
by a **single retention purge coordinator** that runs all five as one unified run on the
schedule below (default **02:00 UTC daily**). The per-table tasks still exist and remain
dispatchable, but they are no longer independently scheduled.

**Workspace export archives are purged separately.** A completed workspace export
(Settings → Archive / Delete → *Export all data*, ADR-0174) writes a full `.tar.gz` to
object storage. `TRUEPPM_EXPORT_RETENTION_DAYS` (default `7`; `None` disables) bounds how
long the download link stays valid; past it the standalone nightly `purge_expired_exports`
Beat task (04:20 UTC) deletes both the `WorkspaceExportJob` row **and** its stored archive
file. It is not folded into the retention coordinator above because it reaps a storage
object, not just a database row.

**`TRUEPPM_SYNC_BATCH_RETENTION_HOURS` is in hours, not days.** Unlike the other knobs,
this window is measured in **hours** because it doubles as the mobile sync upload **dedup
window**: a re-uploaded batch carrying the same `client_batch_id` replays its stored
response only while its `SyncBatch` row is within this window. The default of 24h
comfortably covers a device that was offline overnight. This window **cannot be
disabled** — it is always active.

Each value is read from the matching environment variable at startup. To change a default
deployment-wide (rather than per-UI-override), set the env var (or the corresponding Helm
value) and restart the API/worker pods. Example:

```bash
# Keep webhook deliveries for 30 days. The env var takes a positive integer;
# leave it unset to fall back to the default (7). An empty value is invalid.
TRUEPPM_WEBHOOK_RETENTION_DAYS=30
```

## Purge schedule

The coordinator's schedule is operator-configurable (Settings → Retention & purge):

- **Frequency** — `Daily`, `Weekly`, or `Off`. `Off` disables *scheduled* purging
  entirely; you can still run a purge on demand.
- **Time of day** — a UTC time. It is **UTC with no DST shift** — `02:00` is always
  02:00 UTC year-round, so the purge window doesn't drift with daylight saving.
- **Day of week** — shown only when frequency is `Weekly`.
- **On failure** — `Continue and flag the failed table` (purge the remaining tables and
  mark the failed one in the run) or `Stop the run on first error` (abort immediately).

Internally, Beat fires the coordinator on a fixed sub-hourly cadence and the coordinator
self-gates: it does nothing outside the configured window and never double-runs the same
window.

## Running a purge on demand

- **Run purge now** — deletes eligible rows immediately across all five tables. It is
  **irreversible** and is protected by a confirmation dialog.
- **Dry run** — counts what *would* be purged and **deletes nothing**. Use it to preview
  impact before committing to a real run.

Both are asynchronous: the request returns immediately and the run appears in the log once
the worker finishes. If a run is already in progress the endpoint responds **409** (a
single-flight guard, so a double-click can't launch overlapping purges). The setting
`RETENTION_PURGE_INFLIGHT_SECONDS` (default `600`) bounds that guard, so a worker that
dies mid-run can't block future runs indefinitely.

## Purge log

The editor shows the most recent purge runs — each with its start time, duration, state
(`ok` / `partial` / `failed` / `running` / `dry run`), how many of the five tables
completed, rows deleted, and bytes freed.

**Counts and sizes are estimates.** The row counts and table sizes shown in the editor
(and the bytes-freed figure in the log) are PostgreSQL **estimates**
(`pg_class.reltuples` / `pg_total_relation_size`). They are fast to compute on large
tables but approximate — treat them as guidance, not an exact ledger.

Once at least one run has been recorded, the **System health overview**'s "Retention
purge" component card reports real state (`ok` / `partial` / `failed`) instead of the
`unknown` it shows before any run exists.

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

You can disable a purge two ways:

- **From the UI** — toggle the table off in the Retention & purge editor. (Sync batches is
  the exception: it doubles as the sync dedup window and cannot be disabled.)
- **From settings** — set the Django setting to `None` in a settings override, for example
  in a custom settings module layered on `trueppm_api.settings.prod`:

```python
TRUEPPM_IMPORT_RETENTION_DAYS = None  # never purge MS Project imports
```

The corresponding environment variable cannot express `None` — it must be a valid
integer or left unset — so the settings-level disable is a deliberate override, not an env
toggle.

Disabling a purge means the table grows without bound. For `ImportRequest` in particular,
each retained row can hold a multi-megabyte base64 blob; a team running monthly imports
with the purge disabled will accumulate gigabytes of dead rows. If you disable a purge,
pair it with an external archival or `VACUUM`/retention policy at the PostgreSQL layer.

## Forecast snapshots

:::note[Added in 0.3]
Project forecast-snapshot capture was added in **TruePPM 0.3**, available since
the `0.3.0-alpha.1` pre-release (Jun 28, 2026).
:::

Every time the scheduler recomputes a project, TruePPM will record a
`ProjectForecastSnapshot` — the CPM finish date, total float, Monte Carlo P50/P80/P95, and
task counts at that moment — so a PM can see how the project's finish date has drifted over
time. A nightly **floor** task (`scheduling.capture_daily_forecast_floor`, 00:30 UTC)
guarantees at least one snapshot per active project per day even on quiet days, and also
backfills any recompute capture missed by a broker blip. Capture is **best-effort and
post-commit** — a capture failure never blocks or rolls back the recompute.

Unlike the outbox tables above, forecast snapshots are bounded by a **tiered retention
curve** rather than a single age cutoff, because the long tail of monthly points is what
makes a multi-year drift chart useful:

| `FORECAST_SNAPSHOT_RETENTION` key | Default | Effect |
|---|---|---|
| `daily_days` | `90` | Keep **every** snapshot younger than this |
| `weekly_days` | `365` | Between `daily_days` and here, keep **one per ISO week** (the newest) |
| _beyond `weekly_days`_ | — | Keep **one per calendar month** (the newest), kept forever |

The prune runs nightly via the `scheduling.prune_forecast_snapshots` Beat task (04:15 UTC)
and is also exposed as the [`prune_forecast_snapshots` management
command](/administration/management-commands/#maintenance-commands) for on-demand runs. To
change the curve deployment-wide, override `FORECAST_SNAPSHOT_RETENTION` in a settings
module layered on `trueppm_api.settings.prod`:

```python
# Keep daily points for 6 months, then weekly to 2 years, then monthly forever.
FORECAST_SNAPSHOT_RETENTION = {"daily_days": 180, "weekly_days": 730}
```

History is read-only at `GET /api/v1/projects/{id}/forecast-snapshots/` (any project
member). Snapshots are server-generated; there is no write surface.

:::note[Enterprise]
**Compliance-grade retention is an Enterprise feature.** This page covers basic operational
purge. Compliance-grade retention governance — locked SOC 2/HIPAA floors ("cannot lower
below N days"), a policy-change audit trail, GDPR / legal-hold workflows, and an
immutable **Audit log** retention row — is part of **TruePPM Enterprise** and is
intentionally not in the open-source core.
:::
