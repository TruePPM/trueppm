---
title: Roles and Permissions
description: TruePPM's 5-role RBAC model — setup, enforcement, and permission matrix.
---

TruePPM uses a 5-role per-project permission model stored in `ProjectMembership` and enforced on every API endpoint and WebSocket connection.

## Roles

| Role | Ordinal | Label | Description |
|------|---------|-------|-------------|
| **Owner** | 400 | Project Admin | Full control. Manages members, can assign any role below Owner, deletes project. |
| **Admin** | 300 | Project Manager | Full task and dependency edit, project settings, baseline creation. |
| **Scheduler** | 200 | Resource Manager | Assigns resources and edits dependencies. Cannot edit task content. |
| **Member** | 100 | Team Member | Edits own assigned tasks. Logs time. |
| **Viewer** | 0 | Viewer | Read-only. Can pull delta sync to mobile. |

## Permission matrix

| Action | Owner | Admin | Scheduler | Member | Viewer |
|--------|:-----:|:-----:|:---------:|:------:|:------:|
| View project data | ✓ | ✓ | ✓ | ✓ | ✓ |
| Pull delta sync | ✓ | ✓ | ✓ | ✓ | ✓ |
| Connect WebSocket | ✓ | ✓ | ✓ | ✓ | — |
| Edit own assigned tasks | ✓ | ✓ | — | ✓ | — |
| Create/edit any task | ✓ | ✓ | — | — | — |
| Create/edit dependencies | ✓ | ✓ | ✓ | — | — |
| Assign resources | ✓ | ✓ | ✓ | — | — |
| Edit project settings | ✓ | ✓ | —¹ | — | — |
| Manage members | ✓ | — | — | — | — |
| Delete project | ✓ | — | — | — | — |
| Self-remove | ✓ | ✓ | ✓ | ✓ | ✓ |

¹ Scheduler may edit the **methodology** and **estimation-mode** settings only; all other project settings require Admin (field-level gate, ADR-0041).

## Recommended role by persona

The 5 roles are capability levels, not job titles. The same role may serve different personas depending on the team's delivery method (waterfall, agile, or hybrid).

| Persona | Recommended role | Rationale |
|---------|-----------------|-----------|
| Executive Sponsor / COO | Viewer | Reads status and reports; no editing needed. |
| PMO Director | Viewer | Portfolio-level visibility; project edits belong to the PM. |
| Project Manager | Project Manager (Admin) | Full task/dependency edit, baseline management. |
| Product Owner | Project Manager (Admin) | Backlog and sprint content authority requires the same write access as a PM. |
| Scrum Master / Agile Delivery Lead | Project Manager (Admin) | Opens/closes sprints, manages velocity, runs ceremonies — same capability tier as a PM. |
| Resource Manager | Resource Manager (Scheduler) | Assigns resources without touching task content or the schedule directly. |
| Team Member / Contributor | Team Member (Member) | Edits their own assigned tasks and logs time. |
| Agile Coach | Viewer | Observes team health signals; editing authority belongs to the team, not the coach. |

### Waterfall and agile on the same role tier

Product Owners and Scrum Masters hold the same **Project Manager** role as a traditional PM. This is intentional: sprint sovereignty and scope-change protection are enforced at the **application layer** (sprint open/close rules, explicit scope-injection approval), not by RBAC. A PM cannot silently add tasks to an active sprint regardless of their role, because the sprint model rejects mid-sprint mutations without team notification — the guardrail is in the workflow, not the permission level.

This means you do not need separate "Product Owner" or "Scrum Master" role slots. A project board with a Scrum Master assigned Admin and a PM also assigned Admin will have both respect the sprint boundary because the system enforces it uniformly.

## Managing members

Members are managed at `/api/v1/projects/{project_id}/members/`.

### Add a member

```http
POST /api/v1/projects/{project_id}/members/
Authorization: Bearer <token>

{"user": "<user-id>", "role": 100}
```

**Role escalation rule:** you can only assign a role strictly below your own. An Owner (400) can assign up to Admin (300).

### Change a member's role

```http
PATCH /api/v1/projects/{project_id}/members/{membership_id}/

{"role": 200}
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

## Server-derived capability flags

Every task in the API response carries two read-only booleans for the requesting user: `can_edit` and `can_delete`. They are computed server-side from the **same** predicate the write-permission check enforces (`can_user_edit_task`), so a client never re-implements the rule and the declared capability can never drift from the enforced one. The values reflect the full per-task rule, including the assignee-own case (a Member may edit a task only when they are its assignee) and the Product Owner facet (a PO may edit — but not delete — `EPIC`/`STORY` items). `can_delete` differs from `can_edit` only for a Product Owner, who grooms stories but does not delete them.

These flags are advisory for clients (the server still authorizes every write — hiding a control is defense-in-depth, never the only gate). The web app gates the entire task detail drawer off `can_edit`: a user who cannot edit a task sees a fully read-only drawer with a **"View only"** indicator in the header, rather than controls that silently fail on submit. A future admin role-capability matrix view (`GET /projects/{id}/role-capabilities/`) will expose the full role × capability grid for compliance review.
