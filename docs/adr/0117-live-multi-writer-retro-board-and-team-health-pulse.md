# ADR-0117: Live Multi-Writer Retro Board + In-Retro Team-Health Pulse

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: class SprintRetro)

> **Companion ADRs.** This ADR builds directly on **ADR-0104** (Unified Team-Signal
> Privacy Model — the `pulse` signal gate this feature consumes), **ADR-0071** (the
> single-author `SprintRetro`/`RetroActionItem` model this surface absorbs), **ADR-0094**
> (sprint states / state-aware workspace), and **ADR-0078/#927** (the
> `is_scrum_master`/`is_product_owner` Team facets). It does **not** re-decide the pulse
> privacy posture — ADR-0104 owns that and is treated as settled here.

## Context

The 0.3 agile-cohort epic (#883) Wave 4 ("ceremony completeness") found that TruePPM's
retrospective is a **single-author** surface: `SprintRetro` saves `notes` + a
`RetroActionItem` set via one `update_or_create` upsert at ceremony end
(`views.py:6328`). A focused VoC panel ranked **live multi-writer retro** the **#1
must-have** for the agile tier (Alex/SM 8, Morgan/Coach 7, Priya 7; OSS agile avg ~7.0):
a board where the whole team adds/edits sticky-note items *simultaneously during the live
ceremony*, seeing each other's input in real time. Today they "refresh every few minutes
— embarrassing for a collaborative tool." That is a genuinely different interaction
pattern (concurrent multi-writer board), not a broadcast bolted onto the single-author
save.

Folded in:

- **#923 — in-retro team-health pulse**: a single-team mood/energy(/confidence) poll
  answered during the retro, with a cross-sprint trend visible to **team + coach only**.
  Morgan's championable item (9/10) and his **hard 🔴**: it ships *only* if team-private
  by default with the same posture as the velocity gate (#553/ADR-0104). A
  PM/PMO-visible-by-default pulse is a burnout-surveillance instrument — "worse than no
  pulse at all." **ADR-0104 already specifies this gate and names these models**; this
  ADR consumes it.
- **#858 — promote retro action to backlog**: **already shipped** under ADR-0071
  (`promote_retro_action_item` service, `usePromoteRetroActionItem` hook, the per-item
  "Promote ↗" button at `RetroPanel.tsx:263`). This ADR's only obligation to #858 is to
  **preserve the affordance** when the retro surface becomes the live board.

**P3M layer**: Programs and Projects / Operations — single-project, team-scoped
self-governance. **OSS.** Any cross-team mood aggregation or PMO-visible rollup is a
**Portfolio-layer Enterprise 1.0** feature (file in `trueppm-enterprise`); this ADR does
**not** build it and structurally cannot reach it (the pulse gate denies non-members).

### Grounding in the actual code (verified 2026-06-11)

- `SprintRetro` (OneToOne→`Sprint`) + `RetroActionItem` (`projects/models.py:2363-2452`,
  both `VersionedModel`); `RetroVisibility` (`TEAM_ONLY`/`PROJECT`/`ORG`, ADR-0071) gates
  retro free-text *breadth*, NOT signal *tier* (ADR-0104 §reconcile — kept distinct).
- `ProjectSignalPrivacyPolicy` (`projects/models.py:2867`) **already exists** with the
  `pulse` signal defaulting to `{audience: TEAM, ceiling: TEAM}` (ADR-0104). Gate helpers
  `can_read_signal(request, project_id, "pulse")`, `requester_signal_tier`,
  `audience_can_read` in `signal_privacy_services.py` are ready to consume.
- `broadcast_board_event()` / `abroadcast_board_event()` (`sync/broadcast.py:38-114`):
  best-effort, `transaction.on_commit`-deferred, clients reconcile via sync delta on
  reconnect. `ProjectConsumer` (`sync/consumers.py:22`, group `project_{id}`, **Members+
  only — Viewers rejected**, Redis presence hash TTL 60s) relays `board.event`.
  `WorkshopConsumer` is the client→server *relay* precedent (allowlist + 60 fps rate
  limit + 4096-byte frame cap).
- Role ordinals (`access/models.py`): VIEWER=0, MEMBER=100, SCHEDULER=200, ADMIN=300,
  OWNER=400. PM is ADMIN. `TeamMembership.is_scrum_master` facet (ADR-0078/#927).
- All models UUID PK + `server_version`. Next migration: projects **0070**.

## Decision

### §1 — Two item kinds, kept distinct: discussion stickies vs distilled actions

A retro has two genuinely different artifacts, and conflating them is the trap:

- **Discussion stickies** — the live, multi-writer content the team brainstorms during
  the ceremony ("what went well / what to improve / ideas"). High volume, ephemeral,
  concurrent. **This is the new #851 surface.**
- **Action items** — the *distilled outcomes* the team commits to, which carry an
  assignee + story points and **promote to the backlog** (#858, `RetroActionItem`,
  unchanged).

**Decision: a NEW `RetroBoardItem` model for the live stickies, distinct from the
existing `RetroActionItem`.** Extending `RetroActionItem` was rejected (Alternative B):
its `assignee`/`story_points`/`promoted_task_id` fields are outcome-semantics that
pollute a brainstorm sticky, and the single-author upsert endpoint that owns it is the
wrong write path for concurrent editing.

**`RetroBoardItem`** (`projects/models.py`, `VersionedModel`, `objects =
models.Manager()` per the cross-app stubs convention):

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `retro` | FK→`SprintRetro` (CASCADE) | retro is `get_or_create`-d on first sticky (same lazy pattern as today's upsert) |
| `column` | CharField(choices=`RetroColumn`) | see §2 |
| `text` | TextField | the sticky body; server-capped at 2 000 chars |
| `author` | FK→User (PROTECT) | who created it; shown as attribution chip |
| `position` | DecimalField | fractional index for ordering within a column (drag-reorder without renumbering siblings — same idiom as ADR-0110 backlog reorder) |
| `color` | CharField(nullable) | optional DS-token swatch key; presentation only |
| `created_at` / `updated_at` | DateTime | |
| `server_version` | BigInteger | from `VersionedModel` — the LWW key (§3) and sync cursor |

`SprintRetro` gains a reverse `board_items` relation. `notes` and `action_items` on
`SprintRetro` are **unchanged** — they become sections *within* the new surface (§6).

**Sticky → action conversion (closes the discussion→action→backlog loop).** A one-click
`POST /api/v1/projects/{pid}/retro-items/{id}/convert-to-action/` creates a
`RetroActionItem` from a sticky's `text` (Member+), so the team turns a discussion point
into a committed action that then uses the **existing** #858 promote button. This is the
only coupling between the two kinds; it is one-directional and additive. *(In-scope but
low-risk — if the MR runs long it is the first fast-follow, since the board + pulse are
the VoC core.)*

### §2 — Columns: a fixed 3-column template for 0.3, configurable deferred

```
class RetroColumn(models.TextChoices):
    WENT_WELL  = "went_well",  "What went well"
    TO_IMPROVE = "to_improve", "What to improve"
    IDEAS      = "ideas",      "Ideas & discussion"
```

A fixed three-column template covers the dominant retro formats (Glad/Sad/Mad and
Start/Stop/Continue both map onto it) and avoids a configuration surface the VoC did not
ask for. **Per-team configurable column templates** (and sourcing them from the
methodology preset, ADR-0107) are a **deferred follow-up** (file post-merge). `column` is
stored as a string key, not an FK, so a future template system is additive with no data
migration of existing stickies.

### §3 — Concurrent write model: per-item last-write-wins on `server_version` (NOT CRDT)

**Decision: per-item LWW keyed on `server_version`, with optimistic UI and
sync-delta reconcile.** Justification, weighed against the decision framework:

- Stickies are **short, independent rows**. The common concurrency case is *different
  people editing different stickies* — which LWW handles with zero conflict. Two people
  editing the **same** sticky simultaneously is rare (you edit your own), and LWW's "last
  save wins, loser reconciles on next delta" is acceptable for a brainstorm note.
- The infrastructure for LWW **already exists**: `VersionedModel.server_version` is the
  monotonic cursor, and the board-event channel is explicitly *best-effort + reconcile-on-
  reconnect*. CRDT would bolt a second, parallel consistency model onto a system whose
  entire sync contract is delta-reconcile — large operational + contributor-pool cost
  (decision factors 3 + 4) for negligible benefit at retro scale (a handful of writers, a
  few dozen short notes). **CRDT rejected** (Alternative C).
- Offline (mobile, decision factor 2): `RetroBoardItem` is `VersionedModel`, so it rides
  the existing WatermelonDB delta protocol with tombstones — LWW is exactly what that
  protocol already resolves. CRDT would not.

**Writes go through authenticated REST, not a WS relay.** Create = `POST`, edit text =
debounced `PATCH` (on blur / typing pause, **not** per-keystroke), move = `PATCH
position`, delete = `DELETE`. Each write is RBAC-gated, audited via `VersionedModel`, and
on commit fires `broadcast_board_event` (§4). This is strictly safer than
`WorkshopConsumer`'s client→server relay (no untrusted frames to validate/rate-limit) and
matches the established board-mutation pattern. Per-keystroke relay was rejected as
unnecessary for retro cadence.

### §4 — WS channel: reuse `ProjectConsumer` board events; no new consumer

**Decision: broadcast retro mutations over the existing `project_{id}` board channel
with new event types — no new group, no new consumer.**

New `event_type`s on `broadcast_board_event`, all deferred with `transaction.on_commit`:

```
retro_item_created   retro_item_updated   retro_item_deleted   retro_item_moved
```

Rationale: the retro is project-scoped; `ProjectConsumer` **already** rejects Viewers and
admits Members+ — which *is* the team-private membership boundary the feature needs, for
free. Presence ("who is in the retro right now") **reuses the existing `ProjectConsumer`
Redis presence hash**; the web client tags its presence heartbeat with a
`context: "retro:{sprintId}"` marker so the board can render just the retro participants
without a second presence system. A dedicated `project_{id}_retro` group was rejected:
it adds a consumer + group lifecycle for a surface that is already correctly scoped, and
splits presence into two stores.

The `WorkshopConsumer` rate-limit / frame-cap precedent does **not** apply here because we
do **not** relay client frames — clients never write to the consumer; they `POST`/`PATCH`
via REST and *receive* broadcasts. The only client→server retro traffic is the existing
presence heartbeat, already rate-bounded.

### §5 — Team-health pulse (#923): consume ADR-0104's gate, add two models

ADR-0104 §1/§2 already names the models and fixes the gate (`pulse` default
`{audience: TEAM, ceiling: TEAM}`; above-tier readers get the trend **omitted entirely** —
"a redacted pulse is no pulse"). This ADR only specifies the model shape:

**`PulseResponse`** (`projects/models.py`, `VersionedModel`):

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `retro` | FK→`SprintRetro` (CASCADE) | the sprint's retro the pulse belongs to |
| `respondent` | FK→User (PROTECT) | |
| `mood` | PositiveSmallInteger (1–5) | one-tap |
| `energy` | PositiveSmallInteger (1–5) | one-tap |
| `confidence` | PositiveSmallInteger (1–5, **nullable**) | optional third dimension |
| `created_at` / `updated_at` | DateTime | |
| `server_version` | BigInteger | |

Constraint: **`unique(retro, respondent)`** (one response per person per sprint, editable
— a re-tap updates, satisfying "one tap" without locking the answer).

**`TeamHealthPulse`** is realized as the **aggregate read**, not a stored poll-config row
(YAGNI for 0.3 — the three dimensions are fixed). The trend endpoint computes, **server-
side**, per sprint: `{sprint_id, avg_mood, avg_energy, avg_confidence|null,
response_count}` across the project's sprints, **ordered by sprint start**. This is the
"two-sprints-before-velocity" signal Morgan needs.

**Privacy (the 🔴, enforced exactly as ADR-0104 dictates):**

- Read trend **iff** `can_read_signal(request, project_id, "pulse")` — i.e. requester
  tier `<= signal_visibility['pulse'].audience` (default `TEAM`). The team + SM band
  reads; the **PM/ADMIN band is omitted entirely** at the default; a **non-member is
  always denied** (the back-door close).
- The endpoint returns **aggregates only** — never an individual's raw `mood`/`energy`
  (except the requester's own current response echoed back so they can change it). No min-
  N gate is needed *within* the team boundary (the team may see its own mood); the privacy
  line is the upward `audience` gate, which is absolute.
- **No** pulse→PMO pipeline, **no** cross-team aggregation. `get_shared_team_signals`
  (ADR-0104 §3) already excludes `pulse` unless a team raises its ceiling — and its
  ceiling defaults to `TEAM`, so it cannot even be raised by a PM. Nothing further is
  built here.

### §6 — Surface composition + lifecycle

The new live board **becomes the retro surface**, composing existing pieces rather than
replacing them:

- **Sticky columns** (new, multi-writer) — the primary area.
- **Action items** section — the existing `RetroActionItem` editor + **the #858 "Promote
  ↗" button, unchanged** (the affordance this ADR is obligated to preserve).
- **Notes** — the existing single-author `SprintRetro.notes` summary (kept as a facilitator
  wrap-up field; not multi-writer).
- **Pulse** — the one-tap poll + team-only trend (§5).

`RetroPanel.tsx` is refactored into this composed surface (the single-author editor
becomes the "Action items" + "Notes" sections within it).

**Lifecycle / editable states.** Stickies and pulse responses are writable when
`sprint.state in {ACTIVE, COMPLETED}` — the live ceremony usually runs at/just-after
close, so a hard ACTIVE-only lock would shut the board at the exact moment teams use it.
**`CANCELLED` locks the board** (read-only). This mirrors how the existing retro upsert
already permits post-close edits.

**Coexistence / migration.** Purely additive — no data migration. Existing retros simply
have zero `board_items` and zero `PulseResponse`s until a team uses the new surface; they
render with an empty board and the unchanged notes/actions sections.

### §7 — API surface (API-first; every value a server fact, MCP-reachable)

All under the existing `projects` viewset namespace; all gated by project membership:

- `GET    /api/v1/projects/{pid}/sprints/{sid}/retro-board/` — stickies + columns +
  presence snapshot (Member+; Viewer gets the summary per `RetroVisibility`, consistent
  with today).
- `POST   /api/v1/projects/{pid}/retro-items/` — create sticky (Member+).
- `PATCH  /api/v1/projects/{pid}/retro-items/{id}/` — edit text / move (`position`) /
  recolor (Member+; LWW on `server_version`).
- `DELETE /api/v1/projects/{pid}/retro-items/{id}/` — (author or Admin+).
- `POST   /api/v1/projects/{pid}/retro-items/{id}/convert-to-action/` — §1 (Member+).
- `PUT    /api/v1/projects/{pid}/sprints/{sid}/pulse/` — upsert *my* response (Member+).
- `GET    /api/v1/projects/{pid}/sprints/{sid}/pulse/trend/` — aggregate trend, gated by
  `can_read_signal(..., "pulse")`.

Column ordering, fractional `position` resolution, and pulse aggregation are **all
server-computed** — the client renders server facts and derives no domain values. Every
endpoint is a plain authenticated REST route, so the MCP server reaches them with no
special-casing (ADR-0077).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: new `RetroBoardItem` (stickies) distinct from `RetroActionItem` (outcomes); per-item LWW REST writes + broadcast over the existing board channel; pulse = `PulseResponse` + server aggregate consuming ADR-0104's gate (chosen)** | Stickies and outcomes keep clean semantics; #858 untouched; reuses board channel + presence + best-effort/reconcile + `VersionedModel` sync; no new consumer; pulse privacy is settled by ADR-0104, not re-litigated; all additive | A second retro item model + a small set of new endpoints; the LWW "loser reconciles" case is visible (acceptable for short notes) |
| B: extend `RetroActionItem` to carry a `column` + author and serve as the sticky | One model | Outcome fields (`assignee`/`story_points`/`promoted_task_id`) pollute a brainstorm note; the single-author upsert endpoint is the wrong write path for concurrent editing; muddies #858. Rejected. |
| C: CRDT (e.g. Yjs/Automerge) per sticky for character-level merge | True conflict-free concurrent edit | A second consistency model parallel to the delta-reconcile sync contract; large operational + contributor cost; negligible benefit at retro scale; does not compose with WatermelonDB offline. Rejected. |
| D: dedicated `project_{id}_retro` WS group + new relay consumer (WorkshopConsumer-style) | Isolated retro traffic; client→server relay enables per-keystroke | New consumer + group lifecycle for an already-correctly-scoped surface; splits presence into two stores; per-keystroke relay needs frame-cap/rate-limit/allowlist for no retro-cadence benefit. Rejected — broadcast-only over the existing channel. |
| E: stored `TeamHealthPulse` poll-config row (open/closed, dimension set) | Future configurable polls | Dimensions are fixed for 0.3; a config row is unused state. Deferred — the aggregate read is the "pulse". |

## Consequences

- **Easier**: the team brainstorms a retro together in real time (the #1 VoC ask);
  discussion → action → backlog is one continuous flow (sticky → convert → #858 promote);
  the coach gets the mood/energy trend two sprints before velocity bends, walled off from
  the PMO by construction; offline + sync come free from `VersionedModel`.
- **Harder**: two retro item kinds to keep distinct in UI and docs; any *new* pulse read
  path must route through `can_read_signal` or it re-leaks (mitigated — there is exactly
  one trend endpoint and a regression test); the LWW reconcile is user-visible on the rare
  same-sticky collision.
- **Risks**: (1) broadcast storm if a large team types fast — mitigated by debounced
  PATCH (not per-keystroke) + the existing channel's best-effort drop + reconcile;
  (2) pulse de-anonymization upward — structurally impossible (gate omits entirely above
  tier; ceiling can't be PM-raised), asserted by the ADR-0104 🔴 tests reused here;
  (3) presence-context drift if the `retro:{sid}` marker is mis-set — falls back to
  showing all project-present users (degraded, not leaking).

## Implementation Notes
- **P3M layer**: Programs and Projects / Operations (single-project, team-scoped).
  Cross-team mood aggregation is Portfolio → Enterprise (not built here).
- **Affected packages**: api (`RetroBoardItem` + `PulseResponse` models, serializers,
  viewset actions, broadcast event types, convert + pulse-trend endpoints, pulse gate
  consumption); web (live board surface refactored from `RetroPanel`, presence chips,
  one-tap pulse + team-only trend, sticky drag/reorder, convert affordance; #858 promote
  button preserved). No scheduler change. Mobile: web-first in 0.3; both models are
  `VersionedModel` (sync-ready for 0.4, deferring like `SprintRetro`).
- **Migration required**: **yes** — additive: `RetroBoardItem`, `PulseResponse` (+ their
  sync indexes). No NOT-NULL-without-default hazard (`color`/`confidence` nullable;
  `position` defaulted). Run `makemigrations` (never hand-write); do not hard-code the
  projects-app counter (expected **0070**, but renumber if another model-bearing branch
  merges first — see #986/#1106 in flight).
- **API changes**: yes — the §7 routes. Regenerate `docs/api/openapi.json` **after merging
  origin/main**. Add `ENUM_NAME_OVERRIDES` for `RetroColumn` if drf-spectacular collides
  with another `*Column`/state enum (per the known enum-collision regression).
- **OSS or Enterprise**: **OSS** — the board, the pulse, and the team-only trend are OSS.
  Cross-team mood rollup / coaching-maturity dashboard is Enterprise 1.0 (file separately;
  registers against ADR-0104's `get_shared_team_signals` — not this ADR).
- **Coordinate with**: ADR-0104 (the pulse gate — settled, consumed here), ADR-0071
  (#858 promote + the absorbed single-author retro), ADR-0094 (sprint-state editable
  window), ADR-0078/#927 (SM facet for any future facilitator-gated retro action),
  ADR-0110 (the fractional-`position` reorder idiom), ADR-0107 (future configurable column
  templates), ADR-0077 (MCP reachability).

### Durable Execution
1. **Broker-down behaviour**: N/A for a queue — retro item CRUD and pulse upsert are
   synchronous DB writes; their only side effect is a **best-effort** WS broadcast fired
   in `transaction.on_commit` (the established board-event model). A dropped broadcast is
   self-healing: clients reconcile via the sync delta on next poll/reconnect. No outbox is
   warranted (broadcast is intentionally best-effort, not at-least-once). The one async
   tail is the **existing** #858 promote path (`promote_retro_action_item` → Task create →
   `enqueue_recalculate`), unchanged by this ADR.
2. **Drain task**: N/A — no new async category. The #858 promote path reuses
   `scheduling/services.py::enqueue_recalculate` and its existing CPM drain; semantics
   are unchanged.
3. **Orphan window**: N/A — no outbox rows. Broadcasts fire post-commit, so clients never
   see uncommitted stickies; reconcile covers any dropped event.
4. **Service layer**: new thin `retro_board_services.py` functions
   (`create_board_item` / `update_board_item` / `move_board_item` / `delete_board_item` /
   `convert_to_action` / `upsert_pulse_response`) own the write + the
   `transaction.on_commit(broadcast_board_event)` deferral, so the viewset stays thin and
   the broadcast point is single-sourced. Pulse aggregation is a read service
   (`pulse_trend`) that calls `can_read_signal` before assembling numbers (ADR-0104 §2).
5. **API response on best-effort dispatch**: synchronous — the write endpoints return the
   created/updated resource (201/200) directly; there is no queued task to report. The
   broadcast is fire-and-forget on commit.
6. **Outbox cleanup**: N/A — no outbox rows created.
7. **Idempotency**: pulse upsert is idempotent by the `unique(retro, respondent)`
   constraint (`update_or_create` on that key — a re-tap updates, never duplicates).
   Sticky create is not idempotent by nature (each POST is a distinct sticky, as intended);
   edits/moves are LWW on `server_version` so a replayed PATCH with a stale version is
   rejected/no-ops. `convert-to-action` guards against double-convert by recording the
   source sticky id on the created `RetroActionItem` (skip if already converted).
8. **Dead-letter / failure handling**: N/A for the synchronous writes. A failed broadcast
   is silently dropped by design (best-effort) and recovered by sync reconcile — the
   documented, accepted board-event behaviour; no DLQ.
