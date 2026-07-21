# ADR-0548: Workspace group membership & project-access management UI

## Status

Accepted

## Context

Workspace → Groups & teams (#519, ADR-0087) shipped with a create/delete-only
UI. The backend is complete — `POST/DELETE /workspace/groups/{id}/members/` and
`POST/DELETE /workspace/groups/{id}/projects/` exist, gated `IsWorkspaceAdmin`,
and each write calls `services.reconcile_group_access()` which cascades
`ProjectMembership` rows (a group confers its granted role on every member ×
linked project) and defers a `broadcast_board_event` per affected project via
`transaction.on_commit`. But there was no UI to add members or grant project
access, so every group was stuck at "0 members / Access to 0 projects" (#2253).

Two frontend hooks (`useAddGroupMember`, `useRemoveGroupMember`) already existed
as dead code; no group→project hooks existed. The group read (`_group_dict`)
returned `projects` as bare name strings — which cannot drive a "revoke by
project UUID" control or show the conferred role, and whose `['all']` sentinel
branch in the card was unreachable (the backend never emits it).

**P3M layer:** Workspace-scoped access administration for one org's projects →
OSS. Directory (LDAP/AD) sync stays Enterprise (unchanged EnterpriseBadge gate).

## Decision

1. **Enrich the group read `projects` field in place** from `string[]` to
   `{id, name, role, role_label}[]` (single source of truth; one web consumer +
   two test fixtures migrated). Updates `_group_dict` / `_build_group_dict` /
   `_build_group_dicts` (columns only — query count unchanged, no N+1), a new
   nested `GroupProjectLinkSerializer` (so drf-spectacular documents the object
   shape), the `WorkspaceGroup` TS type, the `useWorkspaceGroups` mapper, and
   `GroupCard` (drop the dead `'all'` branch).

2. **A right-side non-modal drawer (480px desktop) / modal bottom sheet (mobile)**
   manages one group's members and project access, keeping the group grid visible
   (web-rules 89/164/185). All mutations are **immediate, row-level** (no
   dirty/save bar; rule 115): a searchable member combobox + remove, and a
   searchable project combobox + role select (Viewer/Team Member/Resource
   Manager/Project Manager, matching the serializer's `< OWNER` guard) + revoke.
   Two new hooks (`useGrantGroupProject`, `useRevokeGroupProject`) wrap the
   existing grant/revoke endpoints; the two dead member hooks become live.

3. **No new backend write path, no new permission, no migration.** The read
   enrichment is the only server change; RBAC gates, the reconciliation cascade,
   and its board broadcast are reused as-is.

## Consequences

- **Positive:** groups become functional (the intake → bulk-access flow ADR-0087
  designed); dead code is retired; single-source project read shape;
  broadcast / RBAC / migration gates are N/A or light re-verification because no
  write path or permission changed.
- **Cost / churn:** the `GroupSerializer.projects` shape change is an OpenAPI
  schema-drift event — `docs/api/openapi.json` regenerated; two group-read test
  fixtures updated.
- **Follow-ups:** conferrable-role menu breadth is a copy decision (default: the
  full `< OWNER` set); Enterprise directory sync remains out of scope.
