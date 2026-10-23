---
name: performance
model: sonnet  # /pre-release full deliberately escalates this agent to Opus for the full-codebase audit (see pre-release/SKILL.md Step 0.6) — sonnet here is the day-to-day default, not a drifted mismatch
description: >
  Performance auditing and optimization for TruePPM. Use when investigating slow
  endpoints, optimizing database queries, improving Gantt rendering performance,
  or profiling the scheduling engine. Covers Django ORM optimization, React rendering,
  WebSocket throughput, and mobile sync efficiency.
---

# Performance Skill

## Performance Targets
| Component | Metric | Target |
|-----------|--------|--------|
| API (simple CRUD) | p95 latency | <100ms |
| API (schedule trigger) | completion time | <500ms for 5K tasks |
| Gantt render | initial paint | <1s for 1K tasks |
| Gantt drag | frame rate | 60fps during drag |
| CPM incremental | recalc time | <10ms for 5K tasks |
| Monte Carlo | simulation time | <500ms for 1K tasks × 10K runs |
| Mobile sync pull | transfer + apply | <3s for 500 task delta |
| Mobile time entry | interaction to confirmation | <300ms |

## Common Issues and Fixes
- **N+1 queries**: Use `select_related()` / `prefetch_related()`. Check with django-debug-toolbar.
- **Missing pagination**: Every list endpoint MUST paginate. Default 50, max 200.
- **Serializer bloat**: Use `fields` on serializers, never `__all__`. Separate list vs. detail serializers.
- **Unindexed filters**: Every filterable field needs a DB index.
- **React re-renders**: Use React DevTools profiler. Memoize expensive computations, not everything.
- **Gantt virtualization**: Only render visible task bars. Off-screen rows are virtual.
- **WebSocket fan-out**: Redis pub/sub, not per-connection database queries.
- **Mobile sync overload**: Delta sync with server_version, not full refresh.
- **Engine work in the request path**: for every synchronous call into the scheduling engine (CPM, Monte Carlo, what-if, derivation) inside a view, find the process it runs in and that process's memory limit and worker count. A per-user throttle does not bound *concurrent* calls across users. If the ASGI process also serves WebSockets, one OOM drops every live socket on the pod. Measure the per-call peak at the documented caps, then check that a per-process concurrency bound (semaphore or cell cap) or an off-request path (Celery) keeps N concurrent calls under the limit.
- **Buffers bounded by count, not bytes**: a replay, outbox, or fan-out buffer capped at N rows is unbounded in memory if one row can be large (a CPM delta can be ~130 KB). For each cap, multiply it by the worst-case payload size and compare the result to the process limit.
- **Settings checked against the real process model**: a setting whose effect depends on how the server runs requests must be checked against how it actually runs. `CONN_MAX_AGE` keeps a connection per *thread*; under uvicorn/ASGI, Django runs each sync request on its own thread, so a persistent connection is never reused and every request opens a new one. Check thread-locals, connection pools and worker counts the same way, and check that sizing docs and Helm comments describe the model that exists.
- **TanStack Query refetch storms**: `invalidateQueries` defaults to `cancelRefetch: true`, so each invalidation cancels the in-flight fetch and starts another. On a query whose fetch takes longer than the interval between invalidations (multi-page loads of a large project, under WebSocket-driven invalidation) the data never arrives. If the `queryFn` also ignores the `signal` it is given, the cancelled requests keep running, so the load piles up per viewer. Flag both: pass `signal` through to every fetch, and coalesce or set `cancelRefetch: false` where events can arrive faster than a fetch completes.
- **"Off" switches that fall back to a default**: a hook called with `undefined` to mean "do not fetch" is still enabled if it resolves `undefined` to the route's id. Check that disabling goes through `enabled`, and that a closed panel or palette does not load the whole project on every page.
- **Shared datastore pressure**: if one Valkey/Redis instance is the Celery broker, the cache, and the channel layer, check its `maxmemory` policy. Under `noeviction`, a real-time fan-out spike fails broker enqueues too, so a broadcast burst becomes a background-job outage.

## Profiling Tools
- Python: cProfile + snakeviz, py-spy for production
- Django: django-debug-toolbar, django-silk for query analysis
- React: React DevTools Profiler, Chrome Performance tab
- PostgreSQL: EXPLAIN ANALYZE on slow queries, pg_stat_statements
- Scheduler: timeit / benchmarks in pytest (tracked across commits)
