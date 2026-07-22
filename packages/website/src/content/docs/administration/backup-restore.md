---
title: Backup & Restore
description: How to take and restore a TruePPM backup — the tested pg_dump + media artifact, the opt-in Helm CronJob, what is and isn't captured, and how to run a restore drill.
---

:::note[Ships in 0.4 (beta)]
The tested backup/restore scripts and the Helm backup CronJob land in **TruePPM
0.4**, the first beta. Until 0.4 tags, take a manual `pg_dump` of the `trueppm`
database as described under [Manual backup](#manual-backup) — the commands are the
same ones the scripts run.
:::

TruePPM keeps all durable state in **PostgreSQL**. A logical `pg_dump` of the
`trueppm` database, plus a copy of the media directory when attachments are on
local disk, is a complete, restorable backup. This page is the runbook: how to
take one, how to restore it onto a fresh stack, what is and isn't captured, and
how to prove the procedure works with a periodic restore drill.

:::note[Edition]
This is **logical** backup and restore — everything one team needs to not lose
its data. Continuous archiving / point-in-time recovery (WAL shipping),
cross-region replication, and managed backup automation are Enterprise HA
features (`enterprise#20`). The logical backup here is the foundation those build
on, not a lesser version of them.
:::

## What is in the backup

| Data | In backup? | Why |
|---|---|---|
| PostgreSQL (`trueppm` database) | **Yes** | The authoritative store — every project, task, sprint, dependency, baseline, comment, and setting. The `pg_dump --format=custom` artifact preserves the `ltree` and `pg_trgm` extensions and the `wbs_path` GiST index. |
| Media / attachments (local disk) | **Yes**, when local | `TaskAttachment` files when `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE` is on. When you use S3/MinIO object storage instead, the bucket is backed up by the object store — not by this artifact (see below). |
| Redis / Valkey (cache + broker) | **No** (by design) | Valkey holds only **ephemeral, reconstructible** state: the Django cache, the Celery broker queue, and the Channels real-time layer. None of it is a source of truth. Restoring a stale Redis snapshot onto a running instance would resurrect dead queue entries and serve stale cache — worse than an empty cache, which simply refills on first read. In-flight Celery tasks are re-triggered by the next write; WebSocket clients reconnect. So the backup omits it deliberately. |

`backup.sh` can take an **opt-in** Redis `SAVE` snapshot (`--redis`) for operators
who want one, but it is off by default and is never used by `restore.sh` — the
restore path is PostgreSQL-authoritative.

### Object storage note

If attachments live in an S3-compatible bucket (the recommended production
configuration), that bucket is **outside** the TruePPM backup artifact by design.
Back it up with your object store's own tooling (versioning + lifecycle rules, or
`aws s3 sync` / `mc mirror` on your schedule). The database dump still captures the
attachment **metadata** (filename, size, owning task); pair it with your bucket's
backup so a restore reunites the two.

#### Ordering for an internally-consistent restore

The database and the object store are **two backups of one system**, and the
order you capture and restore them in decides whether the restored instance is
internally consistent — the `TaskAttachment` row and the object it points at must
both exist, or neither.

- **Backup order — object store first, then the database.** Snapshot (or let the
  lifecycle-versioned bucket settle) the object store **before** you take the
  `pg_dump`. An attachment upload writes the object, then the row; capturing the
  bucket first guarantees every row the dump contains has its object already in
  the bucket snapshot. The reverse order can dump a row whose object was written
  *after* the bucket snapshot — a **dangling reference** (a row pointing at a
  missing object).
- **Restore order — database first, then reconcile the bucket.** Restore the
  database, then restore/attach the bucket at the **same-or-newer** point in
  time. Because backup captured the bucket first, a matching-time bucket contains
  a **superset** of the objects the DB references: every row resolves, and any
  extra objects (uploads that never committed a row) are harmless orphans the
  attachment-GC pass reclaims. Restoring an **older** bucket than the database is
  the one unsafe combination — it reintroduces dangling references.
- **Quiesce for a clean point.** For a strictly consistent pair, take both while
  writes are paused (a short maintenance window, or scale the API to zero
  replicas). Without a quiesce, the object-store-first / DB-first ordering above
  keeps the result safe (orphans, never dangles) rather than perfectly matched.

## Manual backup

Both scripts take their connection from `DATABASE_URL` (and optional
`REDIS_URL` / `TRUEPPM_MEDIA_ROOT`), so the same command works on the Compose dev
stack and inside a Helm-deployed pod. Run `scripts/backup.sh --help` for the full
flag list.

### Docker Compose

```bash
# From the repo root, against the running dev stack (db published on :5432):
DATABASE_URL="postgres://trueppm:trueppm@localhost:5432/trueppm" \
  ./scripts/backup.sh --output-dir ./backups

# Or from inside the api container (no host psql client needed):
docker compose exec -T \
  -e DATABASE_URL="postgres://trueppm:trueppm@db:5432/trueppm" \
  db sh -c 'exec pg_dump --format=custom --no-owner --no-privileges \
    -d "$DATABASE_URL"' > backups/trueppm-$(date -u +%Y%m%dT%H%M%SZ).dump
```

The script writes a single timestamped `trueppm-backup-<UTC>.tar.gz` containing
`db.dump`, `media.tar.gz` (when a media dir is given), and a `MANIFEST`.

### Kubernetes / Helm

Take an on-demand backup by running the script inside a client pod that can reach
the database, using the chart-owned connection Secret:

```bash
# One-off backup pod using the same image the CronJob uses:
kubectl run trueppm-backup --rm -it --restart=Never \
  --image=postgres:16-alpine \
  --env="DATABASE_URL=$(kubectl get secret <release>-trueppm-connection \
      -o jsonpath='{.data.DATABASE_URL}' | base64 -d)" \
  -- sh -c 'pg_dump --format=custom --no-owner --no-privileges \
      -d "$DATABASE_URL"' > trueppm-$(date -u +%Y%m%dT%H%M%SZ).dump
```

For a scheduled backup, enable the chart's CronJob instead of running this by hand
— see [Scheduled backups with Helm](#scheduled-backups-with-helm).

## Restore onto a fresh stack

`restore.sh` reloads the artifact onto a **clean target**, is **idempotent**
(`pg_restore --clean --if-exists`, safe to re-run), and **verifies the required
extensions** (`ltree`, `pg_trgm`) exist afterward — a schema missing them is
silently broken, so the restore fails loudly instead.

```bash
# Compose: restore onto a freshly-created empty database
DATABASE_URL="postgres://trueppm:trueppm@localhost:5432/trueppm" \
  ./scripts/restore.sh --artifact backups/trueppm-backup-<UTC>.tar.gz --yes

# Kubernetes: restore into the target database from a client pod, then restart
# the API so it picks up the restored schema.
```

`restore.sh` does **not** restore the Redis snapshot even when the artifact
contains one — the cache and broker rebuild themselves. After a database restore,
restart the API and worker pods so any cached state is discarded.

### Why the `ltree` / `pg_trgm` extension ordering matters

TruePPM's schema **depends on two PostgreSQL extensions**, and a naive
dump/restore that reorders or drops their creation produces a database that
restores "successfully" but is silently broken:

- **`ltree`** backs the `projects_task.wbs_path` column and its GiST index. WBS
  subtree and ancestor queries ("everything under this summary task") are
  `ltree` operators — without the extension the column type does not exist and
  the restore of `projects_task` fails outright; with the extension present but
  the GiST index dropped, the queries still run but fall back to sequential
  scans.
- **`pg_trgm`** backs the trigram GIN indexes that power fuzzy task and project
  search. Missing it means search either errors (index create fails) or silently
  degrades to unindexed `ILIKE`.

The extensions must be created **before** any table, column, or index that
references them. `pg_dump --format=custom` records `CREATE EXTENSION` in the
archive's table-of-contents ahead of the dependent `CREATE TABLE` / `CREATE
INDEX` entries, and `pg_restore` replays the TOC in dependency order — so the
**custom-format** dump preserves the ordering automatically. This is why the
runbook uses `--format=custom` and **not** a plain `pg_dump > file.sql` piped
into `psql`: a plain-SQL dump edited or filtered by hand (for example, stripping
`CREATE EXTENSION` lines because "the target already has them", or restoring a
single table) can reorder or drop the extension statements and break exactly the
two indexes above.

If you restore into a database where a platform policy blocks unprivileged
`CREATE EXTENSION` (some managed Postgres offerings), create the extensions as a
superuser **first**, then run the restore:

```sql
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

`restore.sh` guards against a silent miss: after the restore it asserts both
extensions are present (`SELECT 1 FROM pg_extension …`) and **fails the whole
restore** if either is absent, so a broken schema surfaces loudly instead of at
the first WBS query weeks later.

## Scheduled backups with Helm

The chart ships an **opt-in** backup CronJob, **off by default**. Enabling it
silently would create a PersistentVolumeClaim you never asked for, so you turn it
on deliberately once you have chosen a destination.

```yaml
# values.yaml
backup:
  enabled: true
  schedule: "0 2 * * *"     # 02:00 daily, cluster timezone
  outputDir: /backups
  keepDaily: 7              # in-job prune to the 7 newest artifacts
  keepWeekly: 4             # advisory — enforce with your off-cluster lifecycle policy
  persistence:
    enabled: true           # chart-managed PVC at outputDir
    size: 10Gi
    storageClass: ""        # cluster default
```

The CronJob runs a `pg_dump --format=custom` against the database (connection from
the same chart-owned Secret the API uses — no second copy of the password) and
writes a timestamped artifact to the PVC, pruning to `keepDaily`. To ship the
artifact off-cluster instead, point it at an S3-compatible bucket:

```yaml
backup:
  enabled: true
  s3:
    enabled: true
    bucket: trueppm-backups
    endpoint: https://s3.us-east-1.amazonaws.com
    region: us-east-1
    existingSecret: trueppm-backup-s3   # keys: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

To include local-disk media in the scheduled artifact, set `backup.mediaDir` and
mount your media claim read-only via `backup.extraVolumes` /
`backup.extraVolumeMounts`.

:::caution
`keepWeekly` is **advisory** — the in-cluster CronJob does not promote dailies to
weeklies. Enforce longer retention with your object store's lifecycle rules (S3)
or an external sweep. Treat the PVC as a staging area, not your only copy: a
backup that lives on the same cluster as the database it protects does not survive
a cluster loss. Replicate the artifact off-cluster.
:::

## Restore drills

A backup you have never restored is a hypothesis, not a backup. Prove it:

- **Cadence** — run a full restore drill on a **throwaway target monthly**, and
  again before any risky upgrade or migration.
- **What "green" looks like**:
  1. `restore.sh` exits `0` and prints `extension present: ltree` and
     `extension present: pg_trgm`.
  2. Row counts on the restored database match the source for the core tables
     (`SELECT count(*) FROM projects_project;` and `projects_task`, `sprints_sprint`).
  3. The API boots against the restored database (`/api/v1/health/` returns
     `200`) and you can open a project and see its schedule.
- **CI evidence** — every change to the backup/restore scripts or the CronJob
  template runs an automated restore drill in CI (`backup:restore-drill`): it
  seeds a database, backs it up, drops it, restores from the artifact, and asserts
  the row counts match. A nightly scheduled run exercises the same path so the
  procedure can't rot between changes. Green there is your standing evidence that
  the runbook on this page actually works.

## Related

- [Deployment](/administration/deployment/) — the stateful services and the
  managed-datastore path.
- [Beat Liveness & Durability](/administration/durability/) — keeping async work
  durable, the companion to not losing data.
- [Record retention](/administration/retention/) — what the purge jobs remove
  before a backup is even taken.
