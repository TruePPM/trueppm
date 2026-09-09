---
title: Startup, Readiness, and Liveness Probes
description: What each TruePPM component's health probe actually checks, why it is shaped that way, and what to do when it fails.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
The Celery worker's **startup** probe, its heartbeat-file **readiness** probe, and
the tunable **web** probes are new in TruePPM 0.4 (#3346) and are **not** in
`v0.3.0-alpha.3`, the latest release. On 0.3 the worker has no startup probe and
its readiness probe is `celery inspect ping` on a 60s period — the mechanism this
page explains was built to replace for exactly that probe. `/api/v1/readyz`
itself, the api probes, and beat's liveness probe shipped earlier (0.1–0.3) and
are unchanged here except for two 0.4 additions: the disk-migration scan behind
`readyz` is now cached process-wide instead of rebuilt on every call, and the
endpoint carries its own rate limit instead of a full throttle exemption.
:::

Every TruePPM component ships with a probe that answers one of three questions,
and getting them confused is the single most common cause of a self-hosted
install that looks broken but is not (or, worse, looks fine but is not serving):

- **Startup** — has this component finished booting? While a startup probe is
  configured and has not yet passed, Kubernetes suspends the liveness probe
  entirely, so a slow first boot cannot be mistaken for a hang.
- **Readiness** — can this component serve traffic **right now**? A readiness
  failure removes the pod from its Service's endpoints (or, for a worker
  behind no Service, just paces a rolling update) — it does **not** restart
  anything, and it has no failure budget: one success is all it needs, so a
  probe that never gets one cannot be fixed by raising a threshold.
- **Liveness** — is the process itself still alive, as opposed to wedged? A
  liveness failure **kills the container**. This is a blunt, expensive
  instrument — the cost is a full restart plus whatever termination grace the
  component needs to shut down cleanly — so it should fail rarely and for a
  good reason.

The trap this page exists to name: **an exec probe that does real work runs
INSIDE the container it measures.** If that work competes for the same CPU or
process the container needs to do its actual job, a probe can fail a component
that is working correctly, simply because it was too busy to also answer the
probe in time. This is exactly what happened to the Celery worker's readiness
probe before 0.4 (`#3236`): a worker with zero restarts, processing jobs the
entire time, that never once answered `celery inspect ping` under load. Widening
the probe's timeout could not fix it — readiness has no failure budget to widen
around. The fix was to stop asking the worker to do expensive work to prove it
is ready, not to give it more time to do that work.

## At a glance

| Component | Startup | Readiness | Liveness |
|---|---|---|---|
| api (Django / ASGI) | off by default; `/health/` when enabled | `/readyz` — DB, cache, and migration state | `/health/` — process only |
| channels / websockets | — (same process as api) | — (same process as api) | — (same process as api) |
| celery worker | heartbeat file **exists** | heartbeat file **fresh** | `celery inspect ping` |
| celery beat | — | — (see [why beat has no readiness probe](#celery-beat)) | `celery inspect ping` (fleet) |
| valkey / postgres (bundled subcharts) | vendor default | vendor default | vendor default |
| web (nginx) | — (no boot-time dependency) | `GET /` — 200 | `GET /` — 200 |

Full tunable defaults for every row are in the
[Health probes section of the Helm values reference](/administration/helm-values/#health-probes).
Time-to-Ready and time-to-restart arithmetic at those defaults is in
[Deployment Sizing → Startup budget](/administration/sizing/#startup-budget).
Symptom-first diagnosis ("a pod never becomes ready", "a container reports
unhealthy while the site works fine") is in
[Troubleshooting](/administration/troubleshooting/) — this page explains the
mechanism; that one walks you through a specific failure.

## api (Django / ASGI)

**Readiness — `GET /api/v1/readyz`.** Deliberately unauthenticated (kubelet
carries no credential) and deliberately deep: it round-trips the database with a
bounded `SELECT 1`, round-trips the Valkey/Redis cache with a write-then-read,
and checks whether this image's migrations agree with the database's recorded
schema. A pod only joins the Service once all three answer `ok`. This is what
keeps a rolling upgrade from routing traffic to a pod whose code and schema
disagree — a pod mid-migration reports `migration_state: behind` and stays out
of the Service until its own `migrate` init container finishes.

*What to do when it fails:* read the response body — `checks` names which
dependency is down (`database`, `cache`, or `migrations`), and `migration_state`
distinguishes a rollout in progress (`behind`) from a rolled-back image serving
against a newer schema (`ahead`). See
[A pod never becomes ready, or migrations are pending](/administration/troubleshooting/#a-pod-never-becomes-ready-or-migrations-are-pending)
and [Every request returns 503](/administration/troubleshooting/#every-request-returns-503-and-no-api-pod-is-ready).

Two things changed here in 0.4, both perf/security hardening rather than new
behavior: the migration check used to rebuild the full on-disk migration graph
— a filesystem scan and a Python import per app — on **every single call**,
which at kubelet's default 10s readiness period meant a full rebuild every 10
seconds for every Ready pod, forever. That scan is now cached for the life of
the process (only the database's recorded-migrations state, which legitimately
changes mid-rollout, is re-read on every call). And the endpoint no longer gets
a blanket exemption from the API's shared rate limit the way `/health/` and
`/edition/` do — unlike those two it does real database and cache work per
call, so an unauthenticated caller who reached the pod IP directly (the probe
path bypasses the Ingress) could otherwise drive unbounded load with zero rate
limit. It now has its own generous, dedicated scope
(`env.TRUEPPM_THROTTLE_READYZ_RATE`, default `2000/min`) instead.

**Liveness — `GET /api/v1/health/`.** Deliberately shallow: it returns `200`
whenever the ASGI process is up, with no dependency check at all. This is what
keeps a transient database or cache blip from restart-looping a pod that
readiness has already, correctly, pulled out of the Service — restarting the
process would not fix a database outage, and would cost the boot time back on
top of it.

**Startup — off by default**, using the same `/health/` path. Turning it on
(`probes.api.startupEnabled: true`) moves the "how long can a first boot take"
question from liveness's own initial-delay/threshold math to an explicit
budget, and suspends liveness until it passes — worthwhile on a loaded cluster
where a cold pod's first boot is slower than a warm restart. See
[Startup probe](/administration/helm-values/#startup-probe) for the numbers.

## channels / websockets

There is no separate probe for real-time collaboration. WebSocket upgrades are
served by the same ASGI process and the same pods as the HTTP API — Django
Channels runs in-process, not as a separate Deployment — so `/readyz` and
`/health/` already answer "can this pod accept a WebSocket connection?" as a
side effect of answering "can this pod accept a request at all?". A pod that is
Ready is accepting WS upgrades; a pod that is not is not.

## celery worker

The worker has three probes with three different jobs, and, from 0.4, two
different mechanisms:

**Liveness — `celery inspect ping` against this pod's own worker node.** A
control-plane round trip over the broker, so it detects a wedged event loop
that a bare process-alive check would miss. This is the one probe still shaped
this way, deliberately: a missed liveness check only restarts the container, a
cost the worker's 300s termination grace already accounts for
(`failureThreshold × periodSeconds` is derived to match it exactly — see
[Tuning celery probes apart](/administration/helm-values/#tuning-celery-probes-apart)).
A restart is a bounded, recoverable cost in a way a permanently-false readiness
signal is not.

**Readiness — a heartbeat file's freshness, not `celery inspect ping` (#3346).**
A Celery signal handler (`trueppm_api.core.worker_heartbeat`) touches a file
(`probes.worker.heartbeatFile`, default `/tmp/trueppm-celery-worker-heartbeat`)
every time Celery's own internal `heartbeat_sent` signal fires — a fixed ~2s
timer that runs on the worker's MainProcess event loop, entirely independent of
whether the prefork pool is idle or fully saturated. The probe itself is a
plain `find <file> -newermt "-30 seconds"` — a filesystem stat, not a broker
round trip, not a Django import. This is what makes it safe to run far more
often (every 15s, versus the pre-0.4 60s) and, more importantly, what makes it
correct under load: its cost does not scale with how busy the worker is, so a
worker that is fully occupied processing a queue keeps answering readiness
exactly as fast as an idle one does.

**Startup — the same heartbeat file's mere existence.** The file is first
touched when Celery fires `worker_ready` — which only happens once the
worker's initial broker handshake (mingle/gossip) completes — so "the file
exists at all" is precisely "this worker has established a broker connection
at least once." Until it does, liveness stays suspended, so a slow first
connection cannot restart-loop the pod.

*What to do when readiness or startup fails:* check whether the worker process
is even running (`kubectl logs -c celery-worker`, or `docker compose logs
celery`) before assuming a probe bug — a worker that has genuinely crashed or
never connected to the broker will never touch the heartbeat file, and that is
the probe doing its job. If the worker's logs show it healthy and processing
tasks but the probe still fails, check the clock and the file directly:
`kubectl exec ... -- stat /tmp/trueppm-celery-worker-heartbeat` (or the Compose
equivalent) — a stale file with a healthy-looking log usually means the
worker's `--concurrency` is pinned so low, or the node so starved, that even
the MainProcess's own timer thread is not getting scheduled; see
[Deployment Sizing](/administration/sizing/) for concurrency guidance.
See also [Celery is not processing anything](/administration/troubleshooting/#celery-is-not-processing-anything)
for the broader diagnosis flow, and
[`#3236`](https://gitlab.com/trueppm/trueppm/-/issues/3236) for the original
incident this mechanism was built to fix. That issue's underlying root cause —
*why* the pre-0.4 `inspect ping` occasionally never got a reply from a
genuinely healthy worker — was never conclusively identified; the fix taken
here was to remove the class of probe that could fail that way, not to find
the specific reason it did.

## celery beat

**Liveness — `celery inspect ping` against the whole fleet**, not a specific
node — beat runs no worker control plane of its own, so this asserts "beat can
reach the broker, and at least one worker answers." A generous threshold keeps
a brief worker restart from taking beat down with it.

**No readiness probe, on purpose.** Beat is a pinned singleton behind no
Service (`replicas: 1`, `strategy: Recreate`) — a readiness probe would gate
nothing beyond rolling-update pacing that a singleton does not do, while still
costing a Django import in the chart's tightest resource budget (250m CPU /
256Mi). If beat's readiness question — has it loaded its schedule? — matters
to you operationally, the signal exists: beat writes its persistent schedule
shelve (`--schedule=/tmp/celerybeat-schedule`) on boot, before its first tick,
so the file's existence *is* "schedule loaded." The Docker Compose stacks check
this directly, since Compose has no Service for a Kubernetes-style readiness
probe to gate in the first place — see the table below.

For the *other* half of "is beat alive" — is it still ticking, days into an
install, as opposed to having merely booted once — see
[Beat Liveness](/administration/beat-liveness/) and its
`GET /api/v1/health/beat/` endpoint, which is a durable, database-backed
detector rather than a container-level probe. It is what survives beat and
every worker dying at once; the liveness probe above cannot.

## valkey / postgres (bundled subcharts)

The bundled PostgreSQL and Valkey subcharts ship their vendor-standard probes
unmodified (`pg_isready`, `valkey-cli ping`). TruePPM does not maintain or
override them. If you run either as a managed external service instead of the
bundled subchart (see
[Managed datastores](/administration/helm-values/#managed-external-datastores)),
its health is your managed provider's responsibility, and TruePPM only ever
observes it indirectly, through `/readyz`'s database/cache checks above.

## web (nginx)

**Readiness and liveness — `GET /` on both**, differing only in timing
(readiness reaches a first success at 5s so a rollout is not held up; liveness
waits until 10s and checks less often). Both are answered entirely by nginx
serving the pre-built static bundle — there is no backend dependency, which is
also why there is **no startup probe**: the container is either serving within
a second of starting or its process failed to start at all, and there is no
meaningful boot window in between for a startup probe to cover. These numbers
were previously hardcoded in the chart; from 0.4 they are tunable via
`probes.web.*` — see [the values reference](/administration/helm-values/#health-probes).

## Docker Compose equivalents

Docker Compose has one healthcheck per service, not three, so each maps to
whichever Kubernetes probe answers the question a Compose `depends_on:
condition: service_healthy` actually needs — almost always readiness, since
that is what other services should wait on before starting.

| Service | Compose healthcheck | Mirrors |
|---|---|---|
| `api` | `GET /api/v1/readyz` | api readiness |
| `celery` (worker) | heartbeat file freshness (`find ... -newermt`) | worker readiness |
| `celery-beat` | `test -e /tmp/celerybeat-schedule` | "schedule loaded" (beat has no Kubernetes readiness probe to mirror — see [above](#celery-beat)) |
| `db` / `valkey` | vendor healthchecks (`pg_isready`, `valkey-cli ping`) | vendor probes |
| `nginx` (production stack only) | `GET /api/v1/health/` through the reverse proxy | proves the front door — TLS termination plus both upstreams — rather than either component's own probe alone |

`api`'s Compose healthcheck changed from `/health/` to `/readyz` in 0.4 for the
same reason the two are different Kubernetes probes: `depends_on:
condition: service_healthy` is a readiness question ("can dependents start
using this now?"), and a shallow liveness check answers the wrong one — a
healthy-looking `api` container whose database was actually unreachable would
previously report `(healthy)` to Compose while every real request 503'd.
