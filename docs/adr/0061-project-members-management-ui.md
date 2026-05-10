# ADR-0061: Project Members Management UI — Settings Tab and User Search Endpoint

## Status
Proposed

## Context

Issue #144 (milestone 0.1, OSS): The 5-role RBAC back-end (`ProjectMembership`,
`ProjectMembershipViewSet`) is fully implemented but has no management UI. Project Admins
(OWNER role, ordinal 4) cannot invite teammates, change roles, or remove members through
the web app. This is a table-stakes gap — without it, the only way to manage project
membership is via the API directly.

**P3M layer**: Programs and Projects (single-project scope). Cross-project membership
management is an Enterprise concern (ADR-0030). This feature is firmly OSS.

**VoC summary** (5.5/10 average, no 🔴 blockers, all 🟡):
- Cross-persona #1: "must already have an account" — accept for 0.1, surface clearly in UI
- Sarah (PM, 6/10): mobile-responsive layout required for on-site onboarding scenarios
- Priya (Team Member, 5/10): silent-add is bad UX — deferred to follow-up (see §5)
- Marcus (PMO, 6/10): wants role-change audit log — deferred to Enterprise scope
- David (Resource Manager, 5/10): do not conflate RBAC roles with resource allocation

**Existing API surface** (fully implemented, no changes to write semantics):
- `GET /api/v1/projects/{id}/members/` — list members (Viewer+); `?self=true` for own row
- `POST /api/v1/projects/{id}/members/` — add member (Owner only); body `{user: UUID, role: int}`
- `PATCH /api/v1/projects/{id}/members/{id}/` — change role (Owner only)
- `DELETE /api/v1/projects/{id}/members/{id}/` — remove (Owner for others; self-remove for any)
- Read response: `{id, server_version, project, user, user_detail: {id, username, email}, role, role_label}`

**Gap**: The write serializer accepts `user: UUID`. No user-search endpoint exists. The UX
must resolve a name/email typed by the admin to a UUID before posting.

**Constraints from prior ADRs**:
- ADR-0033: `ProjectMembership` (access) and `ProjectResource` (staffing/allocation) must
  remain conceptually and visually separate. Members tab must never show allocation percentages.
- ADR-0034: `directorySync.enabled` enterprise flag should suppress the invite form when
  LDAP/SCIM manages provisioning. Implement via slot registry (ADR-0029), never a hardcoded
  edition guard in OSS code.
- ADR-0029: Enterprise extensions via named `SlotId` registrations in `widget-registry.ts`.
  `grep -r "trueppm_enterprise" packages/` must remain clean.
- ADR-0030: Project shell at `/projects/:id/`. No cross-project membership management in OSS.
- ADR-0041: Tab visibility filter pattern via `TABS` array in `ViewTabs.tsx` and
  `BottomNav.tsx`. New tabs must declare visibility for all three methodology presets.

## Decision

### 1. Routing — Dedicated Settings Tab

Add a new **Settings** section to the project shell at `/projects/:id/settings`, with a
Members child route at `/projects/:id/settings/members`. Redirect bare `/settings` →
`/settings/members` (future sub-tabs: General, Integrations, Notifications, etc. can be
added without changing the shell).

**Why not under Resources?** ADR-0033 explicitly keeps `ProjectMembership` (access control)
separate from `ProjectResource` (staffing). Placing Members under Resources conflates the
two concepts visually and trains users to expect role changes to affect capacity.

**Why not a modal?** A modal viewport is too constrained for the simultaneous display of a
member list, a search-and-invite form, and a role picker, especially on mobile (Sarah's
field scenario). A full route within the shell provides stable layout at all breakpoints.

**Tab visibility**: The Settings tab is visible to all project members (Viewer+) — anyone
can see the member list. Write controls (role picker, remove, invite form) are hidden
client-side for roles below OWNER; the API enforces this server-side regardless.

The tab is present for all three methodology presets (WATERFALL, AGILE, HYBRID), following
the ADR-0041 pattern.

**Self-remove / "Leave project"**: Surfaced in Settings → Members as a contextual "Leave"
action on the current user's own row. Also exposed as a secondary "Leave project" item in
`UserMenu.tsx` project context section so a member can leave without navigating to Settings.

### 2. User Search — New Backend Endpoint

Add `GET /api/v1/users/search/?q=<term>` to the access app.

- Returns `[{id, username, email, display_name, initials}]`, at most 10 results.
- Searches `username__icontains OR email__icontains` (case-insensitive `Q()` query).
- Permission: `IsAuthenticated` only — no project-membership check. The search is org-wide.
- Excludes users already members of the project (optional; front-end also filters the dropdown).
- No pagination — 10 results is sufficient for a typeahead; full user management is admin-level.

**Privacy tradeoff**: Exposing org usernames and emails to any authenticated user is acceptable
for a self-hosted OSS deployment where all accounts are org-internal. This matches the
behaviour of Jira, GitLab, and Linear in self-hosted mode. Document in API docs. Enterprise
can override via `settings.members.invite_form` slot when SCIM/LDAP is active.

**Why not client-side?**: No org-wide user list endpoint exists and building one would
require a full-user dump with pagination — that's a new endpoint regardless, and
filtering client-side over a potentially large set is wasteful.

**Write flow**: Frontend issues `GET /users/search/?q=...` (debounced 300 ms), user selects
a result (which carries the UUID), then `POST /api/v1/projects/{id}/members/` with
`{user: UUID, role: int}`. No change to the existing write serializer.

### 3. Component Structure

```
packages/web/src/features/settings/
├── ProjectSettingsPage.tsx        # shell — tab nav; for 0.1 only "Members" tab
├── members/
│   ├── MembersTab.tsx             # member list + invite form (Owner-gated controls)
│   ├── MemberRow.tsx              # avatar, name, email, role badge, change-role / remove
│   ├── InviteForm.tsx             # search combobox + role picker + Add button
│   └── RolePicker.tsx             # <select> with role ordinals and human labels
└── hooks/
    ├── useMembers.ts              # GET /projects/{id}/members/
    ├── useAddMember.ts            # POST → invalidates ['members', projectId]
    ├── useUpdateMemberRole.ts     # PATCH → invalidates ['members', projectId]
    ├── useRemoveMember.ts         # DELETE → invalidates ['members', projectId]
    └── useUserSearch.ts           # GET /users/search/?q= debounced typeahead
```

`ProjectSettingsPage` renders a settings shell with a `<nav>` tab bar. For 0.1, only
"Members" is rendered. Future tabs (General, Integrations) are added as child routes without
changing the shell or the router pattern.

**Slot registration** (in `widget-registry.ts`):
- `settings.members.toolbar_end` — enterprise badge / "sync now" button for LDAP/SCIM
- `settings.members.invite_form` — enterprise override to suppress/replace the invite form
  when `directorySync.enabled` is active

### 4. Backend Additions

| Item | File | Change |
|------|------|--------|
| `UserSearchView` | `apps/access/views.py` | New `APIView`; `IsAuthenticated`; returns 10 results |
| `UserSearchResultSerializer` | `apps/access/serializers.py` | `id, username, email, display_name, initials` |
| URL registration | `apps/access/urls.py` | `path("users/search/", UserSearchView.as_view())` |
| OpenAPI schema | `docs/api/openapi.json` | Regenerate after merge (run `scripts/export-openapi.sh`) |

No model changes. No migrations.

### 5. "Welcome" Notification (Deferred)

No global notification system exists. Implementing a per-session "you were added to
Project X" banner requires either a `Notification` model or a last-seen-memberships key in
local storage. Deferred to a follow-up issue. For 0.1: the new project appears in the
user's project list immediately (the membership row is live on creation); discovery is
implicit. File a follow-up linking to this ADR.

### 6. Role-Change Audit Log (Deferred — Enterprise)

`simple_history` is installed but `HistoricalRecords()` is not applied to `ProjectMembership`.
Adding it to the OSS model would provide per-row history for free. However, per Marcus's
concern: the *display* surface for audit evidence (who changed whom, when, with what
justification) is an Enterprise compliance feature. The correct 0.1 decision is to add
`simple_history` tracking on the OSS model (low cost, useful data) and gate the history
*view* behind an Enterprise slot. Deferred to a follow-up — the current 0.1 scope ships
without history tracking.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Settings tab** (chosen) | Canonical UX pattern; room for future settings; respects ADR-0033 separation | Adds a tab to the shell; Settings may feel heavy for 0.1 |
| Members sub-route under Resources | Fewer tabs; team-adjacent | Conflates access control with resource allocation (ADR-0033 violation) |
| Modal from project header | No new tab | Too constrained for list + invite simultaneously; poor mobile UX |
| UUID-only invite (no search) | Zero backend work | Completely unusable UX — not viable |
| Client-side user list + filter | No new endpoint | Privacy concern; requires a full-user dump endpoint anyway |

## Consequences

**Easier**:
- Project Admins can self-service team membership without API access.
- OSS is now a complete standalone tool — the RBAC model has a management surface.
- The Settings shell is extensible for future project configuration tabs.

**Harder**:
- A new tab in the project shell adds cognitive load. Mitigated by keeping Settings clearly
  distinct from functional views (Overview, Board, etc.) via tab label and icon.

**Risks**:
- User search exposes org-wide usernames and emails to any authenticated user. Acceptable
  for self-hosted OSS; must be documented and can be overridden via Enterprise slot registry.
- "Must already have an account" friction is unresolved for 0.1. Surface this explicitly in
  the UI ("Users must already have a TruePPM account") rather than letting the admin hit a
  confusing empty search result.

**Deferred**:
- Email invitation flow (requires `Invitation` model, email sending, token validation)
- In-app "you were added" notification
- Role-change audit log view (Enterprise)
- `simple_history` on `ProjectMembership` (follow-up)

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api` (new `UserSearchView`), `web` (new `features/settings/` directory)
- **Migration required**: No
- **API changes**: Yes — `GET /api/v1/users/search/`; regenerate OpenAPI schema after merge
- **OSS or Enterprise**: OSS (`trueppm-suite`)

### Durable Execution

1. **Broker-down behaviour**: N/A — pure CRUD (synchronous). The `broadcast_board_event`
   calls for `member_added`, `member_role_changed`, and `member_removed` are already wired
   in `ProjectMembershipViewSet` inside `transaction.on_commit()` — no change required.
2. **Drain task**: N/A — no new async work categories introduced.
3. **Orphan window**: N/A — no new outbox rows.
4. **Service layer**: N/A — existing viewset layer is sufficient. No new `services.py`
   function needed for CRUD-only membership operations.
5. **API response on best-effort dispatch**: N/A — all member CRUD operations return
   synchronous 200/201/204. WebSocket broadcast is fire-and-forget and does not affect the
   HTTP response code.
6. **Outbox cleanup**: N/A — no new outbox rows created.
7. **Idempotency**: N/A — duplicate member create returns 409 (already implemented in
   `ProjectMembershipViewSet.create`); role update and delete are naturally idempotent.
8. **Dead-letter / failure handling**: N/A — no async tasks introduced by this feature.
