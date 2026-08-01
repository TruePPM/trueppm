# Backup & Restore

> **Ships in 0.4 (beta).** The tested backup/restore scripts and the Helm backup
> CronJob land in **TruePPM 0.4**, the first beta. Until 0.4 tags, take a manual
> `pg_dump` of the `trueppm` database as described under **Manual backup** — the
> commands are the same ones the scripts run.

TruePPM keeps all durable state in **PostgreSQL**. A logical `pg_dump` of the
`trueppm` database, plus a copy of the media directory when attachments are on
local disk, is a complete, restorable backup. This page is the runbook: how to
take one, how to restore it onto a fresh stack, what is and isn't captured, and
how to prove the procedure works with a periodic restore drill.

> **Edition.** This is *logical* backup and restore — everything one team needs to
> not lose its data. Continuous archiving / point-in-time recovery (WAL shipping),
> cross-region replication, and managed backup automation are Enterprise HA
> features (`enterprise#20`). The logical backup here is the foundation those build
> on, not a lesser version of them.

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

## Manual backup

Both scripts take their connection from `DATABASE_URL` (and optional `REDIS_URL` /
`TRUEPPM_MEDIA_ROOT`), so the same command works on the Compose dev stack and
inside a Helm-deployed pod. Run `scripts/backup.sh --help` for the full flag list.

### Docker Compose

```bash
# From the repo root, against the running dev stack (db published on :5432):
DATABASE_URL="postgres://trueppm:trueppm@localhost:5432/trueppm" \
  ./scripts/backup.sh --output-dir ./backups
```

The script writes a single timestamped `trueppm-backup-<UTC>.tar.gz` containing
`db.dump`, `media.tar.gz` (when a media dir is given), and a `MANIFEST`.

### Kubernetes / Helm

Take an on-demand backup by running the script inside a client pod that can reach
the database, using the chart-owned connection Secret:

```bash
kubectl run trueppm-backup --rm -it --restart=Never \
  --image=postgres:16-alpine \
  --env="DATABASE_URL=$(kubectl get secret <release>-trueppm-connection \
      -o jsonpath='{.data.DATABASE_URL}' | base64 -d)" \
  -- sh -c 'pg_dump --format=custom --no-owner --no-privileges \
      -d "$DATABASE_URL"' > trueppm-$(date -u +%Y%m%dT%H%M%SZ).dump
```

For a scheduled backup, enable the chart's CronJob instead of running this by hand
(see **Scheduled backups with Helm** below).

## Restore onto a fresh stack

`restore.sh` reloads the artifact onto a **clean target**, is **idempotent**
(`pg_restore --clean --if-exists`, safe to re-run), and **verifies the required
extensions** (`ltree`, `pg_trgm`) exist afterward — a schema missing them is
silently broken, so the restore fails loudly instead.

```bash
# Compose: restore onto a freshly-created empty database
DATABASE_URL="postgres://trueppm:trueppm@localhost:5432/trueppm" \
  ./scripts/restore.sh --artifact backups/trueppm-backup-<UTC>.tar.gz --yes
```

`restore.sh` does **not** restore the Redis snapshot even when the artifact
contains one — the cache and broker rebuild themselves. After a database restore,
restart the API and worker pods so any cached state is discarded.

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
artifact off-cluster instead, point it at an S3-compatible bucket via
`backup.s3.*`. To include local-disk media, set `backup.mediaDir` and mount your
media claim read-only via `backup.extraVolumes` / `backup.extraVolumeMounts`.

> **Note.** `keepWeekly` is *advisory* — the in-cluster CronJob does not promote
> dailies to weeklies. Enforce longer retention with your object store's lifecycle
> rules (S3) or an external sweep. A backup that lives on the same cluster as the
> database it protects does not survive a cluster loss — replicate the artifact
> off-cluster.

### Off-cluster plaintext warning

`backup.s3.endpoint` (and the CLI scripts' `--s3-endpoint` / `S3_ENDPOINT`) take
whatever URL you give them, scheme included — TruePPM never hardcodes `http://`
or `https://`. That flexibility is deliberate: a self-hosted MinIO sidecar in the
same cluster is normally reached over plain HTTP with no certificate to manage,
and forcing TLS onto that hop would be pure friction for no security benefit
(the traffic never leaves the pod network).

The line that matters is **where the endpoint actually is**, not what scheme you
typed:

- **In-cluster or private-network plaintext is expected and fine.** The
  documented default, `http://minio:9000` (a bare Kubernetes Service DNS name),
  never leaves the cluster network. TruePPM recognizes this shape — a bare
  short name, `*.svc` / `*.local` (which also covers
  `*.svc.cluster.local`), `localhost`, or an RFC1918/loopback address — and
  stays silent.
- **Plaintext to anything else is a real exposure.** The artifact being
  uploaded is a full `pg_dump` of the `trueppm` database — every project,
  task, dependency, comment, and user email in the deployment. If
  `backup.s3.endpoint` is repointed at an off-cluster or cross-VPC bucket
  (a managed S3-compatible store, a different cluster, another cloud region)
  and the scheme is left as `http://`, that dump crosses the network
  unencrypted. When the endpoint doesn't match the in-cluster shape above,
  the backup job logs a `WARNING:` line naming the endpoint — **the upload
  still proceeds**; this is a warning, not a failure, because an operator may
  have a legitimate reason (e.g. a private peered link the heuristic can't
  see) and a hard failure would be a worse outcome for a backup job than a
  loud log line.

**What to do about it:**

- If the endpoint is genuinely off-cluster, use `https://` — every real
  S3-compatible provider serves TLS.
- If you've verified the network path is trusted despite failing the
  heuristic (e.g. an on-prem store reached over a private peered link with no
  public routing), set `backup.s3.allowPlaintext: true` (or, for the CLI
  scripts, `TRUEPPM_S3_ALLOW_PLAINTEXT=1`) to silence the warning
  deliberately, rather than leaving it to be ignored.

This is a heuristic, not a network trace: it recognizes hostname *shapes*, not
actual routes. A privately-routed FQDN, or a public DNS name that happens to
resolve to a private IP, is not recognized and **will** warn — that's the
deliberate bias, since a missed warning on a genuine cross-network endpoint is
the failure this exists to prevent, and an extra log line on a trusted-but-
unrecognized endpoint costs nothing but a `allowPlaintext` flag.

## Restore drills

A backup you have never restored is a hypothesis, not a backup. Prove it:

- **Cadence** — run a full restore drill on a **throwaway target monthly**, and
  again before any risky upgrade or migration.
- **What "green" looks like**:
  1. `restore.sh` exits `0` and prints `extension present: ltree` and
     `extension present: pg_trgm`.
  2. Row counts on the restored database match the source for the core tables
     (`projects_project`, `projects_task`, `sprints_sprint`).
  3. The API boots against the restored database (`/api/v1/health/` returns `200`)
     and you can open a project and see its schedule.
- **CI evidence** — every change to the backup/restore scripts or the CronJob
  template runs an automated restore drill in CI (`backup:restore-drill`): it seeds
  a database, backs it up, drops it, restores from the artifact, and asserts the
  row counts match. A nightly scheduled run exercises the same path so the
  procedure can't rot between changes.

## Related

- [Deployment](./deployment.md) — the stateful services and the managed-datastore
  path.
- [Beat Liveness & Durability](./durability.md) — keeping async work durable, the
  companion to not losing data.
- [Record retention](./retention.md) — what the purge jobs remove before a backup
  is even taken.
