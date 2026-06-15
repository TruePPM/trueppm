# ADR-0132: Server-Derived Task Edit Capabilities

## Status
Accepted

## Context

The web client gates task-drawer write controls off a **client-side reimplementation**
of the server's permission rule: `canEditTask(role) = role >= ROLE_MEMBER (100)` in
`packages/web/src/lib/roles.ts`. The authoritative rule lives in
`IsProjectMemberWriteOrOwn.has_object_permission` (`apps/access/permissions.py`) and is
materially different from the client's approximation. The client rule is wrong in **three**
concrete ways:

1. **Scheduler (200) drift** — the client shows edit controls (`role >= 100` is true) but
   the server returns `False` for `role == Role.SCHEDULER`. A Resource Manager clicks a
   control and silently 403s.
2. **Member-own drift** — the client allows any Member to edit any task; the server only
   allows a Member to edit a task **where `task.assignee_id == request.user.pk`**. A Member
   editing a teammate's task 403s.
3. **PO-facet blindness** — the server grants a Product Owner (ADR-0078 facet) edit access
   to `EPIC`/`STORY` work items below Admin; the client has no notion of this, so a PO sees
   *fewer* controls than they're entitled to.

This is the exact problem VoC raised against the partial gating shipped in #1046 / MR !576:

- **Sarah (PM) 🔴**: "my client clicks the status dropdown and wonders why nothing happens."
- **Priya (Team Member) 🔴**: "Am I in read mode because it hasn't loaded, or is this a bug?"
- **Marcus (PMO)**: partial gating is *worse* than none for compliance — it looks enforced
  while leaving gaps; wants a "show-me, not trust-me" verifiable capability surface.

MR !576 gated only External Links + Attachments. The most prominent controls (status,
assignee, dates, comments, time entry, estimates, dependencies, blocker) remain ungated,
and the gate they'd use is itself the wrong rule.

**P3M layer:** Programs and Projects (single-project task RBAC) — OSS. This is per-project
role enforcement a PM needs to run their program; it is not cross-program governance.

## Decision

**1. A single shared edit-predicate is the source of truth for both enforcement and declaration.**

Extract the predicate currently inlined in `IsProjectMemberWriteOrOwn.has_object_permission`
into a pure helper `can_user_edit_task(request, task, *, method)`. It lives in
`apps/access/permissions.py` next to `_membership_role` (not a separate `capabilities.py`
module — a new module would import `_membership_role`/`Role` from `permissions.py` while
`permissions.py` calls the predicate, a circular import; co-locating avoids it).
`IsProjectMemberWriteOrOwn.has_object_permission` is refactored to delegate to it (no
behaviour change — it is the existing rule, lifted verbatim). The `TaskSerializer.can_edit`
field calls the same function. Drift between client and server becomes structurally
impossible: there is one rule, called twice.

**2. Ship `can_edit` and `can_delete` booleans on `TaskSerializer` for 0.3.**

Two read-only `SerializerMethodField`s, following the existing `my_role` /
`can_access_admin_settings` computed-field convention already in the codebase:

- `can_edit` — `can_user_edit_task(request, task, method="PATCH")`
- `can_delete` — `can_user_edit_task(request, task, method="DELETE")` (DELETE excludes
  the PO-facet branch, so the two values legitimately differ for a PO editing stories)

We deliberately keep the field set to these two for 0.3 rather than a broad
`{can_edit, can_comment, can_log_time, …}` capabilities object. Comments and time entry
have their own permission classes with their own rules; conflating them into one task-level
flag would be a *new* drift surface. The drawer's comment/time-entry controls gate off
`can_edit` for 0.3 (a Viewer is read-only across the board; the distinctions only matter for
Member/Scheduler, where edit access is the binding constraint), and a follow-up can split
them into dedicated capability flags if a real divergence appears. (See Consequences.)

**3. N+1 avoidance: the existing per-request role cache already solves it.**

`_membership_role` memoizes the requesting user's role per `project_id` on the request
object, so calling the predicate once per task row is O(1) after the first lookup —
`assignee_id` is already on the row, no extra query. The PO-facet check (`has_team_facet`)
runs only on the narrow path (sub-Admin role *and* an EPIC/STORY task), not the common case.
No new prefetch or context wiring is required.

**4. Defer the admin role-capability matrix to 0.4.**

#1144 explicitly permits this ("Consider splitting the admin report to 0.4 if scope is
large; the capability field is the 0.3 priority"). The per-task `can_edit` field is the 🔴;
the matrix is Marcus's 🟡 governance nicety. A standalone `GET /projects/{id}/role-capabilities/`
endpoint is filed as a 0.4 follow-up. Crucially, building it later is cheap *because of this
ADR* — it will evaluate the same `can_user_edit_task` helper against the role enum, so the
matrix and the live field can never disagree either.

**5. Client gates off `task.canEdit`, falling back to `canEditTask(role)` only when absent.**

The drawer computes effective editability **once** — `task.canEdit ?? canEditTask(userRole)` —
and threads `canEdit`/`canDelete` down through `DrawerSectionProps`, so each section reads a
prop instead of recomputing a client rule. The server field is authoritative when present;
the legacy client rule remains a fallback for WebSocket-synced rows that predate the field
and for optimistic local creates that haven't round-tripped. `canEditTask` is kept and
documented as a fallback-only approximation, not deleted, to avoid a flash of wrong affordance
during load/sync. As synced rows carry `can_edit`, the field wins everywhere.

**6. Complete drawer gating + one explicit "View only" signal (resolves the hide-vs-disable tension).**

Across every write control in the drawer (status, progress, assignee, sprint, blocker,
comments, recurrence, subtasks, attachments, external links, name, description):

- **Hide** the write control when not editable (Sarah's clean client-facing view; a control
  that would 403 simply does not render — the existing read display stays visible).
- **One explicit "View only" chip** (muted, lock icon) in the drawer header whenever the
  drawer is non-editable, with tooltip "Viewer access — ask an admin for edit access"
  (resolves Priya's ambiguity: absence of controls is never "is it a bug?" because the chip
  states the reason). Styled as the sanctioned neutral read-state (rule 149 pattern), never
  a warning tone.
- The read-only Description renders as plain text (no textarea affordance / focus ring);
  empty reads "No description" in `text-neutral-text-secondary` (rule 169, not the sub-AA
  disabled token).

The task **Delete** affordance lives in the Gantt task-list row / board card menu, not the
drawer, so there is no Delete to hide *in the drawer*; `can_delete` ships as the authoritative
field those surfaces (and MCP/headless clients) can adopt.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Shared predicate + `can_edit`/`can_delete` fields (chosen)** | Zero drift by construction; minimal API surface; reuses existing computed-field convention + role cache | Two new computed fields; sections must read a new prop |
| B. Broad `capabilities: ["task:write", …]` envelope (ADR-0112 shape) | Aligns with future MCP capability vocabulary; extensible | Over-built for 0.3; comments/time-entry have distinct rules → either lie or fan out the envelope now; larger schema churn |
| C. Keep client-only `canEditTask`, just extend it to all sections | No API change | Bakes in all three drift bugs permanently; Marcus's compliance gap unaddressed; still "trust-me" |
| D. Per-request `GET /projects/{id}/role-capabilities/` only (no per-task field) | One endpoint, governance-friendly | Can't express per-task assignee-own rule (Member-own, PO-on-stories) — the very cases that 403 today; client still has to approximate |

## Consequences

- **Easier:** the client's edit affordance becomes correct for Scheduler, Member-own, and
  PO-facet cases it currently gets wrong; compliance reviewers get an authoritative
  per-task signal; a future capability split or admin matrix reuses one helper.
- **Harder:** every task response now carries two more computed fields — additive, but the
  serializer must degrade safely when instantiated without a request (nested serialization,
  tests): `can_edit`/`can_delete` return `False` when no request context is present, never
  raise.
- **Risk — comment/time gating granularity:** gating comments and time entry off `can_edit`
  is slightly coarser than their own permission classes. Verified acceptable for 0.3 because
  the only personas where it matters (Member, Scheduler) are exactly the personas whose task
  *edit* access is the user-visible binding constraint; a Viewer is uniformly read-only. If a
  future rule lets a non-editor comment, split `can_comment` out then — the shared-helper
  pattern makes that a localized change. Flagged for the ai-review / rbac-check gates.
- **Risk — stale WebSocket rows:** a synced row without `can_edit` falls back to the legacy
  (wrong) client rule until refetched. Mitigated because the fallback is strictly the
  pre-existing behaviour (no regression), and the authoritative field supersedes it on the
  next fetch.

## Implementation Notes

- **P3M layer:** Programs and Projects (OSS).
- **Affected packages:** api (shared predicate + serializer fields), web (drawer gating
  completion, "View only" chip, fallback wiring).
- **Migration required:** no (computed read-only fields; no model change).
- **API changes:** yes — additive read-only `can_edit: bool` and `can_delete: bool` on the
  Task response. No request-shape change. No enum added (booleans, no schema-drift risk).
- **OSS or Enterprise:** OSS (`trueppm-suite`). The admin role-capability matrix follow-up is
  also OSS (read-only role enforcement transparency); only immutable/tamper-evident org audit
  trails are Enterprise (ADR-0112).

### Durable Execution
1. **Broker-down behaviour:** N/A — read-path capability fields + UI gating; no async dispatch.
2. **Drain task:** N/A — no async work introduced.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** N/A — no dispatch. The new `can_user_edit_task` helper is a pure
   synchronous predicate, not a service dispatcher.
5. **API response on best-effort dispatch:** N/A — synchronous serializer fields.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** N/A — pure read; evaluating `can_edit` has no side effects and is
   referentially transparent for a fixed (user, task, role).
8. **Dead-letter / failure handling:** N/A. The predicate fails *closed*: any missing context
   (no request, unresolved role, deleted membership) yields `False`, never an exception and
   never an over-permissive `True`.
