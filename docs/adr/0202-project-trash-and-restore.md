# ADR-0202: Trash + Restore for soft-deleted projects

## Status
Accepted

## Context

VoC Option C, part 2 of 3 (follows #1111 correct cascade, #1114 retention purge;
pairs with #1115 audit/notify). The deletion-semantics panel (avg 3.1/10, six 🔴)
was unanimous that **no recovery path is a dealbreaker**: Sarah fat-fingers delete on
a job-site phone; David runs 8–12 PMs so mistaken deletes are inevitable; Morgan/Alex
insist erasing a team's whole project must be reversible.

#1111 made project soft-delete *correct* — `Project.soft_delete()` tombstones the
project row synchronously and `cascade_project_children_soft_delete()` tombstones
tasks, dependency edges, sprints, and baselines via bulk `update()`+`F()` version
bumps, plus risks per-row so the `risk_changed` signal fires. That cascade runs in a
background Celery task after commit. #1114 added the retention window
(`TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS`, default 30) and a purge that
hard-deletes projects whose `deleted_at` is older than the window.

This ADR adds **recoverability on top**: a Trash list of recently-deleted projects,
a per-project **Restore** that un-tombstones the project *and its children in
lockstep*, and an inline "Deleted — Undo" toast at the moment of a soft delete.

**P3M layer:** Programs and Projects (single project + its children). Pure OSS — a PM
recovering their own program is core adoption, not cross-program governance.

## Decision

### 1. `POST /projects/{id}/restore/` — Owner-gated, atomic, synchronous

A new `restore` action on `ProjectViewSet`:

- **Re-scopes the queryset.** `ProjectScopedViewSet.get_queryset()` filters Project to
  `is_deleted=False`, so restore/trash use a dedicated membership-scoped,
  `is_deleted=True` lookup that bypasses that filter. `IsProjectOwner.has_object_permission`
  keys off `ProjectMembership(is_deleted=False)`, which survives a project soft-delete,
  so Owner gating still resolves on a tombstoned project.
- **Atomic.** Unlike the delete cascade (offloaded to Celery for up to ~24k
  round-trips), restore runs **synchronously inside a single `transaction.atomic()`
  block** in the request. The issue's hard requirement is "half-restore must fail
  atomically, never leave a partial state"; restore is a rare, deliberate action, so we
  pay the synchronous cost to guarantee all-or-nothing. `ATOMIC_REQUESTS` already wraps
  the request, but the explicit `atomic()` documents intent and bounds the savepoint.
- **Bumps `server_version` on every restored row** so the offline sync pull moves each
  row out of its `deleted` tombstone bucket and back into `updated` (live) — verified
  against `ProjectSyncView._collect` (rows split live/deleted purely on `is_deleted` at
  read time, gated by `server_version__gt=since`).
- **Broadcasts `project_restored`** on commit (new entry in `FROZEN_WS_EVENT_TYPES`).
- **Records a `project_restored` audit event** (`AuditEventType.PROJECT_RESTORED`).

### 2. Child restore rule — `cascade_project_children_restore()`

The inverse of `cascade_project_children_soft_delete`, run **synchronously** in the
restore transaction (not Celery):

- **Tasks / sprints / baselines**: bulk `update(is_deleted=False,
  server_version=F+1, deleted_version=None, deleted_at=None)` filtered to the project's
  currently-tombstoned rows. Mirrors the delete cascade's bulk+`F()` version bump.
- **Dependency edges** — restore only edges whose **both** endpoints are live *after
  the project's own tasks are restored*: `Q(predecessor__project=p)|Q(successor__project=p),
  is_deleted=True, predecessor__is_deleted=False, successor__is_deleted=False`. This keeps
  a cross-project edge tombstoned while its other project is still trashed (it resurrects
  naturally when *that* project is later restored). Additionally **exclude** any
  tombstoned edge that would collide with an already-live duplicate on the *non-partial*
  `unique_dependency (predecessor, successor, dep_type)` constraint — otherwise
  un-tombstoning would raise `IntegrityError`. The live row is authoritative; the stale
  tombstone is left as-is.
- **Risks** — per-row `.restore()` so `Risk.save()` re-fires
  `risk_changed(action="saved")` (the OSS extension point for the Enterprise portfolio
  risk rollup), exactly as the delete cascade uses per-row `soft_delete()` to fire the
  `deleted` signal. A bulk update would silently skip the signal.

New `VersionedModel.restore()` is the symmetric inverse of `soft_delete()`: clears
`is_deleted` + the `deleted_version` GC marker and bumps `server_version` via `save()`.
`Project.restore()` also clears `deleted_at`.

### 3. Which children get restored: **all currently-tombstoned children** (accepted tradeoff)

`server_version`/`deleted_version` are **per-row** counters (each row's own, starting at
1), not a global clock — there is no cross-row temporal marker except `deleted_at`
wall-clock, and only Task/Dependency/Project carry `deleted_at` (Sprint/Baseline/Risk do
not). An *exact* inverse ("restore only children the cascade tombstoned, not children the
user individually deleted earlier") is therefore not cleanly expressible without a new
per-delete batch-id column on every child model.

We restore **all** currently-`is_deleted=True` children of the project. Rationale: once a
project is tombstoned it is invisible and hard write-locked, so no child can be
independently deleted while it sits in Trash; the tombstoned set at restore time is the
cascade set plus at most any child the user individually deleted *before* the project
delete. Erring toward completeness matches David's "half-restore is worse than none." The
narrow edge (a pre-delete individual deletion reappears on restore) is accepted; an exact
per-batch marker is a deferred follow-up if it ever bites.

### 4. Frontend

- **Trash page** at `/settings/trash` (Workspace scope): lists the caller's soft-deleted
  projects within the retention window (name, code, deleted-by, deleted-at,
  days-remaining), each with a **Restore** action and an empty state. Mobile-responsive.
- **"Move to Trash" (soft delete)** added as a recoverable LifecycleCard on the project
  Lifecycle settings page — the reversible default, sitting *alongside* (not replacing)
  the existing type-to-confirm permanent-delete critical zone. Keeps the Gmail/Jira
  pattern: soft delete → Trash → optional permanent escalation. Deliberately does **not**
  touch the existing hard-delete flow (or its e2e), avoiding a regression.
- **"Deleted — Undo" toast** right after a soft delete: the toast store gains an optional
  `action { label, onClick }`; Undo calls `restore`. Mobile-reachable by construction
  (bottom-center toast host).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Restore async in Celery (mirror delete) | Fast request, no long lock | Cannot guarantee atomic all-or-nothing across the request boundary — violates the issue's hard requirement |
| `deleted_at`-window matching for exact inverse | Precise re-attach | Impossible for Sprint/Baseline/Risk (no `deleted_at`); per-row wall-clock races; complex |
| New `deletion_batch` FK/UUID column on every child | Exact inverse, future-proof | Migration across 5+ models for a rare edge; heavy for the value |
| Reframe existing delete → soft (single delete button) | One mental model | Breaks the shipped permanent-delete e2e + type-to-confirm flow; larger blast radius |

## Consequences

- **Easier:** every persona gets a reversible delete; sync clients re-materialize a
  restored project automatically via the `server_version` bump; the audit trail records
  restores.
- **Harder:** restore holds a transaction over the whole child set — a pathological
  project (many thousands of tasks/edges) restores slower than it deletes. Acceptable
  given restore rarity; a batched/async restore is a future option if it bites.
- **Risks:** the "all tombstoned children" rule can resurrect a pre-delete individual
  deletion (documented, accepted). Cross-project edge liveness and the non-partial
  `unique_dependency` collision are handled explicitly.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api, web
- Migration required: yes — additive `AuditEventType.PROJECT_RESTORED` (choices metadata
  `AlterField`); no new columns, no data migration.
- API changes: yes — `POST /projects/{id}/restore/`, `GET /projects/trash/`, new
  `project_restored` WS event.
- OSS or Enterprise: **OSS** (`trueppm/trueppm-suite`). No cross-program/portfolio scope.

### Durable Execution
1. **Broker-down behaviour:** N/A for the restore mutation itself — restore does its DB
   work synchronously in-request (no Celery dispatch), so there is no outbox gap. The
   only async side effect is the best-effort `project_restored` WS broadcast, deferred
   via `transaction.on_commit`; if the channel layer is down the event is dropped and
   clients recover on their next sync delta (same contract as `project_deleted`).
2. **Drain task:** N/A — no Celery work is enqueued by restore.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** restore logic lives in `cascade_project_children_restore()`
   (models.py) + the viewset action; no new dispatch service needed (deliberately does
   NOT mirror `enqueue_project_cascade_soft_delete` — restore is synchronous by design).
5. **API response:** synchronous `200` with the restored `ProjectSerializer` body (not
   `202 {"queued":true}`) — the work is done when the response returns.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** restore is idempotent — every child pass filters `is_deleted=True`,
   so a re-run (double-click, retry) touches only still-tombstoned rows and is a no-op
   that bumps no versions. Restoring an already-live project is a 200 no-op.
8. **Dead-letter / failure handling:** any failure inside the atomic block rolls the
   whole restore back (all-or-nothing); the client sees a 4xx/5xx and can retry safely.
