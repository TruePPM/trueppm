# ADR-0747: An installation-wide sequence for the program sync cursor

## Status
Accepted — status corrected 2026-08-02 after ADR audit (#2685, verified: `apps/sync/sequence.py`, `apps/sync/models.py`, migration `0005_program_sync_sequence.py`, originally proposed 2026-07-31 for #2498 in 0.4).

## Context

`GET /api/v1/sync/programs/` (`UserProgramSyncView`) has the same defect ADR-0686
fixed on the project endpoint: **a per-row counter compared against a maximum taken
across many rows.**

`_watermark` (`apps/sync/views.py`) returns

```python
max(
    Program.objects.filter(id__in=accessible_ids).aggregate(m=Max("server_version"))["m"] or 0,
    ProgramMembership.objects.filter(program_id__in=accessible_ids).aggregate(m=Max("server_version"))["m"] or 0,
)
```

and the delta reads `Program.objects.filter(id__in=accessible_ids,
server_version__gt=since)`.

`server_version` counts **one row's own saves**. A frequently-edited program raises
`since` above every other program's row counter, and those rows stop being
delivered — permanently, because the cursor only ever moves forward. This is
**data loss in a documented offline protocol**: a `ProgramMembership` role change
on a low-version row never reaches a client enforcing offline RBAC from it.

The defect is already acknowledged in a comment at the call site, which names this
issue. P3M layer: **Programs and Projects** (OSS).

### Why ADR-0686 does not extend to this slice

ADR-0686 gives each **project** a monotonic sequence and allocates `sync_seq` from
it, so `MAX` over one project is a valid checkpoint. That works because every
synced row has exactly one owning project.

The program slice has no such owner. The accessible set is **per-user** — the union
of every program the caller is a member of — and those programs are independent.
Even with a per-program sequence, a single scalar `since` taken as the max across
N programs reintroduces the identical failure one level up: a hot program's
sequence outruns a cold program's, and the cold program's edits fall out.

**The scalar cursor is the problem.** Any fix either changes the cursor's shape or
gives the scalar a single ordering to refer to.

## Decision

**Allocate `Program` and `ProgramMembership` `sync_seq` from one installation-wide
monotonic sequence, and make `_watermark` read that sequence.**

The delta filter becomes `sync_seq__gt=since` on both collections, exactly as the
project slice does.

This is the only option of the three that keeps `MAX` valid **with no
wire-contract change**: `since` stays a scalar, the response shape is untouched,
and existing mobile clients need no update. The cursor stops being "the largest
save-count I have seen" and becomes "the position in the installation's program
write log I have drained to" — which is what a cursor has to be.

### What this costs, stated plainly

**Program writes serialize installation-wide.** Allocation `UPDATE`s a single
counter row and holds its write lock until commit, so two concurrent program
writes anywhere in the installation queue behind each other.

That lock is not incidental — it is the correctness mechanism, for the reason
ADR-0686 spells out: without it a transaction could allocate 100, a later one
allocate 101 and commit first, and a pull between the two commits would report 101
and permanently skip 100. **This same bug, reintroduced as a race.** A PostgreSQL
`SEQUENCE` with `nextval()` would avoid the lock and reintroduce exactly that
hazard, because sequences are non-transactional and grant no ordering between
allocation and commit.

The cost is acceptable here in a way it would not be for tasks. Program writes are
**rare and administrative** — creating a program, renaming it, adding or removing a
member. They are not a hot path: nothing in the product writes a program row in a
loop, there is no bulk-program-import, and CPM recompute never touches these
tables. Contention is bounded by how often humans administer programs, which is
orders of magnitude below task edits.

If that ever stops being true, the escape hatch is the per-program cursor vector
below — a protocol change, but one this decision does not foreclose.

### Existing rows

`Program` and `ProgramMembership` already carry `sync_seq` (it is on
`VersionedModel`), and it is currently `0` on every row because neither model is in
`OWNER_RESOLVERS`. A backfill migration assigns ordered values — by
`(created_at, id)` so the order is deterministic and reproducible — and seeds the
installation counter above the highest assigned value.

Existing clients hold a `since` drawn from the **old** `server_version` scale.
Those two scales are unrelated, so the first pull after upgrade could under- or
over-deliver. The backfill deliberately starts the new sequence at a value **above
any plausible stored `server_version`** so that every pre-existing client cursor
sorts below every row's new `sync_seq`, and the first post-upgrade pull is a full
re-delivery of the caller's accessible set. Re-delivery is safe — the client
applies rows under upsert — and it is the only transition that cannot silently
drop a row.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Per-program cursor vector** — `since` becomes `{program_id: seq}` | Most correct; no cross-program contention; each program orders independently | **Changes the request/response contract.** Every mobile client must be updated in lockstep; cursor size grows with membership count; the pager, `SyncCursor` encoding and the `#2568` watermark-pinning all need rework. Too large for the 0.4 window, and it strands existing clients |
| **One sequence per user's program set** | Matches the accessible set exactly | No natural owning row to serialize on — needs its own allocator table keyed by user, and the set changes as membership changes, so a cursor becomes invalid when a user is added to a program |
| **Installation-wide sequence (chosen)** | `MAX` becomes valid again; **no protocol change**; reuses the ADR-0686 allocator pattern and its proven locking argument | Serializes all program writes installation-wide; needs a backfill and a one-time full re-delivery |
| **PostgreSQL `SEQUENCE` + `nextval()`** | No row lock, no contention | **Incorrect.** Non-transactional: commit order ≠ allocation order, so a pull between two commits permanently skips the lower value — the very bug being fixed, as a race |

## Consequences

**Easier.** The program slice gets the same cursor semantics as the project slice,
so both are explained by one model. `#2568`'s watermark pinning already applies
unchanged, because it pins whatever scalar `_watermark` returns.

**Harder.** Program writes contend on one row. A future need for high-frequency
program writes forces the cursor-vector migration.

**Risks.**
- The one-time full re-delivery after upgrade is a burst of sync traffic
  proportional to each user's accessible program set. Bounded and small (programs
  and memberships only, not tasks), but real.
- The counter row is a new single point of contention. Mitigated by how rarely
  program rows are written; monitored via the existing sync latency signals.

## Implementation Notes

- P3M layer: **Programs and Projects**
- Affected packages: **api** (`apps/sync/sequence.py`, `apps/sync/views.py`, one
  migration)
- Migration required: **yes** — one table for the counter, plus a data backfill
- API changes: **no wire-contract change.** `since`/`timestamp` stay scalar
  integers. The *values* change scale, which is why the backfill forces one full
  re-delivery
- OSS or Enterprise: **OSS**

### Durable Execution
1. Broker-down behaviour: **N/A** — allocation is synchronous inside the writing
   transaction. No task is dispatched.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — allocation commits with the row it stamps.
4. Service layer: `apps/sync/sequence.py` gains `allocate_program_seq()`, beside
   the existing project allocator, so the API keeps one allocation site.
5. API response on best-effort dispatch: **N/A** — synchronous read endpoint.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: allocation is a single `UPDATE … RETURNING` and is naturally
   idempotent per save. A retried transaction draws a fresh value; gaps in the
   sequence are harmless — the cursor requires monotonicity, not density.
8. Dead-letter / failure handling: **N/A**. If the counter row is missing the
   allocator returns 0 and the row keeps `sync_seq = 0`, which is never delivered
   — fail-closed toward "not yet replicated" rather than toward a false checkpoint.

## Related

- #2498 — this issue
- #2491 / ADR-0686 — the project-endpoint fix, whose locking argument this reuses
- #2568 — a *different* sync defect (the watermark was not pinned across pages of
  one drain session). Both must be fixed for the offline protocol to be sound;
  neither implies the other. #2568's pinning applies unchanged here
- ADR-0142 — the watermark receivers ADR-0686 replaced
