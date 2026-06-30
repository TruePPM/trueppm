# ADR-0152: Real-time card-mutation delta broadcast (field-level `task_updated`)

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: def broadcast_task_updated)

## Context
Issue #327. Today every server-side task mutation already schedules a
`broadcast_board_event(project_id, "task_updated", {"id": task_id})` on
`transaction.on_commit()` (≈12 call sites: `TaskViewSet.perform_update`,
suggestion-accept, retro pull, product-backlog reorder, inbound sync, mobile sync
upload, …). The web client (`useProjectWebSocket`) reacts to `task_updated` by
**invalidating the whole `['tasks', projectId]` query** — a full board re-fetch.

Two real gaps remain against #327's acceptance criteria:

1. **No field-level delta / actor / version in the payload.** Consumers can't tell
   *what* changed, *who* changed it, or at *what* `server_version`. Without an actor
   the originating client re-fetches its own change (redundant load + a flicker that
   can clobber an in-flight optimistic update).
2. **Full-list invalidate, not a targeted update.** On a busy board every keystroke
   from any collaborator triggers a full task-list re-fetch for everyone.

The premise in the issue ("the board feels stale until refresh") is only *partly*
true today — the invalidate already refetches — but it is coarse, self-echoing, and
unscalable. This ADR closes the delta/actor/self-echo gap.

**P3M layer:** Programs and Projects (single-project board collaboration) → **OSS**.
The VoC cohort is Alex (8), Priya (7), Sarah (6) — all OSS personas.

### The load-bearing constraint: field-level visibility is role-gated
Task fields are **not** uniformly visible. Per ADR-0104, `story_points` is nulled
below the velocity audience; cost fields are role-gated; future gates will add more.
Therefore the broadcast **must not carry field values** — blasting `{weight: 8,
story_points: 5}` to every connected client (including Viewers) would leak gated
values straight past the serializer that exists to gate them. The broadcast carries
changed-field **names** only; any client that needs the new *values* re-reads the
task through the serializer, which re-applies per-user gating.

## Decision
Enrich the existing `task_updated` broadcast into a privacy-safe field-level delta;
do **not** introduce a global `post_save` broadcaster.

1. **Payload (additive, backward-compatible).** Keep the `task_updated` event name
   (already in `FROZEN_WS_EVENT_TYPES` — no taxonomy change) and keep the existing
   `"id"` key. Add:
   ```json
   {
     "id": "<task uuid>",
     "changed_fields": ["status", "assignee", "sprint"],
     "version": 42,
     "actor_id": "<user uuid or null>",
     "ts": "2026-06-20T16:00:00Z"
   }
   ```
   `changed_fields` is the set of model fields the write actually changed (names,
   never values). `version` is the post-commit `server_version`. `actor_id` is the
   acting user (null for system/CPM-cascade writes).

2. **One helper, routed through the existing per-path calls.** Add
   `broadcast_task_updated(project_id, *, task_id, changed_fields, version, actor_id)`
   in `apps/sync/broadcast.py` that assembles the standard payload and calls
   `broadcast_board_event(project_id, "task_updated", payload)`. Replace the bare
   `{"id": …}` payloads at the task-mutation call sites with this helper. We keep the
   deliberate per-path `transaction.on_commit` calls (ADR-0091 pattern) rather than a
   `post_save` signal, because (a) a signal can't see the request actor, (b) it would
   double-broadcast against the existing explicit calls, and (c) bulk CPM writes use
   `bulk_update`, which does not fire `post_save` anyway.

3. **`changed_fields` source.** At the serializer/view layer the changed set is the
   intersection of `serializer.validated_data` keys with fields whose value actually
   differs from the pre-save instance (computed in `perform_update` from a snapshot of
   the old values). Non-serializer paths (retro pull, product-backlog reorder, sync
   upload) pass the specific field(s) they mutate (e.g. `["sprint"]`, `["order"]`).

4. **Web: self-echo suppression + version guard (this ADR); targeted splice (follow-up).**
   - The hook reads the current user id (from the `useCurrentUser` cache); on
     `task_updated` where `actor_id === currentUserId`, **skip** — the originating
     client already applied the optimistic update, so it must not re-fetch and clobber
     its own in-flight edit. This is the core correctness win.
   - **Version guard**: ignore an event whose `version` is not newer than any version
     already observed for that task — de-dupes replayed/duplicate broadcasts.
   - For a genuine remote event the hook keeps the existing **coalesced
     `['tasks', projectId]` invalidate** (`scheduleInvalidate`). The re-fetch passes
     through the serializer, so role-gated fields (ADR-0104) stay gated — which is
     precisely why we do not splice broadcast *values*.
   - **Follow-up (not this ADR):** replace the list invalidate with a single-task
     refetch (`GET …/tasks/{id}/`) + `setQueryData` splice for the per-keystroke perf
     win. Deferred to keep this change low-risk; the names-only payload already carries
     everything that optimization needs.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A — Enrich per-path payload + names-only delta + targeted refetch (chosen)** | Privacy-safe (no gated values on the wire); keeps proven on-commit pattern; backward-compatible payload; real perf win (1 task vs whole list) | Touches each mutation call site; client still does one small read for values |
| B — Global `Task` `post_save` broadcaster | One place to maintain | No request actor; double-broadcasts vs existing calls; misses `bulk_update`; can't compute a clean changed-set |
| C — Broadcast full field values, splice with no refetch | Zero follow-up read | **Leaks role-gated values** (story_points/cost) to every client — violates ADR-0104; largest payloads |

## Consequences
- **Easier:** collaborators converge without a self-inflicted refetch; the originating
  client no longer races its own optimistic update; busy boards stop full-list
  refetching on every remote keystroke.
- **Harder:** each task-mutation call site must supply `changed_fields`/`actor`; a new
  small contract to keep consistent (the helper centralizes it).
- **Risks:** payload-shape drift across call sites (mitigated by the single helper);
  a forgotten call site keeps the old `{"id"}` payload (still works — web falls back
  to invalidate). Mobile is unaffected: it reconciles via the sync delta on reconnect
  and ignores extra payload keys.

### Known limitation (accepted)
`changed_fields` carries field **names** to every project Member (the WS group is
already gated to Member+ at connect). A Member who cannot see a gated field's *value*
(e.g. `story_points` below the velocity audience) can still infer from
`changed_fields` that that field *changed* — the name, never the value. This is a
minimal metadata inference within an already-trusted audience, accepted as the
single-fanout tradeoff. Filtering `changed_fields` per-recipient would require the
per-connection fanout deferred above; it should land together with the targeted
single-task refetch follow-up.

## Implementation Notes
- P3M layer: Programs and Projects → **OSS**.
- Affected packages: `api` (sync/broadcast helper, projects views/services), `web`
  (`useProjectWebSocket`).
- Migration required: **no** (no schema change).
- API changes: WebSocket payload only (additive); no REST surface change.
- OSS or Enterprise: **OSS** (`trueppm-suite`).

### Durable Execution
1. Broker-down behaviour: **N/A for durability** — broadcast is best-effort by design
   (see `broadcast_board_event` docstring / `docs/durability/on-commit-audit.md`).
   Every mutation is durably committed before the broadcast is scheduled; a dropped
   event is recovered by the client's next sync-delta pull on (re)connect. No outbox
   row is required for a callback that *only* broadcasts.
2. Drain task: **N/A** — no Celery work is enqueued by this feature.
3. Orphan window: **N/A** — no drain.
4. Service layer: new `broadcast_task_updated()` in `apps/sync/broadcast.py`; existing
   CPM dispatch (`scheduling/services.py`) is untouched.
5. API response on best-effort dispatch: **N/A** — broadcasts are fire-and-forget side
   effects of the normal synchronous mutation response; the REST response is unchanged.
6. Outbox cleanup: **N/A** — no outbox rows created.
7. Idempotency: the client de-dupes via the `version` guard (ignore events whose
   `version <= cached server_version`), so a duplicated or replayed broadcast is a
   no-op. Server-side the broadcast itself performs no state change.
8. Dead-letter / failure handling: a channel-layer failure is logged and swallowed by
   `broadcast_board_event`; the client reconciles on next delta pull. Acceptable
   discard — nothing durable depends on the broadcast.
