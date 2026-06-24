# ADR-0092: Import a project from a file (create-from-import)

## Status
Accepted

## Context
TruePPM already imports MS Project files (MSPDI XML, and `.mpp` via MPXJ) **into an
existing project** (ADR-0021): `POST /projects/{pk}/import/msproject/`, async via the
`ImportRequest` outbox + Celery, Admin-gated. That surface is API-only and assumes a
project already exists.

The strongest adoption wedge for the PM (Sarah) and PMO (Marcus) personas is
"migrate off MS Project" — and a migrator does not have a TruePPM project yet; they
have a *file*. They need to **create** a project *from* the file, reachable from the
places a project is normally started: the New Project flow and Program settings.

A Voice-of-Customer panel (avg 5.1/10 — a persona-fit artifact; the agile/portfolio
personas score a waterfall-WBS import low for irrelevance, while the target migrators
Sarah 6 and Marcus 7 are positive) surfaced three binding constraints:

- 🔴 **Janet:** a silent async import ("project appears, tasks maybe populate later")
  is a board-meeting ambush. There must be a **terminal success/failure state + a
  post-import summary**.
- 🟡 **`.mpp` friction** (most-cited): most real files are `.mpp`, which stays
  unsupported (#128). The UI must *tell the user how to get an `.xml`*, not just block.
- 🟡 **Marcus:** an **audit record** of who imported what file, when, and the outcome.

**P3M layer:** Programs and Projects → **OSS**. Single-project migration on-ramp; no
cross-project aggregation. `grep -r trueppm_enterprise packages/` stays clean.

## Decision
Add a dedicated **create-from-import** endpoint rather than asking the client to create
a blank project and then import into it.

`POST /api/v1/projects/import/msproject/` (custom path in `msproject/urls.py`, mounted
before the router so it cannot collide with `/projects/{pk}/…`). Multipart body:
`file` (required), `program` (optional UUID).

**Transactional sequence** (no nullable FK, no orphan-on-parse-failure):
1. Validate extension (`.xml`; `.mpp` only if MPXJ present) + size (`MSPROJECT_MAX_UPLOAD_MB`).
   If `program` is set, the `ProjectSerializer` create-path gate (ADR-0070) requires the
   caller to be **program ROLE_ADMIN+**. Any authenticated user may create a standalone
   project (becomes Owner) — identical to the normal create path.
2. In one `transaction.atomic()`: create the **Project shell** via `ProjectSerializer`
   (name derived from the filename, `start_date` = today as a placeholder, `program`
   set, calendar defaulted by the normal create path) → create the Owner
   `ProjectMembership` → create `ImportRequest(project=shell, creates_project=True, …)`.
3. `transaction.on_commit(lambda: enqueue_import(req_id))` — the existing outbox/drain
   path, unchanged.
4. Response **`202 {"queued": true, "project_id": "<uuid>", "import_request_id": "<uuid>"}`**.
   The client navigates straight to the new project.
5. The worker parses, **overwrites `Project.name` + `start_date` from the file header**,
   bulk-imports tasks/deps/resources/assignments, records the summary, marks the row DONE.

**`creates_project` flag** (new boolean on `ImportRequest`, default `False`): when set,
the import task **wipes any pre-existing tasks for the project before bulk-create**, so a
re-dispatch (orphan-drain recovery of a task that died mid-import) is idempotent —
wipe-then-import is safe precisely because the shell was created empty *for this import*.
The existing import-into-existing-project path leaves the flag `False` and stays additive
(unchanged behavior).

**Terminal state + summary (resolves Janet's 🔴) — reuses existing infra, no new model:**
Progress and terminal state already flow through `TaskRun` (ADR-0020): status
SUCCESS/FAILED, `result_summary` JSON, WebSocket broadcast on `project_{pk}`. The
importer summary is extended with `task_count` and `project_start_date`. The client lands
on the new project showing an "Importing…" state, then a success summary or a failure
card (Retry / Delete) driven by the `TaskRun`.

**Parse failure is terminal (benefits both endpoints):** a deterministic parse/validation
error marks `TaskRun` FAILED **and `ImportRequest` DEAD**, so the orphan drain (which only
re-dispatches stale DISPATCHED rows) does not retry a bad file forever. Infrastructure
errors (broker, timeout, transient DB) leave the row DISPATCHED for the existing
drain/retry path.

**Audit (Marcus 🟡):** the `ImportRequest` row (`initiated_by`, `filename`,
`requested_at`, `status`) is the durable who/what/when/outcome record, surfaced via an
optional `GET /projects/{pk}/imports/` provenance list (#799). 7-day retention (existing
purge); the enterprise audit overlay can consume the history signal for longer retention.

**Format picker is purely client-side gating.** The UI offers `TruePPM` (disabled,
"coming soon") and `MS Project` (enabled); under MS Project, `.xml` is enabled and
`.mpp`/`.mpx` are disabled with inline "Save As → XML from MS Project" guidance
(→ #128/#120). The server stays authoritative on extension (`.xml`, and `.mpp` if MPXJ is
present — same as the existing endpoint).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A — dedicated create-from-import endpoint** (chosen) | One round-trip; non-nullable `ImportRequest.project` FK; file header defines name/dates; single RBAC + audit point | New endpoint + a boolean migration |
| B — client creates a blank project, then calls the existing per-project import | No new endpoint | Client must invent a name the file then contradicts; two round-trips; empty project persists if the second call never happens; the header's project name/dates are lost or fight the client's |
| Parse the whole file synchronously to name the project | Project fully named at once | Defeats async; a 50 MB file blocks the request thread; the parser has no header-only mode |

Chosen middle path: name the shell from the **filename** synchronously (fast), let the
worker refine `name`/`start_date` from the parsed header.

## Consequences
- **Easier:** migrating off MS Project is a first-class "new project" path; the async
  import has a trustworthy terminal state; bad files stop retrying forever (a latent bug
  fixed for the existing endpoint too).
- **Harder:** two import entry points now share the task — the `creates_project` flag must
  be threaded through `enqueue_import`, the drain, and the task signature.
- **Risks:** a create-from-import whose parse fails leaves a named, empty "import failed"
  shell — the UI offers Retry/Delete; no auto-delete (never destroy data implicitly). A
  transient failure mid-import is made safe by wipe-then-import on retry.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (msproject, projects), web
- Migration required: yes — `ImportRequest.creates_project` BooleanField, default `False`
- API changes: yes — `POST /projects/import/msproject/` (new); `GET /projects/{pk}/imports/` (provenance, #799)
- OSS or Enterprise: OSS
- Out of scope (separate issues): three-point/PERT extended-attribute mapping (#798,
  maps MSPDI Duration1–4 ↔ `Task.optimistic_duration/most_likely_duration/pessimistic_duration`);
  convert-to-backlog/sprint hybrid bridge (#372); cross-project resource conflict view (Enterprise);
  `.mpp` (#128) / `.mpx` (#120) backend support; live progress streaming (#61).

### Durable Execution
1. **Broker-down behaviour:** transactional outbox — `ImportRequest` row is committed
   atomically with the Project shell; dispatch is best-effort via
   `transaction.on_commit(enqueue_import)`; if the broker is down the row stays PENDING.
2. **Drain task:** reuses the existing `msproject.drain_import_queue` (every 30 s,
   `@idempotent_task(on_contention="skip")`) — semantics match exactly; it now also
   forwards `creates_project`.
3. **Orphan window:** reuses the existing 15-minute DISPATCHED cutoff (import
   `soft_time_limit` is 9 min). DEAD rows are skipped by the drain (terminal).
4. **Service layer:** reuses `msproject.services.enqueue_import` (extended to carry
   `creates_project`). The create-from-import view goes through it, never `.delay()`.
5. **API response on best-effort dispatch:** `202 {"queued": true, "project_id": …,
   "import_request_id": …}` — no synchronous task id.
6. **Outbox cleanup:** reuses `msproject.purge_old_import_requests` (nightly, 7-day
   retention via `TRUEPPM_IMPORT_RETENTION_DAYS`).
7. **Idempotency:** the create-from-import task is idempotent via `creates_project` —
   it wipes the project's tasks before bulk-create, so a duplicate execution converges
   to the same state. The view itself is creation (not idempotent across distinct
   uploads, by design — re-uploading a file creates a new project), so it is
   Idempotency-Key-exempt like the existing import (ADR-0170).
8. **Dead-letter / failure handling:** deterministic parse/validation errors →
   `ImportRequest` DEAD + `TaskRun` FAILED (terminal, no retry; user retries or deletes
   the shell). Infrastructure errors stay DISPATCHED for the drain to recover.
