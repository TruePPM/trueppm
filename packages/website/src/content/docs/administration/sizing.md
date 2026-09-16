---
title: Deployment Sizing
description: Preliminary hardware sizing best-guesses for 50, 100, and 200 concurrent users.
documentedFor: "0.4"
---

:::caution[Hardware sizing below is still a best-guess]
The **[Tested envelope](#tested-envelope)** section immediately below reports *measured* data-shape limits. Everything after it — the CPU/RAM/replica tiers — remains a **preliminary best-guess, not a benchmarked guarantee.** Large-scale hardening is on the pre-1.0 roadmap. Treat every hardware figure on this page as a starting point to **load-test against your own workload** before committing budget.
:::

This page has two halves. The **tested envelope** states what a pre-release build ahead of the 0.4 beta tag has been measured to hold and names the constraint that sets each ceiling. The **sizing tiers** that follow are derived from the shipped Helm defaults and the shape of the workload, not from measured capacity — adjust them once you have run TruePPM against your real schedules.

## Tested envelope

The envelope has been measured three times, and the first two runs were read wrongly. **On 2026-09-16 both earlier measurements were re-examined on one machine, back to back** ([#3829](https://gitlab.com/trueppm/trueppm/-/issues/3829)). That run found:

- The 2026-07-26 and 2026-09-15 runs were taken on **different computers**. This page previously recorded only the first, so the difference between them read as a change in the product.
- The harness had been measuring whatever query plan PostgreSQL happened to pick **before its planner statistics caught up** with the freshly seeded data.
- The cause of the 2,000-task "cliff" is **PostgreSQL's JIT compiler**, which TruePPM now turns off.

The whole-project row below is from that run; the other rows carry their date and machine.

These are the numbers TruePPM has been *tested* to hold. They are not the maximum it can hold, and they are not a promise about your hardware. Where a ceiling is set by known, already-triaged work, that issue is named — so you can judge whether your shape of project sits near an edge.

### Method

Measured with the capacity harness in [`packages/api/perf/capacity/`](https://gitlab.com/trueppm/trueppm/-/tree/main/packages/api/perf/capacity), which you can re-run yourself. It steps load up until the **first sustained breach** rather than driving a fixed profile, where a breach is **p95 > 2 s** or an **error rate > 1%**. 2 s is the "still usable" line for opening a schedule.

The stack under test is an isolated Docker Compose stack running `settings.prod` with `DEBUG=False` and the **shipped image's default command** — which is a *single uvicorn process*. That single process is itself one of the constraints below. PostgreSQL 16 runs with `shared_buffers=1GB`, `effective_cache_size=3GB`, `max_connections=200`.

**Hardware.** Two machines have been used, and **figures from different machines cannot be compared with each other** — the chips differ in core generation, performance/efficiency core mix, and memory bandwidth, and those differences do not all point the same way:

| Run | Machine | Docker Desktop allocation | Used for |
|---|---|---|---|
| 2026-07-26 | Apple M1 Max — 8 performance + 2 efficiency cores, 32 GiB | 10 CPU / 7.75 GiB | Dependency and workspace rows |
| 2026-09-15 | Apple M5 Pro — 6 performance + 12 efficiency cores, 64 GiB | 18 CPU / 8 GiB / 1 GiB swap | Task-list page row |
| 2026-09-16 | Apple M5 Pro, as above | 18 CPU / 8 GiB / 1 GiB swap | Whole-project row, and the diagnosis on this page |

Both are **single-node developer-class machines**, not a tuned multi-node cluster, and both are faster per core than a typical small VPS. Do not read either as a worst case.

**Statistics.** PostgreSQL chooses a query plan from statistics that `autovacuum` refreshes some time after data changes. The harness re-seeds a project at every step and does not run `ANALYZE`, so its readings depend on whether autovacuum has caught up yet. A real database has been running long enough that it has. **The whole-project row is therefore measured with `ANALYZE` run after seeding** — the steady state — and every load in it was measured individually, 7 per size. (The harness's own "p95" is its slowest of 7 samples, so it can be set by a single outlier.)

### What was measured

| Dimension | Tested to | Measured | What sets the ceiling |
|---|---|---|---|
| **Tasks per project** — one page of the task list | **10,000 tasks** | *2026-09-15, single run:* 0.15 s @ 1k · 0.25 s @ 2k · 0.64 s @ 4k · **0.68 s @ 8k**; a separate targeted run measured **0.44 s @ 10k** — no breach at any size | Page-bounded — **on page 1**. Deep pages cost far more (see below). Not re-measured at steady state; the 2026-07-26 breach at 8k (8.3 s) was on the other machine and cannot be compared |
| **Whole-project load** — every page, what the Schedule fetches before drawing a bar | **8,000 tasks** | *2026-09-16, current `main` with JIT off:* 0.47–0.58 s @ 1k · **1.07–1.37 s @ 2k** · 2.70–3.05 s @ 4k · 7.6–8.4 s @ 8k — breaches the 2 s line between 2k and 4k | [#2815](https://gitlab.com/trueppm/trueppm/-/issues/2815) and [#3381](https://gitlab.com/trueppm/trueppm/-/issues/3381) — each page still pays a pagination `COUNT` and an `OFFSET`, both of which grow with the project. **Without the JIT fix** the same build takes **14.4 s @ 2k** — see [why](#why-the-whole-project-ceiling-is-where-it-is) |
| **Dependency edges per project** | **12,000 edges** on a 4,000-task project | *2026-07-26:* 0.12–0.15 s, flat — **no breach found** | Not the binding constraint at this scale. Untested above 12,000 |
| **Projects per workspace / total tasks** | **50 projects · 50,000 tasks** | *2026-07-26:* 0.04–0.06 s, flat — **no breach found** | The project-list N+1 ([#1482](https://gitlab.com/trueppm/trueppm/-/issues/1482)) does not bite at this scale. Untested above 50 projects |

:::caution[Your PostgreSQL probably has JIT on — check it]
PostgreSQL enables JIT compilation by default, and **0.4.0-beta.1 does not turn it off**. On that build a 2,000-task project takes **about 41 seconds** to open in the Schedule on the machine above. Builds that include [#3829](https://gitlab.com/trueppm/trueppm/-/issues/3829) turn JIT off on every database connection TruePPM opens, the API's and the Celery workers' alike, and need nothing from you.

Two setups should also set it on the server:

- **You run PgBouncer in transaction-pooling mode.** TruePPM's per-connection setting lands only on whichever server connection happened to serve it, so it is best-effort there.
- **You are on 0.4.0-beta.1** and cannot upgrade yet.

Check with `SHOW jit;` as the TruePPM database user, and turn it off for that role:

```sql
ALTER ROLE trueppm SET jit = off;   -- takes effect on new connections
```

Managed PostgreSQL services (RDS, Cloud SQL, Azure) expose `jit` as a parameter-group setting; set it there if you cannot `ALTER ROLE`. TruePPM issues only short, repeated queries, which JIT's compile cost never pays back.
:::

:::caution[What was corrected on 2026-09-16, and what is still open]
- **Hardware was misattributed.** The 2026-09-15 figures were published as a re-run on the M1 Max. They were taken on the M5 Pro, so "the cause of the improvement is unknown" was comparing two computers. On one machine, the 2026-09-15 code was **slower** than the 2026-07-26 code at every size — 3× at 100 tasks, 6× at 500 — so there was no improvement to attribute ([#3828](https://gitlab.com/trueppm/trueppm/-/issues/3828)).
- **The 2,000-task figure understated the problem.** 2026-09-15 published 4.1 s. At steady state that build takes **~41 s**. The 4.1 s reading came from stale statistics.
- **The 2026-07-26 "60 s cliff" was real, not an artifact.** It is the JIT cost appearing once autovacuum had refreshed statistics, mid-step ([#3385](https://gitlab.com/trueppm/trueppm/-/issues/3385)).
- **The 500-task point is not a harness artifact.** It measures slower than 1,000 tasks in 3 of 3 runs on the 2026-09-15 code, and in 0 of 3 on the 2026-07-26 code, and it persists with JIT off. It is unexplained.
- **The 16,000-task task-list ceiling stays withdrawn.** It was the harness's cached token expiring after 15 minutes, not the product ([#3826](https://gitlab.com/trueppm/trueppm/-/issues/3826)). Figures above 10,000 tasks on the task-list row are still **not** published: two readings were slower than their own warm-up requests, and one landed on exactly 5000.0 ms, which is too round to be a latency.
:::

**Two things in this table matter more than the rest.**

**The Schedule is the binding constraint, not the database.** A project holds several thousand tasks comfortably while you page through a list, and a workspace absorbs 50,000 tasks without noticing. But when the **Schedule** opens a project the client pulls *every* page, and that is a far lower ceiling. Plan against **~2,000 tasks per project** on a build with the JIT fix, and **~1,000** on 0.4.0-beta.1 — not the 10,000 in the first row, which measures a single page rather than opening a project.

**Above that it slows steadily; it does not fall off a cliff.** With JIT off, each doubling of project size multiplies whole-project load by 2.2–2.7×, so a 4,000-task project opens in about 3 seconds and an 8,000-task one in about 8, rather than hanging. That is the shape of the two costs described below. The cliff this page used to warn about was JIT.

### Why the whole-project ceiling is where it is

This is the number most likely to decide whether TruePPM fits your project, so here is the mechanism rather than just the figure. Raw data for everything in this section is committed under [`packages/api/perf/capacity/results/2026-09-16-same-host/`](https://gitlab.com/trueppm/trueppm/-/tree/main/packages/api/perf/capacity/results/2026-09-16-same-host).

**The cliff was JIT compilation.** PostgreSQL JIT-compiles a query whose *estimated* cost passes `jit_above_cost` (100,000 by default), and optimizes and inlines it past 500,000. The task list's page query carries a dozen correlated subqueries, and once statistics describe a ~2,000-task project its estimate crosses all three thresholds. `EXPLAIN (ANALYZE, BUFFERS)` of one page, 2,000 tasks, `OFFSET 1000`, on the 2026-09-15 code:

| | Execution time |
|---|---|
| `jit = on` (default) | **4,512 ms** — of which JIT: optimization 549 ms, emission 3,872 ms |
| `jit = off` | **49 ms** |

That cost is paid on **every page**, independent of the offset. The PostgreSQL slow-query log over seven 2,000-task loads recorded 56 statements over 3 s, **every one of them the page query** and none the pagination `COUNT`. Whether a given measurement paid it depended on whether statistics had caught up yet, which is why it appeared as one slow sample on some runs, as a 60 s outlier on another, and not at all on the fastest.

**With JIT off, two costs remain, and both grow with project size.** A whole-project load is `ceil(N / 200)` page requests, and each one pays:

- **A pagination `COUNT` that re-runs the annotations.** `annotate_tasks_queryset` attaches annotations (`predecessor_count`, `linked_risks_count`, `external_link_count`, …). DRF's paginator calls `.count()` on that annotated queryset, which computes every annotation for every row in the project just to arrive at a number ([#2815](https://gitlab.com/trueppm/trueppm/-/issues/2815)).
- **An `OFFSET`** that has to produce every row before the page you asked for ([#3381](https://gitlab.com/trueppm/trueppm/-/issues/3381)).

Earlier figures for these costs — a `COUNT` of 457–503 ms against a 115 ms page, and page 70 at 4,890 ms, on a 4,000-task project ([#2807](https://gitlab.com/trueppm/trueppm/-/issues/2807)) — **predate the JIT finding and did not separate compile time from execution**. Treat them as upper bounds, not as the split between the two costs.

**What has already moved it.** On one machine at 2,000 tasks with JIT on, whole-project load fell from ~41 s on the 2026-09-15 code to ~14 s on current `main`. That span includes [#2814](https://gitlab.com/trueppm/trueppm/-/issues/2814), which replaced the aggregate annotations with subqueries and removed the query's `GROUP BY`, but it also includes every other change merged in between, and the gain has not been isolated to #2814. Turning JIT off, the only difference between the last two builds measured, took the same load from ~14 s to ~1.1 s.

### How this ceiling is raised in 0.5

With JIT off, the measured curve now has the shape the remaining costs predict:

| Step | Whole-project load | Growth for 2× the data |
|---|---|---|
| 1,000 → 2,000 | 0.50 s → 1.10 s | 2.2× |
| 2,000 → 4,000 | 1.10 s → 2.85 s | 2.6× |
| 4,000 → 8,000 | 2.85 s → 7.7 s | 2.7× |

The per-doubling growth is climbing toward 4× — the quadratic that summing an O(N) `COUNT` and an O(offset) skip over `N / 200` pages produces. Three changes are sequenced for **0.5**, tracked together on [#3383](https://gitlab.com/trueppm/trueppm/-/issues/3383):

| | What ships in 0.5 | Effect on the curve |
|---|---|---|
| [#2815](https://gitlab.com/trueppm/trueppm/-/issues/2815) | Count on the unannotated queryset, so pagination stops recomputing every annotation over every row | Removes one quadratic term outright |
| [#3381](https://gitlab.com/trueppm/trueppm/-/issues/3381) | Keyset pagination on the task read | Removes the `OFFSET` term entirely — this is the step that makes the fetch **linear** |
| [#3382](https://gitlab.com/trueppm/trueppm/-/issues/3382) | A slim bootstrap projection, so the Schedule stops fetching 99 fields per task to draw a bar | Cuts the constant, and removes the reason to walk pages at all for the first paint |

**No 0.5 number is promised here.** Each change has a mechanism but not yet a measured outcome. The nightly budgets set in [#2826](https://gitlab.com/trueppm/trueppm/-/issues/2826) are gross-regression tripwires (roughly the observed ceiling plus headroom for run-to-run contention), not a capacity signal: a green nightly rules out a large regression, and confirms no improvement. This page has already published one figure that a better measurement overturned. When the work above is measured, the rows will carry numbers instead of mechanisms.

One thing that is **not** on this list, and is deliberately not: loading only the visible
part of the schedule. The outline numbers each task by its position among the siblings
actually loaded, so a partial task set renders *wrong* rather than merely incomplete.
Fetching less is a correctness hazard in a way that fetching more cheaply is not, which is
why every change above makes the fetch cheaper instead.

### What was explicitly *not* measured

These are **untested**, not unbounded. Do not read silence as a guarantee.

| Dimension | Status |
|---|---|
| **Concurrent authenticated users** | **Not measured.** Three runs of the identical single-reader step returned 90 s, 12 s and 3 s for a read the task sweep measured at 1.3 s. The spread is contention on a shared developer workstation, and a ceiling asserted from it would be invented. Needs a quiet, dedicated host. Note that the shipped image runs **one uvicorn process**, so throughput scales by replica count — and [#2275](https://gitlab.com/trueppm/trueppm/-/issues/2275) (`ATOMIC_REQUESTS` with no connection pooler) is the expected first constraint |
| **Concurrent WebSocket connections per project** | **Not measured.** See [#2339](https://gitlab.com/trueppm/trueppm/-/issues/2339) — reconnect-storm scaling is a known open question |
| **Monte Carlo iterations at the task ceiling** | **Not measured**, but **capped**: `MC_TASK_CAP` (default `5000`) bounds the tasks a simulation will accept, alongside `MC_SIMULATION_CAP`. Within that cap it is untested — and [#2273](https://gitlab.com/trueppm/trueppm/-/issues/2273) means Monte Carlo runs on the request thread, so your gateway timeout binds before the cap does |
| **Import size (rows)** | **Not measured here.** CSV/Excel import ships in 0.4 ([#743](https://gitlab.com/trueppm/trueppm/-/issues/743)); its 10 MB / 5,000-row limit is enforced at the parser, not derived from this run. Note that importing to the row limit puts a project well past the whole-project Schedule ceiling above — the import preview warns when this would happen (see below), but does not block it |
| **Board rendering at scale** | **Not measured.** [#1538](https://gitlab.com/trueppm/trueppm/-/issues/1538) / [#2340](https://gitlab.com/trueppm/trueppm/-/issues/2340) — the board renders every card with no virtualization |
| **Gantt interaction at scale** | **Not measured.** [#1540](https://gitlab.com/trueppm/trueppm/-/issues/1540) / [#1587](https://gitlab.com/trueppm/trueppm/-/issues/1587) — O(N) hit-test per `pointermove` |
| **Sustained multi-day / multi-user soak** | **Not measured.** Every figure above is a point-in-time read sweep |

### Fidelity caveats

The seeded database is written with `bulk_create`, so it carries **no `django-simple-history` rows** and leaves `server_version` at 0. Neither is read by a schedule or task-list request, so read latency is unaffected — but **on-disk size and sync-delta timings would understate** an organically grown database. Generated dependencies are strictly forward-linked, which is tidier than a real plan's topology.

### Re-running this

:::caution[The harness does not start on 0.4 without a one-line change]
`docker-compose.capacity.yml` hard-codes an 8-character database password, and `settings.prod` refuses to boot on any service credential shorter than 12 characters — so `api-init` exits before the first migration runs. Until [#3826](https://gitlab.com/trueppm/trueppm/-/issues/3826) lands, substitute a longer password in the two places it appears: `POSTGRES_PASSWORD` under the `db` service, and the `DATABASE_URL` in the `&api_env` anchor.

That issue tracks a second fault worth knowing before you trust any result it gives you: the harness authenticates once and caches the token for an entire sweep with no refresh, while the access-token lifetime is 15 minutes. **Any sweep that runs longer than 15 minutes will report an error-rate breach at whatever step it happens to reach**, and that breach looks exactly like a capacity ceiling. One previously published ceiling on this page was withdrawn for precisely that reason.

Two more things before comparing a result with this page. The harness does **not** run `ANALYZE` after seeding, so a step can measure a plan chosen from stale statistics — run `ANALYZE` against the capacity database after each seed if you want the steady state this page reports. And it records only `os.cpu_count()` about the host, so **write down the machine and the Docker allocation yourself**: a figure without them cannot be compared with anything, which is how two computers came to be published as one.
:::

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

Raw results are committed under `packages/api/perf/capacity/results/`: the 2026-07-26 sweep at the top level, and the 2026-09-16 same-host run — every sweep, the steady-state diagnostics, `EXPLAIN` output, slow-query logs and the driver scripts — under `results/2026-09-16-same-host/`. The 2026-09-15 sweep's raw output was **not** committed.

:::note[This is a regression tripwire, not a capacity ceiling for you to plan against]
TruePPM runs a separate k6 harness (`packages/api/perf/load.js`) on the nightly schedule, and it does target a 1,000-task project. As of [#2826](https://gitlab.com/trueppm/trueppm/-/issues/2826) its four endpoint rows carry budgets, but they are gross-regression tripwires — each is roughly the worst p95 observed across 15 nightlies (2026-09-04 → 2026-09-15) plus ~30% headroom, e.g. `task_list` ranged 5,105–50,447 ms across those nights, a ~10× spread on identical data. That spread is runner variance, not contention: no job in `.gitlab-ci.yml` carries a `tags:` key, so every job is free-scheduled across three self-hosted runners of differing capability, and the same commit running the same test split has been recorded at 326 s on one and 783 s on another ([#3671](https://gitlab.com/trueppm/trueppm/-/issues/3671)).

Two things follow. A green nightly means "no gross regression," not "this page's numbers still hold" — read it as a floor, not a confirmation. And do not read the p95 figures themselves as a concurrency envelope; they are too noisy to be one, which is exactly why concurrent users appear as **not measured** above.
:::

## "Users" means concurrent active users

Throughout this page, **users** means *concurrent active* users, not named seats. PPM tools typically run at **~30–40% concurrency** — a 200-seat license rarely has 200 people clicking at once. If the numbers you are planning against are named seats rather than simultaneous sessions, divide expected load by roughly three before reading the tables below.

## What the shipped defaults give you

The Helm chart (`packages/helm/values.yaml`) ships these defaults:

- **API pod** (Django + uvicorn) and **Celery worker** each request `250m CPU / 512Mi` and limit at `1 CPU / 2Gi`. Both are driven by the **same** `replicaCount` key — there is no separate `celeryWorker.replicaCount` — and the production overlay sets it to `2`.
- **Web tier** (nginx + the compiled SPA) runs **one** replica. `web.replicaCount` does *not* inherit the top-level `replicaCount`, so `values-prod.yaml` leaves it at 1; set it explicitly.
- **Bundled PostgreSQL** requests `250m / 1Gi`, limits `2 CPU / 4Gi`, with an 8Gi PVC.
- **Bundled Valkey** requests `100m / 256Mi`, limits `1 CPU / 1Gi`, with a 2Gi PVC and **AOF persistence enabled** (`valkey-server --appendonly yes`).

The key constraint to understand: uvicorn runs a **single worker per pod** — `packages/api/Dockerfile` sets `CMD ["uvicorn", …]` with no `--workers` flag and the chart does not override it — so on Kubernetes request throughput scales by **replica count and nothing else**. Celery concurrency is pinned by the chart at `celeryWorker.concurrency` (default `2`); raise it toward the pod's CPU limit as you scale.

The **web** row was absent from this table until 0.4, and so was its redundancy:
`web.replicaCount` shipped as a truthy `1`, which meant the fallback to the
top-level `replicaCount` that `values.yaml` documented could never fire. A
`values-prod.yaml` deploy rendered api=2, worker=2, **web=1**, with no
PodDisruptionBudget on any tier — the only tier a browser actually loads was the
unprotected singleton. It now follows `replicaCount` like the rest.

:::caution[Replica counts alone are not redundancy]
Two replicas can both be scheduled onto the same node, where a node failure
takes 100% of the tier and a PodDisruptionBudget is never consulted. Set
`topologySpreadConstraints` (0.4; `values-prod.yaml` ships one) so replicas
spread across `kubernetes.io/hostname`, and give the cluster at least as many
nodes as your largest replica count. Every "2 nodes" figure below assumes that.
:::

## Sizing tiers

| | 50 concurrent | 100 concurrent | 200 concurrent |
|---|---|---|---|
| API (uvicorn) replicas | 2 | 3 | 4–6 |
| Web (nginx SPA) replicas | 2 | 2 | 2–3 |
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
concern — not a bigger version of this profile.) Here the
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

## Startup budget

How long each component can take to boot before Kubernetes gives up on it and
restarts the container, at the chart's shipped probe defaults. This is the
number to compare against your node's actual boot time (image pull, migration
count, broker reconnect) when deciding whether to raise a `failureThreshold` or
`periodSeconds` for a slower environment. Full probe semantics — what each one
checks, and what to do when it fails — are in
[Startup, Readiness, and Liveness Probes](/administration/probes/); this table
is only the arithmetic.

| Component | Time to first Ready (typical) | Time to restart if never Ready |
|---|---|---|
| api | ~10s (`readiness.initialDelaySeconds`) once migrations are applied and the DB/cache answer | With no startup probe (default): `livenessInitialDelaySeconds` (30) + `livenessFailureThreshold` (3) × `livenessPeriodSeconds` (30) = **120s**. With `probes.api.startupEnabled=true`: `startupFailureThreshold` (30) × `startupPeriodSeconds` (5) = **150s**, and liveness is suspended until startup passes. |
| celery worker | ~15s (`readiness.initialDelaySeconds`) once `worker_ready` has fired once | Startup: `failureThreshold` (30) × `periodSeconds` (5) = **150s** — this gates whether the container is ever considered for liveness at all. Liveness (once startup passes): `initialDelaySeconds` (60) + `failureThreshold` (5) × `periodSeconds` (60) = **360s total**, derived to match the worker's 300s termination grace so a kill never costs more unavailability than the detection that ordered it. |
| celery beat | N/A (liveness-only; no readiness, see below) | `initialDelaySeconds` (30) + `failureThreshold` (5) × `periodSeconds` (60) = **330s**. Beat's grace is only 30s, so a kill itself is cheap — the generous threshold exists to absorb a brief worker blip on the fleet ping, not a slow beat boot. |
| web (nginx) | ~5s (`readinessInitialDelaySeconds`) — no startup dependency, so this is close to the container's actual start time | `livenessInitialDelaySeconds` (10) + `failureThreshold` (3, chart default) × `livenessPeriodSeconds` (30) = **100s** |

Two numbers on this page are not tunable per-component budgets, on purpose:

- **Beat renders no readiness probe.** It is a pinned singleton behind no
  Service (`strategy: Recreate`, `replicas: 1`), so a readiness probe would
  gate nothing beyond rolling-update pacing that a singleton doesn't do, while
  still costing a Django import in the chart's tightest cgroup (250m CPU /
  256Mi). "Schedule loaded" — the readiness question the
  [scope table](/administration/probes/) poses for beat — is answered instead
  by the presence of the `--schedule` shelve file, which is what the Docker
  Compose healthchecks check directly (Helm has no Service to gate, so it does
  not render an equivalent probe).
- **The API's `failureThreshold` (3) on liveness is not itself configurable
  independent of the shared default** — it comes from
  `probes.api.livenessInitialDelaySeconds`/`livenessPeriodSeconds` plus
  Kubernetes' own default `failureThreshold: 3` on any probe block that does
  not set one explicitly (the API's `probes.*` values in `values.yaml` do not
  expose it as a separate key). Set it directly in a chart patch if your
  environment needs a different one.

## Bottlenecks, in the order they bite

1. **Celery / Monte Carlo CPU.** The scheduler is the heavy part. A portfolio reforecast or a Monte Carlo run (P50/P80/P95) is a CPU-bound burst. At 100+ concurrent users triggering recalculations, this is the first wall you hit. Scale Celery replicas, and raise `celeryWorker.concurrency` to match the pod's CPU limit. The chart pins this at `2` by default precisely so it never falls back to Celery's `cpu_count()` auto-detection, which reads the node's cores rather than the cgroup limit, over-allocates, and gets OOM-killed (the dev compose file caps it at 2 for the same reason).
2. **Single uvicorn worker per pod.** WebSocket collaboration keeps connections open (the Channels capacity of 1500 is fine), but request CPU is a single worker. Add `--workers` (roughly 2× vCPU) or scale replicas before reaching 100 users. **This is the single most important non-default change.**
3. **Postgres connection ceiling.** `CONN_MAX_AGE=60` and `ATOMIC_REQUESTS=true` mean every request runs inside a transaction and holds a connection. With many API and Celery workers, you approach PostgreSQL's default `max_connections=100` at the 200-user tier — add **PgBouncer** or raise `max_connections`.

## Production-vs-default caveats


These defaults are tuned for evaluation, not scale. At every tier above:

- The **bundled PostgreSQL and Valkey sub-charts are dev/demo only** — single replica, small PVCs, and **no replication or failover on either**. Both *do* persist: PostgreSQL on an 8Gi PVC and Valkey with AOF on a 2Gi PVC (`--appendonly yes`, default `appendfsync everysec` → roughly a 1 s broker RPO). What they cannot do is survive the loss of their one pod — and because `/api/v1/readyz` gates on a live cache round-trip, losing the Valkey pod marks every API pod `NotReady` and returns 503 for the whole application. Use a **managed PostgreSQL** (RDS, CloudSQL, etc.) and **managed Valkey** (ElastiCache for Valkey, Memorystore for Valkey, etc.) instead; operator-managed in-cluster HA modes for both are planned for 0.5 ([#3403](https://gitlab.com/trueppm/trueppm/-/issues/3403), [#3404](https://gitlab.com/trueppm/trueppm/-/issues/3404)). See [Valkey High Availability](/administration/valkey-ha/) for which topologies are supported, and [Durability & Redundancy](/administration/durability/#broker-persistence-per-artifact) for how the Compose stacks differ — `docker-compose.prod.yml` runs Valkey on a `tmpfs` with **no** persistence at all.
- **File attachments default to the local filesystem**, which is not durable and — above one replica — not even correct. From 0.4 the chart can back local storage with a claim (`persistence.media`), but a `ReadWriteOnce` claim binds to one node, so an upload accepted by one API pod is a `404` from the next; the chart refuses to render that combination. Every tier on this page runs the API at 2+ replicas, so at these sizes **object storage is a requirement, not a durability nicety**: set `TRUEPPM_DEFAULT_FILE_STORAGE` to an S3-compatible or MinIO backend together with `TRUEPPM_S3_BUCKET_NAME` — see [object storage](/administration/configuration/storage-and-networking/#object-storage-s3--minio). If you must stay on local disk, the claim needs a `ReadWriteMany` storage class (CephFS, NFS, Azure Files, EFS); see [attachment storage](/administration/helm-values/#attachment-storage-persistencemedia).
- **Check `jit` on the database you bring.** PostgreSQL enables JIT by default, and on 0.4.0-beta.1 it makes a 2,000-task Schedule take tens of seconds to open. Later builds turn it off per connection; behind PgBouncer in transaction-pooling mode, or on 0.4.0-beta.1, set `ALTER ROLE <user> SET jit = off` or the managed service's `jit` parameter as well. See [the JIT caution under Tested envelope](#tested-envelope).
- The **Horizontal Pod Autoscaler is off by default**, not absent. The chart ships an `autoscaling/v2` HPA for the API tier (and optionally the worker tier) behind `autoscaling.enabled`; the defaults scale the API between 2 and 6 replicas at 75% CPU utilization. It is opt-in because an HPA overrides the static `replicaCount` and **requires `metrics-server`** (or a custom metrics adapter) to be installed in the cluster. Without it, scale replicas manually. See the [values reference](/administration/helm-values/) for the full key list.
- **Autoscale the API tier; keep the worker tier on fixed replicas.** The `celeryWorker.concurrency` pinning advice above and a CPU-utilization HPA are two different answers to the same load, and following both naively double-counts: the HPA adds worker pods while each pod's concurrency is already pinned to its CPU limit, so a Monte Carlo burst can multiply total in-flight tasks well past what the database connection ceiling tolerates. Until worker autoscaling keys off queue depth rather than CPU, the safe posture is `autoscaling.enabled=true` with `autoscaling.worker.enabled=false` — HPA for request-serving traffic, fixed replicas plus pinned concurrency for the CPU-bound queue.

## Per-tier recommendation summary

- **50 users:** single node, 4 vCPU / 8 GB, a small managed PostgreSQL; run the API at 2 replicas × 2 uvicorn workers.
- **100 users:** 2 nodes, 8 vCPU / 16 GB total; scale Celery separately from the API; PgBouncer optional.
- **200 users:** 2–3 nodes, 16 vCPU / 32 GB; a dedicated Celery node pool; PgBouncer required; managed Valkey with persistence.

## Before you commit

Load-test against your own workload before committing budget or hardware. The dominant cost is workload-specific — how many schedules are active and how often reforecasts and Monte Carlo runs fire matters far more than raw user count. Until real benchmarks exist, **every figure on this page is a best-guess.**

See [Deployment](/administration/deployment/) for the underlying Helm chart and Docker Compose topology, and [Networking](/administration/networking/#scaling-out) for where the load balancer sits and the checklist to work through before raising `replicaCount` past one.
