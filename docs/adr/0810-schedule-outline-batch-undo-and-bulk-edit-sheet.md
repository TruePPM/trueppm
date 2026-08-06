# ADR-0810: Schedule outline batch undo, and the bulk-edit sheet's write path

## Status
Accepted

## Context

Issue #2756 (deferred from #2727 / epic #2739, "Project Designer") bundles three pieces
the original design handoff's key table called for and #2727 explicitly scoped out:

1. **⌘Z undo stack** — template-apply, paste-many, cascade, and import-fix must each
   undo as a single step. Was blocked on paste-many (#2724); #2724 is now merged, so
   that blocker is clear.
2. **⌘⇧K bulk-edit sheet** — bulk-edit mode/phase/calendar/owner/dates across the
   multi-row selection #2727 already shipped. Was waiting on the bulk endpoint's
   per-row 207 shape and idempotent write path (#2723); #2723 is now merged.
3. **Timeline `Enter`-to-create parity** — relocating the Timeline's existing,
   tested `Enter` (open drawer, #2205, WCAG 2.1.1) and `Shift+Enter` (keyboard
   reschedule) bindings to make room for row-creation.

**Research findings that shape this decision:**

- **ADR-0776** (Accepted) already resolved the scope question for part 3: Enter-to-create
  was deliberately restricted to the Grid task list, and Timeline's existing bindings
  were left untouched because relocating tested, WCAG-load-bearing keyboard bindings
  was judged higher regression risk than the ask required. ADR-0776 explicitly deferred
  Timeline parity to a follow-up issue rather than deciding it in passing. Nothing in
  the two years — sorry, months — since has changed that calculus: `ScheduleAriaOverlay.tsx`
  still binds `Enter`→open-drawer and `Shift+Enter`→select-then-reschedule (the reschedule
  fires from a *document-level* listener that runs after the React handler in bubble
  order — a same-keystroke choreography the source comments explicitly warn not to
  reorder), and `ScheduleAriaOverlay.keyboard.test.tsx` pins exactly that interplay.
  Redesigning where "open drawer" and "reschedule" go once `Enter` is reassigned is an
  interaction-design decision, not an architecture decision — it needs `ux-design`
  before it needs `architect`.

- **No undo-stack ADR exists.** The codebase's only undo mechanism today is a
  single-slot, server-truth toast: `ScheduleActionToastRenderer` shows one live
  "Undo" affordance at a time (delete, duplicate, paste-many receipt), replaced by
  whatever fires next. `useRestoreTask`/`useBulkRestoreTasks` in `useTaskMutations.ts`
  call `POST /tasks/{id}/restore/` — the *server* un-tombstones the subtree; the
  client never replays state. This is the right precedent to extend, not replace.

- **`TemplateApplication` (ADR-0789/#2729, `models.py:7368`) is the closest existing
  pattern for a batched, undoable server-side operation record**: one row per
  template-apply, `created_task_ids` (an `ArrayField`, not an FK table — survives
  even if referenced rows are later hard-deleted), `status`, `undone_at`, and
  `undo_template_application()` in `template_services.py`, which **skips any row a
  person has since touched** rather than blindly reverting it. Exposed via
  `POST /template-applications/{id}/undo/`.

- **Neither paste-many, cascade classification (`task_classification.py:328`), nor
  the import-fix review-branch flow (#2732) persists any batch/operation row today.**
  `task_bulk.py`'s `BulkOutcome` is an in-memory dataclass, gone once the response is
  sent. There is nothing server-side for a "last action" undo to point at for these
  three operations.

- **The codebase has an established, explicitly-argued position against a single
  polymorphic "operation" table with a nullable discriminator.** `ProjectExportJob` /
  `ProgramExportJob` and `ProjectExportJob`'s own docstring reject that shape twice
  over: *"A discriminator column would leak nullability through the serializer,
  services, and tasks for no gain."* Sibling models, one per scope/operation type,
  each with its own FK, indexes, and drain/purge task, is the house style.

- **`HistoricalRecords`/`server_version` is not a complete substrate for this.**
  CPM's `bulk_update` writes and `TaskResource` (owner/units) writes bypass
  `HistoricalRecords` entirely (noted at `models.py:2274`, `:6237`) — a
  history-rollback-based undo would silently miss exactly the writes a bulk-edit
  sheet is most likely to make (owner, dates via CPM recompute).

- **The bulk PATCH endpoint's idempotency key is the client-minted task `id` itself
  (ADR-0772), not a separate `client_id` field.** The issue text's "`client_id`
  idempotency" is loose phrasing for the same ADR-0772 contract — no design
  correction needed, just naming precision for the implementer.

- **No offline sync tombstone/delta abstraction exists in `packages/web`** — that
  protocol lives in mobile/API. A web-side undo of a batched operation does not need
  to represent itself in a client delta/CRDT model; it only needs the server row to be
  the single source of truth, consistent with ADR-0599's boundary (client compute is
  preview or offline stand-in, never authoritative).

## Decision

**Split #2756.** Part 3 (Timeline `Enter`-to-create parity) is carved out into its own
issue and does not get an architecture decision here — ADR-0776 already made the
scoping call, and what's left is an interaction-design question that needs `ux-design`
first. #2756 going forward covers parts 1 and 2 only.

**Part 1 — undo is a single most-recent-action affordance, not a deep undo/redo
stack.** The issue's own language ("must each undo as a single step") is about
*atomicity* — one ⌘Z reverts a whole batch in one action — not about depth. This
matches the existing single-slot toast UX and requires no new client-side history
data structure. Reject the client-only command-pattern alternative (see below).

**Undo is server-recorded, following the `TemplateApplication` pattern, generalized
to sibling models rather than one polymorphic table:**

- Add `PasteManyOperation`, `CascadeClassificationOperation`, and
  `ImportFixOperation` models, each shaped like `TemplateApplication`: `id`, `project`
  FK, `applied_by` FK, `status`, an array/JSON field recording exactly what changed
  (created ids for paste-many; before/after classification pairs for cascade;
  created/updated ids for import-fix), `undone_at`, timestamps. No `server_version` —
  these are server-side operation ledgers, not synced entities, matching
  `TemplateApplication`'s own reasoning.
- Each gets its own `undo_<x>_operation()` service function following
  `undo_template_application()`'s shape: reject if `undone_at` is already set
  (idempotent no-op, not an error, on a duplicate ⌘Z), skip any row touched since the
  operation (guarded by comparing current `server_version`/`updated_at` against the
  value recorded at operation time), and return a partial-result summary — not a
  bare 204 — when some rows were skipped.
- Before implementing each, check whether #2735 (cascade) or #2732 (import-fix)
  already left a suitable row from its own merged work that can be extended rather
  than duplicated — the research pass here found none, but both landed recently
  enough that this is worth a direct check against `main` at implementation time
  rather than trusting this ADR's snapshot.
- Frontend: replace the per-feature toast wiring in `ScheduleView.tsx` with one
  `useUndoableOperation`-style hook that holds `{ kind, id, expiresAt }` (kind ∈
  `template | paste_many | cascade | import_fix | delete`) and dispatches to the
  matching undo endpoint. `delete` keeps its existing `restore/` endpoint — this is a
  UI-layer unification only, not a migration of already-shipped delete/template-apply
  undo onto the new tables.

**Part 2 — bulk-edit sheet writes through the existing bulk endpoint contract.** No new
endpoint shape is needed: `POST /projects/{pk}/tasks/bulk/` already returns the
`applied/rejected/skipped` 207 shape (ADR-0772) that a multi-row partial-success sheet
needs. The gap is a `useBulkUpdateTasks` hook (no `PATCH`-shaped bulk hook exists today
— only `useBulkDeleteTasks` and `useBulkCreateTasks`) and the sheet UI itself (a
`ux-design` pass, not covered by this ADR).

**Recommendation, not a requirement of this ADR:** wire the bulk-edit sheet's writes
into the same operation-ledger pattern (a `BulkEditOperation` sibling) so a bulk-edit
is ⌘Z-undoable too, for consistency with paste-many/cascade/import-fix. The issue text
doesn't list bulk-edit under the undo requirement, so this is left to the `ux-design`
pass and implementer judgment rather than mandated here — flagging it so it isn't lost.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Server-recorded operation ledger, sibling models (chosen)** | Matches `TemplateApplication` and the export/import-job house style; server is the single source of truth per ADR-0599; skip-if-touched-since safety is a natural server-side check; survives page reload/multi-tab | More migrations (3-4 small tables) than a shared table |
| Client-only command pattern (record inverse operations in a Zustand store, replay locally) | No migration; instant undo, no round trip | Diverges from every existing undo/restore mechanism in the codebase; replaying a CPM recalculation or dependency cascade client-side risks drifting from server truth, which ADR-0599 exists specifically to prevent; lost on reload/tab close; still needs a server call to actually revert persisted state, so the "no round trip" win is illusory |
| One polymorphic `BatchOperation` table with a `kind` discriminator + nullable per-kind columns | Fewer tables, one service module | The codebase has already rejected this shape twice (`ProjectExportJob`/`ProgramExportJob` docstring) — nullable columns leak through serializer, services, and tasks for no real gain |
| History-based rollback via `HistoricalRecords`/`server_version` | Reuses existing sync infrastructure | CPM `bulk_update` and `TaskResource` writes bypass `HistoricalRecords` entirely — would silently miss the exact writes a bulk-edit sheet makes most often (owner, dates) |
| Resolve Timeline Enter parity in this ADR alongside undo/bulk-edit | One issue closes instead of two | ADR-0776 already made this scoping call once; re-deciding it without a `ux-design` pass on the "where do drawer-open and reschedule go" question repeats the exact mistake #2727/ADR-0776 avoided |

## Consequences

- Undo becomes consistent across four (eventually five, if bulk-edit opts in)
  batch-writing flows, using one established pattern instead of four bespoke ones.
- Three to four new small models and migrations; each needs its own purge/retention
  job (see Durable Execution below) rather than reusing `TemplateApplication`'s.
- The single-slot toast UI stays simple — no undo history list, no multi-level
  redo — matching what the issue actually asked for.
- Part 3 (Timeline Enter parity) is now unblocked to get its own `ux-design` pass
  without holding up parts 1 and 2.
- Risk: four near-identical sibling models is real duplication. Accepted deliberately,
  matching the codebase's own stated preference (export/import job siblings) over a
  discriminator table — revisit only if a fifth near-identical use case appears and
  the duplication becomes the bigger cost.

## Implementation Notes
- P3M layer: Programs and Projects (single-project schedule authoring)
- Affected packages: api, web
- Migration required: yes — `PasteManyOperation`, `CascadeClassificationOperation`,
  `ImportFixOperation` models (batch in one `makemigrations` run per migration
  discipline in CLAUDE.md); optionally `BulkEditOperation` if the sheet opts in to undo
- API changes: yes — `POST /paste-many-operations/{id}/undo/`,
  `POST /cascade-classification-operations/{id}/undo/`,
  `POST /import-fix-operations/{id}/undo/` (mirroring
  `POST /template-applications/{id}/undo/`); bulk-edit sheet reuses the existing
  `POST /projects/{pk}/tasks/bulk/` for writes, no new write endpoint
- OSS or Enterprise: OSS — single-project schedule authoring, no cross-program scope

### Durable Execution
1. Broker-down behaviour: N/A — paste-many, cascade, and import-fix already write
   synchronously within the request/response cycle (no Celery dispatch); the new
   operation-ledger row is created in the same DB transaction as the batch write
   itself, so there is no broker-down window to design for. (Template-apply is the
   one async exception among the four and already has its own outbox-shaped handling
   via `celery_task_id`/status, unchanged by this ADR.)
2. Drain task: N/A — no new asynchronous dispatch is introduced.
3. Orphan window: N/A — follows from (1).
4. Service layer: new functions needed —
   `apps/projects/task_batch_services.py::undo_paste_many_operation()`,
   `undo_cascade_classification_operation()`, `undo_import_fix_operation()`, each
   mirroring `template_services.py::undo_template_application()`.
5. API response on best-effort dispatch: synchronous — the undo endpoint returns 200
   with a partial-result summary (`{"reverted": [...], "skipped": [...]}`) when some
   rows were touched since the original operation, mirroring the bulk endpoint's own
   applied/rejected/skipped shape rather than an all-or-nothing 204.
6. Outbox cleanup: each new table gets a nightly purge past a 30-day retention window
   (`undone_at IS NOT NULL OR created_at < cutoff`), registered in Beat alongside the
   existing `TemplateApplication`-adjacent purge jobs — 30 days chosen to comfortably
   exceed any plausible "wait, I meant to undo that" gap while staying well inside the
   90-day `HistoricalTask` retention cap these tables sit alongside.
7. Idempotency: undo is idempotent by construction — each service function's first
   step is `if application.undone_at is not None: return already-undone result`
   (no-op, not an error), matching `undo_template_application()`. A `select_for_update`
   on the operation row during undo prevents a concurrent double-⌘Z race.
8. Dead-letter / failure handling: N/A for the write path (synchronous, no queue). A
   partial undo (some rows skipped as touched-since) is not a failure state — it's
   the designed outcome, surfaced to the user as which rows reverted and which didn't
   rather than an error.

## Amendment — 2026-08-06, corrected at implementation time

Implementation-time code reading (`packages/api/src/trueppm_api/apps/csvimport/tasks.py`,
`views.py`) found that **import-fix is not synchronous**: `CsvImportView.post` only
enqueues `import_csv` (a Celery `shared_task`), which does the actual `bulk_create` of
review-branch rows asynchronously, with its own drain (`drain_csv_import_queue`). The
Context and Durable-Execution §1 claim that "paste-many, cascade, and import-fix already
write synchronously... no Celery dispatch" is **wrong for import-fix** — only paste-many
and cascade are synchronous. Import-fix's durability shape matches template-apply's, not
paste-many/cascade's.

**Corrected decision for `ImportFixOperation`:** it follows the async outbox shape
(`TemplateApplicationStatus`-style `pending/running/success/failed/undone`,
`celery_task_id` field, row created eagerly as `pending` before `transaction.on_commit`
dispatch, `created_task_ids` populated when `import_csv` completes inside its own
`transaction.atomic()` block) — not the plain synchronous row Durable-Execution §1
describes. §1's "no broker-down window" and §3's "orphan window N/A" do **not** apply to
`ImportFixOperation`: it needs the same broker-down handling, drain re-dispatch, and
orphan-window filtering as `TemplateApplication` already has (reuse that existing drain
rather than adding a new one, since the semantics match exactly). Only `PasteManyOperation`
and `CascadeClassificationOperation` get the synchronous, same-transaction ledger-row
treatment §1-§3 originally described for all three.

No other part of this ADR's decision changes — the sibling-model shape, undo semantics,
skip-if-touched-since safety, and idempotency guard all still apply to `ImportFixOperation`
as written; only its dispatch timing moves from "synchronous" to "async, outbox-shaped,
reuse template-apply's drain."

## Amendment — 2026-08-06, `ImportFixOperation` dropped in favor of extending `CsvImportRequest`

Implementing the amendment above, per this ADR's own Decision-section instruction to
check for an existing suitable row before adding a new table: `apps/csvimport/models.py`
already defines `CsvImportRequest` — the exact async outbox row the corrected
`ImportFixOperation` would have duplicated (`project` FK, `status`, `initiated_by`,
`result_summary`, `celery_task_id`, `requested_at`). A parallel `ImportFixOperation`
table would mean two rows bookkeeping the same import.

**Corrected decision:** no `ImportFixOperation` model. Instead, `CsvImportRequest` gets
two new fields — `created_task_versions` (`JSONField`, same `{"<task id>": <server_version
int>} `shape as `PasteManyOperation`) and `undone_at` — and `CsvImportStatus` gets a new
terminal member, `UNDONE`. `import_project()` (`apps/msproject/importer.py`) already
builds `task_objects` with populated `.pk` right where `task_uid_to_pk` is built; it now
also returns `created_task_ids` in its summary dict, and `csvimport/tasks.py`'s
`import_csv` task writes `created_task_versions` onto the `CsvImportRequest` row inside
the same `transaction.atomic()` block that claims it (`_claim_import`, DISPATCHED →
DONE) — the same "row and write commit together" guarantee as the other two operation
types, just against an existing table instead of a new one. `undo_import_fix_operation()`
lives in the new `task_batch_services.py` alongside its two siblings for one vocabulary
at the call site, even though its model lives in a different app; it reuses
`CsvImportRequest`'s existing `drain_csv_import_queue` rather than adding a new drain,
since an `UNDONE` row is inert to that drain's PENDING/DISPATCHED-scoped queries by
construction.

This changes only where the fields live, not the ADR's decision: server-recorded,
skip-if-touched-since, idempotent, one-shot undo, same as the other two operation types.

**Further correction to Implementation Notes' stated URL:** the actual endpoint is
`POST /projects/{project_pk}/import/csv/{pk}/undo/`, not a router-registered
`/import-fix-operations/{id}/undo/`. `apps/csvimport` has no `DefaultRouter` — every
endpoint in it is a plain project-nested `path()` (`CsvImportView`,
`CsvImportStatusView`, …) — and matching that app's own existing convention beats
importing the `projects` app's router style for one endpoint. `PasteManyOperation`'s
and `CascadeClassificationOperation`'s endpoints keep the router-registered,
flat-collection shape this ADR originally specified, since that matches
`template-applications`' own convention in the app they actually live in.
