# ADR-0069: Dual-Level Backlog — Program BacklogItem and Project Backlog

## Status
Accepted (2026-05-25) — Program entity shipped (ADR-0070, #502). The `BacklogItem`
model attaches to `Program`, not `Project`. **See the Erratum at the end of this
document** — the `## Decision` code block below is the superseded *project-scoped*
draft; the implemented design is program-scoped per the Erratum and ADR-0070.
Implemented across #733 (model + sync-readiness + migration), #737 (list + pull-down
endpoints), and #739 (pg_trgm search).

## Context

TruePPM's existing backlog model is single-level: tasks with `status=BACKLOG` and
`sprint=NULL` form the **project backlog** — work accepted into a project but not yet
scheduled. This is surfaced in the Board's BACKLOG rail (ADR-0057), in
`SprintBacklogTable` (ADR-0059), and is excluded from CPM via the `Task.committed`
manager.

What is missing is a holding area for work that has been *proposed* to a program but not
yet committed to any specific project. In program increment planning, a PM or PO
maintains a pool of features/epics at the program level — candidates that can be pulled
into whichever project needs them next. That pool needs:

1. Its own lifecycle (proposed → pulled → archived) distinct from the Task status machine.
2. Item types that span PM vocabulary (WBS-style tasks) and PO vocabulary (epics, stories,
   features) — same items, different framing.
3. Search and filter before committing work to a specific project.
4. A pull-down action that creates a project-backlog Task — never a sprint task — so that
   sprint sovereignty is preserved for the team (Morgan's 🔴 blocker from VoC).

**P3M layer**: Programs and Projects (OSS). `Program` is an OSS entity — a PM and their
team must be fully functional at the program level without Enterprise. A program is a set
of related projects managed by one PM/PO. Portfolio (multiple programs under PMO
governance) is Enterprise. `BacklogItem` lives at the Program level: one program backlog,
pulled into any of the program's projects.

**Scope correction**: An earlier draft of this ADR scoped `BacklogItem` to `Project`
(one intake pool per project). That was wrong. The program backlog must live at the
`Program` level so a PM can pull a feature into whichever project is ready for it — the
core use case for program increment planning. This requires the `Program` entity to be
introduced as an OSS model first.

**VoC panel summary** (panel average 4.0/10 — skewed by exec/contributor personas for
whom this is not the target workflow):
- Jordan (PO) 6/10 🟡 — genuine win on the Jira↔Gantt reconciliation pain; needs
  epic/story hierarchy and velocity forecast at pull-time.
- Alex (SM) 5/10 🟡 — good pre-Sprint scaffolding; pull must wire into Sprint Planning,
  not bypass it.
- Morgan (Coach) 4/10 🔴 — "pull directly into sprint" violates sprint sovereignty.
  **Resolved** by this ADR: pull creates a project-backlog Task only; sprint assignment
  remains PO/SM-gated in Sprint Planning.
- Sarah (PM) 4/10 🟡 — project-level holding area resonates; requires mobile/offline
  support and must not force Agile vocabulary on waterfall users.

**Related ADRs**:
- ADR-0013: `TaskStatus.BACKLOG` as the project-backlog semantic.
- ADR-0036: Hybrid PM philosophy; Phase → Milestone → Sprint → Task decomposition.
- ADR-0037: Sprint model; `task.sprint=NULL` as project-backlog indicator.
- ADR-0057: Board BACKLOG rail; `Task.committed` manager.
- ADR-0059: `SprintBacklogTable`; `+ Add task` button.
- ADR-0068: Inbound task sync (creates Tasks with `status=BACKLOG` directly — separate
  path, no change).

## Decision

Introduce a `BacklogItem` model (extends `VersionedModel`, project-scoped) to represent
the program-level intake pool. Items are created manually by PM/PO; inbound sync
(ADR-0068) continues to create Tasks directly and is unaffected.

A `/pull/` action converts a `BacklogItem` to a `Task` with `status=BACKLOG` and
`sprint=NULL`, landing it in the project backlog. Pull never assigns directly to a sprint.

### Two-tier hierarchy

| Level | Model | Status / condition | Managed by |
|-------|-------|--------------------|------------|
| Program backlog | `BacklogItem` | `status=PROPOSED` | PM / PO (EDITOR+) |
| Project backlog | `Task` | `status=BACKLOG`, `sprint=NULL` | PM / PO (EDITOR+) |
| Sprint | `Task` | `sprint=<Sprint FK>` | PO / SM (gated) |

### BacklogItem model

```python
class BacklogItemStatus(models.TextChoices):
    PROPOSED  = "proposed"   # available to pull
    PULLED    = "pulled"     # converted to a Task
    ARCHIVED  = "archived"   # removed from active pool without pulling

class BacklogItemType(models.TextChoices):
    EPIC     = "epic"     # large cross-sprint body of work (PO vocabulary)
    FEATURE  = "feature"  # user-visible capability (shared vocabulary)
    STORY    = "story"    # user story (PO vocabulary)
    TASK     = "task"     # WBS-style deliverable (PM vocabulary)

class BacklogItem(VersionedModel):
    project              = FK → Project (CASCADE), related_name="backlog_items"
    short_id             = CharField(8, editable=False)  # hex from Project.object_sequence
    title                = CharField(512)
    description          = TextField(blank=True, default="")
    acceptance_criteria  = TextField(blank=True, default="")
    item_type            = CharField(choices=BacklogItemType, default=TASK)
    priority_rank        = PositiveIntegerField(null=True)  # lower = higher priority
    story_points         = PositiveSmallIntegerField(null=True)
    status               = CharField(choices=BacklogItemStatus, default=PROPOSED, db_index=True)
    pulled_task          = OneToOneField(Task, SET_NULL, null=True, related_name="source_backlog_item")
    pulled_at            = DateTimeField(null=True)
    pulled_by            = FK → AUTH_USER_MODEL (SET_NULL, null=True)
    created_by           = FK → AUTH_USER_MODEL (SET_NULL, null=True)
    created_at           = DateTimeField(auto_now_add=True)
    updated_at           = DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            Index(fields=["project", "status"]),                          # list + filter
            GinIndex(fields=["title"], opclasses=["gin_trgm_ops"]),       # text search
        ]
        constraints = [
            UniqueConstraint(fields=["project", "short_id"], name="unique_backlog_item_short_id"),
        ]
```

`BacklogItem` extends `VersionedModel` and therefore participates in the WatermelonDB
delta sync (ADR-0010). The mobile sync table list must be updated to include
`backlog_item`.

### Pull-down action

**Endpoint**: `POST /api/v1/projects/{pk}/backlog-items/{item_pk}/pull/`

**Permissions**: `IsProjectMember` with role ≥ `EDITOR`.

**Behaviour** (atomic, via `backlog_services.pull_to_project_backlog(item, pulled_by)`):

1. `SELECT FOR UPDATE` on the `BacklogItem` row; assert `status == PROPOSED` — returns
   `409 Conflict` if already pulled or archived.
2. Create `Task(project=item.project, name=item.title, description=item.description,
   story_points=item.story_points, status=BACKLOG, sprint=None, ...)`.
3. Set `BacklogItem.status = PULLED`, `pulled_task = task`, `pulled_at = now()`,
   `pulled_by = actor`.
4. In `transaction.on_commit`: call `enqueue_recalculate()` (ADR-0027 outbox) and
   `broadcast_board_event()` for the new Task.
5. Return `201 { "task": <TaskSerializer> }`.

Sprint assignment is a separate, PO/SM-gated action in Sprint Planning (unchanged).

**Rollback**: If the resulting Task is deleted, a `post_delete` signal resets
`BacklogItem.status = PROPOSED` so the item can be re-pulled.

### Vocabulary duality

`item_type` bridges PM and PO vocabulary without forcing either side to learn the other's
terms. On pull, `item_type` is stored in the Task's `notes` as structured metadata
(`{"source_type": "epic"}`); no new field is added to `Task`. The Board and Schedule
views continue to show only Task vocabulary.

### Search API

```
GET /api/v1/projects/{pk}/backlog-items/
    ?q=<text>              # trigram search on title + description
    &item_type=epic        # filter by BacklogItemType
    &status=proposed       # default; omit to include pulled/archived
    &ordering=priority_rank
```

Full-text search uses `pg_trgm` (`gin_trgm_ops` GIN index on `title`). For description
search, a combined `search_vector` `tsvector` column can be added as a follow-up if
the trigram approach proves too slow at scale.

### Interaction with inbound task sync (ADR-0068)

Inbound push (`POST /projects/{id}/task-sync/`) creates Tasks directly with
`status=BACKLOG` or better. This path is unchanged and does not create `BacklogItem`
rows. The two intake paths are distinct:
- **Manual (program planning)**: PM/PO creates `BacklogItem` → pulls to Task.
- **Automated (integration push)**: Jira/Linear/GitHub pushes → Task via `ProjectApiToken`.

A future enhancement could allow inbound items to land in the `BacklogItem` pool as
`PROPOSED` rather than auto-creating Tasks (configured via `ProjectApiToken.intake_mode`),
but this is deferred.

### Navigation and UI surface

A new **Backlog** tab is added to the project shell at `/projects/:id/backlog`, rendered
for all methodologies (WATERFALL / AGILE / HYBRID). The tab is visible only when
`agile_features=True` OR when the project has at least one `BacklogItem` (discovery
path for waterfall PMs who adopt the intake pattern organically).

The tab shows:
- Left panel: `BacklogItem` list (proposed only), sortable by `priority_rank`, filterable
  by `item_type`. Search bar at the top.
- Right panel: detail view / edit form for the selected item.
- "Pull to project backlog" button → calls the pull endpoint; item moves to a "Pulled"
  section at the bottom.

The existing project backlog (Tasks with `status=BACKLOG`) remains visible in the Board
BACKLOG rail and `SprintBacklogTable` — no change to those surfaces.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A — BacklogItem model (chosen)** | Clean separation from Task; own lifecycle; searchable; no impact on CPM or Board | New model + migration; pull creates two rows until the item is accepted |
| **B — Add `backlog_level` field to Task (PROGRAM / PROJECT)** | No new model; reuses Task | Complicates `committed` manager, CPM exclusion, Board partitioning, and all existing BACKLOG logic; semantically wrong |
| **C — Designate a "program container project"** | No new model | Pollutes the project list; breaks project semantics; awkward navigation |
| **D — OSS Program entity** | Architecturally correct for true cross-project program backlog | Conflicts with data model boundary (Program is Enterprise per ADR-0030 data model guidance); large scope increase |

## Consequences

**Easier**:
- PMs and POs have a structured intake queue that does not pollute the Task/Board views.
- Epic/story/feature/task hierarchy is supported at the intake level without changing the
  Task model.
- Sprint sovereignty is preserved: PM pull-down → project backlog; Sprint Planning →
  sprint assignment. Morgan's 🔴 blocker is resolved by design.
- Search before committing eliminates the PM's spreadsheet intake process.

**Harder**:
- Two rows in the database for logically related work until a `BacklogItem` is pulled
  (acceptable; the states are semantically distinct pre- and post-commitment).
- Mobile sync table list must include `backlog_item` as a new sync entity.
- Users expecting a cross-project program backlog (shared pool across all projects in a
  program) will discover the project-scoping constraint. Mitigate with clear UI labeling
  and a tooltip explaining that cross-program views require the Enterprise tier.

**Risks**:
- Naming tension: calling this the "program backlog" in UI while it is project-scoped may
  confuse PMs who expect it to span projects. Mitigation: label the tab "Program Backlog"
  with a subheading "Work proposed for this project".
- If `BacklogItem.priority_rank` becomes a manual drag-drop sort order, the re-ranking
  operation (shift all ranks after insert/remove) is O(n) on the project's backlog size.
  Acceptable at typical backlog sizes (< 500 items); if this proves slow, replace with a
  fractional ranking scheme (LexoRank or gap-based float).

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api`, `web`, `mobile` (sync table list)
- **Migration required**: Yes — new `BacklogItem` model in `packages/api/src/trueppm_api/apps/projects/`; requires `django.contrib.postgres` for `GinIndex`
- **API changes**: Yes — new `BacklogItemViewSet` at `/api/v1/projects/{pk}/backlog-items/` with a `/pull/` action; OpenAPI schema must be regenerated
- **OSS or Enterprise**: OSS — project-scoped intake. Cross-project program backlog is Enterprise.

### Durable Execution

1. **Broker-down behaviour**: `BacklogItem` CRUD is synchronous with no async side effects
   (N/A for a new outbox category). The `/pull/` action creates a Task, which triggers
   `enqueue_recalculate()` via `transaction.on_commit()` per ADR-0027. The pull itself
   uses the existing CPM recompute outbox — no new outbox row type is introduced.

2. **Drain task**: No new drain task needed. The CPM recompute triggered by pull reuses
   the existing `drain_schedule_requests` Beat task (ADR-0027).

3. **Orphan window**: N/A — `BacklogItem` pull is synchronous. CPM recompute uses the
   existing 10-minute orphan window from ADR-0027.

4. **Service layer**: Pull action must go through a new
   `projects/backlog_services.py::pull_to_project_backlog(item, pulled_by)`. This keeps
   the view thin and makes the pull logic testable and reusable (e.g., future batch-pull
   from a Sprint Planning modal).

5. **API response**: Pull is synchronous; response is `201 { "task": <TaskSerializer> }`.
   No `{"queued": true}` pattern — the Task creation itself completes in the request.
   CPM recompute is best-effort background (unchanged from all other Task create paths).

6. **Outbox cleanup**: N/A — no new outbox category. Existing `drain_schedule_requests`
   purge schedule applies to any CPM recompute rows created by pull.

7. **Idempotency**: `pull_to_project_backlog()` acquires `SELECT FOR UPDATE` on the
   `BacklogItem` row and asserts `status == PROPOSED` before creating the Task. A
   concurrent or duplicate pull attempt receives `409 Conflict`. The `pulled_task`
   OneToOne constraint provides a database-level guard as a second line of defence.

8. **Dead-letter / failure handling**: Pull is synchronous; if Task creation fails, the
   database transaction rolls back and `BacklogItem.status` remains `PROPOSED` — no
   dead-letter needed. CPM recompute failure handling is unchanged (ADR-0027 retry/DLQ).

---

## Erratum (2026-05-25) — Program-scoped implementation (#733 / #737 / #739)

The `## Decision` section above predates the Program entity and describes a
**project-scoped** `BacklogItem` (a `project` FK, `short_id` from
`Project.object_sequence`, endpoints under `/projects/{pk}/`). That draft is
**superseded**. The ADR header and Context already mark project-scoping as the wrong
scope; ADR-0070 (Accepted) confirms `BacklogItem.program`. The issues #733/#737/#739
are the authoritative current scope. This erratum records the design as actually built.

### 1. Scope — program, not project

`BacklogItem.program` is a `ForeignKey(Program, on_delete=CASCADE)`. The intake pool
lives at the program level so a PM can pull a feature into whichever of the program's
projects is ready for it. There is no `short_id` (programs have no `object_sequence`
counter; the ID is the UUID PK).

**Endpoints** are nested under the program:

```
GET/POST   /api/v1/programs/{program_pk}/backlog-items/
GET/PATCH/DELETE  /api/v1/programs/{program_pk}/backlog-items/{pk}/
POST       /api/v1/programs/{program_pk}/backlog-items/{pk}/pull/   body: {"project_id": "<uuid>"}
```

### 2. Sync participation — VersionedModel-readiness only; delta wiring deferred

#733 asks that `BacklogItem` "participate in the offline-sync delta." The only delta
endpoint (`ProjectSyncView`, `GET /api/v1/projects/{pk}/sync/`) is **project-scoped**
and structurally cannot reach a program-scoped row. This mirrors the existing,
deliberate decision for `Program`/`ProgramMembership` themselves (see
`sync/serializers.py::SyncProjectSerializer` docstring): program-level rows are *not*
fanned into the project delta; mobile uses REST online and cached project rows offline,
with a dedicated program-sync path deferred to a follow-up.

**Ruling**: `BacklogItem` extends `VersionedModel`, so it is **sync-ready** —
`server_version` bumps atomically on every save and `soft_delete()` sets
`is_deleted`/`deleted_version` (tombstone). Wiring it into a delta payload is deferred
to the same follow-up that owns program-level sync; fanning a program's items into each
member project's delta would duplicate rows and mis-scope items that aren't pulled into
any project yet. This is a deliberate deviation from the literal wording of #733's
"appears in sync push/pull payload" criterion, consistent with established precedent.
The #733 sync test therefore asserts the `VersionedModel` contract (server_version
bump on create/update, `soft_delete` tombstone) rather than the project-delta endpoint.
Follow-up tracked: program-level offline sync (Program, ProgramMembership, BacklogItem).

### 3. Field set (as implemented)

Minimal set satisfying #733 + the #737 pull/rollback mechanics. `acceptance_criteria`
from the original draft is deferred (no consumer until the #742 UI needs it; additive).

```python
class BacklogItem(VersionedModel):           # id (UUID), server_version, is_deleted, deleted_version
    program       = FK(Program, CASCADE, related_name="backlog_items")
    title         = CharField(512)
    description   = TextField(blank=True, default="")
    item_type     = CharField(choices=BacklogItemType, default=TASK)   # epic/feature/story/task
    status        = CharField(choices=BacklogItemStatus, default=PROPOSED, db_index=True)  # proposed/pulled/archived
    tags          = JSONField(default=list, blank=True)   # repo convention (Program.rollup_enabled_kpis et al.)
    priority_rank = PositiveIntegerField(null=True, blank=True)   # lower = higher priority; list ordering
    story_points  = PositiveSmallIntegerField(null=True, blank=True)  # mapped to Task.story_points on pull
    pulled_task   = OneToOneField(Task, SET_NULL, null=True, blank=True, related_name="source_backlog_item")
    pulled_at     = DateTimeField(null=True, blank=True)
    pulled_by     = FK(AUTH_USER_MODEL, SET_NULL, null=True, blank=True, related_name="+")
    created_by    = FK(AUTH_USER_MODEL, SET_NULL, null=True, blank=True, related_name="+")
    created_at    = DateTimeField(auto_now_add=True)
    updated_at    = DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            Index(fields=["program", "status"]),                      # list + filter
            GinIndex(fields=["title"], opclasses=["gin_trgm_ops"], name="backlogitem_title_trgm"),  # #739
        ]
```

`item_type`/`status` are `TextChoices`; `tags` is a JSON list (trigram search is on
`title` only, so no ArrayField is needed). All added columns are nullable or have a
default — no NOT NULL without default.

### 4. RBAC — program write **and** target-project write

"EDITOR+" in the issues maps to `access.models.Role.MEMBER` (100) — the first write
band. List/create/update/delete on `/programs/{pk}/backlog-items/` is gated by
`IsProgramMember` for read and `IsProgramEditor` (role ≥ MEMBER) for write.

The **pull** action is the boundary-crossing operation: it both reads the program item
and *writes a Task into a project*. It therefore requires write role on the **program**
(`IsProgramEditor`) **and** write role on the **target project** (the project's
membership role ≥ MEMBER), checked inside the action against `project_id`. A pull whose
`project_id` is not a member of the program is rejected (`400`); a caller lacking
project write is rejected (`403`); a non-`PROPOSED` item is rejected (`409`).

### 5. Pull mechanics (confirmed)

`projects/backlog_services.py::pull_to_project_backlog(item, project, actor)`, atomic:
1. `select_for_update()` the `BacklogItem`; assert `status == PROPOSED` else `409`.
2. Create `Task(project=project, name=item.title, notes=item.description,
   story_points=item.story_points, status=BACKLOG, sprint=None)`.
3. Set item `status=PULLED`, `pulled_task=task`, `pulled_at=now()`, `pulled_by=actor`; save (bumps `server_version` on both rows).
4. `transaction.on_commit`: `enqueue_recalculate(project.id, reason=TASK_CHANGE)` (existing CPM outbox — no new outbox category) **and** `broadcast_board_event(project.id, "task_created", {"id": str(task.id)})`.
5. Return `201 {"task": TaskSerializer(task).data, "backlog_item": BacklogItemSerializer(item).data}`.

**Rollback**: a `post_delete` signal on `Task` resets any `BacklogItem` whose
`pulled_task` was the deleted Task back to `status=PROPOSED` (`pulled_task`/`pulled_at`/
`pulled_by` cleared) so it can be re-pulled. The `OneToOne` on `pulled_task` uses
`SET_NULL` so Task deletion never cascades to the item.

The pull viewset uses `IdempotencyMixin` (header-based replay, ADR-0170); the
`status==PROPOSED` guard under `select_for_update` is the domain-level double-pull guard.

### 6. Trigram search (#739)

- A migration enables the `pg_trgm` extension via
  `django.contrib.postgres.operations.TrigramExtension` (first repo use) and adds the
  `GinIndex(opclasses=["gin_trgm_ops"])` on `title`. The extension operation runs
  **before** the `AddIndex`. Staged as a **separate** migration after the model-create
  migration so the #739 migration is "extension + index only," additive, and orders the
  extension ahead of the index.
- `?q=` filters with `title__trigram_similar` (the `%` operator — the form the
  `gin_trgm_ops` GIN index accelerates) and orders by an annotated
  `TrigramSimilarity("title", q)` so the closest title ranks first. The filter form
  matters: a scored `filter(similarity__gt=…)` cannot use the GIN index and would
  seq-scan (perf-check 🔴 caught this in review). Matching uses pg_trgm's
  `similarity_threshold` (default 0.3). Combinable with the `item_type`/`status`/`tags`
  filters and program-scoped via `get_queryset`; empty/absent `q` is a no-op. **Index on
  `title` only**; `description` search is deferred (acceptable per the Search API note).
- **Deployment note**: this is the repo's first `CREATE EXTENSION`. `pg_trgm` is a
  *trusted* extension on PostgreSQL 13+ (TruePPM requires 16+), so the application's own
  database owner can create it without superuser; the migration uses
  `CREATE EXTENSION IF NOT EXISTS` and is idempotent. Least-privilege installs that
  revoke `CREATE` on the database from the migration role must pre-create the extension.

### 8. Out of scope / follow-ups

- **`task.created` webhook on pull (deferred)**: the normal `TaskViewSet` create path
  fires a `task.created` outbound webhook (`_dispatch_webhooks`), but the pull path
  fires only the CPM recalc + WS `task_created` broadcast (the side-effects this ADR
  scoped). A backlog task created via pull is therefore not visible to webhook
  integrations until it is next edited. `_dispatch_webhooks`/`_task_webhook_payload` are
  module-private to `projects/views.py`; wiring them into the service cleanly needs a
  small refactor. Tracked as **#752** (broadcast-check 🟡). Other 🟡s noted in review:
  unindexed `tags__contains` scan and the default sort on the unindexed nullable
  `priority_rank` — both bounded by per-program scope + `PAGE_SIZE=50` and accepted for
  this MR.

### 7. ADR-0069 §Decision corrections (for future readers)

Within the superseded `## Decision` block: read `project` → `program`; ignore
`short_id`; the pull endpoint is `/programs/{pk}/backlog-items/{pk}/pull/` with a
`{project_id}` body (not `/projects/{pk}/...`); `IsProjectMember role ≥ EDITOR` becomes
`IsProgramEditor` on the program **plus** project-write on the pull target.

### Blocking questions

None. Both critical questions (scope, sync) are resolved above with codebase-backed
reasoning. The one deviation from an issue's literal wording (#733 sync) is recorded in
§2 and is consistent with the established program-sync-deferred precedent.

## Tracking

Tracking (follow-up): the `task.created` webhook on pull is deferred — not yet filed.
