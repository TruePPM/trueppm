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
- **Every new `@action` needs `@extend_schema`** — a bare `@action` (no `@extend_schema`) produces a null-summary, untyped stub in generated clients and the MCP tool catalog. Each new action must declare its operation id, request body type, and response type so it surfaces as a usable, named operation downstream.

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
