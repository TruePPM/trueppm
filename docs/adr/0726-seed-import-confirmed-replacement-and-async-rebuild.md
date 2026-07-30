# ADR-0726: Program seed import — confirmed, recoverable replacement and an asynchronous rebuild

## Status

Accepted

## Context

Two 🔴 findings from the 0.4 pre-release audit land on the same two functions —
`_SeedImporter` in `apps/projects/seed/importer.py` and `ProgramViewSet.import_seed`
in `apps/projects/program_views.py`.

### #2581 — the replace is destructive, unconfirmed, and invisible

`_SeedImporter._replace_existing()` is called unconditionally from `run()`. When an
imported seed's `program.slug` matches the `code` of a live program the caller owns,
it hard-deletes the whole subtree — `ProjectMembership` → `Project` (cascading tasks,
dependencies, sprints, risks, baselines) → `ProgramMembership` → `Program`. There is
no confirmation flag, no Trash, no audit event, and no broadcast.

Because the rows are *removed* rather than tombstoned, an offline client never learns
they are gone: the sync delta splits `updated` from `deleted` on the live `is_deleted`
flag of a row that still exists, so a hard-deleted row simply stops appearing and the
client keeps a phantom project indefinitely. Connected collaborators keep editing rows
that no longer exist, because no `project_deleted` event ever fires.

The importer's module docstring frames wipe-then-recreate as intentional, citing
ADR-0109's "sample data is disposable" and the ADR-0092 precedent. That reasoning is
sound for the **sample** path and was silently generalized to the **generic** path,
which imports caller-authored bundles into live installations. ADR-0632 named the same
hazard from the other side when it refused to route CSV import through this pipeline:
*"wipe-then-recreate is exactly wrong … a PM adding 40 rows from a stakeholder's
spreadsheet would silently lose the program's other projects."*

The security scoping from #994 is intact and is **not** the defect: candidates are
restricted to programs on which the importing user holds a live OWNER
`ProgramMembership`, so this can only destroy the caller's own work. The defect is that
it destroys it without asking and without a way back.

### #2574 — the rebuild is synchronous and unbounded

`import_seed` runs the whole importer inline on the request thread and returns `201`.
`MAX_SEED_NODES` is `100_000`, and the importer issues at least three round-trips per
row: the `server_version` bump, the `sync_seq` allocation (`UPDATE projects_project …
RETURNING`, one statement per row), and the `simple_history` INSERT. Graph edges add a
fourth for owner resolution. The bundled default sample — 151 nodes — already costs
~3,700 sequential round-trips. A caller-sized document two orders of magnitude larger
returns a gateway timeout **while the transaction is still running**, with no job to
poll and no record that anything happened.

Every other import path in the codebase is already Celery-backed and returns a job
handle — MS Project (ADR-0092), Jira, and CSV (ADR-0632) — and all three carry *smaller*
caps than this one. Seed import is the outlier with the largest permitted payload.

A related hole surfaced while bounding the payload: `_read_seed_payload` enforces
`SEED_MAX_UPLOAD_MB` only on the multipart `file` branch. The raw-JSON-body branch is
capped only by `DATA_UPLOAD_MAX_MEMORY_SIZE` (100 MB), so the 5 MB ceiling is
bypassable and `MAX_SEED_NODES` is reachable after all.

### What the codebase already answers

Three precedents apply directly, and this ADR reuses all three rather than inventing:

| Concern | Existing answer |
|---|---|
| Program-grain async job (outbox, drain, purge, status poll) | `ProgramExportJob` + `enqueue_program_export` + `run_program_export` (ADR-0219, #1958) |
| Create the shell synchronously, build async, `202` with both ids | `msproject.CreateProjectFromMsProjectView` (ADR-0092) |
| Recoverable delete of a project subtree | `ProjectViewSet.perform_destroy` soft branch + `enqueue_project_cascade_soft_delete` (ADR-0202) |

**P3M layer:** Programs and Projects — one program and its member projects.
**OSS or Enterprise:** OSS. Importing and re-importing one program is core PM
workflow, not cross-program governance.

## Decision

### 1. Replacement requires explicit consent; the default is refusal

`POST /programs/import/` gains two optional request fields, accepted as multipart form
fields alongside `file` or as sibling keys on a JSON body, declared through a
`SeedImportRequestSerializer` so drf-spectacular describes them:

- `replace` (boolean, default `false`) — blunt confirmation, "replace whatever collides";
- `expected_program_id` (UUID, optional) — compare-and-swap: it must equal the resolved
  candidate's id or the request is refused again.

With neither set and a collision present, the endpoint returns **`409`** with
`code: "seed_replace_required"` and a `conflict` object naming the colliding program's
id, name, code, project count, and task count.

Naming the program leaks nothing. The candidate resolver requires a live **OWNER**
`ProgramMembership` for the caller — a stricter bar than "can see" — so every program
this response can name is one the caller owns outright.

`expected_program_id` exists so a client that acted on a stale dry run cannot destroy
the wrong program: the collision set can change between the two calls, and a bare
`replace=true` would follow it. The web client sends the id it just received in the 409.

### 2. One resolver, three callers

`resolve_replace_candidates(owner, slug)` is extracted from `_replace_existing` into
`seed/replace.py` and becomes the single site of the #994 OWNER scoping, the
`is_deleted=False` filter, and the `select_for_update()` lock. The import view, the
dry run, and the importer all call it. Re-deriving that query per call site is exactly
how a security scope drifts out of one of them.

### 3. The non-sample replace is a soft delete; the sample replace stays hard

A new `access.services.soft_delete_program_subtree(program_id, *, actor)` soft-deletes
the program, and for each member project sets `deleted_by`, detaches it
(`program = NULL`), soft-deletes it, enqueues `cascade_project_soft_delete`, and defers
a per-project `project_deleted` broadcast to `transaction.on_commit`. The per-project
half is the soft branch of `ProjectViewSet.perform_destroy`, extracted as
`soft_delete_project(project, *, actor)` so the two paths cannot drift.

Three details are load-bearing and are deliberately **not** copied from
`delete_program_cascade`:

- **Memberships stay live.** `UserProgramSyncView` builds its accessible set from
  `ProgramMembership(user=…, is_deleted=False)` and then filters
  `Program.objects.filter(id__in=accessible_ids, …)`. Soft-deleting the memberships —
  which `delete_program_cascade` does — drops the program out of that set, so the
  tombstone is never delivered: the same failure as the hard delete, one layer down.
  `PROTECT` on `ProgramMembership.program` only binds a hard `DELETE`, so keeping the
  rows costs nothing. `perform_destroy` already establishes the convention at project
  grain ("memberships survive a soft-delete").
- **Projects are detached at delete time.** `ProjectViewSet.restore` has no notion of a
  tombstoned parent; a restored project still pointing at a soft-deleted program is the
  dangling reference `delete_program_cascade` was written to prevent.
- **`Program.code` is non-unique by explicit model decision** ("intentionally NOT unique
  — no DB constraint"), and the resolver filters `is_deleted=False`. The replaced
  program and its successor coexisting under one code is therefore not a collision and
  cannot make a later re-import ambiguous.

The `is_sample` path keeps hard delete — disposable demo data is what it is for
(ADR-0109) — but routes through `access.services.hard_delete_program`, which resolves
the `PROTECT`-ing set from `_meta`. This replaces the importer's stale hand-written
delete list, the same rot that 500'd sample teardown in #2364 and that `remove_sample`
was already migrated off. The #2476 invariant is preserved verbatim: a sample reload
never replaces a program containing a real (non-sample) project.

### 4. Replacement happens synchronously; only the rebuild is queued

Inside the request transaction: read and cap the payload, validate it, resolve the
collision under `select_for_update`, perform the replacement, create the `Program` shell
via `create_program`, write the `ProgramImportJob` row, and persist the payload to
`default_storage`. Then return `202`. The O(n) subtree build (Passes A–D) runs in the
worker.

This split is deliberate. Resolving the collision in the request but acting on it in the
worker would open a TOCTOU window between "I told you there was no conflict" and "the
worker deleted something", and a destructive act belongs inside the request the operator
actually authorized. The replacement itself is bounded — one program row plus N project
rows — because the ~24k-row child tombstone cascade is already offloaded per project by
`enqueue_project_cascade_soft_delete`.

The importer therefore learns to **adopt** a pre-created program:
`import_seed(payload, owner=…, target_program=None)`. Passing `None` keeps the
create-it-myself behavior the management command and `load_sample` rely on.

### 5. `ProgramImportJob` is a new sibling of `ProgramExportJob`

Same app (`projects`), same lifecycle (`pending → running → success | failed`), same
`celery_task_id` / `error_detail` / `started_at` / `completed_at` / `expires_at` shape,
same drain and purge machinery. `program` is a **non-null** FK — decision 4 creates the
shell first — which is what lets the status endpoint be program-scoped and inherit the
export job's IDOR guard through `get_object()`.

Additional fields: `replace` and `replaced_program_id` (an audit record of what was
tombstoned, surviving the job), `result_summary` (entity counts), and `file_path` — the
uploaded payload in `default_storage`, **not** a `JSONField`, so a 5 MB document never
bloats an operational table and the purge already knows how to delete a storage file.

Not a reuse of `csvimport.CsvImportRequest` or `msproject.ImportRequest`: both are
`project`-FK-scoped, and a seed import has no project at request time. ADR-0259 and
ADR-0632 both chose a dedicated outbox per source "so no drain has to branch on file
type", and `ProgramExportJob`'s own docstring rejects the generalized nullable-scope
alternative for this exact model family.

### 6. The response is `202 {"queued", "program_id", "import_request_id"}`

The shape of `CreateProjectFromMsProjectView`, and the reason the shell is created
synchronously: the client has somewhere to land immediately. Polling is
`GET /programs/{pk}/import/jobs/{job_id}/`, the mirror of
`GET /programs/{pk}/export/jobs/{job_id}/`. No `celery_task_id` in the body — under the
outbox pattern no task id exists at serialization time (ADR-0632 decision 6).

### 7. The dry run reports the pending replacement, without giving up its purity

`POST /programs/import/validate/` gains a top-level `replaces` key alongside the existing
`SeedReport` fields: `null`, or the same `conflict` object the 409 carries. It is
computed **in the view**, not inside `inspect_seed` — that function is pure and lives in
a module that never imports the ORM, and the dry run's "persists nothing" guarantee is
structural precisely because of it. `SeedReport` stays a frozen, ORM-free dataclass.

### 8. Batch the O(n) writes; leave the semantically ordered ones alone

The whole import runs inside `sync.sequence.coalesce_sync_seq()`, which collapses the
per-row `UPDATE projects_project … RETURNING` cursor allocation into one draw per
project. Its contract explicitly permits this: "rows written together may share a
`sync_seq` — the delta is `> since` and the checkpoint is the maximum, so a batch is
either wholly before or wholly after any client checkpoint."

On top of that, `Task` and `Sprint` (Pass A) and `Dependency`, `TaskRelation`,
`TaskLabel`, `TaskResource` and `RiskTask` (Pass B) move to batched inserts, and the
`parent_epic` / `target_milestone` back-links move to `bulk_update`.

`bulk_create` alone is **not** sufficient for a `VersionedModel` — it skips three things
`save()` does, and each is a silent data defect rather than an error:

- `server_version = 1` on the INSERT branch — set explicitly per instance;
- `sequence.allocate()` — skipped, every row keeps `sync_seq = 0`, and
  `sync_seq__gt=since` never returns it, *even on a cold start with `since=0`*. The rows
  would be permanently invisible to offline sync. Draw once per project with
  `allocate_for_projects` and stamp the batch;
- the `simple_history` row, which `server_version` is documented to track 1:1 and which
  `sync/conflict.py` slices for the ADR-0217 field-level merge. Use
  `simple_history.utils.bulk_create_with_history`, grouping each batch by `created_on`
  so v2 replay's `_history_date` backdating survives — the number of distinct dates is
  bounded by the sprint count, not the task count.

`Task`'s three `post_save` receivers are all safe to skip on INSERT: two early-return on
`created`, and the milestone rollup short-circuits because `Sprint.target_milestone` is
not linked until Pass B.

Structurally **not** batched: Pass C (`replay_timeline`) walks each entity through dated
transitions with a day-by-day burndown clock — row-at-a-time is the semantics, not an
implementation accident. `Risk` stays per-row so the `risk_changed` signal fires, and its
counts are in the tens. `Project` / `Program` / memberships are O(#projects), and
`Project` INSERT has the special `seed_project_sequence` in-memory path.

### 9. `MAX_SEED_NODES` stays at 100,000, and the upload cap is fixed on both branches

At the bundled fixtures' measured ~525 bytes/node, `SEED_MAX_UPLOAD_MB = 5` already
bounds a multipart upload to roughly 10,000 nodes (~44,000 adversarially minified), so
the node ceiling was never the binding constraint there. It *is* reachable through the
uncapped JSON-body branch, which this ADR closes by checking `CONTENT_LENGTH` against
`SEED_MAX_UPLOAD_MB` on **both** branches before any parse.

Once async, the binding resource is worker memory rather than request time: `self.tasks`
holds a live model instance per task for the whole import, so 100k nodes is on the order
of 100–200 MB of symbol tables on top of the parsed payload. The ceiling is therefore
**retained as a memory backstop and deliberately not raised**, even though the constraint
it was written for has moved.

### 10. `load-sample` stays synchronous, with its bound made testable

Its payload is a server-curated bundled fixture, not a caller-sized document. The four
registered samples measure 46–151 nodes; the largest takes seconds, not minutes. Moving
it would double the frontend work on the first thing a new evaluator ever clicks, and
its `landing_project_id` / `sample_key` envelope would have to become poll-resolved for
no user gain.

A test asserts every entry in `SAMPLES` stays under `MAX_SAMPLE_NODES`, converting
today's assumption into an invariant a future fixture cannot break silently. `load_sample`
passes `replace=True` internally and continues down the `is_sample` hard-delete branch,
so "Load demo data" keeps reloading in place.

### 11. Idempotency is a claim, not a property

Once replacement moves into the request, the worker's job is purely **additive**: build
the subtree into a pre-created, empty program. A duplicate delivery — a drain
re-dispatch, an `acks_late` redelivery after a worker loss — would run Passes A–D a
second time into the same program and double every task, dependency, and sprint. `Task`
has no `(project, wbs_path)` unique constraint to stop it.

`run_program_export`'s claim is reused: `select_for_update` the job row, no-op unless
`pending`/`running`, flip to `running` before any write. A caller with a `pending` or
`running` job for the same program gets that job back rather than queuing a second one,
mirroring `enqueue_program_export`'s in-flight de-dupe — which is also what keeps an
async import from converting a bounded CPU cost into an unbounded queue backlog.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Confirmed soft-delete replace + shell-sync / build-async on a `ProgramImportJob`** (chosen) | Reuses three in-tree precedents whole; the destructive act stays inside the authorized request; the client lands immediately; tombstones reach offline clients | Two API breaks in one release; a new model and migration; replaced subtrees accumulate until the retention purge |
| B. Keep it synchronous, add only the `replace` confirmation | One API break instead of two; smallest diff | Leaves #2574 entirely — a 100k-node import still 504s mid-transaction with no job to poll |
| C. Async everything, including the replace; nullable `program` FK on the job | Request is uniformly trivial | TOCTOU between the 409 and the delete; nullable FK leaks through serializer, drain and purge; the status endpoint cannot be program-scoped, losing the IDOR guard; nowhere to land the user |
| D. Reuse `CsvImportRequest` / `msproject.ImportRequest` | No new model or migration | Both are `project`-FK-scoped and a seed import has no project at request time; forces the existing drains to branch on source — the exact coupling ADR-0259 and ADR-0632 refused |
| E. Make re-import additive/merge, like MSP and CSV | Never destroys anything | The seed schema carries no stable entity ids until 0.5 (#1959), so a merge has nothing to key on. Wipe-and-rebuild is correct for this format — the defect is doing it unasked and unrecoverably |
| F. Keep projects attached to the soft-deleted program instead of detaching | Preserves the grouping for a future program-level undo | `ProjectViewSet.restore` would resurrect a project under a tombstoned parent. Revisit if program-level Trash ships |

## Consequences

**Easier**

- A re-import onto a live slug is answerable *before* it is destructive: the dry run
  names what would be replaced, and the import refuses without explicit consent.
- The replaced projects are recoverable from Trash for the retention window, and offline
  clients receive real tombstones instead of silently retaining phantoms.
- A large import no longer 504s; the caller gets a job id and a landing page.
- Batching plus `coalesce_sync_seq` removes the great majority of round-trips on the hot
  path, and the seed importer's write shape now matches the MSP and CSV importers.
- `ProgramImportJob` mirrors `ProgramExportJob` closely enough that the drain, purge,
  retry, and status-polling code are a second instance of a reviewed pattern rather than
  new machinery.

**Harder**

- Two breaking API changes at once (`201 → 202`, and a new `409`), touching
  `useImportProgramSeed`, `ImportProgramButton`, `ImportProjectModal`, both E2E specs,
  and `docs/api/openapi.json`.
- The importer must adopt a pre-created program rather than always minting one.
- `manage.py import_seed` must pass `replace=True` explicitly, or `make seed` starts
  refusing on its second run. A `--no-replace` flag is added for symmetry: a human at a
  shell with `--check` available is a different consent surface than an HTTP client.
- Non-sample re-imports now leave soft-deleted subtrees behind until the project
  retention purge, where they previously left nothing. That is the price of
  recoverability.
- Batched inserts hand-maintain three invariants (`server_version`, `sync_seq`, history
  rows) that `save()` maintained for free. A regression there is invisible until a mobile
  client loses rows, so the batch carries a dedicated test asserting all three plus the
  backdated `history_date` under v2 replay.

**Risks**

- *An operator reads "moves to Trash" as "the program is recoverable."* It is not. There
  is no program Trash and no program restore endpoint, and `Program` carries no
  `deleted_at` / `deleted_by` columns to build one on. Only the **projects** are
  recoverable, and they return as **standalone** projects, not regrouped under the old
  program. The 409 copy, the user docs, and the changelog must say this in those words.
  The program-Trash gap is filed as follow-up #2587.
- *`delete_program_cascade` already loses the program tombstone* by soft-deleting the
  memberships the sync accessible-set depends on. This ADR's path avoids it by keeping
  memberships live; the pre-existing defect on `DELETE /programs/{id}/` is filed as
  follow-up #2588 rather than fixed here.
- *The seed path never ran the ADR-0259 `validate_task_graph` guard*, so a hand-edited
  seed can write a cyclic dependency graph straight into CPM. Pre-existing, orthogonal to
  both issues, and filed as follow-up #2589 — batching the `Dependency` writes makes this
  call site structurally identical to the MSP and CSV ones, so the guard drops in cleanly
  there.
- *A duplicate delivery double-builds the subtree.* Mitigated by the claim (decision 11);
  the failure mode if the claim regresses is silent duplication rather than an error, so
  the claim carries its own test.

## Implementation Notes

- **P3M layer:** Programs and Projects.
- **Affected packages:** api, web, docs.
- **Migration required:** yes — one migration adding `ProgramImportJob`
  (`programs_import_job`) with `(program, status, created_at)` and `(expires_at)`
  indexes mirroring `ProgramExportJob`. No change to any existing model; the `Program`
  and `Project` soft-delete columns already exist.
- **API changes:** yes.
  - `POST /api/v1/programs/import/` — `201 ProgramSerializer` → `202 {"queued",
    "program_id", "import_request_id"}`; new `replace` / `expected_program_id` request
    fields; new `409 {"detail", "code": "seed_replace_required", "conflict": {…}}`.
  - `POST /api/v1/programs/import/validate/` — response gains `replaces`.
  - `GET /api/v1/programs/{pk}/import/jobs/{job_id}/` — new; mirrors
    `export/jobs/{job_id}`.
  - `POST /api/v1/programs/load-sample/` — unchanged.
  - `_read_seed_payload` enforces `SEED_MAX_UPLOAD_MB` on the JSON-body branch too.
- **RBAC:** unchanged and deliberate. `import`, `import/validate`, and the new status
  endpoint stay `IsAuthenticated`, at parity with program `create` (#1957). The replace
  can only touch programs on which the caller holds a live OWNER `ProgramMembership`
  (#994); the status endpoint is program-scoped through `get_object()`, so a `job_id`
  from another program 404s.
- **OSS or Enterprise:** OSS.

### Durable Execution

1. **Broker-down behavior:** transactional outbox. The `ProgramImportJob` row and the
   stored payload commit with the request; `run_program_import.delay()` is attempted in
   `transaction.on_commit` and broker errors are swallowed to a warning. Never a bare
   `.delay()` at the view layer.
2. **Drain task:** new — `projects.drain_program_imports`, every 30 s, under
   `@idempotent_task(on_contention="skip")`. Not a reuse of `drain_program_exports`: same
   shape, different table and different terminal semantics, and ADR-0259/ADR-0632 both
   hold that a drain must not branch on source.
3. **Orphan window:** 10 minutes on `created_at` for `pending` rows with an empty
   `celery_task_id`, matching the export drain. Rows inside an open `on_commit` callback
   are invisible until commit, so the drain must not race them.
4. **Service layer:** new — `projects.services.enqueue_program_import`, the sibling of
   `enqueue_program_export`. `.delay()` is called only from there and from the drain.
   Replacement goes through `access.services.soft_delete_program_subtree`, and
   per-project soft delete through the extracted `soft_delete_project`.
5. **API response on best-effort dispatch:** `202 {"queued": true, "program_id": "<uuid>",
   "import_request_id": "<uuid>"}`. No `celery_task_id` — none exists at serialization
   time under the outbox pattern.
6. **Outbox cleanup:** a dedicated nightly `purge_expired_program_imports` beat task
   deletes each terminal row **and** its stored payload file once `expires_at` passes,
   using the `TRUEPPM_IMPORT_RETENTION_DAYS` window (7 days). It is *not* registered in
   `observability/purge_registry.py`: that registry holds one spec per retention key for
   the ADR-0173 coordinator, `TRUEPPM_IMPORT_RETENTION_DAYS` is already claimed there by
   the MS Project import outbox, and a second spec under the same key would be shadowed.
   This mirrors `purge_expired_program_exports`, which is likewise beat-driven and
   unregistered.
7. **Idempotency:** the job row PK is the key; `run_program_import` claims it under
   `select_for_update` and no-ops unless `pending`/`running`. Necessary rather than
   decorative — after decision 4 the worker is purely additive and a duplicate delivery
   would double the whole subtree.
8. **Dead-letter / failure handling:** `max_retries=3` with exponential backoff for
   transient faults. Validation and referential failures never retry — they are
   deterministic, and the request already rejected them synchronously. On exhaustion the
   job goes `failed` with `error_detail` and the program shell is left in place, empty
   and visibly failed, so the Owner can delete it or retry. It is deliberately **not**
   auto-deleted: the replaced subtree is in Trash, and the operator needs the failed job
   row to reason about what happened.
