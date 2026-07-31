---
title: Offline sync architecture
description: The primitive underneath every mobile and offline-first client — VersionedModel, the two counters that answer two different questions, soft-delete tombstones, the per-project delta cursor, and mobile batch atomicity.
---

[Offline Sync](/features/offline-sync/) documents the WatermelonDB-compatible
delta protocol from a client's point of view — the endpoint shape, the pull/push
cycle, what a mobile app does with it. This page is the layer underneath that:
the model primitive every synced entity extends, why it carries two version
counters instead of one, how a delete becomes something a disconnected client
can learn about, and how a batch of offline edits commits as one unit.

## `VersionedModel`

Every entity a client can pull a delta of extends one abstract base:

```python
class VersionedModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    server_version = models.BigIntegerField(default=0, editable=False)
    sync_seq = models.BigIntegerField(default=0, editable=False)
    is_deleted = models.BooleanField(default=False, db_index=True)
    deleted_version = models.BigIntegerField(null=True, blank=True, editable=False)

    class Meta:
        abstract = True
```

Four of these five fields are old news to anyone who has read
[Architecture Overview](/architecture/overview/#versioned-models-and-soft-delete).
The fifth, `sync_seq`, is not cosmetic, and the gap between "four fields" and
"five fields" is itself a story worth telling, because it's the story of a real
bug in a shipped protocol.

### Why there are two version counters, not one

`server_version` is a **per-row save counter**. It increments by exactly one on
every save of that row, starting at 1. It answers "has this specific row
changed since I last saw it" — which is exactly the question an optimistic-lock
check needs.

That is a different question from the one a delta-sync endpoint needs
answered: "which rows, across an entire project, changed since I last synced."
Comparing a per-row counter against a project-wide watermark conflates the two
questions, and for a while, that's exactly what the sync endpoint did — the
watermark was `MAX(server_version)` across every synced table in the project.
The bug that forced the split (tracked as #2491, and the direct cause of
`sync_seq` existing) is worth stating precisely, because "add a version number"
sounds like it should obviously work and the reason it doesn't is not obvious:

```
A task saved 7 times:      task.server_version = 7
A risk saved once:         risk.server_version = 1
Project watermark:         MAX(server_version) = 7

Client's next `since` = 7. The risk (server_version=1) never clears
`server_version > since` again — not until it happens to be saved
at least 7 more times. It has silently fallen out of every future delta.
```

This is not a race or a rare interleaving. It is the steady state of any
project with unevenly-edited rows, and it is silent in both directions — the
client believes it fully synced, the server believes it delivered everything,
and nothing anywhere raises an error. Because the watermark unions every
synced table, a hot `Task` can hide a stalled `Risk`, `Sprint`, or —
significantly — a `ProjectMembership` row a client relies on to enforce RBAC
while offline.

The fix, `sync_seq`, is a second field with a narrower job: it is not a save
counter, it is a **replication cursor**, allocated from a strictly monotonic
per-project sequence (backed by `Project.last_sync_version`) rather than
derived from anything about the row itself:

```sql
UPDATE projects_project SET last_sync_version = last_sync_version + 1
 WHERE id = %s RETURNING last_sync_version
```

The delta filter is `sync_seq__gt=since`; the watermark returned to the client
is `Project.last_sync_version` read directly, no aggregation required. Because
every synced write allocates from the *same* project-scoped sequence,
`sync_seq` values are totally ordered within a project, and "greater than the
last checkpoint" becomes a question that actually has a correct answer.

### The program slice needs a different sequence

There is a second delta endpoint — `GET /api/v1/sync/user/programs/`, which
delivers the caller's `Program` and `ProgramMembership` rows — and the
per-project sequence cannot serve it. A program has no owning project to
allocate from, and the accessible set is **per-user**: the union of every program
the caller is a member of, which are independent of one another.

That matters because a scalar cursor over independent sequences reproduces the
identical failure one level up. Even giving each program its own counter, a
single `since` taken as the maximum across N programs lets a hot program's
sequence outrun a cold one's, and the cold program's edits fall out of the delta
— exactly the shape described above, with "program" substituted for "row".

So program-scoped writes allocate from **one installation-wide sequence**
instead:

```sql
UPDATE sync_programsyncsequence SET value = value + 1
 WHERE id = 1 RETURNING value
```

Every `Program` and `ProgramMembership` write in the installation is ordered
against every other one, which is what makes a scalar checkpoint meaningful
again. The watermark is that counter read directly — deliberately *not* scoped
to the caller's programs, since scoping it per caller is precisely what made it
a maximum-over-many-rows.

The cost is stated plainly rather than hidden: **program writes serialize
installation-wide**, because allocation holds the counter row's write lock until
commit. That lock is the correctness mechanism, not overhead — without it a
transaction could allocate 100, a later one allocate 101 and commit first, and a
pull between the two commits would skip 100 permanently. (A PostgreSQL
`SEQUENCE` would avoid the lock and reintroduce exactly that race, because
sequences are non-transactional.) The trade is acceptable here because program
writes are rare and administrative — create, rename, add or remove a member —
never a hot path or a bulk import.

`server_version` is untouched by any of this — it still counts a row's own
saves, and it is still what the conflict-detection mechanism below uses as an
optimistic-lock token. The two fields answer two different questions on
purpose, and the ADR that introduces `sync_seq` is explicit that **repurposing
`server_version` itself as the project sequence was considered and rejected** —
doing so would have broken the field-level merge mechanism's arithmetic (which
depends on `server_version` incrementing in exact lockstep with a row's history
records) and would have invalidated every offline client's cached optimistic-lock
value at the moment of migration, producing a conflict storm on upgrade. A
second column costs one field; reusing the first would have cost correctness
in two other places.

One consequence worth flagging rather than glossing over: a delta source that
never allocates a `sync_seq` — because a write path bypasses `save()` entirely,
such as a bulk import — sits permanently at `sync_seq = 0` and is filtered out
of every delta from a cold start onward. The fix is a rule, not a special case:
**any model that appears as a delta source must allocate `sync_seq` on every
write that reaches it**, including bulk paths.

### Atomicity: an `UPDATE ... RETURNING`, not a Django `F()` expression

Both counters are advanced the same way, and it is not the pattern you'd get
from `.update(server_version=F("server_version") + 1)` followed by a refetch.
It's a single raw-SQL statement that increments and reads back the new value
in one round trip:

```python
cursor.execute(
    f"UPDATE {table} SET {version_col} = {version_col} + 1 "
    f"WHERE {pk_col} = %s RETURNING {version_col}",
    [self.pk],
)
```

There is no `select_for_update` anywhere in this path, and none is needed: the
`UPDATE` statement itself takes the row's write lock as part of executing, and
the increment and the read-back happen inside that same locked statement, so
there is no read-then-write gap for a concurrent transaction to land in. A
second concurrent `UPDATE` against the same row simply blocks until the first
commits, then applies against the post-commit value — the lost-update race the
naive `F()` pattern would still be exposed to (read old value, compute new
value, write — with another writer's commit landing in between) cannot happen
here, because there is no separate read step.

This project's own history shows this was an evolution, not the original
design: the codebase's comments describe an earlier two-query version
(`update(F(...)+1)` then a refetch) that this single-statement form replaced
purely for round-trip cost — the lost-update guarantee itself did not change
between the two, because both rely on the same underlying row-lock semantics.

**What this page cannot tell you**, in the interest of not inventing a
rationale that isn't recoverable: no comment or ADR in this codebase weighs
this atomic-`UPDATE` approach against the alternative of explicit optimistic
locking — a client-supplied `If-Match`-style precondition checked with a
`SELECT ... FOR UPDATE` before the write. The two produce broadly equivalent
lost-update safety; this codebase settled on the atomic-statement form early
and the choice was never separately litigated in writing that survives. See
the [retroactive ADR for `VersionedModel`](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0710-versioned-model.md)
for the full account of what is and isn't recoverable about this design's
original reasoning.

### Soft delete: a flag on the row, not a separate tombstone table

A disconnected client cannot be told "this row no longer exists" by simply
removing the row — there is nothing left to sync. `VersionedModel` handles this
with two fields on the row itself, not a separate ledger table:

```python
def soft_delete(self) -> None:
    self.is_deleted = True
    self.save(known_exists=True)
    type(self).objects.filter(pk=self.pk).update(deleted_version=self.server_version)
```

`is_deleted` is what the sync pull actually keys on: a row's collection in the
response splits into `updated` (live) and `deleted` (an id list) purely by
testing this flag against the same `sync_seq__gt=since` filter every other row
in the delta uses. `deleted_version` is not part of that mechanism — it is
explicitly a garbage-collection marker only, recording what `server_version`
was at the moment of deletion so the retention job below has something to
compare an age field against; no delta query reads it.

This flag was purpose-built for exactly one job: giving a mobile client a
tombstone to reconcile against on its next pull. A user-facing Trash/Restore
capability was layered on top of the *same* mechanism considerably later, and
is a distinct feature built on infrastructure that predates it, not the reason
the infrastructure exists.

As with the atomic-increment question above, this page states plainly what it
cannot verify: no surviving comment or ADR explicitly weighs "a soft-delete
flag on the row" against "a separate tombstone table" as alternatives. The flag
approach is what shipped; whether a separate table was ever seriously
considered and rejected, or simply never came up, is not something this
codebase's history answers.

**Retention.** Tombstones are not permanent. A nightly job hard-deletes rows
that have been soft-deleted for longer than `TRUEPPM_TOMBSTONE_RETENTION_DAYS`
(default 90 days), scoped to live projects only. Getting this grace window
right took a real fix: `Task` and `Dependency` originally had no age field
registered for this job at all, which meant they were eligible for hard
deletion on the very next nightly run after a soft delete — a zero-day grace
window that directly contradicted the offline-first premise, since a mobile
client that missed exactly one nightly cycle would never receive the
tombstone and would carry a phantom row indefinitely. The fix added a
dedicated `deleted_at` timestamp, stamped only inside `soft_delete()`, giving
both models the same 90-day window `Risk` and `Sprint` already had.

### UUID primary keys

Every row's primary key is a client-assignable UUID
(`models.UUIDField(primary_key=True, default=uuid.uuid4)`), not a database
auto-increment integer. No single comment in this codebase states the reason
in so many words, but the reason is demonstrated by the code that depends on
it: the mobile upload path applies a `created` row by **upserting on its own
id** — a client generates the UUID for a new task *before* that task has ever
touched the server, submits it in a batch, and the server treats a matching id
as an idempotent re-create rather than a conflict. An auto-increment integer
PK cannot support this — two offline clients would race to claim the same next
integer, and neither could know its assigned id until the server responded.
UUIDs make client-side id generation collision-safe by construction, which is
exactly what an app that must create a task while on an airplane needs.

## Mobile batch atomicity

A batch of offline edits pushed from a mobile client has to behave as one
unit: a connection that drops mid-commit must not double-apply on retry, and
must not leave the batch half-applied with no way to know which half.

The mechanism is a durable idempotency envelope, not merely a Django
transaction wrapped around the apply logic. Every batch carries a
client-generated `client_batch_id`, and a `SyncBatch` row keyed on
`(project, actor_user, client_batch_id)` is the thing that actually makes a
retry safe:

1. If a completed, still-fresh `SyncBatch` row already exists for this key, its
   stored response is replayed verbatim — the batch is not re-applied.
2. Otherwise, the whole operation — creating the `SyncBatch` row, applying
   every row's create/update/delete, and marking the batch complete — runs
   inside one `transaction.atomic()` block. The `SyncBatch` row is created
   *first*, deliberately: its unique constraint on `(project, actor_user,
   client_batch_id)` is what serializes two concurrent submissions of the same
   batch at the database level, not application logic. A second concurrent
   insert simply blocks on that unique index until the first transaction
   resolves.
3. An `IntegrityError` on that insert — the case where a concurrent duplicate
   won the race — is caught and resolved explicitly: replay if the winner
   already completed, `409` "retry shortly" if it's still in flight, or a
   one-time retry if the winning row has expired.

Within the batch, rows apply in a fixed `created → updated → deleted` order,
so a batch that both creates a task and updates it in the same submission
resolves correctly regardless of client-side ordering. The whole batch is
atomic at the transaction level, with one deliberate, documented exception: a
single row whose edit conflicts with a concurrent server-side change (below)
is skipped and reported back as a conflict, without aborting the rest of the
batch.

## Conflict resolution: last-writer-wins by default, explicit detection where it matters most

The baseline behavior for every `VersionedModel` is plain last-writer-wins: a
stale write simply overwrites, with no error and no signal to either party.
That is a real, documented trade-off, not an oversight — and it is explicitly
scoped as v1 behavior for the mobile batch path, with richer conflict handling
named as deliberately out of scope at the time.

For the three models a project's collaborators are most likely to edit
concurrently — `Task`, `Project`, `Risk` — a sharper mechanism sits in front of
plain LWW. A client that wants conflict detection sends the `server_version`
it last saw as a request header. If the row's current version is no higher,
there's no conflict. If it is higher, the server reconstructs exactly which
fields changed in the interim — by walking the precise number of history
records the version gap implies — and checks whether those fields overlap the
incoming write:

- **Disjoint changes** (the concurrent writer touched different fields) — the
  write proceeds, and the response names what the *other* writer changed, so
  the client can merge rather than silently lose that context.
- **Overlapping changes** — the write is refused with a structured `409`
  naming the conflicting fields and both versions of the disputed values,
  rather than silently discarding either side.

A client that never sends a base version gets plain LWW — this mechanism is
opt-in and additive, not a replacement for the default. And it is worth being
honest that the mobile batch path's own version of this check has a known,
documented gap: the batch conflict base falls back to the *project-wide*
sync watermark rather than a true per-row baseline when a row doesn't carry
its own version, which means the field-level guard degrades silently back to
last-writer-wins for any row sitting below that watermark. This is filed and
acknowledged, not fixed as of this writing — the honest posture toward it is
that conflict detection here is real but not yet airtight everywhere it's
exposed.

## Where to go next

- [Offline Sync](/features/offline-sync/) — the endpoint shapes, the pull/push
  cycle, and what a mobile client actually does with all of this.
- [Broadcast and webhook delivery pipeline](/architecture/broadcast-pipeline/) —
  how a change that just landed through this sync path also reaches a live,
  connected client in real time.
- [Architecture Decision Records](/architecture/decisions/) — ADR-0082 (mobile
  sync upload batch atomicity), ADR-0142 and ADR-0686 (the sync watermark, and
  why it moved from a `server_version` aggregate to a dedicated cursor), and
  ADR-0217 (conflict detection beyond plain last-writer-wins) are the primary
  records behind this page, alongside the [retroactive `VersionedModel`
  ADR](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0710-versioned-model.md).
