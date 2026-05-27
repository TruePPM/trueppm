# ADR-0092: Workspace lifecycle endpoints (transfer ownership / export / delete)

## Status
Accepted

## Context
The workspace settings shell (ADR-0087) ships General / Members / Invites / Groups,
but the **Danger zone** (`WorkspaceDangerPage`) is a disabled stub: transfer-ownership,
full export, and delete were deferred from #530 because the workspace API app did not
exist yet. #791 disabled the dead buttons pending these endpoints (#641).

`Workspace` is a **singleton** config row (`singleton_key=1`, unique) materialized
lazily by `Workspace.load()` (`get_or_create(singleton_key=1)`). There is **no owner
FK** — ownership is `WorkspaceMembership.role == WorkspaceRole.OWNER` (ordinals
MEMBER=100/ADMIN=300/OWNER=400), guarded by the existing
`workspace/services.py::would_strand_workspace()` / `workspace_owner_user_ids()`. User
PKs are `int`. `WorkspaceMembership`/`Group` extend `VersionedModel`; `Workspace` is a
plain model.

**P3M layer:** Operations / Programs-and-Projects level workspace administration. A
single PM/team must be able to own, export, and tear down their own workspace without
Enterprise. **OSS.** (Cross-workspace governance, billing, org audit = Enterprise.)

## Decision

A new `IsWorkspaceOwner` permission (role == OWNER; superuser-with-no-row treated as
OWNER, matching the existing bootstrap in `permissions.py`) gates all three endpoints.
All carry `IdempotencyMixin` (ADR-0083), consistent with the other workspace views.

### 1. `POST /api/v1/workspace/transfer-ownership/`
Body `{"new_owner_user_id": <int>}`. Mirrors `ProjectViewSet.transfer`. Service
`transfer_workspace_ownership(new_owner, actor)`: inside `transaction.atomic()`,
`select_for_update()` the current OWNER row(s) and the target membership, demote
current OWNER(s) → ADMIN, promote target → OWNER, set `role_changed_at`, bump
`server_version`. Guards: target must be an existing **active** membership (404/400
otherwise); transferring to the sole existing owner is a 400 no-op. Promoting a new
owner never strands the workspace, so `would_strand_workspace()` is asserted only on
the demotion side. Returns `200` with the refreshed member list. No board broadcast
(workspace is not board-scoped).

### 2. `POST /api/v1/workspace/export/` — full async archive
Returns `202 {"job_id": "<uuid>", "status": "pending"}`.

- **Model** `WorkspaceExportJob` (new, migration `0003`): `id` UUID PK, `requested_by`
  FK→User `SET_NULL`, `status` (pending/running/success/failed, mirrors `TaskRunStatus`),
  `celery_task_id`, `file_path` (storage key), `file_size`, `expires_at`, `error_detail`,
  `created_at`/`started_at`/`completed_at`. Plain model (not synced).
- **Dispatch** `services.enqueue_workspace_export(requested_by)`: create the job row in
  `transaction.atomic()`, then `transaction.on_commit()` attempts
  `run_workspace_export.delay(job_id)`, swallowing broker errors (the drain re-dispatches).
- **Task** `run_workspace_export` (`@idempotent_task`, `on_contention="skip"`,
  `max_retries=3`, `soft_time_limit`/`time_limit` per ADR-0017): idempotency guard — no-op
  unless the job is `pending`/`running`. Builds a `.tar.gz` via
  `workspace/export.py::build_workspace_archive` (manifest + workspace.json + members +
  invites + groups + resources/skills + per-project {project, tasks, dependencies,
  baselines, time_entries, risks, sprints, history} + attachment files + programs), saves
  via `default_storage`, sets `status=success`, `expires_at=now+TRUEPPM_EXPORT_RETENTION_DAYS`,
  then best-effort emails the owner (plain text, links to the danger page — mirrors the
  invite email plumbing). On exhaustion: `status=failed` + `error_detail`; owner re-requests.
- **Drain** `drain_workspace_exports` (Beat 30 s, idempotent skip): re-dispatch `pending`
  jobs with no `celery_task_id` older than the 5-minute orphan window.
- **Purge** `purge_expired_exports` (nightly, idempotent skip): delete jobs past
  `expires_at` and their stored files. `TRUEPPM_EXPORT_RETENTION_DAYS` (default 7; `None`
  disables) — same convention as `TRUEPPM_IMPORT_RETENTION_DAYS`.
- **Status** `GET /api/v1/workspace/export/<job_id>/` → job serializer (Owner-only). The
  web client polls this for the queued → ready transition.
- **Download** `GET /api/v1/workspace/export/<job_id>/download/` → Owner-only; streams the
  archive via `FileResponse` when `status=success` and not expired; `410 Gone` if expired,
  `409` if not ready. We serve through an **authenticated** endpoint rather than handing out
  a raw `default_storage.url()` so the archive (which contains every project's data) is never
  exposed at an unauthenticated URL on `FileSystemStorage` deployments.

### 3. `DELETE /api/v1/workspace/` — hard delete (factory reset)
Added as `delete()` on the existing `WorkspaceSettingsView`. Owner-only. Requires a
typed-confirmation header **`X-Confirm-Workspace`** whose value must equal the current
`Workspace.name` exactly (case-sensitive); mismatch → `400`. `name` is always populated
(`subdomain` may be blank, so `name` is the confirmation phrase).

Because the workspace is a singleton that `Workspace.load()` re-materializes on next
access, **delete = purge all workspace-scoped data + delete the singleton row**; the next
request transparently recreates a fresh factory-default workspace. Service
`purge_workspace()` deletes inside one `transaction.atomic()` in FK-safe order:
GroupProject/GroupMembership/Group → WorkspaceInvite → WorkspaceMembership → (Project|Program)
memberships which are `PROTECT` → Projects (cascades tasks/deps/baselines/sprints/risks/
attachments/comments/etc.) → Programs → Resources/Skills → Calendars (`PROTECT`, after
projects) → `WorkspaceExportJob` → the `Workspace` row. Responds `204`. The web client
clears its tokens and redirects to login; on re-auth a fresh empty workspace materializes
(superuser → OWNER bootstrap; otherwise implicit member).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Delete: purge data but **keep & reset** the singleton row + retain owner membership | No re-bootstrap | Bespoke reset logic; `Workspace.load()` already makes row-delete safe; "all members lose access" not honored |
| Delete: delete the singleton **row** and let `load()` recreate | Matches existing singleton lifecycle; true factory reset; least code | Stale JWT authenticates into the fresh workspace until expiry (no blacklist app) — accepted for self-hosted |
| Export: synchronous (like MS Project XML) | Simplest | A full-workspace archive can be large/slow → request timeout; #641 explicitly wants async + email |
| Export: base64-in-task-kwargs (ADR-0021) | No storage needed | 10 MB cap unrealistic for a full archive; must persist for the email-link/download flow |
| Export download: raw `default_storage.url()` in the email | Zero endpoint code | Unauthenticated archive of all project data on FileSystemStorage — rejected on security grounds |

## Consequences
- **Easier:** the danger zone becomes functional; #791's disabled stubs are wired; the
  workspace gains a real backup/teardown story for self-hosting.
- **Harder:** a new async job category (export) adds a Beat drain + purge task and a
  storage dependency; the exporter must track the full workspace FK graph and stays in
  sync as models are added.
- **Risks:** (a) `DELETE` is irreversible mass deletion — mitigated by Owner-only +
  typed-confirmation header + single atomic transaction. (b) No server-side token
  revocation on delete (no blacklist app) — documented; follow-up if hardening is needed.
  (c) Export archive size/PII — Owner-only, authenticated download, link expiry, retention
  purge.

## Implementation Notes
- P3M layer: Operations / Programs-and-Projects (workspace administration)
- Affected packages: **api** (workspace app, settings Beat), **web** (`WorkspaceDangerPage`)
- Migration required: **yes** — `workspace/0003_workspaceexportjob`
- API changes: **yes** — 3 new endpoints + 2 export sub-routes (status, download)
- OSS or Enterprise: **OSS** (`grep -r trueppm_enterprise packages/` stays zero)

### Durable Execution
1. **Broker-down behaviour:** export uses the outbox-lite pattern — the `WorkspaceExportJob`
   row commits inside `transaction.atomic()`; `.delay()` is attempted in
   `transaction.on_commit()` with broker errors swallowed; `drain_workspace_exports`
   re-dispatches. Transfer and delete are **synchronous** (no async side effects).
2. **Drain task:** new `workspace.drain_workspace_exports`, Beat every 30 s,
   `@idempotent_task(on_contention="skip")`. (The existing `drain_invite_emails` covers
   only invite email, semantics differ, so a new drain is required.)
3. **Orphan window:** 5 minutes — drain ignores jobs `created_at >= now-5m`.
4. **Service layer:** `workspace/services.py` — new `transfer_workspace_ownership`,
   `enqueue_workspace_export`, `purge_workspace`. `.delay()` is only called from
   `enqueue_workspace_export` (and the drain).
5. **API response on best-effort dispatch:** `202 {"job_id", "status":"pending"}` — the job
   row is created synchronously so a real id is always returned (better than `{"queued":true}`).
6. **Outbox cleanup:** `workspace.purge_expired_exports`, nightly, deletes jobs past
   `expires_at` + files; `TRUEPPM_EXPORT_RETENTION_DAYS` default 7, `None` disables.
7. **Idempotency:** HTTP `Idempotency-Key` via `IdempotencyMixin`; the export **task** keys
   on the job-row PK and no-ops unless status is `pending`/`running` (safe under broker
   retry / manual re-queue). Transfer is naturally idempotent (target already OWNER → no-op).
8. **Dead-letter / failure handling:** `run_workspace_export` autoretries (`max_retries=3`,
   backoff); on exhaustion the job goes `status=failed` with `error_detail` surfaced via the
   status endpoint, and the owner can request a new export. No DLQ table — a failed export is
   self-service re-runnable, so silent discard of the row is not used.
