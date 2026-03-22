# Role-Based Access Control

TruePPM uses a 5-role per-project permission model. Roles are stored in `ProjectMembership` and enforced on every API endpoint.

## Roles

| Role | Ordinal | Description |
|------|---------|-------------|
| Owner | 4 | Full control. Can manage members, delete the project, and assign any role below Owner. |
| Admin | 3 | Can modify project settings, tasks, dependencies, and resources. Cannot manage members. |
| Scheduler | 2 | Can create and modify tasks and dependencies. Cannot change project settings or members. |
| Member | 1 | Can view all project data and log time. Cannot modify the schedule. |
| Viewer | 0 | Read-only. Can view the schedule and sync data to a mobile device. |

## Permission matrix

| Action | Owner | Admin | Scheduler | Member | Viewer |
|--------|-------|-------|-----------|--------|--------|
| View project data | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sync (pull delta) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Connect WebSocket | ✓ | ✓ | ✓ | ✓ | — |
| Create/edit tasks | ✓ | ✓ | ✓ | — | — |
| Create/edit dependencies | ✓ | ✓ | ✓ | — | — |
| Manage resources | ✓ | ✓ | — | — | — |
| Edit project settings | ✓ | ✓ | — | — | — |
| Manage members | ✓ | — | — | — | — |
| Self-remove from project | ✓ | ✓ | ✓ | ✓ | ✓ |

## Membership API

Memberships are managed via the nested endpoint `/api/v1/projects/{project_id}/members/`.

### Add a member

```http
POST /api/v1/projects/{project_id}/members/
Authorization: Bearer <token>
Content-Type: application/json

{"user": "<user-id>", "role": 1}
```

Role escalation rule: you can only assign a role **strictly below** your own. An Owner (4) can assign up to Admin (3); an Admin cannot manage members at all.

### Change a member's role

```http
PATCH /api/v1/projects/{project_id}/members/{membership_id}/
Authorization: Bearer <token>
Content-Type: application/json

{"role": 2}
```

### Remove a member

```http
DELETE /api/v1/projects/{project_id}/members/{membership_id}/
Authorization: Bearer <token>
```

Any member may remove themselves (self-removal). An Owner may remove members with a role below their own. Removing a lower-role member requires Owner.

### Last-Owner guard

A project must always have at least one Owner. If you attempt to remove or demote the last Owner, the API returns `HTTP 400`:

```json
{"detail": "Cannot remove or demote the last Owner of a project."}
```

This check uses `SELECT FOR UPDATE` to prevent a race condition where two concurrent requests each see the other as "the other Owner" and both succeed.

## Project creation

When a user creates a project, they are automatically assigned the Owner role. This is handled by the `ProjectViewSet.perform_create()` hook — no separate membership creation is required.

## IDOR prevention

All querysets in the API are scoped to projects the requesting user is a member of via `ProjectScopedViewSet`. An unauthenticated request or a request from a non-member receives an empty queryset, not a 403, preventing information leakage about the existence of objects.

Object-level permission checks use `has_object_permission()` to enforce membership before any data is returned.

## WebSocket auth

WebSocket connections authenticate via a `?token=<jwt>` query parameter on the connection URL. Viewer (role=0) connections are rejected with close code 4003 — real-time push is available to Member and above only.
