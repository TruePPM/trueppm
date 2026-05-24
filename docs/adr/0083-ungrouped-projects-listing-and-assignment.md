# ADR-0083: Ungrouped projects listing and assignment on the Programs directory

## Status
Accepted

## Context

ADR-0070 made `Program` an OSS entity and added a nullable `Project.program` FK
(`SET_NULL`): a project belongs to at most one program, and `program=NULL` means
standalone. The `/programs` directory (`ProgramListPage`) lists programs but gives a
user no way to **see the projects that aren't in any program**, nor to organize them
without opening each project's settings.

The Program-entity design handoff (Claude Design, `Program Entity.html` page 1, issue
#697) adds an **"Ungrouped projects"** section below the program cards: a list of the
user's standalone projects with health, % complete, a member count, and a
**"Move to program"** action.

This is **OSS, P3M layer "Programs and Projects"** — a single user organizing the
projects they already have access to. It does not aggregate across programs (that
rollup is the Enterprise portfolio view; cf. the VoC note that Marcus's portfolio
summary is correctly Enterprise-tier). VoC panel average was low (2.7/10) but assessed
as a wrong-panel artifact for an org-hygiene affordance with no genuine blockers; the
build was confirmed.

Three decisions are net-new relative to ADR-0070, which is why this ADR exists:
how to list the standalone projects, how to move one, and what list fields the row needs.

## Decision

1. **List via a query param on the existing projects list endpoint, not a new endpoint.**
   `GET /api/v1/projects/?program__isnull=true` returns the caller's standalone projects.
   RBAC scoping is inherited unchanged from `ProjectScopedViewSet.get_queryset`
   (membership-scoped); the param only adds `.filter(program__isnull=True)`. No new
   permission class, no new viewset, no IDOR surface.

2. **Move via the existing project PATCH — no new write path.**
   `PATCH /api/v1/projects/{pk}/ { "program": <id> }` already exists and already enforces
   the ADR-0070 gate in `ProjectSerializer.validate_program` (ADMIN on the project AND on
   the target program AND on the source program). `perform_update` already broadcasts
   `project_updated` deferred with `transaction.on_commit`. The web reuses the existing
   `useAssignProjectToProgram()` mutation hook. The picker UI is **new**: the existing
   `AddProjectToProgramModal` runs program→project (pick a project for a program); the
   ungrouped row needs project→program (pick a program for a standalone project), so a
   small `MoveToProgramModal` lists the user's programs (`usePrograms()`) as the inverse
   direction. Same hook, inverted selection.

3. **Enrich `ProjectSerializer` with two cheap annotated read-only fields.**
   - `member_count` — `Count("memberships", filter=Q(memberships__is_deleted=False))`,
     mirroring the existing `ProgramViewSet` annotation. Surfaces the resourcing signal
     David (Resource Manager) asked for in VoC.
   - `percent_complete` — `Avg("tasks__percent_complete", filter=Q(tasks__is_deleted=False))`,
     a single SQL aggregate (no N+1). `null` when a project has no tasks.

   Both are annotated in `get_queryset` so they are populated without per-row queries.
   **`lead` is deferred**: `Project` has no `lead`/`owner` FK (project lead is derived
   from the OWNER `ProjectMembership`), so surfacing it on a list row requires a
   correlated subquery — disproportionate for a cosmetic avatar in this slice. The row
   shows health · name · code · % complete · member count · "standalone" · Move.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **1a. `?program__isnull` filter (chosen)** | Reuses RBAC scoping; API-first; one queryset branch | Adds a query param to a hot endpoint |
| 1b. Dedicated `/programs/ungrouped-projects/` action | Namespaced | Duplicates RBAC logic; splits "list projects" across two endpoints |
| 1c. Fetch all projects, filter `program===null` client-side | Zero backend | Inaccurate "N need a home" count; overfetch; still needs enriched fields |
| **2a. Reuse project PATCH (chosen)** | Already gated + broadcasts | none material |
| 2b. New `programs/{id}/projects/` POST action | Symmetric with member mgmt | Second write path to keep permission-synced with PATCH |
| **3a. Annotate member_count + percent_complete (chosen)** | Single aggregates, no N+1, broadly useful | Slight cost on every projects-list call |
| 3b. Also annotate `lead` via subquery | Matches mock visually | Subquery on a hot endpoint for a cosmetic avatar — deferred |

## Consequences

- **Easier**: organizing standalone projects from one place; the projects-list response
  now carries `member_count`/`percent_complete` for any consumer (program cards, future
  surfaces).
- **Harder**: the `/projects/` list query gains two aggregates and an optional filter
  branch — covered by `perf-check` and a regression on the existing list contract.
- **Risks**: enriching the shared `ProjectSerializer` touches every projects-list
  consumer (additive/backwards-compatible, but it changes the OpenAPI schema — regen
  required) and the frontend `Project` type + `mapProject` mapping must be extended in
  lockstep or the new fields are silently dropped.

## Implementation Notes
- P3M layer: **Programs and Projects** (OSS).
- Affected packages: **api** (filter + serializer annotation), **web** (ungrouped
  section, type/mapper extension, reuse of existing picker/hook).
- Migration required: **no** — `Project.program` and `ProjectMembership` already exist.
- API changes: **yes (additive)** — `?program__isnull=true` query param; `member_count`
  and `percent_complete` read-only fields on `ProjectSerializer`. OpenAPI schema regen.
- OSS or Enterprise: **OSS** (`trueppm/trueppm`).

### Durable Execution
1. Broker-down behaviour: **N/A** — no new async dispatch. The move reuses the existing
   `project_updated` broadcast, which is best-effort UI fanout (mobile/web reconcile via
   `server_version`); dropping it on broker outage is acceptable and unchanged by this work.
2. Drain task: **N/A** — no new async category introduced.
3. Orphan window: **N/A** — no outbox rows added.
4. Service layer: reuses `ProjectViewSet.perform_update` (existing); listing is a pure read.
5. API response on best-effort dispatch: **N/A** — PATCH returns the updated project
   synchronously (200); the list filter is a synchronous read.
6. Outbox cleanup: **N/A**.
7. Idempotency: the move is an idempotent PATCH (setting `program` to a value is
   convergent; re-applying yields the same state). The list filter is a read.
8. Dead-letter / failure handling: **N/A** — no async task. A failed PATCH surfaces a
   synchronous 4xx/5xx to the caller; the optimistic UI rolls back.
