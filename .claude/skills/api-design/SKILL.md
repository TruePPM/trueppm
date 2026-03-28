---
name: api-design
model: opus
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

## Sync Endpoints (Mobile)
- `GET /api/v1/sync/pull?last_version={n}&scope={my_tasks|my_projects|full}`
  Returns all records with server_version > n, scoped to user's access.
- `POST /api/v1/sync/push` accepts batch mutations with conflict resolution.
  Response includes: accepted changes, conflicts, new server_version.

## WebSocket Channels
- `ws://host/ws/project/{id}/` — project-scoped events
- `ws://host/ws/portfolio/{id}/` — portfolio-scoped events (Enterprise)
- `ws://host/ws/user/notifications/` — per-user notifications
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
