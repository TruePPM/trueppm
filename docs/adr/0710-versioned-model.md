# ADR-0710: `VersionedModel` — the sync primitive (retroactive)

## Status
Accepted (retroactive) — documents a mechanism that has been in production since
TruePPM's earliest offline-sync work (0.1) and is currently extended by every
synced model in `packages/api`. Written 2026-07-29, filed against issue #2546.

## Why this ADR exists, and why it is retroactive

`VersionedModel` (`apps/projects/models.py`) is the abstract base every synced
Django model extends — it is, in a literal sense, the foundation the offline
sync protocol, the mobile client, and a large share of the RBAC and
conflict-resolution machinery are built on. `grep -rl "class VersionedModel"
docs/adr/` returns nothing: across more than 160 numbered ADRs, several of
which extend, amend, or depend on this primitive (ADR-0082, ADR-0142, ADR-0197,
ADR-0217, ADR-0686, and others), none of them is the ADR that decided
`VersionedModel` should look the way it does. The decision was made before the
project's ADR discipline caught up to it, or was made informally enough that
no record survives.

This ADR closes that gap **retroactively** — reconstructed from the current
implementation, its docstrings, and the ADRs that build on top of it, rather
than from a design discussion that happened at the time. Section by section
below, this ADR is explicit about which claims are **recovered** (stated
somewhere in code or in a later ADR, and cited) versus **not recoverable**
(the original reasoning is not written down anywhere this investigation could
find, and this ADR says so rather than inventing a plausible-sounding
justification). Treat the "not recoverable" callouts as load-bearing — a
future reader should not mistake this document's own reconstruction for
contemporaneous design intent.

## Context

Every entity a client needs to sync — pull a delta of, or in the mobile case,
push offline edits for — needs three things no plain Django model gives it for
free: a primary key a client can safely generate before ever touching the
server, a way to detect that its own copy of a row is stale, and a way to
learn that a row it used to have has since been deleted, without the row
still existing to be fetched.

`VersionedModel` is the answer, and as of this writing it carries five fields:

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

`sync_seq` is a later addition (ADR-0686, itself prompted by issue #2491) — the
original shape, and the one every other ADR referencing "the four
`VersionedModel` fields" assumes, was `id` / `server_version` / `is_deleted` /
`deleted_version`. This ADR documents the primitive as it stands today,
including that later addition, since a reader following links from
[Offline sync architecture](/architecture/offline-sync/) or the sync ADRs
needs the current shape, not a historical snapshot. ADR-0686 is the correct
place to read the full story of why `sync_seq` was added; this ADR does not
repeat that account, only notes it belongs to `VersionedModel`'s history.

## Decision (as reconstructed)

Three design choices make up the primitive. Each is stated below with what is
recoverable about its rationale, and what is not.

### 1. UUID primary keys, not auto-increment integers

**Recovered, by inference from dependent code, not from a stated rationale.**
No comment on `VersionedModel` itself explains why `id` is a client-assignable
UUID rather than a database-assigned integer. The reasoning is demonstrable
from the code that depends on the choice, even though it is not written down
as a sentence anywhere: the mobile batch-upload path applies a `created` row
by **upserting on the client-generated id** — a mobile client generates a
task's UUID locally, before that task has ever reached the server, and the
apply logic treats a matching id in the `created` bucket as an idempotent
re-create rather than a fresh insert. An auto-increment integer PK cannot
support this: two clients working offline would independently claim the same
next integer, with no way to know the collision until the server responded,
which is precisely the scenario where the server *isn't* reachable. A
client-generated UUID makes id generation collision-safe without any
coordination with the server — which is the property an app that must create
a task with no connectivity actually needs.

**Not recoverable:** whether the original author considered and rejected any
alternative (e.g. a server-assigned integer plus a separate client-side
temporary-id reconciliation step, which some offline-sync systems use
instead) is not stated anywhere this investigation found. This ADR does not
claim that alternative was weighed and rejected — only that the UUID choice
is the one shipped, and that it is coherent with how the upload path actually
works.

### 2. Atomic increment of `server_version` via `UPDATE ... RETURNING`, not optimistic locking with a separate check-then-write

**Recovered in part.** The mechanism itself is fully recoverable from code and
its own comments: `server_version` is advanced by a single raw-SQL statement
executed inside `save()` —

```sql
UPDATE <table> SET server_version = server_version + 1
 WHERE id = %s RETURNING server_version
```

— rather than by Django's `.update(server_version=F("server_version") + 1)`
followed by a separate refetch, and rather than an application-level
`SELECT ... FOR UPDATE` / read-modify-write sequence. The codebase's own
comments state this single-statement form **replaced** an earlier two-query
version of the same idea (`.update(F(...) + 1)` then a `values_list().get()`
refetch), and are explicit that the change was made to remove a redundant
round trip, not to fix a correctness gap — the lost-update guarantee is stated
to be unchanged between the two forms, because both rely on the same
underlying fact: a Postgres `UPDATE` takes the target row's write lock as part
of executing, so a second concurrent `UPDATE` against the same row blocks
until the first commits, and there is no gap between reading the current
value and writing the incremented one for another transaction to land a
conflicting write into.

**Not recoverable:** why this shipped as an atomic single-statement increment
in the first place, rather than the more commonly-described "optimistic
locking" pattern — a client-supplied expected-version header, checked with an
application-level `SELECT ... FOR UPDATE` or a conditional `UPDATE ... WHERE
version = %(expected)s`, failing the request if the precondition doesn't hold
— is not stated anywhere in this codebase's comments or in any ADR this
investigation found. Both approaches give a valid, monotonically increasing
per-row version counter under concurrent writes; they differ in *what happens
to the second writer* (the atomic-increment form always applies the second
write, silently, on top of the first — true last-writer-wins at the storage
layer, with any richer conflict handling built as a layer on top, per
[Offline sync architecture](/architecture/offline-sync/#conflict-resolution-last-writer-wins-by-default-explicit-detection-where-it-matters-most);
the conditional-`UPDATE` form would instead reject the second writer outright
unless the application chose to retry it). This ADR records that TruePPM
chose the former and built conflict detection as an opt-in layer on top,
rather than making rejection-on-conflict the default at the storage layer —
but not why that choice was made over the alternative, because no
contemporaneous record of that decision survives.

### 3. Soft-delete tombstone (`is_deleted` + `deleted_version` on the row), not a separate tombstone table

**Recovered in part.** What the flag is *for* is recoverable and stated
plainly in a later ADR extending the same mechanism (ADR-0689): the
`is_deleted`/`deleted_version` pair's original purpose was giving a mobile
client something to reconcile a deletion against on its next sync pull — a
row a client already has, but which no longer exists server-side, has to
appear as *something* in a delta response, and a flag on the otherwise-normal
row is what makes that possible without a second query against a second
table. A user-facing Trash/Restore capability (ADR-0202, ADR-0689) was built
**on top of** this same flag considerably later, for reasons unrelated to
sync — but that later use does not change what the mechanism was built for
originally.

**Not recoverable:** whether "a flag on the row" was chosen over "a separate,
append-only tombstone table keyed by id" as a deliberate trade-off, or simply
never considered as an alternative, is not stated anywhere in this codebase's
history. Both are established patterns for this problem (a flag-on-row is
simpler to query and requires no join; a separate table can outlive the
original row's schema and doesn't leave a permanently-set boolean column on
every live row). This ADR records the trade-offs each would carry, for a
future reader deciding whether to keep the current shape, without claiming
either was explicitly weighed against the other at the time.

## Alternatives considered

Presented here as the alternatives a reviewer would naturally raise against
each of the three decisions above — not as alternatives this codebase's
history shows were actually discussed and rejected, except where explicitly
marked as recovered from ADR-0686.

| Decision | Shipped | Alternative | Why the alternative is plausible, and what would have to be true for it to win |
|---|---|---|---|
| Primary key | Client-generated UUID | Server-assigned integer + client temp-id reconciliation | Smaller keys, familiar auto-increment ergonomics; would require every offline-created row to carry a temporary local id reconciled to a server id on next sync, adding a mapping layer the current design has no need for. |
| Version counter mechanism | Atomic `UPDATE ... RETURNING` (true LWW at the storage layer) | Optimistic locking: conditional `UPDATE ... WHERE version = expected`, rejecting a stale writer outright | Would make every write conflict-aware by default rather than opt-in; the current design instead makes conflict *detection* an explicit, opt-in layer (`X-Base-Version`) on top of an always-succeeding storage write — recovered as the actual shipped behavior, not as a rejected alternative with a stated reason. |
| Tombstone shape | Boolean flag + version marker on the same row | Separate `Tombstone(model_name, object_id, deleted_at)` table | A separate table avoids a permanently-set column on every live row and could survive a schema change to the original model; the flag-on-row form is simpler to query (no join) and is what the current delta-pull and retention-reaper code is built against. |

## Consequences

### What holds up well
- The two-counter split (`server_version` for per-row optimistic-lock state,
  `sync_seq` for the project-wide delta cursor) has, since ADR-0686, made the
  delta pull correct in a way the original single-counter design was not —
  see [Offline sync architecture](/architecture/offline-sync/#why-there-are-two-version-counters-not-one).
- UUID primary keys make offline-first creation actually work: a client can
  generate a fully-formed, uniquely-identified row with zero network
  round-trips, and the server-side upsert-by-id logic treats that as a normal
  case rather than a special one.
- The soft-delete flag has proven reusable well beyond its original purpose —
  the Trash/Restore feature is a second consumer of the same mechanism years
  after it was introduced for sync, at no cost to the sync mechanism itself.

### What is a known, load-bearing gap
- The rationale gaps flagged above (optimistic-locking-vs-atomic-increment;
  soft-delete-flag-vs-separate-table) are not merely undocumented — they are
  genuinely unrecoverable from this codebase's history, and a future
  contributor revisiting either decision should not assume the current shape
  was chosen after weighing the alternative in this table. It may not have
  been.
- The retention/grace-window story for tombstones (ADR-0197) shows this
  primitive's design was refined reactively at least once, after a real gap
  (`Task`/`Dependency` tombstones with no grace window at all) reached
  production. That is evidence the original shape was not fully specified
  against the offline-first requirement from day one — it was completed
  incrementally.

### Risks
- Because the atomic-increment mechanism makes every write succeed at the
  storage layer regardless of staleness, any code path that extends
  `VersionedModel` **without** also adopting the opt-in conflict-detection
  layer (`X-Base-Version` / the field-level merge mechanism) gets silent
  last-writer-wins by default. This is a correct reading of the current
  design, not a bug — but it means "does this model need conflict detection"
  is a question every new synced model has to ask explicitly; the base class
  does not surface it.

## Related ADRs

- **ADR-0082** — Mobile Sync Upload — Transactional Batch Atomicity: the batch
  envelope (`SyncBatch`) that applies rows through `VersionedModel`'s save path
  as one durable unit.
- **ADR-0142** — Sync watermark column and CPM working-day index: the first
  watermark optimization, since superseded in part by ADR-0686.
- **ADR-0686** — The sync delta cursor is a per-project sequence, not
  `server_version`: introduces `sync_seq`, and is the fullest surviving record
  of why the two-counter split exists.
- **ADR-0197** — Task/Dependency tombstone retention window: the grace-window
  fix to the reaper that consumes `is_deleted`/`deleted_version`.
- **ADR-0217** — Sync conflict hardening: the opt-in, field-level
  conflict-detection layer built on top of `server_version`.
- **ADR-0689** — Task Trash list and soft-delete recovery posture: documents
  that the soft-delete flag's *original* purpose was sync tombstones, and that
  user-facing recovery was layered on afterward.

See also [Offline sync architecture](/architecture/offline-sync/) for the
consolidated, explanation-level account of how these pieces fit together for a
reader who wants the current design rather than its history.
