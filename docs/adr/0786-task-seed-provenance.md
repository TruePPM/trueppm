# ADR-0786: Task seed provenance — five columns on `Task`, and `edited_at` is stamped by `save()` and opted out of, never opted in to

## Status

Accepted — proposed 2026-08-04 for #2730 (0.4); child of epic #2740 ("the way in").
Prerequisite for B4 (bulk-delete of untouched seeded rows) and for the template
adoption link in #2729.

## Context

The seeded project landing offers **Delete untouched rows (19)** for seven days after a
template or import writes a skeleton. That offer is the only reason accepting a seeded
skeleton is safe: a team that keeps three phases and bins the rest must lose nothing they
typed. Today no model carries the information needed to compute it — there is no record
of which rows a machine wrote, what wrote them, when, or whether a human has touched them
since.

Three premises in the issue were checked against the code before deciding anything. One
of them moved, and it changes the design.

### 1. `Task` has no `created_at` and no `updated_at` at all

The issue argues `updated_at` is not a substitute. It is not — but not for the stated
reason, and the real reason matters because it decides where the signal comes from.

### 2. The scheduling engine does **not** go through `save()` — it never did

The issue's premise is that "the scheduling engine writes computed dates to every seeded
row immediately, so every row is modified before the user has seen it." CPM persistence
is `Task.objects.bulk_update(...)` (`apps/scheduling/tasks.py:1227`, `:1656`), which
bypasses `VersionedModel.save()` deliberately and by documented design — ADR-0091, with
a "do NOT change the call sites to `save()`" comment at `tasks.py:855`, because bumping
`server_version` on every recalc would flood every connected client with sync deltas.
The `.update()` at `tasks.py:1351` bypasses it for the same reason.

So a hypothetical `auto_now` `updated_at` on `Task` would in fact have survived CPM
untouched. The premise is wrong; the conclusion is still right, for a different and
stronger reason: **`updated_at` has no null state.** "Never touched by a human" is not
"touched a long time ago" — it is a distinct fact, and only a nullable field can carry
it. A row seeded and never opened must be distinguishable from a row seeded and edited
one second later, and `auto_now` collapses both to a timestamp.

This premise moving is load-bearing for the rest of the ADR: because CPM already sits
outside `save()`, `save()` is a usable proxy for "a human caused this write", and the
opt-out list below is short rather than open-ended.

### 3. Every `Task.save()` site in the projects app is human-caused

Surveyed: `product_backlog_services` (DoR, priority rank, sprint rank),
`poker_services` (story points), `retro_services` (sprint promotion), `services`
(sprint assignment), `inbound_sync`, `TaskViewSet`, `TaskBulkView` — the Designer batch
endpoint saves **per row** via `ser.save()` (`task_bulk.py:299`, `:328`, `:384`,
`:708`), so paste-many (#2724) and every other authoring path already flow through
`save()`. The offline sync upload does too (`apps/sync/upload.py:315`, `:327`, `:375`).

None of these is a background recompute. That is the whole finding: the set of writes
that reach `save()` and are *not* attributable to a person is small and enumerable,
whereas the set of code paths that could create a task is not.

## Decision

### 1. Five nullable columns on `Task`, not a side table

```
source_kind     CharField(choices=TaskSource, default=HAND)   # what wrote the row
source_id       UUIDField(null=True)                          # template / import job / paste batch id
source_version  CharField(max_length=32, blank=True)          # template version; "" otherwise
seeded_at       DateTimeField(null=True)                      # non-null iff machine-written in bulk
edited_at       DateTimeField(null=True)                      # last human-caused write
```

`TaskSource` values: `hand`, `template`, `seed_import`, `csv_import`, `msproject_import`,
`jira_import`, `paste`. A row whose `source_kind` is `hand` has `seeded_at IS NULL`,
`source_id IS NULL`, `source_version = ""` — the default state, so no backfill of
existing rows is required beyond the column defaults.

### 2. The predicate is `seeded_at IS NOT NULL AND edited_at IS NULL`

Not `edited_at > seeded_at`. Once a human touches a seeded row it is out of the set
permanently, and a null is cheaper and less ambiguous than a comparison. Hand-authored
rows are excluded by the first clause without needing the second to mean anything for
them.

The seven-day window is `seeded_at >= now() - 7 days`, applied by the caller, not baked
into the predicate — B4's delete action and the landing count need the same set, and the
"% of seeded rows still present at 14 days" measurement the design proposes needs the
same predicate over a different window.

A single partial index serves all three:

```python
models.Index(
    fields=["project", "seeded_at"],
    condition=models.Q(edited_at__isnull=True, is_deleted=False),
    name="task_untouched_seeded_idx",
)
```

### 3. One definition, in a manager method — never re-derived at a call site

```python
Task.objects.untouched_seeded(project, within=timedelta(days=7))
```

The landing count, the outline margin tick, B4's delete action and Epic E's divergence
digest all call this. They do not each write the filter.

This is not fastidiousness. The closest precedent in this codebase is capacity: two
call sites that looked like they detected the same fact re-derived it independently, one
of them read `Task.assignee` instead of `TaskResource.units`, and a whole class of load
became invisible with no error anywhere. A predicate that decides what to **delete** gets
one implementation.

### 4. `edited_at` is stamped by `Task.save()` by default; system writes opt **out**

`Task.save()` sets `edited_at = timezone.now()` unless the caller passes
`system_write=True`. Bulk paths (`bulk_create`, `bulk_update`) never reach `save()` and
therefore never stamp — which is correct in both directions: seeders set `seeded_at` on
the instances they construct, and CPM must not stamp at all.

The direction of the default is the decision, and it is chosen for its failure mode:

| Mistake | Consequence |
|---|---|
| A system write path forgets `system_write=True` | The row looks edited → it is **retained** |
| A human write path bypassed `save()` | The row looks untouched → it is **deleted** |

Deleting a row someone typed into is unrecoverable trust damage; keeping a row they did
not is a mildly disappointing count. So the default must be the one whose failure lands
in the top row, and the second row must be closed structurally rather than by vigilance —
which §3 above does by making `save()` the only write path a human edit can take, and
which is already true today (finding 3 in Context).

Opt-out sites are enumerated in the implementation and each carries a one-line comment
naming why the write is not attributable to a person.

### 5. Server-owned: read-only on every serializer, including the sync upload

All five fields are `read_only` on `TaskSerializer`, `SyncTaskSerializer` and the
Designer batch serializer. A client that could set `edited_at` could make a row it never
touched survive the sweep, or — worse — clear it and make a row it *did* touch eligible
for deletion. `seeded_at` and `source_*` are equally server-owned: provenance a caller
asserts about itself is not provenance.

All six ride `TaskSerializer`, which `TaskViewSet` uses for **both** list and detail —
there is no list/detail split on tasks today (`apps/projects/views.py:4618`), and
introducing one for the sake of two fields is a larger change than this issue
justifies. The cost is that `source_id` (a UUID) and `source_version` (≤32 chars)
appear on every row of the hottest read in the product even though only the
divergence digest reads them, one row at a time. If the task list payload is ever
split, those two are the first candidates to drop from the list half.

### 5a. The untouched verdict is published as a positive boolean, because a null does not survive MCP

`is_untouched_seed` — a read-only boolean on `TaskSerializer`,
`seeded_at is not None and edited_at is None`. It reads two columns already loaded and
costs no query.

This exists because of a concrete failure found by the `ai-review` gate, not for
symmetry. The MCP server compacts every payload through `_compact_mapping`
(`packages/mcp/src/trueppm_mcp/tools.py:65`), which **drops keys whose value is `None`
or `""`** to save tokens. The untouched fact as designed in §2 is carried *by* a null:
`edited_at IS NULL`. So an agent calling `get_task` on a seeded, untouched row would
receive a payload with no `edited_at` key at all, and could not distinguish "this row has
never been edited" — the entire signal — from "this MCP version does not publish
`edited_at`". The same compaction drops `source_version: ""` on non-template rows.

Encoding a load-bearing fact in the absence of a key is unreadable to the one consumer
that strips absent keys. The predicate stays in the manager method (§3) as the single
definition; this field is that predicate's answer, published positively so it survives
the wire.

The seven-day window is deliberately **not** folded into this field. The field answers
"was this row machine-written and never touched"; the window is a caller policy that
differs between B4's sweep (7 days) and the retention measurement (14 days), and baking
one of them into a field name would make the other read as a lie.

### 6. All five are excluded from `HistoricalRecords`

Added to `_HISTORY_EXCLUDED_TASK`, alongside `deleted_at` and the CPM outputs.

This is not a size optimization. ADR-0217's field-level merge slices exactly
`current - base_version` history rows and compares fields to decide what conflicts.
`edited_at` changes on **every** human write by construction, so tracking it would name
it in every merge header and make it a permanent phantom conflict on every concurrent
edit. `seeded_at` and `source_*` are immutable after the write that sets them and have
nothing to contribute to an audit trail.

### 7. RBAC is already decided

ADR-0773's matrix lists "Bulk-delete untouched seeded rows" as **Admin+** (Owner and
Admin only; Member and Scheduler cannot). This ADR adds no new capability — the read
fields ride the existing task read permission, and the delete action they enable is
B4's, gated where ADR-0773 already put it.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Five columns on `Task`** (chosen) | The untouched predicate is one partial index on one table; the outline read gets `source_kind`/`seeded_at` with no join; nulls cost a bitmap bit, not a column width, so hand-authored rows are nearly free | Widens an already-wide hot table by five columns |
| A `TaskProvenance` side table (OneToOne) | Only seeded rows occupy space; keeps `projects_task` narrow | `edited_at` must stay on `Task` regardless (stamping it from `save()` into a second table doubles the write on the hottest path), so the predicate would span a join and no single index could serve it; and a new **synced** table costs a `sync_seq` allocator, tombstone reaping, a WatermelonDB schema migration and its own RBAC — far more than five nullable columns |
| A single `source_ref` JSONField | Matches the issue's wording; one column | Not cheaply indexable, invites unbounded blobs, and pushes a JSON column into the mobile schema; the three facts inside it are fixed and small, so normalizing them costs nothing |
| Derive "edited" from `HistoricalRecords` | No new columns; the data already exists | A history row is written on every `save()` regardless of which fields changed, so "was this a human edit" requires comparing consecutive rows across ~40 columns **per task** — O(rows × history) for a number rendered on a landing page. It also makes the predicate depend on the history retention window, which is a different policy with different owners |
| `updated_at` with `auto_now` | Trivial | No null state — "never touched" and "touched long ago" collapse to the same value, and the first is the entire question |
| Opt **in** to stamping `edited_at` at each user write path | Explicit; no default magic | Fails in the dangerous direction — a forgotten stamp deletes a row the user edited. Inverts the table in §4 |

## Consequences

**Easier**

- "Delete untouched rows (N)" becomes a single indexed count, and B4 can be built without
  touching the model layer.
- The seeded-row tick in the outline margin is a field read, not a derivation.
- #2729's "adoption records a versioned link" is `source_kind=template` +
  `source_id` + `source_version`, already carried per row rather than only on the project.
- The "% of seeded rows still present at 14 days" measurement — which the design says
  will settle whether templates should shrink to phases and gates only — becomes
  answerable from the database instead of unanswerable.
- Epic E's divergence digest gets its input for free.

**Harder**

- Every future bulk task-writing path must decide its `source_kind` and stamp
  `seeded_at`. A new importer that forgets both produces rows that look hand-authored —
  which is the safe failure (they are never swept) but silently omits them from the
  divergence digest.
- Five more columns on `Task` to carry through the sync serializers and the mobile
  schema.

**Risks**

- *A human write path that bypasses `save()`.* This is the one failure that deletes real
  work. It is closed today (Context finding 3) and must be re-checked whenever a bulk
  write path is added to the authoring surface. The regression test asserts it directly:
  a `TaskBulkView` update of a seeded row must leave it out of `untouched_seeded`.
- *Clock skew on the seven-day window.* Immaterial — the window is generous and the
  action is user-initiated and reversible via task trash (ADR-0689).
- *`source_id` is not a foreign key.* Deliberate: it points at four different tables
  (`CsvImportRequest`, `ProgramImportJob`, the MS Project job, and #2729's template) and
  a generic relation would buy referential integrity at the cost of a join on the hot
  read. A dangling `source_id` degrades to "we know a template wrote this, we no longer
  know which" — acceptable, and the reason `source_kind` is a separate column rather
  than being inferred from what `source_id` points at.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: api (models, serializers, seed importer, csvimport, msproject,
  jiraimport), web (read-only surfacing follows in B4/#2733)
- **Migration required**: yes — one migration, five nullable columns plus one partial
  index. No data migration: existing rows take the column defaults and read as
  hand-authored, which is the truthful answer for every row written before this shipped.
- **API changes**: yes — five read-only fields on the task read surface (two on list,
  five on detail). No new endpoint; the delete action is B4.
- **OSS or Enterprise**: OSS. Provenance of rows inside one project is a
  Programs-and-Projects fact; nothing here aggregates across projects.

### Durable Execution

1. **Broker-down behaviour**: N/A — this change has no async side effects. It adds
   columns and stamps them synchronously inside the request or job that already writes
   the row. The importers that set `seeded_at` are themselves already-durable Celery
   jobs (ADR-0726) and their durability posture is unchanged.
2. **Drain task**: N/A — no new category of async work.
3. **Orphan window**: N/A — no drain.
4. **Service layer**: `Task.objects.untouched_seeded()` (manager method) is the single
   definition of the set. B4's delete action will call it; nothing else re-derives it.
5. **API response on best-effort dispatch**: N/A — all writes here are synchronous.
6. **Outbox cleanup**: N/A — no outbox rows are written.
7. **Idempotency**: Stamping is idempotent by construction. `seeded_at` is written once,
   by the bulk insert that creates the row, and never updated — a re-run of an importer
   creates new rows rather than re-stamping old ones. `edited_at` is last-write-wins on a
   monotonic clock, so a duplicated save produces the same value or a later one; neither
   changes the `IS NULL` predicate that matters.
8. **Dead-letter / failure handling**: N/A — no task to fail. A partial importer failure
   leaves the rows it did write correctly stamped, which is the desired outcome: those
   rows are genuinely seeded and genuinely untouched.
