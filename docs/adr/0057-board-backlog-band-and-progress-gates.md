# ADR-0057: Board BACKLOG rail, phase progress chip, and `Task.committed` manager (#361)

## Status
Accepted (rail layout direction confirmed 2026-05-08 via Claude Design handoff
`Backlog Redesign.html`; epic split into 5 children — see "Implementation
slices" below).

## Context

The Board view rolls phase progress from every card in the phase, including
BACKLOG. Backlog is intake — undated, unrefined, not-yet-committed work — so
its zero-percent rows drag the denominator down and produce a misleading
"Project Tasks · 22% · 8 tasks" status signal. The same rollup feeds the
capacity heat map and the Monte Carlo simulation, so BACKLOG bleed isn't
purely cosmetic: it pushes resources into the over-allocated band on cards
the team hasn't committed to.

A six-persona VoC panel scored the existing layout 5.0/10 with multiple
🔴s. Two coupled issues surfaced:

1. BACKLOG cards live inside a phase, which forces premature phase
   assignment and pollutes Schedule + PDF exports.
2. Progress can be entered without a date anchor, so the chip moves to
   "in progress" before the card is actually committed.

To keep this slice tight, only #1 ships in 0.1. The progress-anchor gate
and the auto-promote NOT_STARTED → IN_PROGRESS rule spin out as #362 in
0.2.

**P3M layer**: Programs and Projects (single-project execution surface). **OSS.**

## Decision

### Q2 — `Task.committed` manager (data-layer enforcement)

Add a `Task.committed` manager that filters `status != BACKLOG` and
`is_deleted=False`. Default `Task.objects` is unchanged — the Board view
needs to *see* BACKLOG to render it in the band.

New consumers opt in:

- Board phase progress aggregation (web — committed-only after partition).
- Schedule view query (api/web).
- Capacity / heat map input — `_check_overallocation` in
  `apps/resources/views.py`.
- Monte Carlo simulation input — `run_monte_carlo` in
  `apps/scheduling/views.py`.
- Client PDF export.

Single source of truth, ORM-enforced, easy to grep — addresses David's
hard-NO on capacity bleed and Marcus's data-trust concern.

### Q4 — BACKLOG rail (left side), phase-agnostic, expand-by-default

`BoardView.tsx` partitions cards before grouping: cards with
`status === 'BACKLOG'` go into the `BacklogBand` (rendered as a left-side
rail). The phase grid to the right of the rail shows only committed columns
(TO DO / IN PROGRESS / REVIEW / DONE) — the inline BACKLOG column inside
phases is removed from `COLUMNS` in `BoardView.tsx` regardless of what
the saved board config says.

The rail layout supersedes the original "horizontal band above the grid"
direction (the first implementation pass before the Claude Design handoff).
Two alternate layouts — *Drawer* (top horizontal strip) and *Queue* (single
prioritised list grouped *Next up · In flight · Backlog · Recently done*) —
are filed as siblings #383 / #384 and consume the same drag droppable id
(`backlog-band`) so the drag rules below apply uniformly.

No schema change. "Phase" is already a view-layer abstraction over WBS L1
summary tasks (no `phase_id` FK exists), so BACKLOG cards are inherently
phase-agnostic in the data model.

Collapsed-state preference persists in `localStorage`
(`trueppm.board.backlogBand.collapsed`) — no new endpoint. Collapsed view
is a 44 px vertical strip with rotated text + stalled-count badge.

`BacklogCard` is a dedicated component, distinct from `BoardCard`:
no progress bar (BACKLOG is undated), no SPI / EVM / cost chips, instead a
priority-bar histogram, `ReadinessChip` (idea / estimated / ready /
baselined), phase-color left rail (3 px), stalled indicator at age ≥ 5 d.
Three densities (compact / comfortable / full) — for child A the rail
defaults to comfortable; child B's calm toolbar will expose the switch.

### Q7 — Backwards compatibility

Existing BACKLOG cards parented to a phase keep their `parent_id`; the
band-vs-grid renderer ignores the parent for BACKLOG cards. No data
migration. No legacy-fix Celery task.

### Drag rules — TO DO behaviour (VoC outcome 2026-05-08)

A pre-implementation VoC pass scored three options for the demote rule
on cards already in TO DO:

| Option | Headline | Tally |
|---|---|---|
| A | Locked at TO DO — no demotion | 0 votes |
| B | Frictionless demote, no audit signal | 2 votes (Sarah, Janet) |
| **C** | **Demote allowed with confirm + audit** | **4 votes** (David 🔴 on B, Alex 🔴 on B, Marcus, Priya) |

Option **C** ships. David flagged silent demotion as a hard NO (capacity
heat map updates without him knowing). Alex matched it: silent mid-sprint
scope shrinkage is the canonical "slips in quietly" pattern from his
hard-NO list.

Mechanics:

- BACKLOG → committed column: standard dnd-kit drop, sets `status`. The
  card's `parent_id` is left intact when a card moves out of the band
  (drag-from-band uses the destination's phase as parent only in
  workshop mode, matching the existing `phaseChanged` path).
- TO DO (NOT_STARTED) → BACKLOG band: opens
  `BacklogDemoteConfirmDialog`. Confirm fires the `status=BACKLOG`
  PATCH; cancel and Esc both no-op.
- IN_PROGRESS / REVIEW / COMPLETE → BACKLOG band: blocked. The
  `aria-live` region announces *"X cannot move to backlog — work has
  already started."*
- ON_HOLD (legacy) → BACKLOG band: no confirm — ON_HOLD is not a
  committed delivery state, so the lock doesn't apply.

Audit comes for free: `simple_history` already tracks the `status`
field, so `TaskHistoryView` returns the demotion in the diff list.
Sarah's mobile-friction concern is mitigated by focus-first confirm
button + Escape-to-cancel — no precision tap needed.

## Implementation slices (epic #361 children)

The work landed against this ADR is split across five children so each MR
stays reviewable. All target milestone 0.1.

| # | Slice | Status |
|---|---|---|
| #381 | Backlog rail + new card style + drag rules | active (this branch) |
| #382 | Calm toolbar (chips / pill toggles / layout switcher / `More⋯`) | queued |
| #383 | Drawer layout variant | queued |
| #384 | Queue layout variant | queued |
| #385 | Phase-grid quieting (empty-cell ticks, `LaneMeta` inline progress, `ColHeader` redesign) | queued |

Children B–E will amend this ADR as they land.

## Out of scope (split to #362, milestone 0.2)

- Progress-anchor gate (`progress_requires_anchor` 400 + inline
  date-picker popover).
- Auto-promote NOT_STARTED → IN_PROGRESS on first non-zero progress.
- Sprint-scoped + no-`planned_start` "not on critical path" footer chip.
- Push notification to assignees on demote (Priya's
  follow-up — needs notifications system change, separate slice).
- Reason capture on the demote dialog (Alex's retro want — could ship
  via `history_change_reason`; deferred to keep this slice tight).

## Out of scope (deferred per ADR-0036)

- Sprint membership as a CPM date anchor — deferred to v1.1.

## Touched ADRs
ADR-0013 (Board view), ADR-0014 (5-column model), ADR-0023 (sync),
ADR-0036 (sprint commitments), ADR-0039 (Board state persistence),
ADR-0047 (status-aware computation).

## Implementation notes

- Backend manager additions in `apps/projects/models.py` are a
  metadata-only change — no migration required (verified via
  `manage.py makemigrations --dry-run`).
- The Manager is declared *after* `objects = models.Manager()` so the
  default manager is preserved; this matters because `VersionedModel.save()`
  reaches for `type(self).objects` directly.
- Helper bubble (one-time "phase progress now reflects committed work
  only") was scoped out of 0.1 to keep the diff focused. The em-dash
  empty state on `LaneMeta` already signals the change visually for
  phases that drop to zero committed cards after the partition.
