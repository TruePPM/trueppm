# API Reference

The TruePPM REST API is documented via OpenAPI 3.1, generated automatically from the source using [drf-spectacular](https://drf-spectacular.readthedocs.io/).

## Interactive schema

With the development stack running:

| Format | URL |
|--------|-----|
| Swagger UI | http://localhost:8000/api/schema/swagger-ui/ |
| ReDoc | http://localhost:8000/api/schema/redoc/ |
| Raw YAML | http://localhost:8000/api/schema/ |

## Base URL

```
http://localhost:8000/api/v1/
```

## Authentication

All endpoints require a JWT Bearer token:

```http
Authorization: Bearer <access_token>
```

Obtain tokens via:

```http
POST /api/token/
Content-Type: application/json

{"username": "...", "password": "..."}
```

Response:
```json
{"access": "<jwt>", "refresh": "<jwt>"}
```

Refresh an expired access token:

```http
POST /api/token/refresh/
Content-Type: application/json

{"refresh": "<refresh_token>"}
```

## Endpoints

### Calendars

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/calendars/` | List calendars |
| POST | `/api/v1/calendars/` | Create a calendar |
| GET | `/api/v1/calendars/{id}/` | Retrieve a calendar |
| PUT / PATCH | `/api/v1/calendars/{id}/` | Update a calendar |
| DELETE | `/api/v1/calendars/{id}/` | Soft-delete a calendar |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/` | List projects you are a member of |
| POST | `/api/v1/projects/` | Create a project (caller becomes Owner) |
| GET | `/api/v1/projects/{id}/` | Retrieve a project |
| PUT / PATCH | `/api/v1/projects/{id}/` | Update a project |
| DELETE | `/api/v1/projects/{id}/` | Soft-delete a project |

### Project members

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/{id}/members/` | List members (Viewer+) |
| POST | `/api/v1/projects/{id}/members/` | Add a member (Owner only) |
| GET | `/api/v1/projects/{id}/members/{mid}/` | Retrieve a membership |
| PATCH | `/api/v1/projects/{id}/members/{mid}/` | Change role (Owner only) |
| DELETE | `/api/v1/projects/{id}/members/{mid}/` | Remove member (Owner, or self) |

See [RBAC](../features/rbac.md) for the full permission matrix and role escalation rules.

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/tasks/` | List tasks (filter: `?project=<id>`, `?is_critical=true`) |
| POST | `/api/v1/tasks/` | Create a task |
| GET | `/api/v1/tasks/{id}/` | Retrieve a task |
| PUT / PATCH | `/api/v1/tasks/{id}/` | Update a task |
| DELETE | `/api/v1/tasks/{id}/` | Soft-delete a task (cascades to edges) |

CPM output fields (`early_start`, `early_finish`, `late_start`, `late_finish`, `total_float`, `is_critical`) are read-only — set by the auto-scheduler.

### Dependencies

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/dependencies/` | List dependencies (filter: `?project=<id>`, `?dep_type=FS`) |
| POST | `/api/v1/dependencies/` | Create a dependency |
| GET | `/api/v1/dependencies/{id}/` | Retrieve a dependency |
| PUT / PATCH | `/api/v1/dependencies/{id}/` | Update a dependency |
| DELETE | `/api/v1/dependencies/{id}/` | Soft-delete a dependency |

Predecessor and successor must belong to the same project; cross-project edges return `HTTP 400`.

### Resources

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/resources/` | List resources |
| POST | `/api/v1/resources/` | Create a resource |
| GET | `/api/v1/resources/{id}/` | Retrieve a resource |
| PUT / PATCH | `/api/v1/resources/{id}/` | Update a resource |
| DELETE | `/api/v1/resources/{id}/` | Soft-delete a resource |

### Task-resource assignments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/task-resources/` | List assignments |
| POST | `/api/v1/task-resources/` | Assign a resource to a task |
| GET | `/api/v1/task-resources/{id}/` | Retrieve an assignment |
| PUT / PATCH | `/api/v1/task-resources/{id}/` | Update an assignment |
| DELETE | `/api/v1/task-resources/{id}/` | Remove an assignment |

### Sync

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/projects/{id}/sync/` | Pull delta changes for mobile sync |

See [Offline Sync](../features/offline-sync.md) for the full protocol.

## Pagination

List endpoints use cursor pagination with a default page size of 50. Response envelope:

```json
{
  "count": 123,
  "next": "http://localhost:8000/api/v1/tasks/?cursor=...",
  "previous": null,
  "results": [...]
}
```

## Common response codes

| Code | Meaning |
|------|---------|
| 200 | OK |
| 201 | Created |
| 204 | No content (delete) |
| 400 | Validation error |
| 401 | Missing or invalid token |
| 403 | Authenticated but insufficient role |
| 404 | Object not found (or soft-deleted) |
| 409 | Conflict (e.g. duplicate membership) |
