# ADR-1285: Per-project, commit-ordered WebSocket replay sequence

## Status
Accepted (2026-10-14)

Supersedes three parts of [ADR-0236](0236-websocket-event-replay.md): §2 (the global
`BigAutoField` PK as the sequence), §4's global `oldest`-id purge watermark, and §5's
high-water `seq <= lastSeqRef` client gate. The rest of ADR-0236 stands: the buffer
model (§1), the denylist persist policy (§3), the `?since=` handshake, the
`resync_required` frame and the ordering-safety argument (§4), and purge (§6).

## Context

ADR-0236 made the `BoardEvent` table's global auto-increment PK the wire `seq`. Its
reasoning was that clients "only compare, never count", so a gap-tolerant global value
would do. The 2026-10-10 `/pre-release full` audit (#4386) found three defects in that
reasoning:

1. **Out-of-order delivery was dropped as a duplicate.** The id is assigned at INSERT,
   but delivery order is the order two workers' `group_send` calls arrive in. Suppose
   a CPM worker emits `task_dates_updated` (id 10) and an API worker emits
   `task_updated` (id 11) on one project. If 11 arrives first, the client advances to
   11 and drops 10 under its `seq <= last` gate, and `?since=11` never replays 10.
2. **Gap detection was impossible.** #2848 wants to treat `seq > last + 1` as a lost
   frame. With a global counter the next event on a project is almost never `last + 1`,
   because other projects' traffic interleaves the sequence.
3. **Instance-wide volume leaked.** The delta between consecutive frames told any
   project member how many events the whole installation produced in between.
   `consumers.py` had already scoped `latest` to the project to avoid exactly that leak.

**P3M layer:** Programs and Projects (single-project real-time transport). **OSS.**

## Decision

### 1. `seq` is per project, dense, and commit-ordered

`BoardEvent.seq` is a new `BigIntegerField`. It is drawn from a per-project
`BoardEventSequence(project PK, value)` row by `UPDATE … SET value = value + 1 RETURNING
value` (`apps/sync/sequence.py::allocate_board_event_seq`). This happens **inside the
same `transaction.atomic()` as the `BoardEvent` INSERT**
(`broadcast.py::_persist_board_event`). The counter row's lock is held until the event
commits. As a result:

- the next event on the project waits for the first to commit before drawing, so commit
  order equals allocation order;
- a rolled-back INSERT returns its value, so committed values are `1, 2, 3, …` with no
  holes;
- the row is committed **before** `group_send`, so a replay racing the send already
  sees it.

This is the `sync_seq` pattern (ADR-0686) and the `ProgramSyncSequence` pattern
(ADR-0747): a row lock, not a PostgreSQL `SEQUENCE`. `nextval()` is non-transactional
and would leave holes and break the commit-order property.

A unique constraint on `(project, seq)` backs the invariant. Its index also serves the
replay query.

### 2. The counter is its own row, not a column on `Project`

`Project.last_sync_version` is held locked across the whole apply of a sync upload.
`Project` rows are also taken `FOR UPDATE` by several domain transactions. Broadcasts
run in `on_commit` callbacks. If the allocator were on the project row, every broadcast
would wait behind those transactions, and a transport counter would be coupled to
domain locking. A dedicated row is locked only for one INSERT, and nothing else ever
locks it.

That does not make a broadcast entirely independent of the project row. The `BoardEvent`
INSERT's deferred FK check takes `FOR KEY SHARE` on the project at COMMIT. `KEY SHARE`
does not conflict with `FOR NO KEY UPDATE` (an ordinary `UPDATE` of the row, which is how
`last_sync_version` is taken). It does conflict with plain `FOR UPDATE`, which several
domain transactions take on `Project` with `select_for_update()` — for example
`commit_moment.py`, `access/services.py`, `projects/services.py` and the seed importer.
A broadcast that commits while one of those holds the row waits at COMMIT, still holding
its counter lock, so other broadcasts on that project queue behind it for that time.
There is still no lock cycle: those holders never touch the counter row, so nothing
they wait on is held by the broadcast.

The counter row is created lazily on a project's first replayable event. A concurrent
first event is resolved by `get_or_create`'s savepoint. A project id with no `Project`
row (checked before the INSERT, because Django FKs are deferred to COMMIT) draws no
`seq`, and the event goes out live and unsequenced.

### 3. Replay completeness is a count

The consumer reads the project's head (the counter value). The client is owed exactly
`head - since` events. The consumer replays only when exactly that many rows survive in
`(since, head]`. In every other case it sends one `resync_required {latest_seq: head}`:

- `since > head`: a value the project's sequence never reached, for example a global
  id an old pod issued during the rolling update for a project created in that
  window, whose counter starts at 0. A global-id cursor for a project that existed at
  the upgrade is below the seed (§6), so it lands in the "fewer rows" case instead;
- `head - since > _REPLAY_CAP`;
- fewer rows than owed, because the purge reaped part of the gap.

`since == head` sends nothing. This replaces ADR-0236's "oldest surviving **global** id"
watermark, which assumed `created_at` was monotonic with the global id. The density
check reads nothing outside the project.

### 4. The client keeps a contiguous cursor and a reorder buffer

`packages/web/src/hooks/wsSeqGate.ts` handles each frame by comparing its `seq` with
the cursor:

- `seq <= cursor`: drop it as a genuine duplicate.
- `seq === cursor + 1`: apply it, then drain any buffered successors.
- `seq > cursor + 1`: buffer it for `SEQ_REORDER_WINDOW_MS` (750 ms), bounded at 256
  frames. If the predecessor lands, the run applies in order. On expiry, the held
  frames apply in ascending order and the cursor moves past the hole. A frame is not
  dropped for arriving early.

**The bound is 750 ms, and past it the skipped event is lost.** A predecessor that
arrives more than 750 ms late finds the cursor already past it, so the gate drops it as
`seq <= cursor`. A reconnect cannot recover it either, because `?since=` starts above
the hole. Until #2848 lands, the only recovery is a later refetch of the affected data.

A cursor of 0 means the client is not yet baselined. Its first frame waits out the
window unless it is `seq 1`, so a reversed pair at page load is still ordered.

**Gap → resync is left to #2848.** A confirmed hole at window expiry is exactly the
signal #2848 needs, and the hook point is marked `TODO(#2848)`. #2848 also covers
backing off the fallback poll while the socket is live, and fixing the throttle
docstring. Neither belongs in this change.

### 5. Rolling-update compatibility

`seq` is nullable because the existing rows are left unnumbered (§6) and because an old
pod does not know the column and INSERTs without it. Both kinds of row are live-only: the replay filters `seq` non-null and the allocator never
counted them, so they create no false gap. Old pods `group_send` the global id as
`seq`. New pods add a channel-layer-internal `seq_scope: "project"` marker, and the
consumer forwards `seq` only when the marker is present, so a client never adopts a
global id as its cursor through a new consumer.

An *old* consumer forwards whatever it receives, so a client fed by one can still
mix the two spaces. Old pods also keep minting global ids from the same identity
sequence throughout the window. With the seed at a project's bare old max, those
fresh ids would land in the range the new pods hand out as per-project seqs. The
round-2 audit reproduced the consequence with a seed of 1000. The client applies the
old pod's 1001 and drops the new pod's seq 1001 as a duplicate. It applies 1002 and
1003, then reconnects with `since=1003`, equal to the head. It is owed nothing, so it
never gets seq 1001 back. The migration therefore offsets every seed by 2**32 (§6).
That puts the two spaces about four billion apart, so no id an old pod can mint in
the window reaches a project's seq space. The remaining mixing is accepted and
disclosed in the 0.4 upgrade notes (CLAUDE.md migration rule 8(c)):

- An old consumer replays global ids to a new client. The client's cursor is then a
  global id, below every seed, so its next reconnect to a new pod resyncs.
- An old client that has taken a per-project seq drops old-pod frames as
  duplicates. Those frames are live-only anyway.
- An old client still on a global cursor treats the first per-project frame as a
  forward jump and adopts it. Its next reconnect either resyncs (global cursor) or
  replays correctly (per-project cursor).

The client gate's 750 ms window handles the one-time jump from a global cursor to the
seeded space. The frame is held, then applied, and the cursor moves into the
per-project space.

### 6. Migration and pre-upgrade cursors

A client that crossed the upgrade holds a cursor `c` that is a *global* id. The protocol
must never let such a cursor silently skip an event. Renumbering the old rows per
project (this ADR's first draft) did exactly that: a project-local rank `r` is at most
the global id `c` it replaced, so a cursor that landed at or below the new head
replayed `(c, head]` and never sent ranks `r + 1 .. c`. The independent completeness
check reproduced it: rows `other:1`, `P:2`, `P:3` (seen), `P:4` (missed) renumber to a
head of 3, and `since=3` returns nothing.

So `sync.0006_boardevent_per_project_seq` does **not** renumber. It does three things:

1. adds the nullable `seq` column and the counter table; every existing row keeps
   `seq = NULL` and stays live-only;
2. seeds every project's counter at **that project's highest existing global id plus
   `BOARD_EVENT_SEQ_UPGRADE_OFFSET` (2**32)**. A project with no surviving rows is
   seeded at the table's identity-sequence value plus the same offset. That value
   bounds every id ever assigned, because a client can hold a cursor from rows the
   purge has since removed. The offset is what keeps ids minted by old pods during
   the rolling update out of the per-project space (§5);
3. replaces the `(project, id)` index with the `(project, seq)` unique constraint. Every
   existing row is NULL there, so the constraint cannot be violated
   (`# safe-constraint`, rule 7).

Every global id is then below its project's seed, whether it was issued before the
upgrade or during the window. So **every pre-upgrade cursor gets exactly one
`resync_required`**. The density check of §3 handles it: the cursor is owed
`head - since` events, more than the rows that carry a `seq`. This includes a cursor
that was fully current at the upgrade. Treating every old cursor the same way is
simpler to state and to test than special-casing that one, and it costs one refetch per
client per upgrade.

**Range.** `seq` is a signed 64-bit `BIGINT` (max 2**63 − 1). The web client compares
seqs as JavaScript numbers, which are exact up to 2**53 − 1. A seed is an existing id
plus about 4.3 × 10⁹, so both limits are many orders of magnitude away. The
allocator's `value + 1` (`increment_returning`) and the `(project, seq)` uniqueness
behave on shifted values exactly as on small ones. A project created after the upgrade
starts its counter at 0, as before.

The seeding lives in `sequence.py::seed_board_event_sequences`, so it is tested
without importing a migration module (rule 3).

What this publishes: for a project with surviving rows the seed is an id its members
already received, plus a public constant. For a project with none, the seed reveals
once how many events the installation had written by the upgrade. That is a single
fixed number, not the per-frame volume the old design leaked continuously.

**Migration locks.** The whole migration is one transaction. It holds `ACCESS EXCLUSIVE`
on `sync_boardevent` until commit. `CreateModel(BoardEventSequence)`, through its
foreign key to `projects.Project`, also takes `SHARE ROW EXCLUSIVE` on
`projects_project` until commit. That blocks every write to project rows, including
the `last_sync_version` bump on a sync upload, for the duration. About 0.12 s was
measured for 300,000 buffer rows on a laptop. The upgrade notes say so.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Per-project commit-ordered seq (chosen)** | Dense, so duplicates and gaps are both decidable; no cross-project leak; replay completeness is exact | One extra `UPDATE` and transaction per broadcast; broadcasts on one project serialize for the length of one INSERT; migration and rolling-update window |
| B. Keep the global id, document "monotonic, not dense, may arrive out of order", and gate on a bounded seen-set | No migration | Gap detection (#2848) stays impossible; the leak stays; a seen-set must also be persisted across reconnects to be correct |
| Allocator column on `Project` | No new table | Broadcasts wait behind sync uploads and `select_for_update` holders of the project row; a transport counter is coupled to domain locks |
| PostgreSQL `SEQUENCE` per project | No row lock | Non-transactional: holes on rollback, and allocation order is not commit order, so this is the same bug as a race |
| Renumber the surviving buffer per project (first draft) | Sequences start at 1; no instance figure is published | A pre-upgrade cursor at or below the new head replays from the wrong point and silently skips events (§6) |
| Seed every project at the global identity value | One rule for every project | Publishes the instance's cumulative event count to every member, not only members of projects with no surviving rows |
| Seed at the bare old max (round-1 draft) | A fully-current old cursor replays instead of resyncing | Old pods' fresh global ids fall in the new seq range during the rolling update; a client can reach `since == head` with a seq skipped (§5) |

## Consequences

- **Easier:** #2848's gap detection becomes a one-line hook at the gate's expiry.
  Replay completeness is exact. The consumer no longer runs a global
  `ORDER BY id LIMIT 1` scan on every reconnect.
- **Harder:** every replayable broadcast is now a small explicit transaction (counter
  `UPDATE` plus INSERT). Two broadcasts on one project serialize for the length of
  that transaction.
- **Risk: counter reuse on rollback.** A caller that broadcasts *inside* an open
  transaction (breaking the `on_commit` contract that `broadcast-check` enforces) has
  its allocation rolled back with the outer transaction. If that happens, the next
  event reuses the value, and a client that saw the phantom frame drops the real one as
  a duplicate. Before this change, such a caller produced a phantom frame for a
  rolled-back write. Now it can also cost a real one. The contract is unchanged; the
  price of breaking it went up.
- **Risk: rolling-update window.** See Decision §5.
- **Upgrade cost:** every client that was connected across the upgrade refetches once,
  and the migration briefly blocks `sync_boardevent` and `projects_project` writes
  (§6).
- **Risk: a frame more than 750 ms late is lost** until #2848 adds gap → resync (§4).
- **Wire contract:** the field name and type are unchanged. Its meaning changed from
  "global, gap-tolerant" to "per-project, dense". Integrators holding a cursor see one
  `resync_required`. This is documented on the WebSocket API page.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api, web, website docs
- Migration required: yes (`sync.0006_boardevent_per_project_seq`)
- API changes: no REST/OpenAPI change; WebSocket `seq` semantics change (documented)
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: N/A. No Celery dispatch is added. The broadcast stays
   best-effort, and the `BoardEvent` row commits before `group_send`.
2. Drain task: N/A. A lost live frame is recovered by replay or `resync_required`, not
   by a drain.
3. Orphan window: N/A. The row and the allocation commit together in one transaction,
   so no row is left in flight.
4. Service layer: `apps/sync/sequence.py::allocate_board_event_seq`, called only from
   `broadcast.py::_persist_board_event`.
5. API response on best-effort dispatch: N/A (no REST surface).
6. Outbox cleanup: the existing `sync.purge_board_events` Beat task (24 h). Counter rows
   are kept for the project's lifetime and cascade-delete with it.
7. Idempotency: the `(project, seq)` unique constraint. Client-side, `seq <= cursor` is
   dropped, and replay is idempotent by the ADR-0236 denylist argument.
8. Dead-letter / failure handling: a failed persist rolls back its allocation and the
   event goes out live with `seq: null`. No retry, by design.

### On Acceptance
- [x] Open issues naming this ADR re-read against the settled decision: none. The ADR
      is new, and it is accepted in the same change as its implementation. Count: 0.
- [x] Issues with pre-ADR scope rewritten: #2848's fix #1 assumes a dense sequence,
      which this ADR now provides, so its scope is unchanged. Count: 0.
