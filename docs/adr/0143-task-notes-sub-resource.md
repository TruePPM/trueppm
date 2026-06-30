# ADR-0143: Task Notes Sub-Resource (per-author, append-with-edit-window)

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class TaskNote)

## Context

Today a task carries collaborative annotations in a single mutable scalar field,
`Task.notes` (`projects/models.py:1118`, a `TextField(blank=True, default="")`
normalized by ADR-0048). That field has three problems as a *collaborative* surface:

1. **No authorship or chronology.** It is one blob; whoever saved last owns the whole
   thing. There is no "who wrote what, when" — the exact provenance a team needs when a
   note records *why* a task changed.
2. **Last-write-wins clobbering.** Two people editing the same task's notes overwrite
   each other silently.
3. **Overloaded role.** `Task.notes` is *also* the import/description scalar: MSPDI
   `<Notes>` round-trips through it (`msproject/exporter.py:123`,
   `importer.py:168`), the seed schema declares it (`seed_v1.json:162`,
   `seed_v2.json:189`), inbound external-task sync writes the external description into
   it (`inbound_sync.py:238`), the program/product backlog maps `BacklogItem.description`
   → `Task.notes` (`backlog_services.py:114`, `product_backlog_services.py:309`), and
   the offline sync upload path treats it as an editable task scalar
   (`sync/upload.py`, `tests/apps/sync/test_sync_upload.py` — the heaviest coupling).

So `Task.notes` is doing double duty: a machine-written **description/scratch** field
*and* a human **collaborative-notes** field. Issue #740 is about the second role — give
collaborative notes first-class authorship, timestamps, an immutability guarantee, and a
freshness signal — without breaking the first.

**P3M layer**: Programs and Projects / Operations. Task-scoped collaborative notes are a
single-project operation a PM/team needs to run their work — **OSS** (feature-resonance:
the on-target audience is Jordan/Alex/Morgan/Priya, never Marcus/Janet — see VoC below).

**VoC panel** (6 personas, opus): average 4.8/10, but dragged by two **off-target**
personas — Marcus/PMO (3, wants an Enterprise portfolio decisions register; deliberate
out-of-scope) and Sarah/PM (4, weak fit: a construction PM judging a software-team notes
feature). The **on-target agile trio** averaged 6.3 (Jordan/PO 5, Alex/SM 6, Morgan/Coach
8 — champion). The praised primitive is *immutable per-author timestamped rows + a short
self-edit window + a single structured marker*. Two 🟡 signals carried into this design:
Priya wants the add-note flow to be **extremely low-ceremony** (the edit window helps),
and Sarah's offline 🔴 is structurally about the **absence of a mobile client**, not about
this model (see Decision §"Offline").

This ADR also partially lands **ADR-0075** (Proposed, "Task Attachments, Comments,
@Mentions, Notifications"), which sketched a "Notes + Decision toggle + per-author
timestamped entries with a project/sprint Decisions view" for #476/#748. This ADR
implements the **Notes** half only. The **Decision** half (#748) is a deliberate
sprint-bound fast-follow (see §Decision seam); @mention and project-wide FTS are out of
scope (#751 covers FTS).

## Decision

Add a **`TaskNote`** sub-resource modeled directly on `TaskComment` (the proven
project-scoped, append-with-edit-window, REST + WebSocket sibling at
`projects/models.py:3778` / `views.py:8939`). `Task.notes` is **kept** and re-cast as the
task's *description/scratch* scalar (its real, system-coupled role); the *collaborative*
notes surface moves to `TaskNote`. **No data migration, no removal** — see §"Existing
`Task.notes` blob".

### Model — `TaskNote(models.Model)` (plain Model, NOT VersionedModel)

```python
class TaskNote(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="notes_log")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                               null=True, related_name="task_notes")
    body = models.TextField()
    pinned = models.BooleanField(default=False)
    # Seam for #748 (sprint-bound Decisions). Column lands now so #748 is purely
    # additive; exposed read-only in the serializer, not toggleable until #748.
    decision = models.BooleanField(default=False)
    edited_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                                   null=True, blank=True, related_name="deleted_task_notes")

    class Meta:
        db_table = "projects_tasknote"
        ordering = ["-pinned", "-created_at"]          # pinned-first, then newest
        indexes = [models.Index(fields=["task", "is_deleted", "-created_at"],
                                name="ix_tasknote_task_recent")]

    @property
    def project_id(self):                               # for RBAC _get_project_id_from_obj
        return self.task.project_id

    def soft_delete(self, actor=None):                  # mirror TaskComment.soft_delete
        ...
```

`related_name="notes_log"` (not `notes`) avoids colliding with the existing
`Task.notes` scalar attribute. The `-pinned` lead in `ordering` gives pinned-first; the
listing index mirrors `TaskComment.ix_comment_task_chrono`.

**Why plain `Model`, not `VersionedModel`** (the key model-base decision):
- The exact sibling, `TaskComment`, is a plain Model and **deliberately does not join the
  sync union** — it reconciles via REST refetch + WS broadcast invalidation. ADR-0075
  set that precedent for task-scoped sub-content.
- There is **no mobile/client package in the repo** (ADR-0026 is *Superseded*; the only
  WatermelonDB code is server-side). Making `TaskNote` a `VersionedModel` would force it
  into the sync union → an ADR-0142 watermark receiver, a `sync/views.py` delta-pull
  entry, and a conformance test that *fails loudly otherwise* — non-trivial surface for a
  consumer that does not exist yet.
- ADR-0044 reasoned that **immutability makes `server_version` unnecessary** (LWW
  conflict resolution is moot for append-only rows). Same logic here.
- Promotion is additive later: if/when a mobile client lands, `TaskNote` can be converted
  to `VersionedModel` + joined to the union in a separate migration.

### Behavior

- **Append-only with a self-edit window.** Each save is a new row. The author may `PATCH`
  *their own* note `body` only within **`NOTE_EDIT_WINDOW_SECONDS = 900`** (15 min) of
  `created_at`; after that the serializer `update()` rejects with 400 and stamps
  `edited_at` on a successful edit. This mirrors `TaskComment`'s
  `COMMENT_EDIT_WINDOW_SECONDS` machinery exactly (`serializers.py:4851`). "Immutable"
  = each note is its own row + locked after the window.
- **Pin** is a separate mutable affordance (like `TaskAttachment.is_pinned`), exposed as a
  dedicated `@action` so it is **not** gated by the edit window and does not require
  authorship — any project writer (MEMBER+) may pin/unpin a team note for curation.
- **Body caps**: `MAX_NOTE_BODY_CHARS` (mirror `MAX_COMMENT_BODY_CHARS`) in
  `validate_body`; `MAX_NOTES_PER_TASK` count cap in `perform_create` (DoS guard, mirrors
  `MAX_COMMENTS_PER_TASK`).
- **No CPM recalc.** Notes live in a separate table and never touch Task scheduling
  fields, so note CRUD never calls `Task.save()` and never enqueues a recalculate.

### API (manual `path()` registration, mirroring task comments — `urls.py:592`)

| Method + path | Action | Permission |
|---|---|---|
| `GET  /projects/<project_pk>/tasks/<task_pk>/notes/`        | list     | `IsProjectMember` (VIEWER+) |
| `POST /projects/<project_pk>/tasks/<task_pk>/notes/`        | create   | `IsProjectMemberWrite` (MEMBER+) |
| `GET  /projects/<project_pk>/tasks/<task_pk>/notes/<pk>/`   | retrieve | `IsProjectMember` |
| `PATCH /projects/<project_pk>/tasks/<task_pk>/notes/<pk>/`  | edit `body` (author-only, ≤15 min) | `IsProjectMemberWrite` + author guard |
| `DELETE /projects/<project_pk>/tasks/<task_pk>/notes/<pk>/` | soft-delete (author OR role≥ADMIN) | `IsProjectMemberWrite` + author/admin guard |
| `POST /projects/<project_pk>/tasks/<task_pk>/notes/<pk>/pin/` | toggle `pinned` | `IsProjectMemberWrite` |

All wrapped with `IsProjectNotArchived` on writes, exactly as `TaskCommentViewSet`. Role
thresholds follow the band contract of **ADR-0072** (`role >= Role.X`). `author` set in
`perform_create` via `serializer.save(task=task, author=self.request.user)`. `decision` is
in the serializer `read_only_fields` (in the shape, un-toggleable until #748).

### Freshness signal

The board card face and the Gantt row tooltip surface the **latest note timestamp**. To
avoid an N+1 across the board, the *task list/board* serializer gains a cheap
`latest_note_at` (annotated `Max("notes_log__created_at", filter=Q(notes_log__is_deleted=False))`
on the board/task queryset, not a per-row property). Card-scoped search and the dim
behavior (N of M, non-matches → 0.3 opacity) are **client-side only** over the already-
fetched notes list — no FTS index (deferred #751).

### Real-time

`broadcast_board_event(project_id, "task_note_created" | "task_note_updated" |
"task_note_deleted" | "task_note_pinned", {...})`, deferred with
`transaction.on_commit(...)`, **snapshotting all plain string values before the closure**
(never dereference ORM instances inside the lambda) — the H-1 broadcast-check rule, per
the `task_*` snake_case event family of ADR-0091 and the wiring of ADR-0117. Broadcast is
best-effort; the web `useProjectWebSocket` hook invalidates `['task-notes', taskId]` and
the board query on these events.

### Offline

"Offline persist + sync on reconnect" is satisfied at **parity with `TaskComment`**:
TanStack Query cache + WS-reconnect invalidation + REST refetch. True WatermelonDB
offline-*create* is **deferred** — it has no consumer (no mobile package exists). Sarah's
offline 🔴 is logged against the missing mobile client, not this model; promotion to a
`VersionedModel` in the sync union is a clean additive follow-up when that client lands.

### Existing `Task.notes` blob

**Keep the column; no data migration; no backfill.** `Task.notes` remains the
description/scratch scalar that MSPDI export/import, the seed schema, inbound external
sync, backlog `description→notes` mapping, webhooks, and the offline upload path already
depend on. The web *collaborative-notes UI* switches from editing `Task.notes` to the
`TaskNote` sub-resource. We deliberately **do not** backfill `Task.notes` into authored
`TaskNote` rows: that text is frequently machine-written ("Split from …", external sync
descriptions, MSPDI notes) and backfilling it would mis-attribute it to a human author and
pollute the collaborative stream. Renaming `Task.notes` → `Task.description` for clarity
is a large cross-system rename (MSPDI/seed/inbound-sync/web type + fixtures) tracked as a
**separate follow-up**, not this MR.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. `TaskNote` plain Model, REST + WS, keep `Task.notes` (chosen)** | Exact `TaskComment` sibling pattern; additive, trivially-safe migration; no sync-union conformance burden; no multi-system breakage | "Offline" is web-cache parity, not WatermelonDB delta (acceptable: no mobile consumer) |
| B. `TaskNote` as `VersionedModel` in the sync union | Future mobile offline-create works out of the box | Watermark receiver + delta-pull entry + conformance test for a non-existent consumer; `server_version` is dead weight on append-only rows (ADR-0044); over-builds the MR |
| C. Strictly immutable, no edit at all (ADR-0044 `RiskComment` pattern) | Simplest invariant; no edit-window code | Fails #740's "author may fix their own entry within 15 min"; worse for Priya's low-ceremony ask (typo = orphaned row forever) |
| D. Remove `Task.notes`, backfill into `TaskNote` | One canonical notes concept | Breaks MSPDI export, seed schema, inbound-sync, webhooks, offline upload, web Task type + ~12 fixtures; mis-attributes machine text to humans; large risky data migration |
| E. Keep one mutable blob, add author/timestamp columns | No new table | Still one row → no per-author history, no pin, no immutability; doesn't solve the clobbering problem |

## Consequences

**Easier:**
- Per-author "who decided what, when" provenance on a task — the praised primitive.
- The `decision` seam means #748 (sprint-bound Decisions) is purely additive — a toggle
  action + a filtered view, no schema change.
- Freshness signal gives the board a cheap recency cue (Morgan's 🟢 health cue without
  exposing task-internals to the PMO).

**Harder / risks:**
- **Terminology collision** `Task.notes` (scalar) vs `TaskNote` (sub-resource) — mitigated
  by `related_name="notes_log"` and an explicit naming note here; the eventual
  `Task.notes`→`description` rename is deferred.
- Two notes surfaces coexist transiently (the legacy scalar still PATCHable via
  `TaskSerializer`, the new sub-resource). The web UI points users at the sub-resource;
  the scalar stays for system/import use. Acceptable, documented.
- Freshness `latest_note_at` must be a queryset annotation, not a per-row property, or it
  N+1s the board — called out for perf-check.

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations
- **Affected packages**: api (model, migration `0083`, serializer, viewset, urls,
  board/task serializer annotation, OpenAPI regen), web (notes section in task drawer,
  dim-search, pin, freshness on card + Gantt tooltip, WS event handling, `TaskNote` type,
  `useTaskNotes` hooks)
- **Migration required**: yes — `projects/0083_tasknote.py`, pure additive table create
  (no NOT NULL without default; `decision`/`pinned` default `False`; `body` has no default
  but is required on insert, which is correct for a create-only field). No data migration.
- **API changes**: yes — new `/tasks/<pk>/notes/` collection + detail + `pin` action;
  `latest_note_at` added to board/task read serializer.
- **OSS or Enterprise**: **OSS** (`trueppm-suite`). Boundary verified:
  `grep -rn "trueppm_enterprise" packages/` → 9 matches, all comments/docs, zero imports.

### Durable Execution
1. **Broker-down behaviour**: N/A — note CRUD dispatches no Celery work. The only side
   effect is a **best-effort** `broadcast_board_event` WS push (failures swallowed by
   design; ADR-0117/`broadcast.py`). Broadcast-only `on_commit` callbacks need no outbox
   row — clients reconcile via REST refetch on reconnect. (@mention/notification fan-out,
   which *would* need the outbox, is explicitly out of scope for #740.)
2. **Drain task**: N/A — no async task category introduced.
3. **Orphan window**: N/A — no drain.
4. **Service layer**: N/A — viewset `perform_create/update/destroy` directly, mirroring
   `TaskCommentViewSet`. No CPM path (notes are non-schedule), so no
   `enqueue_recalculate()`.
5. **API response on best-effort dispatch**: N/A — REST is synchronous (201 create / 200
   update / 204 delete); the WS broadcast is a fire-and-forget side effect, not the
   response.
6. **Outbox cleanup**: N/A — no outbox rows written.
7. **Idempotency**: REST create is naturally non-idempotent; bounded by `MAX_NOTES_PER_TASK`
   and standard DRF create semantics (no Idempotency-Key required, matching
   `TaskCommentViewSet`). The WS broadcast is idempotent on the client — re-delivery just
   re-invalidates the `['task-notes', taskId]` query, a no-op refetch.
8. **Dead-letter / failure handling**: N/A — the sole async-ish effect (WS broadcast) is
   best-effort with no retry/DLQ by design; the client reconciles on the next fetch or
   reconnect (the documented broadcast contract).
