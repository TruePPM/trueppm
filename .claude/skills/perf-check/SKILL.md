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
- [ ] Counted fields (e.g., `task_count`) use `annotate(Count(...))`, not Python `len()`
- [ ] **`.count()` and `.exists()` on prefetched relations** — both always issue a fresh `COUNT(*)` query and ignore the prefetch cache. The right pattern when the relation is already prefetched is `len(obj.relation.all())`. Grep: `grep -rnE '\.(count|exists)\(\)' packages/api/` and verify each call site is acting on a non-prefetched relation, or refactor to use `len(...)` against the prefetched cache.
- [ ] **`.order_by()` on prefetched relations** — calling `.order_by()` on a prefetched reverse relation **always** issues a fresh `ORDER BY` query because the prefetch's order may differ from the requested order. The fix is to either (a) declare `Meta.ordering` on the related model and call `.all()`, or (b) prefetch with `Prefetch(... queryset=Model.objects.order_by(...))` so the cached rows arrive pre-ordered.
- [ ] **Annotation-fallback `SerializerMethodField` from bare instances** — if a method field uses `getattr(obj, '_count', None)` with a live `.count()` fallback, every code path that constructs the serializer must thread the annotation through `get_queryset()`. The bare-instance call site (e.g. after `Model.objects.create()` returning the freshly-saved row, or an `@action` that re-fetches by PK) silently triggers the live fallback — one extra query per render. Flag any new call site that builds the serializer from a non-annotated bare instance.
- [ ] **`SerializerMethodField` that calls a service function** — a method field whose body looks query-free because it delegates to a service/helper (`compute_x(obj)`, `service.get_y(obj)`) still N+1s if that service queries per call. Trace *into* the service: any ORM access (`.filter()`, `.get()`, `.aggregate()`, a related lookup) reached from a per-row method field is one query per serialized row on a list path. Flag the field even when the serializer body itself touches no ORM.
- [ ] **Bulk endpoints re-fetch through the prefetched queryset before serializing** — a bulk create/update/reorder must not serialize its results with a bare per-instance serializer (`Serializer(obj).data` in a loop, or `Serializer(bulk_result, many=True)` over the raw `bulk_create`/`bulk_update` return). Those instances carry no `select_related`/`prefetch_related` and re-query per row. Re-fetch the affected PKs through the viewset's prefetched `get_queryset()`, then serialize that queryset once.

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
