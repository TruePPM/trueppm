---
title: Valkey High Availability
description: Why Valkey is load-bearing for real-time, async, and caching at once, which HA topologies TruePPM actually supports, and how to run it highly available without a commercial Redis license.
---

TruePPM uses **Valkey** — the BSD-3-Clause, Linux Foundation fork of Redis — for
three distinct roles **at the same time**. A single Valkey outage therefore
degrades or disables three subsystems simultaneously. For a production on-prem
deployment, running Valkey highly available is **effectively mandatory**, not
optional.

Valkey speaks the Redis wire protocol, so TruePPM's configuration surface keeps
the Redis names: the connection string is `REDIS_URL`, the scheme is `redis://`
(or `rediss://` for TLS), and the client libraries are `redis-py` and
`channels-redis`. Any Redis-compatible server works. Valkey is what the chart and
Compose files ship.

:::caution[The bundled Valkey pod is a single point of failure]
The Valkey pod in the Helm chart is a **single node with no replication or
failover**. It is fine for evaluation and small single-team installs, but it is
**not** a production-HA configuration. If that one pod is lost, real-time
collaboration, background jobs, and caching are all affected at once.
:::

## The dependency surface — one Valkey, three load-bearing roles

Valkey is not a "nice to have" cache you can shed. It is wired into three
independent subsystems, each on its own logical database index off the same
`REDIS_URL`:

| Role | Database | What uses it | What it does |
|------|----------|--------------|--------------|
| **Celery broker** | `/0` | Async / background work | Queues every asynchronous job — CPM recalculation drains, MS Project imports, webhook delivery, retention purges, notification email. |
| **Django Channels layer** | `/1` | Real-time collaboration, WebSocket fan-out | Carries live board/schedule updates and presence between API pods. Every connected client depends on it. |
| **Django cache backend** | `/2` | Read-path caching, rate limiting, transient state | Backs cached reads, DRF throttle counters, and short-lived OIDC/OAuth login state (the PKCE verifier and nonce for an in-flight SSO login). |

Because all three point at the same Valkey instance, its availability is a
**shared fate**: a broker outage is also a Channels outage is also a cache outage.
Sizing and hardening Valkey is therefore a production concern on par with the
database, not an afterthought.

## Which HA topologies TruePPM supports today

This is the part that determines your deployment, so read it before choosing a
topology.

TruePPM derives all three roles from a single `REDIS_URL` by appending the
database index. That shape constrains which HA topologies you can actually
configure:

| Topology | Supported | Notes |
|----------|-----------|-------|
| **Replicated Valkey behind one stable endpoint** | Yes | Primary with one or more replicas, fronted by a managed service endpoint, Kubernetes Service, or VIP that always resolves to the current primary. **This is the recommended production path.** |
| **Managed Valkey / Redis-compatible service** | Yes | Cluster mode must be **disabled** — see below. The provider handles failover, patching, and backups. |
| **Sentinel** | Not yet | Requires per-role configuration TruePPM does not expose. Tracked in [#2554](https://gitlab.com/trueppm/trueppm/-/issues/2554). |
| **Cluster mode** | Not yet | Cluster exposes only database `0`, so the `/1` and `/2` indexes are invalid against a clustered endpoint. Tracked in [#2554](https://gitlab.com/trueppm/trueppm/-/issues/2554). |

:::caution[Do not configure Sentinel or Cluster yet]
Pointing `REDIS_URL` at Sentinel endpoints or a cluster-mode-enabled service will
**not** work. None of the three consumers can resolve a Sentinel primary from a
URL alone, and two of the three cannot address a non-zero database on a clustered
endpoint. Follow [#2554](https://gitlab.com/trueppm/trueppm/-/issues/2554) for
support.
:::

So the goal is achievable, just narrower than it looks: **no single Valkey process
whose loss takes down real-time, async, and caching together** — reached with
replication behind one endpoint that survives failover, not with Sentinel or
Cluster.

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
     # Cluster mode must be DISABLED — TruePPM needs databases 0, 1, and 2.
     REDIS_URL: "rediss://:PASSWORD@my-valkey.example.internal:6379"
   ```

   Do **not** append a database index yourself — TruePPM appends `/0`, `/1`, and
   `/2` to this base URL for the three roles.

3. **Keep the password out of plaintext.** As with `DATABASE_URL`, prefer sourcing
   `REDIS_URL` (or just its password) from a Kubernetes Secret via `secretKeyRef`
   rather than committing it into a values file.

4. **Verify the endpoint survives failover.** The single most important property
   is that the hostname in `REDIS_URL` keeps resolving to a writable primary after
   a failover, without a TruePPM restart. Managed services do this for you. If you
   assemble it yourself, test it by killing the primary and confirming that
   WebSocket updates and Celery jobs resume on their own.

The same three roles all read `REDIS_URL`, so one correct external endpoint moves
all three onto your HA Valkey at once.

## Failure-mode matrix — what happens when Valkey is down

If Valkey becomes unavailable, the impact is **partial, not total** — the API does
not simply go dark — but it is broad:

| Subsystem | Behavior when Valkey is unavailable |
|-----------|-------------------------------------|
| **API / REST reads** | Still serves database-backed reads and writes. Requests that hit the cache fall through to the database (slower, higher DB load) rather than failing. The core app stays reachable. |
| **Real-time (Channels / WebSockets)** | **Disrupted.** WebSocket clients disconnect and live updates stop. Collaborators fall back to manual refresh; changes are not lost (they persist to the database) but are no longer pushed live. |
| **Async (Celery broker)** | **Halted.** New tasks cannot be enqueued and queued work is not processed. Depending on broker persistence, in-flight or unacknowledged tasks may be **lost**; drains (CPM recalculation, imports, webhooks, notification email) stall until Valkey returns. |
| **Cache** | **Cache misses fall through** to the source of truth. Read latency and database load rise, but responses remain correct. Throttle counters may reset, and in-flight SSO logins fail and must be retried. |

The takeaway: an outage does not corrupt committed data, but it **stops real-time
collaboration and background processing**, and can **drop in-flight async work**.
For production, that is why HA Valkey is treated as mandatory.

## Related pages

- [Deployment Sizing](/administration/sizing/) — resource guidance for the API,
  worker, and cache tiers.
- [Beat Liveness & Durability](/administration/durability/) — how async work is
  kept durable and how a dead Beat process is detected.
- [System Health](/administration/system-health/) — the in-app health surface for
  operators.
