# Rule 94 — Permission gate: ResourceView is only rendered for SCHEDULER (role ≥ 2) and above

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**Permission gate: ResourceView is only rendered for SCHEDULER (role ≥ 2) and above.**
Team Member (MEMBER, role=1) and Viewer (role=0) must see `PermissionDeniedNotice`
instead of the grid. Gate via `useCurrentUserRole()` on the client side; the API
enforces the same gate server-side (HTTP 403). Never render the grid for lower roles
even if the API call happens to return 200.
