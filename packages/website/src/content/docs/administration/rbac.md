---
title: Roles and Permissions
description: TruePPM's 5-role RBAC model — setup, enforcement, and permission matrix.
---

TruePPM uses a 5-role per-project permission model stored in `ProjectMembership` and enforced on every API endpoint and WebSocket connection.

## Roles

| Role | Ordinal | Description |
|------|---------|-------------|
| **Owner** | 4 | Full control. Manages members, can assign any role below Owner. |
| **Admin** | 3 | Modifies project settings, tasks, dependencies, resources. |
| **Scheduler** | 2 | Creates and modifies tasks and dependencies. |
| **Member** | 1 | Views all project data. Logs time. |
| **Viewer** | 0 | Read-only. Can sync to mobile. |

## Permission matrix

| Action | Owner | Admin | Scheduler | Member | Viewer |
|--------|:-----:|:-----:|:---------:|:------:|:------:|
| View project data | Yes | Yes | Yes | Yes | Yes |
| Pull delta sync | Yes | Yes | Yes | Yes | Yes |
| Connect WebSocket | Yes | Yes | Yes | Yes | — |
| Create/edit tasks | Yes | Yes | Yes | — | — |
| Create/edit dependencies | Yes | Yes | Yes | — | — |
| Manage resources | Yes | Yes | — | — | — |
| Edit project settings | Yes | Yes | — | — | — |
| Manage members | Yes | — | — | — | — |
| Self-remove | Yes | Yes | Yes | Yes | Yes |

## Managing members

Members are managed at `/api/v1/projects/{project_id}/members/`.

### Add a member

```http
POST /api/v1/projects/{project_id}/members/
Authorization: Bearer <token>

{"user": "<user-id>", "role": 1}
```

**Role escalation rule:** you can only assign a role strictly below your own. An Owner (4) can assign up to Admin (3).

### Change a member's role

```http
PATCH /api/v1/projects/{project_id}/members/{membership_id}/

{"role": 2}
```

### Remove a member

```http
DELETE /api/v1/projects/{project_id}/members/{membership_id}/
```

Any member may remove themselves. An Owner may remove members with a role below their own.

### Last-Owner guard

A project must always have at least one Owner. Removing or demoting the last Owner returns `HTTP 400`. The check uses `SELECT FOR UPDATE` to prevent a concurrent-removal race condition.

## Project creation

When a user creates a project, they are automatically assigned the Owner role via `ProjectViewSet.perform_create()`.

## IDOR prevention

All querysets are scoped to projects the requesting user is a member of via `ProjectScopedViewSet`. Non-members receive an empty queryset rather than a 403, preventing information leakage about object existence.

## WebSocket auth

WebSocket connections authenticate via `?token=<jwt>` on the connection URL. Viewer (role=0) connections are rejected with close code 4003 — real-time push requires Member or above.
