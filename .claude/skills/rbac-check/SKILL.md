---
name: rbac-check
model: opus
description: >
  Role-based access control audit for TruePPM API endpoints. Use when adding or
  modifying any viewset, view, or serializer to verify authentication is required,
  permission classes enforce the 5-role model, and object-level access is correct.
  A missing permission check is a security vulnerability, not a quality issue.
---

# RBAC Check Skill

You are auditing TruePPM's role-based access control for a new or modified endpoint.

## TruePPM's 5-Role Model

| Role | Scope | Key Permissions |
|------|-------|-----------------|
| `Owner` | Project | All CRUD + delete project + manage members |
| `Admin` | Project | All CRUD, cannot delete project or demote Owner |
| `Scheduler` | Project | Read all + create/update tasks, dependencies, baselines |
| `Member` | Project | Read all + update own time entries |
| `Viewer` | Project | Read-only across all project data |

## Checklist

### Authentication
- [ ] Every viewset/view has `permission_classes` explicitly set — no implicit defaults
- [ ] `IsAuthenticated` (or stricter) is always in the permission chain
- [ ] Unauthenticated requests return 401, not 403 or 200
- [ ] WebSocket consumers validate JWT on `connect()`, disconnect on invalid token

### Object-Level Access
- [ ] List endpoints filter by project membership — users cannot enumerate other projects' data
- [ ] Retrieve/update/delete endpoints verify the object belongs to a project the user is a member of
- [ ] Cross-project access (e.g., resource sharing) is explicitly gated and audited
- [ ] Nested resources (e.g., `/api/v1/tasks/{id}/dependencies/`) inherit parent project membership check
- [ ] **Org-wide permission classes pair with an object-level target check** — a permission class that grants access based on holding a role on *any* project/program (org-wide / "is a member somewhere" style) only proves the caller is *a* member, not a member of *this object's* project. Any write gated solely by such a class must add an object-level check in `perform_create`/`perform_update`/`has_object_permission` that the target object's project/program matches the caller's membership. Flag any mutation gated only by an org-wide role with no per-object scope check.
- [ ] **`IsAuthenticated` + an unscoped `get_queryset()` is an object-existence leak** — even when per-object role checks exist, an unscoped queryset on a membership-scoped resource lets a caller probe existence via 403-vs-404 (a valid PK returns 403, an invalid one 404). Queryset scoping is part of the permission surface, not just a performance detail: `get_queryset()` must filter to the caller's memberships so non-members get a uniform 404. Flag any membership-scoped viewset whose `get_queryset()` returns the full table.

### Role Enforcement
- [ ] **Per-action role mapping — one viewset-level permission class rarely fits every method.** Enumerate every mutating entry point on the viewset — `create`, `update`, **`partial_update` (PATCH)**, `destroy`, and each custom `@action` with an unsafe method — and map each to its minimum role. Verify the permission layer enforces that mapping *per action* (`get_permissions()` keyed on `self.action`, or an object-level `has_object_permission` that reads the action), not a single blanket class that grants any project member the same access for reads and writes. PATCH is the classic miss: `partial_update` routes through the same permission as `retrieve`, so a read-level "is a project member" class silently lets a Viewer or Member edit fields (e.g. project settings) the UI only exposes to Admin+.
- [ ] Write operations (create/update/delete) check the user's role in the project
- [ ] Scheduler-only actions (schedule trigger, baseline create) are gated to `Scheduler`+
- [ ] Admin-only actions (member management, project settings) are gated to `Admin`+
- [ ] Owner-only actions (delete project) are gated to `Owner`
- [ ] Role is checked from the `ProjectMembership` model, not from a user flag

### Serializer Safety
- [ ] Serializers do not expose fields from other projects
- [ ] Write serializers explicitly list `fields` — no `__all__`
- [ ] `read_only_fields` covers server-computed values (`server_version`, CPM outputs)
- [ ] User-controlled FK fields validate the related object belongs to the same project

### Privilege Escalation
- [ ] Users cannot assign themselves a higher role than they currently hold
- [ ] Bulk operations enforce per-object permission checks, not just list-level
- [ ] Soft-delete or archive operations require the same role as hard delete

## Output Format

State the verdict first: **PASS**, **FAIL**, or **NEEDS REVIEW**.

For each issue found:
```
### [CRITICAL|HIGH|MEDIUM|LOW] Issue Title
**Endpoint/File**: path:line
**Problem**: What the gap is
**Fix**: Exact code change needed
```

If no issues: confirm which permission classes are applied and which roles they map to.
