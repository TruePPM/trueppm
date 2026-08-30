---
title: Deployment Sizing
description: Preliminary hardware sizing best-guesses for 50, 100, and 200 concurrent users.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
This page is written against **TruePPM 0.4**, the first beta, and parts of it are
**not** in `v0.3.0-alpha.3`, the latest release:

- **The tested envelope** was measured against a pre-release build ahead of the
  0.4 tag, not against 0.3.
- **The chart values it names** — `web.replicaCount`, `autoscaling.*`,
  `podDisruptionBudget.*`, `celeryWorker.concurrency` — ship in 0.4. On 0.3 the
  chart has none of them, and `replicaCount` is the only scaling knob.

The bottleneck analysis, the concurrency arithmetic, and the PgBouncer guidance
apply to 0.3 as well.
:::

:::caution[Hardware sizing below is still a best-guess]
The **[Tested envelope](#tested-envelope)** section immediately below reports *measured* data-shape limits. Everything after it — the CPU/RAM/replica tiers — remains a **preliminary best-guess, not a benchmarked guarantee.** Large-scale hardening is on the pre-1.0 roadmap. Treat every hardware figure on this page as a starting point to **load-test against your own workload** before committing budget.
:::

This page has two halves. The **tested envelope** states what a pre-release build ahead of the 0.4 beta tag has been measured to hold and names the constraint that sets each ceiling. The **sizing tiers** that follow are derived from the shipped Helm defaults and the shape of the workload, not from measured capacity — adjust them once you have run TruePPM against your real schedules.

## Tested envelope

Measured against a pre-release build ahead of the **0.4 beta** tag, on **2026-07-26**, against commit `89fc5137f`.

These are the numbers TruePPM has been *tested* to hold. They are not the maximum it can hold, and they are not a promise about your hardware. Where a ceiling is set by known, already-triaged work, that issue is named — so you can judge whether your shape of project sits near an edge.

### Method

Measured with the capacity harness in [`packages/api/perf/capacity/`](https://gitlab.com/trueppm/trueppm/-/tree/main/packages/api/perf/capacity), which you can re-run yourself. It steps load up until the **first sustained breach** rather than driving a fixed profile, where a breach is **p95 > 2 s** or an **error rate > 1%**. 2 s is the "still usable" line for opening a schedule.

The stack under test is an isolated Docker Compose stack running `settings.prod` with `DEBUG=False` and the **shipped image's default command** — which is a *single uvicorn process*. That single process is itself one of the constraints below.

**Hardware:** Apple M1 Max, 10 cores (8 performance / 2 efficiency), 32 GiB RAM, macOS 26.5.1; Docker Desktop allocated 10 CPUs and 7.75 GiB. Postgres 16 with `shared_buffers=1GB`, `effective_cache_size=3GB`, `max_connections=200`.

This is a **single-node developer-class machine**, which is deliberately close to what a 0.4 beta self-hoster actually runs — not a tuned multi-node production cluster. A dedicated server will do better; a small VPS will do worse.

### What was measured

| Dimension | Tested to | Measured p95 | What sets the ceiling |
|---|---|---|---|
| **Tasks per project** — one page of the task list | **4,000 tasks** | 0.35 s @ 500 · 0.57 s @ 1k · 1.19 s @ 2k · **1.99 s @ 4k** · breaches at 8k (8.3 s) | Page-bounded, so it degrades gently. 4,000 sits *on* the 2 s gate — treat 2,000 as the comfortable figure |
| **Whole-project load** — every page, what the Schedule fetches before drawing a bar | **1,000 tasks** | 0.22 s @ 100 · 0.50 s @ 250 · 0.96 s @ 500 · **1.85 s @ 1k** · breaches at 2k (**60 s**) | [#2277](https://gitlab.com/trueppm/trueppm/-/issues/2277) — the Schedule loads the entire project into memory via `fetchAllPagesParallel`; there is no windowing |
| **Dependency edges per project** | **12,000 edges** on a 4,000-task project | 0.12–0.15 s, flat — **no breach found** | Not the binding constraint at this scale. Untested above 12,000 |
| **Projects per workspace / total tasks** | **50 projects · 50,000 tasks** | 0.04–0.06 s, flat — **no breach found** | The project-list N+1 ([#1482](https://gitlab.com/trueppm/trueppm/-/issues/1482)) does not bite at this scale. Untested above 50 projects |

:::caution[The two task-list rows are pending a re-measure — updated 2026-08-09]
Both task rows above were measured **before** the `GET /tasks/` latency regression window of 2026-08-04 → 2026-08-05 ([#2767](https://gitlab.com/trueppm/trueppm/-/issues/2767)), and have not been re-run since. Treat them as the last known-good envelope, not as current.

Two corrections that follow from the [#2807](https://gitlab.com/trueppm/trueppm/-/issues/2807) diagnosis, and that the numbers above do not yet reflect:

- **"Page-bounded, so it degrades gently" holds for the first page only.** The harness reads page 1 (`run_capacity.py`). Later pages do not degrade gently: `OFFSET n` cannot skip work on this endpoint, so cost grows with how deep the page is. On a 4,000-task project, page 1 and page 70 of the same request differed by roughly 40× in database time. This is also the most likely explanation for the 32× whole-project cliff between 1,000 and 2,000 tasks in the row below it.
- **The task list paginated with no `ORDER BY`** until this release, so the whole-project figure was measured against a fetch whose page boundaries were not guaranteed stable. Pagination is now explicitly ordered.

Tracked in [#2814](https://gitlab.com/trueppm/trueppm/-/issues/2814) and [#2815](https://gitlab.com/trueppm/trueppm/-/issues/2815). Re-run `packages/api/perf/capacity/` on the documented hardware at the next tag and replace both rows.
:::

**Two things in this table matter more than the rest.**

**The Schedule is the binding constraint, not the database.** A project holds several thousand tasks comfortably while you page through a list, and a workspace absorbs 50,000 tasks without noticing. But when the **Schedule** opens a project the client pulls *every* page, and that is a far lower ceiling. If you work in the Gantt, plan against **~1,000 tasks per project** in 0.4 — not 4,000.

**Past that point it is a cliff, not a slope.** Whole-project load goes from **1.85 s at 1,000 tasks to 60 s at 2,000** — a 32× jump for a 2× increase in data. Doubling from a comfortable project does not get you a slow project; it gets you one that reads as hung. That non-linearity is the single most important thing to know before committing a large plan to 0.4, and it is why [#2277](https://gitlab.com/trueppm/trueppm/-/issues/2277) is named rather than buried.

### What was explicitly *not* measured

These are **untested**, not unbounded. Do not read silence as a guarantee.

| Dimension | Status |
|---|---|
| **Concurrent authenticated users** | **Not measured.** Three runs of the identical single-reader step returned 90 s, 12 s and 3 s for a read the task sweep measured at 1.3 s. The spread is contention on a shared developer workstation, and a ceiling asserted from it would be invented. Needs a quiet, dedicated host. Note that the shipped image runs **one uvicorn process**, so throughput scales by replica count — and [#2275](https://gitlab.com/trueppm/trueppm/-/issues/2275) (`ATOMIC_REQUESTS` with no connection pooler) is the expected first constraint |
| **Concurrent WebSocket connections per project** | **Not measured.** See [#2339](https://gitlab.com/trueppm/trueppm/-/issues/2339) — reconnect-storm scaling is a known open question |
| **Monte Carlo iterations at the task ceiling** | **Not measured.** [#2273](https://gitlab.com/trueppm/trueppm/-/issues/2273) — Monte Carlo runs on the request thread, so it is bounded by your gateway timeout before anything else |
| **Import size (rows)** | **Not measured here.** The 10 MB / 5,000-row limit claimed for CSV/Excel import is enforced at the parser, not derived from this run — see [#743](https://gitlab.com/trueppm/trueppm/-/issues/743) |
| **Board rendering at scale** | **Not measured.** [#1538](https://gitlab.com/trueppm/trueppm/-/issues/1538) / [#2340](https://gitlab.com/trueppm/trueppm/-/issues/2340) — the board renders every card with no virtualization |
| **Gantt interaction at scale** | **Not measured.** [#1540](https://gitlab.com/trueppm/trueppm/-/issues/1540) / [#1587](https://gitlab.com/trueppm/trueppm/-/issues/1587) — O(N) hit-test per `pointermove` |
| **Sustained multi-day / multi-user soak** | **Not measured.** Every figure above is a point-in-time read sweep |

### Fidelity caveats

The seeded database is written with `bulk_create`, so it carries **no `django-simple-history` rows** and leaves `server_version` at 0. Neither is read by a schedule or task-list request, so read latency is unaffected — but **on-disk size and sync-delta timings would understate** an organically grown database. Generated dependencies are strictly forward-linked, which is tidier than a real plan's topology.

### Re-running this

The numbers carry the version they were measured against so they can be compared next release:

The stack takes its two secrets from the environment rather than from committed defaults, so mint a throwaway pair first — they are discarded with the stack:

```bash
export CAPACITY_INTEGRATION_KEY=$(python3 -c \
  'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')
export TRUEPPM_CAPACITY_PASSWORD=$(python3 -c \
  'import secrets; print(secrets.token_urlsafe(16))')

docker compose -f packages/api/perf/capacity/docker-compose.capacity.yml up -d
python packages/api/perf/capacity/run_capacity.py --dimension all \
  --out packages/api/perf/capacity/results
docker compose -f packages/api/perf/capacity/docker-compose.capacity.yml down -v
```

Raw results, including the per-step host load average and noise-control readings, are committed under `packages/api/perf/capacity/results/`.

## "Users" means concurrent active users

Throughout this page, **users** means *concurrent active* users, not named seats. PPM tools typically run at **~30–40% concurrency** — a 200-seat license rarely has 200 people clicking at once. If the numbers you are planning against are named seats rather than simultaneous sessions, divide expected load by roughly three before reading the tables below.

## What the shipped defaults give you

The Helm chart (`packages/helm/values.yaml`) ships these defaults:

- **API pod** (Django + uvicorn) and **Celery worker** each request `250m CPU / 512Mi` and limit at `1 CPU / 2Gi`. Both are driven by the **same** `replicaCount` key — there is no separate `celeryWorker.replicaCount` — and the production overlay sets it to `2`.
- **Web tier** (nginx + the compiled SPA) runs **one** replica. `web.replicaCount` does *not* inherit the top-level `replicaCount`, so `values-prod.yaml` leaves it at 1; set it explicitly.
- **Bundled PostgreSQL** requests `250m / 1Gi`, limits `2 CPU / 4Gi`, with an 8Gi PVC.
- **Bundled Valkey** requests `100m / 256Mi`, limits `1 CPU / 1Gi`, with a 2Gi PVC and **AOF persistence enabled** (`valkey-server --appendonly yes`).

The key constraint to understand: uvicorn runs a **single worker per pod** — `packages/api/Dockerfile` sets `CMD ["uvicorn", …]` with no `--workers` flag and the chart does not override it — so on Kubernetes request throughput scales by **replica count and nothing else**. Celery concurrency is pinned by the chart at `celeryWorker.concurrency` (default `2`); raise it toward the pod's CPU limit as you scale.

## Sizing tiers

| | 50 concurrent | 100 concurrent | 200 concurrent |
|---|---|---|---|
| API (uvicorn) replicas | 2 | 3 | 4–6 |
| Celery worker replicas | 1 (concurrency 2–4) | 2 (concurrency 4) | 3–4 (concurrency 4) |
| API total CPU / RAM | ~1 vCPU / 2Gi | ~1.5 vCPU / 3Gi | ~3 vCPU / 6Gi |
| Celery total CPU / RAM | ~1 vCPU / 2Gi | ~2 vCPU / 4Gi | ~4 vCPU / 8Gi |
| PostgreSQL | 2 vCPU / 4Gi, 20Gi disk | 2–4 vCPU / 8Gi, 50Gi | 4 vCPU / 16Gi, 100Gi |
| Valkey / Redis | 1 vCPU / 1Gi | 1 vCPU / 2Gi | 2 vCPU / 4Gi |
| **Cluster total (with headroom)** | **~4 vCPU / 8 GB, 1 node** | **~8 vCPU / 16 GB, 2 nodes** | **~16 vCPU / 32 GB, 2–3 nodes** |

## Two worked profiles: team of 25 vs team of 250

The tiers above are keyed to *concurrent* users. Most operators plan against a
**team size** (named seats) instead, so here are two fully worked profiles at the
ends of the OSS single-program range. Both apply the ~30–40% concurrency rule:
a **team of 25** is ~8–10 concurrent, a **team of 250** is ~75–100 concurrent.
Every number is a starting point to load-test against your own workload, not a
guarantee.

### Profile A — team of 25 (single program, one node)

A single PM and their team. Fits comfortably on one small node; the bundled
subcharts are *still* not recommended for real data, but a single managed
Postgres and managed Valkey are inexpensive at this size.

| Component | Replicas | Requests (CPU / mem) | Limits (CPU / mem) |
|---|---|---|---|
| API (uvicorn, 2 workers/pod — [non-default](#raising-the-uvicorn-worker-count)) | 2 | `250m / 512Mi` | `1 / 1Gi` |
| Celery worker (`--concurrency 2`) | 1 | `250m / 512Mi` | `1 / 2Gi` |
| PostgreSQL (managed) | 1 | `1 vCPU / 2Gi` | `2 / 4Gi` |
| Valkey / Redis (managed) | 1 | `250m / 512Mi` | `1 / 1Gi` |

- **Cluster total (with headroom):** ~4 vCPU / 8 GB, **1 node**, ~20Gi Postgres disk.
- **PgBouncer:** not needed — connection count stays well under `max_connections=100`.
- **API workers:** the single most important non-default change is `--workers 2`
  on the API pods; at 2 replicas that is 4 request workers, ample for ~10
  concurrent. It is genuinely non-default — see
  [Raising the uvicorn worker count](#raising-the-uvicorn-worker-count) for what
  it takes on each deployment path.

### Profile B — team of 250 (large program, dedicated pools)

A large program at the top of the OSS single-program envelope. (Coordinating
*multiple* programs under one PMO is portfolio governance — an Enterprise
concern, `enterprise#20` — not a bigger version of this profile.) Here the
scheduler CPU and the Postgres connection ceiling both bite, so Celery gets its
own pool and PgBouncer is mandatory.

| Component | Replicas | Requests (CPU / mem) | Limits (CPU / mem) |
|---|---|---|---|
| API (uvicorn, 2–3 workers/pod — [non-default](#raising-the-uvicorn-worker-count)) | 4–6 | `500m / 1Gi` | `1 / 2Gi` |
| Celery worker (`--concurrency 4`, pinned) | 3–4 | `500m / 1Gi` | `2 / 4Gi` |
| PostgreSQL (managed) | 1 (+ replica optional) | `4 vCPU / 16Gi` | `4 / 16Gi` |
| PgBouncer | 2 | `100m / 128Mi` | `500m / 256Mi` |
| Valkey / Redis (managed, persistent) | 1 | `1 vCPU / 2Gi` | `2 / 4Gi` |

- **Cluster total (with headroom):** ~16 vCPU / 32 GB, **2–3 nodes**, ~100Gi Postgres disk.
- **PgBouncer:** **required.** `ATOMIC_REQUESTS=true` + `CONN_MAX_AGE=60` means every
  API and Celery worker holds a Postgres connection; 6 API pods × 3 workers + 4
  Celery pods × 4 will exceed the default `max_connections=100` without pooling.
- **Celery pinning:** set `celeryWorker.concurrency: 4` to match the pod CPU
  limit. The chart pins concurrency for you — it defaults to `2` — so the worker
  never falls back to Celery's `cpu_count()` default, which reads the *node's*
  core count rather than the cgroup CPU limit and gets OOM-killed on a large
  shared node.
- **Dedicated Celery node pool:** keep reforecast/Monte Carlo CPU bursts off the
  request-serving API pods so a portfolio recompute never starves interactive traffic.

Both profiles slot into the [values reference](/administration/helm-values/) —
set `replicaCount` / `web.replicaCount`, `resources.*`, the managed-datastore
`env.DATABASE_URL` / `env.REDIS_URL`, and (for Profile B) `celeryWorker.concurrency`.

### Raising the uvicorn worker count

Both profiles above assume more than one uvicorn worker per API pod. **That is not
what the shipped image does**, and the two figures are not in conflict — one
describes the default, the other describes the change you should make.

The image's `CMD` is `uvicorn trueppm_api.asgi:application --host 0.0.0.0 --port
8000`, with no `--workers`. How you change it depends on the path:

| Path | How |
|---|---|
| **Docker Compose** | Override the `api` service's `command` in `docker-compose.override.yml`, appending `--workers 2`. |
| **Single server with systemd** | Add `--workers N` to the `ExecStart` line. |
| **Helm** | **There is no chart value for this.** The chart renders no `command` or `args` for the `api` container and exposes no `extraArgs` on it (unlike `celeryWorker.extraArgs`). Scale the API tier with `replicaCount` instead, or supply the flag with a post-render patch or a derived image. |

On Kubernetes, `replicaCount` and multi-worker pods buy the same throughput; a
replica additionally buys you redundancy, which a second worker in the same pod
does not. Prefer replicas there. See [Durability &
Redundancy](/administration/durability/#the-step-up-ladder) for what that costs.

## Bottlenecks, in the order they bite

1. **Celery / Monte Carlo CPU.** The scheduler is the heavy part. A portfolio reforecast or a Monte Carlo run (P50/P80/P95) is a CPU-bound burst. At 100+ concurrent users triggering recalculations, this is the first wall you hit. Scale Celery replicas, and raise `celeryWorker.concurrency` to match the pod's CPU limit. The chart pins this at `2` by default precisely so it never falls back to Celery's `cpu_count()` auto-detection, which reads the node's cores rather than the cgroup limit, over-allocates, and gets OOM-killed (the dev compose file caps it at 2 for the same reason).
2. **Single uvicorn worker per pod.** WebSocket collaboration keeps connections open (the Channels capacity of 1500 is fine), but request CPU is a single worker. Add `--workers` (roughly 2× vCPU) or scale replicas before reaching 100 users. **This is the single most important non-default change.**
3. **Postgres connection ceiling.** `CONN_MAX_AGE=60` and `ATOMIC_REQUESTS=true` mean every request runs inside a transaction and holds a connection. With many API and Celery workers, you approach PostgreSQL's default `max_connections=100` at the 200-user tier — add **PgBouncer** or raise `max_connections`.

## Production-vs-default caveats

:::note[Ships in 0.4]
One item below is ahead of the current release: the `persistence.media` chart
block that backs local attachment storage with a claim. On 0.3 the chart has no
media volume at all, so local attachment storage cannot work on either supported
production path and object storage is the only option. Everything else in this
section describes the current release.
:::


These defaults are tuned for evaluation, not scale. At every tier above:

- The **bundled PostgreSQL and Valkey sub-charts are dev/demo only** — single replica, small PVCs, and **no replication or failover on either**. Both *do* persist: PostgreSQL on an 8Gi PVC and Valkey with AOF on a 2Gi PVC (`--appendonly yes`, default `appendfsync everysec` → roughly a 1 s broker RPO). What they cannot do is survive the loss of their one pod — and because `/api/v1/readyz` gates on a live cache round-trip, losing the Valkey pod marks every API pod `NotReady` and returns 503 for the whole application. Use a **managed PostgreSQL** (RDS, CloudSQL, etc.) and **managed Valkey** (ElastiCache for Valkey, Memorystore for Valkey, etc.) instead. See [Valkey High Availability](/administration/valkey-ha/) for which topologies are supported, and [Durability & Redundancy](/administration/durability/#broker-persistence-per-artifact) for how the Compose stacks differ — `docker-compose.prod.yml` runs Valkey on a `tmpfs` with **no** persistence at all.
- **File attachments default to the local filesystem**, which is not durable and — above one replica — not even correct. From 0.4 the chart can back local storage with a claim (`persistence.media`), but a `ReadWriteOnce` claim binds to one node, so an upload accepted by one API pod is a `404` from the next; the chart refuses to render that combination. Every tier on this page runs the API at 2+ replicas, so at these sizes **object storage is a requirement, not a durability nicety**: set `TRUEPPM_DEFAULT_FILE_STORAGE` to an S3-compatible or MinIO backend together with `TRUEPPM_S3_BUCKET_NAME` — see [object storage](/administration/configuration/#object-storage-s3--minio). If you must stay on local disk, the claim needs a `ReadWriteMany` storage class (CephFS, NFS, Azure Files, EFS); see [attachment storage](/administration/helm-values/#attachment-storage-persistencemedia).
- The **Horizontal Pod Autoscaler is off by default**, not absent. The chart ships an `autoscaling/v2` HPA for the API tier (and optionally the worker tier) behind `autoscaling.enabled`; the defaults scale the API between 2 and 6 replicas at 75% CPU utilization. It is opt-in because an HPA overrides the static `replicaCount` and **requires `metrics-server`** (or a custom metrics adapter) to be installed in the cluster. Without it, scale replicas manually. See the [values reference](/administration/helm-values/) for the full key list.
- **Autoscale the API tier; keep the worker tier on fixed replicas.** The `celeryWorker.concurrency` pinning advice above and a CPU-utilization HPA are two different answers to the same load, and following both naively double-counts: the HPA adds worker pods while each pod's concurrency is already pinned to its CPU limit, so a Monte Carlo burst can multiply total in-flight tasks well past what the database connection ceiling tolerates. Until worker autoscaling keys off queue depth rather than CPU, the safe posture is `autoscaling.enabled=true` with `autoscaling.worker.enabled=false` — HPA for request-serving traffic, fixed replicas plus pinned concurrency for the CPU-bound queue.

## Per-tier recommendation summary

- **50 users:** single node, 4 vCPU / 8 GB, a small managed PostgreSQL; run the API at 2 replicas × 2 uvicorn workers.
- **100 users:** 2 nodes, 8 vCPU / 16 GB total; scale Celery separately from the API; PgBouncer optional.
- **200 users:** 2–3 nodes, 16 vCPU / 32 GB; a dedicated Celery node pool; PgBouncer required; managed Valkey with persistence.

## Before you commit

Load-test against your own workload before committing budget or hardware. The dominant cost is workload-specific — how many schedules are active and how often reforecasts and Monte Carlo runs fire matters far more than raw user count. Until real benchmarks exist, **every figure on this page is a best-guess.**

See [Deployment](/administration/deployment/) for the underlying Helm chart and Docker Compose topology, and [Networking](/administration/networking/#scaling-out) for where the load balancer sits and the checklist to work through before raising `replicaCount` past one.
