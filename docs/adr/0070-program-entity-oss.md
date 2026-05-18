# ADR-0070: Program Entity (OSS)

## Status
Accepted (2026-05-18) — implemented in #502 / !291. Prerequisite for ADR-0069 (BacklogItem / program backlog).

## Context

TruePPM's go-to-market is adoption-first. A PM and their team must be fully functional
at the **program level** — managing a set of related projects under a shared context —
without needing the Enterprise tier. Portfolio (multiple programs under PMO governance)
remains Enterprise.

The current OSS data model has no `Program` entity. Projects are standalone top-level
containers with no grouping mechanism. This makes it impossible to:

- Maintain a program-level backlog of features shared across related projects (ADR-0069)
- View combined burndown across a program's projects
- Plan which project absorbs the next body of work from the program pool
- Navigate coherently across a PM's set of related projects

This ADR introduces `Program` as a first-class OSS entity: a lightweight, named grouping
of related projects owned by one PM/team. It is not portfolio governance — no health
scores, no cross-program resource leveling, no approval workflows. It is the container
a PM needs to manage their own program of work.

**Corrected boundary**: Earlier architecture guidance (and ADR-0030's data model notes)
stated "Program is Enterprise." That was based on the original P3M-market framing and
has been superseded. The revised rule: a PM must be fully functional at the program level
in OSS. Portfolio (multiple programs under PMO governance) is Enterprise. See CLAUDE.md
Two-Repo Rule.

**Related ADRs**:
- ADR-0030: P3M Navigation Shell Split — amended by this ADR to add `/programs/:id` as
  an OSS shell between the project list and the Enterprise portfolio shell.
- ADR-0033: `ProjectMembership` model and 5-role RBAC — `ProgramMembership` mirrors this
  pattern and lives in the same `access` app.
- ADR-0069: `BacklogItem` model — depends on this ADR; `BacklogItem.program` FK resolves
  once `Program` exists.
- ADR-0041: `Project.methodology` — `Program.methodology` serves as a default for new
  projects created within the program; existing project methodologies are not overridden.

## Decision

Introduce a `Program` model in the `projects` app and a `ProgramMembership` model in
the `access` app, following the exact structural pattern of `ProjectMembership`
(ADR-0033). Add a nullable `program` FK to `Project`.

All existing projects remain standalone (`project.program = NULL`) — no forced
migration. PMs group projects into programs at their discretion.

### Data model

**`Program`** — `packages/api/src/trueppm_api/apps/projects/models.py`

```python
class Program(VersionedModel):
    """Named grouping of related projects for one PM or program team.

    A program is the OSS unit of coordination — one PM's set of related projects
    with a shared backlog, burndown, and planning surface. Portfolio (cross-program
    governance) is Enterprise scope.

    Projects are optional members: project.program = NULL is fully supported.
    """
    name        = CharField(255)
    description = TextField(blank=True, default="")
    methodology = CharField(choices=Methodology, default=HYBRID)
    created_by  = FK → AUTH_USER_MODEL (SET_NULL, null=True)
    created_at  = DateTimeField(auto_now_add=True)
    updated_at  = DateTimeField(auto_now=True)

    class Meta:
        db_table = "projects_program"
        ordering = ["name"]
        # No unique constraint on name — two PMs can have programs named "Phase 2"
```

**`Project` amendment** — add one nullable FK:

```python
program = FK → Program (SET_NULL, null=True, db_index=True, related_name="projects")
```

This is a nullable addition; no existing rows are affected. A project with
`program=NULL` is standalone and fully functional.

**`ProgramMembership`** — `packages/api/src/trueppm_api/apps/access/models.py`

```python
class ProgramMembership(VersionedModel):
    """Through table linking a user to a program with a specific role.

    Mirrors ProjectMembership exactly — standalone model (not M2M through=) so it
    participates in offline sync and supports direct permission checks without joins.
    Program membership controls access to program-level views (backlog, burndown,
    project list). It does not automatically grant or modify project-level access.
    """
    program = FK → Program (PROTECT, related_name="memberships")
    user    = FK → AUTH_USER_MODEL (CASCADE, related_name="program_memberships")
    role    = IntegerField(choices=Role.choices)

    class Meta:
        db_table  = "access_program_membership"
        unique_together = [("program", "user")]
```

**Cascade summary**:

| Action | Effect |
|--------|--------|
| Delete `Program` | Blocked by `PROTECT` on `ProgramMembership`; must remove members first |
| Delete `Program` (after members removed) | `BacklogItem` rows cascade (program owns them); projects become standalone (`SET_NULL`) |
| Delete `Project` | No effect on `Program`; FK is `SET_NULL` the other way |
| Delete `User` | `ProgramMembership` cascades; `Program.created_by` → NULL |

### RBAC

Reuses the existing `Role` enum from the `access` app (`access.models.Role`).
The ordinals match the project RBAC table exactly:

| Ordinal | Code name | Label              | Program-level intent |
|--------:|-----------|--------------------|----------------------|
| 0       | VIEWER    | Viewer             | Read backlog and projects list. |
| 1       | MEMBER    | Team Member        | Edit BacklogItem entries (#501). |
| 2       | SCHEDULER | Resource Manager   | Pull BacklogItem → project Task (#501). |
| 3       | ADMIN     | Project Manager    | Manage members; manage projects in program. |
| 4       | OWNER     | Project Admin      | Delete program. |

| Action | Minimum role |
|--------|-------------|
| View program (shell, project list) | VIEWER (0) |
| View program backlog | VIEWER (0) |
| Add/edit BacklogItems (#501) | MEMBER (1) |
| Pull BacklogItem → project Task (#501) | SCHEDULER (2) |
| Add/remove projects from program | ADMIN (3) |
| Manage ProgramMembership | ADMIN (3) |
| Delete program | OWNER (4) |

**Auto-membership on create**: When a user creates a Program, a `ProgramMembership` row
is automatically created for them with `role=OWNER` inside the same transaction.

**Project membership is independent**: `ProgramMembership` grants access to program-level
views. It does not cascade to individual project access, and project membership does not
grant program visibility. A team member on Project A sees that their project belongs to
"Program Alpha" (read-only label), but cannot access the program backlog without an
explicit `ProgramMembership` row.

### Permission classes (new, in `access.permissions`)

- `IsProgramMember` — any role on the program (Viewer+).
- `IsProgramEditor` — role ≥ MEMBER (1). Used by #501's BacklogItem write paths.
- `IsProgramAdmin` — role ≥ ADMIN (3). Used by program metadata update, member CRUD, and project assignment.
- `IsProgramOwner` — role = OWNER (4). Used only by program delete.

A per-request memoisation cache (`_program_membership_role`) prevents N+1
queries when a list endpoint resolves the caller's role per row.

### API surface

All nested under `/api/v1/programs/`:

| Endpoint | Method | Permission | Description |
|----------|--------|------------|-------------|
| `/api/v1/programs/` | GET | IsAuthenticated | List programs the user is a member of |
| `/api/v1/programs/` | POST | IsAuthenticated | Create program; auto-creates OWNER membership |
| `/api/v1/programs/{pk}/` | GET | IsProgramMember | Retrieve |
| `/api/v1/programs/{pk}/` | PATCH | IsProgramAdmin | Update name/description/methodology |
| `/api/v1/programs/{pk}/` | DELETE | IsProgramOwner | Delete (blocked if members exist) |
| `/api/v1/programs/{pk}/members/` | GET | IsProgramMember | List members |
| `/api/v1/programs/{pk}/members/` | POST | IsProgramAdmin | Add member |
| `/api/v1/programs/{pk}/members/{user_pk}/` | PATCH | IsProgramAdmin | Update role |
| `/api/v1/programs/{pk}/members/{user_pk}/` | DELETE | IsProgramAdmin | Remove member |

`Project` is assigned to a program via the existing `PATCH /api/v1/projects/{pk}/`
endpoint — `program` field added to the project serializer. Permission: `IsProgramAdmin`
on the target program AND `IsProjectAdmin` on the project.

### Navigation (ADR-0030 amendment)

Add a program shell to the OSS navigation layer:

```
/programs               — list of all programs the user is a member of
/programs/new           — create program
/programs/:id           — program shell (default tab: Backlog)
/programs/:id/backlog   — BacklogItem list + pull-down (ADR-0069)
/programs/:id/projects  — projects in this program
/programs/:id/burndown  — combined burndown across program projects (future: 0.3)
```

The project list (`/projects`) continues to show all projects the user has access to,
with a program badge on grouped projects. Standalone projects are shown without a badge.

The Enterprise portfolio shell (`/portfolios/:id`) is unchanged.

### Sync (WatermelonDB, ADR-0010)

Both `Program` and `ProgramMembership` extend `VersionedModel`. For #502 we ship
the architectural foundation but only the `Project.program` FK is wired into the
existing project-scoped sync endpoint:

- `projects_project` — `program` FK added to `SyncProjectSerializer` so mobile
  can render the program badge offline.
- `projects_program`, `access_program_membership` — **not yet wired into mobile
  sync.** The existing endpoint at `/api/v1/projects/{pk}/sync/` is
  project-scoped and cannot reach user-scoped Program rows. Mobile clients use
  the REST endpoints online and rely on the cached project rows (with the
  `program` FK) offline. A user-scoped sync endpoint that delivers Program /
  ProgramMembership deltas is tracked as a 0.4 mobile follow-up.

This split keeps the model architecturally clean (both extend VersionedModel
for future sync) while deferring the user-scoped sync endpoint plumbing to the
mobile milestone.

### Real-time broadcast

When a project is added to or removed from a program (`Project.program` changes), fire
`broadcast_board_event` in `transaction.on_commit` so connected program-shell clients
receive the update without a refresh.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A — `Program` model in `projects` app, `ProgramMembership` in `access` app (chosen)** | Mirrors existing Project/ProjectMembership split; RBAC stays in one app | Slight cross-app FK from `access` → `projects` (already exists for ProjectMembership) |
| **B — Dedicated `programs` Django app** | Clean separation | Overkill for an entity with two models; adds a fourth app for a PM to reason about |
| **C — M2M relationship on Project (no Program entity)** | No new top-level model | Can't attach a backlog, burndown, or navigation shell to a relationship; wrong abstraction |
| **D — Program as a special Project type** | No new model | Pollutes the project list; wrong semantics; breaks CPM and schedule assumptions |
| **E — Auto-cascade project membership → program membership** | Simpler onboarding | Implicit access grants are a security anti-pattern; different role scope; harder to audit |

## Consequences

**Easier**:
- ADR-0069 (`BacklogItem`) can be fully implemented — `BacklogItem.program` FK resolves.
- PMs have a first-class surface for managing their program of work in OSS.
- Combined burndown and program-level planning are now architecturally possible.
- The navigation model is coherent: project → program → (Enterprise) portfolio.

**Harder**:
- Two RBAC surfaces to maintain (program + project). Mitigated: same `Role` enum, same
  `access` app pattern, same permission class idiom.
- The project list gains a `program` field in the API response — OpenAPI schema must be
  regenerated.
- Mobile sync table list grows by two entries.

**Risks**:
- PMs may expect that adding a project to a program automatically grants program
  membership to all project members. The explicit membership model prevents this; UI
  must set clear expectations (a tooltip or onboarding prompt on program creation).
- `PROTECT` on `ProgramMembership → Program` means deleting a program requires a
  two-step flow in the UI (remove all members, then delete). The admin UI must handle
  this gracefully — offer a "Remove all members and delete" confirmation dialog.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api`, `web`, `mobile` (sync table list)
- **Migration required**: Yes — new `Program` model in `projects` app; new
  `ProgramMembership` model in `access` app; nullable `program` FK added to `Project`
- **API changes**: Yes — new `/api/v1/programs/` viewset; `program` field added to
  project serializer; OpenAPI schema must be regenerated
- **OSS or Enterprise**: OSS — single-program coordination for one PM/team

### Durable Execution

1. **Broker-down behaviour**: Program CRUD is synchronous with no async side effects.
   The `project.program` FK change fires `broadcast_board_event` via
   `transaction.on_commit` (existing pattern); no new outbox category needed. N/A.

2. **Drain task**: N/A — no new async work category introduced.

3. **Orphan window**: N/A — all operations are synchronous.

4. **Service layer**: Program creation should go through
   `access/services.py::create_program(name, description, methodology, created_by)`
   which atomically creates the `Program` and the OWNER `ProgramMembership` row. This
   prevents the race condition where a program exists with no OWNER.

5. **API response**: All Program CRUD is synchronous; standard `200/201` responses.

6. **Outbox cleanup**: N/A.

7. **Idempotency**: N/A for CRUD. `create_program()` is wrapped in an atomic
   transaction; duplicate calls from a network retry return the existing program if
   the name matches for the same `created_by` user (or return 201 with a new program
   if names differ — no uniqueness constraint on name).

8. **Dead-letter / failure handling**: N/A — no async tasks introduced.
