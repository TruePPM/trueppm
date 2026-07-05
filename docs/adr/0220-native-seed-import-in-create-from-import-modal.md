# ADR-0220: Native TruePPM seed import in the create-from-import modal

## Status
Accepted

## Context
The create-from-import dialog (`ImportProjectModal`, ADR-0092) offers a
`FormatPicker` with two format tiles: **MS Project** (enabled, `.xml`) and
**TruePPM** (permanently `aria-disabled`, "Coming soon"). The disabled tile is a
UI-wiring lie flagged by the 2026-07-03 Fable audit (issue #1611): the native
TruePPM JSON seed *can* already be imported.

What already exists:
- **Backend**: `POST /api/v1/programs/import/` (`ProgramViewSet.import_seed`)
  validates a seed document (`validate_seed`, #614), remaps file-local slugs to
  fresh UUIDs, and materializes a `Program` and its projects/tasks/dependencies/
  sprints/baselines/risks/resources in one transaction (ADR-0109, #615). It is
  idempotent on the program slug, forces `create_users=False` (a live import must
  never mint logins), and is bounded against DoS by `SEED_MAX_UPLOAD_MB` (5 MB)
  and `MAX_SEED_NODES` (100 000 total entities). Permission is `IsAuthenticated`
  — same as `Program.create`; the caller becomes the program OWNER.
- **Web**: `useImportProgramSeed()` + `ImportProgramButton` ("Import from JSON")
  already wire this endpoint on the programs index, with a line-level validation
  error report (`seedImportErrors`).
- **Round-trip**: `GET /api/v1/projects/{id}/export/` (#967) exports a single
  project wrapped in a *synthesized single-project program* envelope (ADR-0109
  #967 addendum), so it re-imports through the very same `POST /programs/import/`.

The tension: the native seed is **program-grained** (the importer always creates
a new `Program`; it cannot import into an existing program, and cannot mint a
program-less standalone project without refactoring a 33 KB importer that
structurally assumes a program). But the modal that hosts the lying tile is
**project-grained** — its success contract is `onCreated(projectId)` and it
navigates to a project. The modal is opened in two contexts:
1. **Standalone** (Sidebar "Import a project", no `programId`) — create a new
   thing from a file.
2. **Add-to-program** (`ProgramProjectsPage`, `programId` set) — add a project to
   *this* existing program.

## Decision
Make the TruePPM tile real by **reusing the existing `POST /programs/import/`
endpoint** — no new backend surface — and enabling it **only in the standalone
(no-`programId`) entry** of the create-from-import modal.

- Selecting the **TruePPM** tile switches the dropzone to accept `.json` and, on
  import, calls `useImportProgramSeed()`. On success the modal navigates to the
  imported **program** (`/programs/{id}/overview`), not a project.
- The copy is honest that a TruePPM export imports as a **program** (it may
  contain multiple projects), so the program-grain outcome is never a surprise.
- In the **add-to-program** entry (`programId` set) a whole-program bundle is the
  wrong grain — you cannot import a new program *into* an existing program — so
  the TruePPM tile stays disabled there with an honest reason that points the
  user at the Programs page. The MS Project (project-grain) path is unchanged in
  both entries.

This is a web-wiring + honesty fix. The backend import path, its validation, its
id-remapping, its DoS bounds, and its permission model are unchanged.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| A. Reuse `POST /programs/import/`, context-dependent tile (chosen) | No new backend surface; DRY; DoS/permission/validation already battle-tested; honest about grain | Modal is dual-grain (MS Project → project, TruePPM → program); tile enabled state depends on entry context |
| B. New project-grain `POST /projects/import/native/` returning a `project_id` | Fits the modal's `onCreated(projectId)` contract cleanly; symmetric to MS Project create-from-import | Requires refactoring a 33 KB importer that assumes a program; the seed *format* is program-grained (even #967 project export wraps in a program), so a "program-less" import is a fiction; large risk for a wiring fix |
| C. Enable the tile universally (including add-to-program) | Simplest tile logic | Importing a new program from the "add a project to THIS program" entry is semantically wrong and would confuse/duplicate program creation |
| D. Leave the tile disabled, only document `ImportProgramButton` | Zero code | Leaves the audited UI lie in place; does not resolve #1611 |

## Consequences
- **Easier**: a TruePPM → TruePPM round-trip is now reachable from the primary
  "Import" affordance, not only the programs index; the audited "Coming soon" lie
  is removed.
- **Harder**: the modal now branches on selected format (accepted extensions,
  mutation, success navigation) and on entry context (tile enablement). This
  logic is covered by unit + E2E tests.
- **Risks**: a user importing from the standalone entry expecting "a project"
  gets "a program". Mitigated by explicit copy on the tile and modal. Multi-
  project seeds land the user on the program overview (the natural home), not an
  arbitrary child project.

## Implementation Notes
- **P3M layer**: Programs and Projects (OSS). Seed import creates a program the
  caller owns — the core OSS adoption unit; no cross-program aggregation.
- **Affected packages**: web (FormatPicker, ImportProjectModal, hook reuse).
  api: no change (the endpoint, serializer, and permissions already exist).
- **Migration required**: no (no `models.py` change).
- **API changes**: no new endpoint. `POST /programs/import/` is reused as-is.
- **OSS or Enterprise**: OSS (`trueppm-suite`). Native seed import is table-stakes
  self-hosting portability, not org governance.

### Durable Execution
1. **Broker-down behaviour**: N/A for the import itself — `import_seed` runs
   **synchronously** inside a single DB transaction in the request; it is not a
   Celery dispatch, so there is no broker gap for the write. The *post-commit*
   CPM recompute it schedules already goes through
   `scheduling/services.py::enqueue_recalculate()` (the outbox-backed path,
   ADR-existing), so a broker outage there degrades to the existing drain — this
   change adds no new dispatch site.
2. **Drain task**: reuses the existing schedule-recompute drain via
   `enqueue_recalculate`; no new drain. This change introduces no new async work.
3. **Orphan window**: N/A — no new outbox rows are written by this change.
4. **Service layer**: reuses `import_seed()` (projects/seed) and the existing
   `ProgramViewSet.import_seed` action; no new service function.
5. **API response**: synchronous `201 Created` with the created `Program` body
   (unchanged existing behaviour) — not a best-effort `202`.
6. **Outbox cleanup**: N/A — no new outbox rows.
7. **Idempotency**: unchanged — the seed importer is idempotent on the program
   slug (`Program.code`): a re-import of the same seed hard-deletes and rebuilds
   the matching program subtree (ADR-0109). The web flow does not retry
   automatically; a manual re-upload converges rather than duplicates.
8. **Dead-letter / failure handling**: a validation failure returns `400` with a
   line-level `detail` report; the modal renders it inline (`seedImportErrors`)
   so the user can fix the file and retry. No partial write survives — the whole
   import is one transaction.
