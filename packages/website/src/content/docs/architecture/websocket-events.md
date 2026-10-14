---
title: WebSocket event conventions
description: The naming convention, frozen-contract guarantee, and registration steps for real-time board events.
---

The real-time layer broadcasts board and schedule changes over WebSocket. It has
been in place since 0.2; what this page documents is the **convention** every
event follows and the **frozen-contract** guarantee that keeps the event surface
stable for external consumers. The complete event list, the envelope, and the
WebSocket ↔ webhook taxonomy live on the [WebSocket API reference](/api/websockets/);
this page is the explanation behind that reference — read it before adding a new
event type.

## The envelope

Every board event arrives as the same JSON envelope:

```json
{ "protocol_version": 1, "event_type": "<name>", "payload": { ... }, "seq": 1234 }
```

`protocol_version` is a bare integer identifying the wire version of the envelope
(currently `1`). It is reserved so a future backward-incompatible envelope change
can be negotiated without breaking clients that ignore it today — clients that do
not read it are unaffected; future clients can branch on it. Bump it **only** on a
backward-incompatible envelope change, never for a new `event_type`.

`payload` is intentionally minimal — usually an id or a small id set. Treat
delivery as best-effort and refetch the affected resource on reconnect rather than
relying on having seen every event.

`seq` is the per-project replay sequence for a persisted (replayable) event, or
`null` for an ephemeral one (presence, task-run progress). It is additive — a
client that ignores it behaves exactly as before, so it does not bump
`protocol_version` — and it powers reconnect replay, below.

## Reconnect replay & sequence numbers

Broadcast delivery is best-effort: an event sent while a client is disconnected is
lost. Rather than force a full refetch storm on every reconnect, each replayable
event is persisted to a bounded per-project buffer (`BoardEvent`) and stamped with
a per-project `seq` (ADR-0236, ADR-1285). The mechanism:

- **Sequence** — the `seq` is a **per-project, dense, commit-ordered** counter
  (ADR-1285, #4386). It is drawn from the project's `BoardEventSequence` row in the
  same transaction as the event's INSERT. That row stays locked until the event
  commits, so within one project the committed values are `1, 2, 3, …` with no
  holes, in commit order. A rolled-back event returns its value. Until #4386 the
  `seq` was the buffer's global row id. Other projects' traffic interleaved it, so
  the next frame on a project was almost never `last + 1`. The client dropped an
  out-of-order delivery as a duplicate, and the gap between frames revealed
  instance-wide event volume.
- **What is buffered** — every mutation event, but **not** the high-frequency
  ephemeral ones (`presence_*`, `task_run_*`), which carry `seq: null` and are
  pointless to replay. This is a denylist, so a newly-added mutation event is
  replayable by default.
- **Ordering on the client** — dense allocation does not order delivery. Two
  workers can commit 10 then 11 and still have 11's `group_send` arrive first. The
  client keeps a contiguous cursor. It drops `seq <= cursor` as a duplicate and
  applies `cursor + 1` immediately. It holds a frame that overtook its predecessor
  for a short window (`SEQ_REORDER_WINDOW_MS`, `packages/web/src/hooks/wsSeqGate.ts`).
  When the window expires, it applies the held frames in order rather than dropping
  them, and moves the cursor past the hole. That window is the bound: a predecessor
  arriving more than 750 ms late finds `seq <= cursor` and is dropped. A reconnect
  cannot recover it, because `?since=` starts above the hole. Until #2848 adds a
  gap → resync, only a later refetch repairs it.
- **The handshake** — on reconnect the client opens the socket with
  `?since=<cursor>`. The consumer reads the project's head (its counter value).
  The client is owed exactly `head - since` events, and the consumer streams them
  (each flagged `"replayed": true`) only when exactly that many rows survive.
  Replayed frames always precede live ones, and the client drops any `seq` it has
  already applied, so replay is idempotent.
- **Gap fallback** — the consumer sends a single `resync_required` control frame
  carrying `{ "latest_seq": <head> }` in three cases. The first is when some owed
  rows were purged (the buffer keeps `TRUEPPM_BOARD_EVENT_RETENTION_HOURS`, default
  24h). The second is when the client is more than the replay cap behind. The third
  is when `since` is above the head, a value the project's sequence never reached.
  A global-id cursor from before #4386 lands in the first case. The upgrade seeded
  every existing project's counter at its highest old id plus 2³², so such a cursor
  is owed more events than carry a `seq` (ADR-1285 §6). The client refetches its project-scoped caches and baselines its
  cursor to `latest_seq`. Every value the consumer reads is scoped to the project.

`resync_required` is a **consumer-emitted control frame**, not a broadcast event —
it never passes through `broadcast_board_event()`, so it is deliberately *not* part
of `FROZEN_WS_EVENT_TYPES`.

## Naming convention

WebSocket `event_type` values follow one pattern:

> **`<resource>_<past-tense-verb>`** — lowercase `snake_case`, singular resource,
> past-tense verb.

Examples: `task_created`, `task_updated`, `task_deleted`, `dependency_accepted`,
`baseline_activated`, `roster_changed`, `sprint_retro_updated`,
`task_run_started`, `slip_conflicts_updated`. The `task_run_*` family
(`task_run_started`, `task_run_progress`, `task_run_completed`, `task_run_failed`,
`task_run_cancelled`) follows the same rule with a two-word resource. New events
**must** conform to this shape.

Two deliberate qualifiers:

- **Underscores, not dots.** WebSocket events are `snake_case`. Webhook events are
  dot-namespaced `noun.verb` (`task.created`) — a different transport with a
  different audience. The *same* domain event is therefore `task_created` over the
  WebSocket and `task.created` in a webhook payload. This is an intentional
  per-transport distinction, not drift; see the
  [WebSocket ↔ webhook taxonomy](/api/websockets/#websocket--webhook-event-taxonomy).
- **A handful of shipped strings predate the rule.** Bulk and collection events use
  a plural or non-`<resource>_<verb>` form — `tasks_bulk_mutated`,
  `tasks_reordered`, `tasks_restructured`, `phases_reordered`, `backlog_reranked`,
  `risks_imported`. These are **grandfathered**: they are part of the frozen
  contract and will not be renamed mid-line. New events do not get the same
  latitude — conform to `<resource>_<past-tense-verb>`. The grandfathered strings
  are normalized only at the 1.0 wire-freeze, where a one-time breaking rename is
  acceptable.

## The frozen contract

The set of WebSocket event-type strings is a **public contract**. 0.3 froze
the event-string surface, and the read-only MCP server shipped in 0.4 — along
with any external integrator that subscribes to the board channel — will bind to
that frozen set. Once a client builds against an `event_type`, renaming or removing
it is a breaking change.

Because the literals are scattered across `broadcast_board_event()` call sites
rather than centralized in an enum, a CI guard keeps them honest. The test
`test_ws_event_type_set_is_frozen` (in
`packages/api/tests/apps/sync/test_broadcast.py`) re-derives the live set by
AST-scanning the API source for every literal `event_type` passed to
`broadcast_board_event()` / `abroadcast_board_event()`, then asserts it equals the
hand-maintained `FROZEN_WS_EVENT_TYPES` frozenset. Adding or removing a broadcast
event without updating that set fails the build loudly.

:::caution[The guard only sees *direct literal* call sites]
The AST scan reads the `event_type` literal passed **directly** to the broadcast
helpers. A call site that forwards `event_type` as a **variable** — for example a
wrapper that takes its own literal and relays it on — is intentionally skipped, on
the assumption that it forwards an already-frozen type. A wrapper emitter that
introduces a *new* literal at its own call sites therefore escapes the freeze set
(this is how the `task_run_*` events once slipped through). If you add an event via
a wrapper, enumerate the wrapper's call sites and add each literal to
`FROZEN_WS_EVENT_TYPES` by hand. The `broadcast-check` gate covers this case.
:::

## Registering a new event

When a new mutation needs to broadcast, register the event in **four** places, in
the same change:

1. **Emit a direct string literal** at the `broadcast_board_event()` /
   `abroadcast_board_event()` call site — not a variable — so the freeze guard
   registers it. The name must follow `<resource>_<past-tense-verb>`.
2. **Add the literal to `FROZEN_WS_EVENT_TYPES`** in
   `packages/api/tests/apps/sync/test_broadcast.py`.
3. **Document it** in the taxonomy on the
   [WebSocket API reference](/api/websockets/), noting whether it has a webhook
   counterpart or is WS-only.
4. **Register a frontend handler** in the project WebSocket hook under
   `packages/web/src`. An event the backend fires that the frontend never handles
   is a silently dropped update; a handler that listens for an event nothing emits
   is dead code that masks the real name.

The `broadcast-check` agent runs through exactly this checklist for any write-path
change — including the wrapper-emitter case above — so a new event that misses one
of these steps is caught before merge.
