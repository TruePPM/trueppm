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
| #381 | Backlog rail + new card style + drag rules | merged |
| #382 | Calm toolbar (chips / pill toggles / layout switcher / `More⋯`) | merged |
| #383 | Drawer layout variant | merged |
| #384 | Queue layout variant | merged |
| #385 | Phase-grid quieting (empty-cell ticks, `LaneMeta` inline progress, `ColHeader` redesign) | merged |

Children B–E will amend this ADR as they land.

### Child B addendum (#382) — calm toolbar

The 14-control toolbar row collapses into:

- **Identity block** — `BoardViewDropdown` (saved views) + project name + activity stats (`{N} active · {N} in backlog`).
- **Primary chips** — `Group: Phase`, `Sort: {value}`, `Density: {value}`. Each is a rounded pill that opens a `role="dialog"` popover with `radiogroup` options. The Density popover exposes both *board-card* density (existing `useBoardDensity`) and *backlog-card* density (new, persisted via `useBoardToolbarPrefs`).
- **Quiet pill toggles** — `★ My tasks`, `⚠ At-risk`, `$ Cost`. No border at rest, sunken-fill when active. `aria-pressed` reports state. The `aria-label` on the cost pill remains `"Show cost"` for backwards compatibility with existing tests and saved-view configs.
- **Layout segmented control** — `Rail · Drawer · Queue`. All three persist via `useBoardToolbarPrefs` (localStorage key `trueppm.board.toolbarPrefs.v1`); only `rail` actually renders a backlog layout until siblings #383 (drawer) and #384 (queue) plug in. Selection survives reload — verified in `board-calm-toolbar.spec.ts`.
- **`More⋯` overflow popover** — secondary controls cut from the primary row: Collapse all, Expand all, Show WIP, Column tints, EVM, Columns, Keyboard shortcuts, Workshop. The popover persists open across button-clicks inside it so a user can collapse-then-expand without re-opening.

No behaviour changes: every control delegates to the same setters previously wired in `BoardView.tsx`. The change is a pure surface refactor scoped to `packages/web/src/features/board/CalmToolbar.tsx` and a new `useBoardToolbarPrefs` hook.

### Child D addendum (#384) — Queue layout

When `toolbarPrefs.layout === 'queue'`, `BoardView` renders `QueueLayout` in
place of *both* the rail/drawer surface *and* the phase grid. The queue is a
single flat priority-ordered list grouped into four sections:

| Section | Status filter | Sort |
|---|---|---|
| **Next up · ready to pull** | `NOT_STARTED` | `priorityRank` asc |
| **In flight** | `IN_PROGRESS` + `REVIEW` | `priorityRank` asc |
| **Backlog · needs decision** | `BACKLOG` | `statusEnteredAt` desc |
| **Recently done** | `COMPLETE` within 14 days | `actualFinish` desc |

`ON_HOLD` is intentionally inert (legacy status). Summary tasks are excluded.
The recently-done window is fixed at 14 days — long enough to anchor a "what
shipped lately" mental model, short enough to prevent the section from
growing unboundedly on long-running projects.

`QueueRow` is a table-style row with a fixed grid:
*priority histogram · phase tag · name + CP/risk/milestone affordances ·
readiness chip OR status dot+name+pct · duration + owner avatar · overflow*.
BACKLOG rows render the readiness chip and use italic + secondary tone for
the name (idea treatment); committed rows render a status dot + label + %
complete. The CP affordance is a "CP" badge per rule 26 (color alone is
insufficient); risk is a `⚠` glyph; milestone is a `◆` diamond.

Drag from queue rows is intentionally out of scope for v1 — the queue is a
read/sort surface. Promote/demote via row overflow menu lands in a
follow-up; for now the `⋯` button renders as a disabled placeholder so
keyboard tab order is preserved.

The same task-level filters (`cpOnly`, `dueSoonDays`, `mineActive`,
`riskLinkedOnly`) that apply to the phase grid apply to the queue, so
switching layouts never reveals hidden work.

### Child E addendum (#385) — phase-grid quieting

Once children B–D shipped, the phase grid was the loudest surface left in
the board: empty cells rendered as full card-shaped slots, and the column
header relied on a band tint that competed with the new toolbar's calm
palette. Child E quiets all three column-grid atoms.

**Empty cells** — when `tasks.length === 0` and no drag is active, the cell
collapses to a 16px-tall row containing a 32×1px tick on
`bg-neutral-border/60`. No card outline, no surface fill, no "drop here"
hint. The droppable is still wired up; during drag (`isDragActive`) the
cell expands back to its full `min-h-[120px]` slot so the user has a clear
target. The tick is `aria-hidden="true"` — the column header's accessible
count chip already announces "0 tasks" to assistive tech, so a tick with
its own announcement would be redundant.

**LaneMeta** — the row-2 layout drops `ProgressRing` (a 36×36 SVG arc)
in favour of an inline 4px `role="progressbar"` bar with a mono percent
label and the existing task count. The bar uses `bg-semantic-on-track`
above 50% and `bg-brand-accent` below — same colour story as the prior
ring. ADR-0057's em-dash empty state continues to apply (no committed
tasks → bar empty, percent reads `—`); the bar drops `aria-valuenow` in
that case and reports `aria-label="No committed tasks"` instead.

**ColHeader** — the inline column header (`BoardView.tsx`) gains a 6px
status dot prefix per status: `NOT_STARTED` → `bg-neutral-text-disabled`,
`IN_PROGRESS` → `bg-brand-primary`, `REVIEW` → `bg-brand-accent`,
`COMPLETE` → `bg-semantic-on-track`. The dot is `aria-hidden`; the label
already carries `aria-label="${col.label}, ${count} tasks"`. The count
chip moves to `tppm-mono`, and the WIP fraction (when `wipLimit` is set)
is right-aligned via `ml-auto`. The earlier WIP-state band tint is kept
on `at` and `over` states only — the dot prefix carries the resting
signal, so a tint at rest would compete.

**Done column tint** — `COLUMN_TINT.COMPLETE` drops from
`bg-semantic-on-track/5` to `bg-semantic-on-track/[0.025]`. The status
dot already labels the column as the close-out lane, so the cell tint
can step back toward neutral without losing the affordance.

The workshop variant of `LaneMeta` is unchanged (contentEditable name +
drag handle); the inline bar applies in workshop mode as well.

## Consequences

**Positive:**
- Phase progress, the capacity heat map, and Monte Carlo input all draw from
  the single ORM-enforced `Task.committed` manager, so BACKLOG intake work no
  longer drags the progress denominator or pushes resources into the
  over-allocated band on uncommitted cards (David's capacity-bleed hard-NO and
  Marcus's data-trust concern are addressed at the data layer, not per consumer).
- The left-side BACKLOG rail makes intake phase-agnostic without a schema change,
  removing premature phase assignment and BACKLOG pollution from Schedule and PDF
  exports. Drawer and Queue layout variants reuse the same `backlog-band` droppable.
- Demotion out of a committed state is gated (confirm + free audit via
  `simple_history`) and forward-from-started demotion is blocked, closing the
  "scope slips in quietly" pattern.

**Costs / limitations:**
- Consumers must opt in to `Task.committed`; the default `Task.objects` still
  returns BACKLOG, so any new aggregation that forgets to switch managers
  reintroduces the bleed. This is mitigated by being greppable in one place.
- The committed/BACKLOG partition is a view-layer convention over WBS L1 phases
  (no `phase_id` FK), so the renderer must keep ignoring `parent_id` for BACKLOG
  cards; existing parented BACKLOG cards are tolerated with no migration.
- Several promised refinements (progress-anchor gate, auto-promote, demote-reason
  capture, assignee push notification) are deferred — see "Out of scope" below.

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

## Tracking

Tracking: implemented across epic #361 children (#381–#385). The progress-anchor gate
and auto-promote are tracked by #362; the demote-reason capture and sprint-membership-as-
CPM-anchor follow-ups are deferred — not yet filed.
