---
title: Valkey High Availability
description: Why Valkey is load-bearing for real-time, async, and caching at once, which HA topologies TruePPM actually supports, and how to run it highly available without a commercial Redis license.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
Two things on this page are new in **TruePPM 0.4**, the first beta, and are **not**
in `v0.3.0-alpha.3`, the latest release:

- **Sentinel support** — the whole of [Configuring Sentinel](#configuring-sentinel),
  the `TRUEPPM_VALKEY_*` settings, and the `valkey.sentinel` chart block. On 0.3
  there is no Sentinel wiring and `REDIS_URL` is the only way to reach Valkey.
- **The readiness coupling.** `/api/v1/readyz` and the chart's `probes` block ship
  in 0.4, so the "every API pod goes NotReady" behavior described in the caution
  below and in the [failure-mode
  matrix](#failure-mode-matrix--what-happens-when-valkey-is-down) is 0.4 onward.
  On 0.3 the chart wires no readiness probe, so a Valkey outage leaves the pods in
  the Service and the failures surface per-subsystem instead.

Everything else — the four load-bearing roles, the supported topologies, the
cluster-mode prohibition, the bundled pod's AOF persistence, and the licensing
discussion — applies to 0.3 as well.
:::

TruePPM uses **Valkey** — the BSD-3-Clause, Linux Foundation fork of Redis — for
four distinct roles **at the same time**. A single Valkey outage therefore
degrades or disables four subsystems simultaneously. For a production on-prem
deployment, running Valkey highly available is **effectively mandatory**, not
optional.

Valkey speaks the Redis wire protocol, so TruePPM's configuration surface keeps
the Redis names: the connection string is `REDIS_URL`, the scheme is `redis://`
(or `rediss://` for TLS), and the client libraries are `redis-py` and
`channels-redis`. Any Redis-compatible server works. Valkey is what the chart and
Compose files ship.

:::caution[The bundled Valkey pod is a whole-application single point of failure]
The Valkey pod in the Helm chart is a **single node with no replication or
failover**. It is fine for evaluation and small single-team installs, but it is
**not** a production-HA configuration.

Losing that one pod does not merely degrade real-time collaboration, background
jobs, and caching. `/api/v1/readyz` — which the chart uses as the API's readiness
probe — gates on a live cache round-trip, so a Valkey outage marks **every API pod
`NotReady`**, empties the Service endpoints, and leaves the ingress returning
**503** for the entire application. See the [failure-mode
matrix](#failure-mode-matrix--what-happens-when-valkey-is-down) below.
:::

## The dependency surface — one Valkey, four load-bearing roles

Valkey is not a "nice to have" cache you can shed. It is wired into four
independent subsystems, each on its own logical database index:

| Role | Database | What uses it | What it does |
|------|----------|--------------|--------------|
| **Celery broker** | `/0` | Async / background work | Queues every asynchronous job — CPM recalculation drains, MS Project imports, webhook delivery, retention purges, notification email. |
| **Django Channels layer** | `/1` | Real-time collaboration, WebSocket fan-out | Carries live board/schedule updates and presence between API pods. Every connected client depends on it. |
| **Django cache backend** | `/2` | Read-path caching, rate limiting, transient state | Backs cached reads, DRF throttle counters, and short-lived OIDC/OAuth login state (the PKCE verifier and nonce for an in-flight SSO login). |
| **Notification throttles** | `/3` | Mention fan-out limits | Counters bounding notification volume per user. |

Because all four point at the same Valkey instance, its availability is a
**shared fate**: a broker outage is also a Channels outage is also a cache outage.
Sizing and hardening Valkey is therefore a production concern on par with the
database, not an afterthought.

## Which HA topologies TruePPM supports today

This is the part that determines your deployment, so read it before choosing a
topology. TruePPM addresses **four logical databases**, which is what decides
whether a given topology can work at all:

| Topology | Supported | Notes |
|----------|-----------|-------|
| **Replicated Valkey behind one stable endpoint** | Yes | Primary with one or more replicas, fronted by a managed service endpoint, Kubernetes Service, or VIP that always resolves to the current primary. **The simplest production path.** |
| **Managed Valkey / Redis-compatible service** | Yes | Cluster mode must be **disabled** — see below. The provider handles failover, patching, and backups. |
| **Sentinel** | **Experimental** | Ships in 0.4 as experimental. Configure it with the `TRUEPPM_VALKEY_*` settings below; all four databases are wired to follow the primary across a failover with no restart. **Not yet verified against a live Sentinel quorum** — see the caution below. |
| **Cluster mode** | **No** | Not supported, and not planned. A clustered endpoint exposes only database `0`, and TruePPM uses four. The Channels layer has no cluster support in any case. |

:::caution[Do not enable Cluster mode]
Pointing TruePPM at a cluster-mode-enabled endpoint will fail: databases `/1`,
`/2`, and `/3` are invalid against a clustered server. On a managed service
(ElastiCache, Memorystore, Azure Managed Redis) choose the
**cluster-mode-disabled** configuration.
:::

So the goal is reachable two ways: **no single Valkey process whose loss takes
down real-time, async, and caching together** — via replication behind one
endpoint that survives failover, or via Sentinel.

**For a production deployment you can only rely on today, choose a replicated
primary behind one stable endpoint.** That path is the one this project exercises;
Sentinel is new and carries the caveat below.

## Configuring Sentinel

:::caution[Sentinel support is experimental in 0.4]
The Sentinel wiring is unit-tested — the right topology, database, and credentials
reach every one of TruePPM's Valkey consumers — but it has **not been verified
against a live Sentinel quorum with a real failover**. TruePPM's bundled
development stack is a single-node Valkey, so there is no continuous end-to-end
test of promotion behavior.

Treat it as experimental: **validate a full failover in a staging environment that
mirrors your production topology before you depend on it**, and prefer a
replicated primary behind one stable endpoint if you need a path that is already
proven. Please report what you find on
[#2554](https://gitlab.com/trueppm/trueppm/-/issues/2554) — real-world results are
what will move this from experimental to supported.
:::

Sentinel monitors a primary/replica set and promotes a replica when the primary
fails. TruePPM resolves the current primary from the Sentinels **on every
connection**, so a failover is designed to need no restart and no config change.

Set these on the API and every Celery worker. A non-empty
`TRUEPPM_VALKEY_SENTINELS` is what switches Sentinel on; when it is empty (the
default), TruePPM uses `REDIS_URL` exactly as before.

| Variable | Required | Meaning |
|----------|----------|---------|
| `TRUEPPM_VALKEY_SENTINELS` | Yes | Comma-separated `host:port` list of the Sentinel nodes. Use **three or more** — Sentinel needs a quorum to authorize a promotion, so two can never fail over. |
| `TRUEPPM_VALKEY_MASTER_NAME` | Yes | The name the Sentinels monitor the primary under — the first argument of `sentinel monitor` in `sentinel.conf`, commonly `mymaster`. |
| `TRUEPPM_VALKEY_PASSWORD` | No | Password for the **data** nodes (primary and replicas). |
| `TRUEPPM_VALKEY_SENTINEL_PASSWORD` | No | Password for the **Sentinel** nodes themselves. Separate on purpose: sentinels commonly carry a different password, or none. |
| `TRUEPPM_VALKEY_USE_TLS` | No | `true` to use TLS to the data nodes. Default `false`. |

In Sentinel mode `REDIS_URL` is **ignored**. Leave it unset — TruePPM emits a
startup warning (`trueppm.valkey.W001`) if a stale value is left behind, so it is
never ambiguous which topology is in effect. A missing
`TRUEPPM_VALKEY_MASTER_NAME` or a malformed sentinel list refuses to boot
(`trueppm.valkey.E001` / `E002`) rather than silently degrading.

### With Helm

Disable the bundled pod and fill in the `valkey.sentinel` block. The chart routes
both passwords through its connection Secret, so neither is rendered into a
Deployment manifest in plaintext:

```yaml
valkey:
  enabled: false
  sentinel:
    enabled: true
    nodes: "sentinel-0.valkey:26379,sentinel-1.valkey:26379,sentinel-2.valkey:26379"
    masterName: "mymaster"
    password: "DATA_NODE_PASSWORD"
    sentinelPassword: ""   # leave empty if the sentinels are unauthenticated
    tls: false
```

With `sentinel.enabled: true` you do **not** need to supply `env.REDIS_URL` — the
chart stops requiring it, because there is no single endpoint to name.

**Verify a failover in staging before relying on it** — this is the step that
matters most while support is experimental. Stop the primary, confirm the
Sentinels promote a replica, then check that all four roles recover without a pod
restart: real-time updates resume (Channels), queued jobs drain (Celery), logins
succeed (cache-backed SSO state), and WebSocket reconnects authenticate (ticket
auth). If any of those stay broken, that is a bug worth reporting on
[#2554](https://gitlab.com/trueppm/trueppm/-/issues/2554).

## Licensing and cost — you do not need a commercial Redis

Self-hosters reasonably ask whether HA means paying for Redis. It does not.
Self-hosting is free either way; the difference is **license terms, not money**.

- **Valkey** is BSD-3-Clause under the Linux Foundation, forked from Redis 7.2.4.
  It is unambiguously open source, and it is what TruePPM ships
  (`valkey/valkey:8-alpine`). There is no license conversation to have.
- **Redis 7.4 and later** moved to RSALv2 / SSPLv1 — source-available, not
  OSI-approved open source. You may still self-host it at no cost; the restriction
  targets offering it as a managed service to third parties.
- **Redis 8.0 and later** added AGPLv3 as a third option, making it OSI-open
  again. Running it alongside TruePPM does not affect TruePPM's Apache 2.0
  licensing — it is a separate process reached over a network protocol, not linked
  code. But AGPL is blocked outright by many enterprise legal teams, which is a
  practical obstacle even though it is not a technical one.

**Where cost actually appears is managed services.** Valkey-based offerings are
generally priced below their Redis-OSS equivalents:

| Provider | Valkey option |
|----------|---------------|
| AWS | ElastiCache for Valkey, MemoryDB for Valkey — priced below the ElastiCache for Redis OSS equivalents |
| Google Cloud | Memorystore for Valkey |
| DigitalOcean | Managed Caching (Valkey) |
| Aiven | Aiven for Valkey |
| Azure | **No first-party Valkey.** Azure Managed Redis is a commercial Redis Enterprise SKU. On Azure, the license-free path is self-hosting Valkey on AKS. |

If you want HA with no vendor bill at all, run a replicated Valkey StatefulSet in
your own cluster with a Kubernetes Service fronting the primary, and give it a
PersistentVolume so the Celery broker survives a pod restart.

## Helm guidance — point TruePPM at external Valkey

The bundled Valkey subchart is **single-node**. For production, disable it and
point TruePPM at an external, highly available endpoint.

1. **Disable the bundled Valkey pod** in your values override:

   ```yaml
   valkey:
     enabled: false
   ```

2. **Set `REDIS_URL`** to your external endpoint. When the bundled Valkey is
   disabled, the chart no longer builds `REDIS_URL` for you, so you must provide
   it under `env` (or via an override):

   ```yaml
   env:
     # A managed Valkey endpoint, or your own replicated Valkey behind a Service.
     # Use rediss:// for TLS-terminated managed services.
     # Cluster mode must be DISABLED — TruePPM needs databases 0, 1, 2, and 3.
     REDIS_URL: "rediss://:PASSWORD@my-valkey.example.internal:6379"
   ```

   Do **not** append a database index yourself — TruePPM appends `/0`, `/1`,
   `/2`, and `/3` to this base URL for the four roles.

3. **Keep the password out of plaintext.** As with `DATABASE_URL`, prefer sourcing
   `REDIS_URL` (or just its password) from a Kubernetes Secret via `secretKeyRef`
   rather than committing it into a values file.

4. **Verify the endpoint survives failover.** The single most important property
   is that the hostname in `REDIS_URL` keeps resolving to a writable primary after
   a failover, without a TruePPM restart. Managed services do this for you. If you
   assemble it yourself, test it by killing the primary and confirming that
   WebSocket updates and Celery jobs resume on their own — or use
   [Sentinel](#configuring-sentinel), which removes the need for a stable
   endpoint entirely.

All four roles read `REDIS_URL`, so one correct external endpoint moves all four
onto your HA Valkey at once.

## Failure-mode matrix — what happens when Valkey is down

If Valkey becomes unavailable, the impact on a Kubernetes deployment is **total,
not partial**. The API does go dark, and the reason is worth understanding
precisely, because it is a deliberate design choice rather than an accident:

| Subsystem | Behavior when Valkey is unavailable |
|-----------|-------------------------------------|
| **API / REST reads and writes** | **Unreachable in the chart's default topology.** `/api/v1/readyz` performs a `set`-then-`get` round-trip against the cache (`_probe_cache`), and `probes.api.readinessPath` points at it, so every API pod is marked `NotReady`, the Service loses its endpoints, and the ingress returns **503**. Django itself would happily serve database-backed reads — the process stays up and `/api/v1/health/` still answers `200` — but nothing routes to it. |
| **Real-time (Channels / WebSockets)** | **Disrupted.** WebSocket clients disconnect and live updates stop. This is the reason readiness gates on the cache at all: the same Valkey carries the Channels layer, so a pod that cannot reach it cannot serve real-time collaboration and should not claim to be ready. |
| **Async (Celery broker)** | **Halted.** New tasks cannot be enqueued and queued work is not processed; drains (CPM recalculation, imports, webhooks, notification email) stall until Valkey returns. |
| **Cache** | Cold on recovery. Throttle counters reset, and in-flight SSO logins fail and must be retried — the PKCE verifier and nonce live in the cache. |

**Queued work is delayed, not lost.** The Celery queue is not the record of what
needs doing — PostgreSQL is. Fourteen outbox drains run every 30 seconds and
re-dispatch pending and orphaned rows, and every task carries `acks_late=True`
with `reject_on_worker_lost=True`. Within about 30 seconds of Valkey returning,
outbox-backed work resumes on its own. What has no outbox row behind it — a
fire-and-forget dispatch whose only record was the queue entry — is the part that
can be lost. See [Why losing the broker does not lose the
work](/administration/durability/#why-losing-the-broker-does-not-lose-the-work).

**The bundled Valkey does persist**, which is a separate question from
availability. `charts/valkey` runs `valkey-server --appendonly yes` against a 2Gi
PVC, so AOF at the default `appendfsync everysec` puts roughly **one second** of
appended commands at risk on an unclean stop. `docker-compose.prod.yml` is the
opposite: `/data` is a `tmpfs` with no AOF, so a container restart drops the queue
entirely. The [per-artifact
table](/administration/durability/#broker-persistence-per-artifact) states all
three shapes.

The takeaway: an outage does not corrupt committed data, and it does not lose
outbox-backed work — but on Kubernetes it **takes the entire application offline**,
not just its real-time and async layers. For production, that is why HA Valkey is
treated as mandatory.

## Related pages

- [Deployment Sizing](/administration/sizing/) — resource guidance for the API,
  worker, and cache tiers.
- [Durability & Redundancy](/administration/durability/) — what is authoritative,
  what is reconstructible, and the step-up ladder that ends at an HA broker.
- [Beat Liveness](/administration/beat-liveness/) — how a dead Beat process is
  detected.
- [Troubleshooting](/administration/troubleshooting/) — diagnosing a live 503 and
  telling a cache outage from a database one.
- [System Health](/administration/system-health/) — the in-app health surface for
  operators.
