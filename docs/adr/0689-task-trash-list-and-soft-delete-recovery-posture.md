# ADR-0689: Task trash list, and a declared recovery posture for every soft-deleting model

## Status

Accepted

## Context

`VersionedModel` gives every synced model `is_deleted` / `deleted_version`, and nearly
every DRF `destroy` path calls `soft_delete()` rather than a real delete. The flag's
original purpose was **offline sync tombstones** — so the sync delta can hand a mobile
client a tombstone instead of silently dropping a row — not user-facing recovery
(`projects/models.py`, `VersionedModel` docstring).

Trash (#1113, ADR-0202) was layered on top of that later, and only for `Project`. The
result reported in #2494 is a coverage gap between what the database retains and what a
user can reach:

| Entity | Soft-deletes | Restore endpoint | User-reachable recovery **before** this ADR |
|---|---|---|---|
| `Project` | yes | `POST /projects/{id}/restore/` | Full — `WorkspaceTrashPage`, 30-day window, Owner-gated |
| `Task` | yes | `POST /tasks/{id}/restore/` (#2078, ADR-0494) | **Undo toast only** — no durable list |
| `Resource` | yes | `POST /resources/{id}/restore/` | Full — see the correction below |
| `Label`, `Risk`, `Dependency`, `Baseline`, `TaskRelation`, `Sprint` | yes | — | None |

Two premises in the issue needed checking before deciding anything, and both moved:

1. **"Task tombstones are never purged" is wrong** (corrected on the issue itself).
   `sync.reap_domain_tombstones` (ADR-0197, #1321) runs nightly and hard-deletes `Task`,
   `Dependency`, `TaskRelation`, `Risk` and `Sprint` tombstones past
   `TRUEPPM_TOMBSTONE_RETENTION_DAYS` (default 90). Unbounded growth is therefore **not**
   a prerequisite for a task trash list — the window already exists, and this ADR adopts
   it as the task recovery window rather than inventing a second one.
2. **"`Resource` recovery has no web caller" is also wrong.** `ResourcesPage` carries a
   "Show deactivated" checkbox that sets `?include_deleted=true`, and selecting a
   deactivated resource renders a **Restore resource** button wired to
   `useRestoreResource` (`ResourceDetailPanel.tsx`). Resource is the one entity besides
   Project that was already whole. Nothing to build; it only needed documenting.

So the real remainder is: `Task` has an excellent restore endpoint reachable only from a
toast, and six models soft-delete with no stated position on whether that is recoverable.

The second problem is the more corrosive one. It is not that `Label` deletion is
irreversible — for a label that is a defensible product decision. It is that **nothing
says so**, anywhere, so each entity's answer has to be re-derived from `perform_destroy`
by someone reading the source. A soft delete that a user can never reverse is a
*tombstone*, and a tombstone is an implementation detail of sync. The bug is the silence,
not the irreversibility.

**P3M layer:** Programs and Projects — a single project's task set. No cross-project or
portfolio aggregation, so this is squarely OSS.

## Decision

### 1. `GET /api/v1/tasks/trash/?project=<uuid>`

A new read-only, project-scoped collection action on `TaskViewSet`, surfacing the
`_trashed_task_queryset()` that #2078 already built for `restore`.

- **`project` is required.** Omitting it is `400`, not "all your projects". The panel that
  consumes it opens from the Schedule/Board of one project, and a workspace-wide task
  trash would be a different (and much larger) surface.
- **Membership-scoped**, reusing `_trashed_task_queryset()` verbatim — so it inherits the
  exact non-leak guard `restore` is already tested against. A foreign project id returns
  an empty list rather than a 403, matching the existing existence-oracle posture.
- **Windowed on `TRUEPPM_TOMBSTONE_RETENTION_DAYS`**, read from settings the same way
  `reap_domain_tombstones` reads it — deliberately *not* through the ADR-0173
  `resolve_retention` coordinator, because the reaper does not consult the coordinator
  either. Reading a window the reaper does not honor would show users a countdown that
  does not predict the purge. (That divergence is a real defect; it is #2494's sibling
  finding and is tracked separately — this ADR refuses to paper over it by displaying a
  number sourced from the wrong system.)
- **Restore roots only.** Deleting a parent tombstones its `is_subtask=True` subtree, and
  `cascade_task_children_restore` brings the whole subtree back. Listing every descendant
  would present twelve rows for one delete, eleven of which are no-ops. A row is omitted
  when it is `is_subtask=True` **and** another tombstoned row in the same result set is a
  strict `wbs_path` ancestor. Each surviving row carries `subtree_count` so the user can
  see what comes back with it.
- **`can_restore` per row** is `can_user_edit_task(request, task, method="DELETE")` — the
  same predicate `IsProjectMemberWriteOrOwn` calls for the `restore` action (ADR-0133).
  One rule, called twice; the button's enablement cannot drift from the server's gate.
- **Capped at the 200 most recently deleted.** The response carries `truncated` so the
  panel can say so out loud. A silent cap on a recovery surface would read as "that task
  is gone" when it is not.

The response is a bare object `{results: [...], truncated: bool}` rather than the bare
array `/projects/trash/` returns — the truncation flag has nowhere to live in an array,
and this endpoint's list is the one that can actually hit a cap.

### 2. "Recently deleted" panel

`TaskTrashDialog` — a focus-trapped modal, structurally a sibling of `BaselineManagerModal`,
opened from two places that already exist:

- Schedule toolbar `···` (Project actions) → **Recently deleted…**
- Board toolbar `⋯ More` → **Recently deleted…**

It lists each restorable root with its WBS code, status, how long ago it was deleted, how
many days remain, and a **Restore** button wired to the existing `useRestoreTask`. Restore
is disabled with a reason when `can_restore` is false.

### 3. A declared recovery posture for every soft-deleting model

The deliverable is a **published table**, not code: `docs/administration/retention.md`
gains a "What you can get back" matrix that states, per entity, whether a delete is
reversible and for how long. Every entry is one of exactly two states — no entity may sit
between them:

| Entity | Posture | Why |
|---|---|---|
| `Project` | **Recoverable** — Settings → Workspace → Trash, 30 days, Owner | ADR-0202 |
| `Task` | **Recoverable** — Recently deleted, 90 days, delete-parity gate | This ADR |
| `Resource` | **Recoverable** — Resources → Show deactivated → Restore, indefinite | Deactivation, not deletion; never reaped |
| `Sprint` | **Not recoverable** — final from the UI | Only `PLANNED`/`CANCELLED` sprints may be deleted at all; an empty forward-looking container is cheap to recreate |
| `Baseline` | **Not recoverable** — final from the UI | Owner-gated, deliberate, and a baseline is a snapshot the user chose to discard |
| `Dependency`, `TaskRelation` | **Not recoverable individually** — but restored automatically with their task | `cascade_task_children_restore` re-links every edge whose endpoints are both live; a hand-deleted edge is two clicks to redraw |
| `Risk` | **Not recoverable** — final from the UI | |
| `Label` | **Not recoverable, and could not be** | `perform_destroy` hard-deletes the `TaskLabel` through-rows. Restoring the `Label` row would return an orphan attached to nothing — a faithful restore does not exist to expose |

"Not recoverable" is a statement about the **product surface**, not the database. The rows
still exist as tombstones for the sync window, because that is what tombstones are for.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Task trash list + declared posture for the rest** (chosen) | Closes the sharpest gap with an endpoint that is a list over an already-tested queryset; converts six undocumented entities into a decision on the record | Five entities stay unrecoverable — the decision is written down, not solved |
| B. Universal trash (one `/trash/` across every soft-deleting model) | One surface, one mental model | Explicitly out of scope per the issue. Needs a polymorphic list, a per-entity restore dispatcher, and a faithful restore for `Label` that cannot be written without also versioning `TaskLabel`. Large, and the payoff over A is `Risk` and `Baseline` |
| C. Task trash as a Project settings section | Mirrors `WorkspaceTrashPage`; near-zero new UI | Recovery lives two navigations from where the delete happened. The user who dismissed the toast is on the board, not in settings |
| D. Extend the Undo toast's lifetime | Trivial | A longer toast is still a toast. Reload and it is gone — the exact failure the issue reports |
| E. Give `Task` its own retention setting | Independent tuning of the recovery window | A second window over the same rows the 90-day reaper already governs. If they disagree, the countdown lies. Adopting the reaper's window is the only way the number shown is the number enforced |

## Consequences

**Easier**

- A task deleted more than one toast ago is recoverable from the surface it was deleted on.
- "Is this delete reversible?" is answerable from the docs for every entity, without
  reading `perform_destroy`.
- The restore-root collapsing means one delete reads as one recoverable item.

**Harder**

- Two recovery windows now exist and differ (Project 30 days via the ADR-0173 coordinator;
  Task 90 days via the ADR-0197 reaper). The docs must state both; they cannot be unified
  without moving the reaper onto the coordinator, which is out of scope here.
- The posture table is a doc that can rot. Any new `VersionedModel` with a `destroy` path
  must add a row. Called out in the "Before marking a feature complete" checklist.

**Risks**

- *A user reads "Recently deleted" as a full trash and expects risks/labels there.* The
  panel's title is scoped to tasks and its empty state says so; the docs table is the
  complete answer.
- *The 90-day countdown is wrong when an operator has disabled retention via the
  coordinator.* The reaper does not honor the coordinator's Off switch — a pre-existing
  defect, tracked separately. This ADR sources the countdown from the setting the reaper
  actually reads, so the displayed number matches enforced behavior in every case where
  the two systems agree, and is not made worse where they do not.
- *Tombstones inside an archived project are excluded by the reaper and retained
  indefinitely.* Those tasks appear in the list with an indefinite retention, which is
  accurate. Also tracked separately.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: `api`, `web`, `website` (docs)
- Migration required: **no** — no model change. `Task.deleted_at` and the
  `is_deleted`/`deleted_at` index already exist (ADR-0197)
- API changes: **yes** — one new read action, `GET /api/v1/tasks/trash/?project=<uuid>`.
  No change to any existing endpoint
- OSS or Enterprise: **OSS**

### Durable Execution

1. **Broker-down behaviour:** N/A for the new endpoint — `trash` is a pure read with no
   async side effects. The `restore` action it feeds already routes its CPM recalculation
   through `_enqueue_recalculate` (the ADR-0027 transactional outbox), unchanged here.
2. **Drain task:** Reuses the existing schedule-request drain via `_enqueue_recalculate`
   on the restore path. No new category of async work, so no new drain.
3. **Orphan window:** N/A — no new outbox rows are written by this change.
4. **Service layer:** Restore already goes through `scheduling/services.py::enqueue_recalculate`
   (via `_enqueue_recalculate`). The list action needs no service function; it is a
   queryset read in the viewset, mirroring `ProjectViewSet.trash`.
5. **API response on best-effort dispatch:** N/A — the list is synchronous `200`. `restore`
   returns the restored task synchronously (unchanged, ADR-0494).
6. **Outbox cleanup:** N/A — no new outbox rows. Tombstone cleanup is
   `sync.reap_domain_tombstones` (nightly, `TRUEPPM_TOMBSTONE_RETENTION_DAYS`, default 90),
   which this ADR adopts rather than adds to.
7. **Idempotency:** The list is a safe GET and trivially idempotent. `restore` is
   idempotent-by-404: a second restore of an already-live task falls out of
   `_trashed_task_queryset()` and returns 404 rather than re-applying (ADR-0494).
8. **Dead-letter / failure handling:** N/A for the read. Restore failures roll back inside
   a single `transaction.atomic()` and surface as a 4xx/5xx to the caller, which the panel
   renders inline on the row.
