# ADR-0236: WebSocket event replay — sequence numbers, gap detection, resync on reconnect

## Status
Accepted

## Context
Real-time collaboration is delivered over Django Channels. `broadcast_board_event(project_id, event_type, payload)` (`apps/sync/broadcast.py`) fans an envelope out to the `project_{id}` channel group; the frontend `useProjectWebSocket` hook maps ~60 event types to (mostly idempotent) TanStack Query invalidations, with `task_dates_updated` and the `task_run_*` progress store as the only *incremental-apply* handlers.

The broadcast is **best-effort by design** (see `broadcast.py` docstring, ADR-0091, ADR-0152): if a client disconnects (network blip, laptop sleep, server restart) and reconnects, every event broadcast during the gap is silently lost. TanStack's refetch-on-focus papers over most of this, but two windows remain:

1. **A heavy, racy full-refetch storm on every reconnect** — the client has no way to learn *which* caches actually went stale, so a robust client must invalidate broadly.
2. **The incremental `task_dates_updated` splices are lost** — a plain refetch-on-focus does not re-splice CPM bar positions that moved while the socket was down, so a collaborator's Gantt can silently drift until an unrelated refetch.

This is durability hygiene, not HA: it applies to the single-node OSS deployment as much as a multi-pod one. #321 asks for a bounded server-side replay buffer with per-project sequence numbers, a `?since=<seq>` replay handshake, and a `resync_required` fallback when the requested point has aged out of retention.

**P3M layer:** Programs and Projects (single-project real-time transport). **OSS** — real-time collaboration for one PM/team is adoption-critical and has always been OSS; there is no cross-program or governance dimension here.

## Decision

### 1. `BoardEvent` replay-buffer model (`apps/sync`)
A plain `models.Model` (server infrastructure, never pulled as a synced domain row — mirrors `SyncBatch`):

| Field | Type | Notes |
|-------|------|-------|
| `id` | `BigAutoField` PK | **Doubles as the global monotonic sequence.** |
| `project` | FK → `projects.Project`, `on_delete=CASCADE`, indexed | Replay is filtered per project. |
| `event_type` | `CharField(64)` | Same identifier as the broadcast envelope. |
| `payload` | `JSONField` | The verbatim broadcast payload. |
| `created_at` | `DateTimeField(auto_now_add=True)`, indexed | Purge scans by age. |

Indexes: `(project, id)` composite (the replay query `WHERE project_id=? AND id > ?  ORDER BY id`) and `(created_at)` (purge). No `server_version` — this is not a `VersionedModel`.

### 2. Sequence allocation — the global `BigAutoField` PK **is** the sequence
Clients only need a value that is **strictly increasing per project** for a `seq > since` comparison, and **gaps are harmless** (they compare, they do not count). The table's global auto-increment PK satisfies this for free: Postgres assigns it atomically at INSERT, so two racing commits can never receive a duplicate or lost sequence. Per-project the ids are monotonically increasing with gaps (other projects' rows interleave) — exactly the gap-tolerant contract the client needs.

This deliberately avoids a per-project counter row (`SELECT … FOR UPDATE` contention) and a dedicated Postgres sequence (no benefit over the PK). The wire field is named `seq` and equals the row `id`.

### 3. Persist policy — **default-persist with an ephemeral denylist**
`broadcast_board_event` persists a `BoardEvent` **unless** the event type is ephemeral:

```
EPHEMERAL_EVENT_TYPES = {
    "presence_join", "presence_leave",
    "task_run_started", "task_run_progress", "task_run_completed",
    "task_run_failed", "task_run_cancelled",
}
```

Rationale for a *denylist* rather than an allowlist: every one of the ~60 mutation events maps to an **idempotent** cache invalidation on the client, so replaying one is always safe, and new mutation events should be replayable by default (fail-safe). The excluded events are high-frequency live progress / presence that are pointless to replay (a stale progress bar, a presence ping for a since-departed peer). Persisting is best-effort: a DB failure is logged and swallowed (`seq` becomes `None`), never raised — identical to the existing broadcast contract.

The sequence is threaded into the **live** payload: persist first, then `group_send` with `seq=row.id`. Because callers already run `broadcast_board_event` inside `transaction.on_commit()`, the INSERT happens post-commit in autocommit — the row is the durable truth; the broadcast is the best-effort echo.

### 4. Consumer replay protocol (`ProjectConsumer`)
`?since=<seq>` is parsed from the query string (reusing `ws_auth._parse_query`; it is not a credential, so it is read after auth). The replay runs **inside `websocket_connect`, after `group_add` and after `super().websocket_connect()` (ACCEPT)**:

- **`since` absent or `≤ 0`** → no replay (a fresh client loads via REST); stream live only.
- **`since > 0`** → compute `oldest = min(id)` over all `BoardEvent` rows (one indexed lookup). Retention purges a contiguous low-`id` prefix (`created_at` is monotonic with `id` at 24 h granularity), so:
  - `oldest is None` (buffer empty) **or** `since < oldest - 1` (the first wanted event, `since+1`, was purged) → send one **`resync_required`** frame carrying `payload.latest_seq = max(id)` and replay nothing.
  - otherwise replay `BoardEvent.filter(project_id=pk, id__gt=since).order_by("id")[:REPLAY_CAP]` (cap 1000), each as a frame with `seq` and `replayed: true`. If the cap truncates, emit `resync_required` instead (too far behind to stream economically).

**Ordering safety:** while `websocket_connect` runs, `AsyncJsonWebsocketConsumer`'s `await_many_dispatch` loop is blocked, so no live `board_event` is dispatched until it returns. `group_add` happens *before* the replay read, so any event broadcast mid-replay is queued and delivered *after* the replay frames — replayed (older `seq`) always precede live (newer `seq`). A row persisted-but-also-queued during the `group_add`↔read race is delivered twice (once replayed, once live) at the *same* `seq`; the client dedups on `seq` (below).

### 5. Frontend contract (`useProjectWebSocket`)
- Track `lastSeqRef` (highest `seq` processed for the current project; reset on project change).
- Every frame carrying a numeric `seq`: **drop it if `seq ≤ lastSeqRef`** (already processed — handles the replay/live dup and any duplicate replay), else process and set `lastSeqRef = seq`. Frames **without** `seq` (presence, `task_run_*`) always process — the seq-gate applies only to seq-bearing frames.
- `(re)connect` appends `&since=${lastSeqRef}` to the socket URL; `openSocket` takes `since` as a third argument so a reconnect carries the last-processed sequence, not the mount-time value.
- **`resync_required`** → invalidate the project-scoped query caches (the same keys the mutation handlers touch) and set `lastSeqRef = payload.latest_seq` so the next reconnect does not re-request the purged gap.

Replayed events flow through the existing `handleMessage` switch unchanged — every handler is already idempotent, and the `seq`-gate prevents an out-of-order older splice (`task_dates_updated`) from regressing a newer live one.

### 6. Retention & purge
A **standalone nightly Celery Beat entry** (the pattern `purge-resolved-slip-conflicts-nightly` and the tombstone reaper still use), *not* the ADR-0173 operator-editable coordinator. The coordinator's `run_purge` calls `spec_for(spec.key)`, which raises `KeyError` unless every `PurgeSpec` key also has a matching `RETENTION_SPECS` entry — so coordinator registration is all-or-nothing and would surface the internal replay buffer as a seventh row in the operator "Retention & purge" UI (and its e2e). That is out of scope for #321, whose AC only requires a nightly purge. Registering the buffer in the operator UI is a clean, deferred follow-up.

- `settings/base.py`: `TRUEPPM_BOARD_EVENT_RETENTION_HOURS = env.int(..., default=24)`.
- `apps/sync/tasks.py::_do_purge_board_events(*, dry_run, override_value)` does the `created_at < cutoff` bulk delete, reading the window directly from settings (mirrors `reap_domain_tombstones`'s `getattr(settings, ...)`); a thin `@idempotent_task(on_contention="skip", name="sync.purge_board_events")` wrapper is scheduled nightly in `CELERY_BEAT_SCHEDULE`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Global `BigAutoField` PK as sequence** (chosen) | Zero-lock, race-free, gap-tolerant is exactly the client contract | Per-project ids are non-contiguous (irrelevant — client compares, never counts) |
| Per-project counter row + `SELECT FOR UPDATE` | Dense per-project sequence | Write contention on every mutation; a hot serialization point on the busiest path |
| Dedicated Postgres sequence per project | Dense, lock-light | Unbounded sequence objects; no benefit over the PK for a `>` comparison |
| Monthly native partitioning (issue's suggestion) | Cheap `DROP PARTITION` purge | Over-engineered for OSS single-node; Django partition tooling is non-native; a 24 h indexed bulk-DELETE matches `SyncBatch` and the coordinator already exists |
| Allowlist of replayable events | Explicit | New mutation events silently *not* replayed until someone remembers to add them — fail-*unsafe* |

## Consequences
- **Easier:** reconnect reconciliation is now surgical (replay the exact missed events) instead of a broad refetch storm; the incremental `task_dates_updated` splices survive a disconnect; DevTools WS frames carry a visible `seq`; retention rides the existing operator-configurable coordinator.
- **Harder:** every persisted mutation now costs one extra INSERT on the broadcast path (post-commit, best-effort, swallowed on failure) — bounded by the denylist excluding the high-frequency ephemeral events. A new table to purge (already automated).
- **Risks:** the `oldest`-watermark gap check assumes `created_at` is monotonic with `id`; true at 24 h purge granularity, documented in the purge task. The `group_add`↔replay-read race can duplicate one event at a shared `seq`; neutralized by the client `seq`-gate. Persisting after commit means a crash between domain-commit and BoardEvent-INSERT leaves that one event unreplayable — strictly better than today (lost entirely), and the client recovers it via `resync_required`/refetch.

## Implementation Notes
- **P3M layer:** Programs and Projects (single-project real-time transport).
- **Affected packages:** `api` (apps/sync model + migration `0003`, broadcast, consumer, tasks; observability retention/purge registration; settings), `web` (`useProjectWebSocket`).
- **Migration required:** yes — `apps/sync/0003_boardevent`.
- **API changes:** WebSocket only — additive `seq` field on the `board.event` frame, new `resync_required` frame, new `?since=` connect param. No REST surface, no OpenAPI change. `protocol_version` stays `1` (additive fields are backward-compatible; a client that ignores `seq` behaves exactly as today).
- **OSS or Enterprise:** OSS.

### Durable Execution
1. **Broker-down behaviour:** N/A for the write path — persistence is a synchronous INSERT inside the existing post-commit broadcast, no Celery dispatch. The only async work is the *purge*, which rides the ADR-0173 coordinator; a down broker just delays a purge run (rows age slightly longer), never loses data.
2. **Drain task:** N/A — no new dispatch category. Purge reuses `retention.run_purge`.
3. **Orphan window:** N/A — the purge deletes by `created_at < now - retention` (24 h); no in-flight-commit race (the window dwarfs any commit latency).
4. **Service layer:** `apps/sync/broadcast.py::broadcast_board_event` (persist folded in); purge via `apps/sync/tasks.py::_do_purge_board_events`.
5. **API response on best-effort dispatch:** N/A — no HTTP endpoint; the WS broadcast is fire-and-forget and already best-effort.
6. **Outbox cleanup:** the `BoardEvent` table itself is the bounded buffer — `TRUEPPM_BOARD_EVENT_RETENTION_HOURS` (default 24 h) purge via a nightly standalone Beat task `sync.purge_board_events`.
7. **Idempotency:** replay is idempotent by the client `seq`-gate (`seq ≤ lastSeq` dropped); the purge is `@idempotent_task(on_contention="skip")` and a bulk delete is naturally re-runnable.
8. **Dead-letter / failure handling:** a persist failure is logged and swallowed (`seq=None`, event still broadcast live) — the client recovers the gap on its next `resync_required`. No DLQ; silent-discard is acceptable because the buffer is a best-effort optimization over the authoritative REST reads.
