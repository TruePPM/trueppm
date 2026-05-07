---
name: performance
model: sonnet
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

## Profiling Tools
- Python: cProfile + snakeviz, py-spy for production
- Django: django-debug-toolbar, django-silk for query analysis
- React: React DevTools Profiler, Chrome Performance tab
- PostgreSQL: EXPLAIN ANALYZE on slow queries, pg_stat_statements
- Scheduler: timeit / benchmarks in pytest (tracked across commits)
