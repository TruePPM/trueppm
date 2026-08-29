---
title: Outbox & Record Retention
description: How TruePPM bounds its transactional outbox and audit tables with purges, and how to tune, run on demand, or disable each retention window.
documentedFor: "0.4"
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

:::danger[`0` is not "use the default" — it deletes everything in the trash]
Every window on this page is read with `env.int`, so `0` parses as the number
zero, not as "unset". For `TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS` that puts
the purge cutoff at the present moment: the next run hard-deletes **every**
trashed project, with its tasks, dependencies, sprints and baselines, via
CASCADE. There is no tombstone and no undo.

The chart's own comment used to say `0` meant "keep the default" and that an
empty string meant "disabled". Both were wrong — an empty string raises
`ValueError` at settings import and crash-loops the container. From 0.4 the app
**will refuse to boot** on `0` rather than losing the data silently; on the
current release the value is accepted and the data is lost on the next purge.

- **To keep the default:** leave the variable unset.
- **To change the window:** set a positive number of days.
- **To disable auto-purge entirely:** leave the variable unset and turn the
  policy off in **Settings → System Health**, which stores an override with
  `enabled: false`. That is also where you tune the live value without a
  redeploy — the environment variable is only the fallback used when no override
  row exists.
:::

| Setting | Default | Unit | What it bounds |
|---|---|---|---|
| `TRUEPPM_HISTORY_RETENTION_DAYS` | `90` | days | django-simple-history object-change records |
| `TRUEPPM_TASK_RUN_RETENTION_DAYS` | `30` | days | Completed/failed/canceled `TaskRun` records |
| `TRUEPPM_IMPORT_RETENTION_DAYS` | `7` | days | Terminal (`DONE`/`DEAD`) `ImportRequest` rows, including their multi-MB `file_content_b64` blobs; also terminal `ProgramImportJob` rows and their stored seed payloads |
| `TRUEPPM_WEBHOOK_RETENTION_DAYS` | `7` | days | Terminal (`SUCCESS`/`FAILED`) `WebhookDelivery` rows |
| `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` | `24` | hours | `SyncBatch` mobile-upload idempotency rows past the dedup window (ADR-0082) |
| `TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS` | `30` | days | Soft-deleted ("trashed") `Project` rows, hard-deleted with all child data (see [Trashed projects](#trashed-projects-are-hard-deleted-after-the-window) below) |
| `TRUEPPM_TOMBSTONE_RETENTION_DAYS` | `90` | days | Per-row soft-delete tombstones (`Task`, `Dependency`, `TaskRelation`, `Risk`, `Sprint`) in live projects. This is also the window a deleted **task** stays restorable — see [What you can get back](#what-you-can-get-back) |
| `TRUEPPM_BOARD_EVENT_RETENTION_HOURS` | `24` | hours | WebSocket event-replay buffer (`BoardEvent`) rows (ADR-0236) — see the note below the table |

**One purge coordinator, not many nightly jobs.** The outbox and history tables were
originally purged by separate nightly Beat jobs at staggered UTC times. As of ADR-0173 the
retention windows above are purged by a **single retention purge coordinator** that runs
all six as one unified run on the schedule below (default **02:00 UTC daily**). Each
per-table task still exists and remains dispatchable, but none is independently scheduled.

**Per-row tombstones are reaped on their own schedule.** `TRUEPPM_TOMBSTONE_RETENTION_DAYS`
is enforced by a separate nightly job (03:30 UTC) that does **not** run through the
coordinator above: it reads the setting directly, writes no purge-log row, and is not
listed on the Retention & purge settings page. Changing the coordinator's schedule — or
setting its frequency to `Off` — does not affect it. Tombstones inside an **archived**
project are skipped entirely and retained indefinitely.

**The WebSocket event-replay buffer is reaped on its own schedule, too.**
`TRUEPPM_BOARD_EVENT_RETENTION_HOURS` (default `24`) bounds how long `BoardEvent` rows —
the replay buffer a reconnecting collaboration client uses to catch up on missed
board/schedule events — are kept. A separate nightly job (02:35 UTC) reaps rows past the
window; it is deliberately **not** part of the coordinator above and is not exposed on the
Retention & purge settings page, because the buffer is internal WebSocket transport
plumbing rather than an operator-facing data-retention decision. A client reconnecting
with a `?since=` cursor older than the retained window receives a `resync_required` frame
and refetches full state instead of replaying — the buffer being reaped is expected steady
state, not a failure.

**Workspace export archives are purged separately.** A completed workspace export
(Settings → Archive / Delete → *Export all data*, ADR-0174) writes a full `.tar.gz` to
object storage. `TRUEPPM_EXPORT_RETENTION_DAYS` (default `7`; `None` disables) bounds how
long the download link stays valid; past it the standalone nightly `purge_expired_exports`
Beat task (04:20 UTC) deletes both the `WorkspaceExportJob` row **and** its stored archive
file. It is not folded into the retention coordinator above because it reaps a storage
object, not just a database row.

**Project export bundles share the same knob.** A completed project export bundle
(Project → Settings → Lifecycle → *Export bundle*, ADR-0219) writes a per-project `.tar.gz`
to object storage. It reuses `TRUEPPM_EXPORT_RETENTION_DAYS` (same default `7`; `None`
disables) for its download-link validity, reaped by the standalone nightly
`purge_expired_project_exports` Beat task (04:25 UTC) — which deletes both the
`ProjectExportJob` row **and** its stored archive.

**Program export bundles too.** A completed program export bundle (Program →
Settings → General → *Export program bundle*, ADR-0219) writes a per-program
`.tar.gz` to object storage and likewise reuses `TRUEPPM_EXPORT_RETENTION_DAYS`,
reaped by the standalone nightly `purge_expired_program_exports` Beat task
(04:30 UTC), which deletes both the `ProgramExportJob` row **and** its stored
archive. All three export purges run a few minutes apart and honor the single
`TRUEPPM_EXPORT_RETENTION_DAYS` setting.

**Program seed import jobs share the MS Project import knob.** A queued program
seed import (`POST /api/v1/programs/import/`) writes a `ProgramImportJob` row and
stores the uploaded seed document. Terminal rows and their stored payloads are
reaped by the standalone nightly `purge_expired_program_imports` Beat task
(04:35 UTC) using `TRUEPPM_IMPORT_RETENTION_DAYS` (same default `7`; `None`
disables) — the same knob the MS Project import outbox uses. Like the export
purges it is a standalone task rather than a coordinator entry, because it
deletes a storage object as well as a database row.

:::caution[Import retention is not project retention]
Re-importing a seed over a live program moves that program's **projects** to
project Trash, and those are governed by the project retention window, not by
`TRUEPPM_IMPORT_RETENTION_DAYS` — which only bounds how long the *job record and
its uploaded file* are kept. The replaced program shell is not recoverable at
all: there is no program Trash
([#2587](https://gitlab.com/trueppm/trueppm/-/issues/2587)).
:::

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

## What you can get back

Deleting something in TruePPM does not always mean the row leaves the database — most
models are *soft*-deleted so offline and MCP clients receive a tombstone on their next
sync rather than silently losing a row. That is a sync mechanism, not a promise of
recovery. This table is the promise: what a **user** can actually restore, and for how
long.

| You delete a… | Can you get it back? | Where from | For how long |
|---|---|---|---|
| **Project** | Yes | Settings → Workspace → **Trash** (project Owner) | `TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS` (default 30 days) |
| **Task** | Yes | Schedule ⋯ or Board ⋯ → **Recently deleted** (project admin, or the task's assignee) | `TRUEPPM_TOMBSTONE_RETENTION_DAYS` (default 90 days) |
| **Resource** | Yes | Resources → **Show deactivated** → **Restore resource** (workspace admin) | Indefinitely — a deactivated resource is never purged |
| **Sprint** | No | — | Only `Planned` or `Cancelled` sprints can be deleted at all |
| **Baseline** | No | — | Capture a new one |
| **Dependency / task link** | Not on its own | Restored automatically when its task is restored, if both ends are live | — |
| **Risk** | No | — | — |
| **Label** | No | — | Deleting a label also detaches it from every task, so there is nothing faithful to restore |

:::note[Ships in 0.4]
The task **Recently deleted** panel ships in **TruePPM 0.4** (the first beta), alongside
the project Trash. Before 0.4, a deleted task is recoverable only from the inline
"Deleted — Undo" toast shown immediately after the delete.
:::

### Recovering a deleted task

A deleted task stays restorable for `TRUEPPM_TOMBSTONE_RETENTION_DAYS` (default 90 days),
after which the nightly tombstone reaper removes it permanently. Two ways back:

- **Undo, immediately.** The inline **"Deleted — Undo"** toast right after the delete.
- **Recently deleted, later.** **Recently deleted…** in the Schedule's Project-actions (⋯)
  menu or the Board's ⋯ More menu lists every restorable task in the project, newest
  first, with how long ago it was deleted and how many days remain.

Restoring is **atomic and faithful**: the task comes back with its original id, history,
resource assignments, and its subtask subtree, and every dependency edge whose two
endpoints are both live is re-linked in the same transaction. Because a parent's restore
brings its subtasks with it, the list shows the **restorable root** of each delete rather
than every tombstoned row — a row that will bring subtasks back says so.

Any project member can open the list; **Restore** is enabled under exactly the rule that
governs deletion — a project admin, or the task's own assignee. The list is capped at the
200 most recent deletions and says so when it has been cut.

:::caution[Archived projects keep their tombstones forever]
The nightly reaper skips projects flagged as archived, so tasks deleted inside an archived
project are retained indefinitely rather than aging out. They show an indefinite retention
in the list.
:::

## Trashed projects are hard-deleted after the window

:::note[Ships in 0.4]
Automatic hard-delete of trashed projects lands in **TruePPM 0.4** (the first beta).
Manual soft delete and `?force=true` hard delete already ship; the *scheduled* purge below
is the 0.4 addition.
:::

Deleting a project is a **soft delete**: the project drops out of every list, board, and
report immediately, but its row and all its child data (tasks, dependencies, sprints,
risks, baselines) are retained so the deletion can be reviewed and — until it is purged —
recovered. The **Trash** (below) is the recovery surface; a `?force=true` delete is the
manual *permanent* removal.

`TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS` (default `30`) will bound that grace period.
Once a project has been in the trash longer than the window, the retention coordinator will
**hard-delete** it: the project row and, via database `CASCADE`, its entire child subtree
are permanently removed in one pass. This is the same removal the manual `?force=true`
delete performs, applied automatically on a schedule. Like every retention window it is
**irreversible** and can be tuned or disabled (set the value to `None` in a settings
override) exactly like the others.

:::caution[Age is measured from the delete, not the purge]
A project soft-deleted **before** this feature ships has no recorded delete timestamp
(`deleted_at IS NULL`). Because its age cannot be known, it will be deliberately **never**
auto-purged — the safe default is to keep it. Such a legacy trashed project can still be
removed manually with a `?force=true` delete; only projects deleted after the feature ships
carry a timestamp and age out automatically.
:::

### Restoring a project from Trash

:::note[Ships in 0.4]
The Trash list, the **Restore** action, and the inline "Deleted — Undo" toast ship in
**TruePPM 0.4** (the first beta).
:::

A soft-deleted project is recoverable for the whole retention window. There are two ways
back:

- **Undo, immediately.** Right after a delete, an inline **"Deleted — Undo"** toast lets
  the person who deleted it put it straight back — the fat-finger safety net, reachable on
  a phone.
- **Trash, later.** **Settings → Workspace → Trash** lists every soft-deleted project still
  inside the retention window, showing who deleted it, how long ago, and how many days
  remain before it is permanently purged. Any project member sees the list; only a project
  **Owner** can restore, so a project is never quietly resurrected by someone without the
  authority to have deleted it.

Restore is **atomic and complete**: the project and all its children (tasks, dependency
edges, sprints, baselines, risks) come back in one transaction — a failure part-way
through rolls the whole thing back rather than leaving a half-restored project — and every
restored record's sync version is bumped so offline and MCP clients re-materialize it on
their next pull. Cross-project dependency edges are re-linked only when both ends are live
again, so an edge to a task in a still-deleted project stays dormant until that project is
also restored.

Once a project has been in the trash past the window it is purged and no longer restorable;
recover it before the countdown reaches zero.

:::caution[Projects replaced by a seed re-import come back standalone]
Re-importing a JSON seed over a program you own sends that program's projects to Trash
individually, **detached from the program at delete time**. Restoring one puts the project
back as a standalone project — it does not return to the program it belonged to, because
the program shell is gone and is not itself recoverable
([#2587](https://gitlab.com/trueppm/trueppm/-/issues/2587)). See
[Data export](/administration/data-export/#check-a-file-before-you-import-it).
:::

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

- **Run purge now** — deletes eligible rows immediately across all six tables. It is
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
(`ok` / `partial` / `failed` / `running` / `dry run`), how many of the six tables
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
- **Live business data.** Retention purges target *outbox, history, and trashed* records
  only. **Live** projects, tasks, schedules, and baselines are never touched — a project
  will become eligible only after you have explicitly deleted it (moved it to the trash)
  *and* the soft-delete retention window has elapsed. See [Trashed
  projects](#trashed-projects-are-hard-deleted-after-the-window) below.
- **API-token audit log.** `ApiTokenAuditEntry` rows (project- and
  program-scoped token mint/revoke events) are **never** purged — they are kept
  indefinitely as compliance evidence and have no retention window.

## Why the legacy bare names still work

Every retention knob has a `TRUEPPM_`-prefixed name today — `TRUEPPM_HISTORY_RETENTION_DAYS`
and `TRUEPPM_TASK_RUN_RETENTION_DAYS` were standardized onto the prefix pre-0.3 (#1325),
matching `TRUEPPM_IMPORT_RETENTION_DAYS` and `TRUEPPM_WEBHOOK_RETENTION_DAYS`, which
carried it from the start (ADR-0081) for env-var namespacing in shared Kubernetes
ConfigMaps and Secrets. Django reads the **prefixed name first**; only when it is unset
does it fall back to the legacy bare name (`HISTORY_RETENTION_DAYS`,
`TASK_RUN_RETENTION_DAYS`). The bare names are kept working indefinitely as a fallback —
removing them would break any deployment that still sets the old name — but a
deployment configuring these for the first time should always use the `TRUEPPM_`-prefixed
form.

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

Every time the scheduler recomputes a project, TruePPM records a
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
