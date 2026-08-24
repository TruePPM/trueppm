# Capacity harness — the published scale envelope

This harness produces the numbers behind **"Tested envelope"** in
`packages/website/src/content/docs/administration/sizing.md` (issue #2391). It is a different instrument from
`../load.js`, and conflating the two would misread both:

|  | `perf/load.js` (k6) | `perf/capacity/` (this) |
|---|---|---|
| Question | "did this get slower than last night?" | "what has this been tested to hold?" |
| Runs | nightly in CI, shared runner | on demand, off-CI, dedicated stack |
| Load | fixed profile | stepped up until first sustained breach |
| Verdict | trend / tripwire, `allow_failure` | a published number, or explicitly *not measured* |

## Why it is not k6

`load.js` needs k6 installed. This harness is plain Python against `requests` +
`websockets`, both already in the API environment, so any contributor with the
venv can reproduce a published figure without installing anything. A capacity
number nobody can re-run is a marketing claim, not a measurement.

## The stack under test

`docker-compose.capacity.yml` — an isolated stack under the `trueppm-capacity`
project name with its own volumes and ports (API 28000, Postgres 25432). It never
touches the dev stack's database.

It deliberately runs **`settings.prod` with `DEBUG=False` and the shipped image's
default CMD**. That default is a **single uvicorn process** (`Dockerfile:101`, no
`--workers`), which is itself one of the headline constraints — overriding it here
would measure a stack nobody deploys.

The `api` service has **no source mount**, so every measured number comes from the
packaged code as shipped. Only the on-demand `seeder` service mounts the working
tree, and seeding is not a measured path.

## Running it

```bash
# 0. Mint the two throwaway secrets this stack needs. Both are supplied from
#    the environment rather than committed: a literal key or password in a
#    tracked file is a secret-scanner finding however disposable it is. Same
#    `${VAR:?}` pattern the prod compose uses.

#    a. Fernet key for the integration-PAT boot guard (#1002).
export CAPACITY_INTEGRATION_KEY=$(python3 -c \
  'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')

#    b. Password for the load driver's account, capacity@trueppm.local (#2457).
#       `seed_capacity` creates the account with it and `run_capacity.py`
#       authenticates as it, so both read this one variable. Export it in the
#       same shell you run both from; the value is thrown away with the stack.
export TRUEPPM_CAPACITY_PASSWORD=$(python3 -c \
  'import secrets; print(secrets.token_urlsafe(16))')

# 1. Bring the isolated stack up (from repo root)
docker compose -f packages/api/perf/capacity/docker-compose.capacity.yml up -d

# 2. Sweep one dimension, or all of them
python packages/api/perf/capacity/run_capacity.py --dimension tasks
python packages/api/perf/capacity/run_capacity.py --dimension all --out packages/api/perf/capacity/results

# 3. Tear it down — `-v` also drops the seeded database
docker compose -f packages/api/perf/capacity/docker-compose.capacity.yml down -v
```

The runner re-seeds the database at each step via `manage.py seed_capacity`, so a
sweep is destructive **to the capacity stack only**.

## Gates

A step "breaches" when p95 > **2000 ms** or the error rate > **1%**.

2 s is the "still usable" line for opening a schedule — past it the Gantt reads as
broken rather than slow. The error gate is near-zero deliberately: a ceiling that
starts returning 500s is a different and worse failure than one that merely gets
slow, and the envelope must not conflate them.

## The host-noise control — read this before trusting any number

This harness runs on a developer workstation that is not otherwise idle. During
development the **same 2,000-task read measured 253 ms on a quiet host and
4,147 ms at load average 14** — a 16× swing with identical data. Publishing either
number unqualified would be meaningless.

So every step also measures `/api/v1/health/`, which does a constant trivial amount
of work, and records the host load average. If that control exceeds **150 ms** the
step is retried up to 3 times; if it stays high the step is recorded with
`contaminated: true` and **must not be published**. Contaminated steps are kept in
the results rather than dropped — silently discarding them would misreport the
sweep as having covered ground it did not.

**Known limitation of the control.** `/api/v1/health/` does not touch the database,
so it detects host **CPU** starvation but not **database** contention. A step can
pass the control and still be noisy. This is why `concurrent_users` is published as
*not measured* rather than as a number — see below.

## Dimensions

| Dimension | What it measures | Status |
|---|---|---|
| `tasks` | first page of the task list at rising project sizes | measured |
| `full_load` | every page of one project — what the Schedule pays before drawing a bar (#2277) | measured |
| `edges` | dependency-list read at rising edge density | measured, no breach found |
| `workspace` | project-list read at rising project and total-task counts | measured, no breach found |
| `concurrency` | concurrent authenticated readers | **not measured — irreproducible here** |

### Why `concurrent_users` is not published

Three runs of the identical single-reader step returned **90,433 ms**, **11,959 ms**
and **3,037 ms**, against **1,319 ms** for the same read in the `tasks` sweep. The
first two were partly a harness defect — too few samples and no warm-up, so p95 was
essentially the cold first call after a re-seed, now fixed. The residual spread is
host contention that the control does not catch (see the limitation above).

A concurrency ceiling asserted from that spread would be invented. It is recorded
as untested until it can be run on a quiet, dedicated host.

## What a result file contains

`results/capacity-<dimension>.json` carries the gates, the host description
(platform, CPU count, load average), the **git SHA the measured image was built
from**, and every step with `p95_ms`, `error_rate`, `control_p95_ms`, `load_avg`,
`attempts` and `contaminated`. A number without its SHA and host is not repeatable,
so both are recorded rather than assumed.

## Fidelity caveats

`seed_capacity` writes rows with `bulk_create`, which skips per-row `save()`. So the
seeded database has **no `django-simple-history` rows** and leaves `server_version`
at 0. Neither is read by a schedule or task-list request, so read latency is
unaffected — but on-disk size and any sync-delta measurement would understate an
organically grown database. Dependencies are generated strictly forward, which is
acyclic by construction and tidier than a real plan's topology.
