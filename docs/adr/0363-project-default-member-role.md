# ADR-0363: Project default member role

## Status
Accepted

## Context
Issue #157 (OSS, milestone 0.4) lists "default RBAC role for new members" among the
per-project settings a PM running 2–5 projects should be able to configure once and
carry into new projects. ADR-0242 already delivered the copy-at-create settings
template (`copy_settings_from` + `SETTINGS_TEMPLATE_FIELDS`); this ADR extends that set
with one new stored setting.

Today `ProjectMembership.role` (`access/models.py`) is a required `IntegerField` with no
default, so **every** add-member request must name a role. When a PM repeatedly adds
contributors to a project, they re-pick the same role each time. A project-level default
removes that friction: add a member without a `role` and the project's configured
default is used.

- **P3M layer**: Programs and Projects (single-project membership convenience). OSS.
- **Boundary check**: this selects one of the five existing OSS roles
  (VIEWER/MEMBER/SCHEDULER/ADMIN/OWNER, ADR-0072). It does **not** define a custom role
  (Enterprise) and adds **no** lock, enforcement, or audit trail — those remain the
  Enterprise governance overlay (`trueppm-enterprise#47`). It is a convenience default,
  firmly OSS.

## Decision
Add `Project.default_member_role`, an `IntegerField` storing one of the RBAC `Role`
ordinals, defaulting to `MEMBER` (100), and apply it only where a member is added
without an inherent role.

1. **Field.** `Project.default_member_role: IntegerField(default=<MEMBER=100>)`.
   Because `access/models.py` imports `VersionedModel` *from* `projects/models.py`,
   `projects/models.py` cannot import `Role` at module load without a circular import.
   The choices are supplied via a **module-level callable** (Django 5.x lazy `choices`),
   which defers the `Role` import to first evaluation (post-app-load). The stored default
   is the literal `100` behind a named constant documenting `== Role.MEMBER`. The
   migration serializes the callable by dotted path, so it carries no `Role` import.

2. **Default value = MEMBER.** A person added to a project is presumed a contributor.
   `VIEWER` would silently under-grant (cannot do work); `ADMIN`/`OWNER` over-grants.
   MEMBER matches the value the web add-member form already pre-selects.

3. **Applied only on the direct add-member path.** In `ProjectMembershipViewSet.create`
   (`access/views.py`), `role` becomes optional; when omitted, the resolved role is
   `project.default_member_role`. The existing "an actor may only grant a role strictly
   below their own" guard applies unchanged to the resolved role.
   - Auto-owner creation (project create, MS Project import) continues to force `OWNER` —
     the creator must own their project.
   - The Group→project access cascade (ADR-0087, `ProjectMembership.source_group`)
     continues to derive its role from `GroupProject.role`. That is an explicit,
     group-scoped grant; overriding it with the per-project default would break the
     group-access contract. The default is for *ad-hoc individual* adds only.

4. **The default is constrained to `< OWNER` (i.e. VIEWER/MEMBER/SCHEDULER/ADMIN).**
   A default of OWNER would make every unspecified add an Owner (a privilege-escalation
   footgun) and, because add-member is Owner-only (ADR-0184), a resolved role of OWNER
   (400) is not *strictly below* the acting Owner (400) and would always fail the grant
   guard — an unusable default. The write serializer and the web picker both reject/omit
   OWNER as a default. The model `choices` callable still exposes the full enum; the
   constraint lives in serializer validation and the UI.

5. **Reject, never clamp.** If a resolved default role is not below the actor's role, the
   request is rejected by the existing guard rather than silently lowered — silent
   clamping would under-grant without the actor knowing. With the `< OWNER` constraint
   and Owner-only add, the common path always passes; reject is a defensive path only.

6. **Copyable.** `default_member_role` is added to `SETTINGS_TEMPLATE_FIELDS`
   (`projects/services.py`) as a plain stored setting, so `copy_settings_from` carries it
   at project create (ADR-0242 §1). It is owned outright — not a live-inherited nullable
   override — so it never participates in the Program/Workspace inheritance resolver.

7. **Editable after create.** Exposed as a read/write field on `ProjectSerializer`, so
   project admins PATCH it freely (acceptance: "all settings independently editable").
   No lock, no policy tooltip, no audit record (those are Enterprise `#47`).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Callable `choices` (chosen)** | Full enum choices on the field; no circular import; migration carries no `Role` import | Slightly less obvious than a literal import |
| `IntegerField(default=100)` with no `choices`, validate only in serializer | Simplest | Loses model-level choice metadata (admin/DRF introspection) |
| Duplicate a `Role` enum inside the projects app | No import at all | Enum drift — two sources of truth for the RBAC ordinals; rejected |
| Make it a nullable live-inherited override (Program→Project) | Consistent with sharing/MC-history inheritance | Over-scopes #157 (which is copy-at-create, not governance inheritance); no Program-level default field exists; rejected |
| Apply the default to the Group→project cascade too | One uniform rule | Breaks the explicit `GroupProject.role` grant contract; rejected |

## Consequences
- **Easier**: repeated add-member on a project no longer re-picks the same role; new
  projects inherit the default via the existing settings-copy path.
- **Harder**: `role` is now optional on the add-member write serializer — tests and API
  clients that assumed it was required must tolerate the fallback (the field remains
  accepted; only its *requiredness* relaxes).
- **Risks**: a mis-set default silently changes what role unspecified adds get. Mitigated
  by (a) constraining to `< OWNER`, (b) the unchanged grant-below-your-own guard, and
  (c) the web always sending an explicit role from its picker, so the default is a
  fallback for API/bulk callers, not a hidden web behavior.

## Implementation Notes
- P3M layer: Programs and Projects.
- Affected packages: api (model + migration + serializers), web (create modal + members
  settings + hook types + regenerated OpenAPI types).
- Migration required: **yes** — one `AddField` on `projects.Project` with a default
  (safe: non-null with default 100; no data backfill needed).
- API changes: **yes** — `ProjectSerializer` gains read/write `default_member_role`;
  `ProjectMembershipWriteSerializer.role` becomes optional with a project-default
  fallback in the viewset; `default_member_role` joins `SETTINGS_TEMPLATE_FIELDS`.
- Sync: **no** — settings fields are deliberately excluded from `SyncProjectSerializer`
  (which carries only structural fields); `default_member_role` follows `default_view`/
  `estimation_mode` in being sync-excluded. Offline RBAC continues to sync *resolved*
  membership rows via `SyncMembershipSerializer`, unaffected.
- OSS or Enterprise: **OSS** (`trueppm-suite`).

### Durable Execution
1. Broker-down behaviour: **N/A** — add-member and project PATCH are synchronous DB
   writes with no task dispatch; only an existing `on_commit` WebSocket broadcast fires.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: `apply_settings_template` (`projects/services.py`) gains the field via
   `SETTINGS_TEMPLATE_FIELDS`; no new dispatch function. Add-member fallback is inline in
   the viewset `create`.
5. API response on best-effort dispatch: **N/A** — synchronous `201`/`200` responses.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — no tasks. The writes themselves are ordinary idempotent-by-PK
   model saves guarded by the existing `server_version` bump.
8. Dead-letter / failure handling: **N/A** — no tasks. Validation failures return `400`.
