---
name: perf-check
model: sonnet
description: >
  Performance audit for TruePPM API endpoints and serializers. Use when adding or
  modifying a viewset, serializer, or any code that queries the database to catch
  N+1 queries, missing prefetches, unindexed filters, and unbounded result sets
  before merge.
---

# Perf Check Skill

You are auditing TruePPM API code for performance regressions before merge.

## Performance Targets

| Endpoint type | p95 target |
|---------------|-----------|
| Simple CRUD (single object) | <50ms |
| List (paginated, 50 rows) | <100ms |
| Schedule trigger (5K tasks) | <500ms |
| Gantt data fetch (1K tasks) | <200ms |
| WebSocket fan-out (500 members) | <50ms per member |

## Checklist

### N+1 Queries
- [ ] Every `ModelViewSet` that returns related objects uses `select_related()` or
  `prefetch_related()` on the base queryset — not inside the serializer
- [ ] Serializers with nested serializers (`TaskSerializer(many=True)`) are served from
  a prefetched queryset, not lazy-loaded per row
- [ ] `get_queryset()` overrides preserve the base `select_related` chain
- [ ] Counted fields (e.g., `task_count`) use `annotate(Count(...))`, not Python len()

### Pagination
- [ ] Every list endpoint paginates — no endpoint returns an unbounded queryset
- [ ] Default page size is 50 or fewer; maximum is 200 or fewer
- [ ] Cursor pagination is used for real-time feeds (avoid offset pagination on large tables)

### Indexing
- [ ] Every field used in `filter_backends` has a corresponding DB index
- [ ] Foreign keys used in `select_related()` paths have indexes (Django adds these by default)
- [ ] `wbs_path` (ltree) uses GiST index — already in migration; do not remove
- [ ] Composite indexes exist where multiple fields are filtered together (e.g., project + is_critical)
- [ ] Ordering fields (`ordering_fields`) are indexed

### Serializer Efficiency
- [ ] Serializers use explicit `fields` lists — no `__all__`
- [ ] Separate lean list serializers vs. full detail serializers for heavy endpoints
- [ ] `SerializerMethodField` that runs queries is flagged — move to `annotate()` instead
- [ ] Write serializers do not trigger validation queries that re-read what was just written

### Scheduling Engine
- [ ] `schedule()` is never called synchronously in a request handler
- [ ] CPM recalculation is always dispatched via Celery (`recalculate_schedule.delay()`)
- [ ] Monte Carlo simulation is Celery-only — never in a view or serializer

### Caching
- [ ] Calendar and holiday lookups are cached (Redis, 1-hour TTL) — not re-queried per task
- [ ] Project-level CPM results are invalidated on any Task or Dependency write

## How to Audit

1. Read the viewset's `get_queryset()` — list every related model accessed by the serializer
2. For each related model, verify a `select_related` or `prefetch_related` exists
3. Check `filter_backends` and `filterset_fields` — verify DB indexes for each
4. Count any `SerializerMethodField` definitions that touch the ORM

## Output Format

State the verdict: **PASS**, **FAIL**, or **NEEDS REVIEW**.

For each issue:
```
### [HIGH|MEDIUM|LOW] Issue Title
**File**: path:line
**Problem**: e.g., "N+1: Task.project is lazy-loaded in serializer loop"
**Fix**: Exact queryset change needed
**Est. impact**: e.g., "50 extra queries per 50-row page"
```
