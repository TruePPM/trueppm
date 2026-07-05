# ADR-0219: Richer asynchronous project export bundle

## Status
Accepted

## Context
Issue #967 (ADR-0109 addendum) shipped a **synchronous** single-project export:
`GET /api/v1/projects/{id}/export/` returns the canonical JSON seed built from
`seed.exporter.export_project` + `dump_seed`. That closed the dead-control
anti-pattern and delivered the portability / no-lock-in value (VoC: Marcus 🟢,
Sarah 🟢) with a small change.

Issue #1266 tracks the deferred, **richer** bundle: beyond the JSON seed, a PM/team
needs their whole project as a portable archive — the schedule in an MS-Project-openable
format, every task attachment binary, all logged time entries, and the change/audit
history. Assembling that (zip of JSON + XML + blobs + history) is heavy and unbounded in
size, so it cannot run on the request thread; it must be an asynchronous job with a
poll/download lifecycle.

TruePPM already has exactly this pattern: ADR-0174/#641 shipped the **workspace** async
export (`WorkspaceExportJob` + `enqueue_workspace_export` + `run_workspace_export` +
drain + nightly purge + authenticated download). This ADR mirrors that pattern at the
**project** grain rather than inventing a parallel mechanism.

**P3M layer**: Programs and Projects → **OSS**. This is per-project data portability for
one PM/team. It does **not** aggregate across projects/programs (that upward move is the
Enterprise line), so it stays Apache 2.0. `grep -r "trueppm_enterprise" packages/` stays
empty.

VoC (6.7/10, no 🔴): 🟢 portability/no-lock-in (Marcus/Sarah/Omar); 🟢 audit-log-in-bundle
feeds Marcus's evidence path; 🟡 `.mpp` binary not writable by MPXJ; 🟡 retention must be
operator-configurable and documented.

## Decision

### Job model
Add `ProjectExportJob` to `packages/api/src/trueppm_api/apps/projects/models.py`,
mirroring `WorkspaceExportJob`'s status/timestamp/file shape but adding
`project = ForeignKey(Project, on_delete=CASCADE, related_name="export_jobs")`. It is a
plain `models.Model` (server-side bookkeeping, **not** a mobile-offline `VersionedModel`).

A **local** `ExportJobStatus` `TextChoices` (pending/running/success/failed) is defined in
`projects.models` rather than importing `workspace.models.ExportJobStatus`. The dependency
direction is one-way `workspace → projects` (workspace already imports Project); importing
back the other way would create a circular import. The four-value enum is trivially
duplicated; the cost of a circular-import risk is not worth the DRY saving. Indexes mirror
workspace: `(project, status, created_at)` for the per-project drain scan and
`(expires_at)` for the purge scan.

### Endpoints (all `@action` on `ProjectViewSet`)
- **`POST /api/v1/projects/{id}/export/`** — enqueue an async bundle build; returns
  `202` + the serialized job. The **existing** `GET /api/v1/projects/{id}/export/`
  (synchronous JSON seed) is kept unchanged for back-compat — the method split (GET=sync
  JSON, POST=async bundle) is deliberate and additive.
- **`GET /api/v1/projects/{id}/export/jobs/`** — list this project's recent export jobs
  (page-number envelope).
- **`GET /api/v1/projects/{id}/export/jobs/{job_id}/`** — poll one job's status.
- **`GET /api/v1/projects/{id}/export/jobs/{job_id}/download/`** — authenticated
  `FileResponse` of the archive; `409` if not ready, `410 Gone` once expired. The archive
  is **never** served from a raw, unauthenticated storage URL — it contains the whole
  project including audit history.

### RBAC
The sync JSON export is any-member (Viewer+, #967). The async bundle is gated at
**`IsProjectAdmin` (Admin+)** — a deliberate step up — because it aggregates data a Viewer
should not necessarily be able to bulk-exfiltrate in one archive: the **full audit/change
history**, **every member's time entries**, and **all attachment binaries**. Admin+ is the
role that already governs project membership and settings, so authorizing a full-project
data extract fits that tier. Enqueue, list, poll, and download all share the Admin+ gate;
the job list/download is additionally scoped to the job's own project (object-level: the
`{job_id}` must belong to `{id}`), preventing IDOR across projects. Like the sync export,
these actions skip `IsProjectNotArchived` — portability must remain available for
archival/forensics on archived projects.

### AI-agent actor constraint (ADR-0112)
A `mcp:read` API token is confined to safe methods and cannot reach `POST .../export/`
(the existing `mcp_token_guards()` on `ProjectViewSet` already blocks write methods for
tokens). An agent therefore cannot exceed its provisioning human's role, and every enqueue
is recorded by the `ProjectExportJob` row itself (`requested_by` + `created_at` +
`project`) — the audit record of who triggered the export. Poll/download are safe methods
but still require Admin+ *and* the token scope, so an agent never bulk-exfiltrates beyond
its human's project role. No cross-app write into the workspace-admin `AuditEvent` log
(it is workspace-grained, and using it would invert the `workspace → projects` import
direction).

### Bundle format (`.tar.gz`, mirrors workspace)
Assembled by a new `projects/export_bundle.py::build_and_store_project_archive(job_id)`,
streaming each part to a `SpooledTemporaryFile`/tar so peak memory is one row + gzip
window (history tables are unbounded):
- `manifest.json` — archive version, generated_at, project id/code/name.
- `seed.json` — canonical JSON seed (`dump_seed(export_project(project))`).
- `msproject.xml` — MS Project XML (MSPDI) via `export_project_xml(project_id)`.
- `attachments/<attachment_id>/<filename>` + `attachments/index.json` — task attachment
  binaries for the project's tasks (missing blob → metadata-only, does not abort).
- `time_entries.json` — `TimeEntry` rows for the project's tasks.
- `history/{tasks,dependencies,risks,sprints}.json` and `history/project.json` —
  django-simple-history rows filtered to this project.
- `counts.json` — per-member row counts.

Archive filename: `project-<code-or-id>.tar.gz`.

### `.mpp` — honest degradation
The bundle's "MS Project" artifact is **MS Project XML (MSPDI)**, not the proprietary
binary `.mpp`. The codebase's MPXJ integration **reads** `.mpp` (import) but MPXJ cannot
**write** the binary `.mpp` format — it emits MSPDI XML, which MS Project opens natively
and which already round-trips through our own importer. We ship `msproject.xml` and label
it plainly in the API docs and the web card ("MS Project XML — opens in MS Project"). No
fabrication of a fake `.mpp`. A binary-`.mpp` writer would require a different, heavier
toolchain; if a customer ever needs it, file a follow-up — it is out of scope here.

### Retention / expiry
Reuse the existing `TRUEPPM_EXPORT_RETENTION_DAYS` setting (shared with workspace export,
default 7; `None` disables purge). `run_project_export` stamps `expires_at` on success; a
nightly `purge_expired_project_exports` deletes rows past expiry and their stored files; a
30-second `drain_project_exports` re-dispatches jobs orphaned by a broker outage at
`on_commit`. Documented as an operator knob in Helm values + `docs/administration/`.

### Broadcast
No WebSocket broadcast. `ProjectExportJob` is not a board-scoped collaborative resource;
the web card **polls** the job endpoint (2 s interval, backed off) until terminal.
`broadcast-check` is N/A here.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. New `ProjectExportJob` mirroring `WorkspaceExportJob` (chosen)** | Clean per-project FK + object-scoping; proven pattern; no cross-app coupling | ~4-value enum duplicated |
| B. Generalize `WorkspaceExportJob` to a polymorphic `ExportJob(scope_type, scope_id)` | One model | `WorkspaceExportJob` is Owner/singleton-bound (ADR-0174) with no project FK; retrofitting it risks the workspace flow and forces `projects → workspace` import direction |
| C. Make the async build synchronous with a bigger timeout | No job model | Blocks the request thread; unbounded archive size; fails Omar's ops bar and #1266's premise |
| D. Ship a real binary `.mpp` | Double-click file | No Apache-2.0-compatible writer in-tree (MPXJ is read-only for `.mpp`); would fabricate or add a heavy Java writer toolchain |

## Consequences
- **Easier**: a PM/team gets a complete, portable project archive (schedule + files +
  timesheets + history) off the request thread; the pattern is identical to workspace
  export, so operators reason about one retention/drain/purge model.
- **Harder**: a second export-job lifecycle to keep in step with the workspace one
  (mitigated by mirroring names/structure and sharing the retention setting).
- **Risks**: (1) large archives on disk if retention is misconfigured — mitigated by the
  documented `TRUEPPM_EXPORT_RETENTION_DAYS` knob + nightly purge; (2) `.mpp`-expecting
  users seeing `.xml` — mitigated by explicit labeling; (3) attachment blob drift —
  mitigated by metadata-only degradation (never aborts the build).

## Implementation Notes
- P3M layer: **Programs and Projects** (OSS).
- Affected packages: `api` (model, migration 0108, service, tasks, views, urls,
  serializers, settings/beat), `web` (Export project card async state), docs.
- Migration required: **yes** — `0108` adds `ProjectExportJob` (projects app).
- API changes: **yes** — one new POST + three new GET actions (above).
- OSS or Enterprise: **OSS** (`trueppm-suite`).

### Durable Execution
1. **Broker-down behaviour**: Transactional outbox (ADR-0080). `enqueue_project_export`
   creates the `pending` row atomically with the request, then attempts
   `run_project_export.delay()` inside `transaction.on_commit`; broker errors are
   swallowed because the drain re-dispatches. `.delay()` is only ever called from the
   service and the drain.
2. **Drain task**: **New** — `drain_project_exports` (Beat, every 30 s,
   `@idempotent_task(on_contention="skip")`). Semantics differ from
   `drain_workspace_exports` only in the model queried, so a separate drain (not reuse) is
   correct.
3. **Orphan window**: 5 minutes — a `pending` row with `celery_task_id == ""` older than
   5 min is considered orphaned and re-dispatched (matches workspace export).
4. **Service layer**: **New** `projects/services.py::enqueue_project_export(*, project, requested_by)`.
5. **API response on best-effort dispatch**: `202 Accepted` with the serialized job
   (`{id, status: "pending", ...}`) — the caller polls `.../jobs/{job_id}/`.
6. **Outbox cleanup**: `purge_expired_project_exports` nightly deletes rows past
   `expires_at` and their stored files; retention `TRUEPPM_EXPORT_RETENTION_DAYS` (default
   7 days). De-dupe: an in-flight `pending`/`running` job for the same project is returned
   rather than minting a second build.
7. **Idempotency**: `run_project_export` claims the job under `select_for_update` and
   no-ops unless it is `pending`/`running`, so a duplicate delivery (broker retry, drain
   re-dispatch) cannot produce two archives.
8. **Dead-letter / failure handling**: `max_retries=3` with exponential backoff; on
   exhaustion the job is set `failed` with a truncated `error_detail`, surfaced on the web
   card so an Admin can request a fresh export. No separate DLQ table — the `failed` job
   row *is* the human-actionable record.
