# ADR-0686: The sync delta cursor is a per-project sequence, not `server_version`

## Status
Accepted

## Context

`GET /api/v1/projects/{pk}/sync/?since=` returns every synced row whose version is
strictly greater than `since`, and returns a `timestamp` the client is instructed
to adopt as its next `since`. The endpoint has shipped since 0.1 and is publicly
documented.

It silently drops edits (#2491). Two incompatible notions of "version" are being
compared:

- **`server_version` is a per-row save counter.** `VersionedModel.save()` does
  `UPDATE … SET server_version = server_version + 1 WHERE id = %s`
  (`apps/projects/models.py`). Every row starts at 1 and counts *its own* saves.
  Row versions are small, independent, and unordered relative to one another.
- **The checkpoint is a project-wide maximum.** `timestamp` is
  `MAX(server_version)` across the project's synced tables — computed by the
  14-table union `_snapshot_max_version`, or read from the `Project.last_sync_version`
  cache that ADR-0142 added and the `apps/sync/receivers.py` receivers maintain.

The delta filter `server_version__gt=since` therefore compares a per-row counter
against a project-wide maximum. That is not a valid ordering. A frequently-edited
row raises the checkpoint above every other row's counter, and those rows fall
out of the delta permanently — until they are saved enough times to climb past
it:

```
AFTER HOT EDITS:  hot.server_version=7  cold.server_version=1  watermark(since)=7
AFTER COLD EDIT:  cold.server_version=2  since=7  new_watermark=7  tasks_returned=[]
```

This is not a race or a rare interleaving; it is the steady state of any project
with unevenly-edited rows. It is silent in both directions — the client believes
it is fully synced, the server believes it delivered everything, nothing errors.
Because `_snapshot_max_version` unions 15 sources, a hot `Task` raises the bar for
`Risk`, `Sprint`, `Label`, `TimeEntry`, and `ProjectMembership` alike;
`ProjectMembership` is synced specifically so clients can enforce offline RBAC, so
a role change on a low-version membership row may never reach the client
enforcing permissions from it.

P3M layer: Projects (OSS) — the offline sync protocol.

## Decision

**Introduce a second version field. `sync_seq` is the replication cursor;
`server_version` keeps its per-row meaning unchanged.**

`VersionedModel` gains:

```python
sync_seq = models.BigIntegerField(default=0, editable=False)
```

`sync_seq` is allocated from a **per-project monotonic sequence** whose current
value is `Project.last_sync_version`. Every synced write allocates the next value
in one statement:

```sql
UPDATE projects_project SET last_sync_version = last_sync_version + 1
 WHERE id = %s RETURNING last_sync_version
```

The delta filter becomes `sync_seq__gt=since`, the keyset order becomes
`(sync_seq, id)`, and the response `timestamp` is `Project.last_sync_version`
read directly. Values are now totally ordered within a project, so `MAX` is a
meaningful checkpoint and `> since` is a correct delta.

`server_version` is untouched: it still counts that row's own saves, it is still
the optimistic-lock token, and it is still what serializers publish.

### Why the project row lock is load-bearing

Allocation `UPDATE`s the project row, so it holds that row's write lock until
commit. Concurrent synced writes to the same project therefore serialize on
allocation, which is what makes commit order equal allocation order. Without
that, a transaction could allocate 100, a later one allocate 101 and commit
first, and a pull between the two commits would return a `timestamp` of 101 and
permanently skip the row at 100 — the very bug this ADR fixes, reintroduced as a
race.

Under `READ COMMITTED` a concurrent *reader* does not block and does not see an
uncommitted allocation, so a pull always reports a checkpoint whose rows are all
committed.

**For a single write this adds no contention**: the ADR-0142 watermark receivers
already issued `UPDATE projects_project SET last_sync_version = Greatest(…)` on
every synced save, taking the same row lock. Allocation replaces that `UPDATE`;
it does not add one.

**For a batch the lock is held longer, and that is a real cost.** The old
`coalesce_watermark_bumps` deferred its single `UPDATE` to context exit, so the
project row was locked only for the tail of the transaction. The allocator cannot
defer — it must return a value to stamp on the first row — so two concurrent
uploads to the same project now serialize across the whole apply rather than just
its tail. We accept this: the serialization *is* the ordering guarantee, and the
alternative (a real Postgres sequence, which takes no row lock) cannot order
commits, which is the property the delta depends on. Worth measuring if
same-project concurrent upload latency becomes a complaint.

### Rows owned by more than one project

A `Calendar` may be shared by several projects, and one row can carry only one
`sync_seq`. It allocates from **every** owning project, stores the maximum, and
then raises every owning project's `last_sync_version` to at least that value.
The second step is what keeps the invariant `sync_seq <= last_sync_version` for
all owners — without it the shared row would sit permanently above one project's
checkpoint and be redelivered on every single pull.

### Every collection the delta serves must allocate — including graph edges

`Dependency` and `TaskRelation` carry no project FK, and an earlier draft of this
change left them out of the allocator on the reasoning that the delta "tracks a
dependency through its predecessor task's cursor". That reasoning is wrong, and
the way it is wrong is worth recording because it is the same failure this ADR
exists to remove.

Each collection is filtered on **its own** `sync_seq`. A model that never
allocates therefore sits at `0`, and `sync_seq__gt=since` is false for it at every
checkpoint — including a cold start at `since=0`, where the old
`server_version__gt=0` filter had always matched because `server_version` starts
at `1`. The effect was not a dropped edit but a permanently empty collection: an
offline client would receive tasks with no edges between them and could not run
CPM at all.

Both models therefore allocate through the endpoint the delta already scopes and
orders by — `predecessor` for a dependency, `source` for a relation — matching
their `(predecessor, sync_seq)` and `(source, sync_seq)` indexes. The general rule:
**if a model appears as a delta source, it allocates.** The models that legitimately
keep `sync_seq = 0` are exactly those outside the sync union.

The same rule catches the two `bulk_create` paths that bypass `save()`: the MS
Project importer's tasks *and* its labels each draw one value for the import.

### Batched writes share one value

Rows written in one batch may share a `sync_seq`: the delta is `> since` and the
checkpoint is the max, so a batch is either wholly before or wholly after any
client checkpoint. The `coalesce_watermark_bumps` context (added by #1527 to stop
a 500-row sync upload issuing 500 `UPDATE projects_project` statements) therefore
becomes an *allocate-once-per-batch* context, keeping that optimization intact.

### `Project.last_sync_version` becomes authoritative

It is no longer a cache of a derivable value, so the 14-table union
`_snapshot_max_version`, the `SYNC_WATERMARK_USE_COLUMN` fallback flag, and the
receiver-vs-union conformance test are all removed. This also retires the standing
maintenance burden ADR-0142 documented: "the model set here must mirror
`_snapshot_max_version` one-for-one."

Allocation gaps (a transaction that allocates and then rolls back) are expected
and harmless — `> since` skips missing numbers, and the checkpoint only ever
moves forward.

### Indexes

Every `(owner, server_version)` composite index that exists today to serve the
delta filter gains a `(owner, sync_seq)` twin — 18 of them. `sync_seq` carries no
`db_index=True` of its own, so the ~30 `VersionedModel` tables outside the sync
union get the column but no index.

### History records

`sync_seq` joins `server_version` in `_HISTORY_EXCLUDED_BASE`. Both are
server-owned counters rather than user-meaningful audit facts, and tracking
`sync_seq` would make it a changed field on *every* write — so the ADR-0217 merge
would name it in the `X-Merged-Concurrent-Fields` header a client reconciles its
cache from.

## Migration

One migration per app adds the column and the 18 indexes; a final data migration
(`sync/0004`, logic in `apps/sync/backfill.py` so a squash cannot orphan it) seeds
existing rows.

**Every synced row in a project gets the same value: the project's old watermark
plus one.** That is not a shortcut. Rows sharing a value is a property the design
already relies on for batched writes — the delta is `> since` and the checkpoint
is the maximum, so a set of rows sharing a value is either wholly before or wholly
after any client checkpoint. Assigning a distinct ordinal per row would cost a
per-project pass over 13 tables and buy nothing the delta can observe.

Because the value is the old watermark **plus one**, every `since` an existing
client holds is strictly below it. **The first pull after upgrade redelivers each
project once under upsert semantics — which also repairs whatever the old scheme
had already dropped — and every pull after that is a normal delta.** No client
change and no forced re-pull from zero.

Shared calendars take the maximum over their owners, and the final statement
raises every owning project's watermark to at least that value, so the
`sync_seq <= last_sync_version` invariant holds from the first pull onward.

The reverse migration zeroes the column but deliberately does **not** wind
`last_sync_version` back: it is monotonic by contract, and a watermark that is too
high only costs a client a pull that returns nothing, whereas one that moves
backwards would redeliver rows forever.

**That reasoning holds only while this ADR's code is running**, and the limit is
worth stating because it is not obvious. Reversing the migration *and* rolling the
code back to the pre-0686 delta re-arms #2491 at full strength: the old filter is
`server_version__gt=since` with `since` read from a `last_sync_version` this
migration inflated far above any per-row save count, so every existing row falls
out of the delta permanently. **The reverse migration is an escape hatch for
rolling forward to a fix, not a supported release rollback.** A genuine rollback
to pre-0686 code must also reset `last_sync_version` to
`MAX(server_version)` per project and accept that clients re-pull.

Adding a `BigIntegerField` with a constant default is metadata-only on
PostgreSQL 11+, so the column addition does not rewrite the ~47 tables. The index
builds and the seed are the real cost, and both are proportional to existing data.

## Alternatives considered

**Reallocate `server_version` itself from the per-project sequence** — the sketch
in #2491, and rejected on evidence found while implementing it. Two live
mechanisms read `server_version` as a per-row save count:

1. **ADR-0217 field-level merge.** `_concurrent_changed_fields`
   (`apps/sync/conflict.py`) computes `gap = current - base_version` and slices
   *exactly that many* `HistoricalRecords` rows, relying on the documented 1:1
   correspondence between a `server_version` increment and a history row. Under a
   project-wide sequence the gap becomes "project writes since", so the merge
   would read the wrong number of history rows — silently producing wrong merge
   decisions, or hitting the ambiguity guard and failing closed with 409s.
2. **The optimistic-lock base.** Clients send the `server_version` they last saw
   as `X-Base-Version`. Renumbering every row at migration time invalidates every
   offline client's cached base at once, so their next write is rejected as a
   conflict until they re-pull — a conflict storm on upgrade.

Repurposing the field means rewriting ADR-0217's merge arithmetic *and* accepting
that storm. A second field costs one column and leaves both mechanisms alone.

**A per-project change-log (outbox/CDC) table** — append `(project, seq, model,
row_id)` on every synced write and drive the pull from it. One new table instead
of a column on ~47, but it turns the pull into a log read plus 13 keyed fetches,
and introduces log retention as a new operational concern with a full-re-pull
cliff when the log is trimmed. Rejected: a version column on the row is the
standard shape for this (SQL Server `rowversion`, Salesforce `SystemModstamp`), it
leaves the pull queries structurally as they are, and it has no retention story to
get wrong.

**A monotonic timestamp cursor** — rejected on ties (two writes in the same
microsecond are unordered) and on clock movement; a sequence has neither problem.

**Postgres `SEQUENCE` per project** — sequences are non-transactional (gaps on
rollback are fine, but a sequence cannot be locked to order commits) and would
require DDL per project. The project row is already the serialization point.

## Consequences

- The delta pull is correct: a row edited once after another row is edited 100
  times is still delivered, and a hot `Task` no longer hides a `Risk`, `Sprint`,
  `Label`, or `ProjectMembership` edit.
- `timestamp` and `since` change scale. They were already opaque — the endpoint
  documents "adopt `timestamp` as the next `since`" and nothing else — so no
  client contract changes. Clients that compared `since` against a row's
  `server_version` were relying on the bug.
- **The upload response's `timestamp` moves to the cursor scale too.**
  `BatchApplyResult.max_version` tracked the highest `server_version` the batch
  touched and the upload returned it as `timestamp` — a value the client is told
  to adopt as its next `since`. On the old scheme that was already the wrong
  number line; keeping it would now hand back a save count where a cursor is
  expected. It tracks `sync_seq` instead. The per-row `server_version` in each
  `created`/`updated`/`deleted` entry is unchanged — that one *is* the
  optimistic-lock token.
- Writes that bypass `save()` must allocate explicitly, because nothing else
  will. Two paths were already silently undeliverable for exactly this reason and
  are fixed here: `apps/projects/inbound_sync.py` (a webhook write-through that
  bumps `server_version` with `F("server_version") + 1` in a `QuerySet.update()`)
  and the MS Project importer, which `bulk_create`s its tasks — the rows an
  offline client most wants after an import, and the ones the ADR-0142 receiver
  docstring already noted "neither the union nor the column counts". Both now
  draw one `sync_seq` for the batch. CPM recompute is deliberately left alone: it
  writes computed dates with `bulk_update` (ADR-0091) and must not advance a
  cursor no user edit moved.
- One extra `BigInteger` per row on every `VersionedModel` table, and 18 extra
  indexes on the synced ones.
- Allocation sorts the owning project ids before taking any lock. Only a shared
  `Calendar` locks more than one project row, but the resolver's queryset has no
  `ORDER BY`, so two concurrent saves of the same calendar could otherwise take
  the same two rows in opposite orders and deadlock.
- `deleted_version` is unchanged. It records the `server_version` at soft-delete
  as a GC marker and is not read by any delta query; tombstones are selected by
  the same `sync_seq__gt=since` filter and split on `is_deleted`.

## Out of scope — filed separately

- **`ProgramSyncView` has the same defect.** Its watermark is
  `MAX(server_version)` over the caller's `Program` and `ProgramMembership` rows,
  compared against each row's own counter. A program is not project-scoped, so the
  fix is a different shape (the accessible-program set is per-user, with no single
  owning row to sequence from). Filed as #2498.
- **The upload conflict base has the mirror-image defect.** `_row_base_version`
  (`apps/sync/upload.py`) falls back to the batch's `last_pulled_at` — a
  project-wide watermark — as the per-row conflict base. `_evaluate_conflict` then
  computes `instance.server_version <= base_version` and returns "no conflict", so
  the ADR-0217 field-level lost-update guard is inert for every row whose counter
  sits below the watermark, silently degrading to last-writer-wins. Filed as
  #2499.
