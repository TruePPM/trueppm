---
title: Redis (Valkey) High Availability
description: Why Redis (Valkey) is load-bearing for real-time, async, and caching at once, and how to run it highly available for production on-prem deployments.
---

TruePPM uses **Redis (Valkey)** — Valkey is the Redis-compatible cache that ships
with the chart — for three distinct roles **at the same time**. A single Redis
outage therefore degrades or disables three subsystems simultaneously. For a
production on-prem deployment, running Redis (Valkey) highly available is
**effectively mandatory**, not optional.

:::caution[Redis is a single point of failure by default]
The bundled Valkey pod in the Helm chart is a **single node with no replication or
failover**. It is fine for evaluation and small single-team installs, but it is
**not** a production-HA configuration. If that one pod is lost, real-time
collaboration, background jobs, and caching are all affected at once.
:::

## The dependency surface — one Redis, three load-bearing roles

Redis (Valkey) is not a "nice to have" cache you can shed. It is wired into three
independent subsystems:

| Role | What uses it | What it does |
|------|--------------|--------------|
| **Django Channels layer** | Real-time collaboration, WebSocket fan-out | Carries live board/schedule updates and presence between API pods. Every connected client depends on it. |
| **Celery broker** | Async / background work | Queues every asynchronous job — CPM recalculation drains, MS Project imports, webhook delivery, retention purges, notification email. |
| **Django cache backend** | Read-path caching, rate limiting, transient state | Backs cached reads, throttle counters, and other short-lived server state. |

Because all three point at the same Redis (Valkey) instance, its availability is a
**shared fate**: a broker outage is also a Channels outage is also a cache outage.
Sizing and hardening Redis is therefore a production concern on par with the
database, not an afterthought.

## HA recommendation

For any production on-prem deployment, treat highly available Redis as a
**requirement**:

- **Redis Sentinel** — a primary/replica topology with automatic failover.
  Sentinel promotes a replica when the primary fails and updates clients to the new
  primary. This is the lightest-weight path to remove the single point of failure.
- **Redis Cluster** — sharded, multi-primary, with replicas per shard. Choose this
  when you also need to scale throughput or memory beyond one node, not only for
  availability.
- **A managed Redis-compatible service** — AWS ElastiCache (Redis/Valkey), Azure
  Cache for Redis, or an equivalent — where failover, patching, and backups are the
  provider's responsibility.

Whichever you choose, the goal is the same: **no single Redis process whose loss
takes down real-time, async, and caching together.**

## Helm guidance — point TruePPM at external Redis

The bundled Valkey subchart is **single-node**. For production, disable it and
point TruePPM at an external, highly available Redis (Valkey) endpoint.

1. **Disable the bundled Valkey pod** in your values override:

   ```yaml
   valkey:
     enabled: false
   ```

2. **Set `REDIS_URL`** to your external endpoint. When the bundled Valkey is
   disabled, the chart no longer builds `REDIS_URL` for you, so you must provide it
   under `env` (or via an override). Point it at your managed or self-managed
   Redis (Valkey):

   ```yaml
   env:
     # AWS ElastiCache, Azure Cache for Redis, or a self-managed Sentinel/Cluster
     # endpoint. Use rediss:// for TLS-terminated managed services.
     REDIS_URL: "rediss://:PASSWORD@my-redis.example.internal:6379/0"
   ```

   For **Redis Sentinel**, point clients at the Sentinel endpoints rather than a
   fixed primary, so failover is transparent. For a **managed service**, use the
   provider's primary/configuration endpoint, which already abstracts failover.

3. **Keep the password out of plaintext.** As with `DATABASE_URL`, prefer sourcing
   `REDIS_URL` (or just its password) from a Kubernetes Secret via `secretKeyRef`
   rather than committing it into a values file.

The same three roles (Channels, Celery broker, cache) all read `REDIS_URL`, so a
single correct external endpoint moves all three onto your HA Redis at once.

## Failure-mode matrix — what happens when Redis is down

If Redis (Valkey) becomes unavailable, the impact is **partial, not total** — the
API does not simply go dark — but it is broad:

| Subsystem | Behavior when Redis is unavailable |
|-----------|------------------------------------|
| **API / REST reads** | Still serves database-backed reads and writes. Requests that hit the cache fall through to the database (slower, higher DB load) rather than failing. The core app stays reachable. |
| **Real-time (Channels / WebSockets)** | **Disrupted.** WebSocket clients disconnect and live updates stop. Collaborators fall back to manual refresh; changes are not lost (they persist to the database) but are no longer pushed live. |
| **Async (Celery broker)** | **Halted.** New tasks cannot be enqueued and queued work is not processed. Depending on broker persistence, in-flight or unacknowledged tasks may be **lost**; drains (CPM recalculation, imports, webhooks, notification email) stall until Redis returns. |
| **Cache** | **Cache misses fall through** to the source of truth. Read latency and database load rise, but responses remain correct. Throttle/rate-limit counters backed by the cache may reset. |

The takeaway: an outage does not corrupt committed data, but it **stops real-time
collaboration and background processing**, and can **drop in-flight async work**.
For production, that is why HA Redis is treated as mandatory.

## Related pages

- [Deployment Sizing](/administration/sizing/) — resource guidance for the API,
  worker, and cache tiers.
- [Beat Liveness & Durability](/administration/durability/) — how async work is
  kept durable and how a dead Beat process is detected.
- [System Health](/administration/system-health/) — the in-app health surface for
  operators.
