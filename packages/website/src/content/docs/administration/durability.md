---
title: Durability & Redundancy
description: What TruePPM keeps, what it rebuilds, and what it throws away — the durability contract, a per-tier redundancy matrix, the step-up ladder from an evaluation install to a redundant one, and what actually happens when each component fails.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
Most of the Helm surface this page names is new in **TruePPM 0.4**, the first
beta, and is **not** in `v0.3.0-alpha.3`, the latest release. On 0.3 the chart has
no `web`, `probes`, `podDisruptionBudget`, `autoscaling`, or `backup` values at
all, and the API exposes no `/api/v1/readyz`. Specifically, these ship in 0.4:

- the **`/api/v1/readyz` readiness endpoint** and the chart's `probes.*` block —
  everything under [Health and readiness endpoints](#health-and-readiness-endpoints)
  and the readiness rows in the failure-mode matrix;
- the **nginx web tier** (`web.*`) and its replica count;
- **`podDisruptionBudget.*`** and **`autoscaling.*`**;
- the **backup CronJob** (`backup.*`) named in rung 5 of the ladder;
- **Valkey Sentinel** (`valkey.sentinel.*`) named in rung 6.

What is true on 0.3 as well: PostgreSQL is the only authoritative store, the
bundled Valkey runs with AOF on a PVC, Beat is a pinned singleton, the outbox
drains and `acks_late` redelivery described under [The durability
contract](#the-durability-contract), and the three admin health endpoints.
:::

TruePPM has one authoritative store and a lot of state it can rebuild. Knowing
which is which is the whole of operating it safely: it tells you what a backup
must contain, what a pod loss costs, and which components deserve a second
replica before any of the others.

This page is the contract and the ladder. It does not repeat the runbooks — take
a backup with [Backup & Restore](/administration/backup-restore/), size the tiers
with [Sizing](/administration/sizing/), make the broker redundant with [Valkey
High Availability](/administration/valkey-ha/), and diagnose a live incident with
[Troubleshooting](/administration/troubleshooting/).

## The durability contract

| Class | What is in it | Survives a pod restart? | RPO |
|---|---|---|---|
| **Authoritative** | The `trueppm` PostgreSQL database — every project, task, dependency, sprint, baseline, comment, setting, and every outbox row. | Only because it is on a PersistentVolume. | Your backup interval. The Helm CronJob defaults to `0 2 * * *`, so **up to 24 h**. There is no PITR — see [Not covered](#what-this-does-not-cover). |
| **Authoritative (outside the database)** | File attachments, and `INTEGRATION_ENCRYPTION_KEY`. Attachments need shared, persistent storage — see [Attachments](#attachments-are-their-own-durability-decision). The key lives in a Secret or `.env`, **not** in the dump, and a restore without it silently orphans every stored credential. | Only on shared storage / in your secret manager. | Same as your object store or media volume. |
| **Reconstructible** | Everything in Valkey: the Celery broker queue (db `0`), the Channels real-time layer (`1`), the Django cache (`2`), notification throttles (`3`). | The bundled pod persists (below), but nothing depends on it doing so. | Not a source of truth — losing all of it costs latency and delay, not data. |
| **Ephemeral by design** | Every `emptyDir` in the chart: `/tmp` scratch, the `staticfiles` collectstatic target, Beat's schedule shelve, and `/run/trueppm/admin_password`. | **No.** Gone on any restart. | Zero. Nothing here may be a source of truth, and the admin password file is the one that surprises people — see [Admin password setup](/administration/admin-password/). |

### Why losing the broker does not lose the work

The Celery queue is not the record of what needs doing — the database is.
**Fourteen** outbox drains run every **30 seconds** — `ScheduleRequest`, MS Project
/ Jira / CSV `ImportRequest`s, `TemplateApplication`, `SprintCloseRequest`, webhook
deliveries, notification emails, invite emails, the workflow outbox, and the
workspace / project / program export and import queues. Each dispatches what is
pending and re-dispatches rows whose worker died mid-flight. On top of that,
every task in the codebase is registered with `acks_late=True` and
`reject_on_worker_lost=True`, so a task is acknowledged only after it completes
and is redelivered if its worker disappears.

The practical consequence: **wiping the broker delays outbox-backed work, it does
not delete it.** Within about 30 seconds of Valkey coming back, the drains
re-enqueue everything still pending in the database.

What that does *not* cover is work with no outbox row behind it — a
fire-and-forget `.delay()` whose only record was the queue entry. That is why
`capture_daily_forecast_floor` exists as a nightly backstop, and why the answer
to "how much did we lose" is "the delta since the last successful drain", not
zero.

### Broker persistence, per artifact

Three deployment artifacts ship Valkey and **they do not agree**, so read the row
that matches what you run:

| Artifact | Persistence | Effective broker RPO |
|---|---|---|
| **Helm chart** (`charts/valkey`) | `valkey-server --appendonly yes` on a **2Gi PVC** (`valkey.persistence.size`). | Valkey's default `appendfsync everysec` → **~1 second** of appended commands at risk on an unclean stop. |
| **`docker-compose.prod.yml`** | **None.** `/data` is a `tmpfs` and AOF is not enabled. | **Total.** Every queue entry is gone on container restart. |
| **`docker-compose.yml`** (dev) | A `valkey_data` volume, but **no AOF flag** — only whatever periodic RDB snapshot Valkey's built-in defaults produce. | Best-effort. Do not plan against it. |

None of this changes the contract above — the outbox is what makes the work
durable, and the AOF file is a latency optimization on top of it. But it does mean
"restart the Valkey container" is a materially different action on Compose-prod
than on Helm, and the pages that used to say Valkey "does not store persistent
data" were describing the Compose case only.

### Attachments are their own durability decision

Task attachments are the one piece of user data that is not in the `pg_dump`
artifact. Two supported shapes:

- **Object storage (recommended).** Set `TRUEPPM_DEFAULT_FILE_STORAGE` to an
  S3-compatible backend plus `TRUEPPM_S3_BUCKET_NAME`. Durability and versioning
  become the bucket's problem, the API pods stay stateless, and a second replica
  needs no coordination. See [object
  storage](/administration/configuration/#object-storage-s3--minio).
- **Local disk**, behind the explicit `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE`
  opt-in. This needs storage that is both **persistent** and **shared across every
  API replica** — an `emptyDir` is neither, and a `ReadWriteOnce` volume is not
  shared. If you take this path, include the media directory in your backup
  (`backup.mediaDir` plus `backup.extraVolumes` / `backup.extraVolumeMounts` on
  the Helm CronJob) and read [Attachment
  policy](/administration/attachment-policy/) first.

The safe default for any install with more than one API pod is object storage.

## Health and readiness endpoints

There are five health endpoints and they are not interchangeable. Two of them are
unauthenticated and probe-safe; three require a staff account and are for
operators and scrapers.

| Endpoint | Auth | What it checks | Codes |
|---|---|---|---|
| `GET /api/v1/health/` | None | **Nothing.** Returns `200 {"status": "ok"}` while the Django process is up. | `200` only |
| `GET /api/v1/readyz` *(no trailing slash)* | None | A bounded `SELECT 1` against PostgreSQL, a **write-then-read round-trip** against Valkey, and whether this image's migrations match the schema. Body: `{"status", "checks": {database, cache, migrations}, "migration_state"}`. | `200` / `503` |
| `GET /api/v1/health/beat/` | Staff | Celery Beat heartbeat freshness. See [Beat Liveness](/administration/beat-liveness/). | `200` / `503` |
| `GET /api/v1/health/dead-letter/` | Staff | Prometheus gauge of permanently failed tasks. See [Dead-letter Alerting](/administration/dead-letter-alerting/). | `200` |
| `GET /api/v1/health/system/` | Staff | The full operator view behind [System Health](/administration/system-health/). | `200` |

:::caution[`/api/v1/health/` is a liveness probe, never a readiness probe]
It opens no database connection and touches no cache, so a pod whose datastores
are unreachable answers `200` and keeps taking traffic. That is exactly what you
want from *liveness* — a dependency blip must not restart-loop a healthy process —
and exactly wrong for *readiness*.

The chart gets this right and you should keep its defaults: `probes.api.livenessPath`
is `/api/v1/health/`, `probes.api.readinessPath` is `/api/v1/readyz`.
:::

**`/readyz` gates on the cache, and that is a deliberate whole-application
coupling.** `_probe_cache()` performs a real `set`-then-`get` round-trip, so when
Valkey is unreachable every API pod reports `503`, the kubelet removes it from the
Service endpoints, and the ingress has nowhere to send traffic. The reasoning is
that the same Valkey carries the Channels layer — a pod that cannot reach it
cannot serve real-time collaboration and should not claim to be ready. The
consequence is that **the bundled single-node Valkey is a hard SPOF for the entire
application**, not just for background work. Plan for it with rung 6 of the
ladder.

## Per-tier redundancy matrix

Chart defaults, and what each tier costs you when it goes away.

| Tier | Chart default | Minimum safe | What sets it | Losing one pod | Losing the node |
|---|---|---|---|---|---|
| **API** | `replicaCount: 1` | **2** | `replicaCount`, or `autoscaling.enabled` with `autoscaling.api.minReplicas: 2`. Guard voluntary evictions with `podDisruptionBudget.enabled`. | At 1: total API outage until the pod reschedules. At ≥2: in-flight requests fail, clients retry, WebSockets reconnect. | The chart ships **no** `affinity` or `topologySpreadConstraints` values, so two replicas may both be scheduled on one node. See rung 4. |
| **Web (nginx SPA)** | `web.replicaCount: 1` | **2** | `web.replicaCount`. Note it does **not** inherit the top-level `replicaCount` — `values-prod.yaml` sets `replicaCount: 2` and the web tier still runs **one** pod. | The browser gets nothing at `/` — a blank page or a 502 — while `/api` and `/ws` keep working. | Same as above, plus: **no PDB covers this tier**; `pdb.yaml` renders budgets for `api` and `celery-worker` only. |
| **Celery worker** | `replicaCount: 1` *(the same key as the API — there is no separate `celeryWorker.replicaCount`)* | **2** | `replicaCount`; tune throughput with `celeryWorker.concurrency` rather than replicas alone. | Nothing is lost. `acks_late` + `reject_on_worker_lost` redeliver the in-flight task; the 30-second drains re-dispatch orphaned outbox rows. Work is **delayed**. | Same, at the cost of one drain cycle. |
| **Celery beat** | `replicas: 1`, **hardcoded**, `strategy: Recreate` | **1 — by design** | Nothing. Two beats would double-fire every periodic task. | Every periodic tick stops: no drains, no retention purge, no heartbeat. Nothing is lost; everything waits. Detect it with `/api/v1/health/beat/`. | Same. A PDB would only block node drains, which is why beat is excluded from `pdb.yaml`. |
| **PostgreSQL (bundled)** | 1 StatefulSet replica, **8Gi PVC** | **1, and not this one** | `postgresql.persistence.size`; production sets `postgresql.enabled: false`. | Total outage. Every API pod goes `NotReady`. Committed data survives on the PVC. | With `ReadWriteOnce` storage the pod cannot start elsewhere until the volume detaches; with node-local storage the data is stranded with the node. |
| **Valkey (bundled)** | 1 StatefulSet replica, AOF on a **2Gi PVC** | **1, and not this one** | `valkey.persistence.size`; production sets `valkey.enabled: false`. | **Every API pod goes `NotReady` and the ingress returns 503** — `/readyz` gates on a cache round-trip. Real-time, async, cache, and throttles fail together. | Same, plus the RWO caveat above. |

## The step-up ladder

Six rungs from "I am evaluating this" to "I can lose a node during business
hours". Each one is independently useful — climb only as far as your risk
tolerance requires, and climb **in order**: multi-replica stateless pods (rung 4)
buy you very little while the datastores under them are still single bundled pods.

### Rung 1 — Evaluation, single node

`docker compose up -d`, or `helm install` with stock values.

- **Changes:** none.
- **Costs:** nothing.
- **Buys:** a working instance. Every tier is one replica, both datastores are
  bundled, and on `docker-compose.prod.yml` the broker is a `tmpfs`.
- **Do not** put a real program on this. Any node loss is a full outage of
  indeterminate length, and on the Compose-prod path a broker restart drops the
  queue.

### Rung 2 — Bundled datastores, sized PVCs, and a real backup

Still one node, but the data now survives a restart and you can restore it.

```yaml
postgresql:
  persistence:
    size: 20Gi          # 8Gi default is an evaluation figure
    storageClass: ""    # name a class with real durability, not node-local
valkey:
  persistence:
    size: 2Gi
backup:
  enabled: true
  schedule: "0 2 * * *"
  persistence:
    enabled: true       # a PVC, so the artifact outlives the job pod
    size: 20Gi
```

- **Costs:** the volumes, and a nightly `pg_dump` window.
- **Buys:** committed data survives pod restarts and image upgrades, and you have
  a restorable artifact. RPO is now your backup interval — **up to 24 h** at the
  default schedule.
- **Watch:** a backup that stays inside the cluster does not survive the cluster.
  That is rung 5.

### Rung 3 — Managed PostgreSQL and managed Valkey

The single highest-value rung. It moves both stateful components out of the chart
and onto something with its own replication, failover, patching, and backups.

```yaml
postgresql:
  enabled: false
valkey:
  enabled: false
env:
  DATABASE_URL: "postgres://…?sslmode=require"   # from a Secret, not inline
  REDIS_URL: "rediss://…:6379"                   # base URL only — no /0 suffix
```

This is exactly what `values-prod.yaml` does. Two rules that bite people:

- **Do not append a database index to `REDIS_URL`.** TruePPM appends `/0`, `/1`,
  `/2`, and `/3` itself.
- **Cluster mode must be disabled** on a managed endpoint — a clustered server
  exposes only database `0`. See [Valkey HA](/administration/valkey-ha/).

**The trade-off.**

- **Costs:** a monthly bill, and two connection strings to manage as Secrets.
- **Buys:** the two single points of failure that no amount of application
  redundancy can fix stop being your problem. Your RPO for the database becomes
  the provider's (typically minutes, with PITR), instead of your CronJob's.

### Rung 4 — Multi-replica stateless tiers, with a disruption budget

Now that the datastores can survive without you, make the pods that talk to them
redundant.

```yaml
replicaCount: 2         # API *and* Celery worker — one key drives both
web:
  replicaCount: 2       # does NOT inherit replicaCount; set it explicitly
podDisruptionBudget:
  enabled: true
  api:
    maxUnavailable: 1
  worker:
    maxUnavailable: 1
```

Three things to know before you rely on this:

- **The budgets are expressed as `maxUnavailable`, on purpose.** A `minAvailable: 1`
  budget at `replicaCount: 1` would make the node undrainable — the cluster could
  never evict the only pod. `maxUnavailable` keeps a single-replica install
  drainable; the protection only becomes meaningful at two or more replicas.
- **There is no PDB for the web tier.** `pdb.yaml` covers `api` and
  `celery-worker` only. Run `web.replicaCount: 2` anyway — without it a node drain
  takes the UI offline while the API stays up, which reads to users as a total
  outage.
- **The chart exposes no scheduling constraints.** There are no `affinity`,
  `nodeSelector`, `tolerations`, or `topologySpreadConstraints` values, so nothing
  stops both API replicas from landing on the same node — which is the exact
  failure the second replica was bought to survive. Until the chart grows the
  keys, apply a spread constraint out of band (a post-render `kustomize` layer, or
  a cluster-wide default via a scheduling policy), and verify with
  `kubectl get pods -o wide` that the replicas really are on different nodes.

**The trade-off.**

- **Costs:** roughly double the request-tier CPU and memory, plus the connection
  count that comes with it — check the `max_connections` guidance in
  [Sizing](/administration/sizing/#bottlenecks-in-the-order-they-bite).
- **Buys:** a rolling upgrade with no downtime, and survival of a single pod
  eviction. **Not** survival of a node loss, until the spread constraint above is
  in place.

### Rung 5 — Backups that leave the cluster

A backup on a PVC in the cluster it protects survives a pod. It does not survive
the cluster, the namespace, or a `helm uninstall`.

```yaml
backup:
  enabled: true
  s3:
    enabled: true
    bucket: "my-trueppm-backups"
    region: "eu-west-1"
    endpoint: ""            # set for MinIO; empty for real S3
    prefix: "prod"
    existingSecret: "trueppm-backup-s3"   # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  persistence:
    enabled: true           # keep the PVC as a staging area
```

- **Also back up `INTEGRATION_ENCRYPTION_KEY`**, separately and somewhere you will
  still have it during a disaster. The dump contains Fernet ciphertext that is
  unrecoverable without it, and nothing about that failure is loud — see the
  warning in [Backup & Restore](/administration/backup-restore/#back-up-integration_encryption_key-with-the-dump).
- **Run a restore drill.** An untested backup is a belief, not a control. The
  procedure is in [Restore
  drills](/administration/backup-restore/#restore-drills).

**The trade-off.**

- **Costs:** object-storage egress and storage, and an hour per drill.
- **Buys:** the loss of the whole cluster stops being unrecoverable. A failed
  upload fails the job, so you find out.

### Rung 6 — A broker that survives its own failure

Because `/readyz` gates on the cache, a single-node Valkey means every API pod
goes `NotReady` when it dies. This rung removes the last SPOF.

Two supported topologies, in order of how proven they are:

```yaml
# A: replicated primary behind one stable endpoint — the proven path
valkey:
  enabled: false
env:
  REDIS_URL: "rediss://:PASSWORD@valkey-primary.example.internal:6379"
```

```yaml
# B: Sentinel — experimental in 0.4; validate a real failover in staging first
valkey:
  enabled: false
  sentinel:
    enabled: true
    nodes: "sentinel-0.valkey:26379,sentinel-1.valkey:26379,sentinel-2.valkey:26379"
    masterName: "mymaster"
```

With Sentinel, `REDIS_URL` is ignored and no longer required — the primary is
resolved from the Sentinels on every connection. Use **three or more** sentinels;
two can never reach quorum to promote. Full detail, including the cluster-mode
prohibition and the licensing question, is in [Valkey High
Availability](/administration/valkey-ha/).

- **Costs:** two more Valkey nodes, or a managed HA endpoint.
- **Buys:** the failure that currently returns 503 for your entire application
  becomes a failover measured in seconds.

## Failure-mode matrix

What an operator actually sees, and what it costs. For the diagnosis steps, go to
[Troubleshooting](/administration/troubleshooting/).

| Failure | What users see | What happens underneath | Data loss |
|---|---|---|---|
| **PostgreSQL down** | Total outage. Every request fails; the ingress returns 503 once readiness drains the endpoints. | `_probe_database()`'s bounded `SELECT 1` fails, so `/readyz` returns `503` on every API pod. Celery tasks fail and retry. Nothing can be written. | **None**, once it returns. Committed transactions are on the PVC. |
| **Valkey down** | **Total outage — the whole app returns 503**, not a degraded one. | `/readyz` gates on a live cache round-trip, so **every** API pod is marked `NotReady`, the Service loses all endpoints, and the ingress has nowhere to route. Real-time, async, cache, and throttles are all down regardless. | **None** for outbox-backed work — the drains re-dispatch within ~30 s of recovery. In-flight SSO logins fail and must be retried. |
| **Celery worker down** | Everything reads fine. Schedules stop recalculating, imports sit at "queued", notification email stops. | Queued tasks accumulate; `acks_late` + `reject_on_worker_lost` return in-flight tasks to the queue. Outbox rows stay `PENDING`. | **None.** Work resumes on the next drain cycle after a worker returns. |
| **Celery beat down** | Identical to the above from the outside — which is why it needs its own detector. | Every periodic tick stops: the fourteen 30-second drains, the retention purge, the nightly forecast floor, the heartbeat itself. Nothing re-enqueues. | **None**, but the backlog grows for as long as it is down. `GET /api/v1/health/beat/` returns `503` after `TRUEPPM_BEAT_STALE_SECONDS` (default 120 s). |
| **One API pod down** (at `replicaCount: 1`) | Total API outage until the pod reschedules; the SPA loads but every call fails. | No endpoints behind the Service. | **None.** |
| **One API pod down** (at `replicaCount: ≥2`) | In-flight requests fail once; clients retry. WebSocket clients reconnect and resubscribe. | The kubelet removes the pod from the Service; the remaining replicas take the load. | **None.** |
| **One node down** | Depends entirely on what was on it. | With bundled datastores: whatever ran there is gone until it reschedules, and a `ReadWriteOnce` volume may block that. With no spread constraints (rung 4), both API replicas can be on the lost node. | **None**, unless the node held node-local storage for the database PVC — in which case, your backup is the recovery path. |

## Singletons and one-per-pod work

Two things in the chart do not scale the way the rest does.

**Celery Beat is a pinned singleton.** `templates/celery-beat/deployment.yaml`
hardcodes `replicas: 1` — it is not a value you can override — and uses
`strategy: Recreate` so a rollout never leaves two beats overlapping. Two beat
processes would double-fire every entry in `CELERY_BEAT_SCHEDULE`: two drains of
the same outbox row, two retention purges, two heartbeats. Redundant beat with
leader election is an Enterprise HA feature (`enterprise#20`). The detection layer
you do get is on [Beat Liveness](/administration/beat-liveness/).

**The `migrate` init container runs once per API pod, and they are not
coordinated.** Every API pod runs `python manage.py migrate --noinput` before its
main container starts. At `replicaCount: 1` that is simply how migrations get
applied. At `replicaCount >= 2`, several pods run `migrate` concurrently against
one database — Django takes no cross-process migration lock, so PostgreSQL's own
DDL locking is what serializes them, and a pod that loses the race can exit
non-zero and restart until the winner finishes. Expect init-container restarts
during the first rollout at two or more replicas.

For an upgrade carrying a long-running or destructive migration, do not rely on
that: scale the API to one replica for the rollout, or apply the migration out of
band first. The same one-per-pod shape applies to the `bootstrap` init container
that mints the admin password — see [Admin password
setup](/administration/admin-password/#kubernetes--helm) for why that matters at
two or more replicas.

## What this does not cover

Be explicit about the gaps, so nobody plans around a capability that is not there.

- **No point-in-time recovery.** Backups are logical `pg_dump` artifacts on a
  schedule. There is no WAL archiving in the chart, so your RPO is the interval
  between backups — not seconds. If you need PITR, that is a reason to run managed
  PostgreSQL (rung 3), which gives it to you.
- **No in-chart PostgreSQL HA.** The bundled subchart is a single StatefulSet
  replica with no streaming replication and no failover. There is no
  `postgresql.replicaCount` that makes it highly available, and adding one is not
  planned — the supported answer is a managed database.
- **No cross-region or multi-cluster anything.** No replication, no active/active,
  no automated failover between clusters. Continuous archiving, cross-region
  replication, and managed backup automation are Enterprise HA features
  (`enterprise#20`).
- **No scheduling constraints in the chart.** No `affinity`, `nodeSelector`,
  `tolerations`, or `topologySpreadConstraints` values exist today; see rung 4 for
  the workaround.
- **No automatic restore.** `scripts/restore.sh` is a deliberate manual
  operation. Nothing in the chart will ever restore a backup on your behalf.

## Related pages

- [Backup & Restore](/administration/backup-restore/) — the runbook: taking a
  backup on Compose and Helm, restoring onto a fresh stack, what is and is not
  captured, and the drill cadence.
- [Valkey High Availability](/administration/valkey-ha/) — which broker topologies
  are supported, and how to run one without a commercial Redis license.
- [Deployment Sizing](/administration/sizing/) — the tested scale envelope and
  per-tier resource guidance.
- [Beat Liveness](/administration/beat-liveness/) — detecting the singleton
  scheduler's death.
- [Troubleshooting](/administration/troubleshooting/) — symptom-keyed diagnosis
  for the failures above.
- [Upgrade](/getting-started/upgrade/) — how a version bump interacts with the
  migrate init container.
- [Helm values reference](/administration/helm-values/) — every key named on this
  page, in full.
