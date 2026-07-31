---
name: api-design
model: sonnet
description: >
  Design REST and WebSocket API endpoints for TruePPM. Use when adding new endpoints,
  modifying existing ones, or designing the sync protocol. Follows API-first principles:
  every feature must be an API endpoint before it becomes a UI element. Produces OpenAPI
  schema fragments, DRF serializer/viewset specifications, and WebSocket channel definitions.
---

# API Design Skill

You design APIs for TruePPM following these rules:

## Conventions
- Base URL: `/api/v1/`
- Enterprise endpoints: `/api/v1/enterprise/` (these go in trueppm-enterprise repo)
- Auth: JWT Bearer token (access + refresh). API keys for service accounts.
- Pagination: cursor-based (keyset) using `server_version` for sync-friendly ordering
- Filtering: django-filter query params (e.g., `?status=active&is_critical=true`)
- Bulk operations: POST to `/batch` sub-endpoint with array body
- Response format: JSON with consistent envelope: `{ "data": ..., "meta": { "page": ... } }`
- Errors: RFC 7807 Problem Details (`{ "type": "...", "title": "...", "status": 400, "detail": "..." }`)
- Versioning: URL path (`/v1/`). Breaking changes = new version.

## For Each New Endpoint, Specify:
1. HTTP method + URL pattern
2. Request body schema (if applicable)
3. Response schema with example
4. Permission class (which RBAC roles can access)
5. Query parameters (filters, pagination)
6. Side effects (Celery tasks triggered, WebSocket events emitted)
7. Rate limit tier (standard: 100/min, bulk: 10/min, heavy: 5/min)
8. OSS or Enterprise? (check CLAUDE.md boundary rules)

## Schema Fidelity (verify before finalizing any endpoint)
- **Response-transforming views need a matching `@extend_schema` override** — if a view returns a body that diverges from its declared serializer (popping a field, renaming it, relocating it — e.g. moving a value into a cookie or a `meta` envelope), the generated schema still advertises the declared shape. That divergence breaks every schema-driven client (the TypeScript types, the MCP tool catalog). Any view whose actual response differs from its serializer must carry an `@extend_schema(responses=...)` that describes the *real* body.
- **Every new `@action` needs `@extend_schema`** — a bare `@action` (no `@extend_schema`) produces a null-summary, untyped stub in generated clients and the MCP tool catalog. Each new action must declare its operation id, request body type, and response type so it surfaces as a usable, named operation downstream. Worse than a stub: on a **ViewSet**, an unannotated `@action` does not merely go untyped — drf-spectacular falls back to the *viewset's* default serializer, so the schema confidently advertises a completely unrelated model. A silent wrong answer beats a visible missing one every time.
- **CI CANNOT CATCH THIS CLASS — you must verify it by reading.** `api:schema-drift` only checks *self-consistency*: that the committed `openapi.json` matches what spectacular generates from current code. When an annotation is missing or a pagination heuristic misfires, spectacular faithfully generates the **wrong** schema and the committed file matches it perfectly. The gate is green and the contract is a lie. Never treat a passing schema-drift job as evidence that a response shape is correctly declared.
- **Check the declared shape against the actual `return` statement, per endpoint.** For every list endpoint and every `@action`, read the view's return and compare it to the schema entry. Two recurring failure shapes: (a) a plain `APIView` that paginates in the method body but has no class-level `pagination_class`, so the auto-wrap heuristic never fires and the schema declares a bare array while the body is `{next, previous, results}`; (b) an unannotated ViewSet `@action` inheriting the viewset's serializer. Both break a generated SDK on first call.
- **Diff an endpoint's annotation against its siblings.** When the same feature exposes per-object and per-collection variants (`/tasks/{id}/x/` and `/sprints/{id}/x/`), confirm both carry equivalent `@extend_schema`. A fix applied to one variant and not the other is this codebase's most repeated defect shape — the annotated sibling is proof of the intended contract, so its absence next door is a regression, not a choice.
- **Confirm the decorator landed on the method you think it did.** A stray or mis-indented `@extend_schema` can bind to the `@action` *below* it, leaving the intended one bare while appearing annotated on a quick read (this has bitten before — see #2455). After adding one, verify the generated `openapi.json` entry for that exact path changed.

## Sync Endpoints (Mobile)
- `GET /api/v1/sync/pull?last_version={n}&scope={my_tasks|my_projects|full}`
  Returns all records with server_version > n, scoped to user's access.
- `POST /api/v1/sync/push` accepts batch mutations with conflict resolution.
  Response includes: accepted changes, conflicts, new server_version.

## WebSocket Channels (canonical: `packages/api/src/trueppm_api/routing.py`)
- `ws/v1/projects/{project_id}/` — `ProjectConsumer`: board/schedule events + presence
- `ws/v1/projects/{project_id}/workshop/` — `WorkshopConsumer`: live workshop session (requires an active `WorkshopSession`)
- Auth: JWT in first message or query param
- Events: JSON with `{ "type": "task.updated", "data": { ... }, "event_id": "uuid" }`

## Output Format
Produce a DRF-style specification:
```python
# URL: POST /api/v1/projects/{id}/schedule/
# Permission: PM, Admin
# Rate Limit: heavy (5/min)
# Side Effects: Celery task compute_schedule, WS event schedule.recalculated
# OSS: Yes (community edition)

class ScheduleSerializer(serializers.Serializer):
    # Request: empty (trigger only)
    pass

class ScheduleResultSerializer(serializers.Serializer):
    # Response
    critical_path = serializers.ListField(child=serializers.UUIDField())
    recomputed_tasks = serializers.IntegerField()
    duration_ms = serializers.IntegerField()
```
