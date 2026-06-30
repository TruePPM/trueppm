# ADR-0192: Board Viewability Overhaul — Fixed-Width Sticky Grid, Column Collapse, Phase-Lane Focus, Worst-Offender Card Badge

## Status
Accepted

## Context

User feedback: **"the boards are hard to view."** The Kanban board
(`packages/web/src/features/board/BoardView.tsx`) is the daily working surface for
delivery teams (Operations layer), but its layout degrades on real multi-phase
projects at common laptop widths (1024–1440px).

Confirmed root causes in code, contrasted with the reference implementation in
`~/repos/visiban`:

1. **Fluid columns.** Both grid definitions use
   `repeat(${colCount}, minmax(0, 1fr))` (`BoardView.tsx:713` and `:2478`, plus
   `PhaseMilestoneRail.tsx:129`). Every status column is forced to an equal fraction
   of the viewport, so cards squish, chips wrap, and titles truncate. There is no
   horizontal scroll — columns shrink instead of overflowing. *This is the primary
   cause.*
2. **Partial sticky orientation.** The column header row is already
   `sticky top-0 z-10` (`BoardView.tsx:2476`), but the phase-lane meta column
   (`LaneMeta`) is **not** `sticky left-0`. Once columns become fixed-width and the
   board scrolls horizontally, the phase label/progress scrolls out of view and the
   user loses orientation.
3. **No column collapse.** Phase *lanes* (rows) collapse via
   `useBoardCollapsedLanes(projectId)` (`BoardView.tsx:815`, localStorage
   `trueppm.board.${projectId}.collapsedLanes`), but status *columns* cannot.
4. **No phase-lane focus.** No way to isolate a single phase lane.
5. **Card chip overload.** `BoardCard.tsx` (comfortable/detailed) stacks up to ~14
   chips (readiness, type, priority rank, CP, assignees, overalloc, entry-stamp,
   notes, aging, float, SPI, CPI, cost, baseline). Scanning a busy lane is hard
   (tracked separately as #1305).

This ADR covers epic **#1457** and its children **#1458** (layout keystone),
**#1459** (column collapse), **#1460** (phase-lane focus), and the card-density work
**#1305** (worst-offender badge) pulled into 0.4. It also resolves the persistence
question shared with **#285** (column/phase drag-resize, persisted).

**P3M layer:** Operations / Programs and Projects — a single-project board surface.
Per `.claude/personas.md` resonance rules and the VoC panel run for this work, the
load-bearing personas are Alex (Scrum Master, 7/10) and Morgan (Agile Coach, 7/10);
the low scores came entirely from governance personas (Janet 3, Marcus 2) whose
cross-project criteria a single-project readability change cannot and should not
serve. This confirms **OSS** placement. `grep -rn "trueppm_enterprise" packages/`
returns zero OSS imports — boundary clean.

## Decision

A **frontend-only** overhaul of the desktop board grid. **No API change, no
migration, no async work.** Four parts:

### 1. Fixed-width sticky 2-tier grid (#1458)

- Replace `repeat(N, minmax(0, 1fr))` with **fixed-width** column tracks:
  `repeat(N, var(--board-col-w))`. The board content wrapper gets `min-w-max` and the
  existing outer board container remains the single horizontal+vertical scroll
  context. Header row, every phase-lane row, and `PhaseMilestoneRail` share that one
  scroll container so columns stay vertically aligned.
- **Extend ADR-0145's zoom tokens** rather than introduce a new mechanism. Add a
  `--board-col-w` token to `BOARD_ZOOM_VARS` (small/normal/large) alongside the
  existing `--board-phase-col`/`--board-col-gap`. **Column width remains a CSS grid
  track, never `transform: scale()`** — ADR-0145 established that `scale()` breaks
  dnd-kit drag-coordinate math; that constraint is preserved.
- Make the phase-lane meta column `sticky left-0`. Establish a z-index hierarchy:
  **sticky corner / left sidebar (highest) > sticky top header > body cells**,
  matching Visiban's `z-30 / z-20 / z-0` layering (current header uses `z-10`; the
  sidebar must sit above it).
- **Mobile path unchanged.** The `<md` `MobileBoard` snap-scroll reflow and the
  `useBoardDensity()` mobile `compact` auto-select are untouched. This ADR targets the
  `≥md` grid only.

### 2. Column collapse-to-stub (#1459)

- A per-column collapse control in the column header. Collapsed → the column track
  narrows to a thin stub (`--board-col-w-collapsed`, ~28px) showing a status color
  dot, vertical label abbreviation, and a card-count badge that adopts the existing
  WIP banding (`wip.ts` `wipState()` → red `over` / amber `at`), independent of the
  "Show WIP limits" toggle (mirrors the existing header-tint behavior at
  `BoardView.tsx:2486`).
- Persist per-user, per-project in a **new localStorage key**
  `trueppm.board.${projectId}.collapsedColumns` (a `string[]` of statuses), mirroring
  the existing `collapsedLanes` hook exactly (`useBoardCollapsedColumns(projectId)`).
- A sticky banner appears when ≥1 column is collapsed: "**N columns collapsed ·
  Expand all**", consistent with the existing lane collapse-all (`[`/`]`).
- **VoC enhancement (Alex):** the collapsed stub's WIP-breach badge is tappable →
  a small popover listing each breaching column by name + count, so overload can be
  triaged without expanding the board.

### 3. Phase-lane focus mode (#1460)

- A focus control on each phase-lane header. Entering focus collapses all *other*
  lanes and expands the focused lane.
- **Snapshot + restore:** capture the current `collapsedLanes` set before focusing and
  restore it exactly on exit, so focus never clobbers the user's manual collapse
  prefs. The snapshot lives in component state (ephemeral) since the durable state is
  the URL.
- **Shareable via URL.** Add a `?focus=${phaseId}` param read/written through the same
  `useSearchParams` pattern as `?standup=1` / `?sprint=` (`BoardView.tsx:1297`,
  `:1154`). Loading a `?focus=` URL re-enters focus. **The existing `?sprint=` param
  composes naturally** — a focused-within-a-sprint view carries both params, which
  satisfies the VoC constraint (Alex) that focus links retain sprint scope. No new
  param shape is needed for sprint context.
- A sticky banner: "**Focused on: {phase} · Exit focus**".

### 4. Worst-offender card badge (#1305)

- Consolidate the stacked chips into **one primary badge** that is **expandable, not
  lossy**. The badge shows the single highest-severity signal computed client-side
  from already-hydrated card fields (ADR-0115 / ADR-0152 already provide
  `isBlocked`, `predecessorCount`, `linkedRisksCount`/`linkedRisksMaxSeverity`,
  `dwellDays`/`isStalled`, `totalFloat`, `spiBand`/`cpiBand`). Hover/focus (and tap on
  touch) reveals the full existing chip set behind a disclosure — the current chips
  are reused, not deleted.
- **VoC constraints honored:**
  - *Non-lossy (David + Alex):* the badge keeps counts (e.g. "2 blocked", "3×
    over-alloc"); the full chip set is one interaction away.
  - *Neutral "worst" definition (Morgan):* severity ordering is derived from
    objective signals (blocked → over-SLA/stalled → critical-path/negative-float →
    at-risk EVM → on-track), **not** from PM-assigned priority rank. Priority rank
    stays a separate corner affordance.
  - *Respects grouping language (Jordan):* badge copy uses the active grouping's
    vocabulary where applicable.
- Pure client render — no serializer or endpoint change.

### Persistence decision (resolves #285 overlap)

**Per-user board view-state — collapsed columns, column widths, focus snapshot — is
client-side**, not a new server model:

- Collapsed columns → localStorage `trueppm.board.${projectId}.collapsedColumns`.
- Column/phase widths (#285) → localStorage `trueppm.board.${projectId}.columnWidths`
  (a `Record<status, px>`), mirroring how zoom already persists in
  `useBoardToolbarPrefs` (`trueppm.board.toolbarPrefs.v1`).
- Focus lane → URL `?focus=` (shareable) + ephemeral snapshot in component state.
- **Every new localStorage blob carries `schema_version: int`** per ADR-0086, read
  through the same forward-migration guard convention. The simple `string[]`
  collapsed-columns key follows the existing `collapsedLanes` precedent (versioned
  wrapper).

This matches the established convention (ADR-0057 backlog rail, ADR-0145 zoom,
`collapsedLanes`): ephemeral per-user-per-browser view state → localStorage;
project-level *shared* config (column labels, colors, WIP limits) stays on the server
`BoardColumnConfig` (unchanged). It avoids a migration + sync surface for a web-only
nicety.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Fixed-width tracks + sticky-left sidebar + localStorage view-state** (chosen) | Convention-aligned (ADR-0145/0057/0086); zero API/migration; preserves dnd-kit math; ships in one frontend MR | View-state not shareable across a user's own devices; no server analytics on collapse usage |
| B. New per-user server model (`BoardUserViewState`, `ProjectMembership` pattern) for collapse/width/focus | Cross-device persistence; mobile could restore; sync-participating | New model + migration + serializer + viewset + sync surface for a web-only nicety; over-builds a 0.4 readability fix; slower |
| C. `transform: scale()` zoom for density instead of fixed tracks | Trivial CSS | **Rejected by ADR-0145** — breaks dnd-kit drag coordinates; regresses drag-and-drop |
| D. Keep fluid columns, only add horizontal min-width breakpoints | Smallest diff | Doesn't fix the core squish at 1024–1440px; columns still fight for fractions |
| E. Fold worst-offender "worst" into PM priority rank | Simplest signal source | **Rejected by VoC (Morgan)** — imports management's priority model onto the team's view; not a neutral health signal |

## Consequences

**Easier:**
- Board is readable and scannable at laptop widths; columns hold a comfortable fixed
  width and the board scrolls horizontally with header + phase sidebar pinned.
- Teams can collapse noise columns and focus a single phase for standups/reviews;
  focus views are shareable links.
- Cards scan at a glance via one primary badge, with full detail one interaction away.

**Harder / risks:**
- **Sticky layering is fiddly.** Two-axis sticky (top header + left sidebar +
  corner) with dnd-kit overlays and the existing `PhaseMilestoneRail` must be tested
  for z-index/scroll-jank regressions. Mitigate with explicit z-index tokens and a
  Playwright scroll test.
- **dnd-kit + horizontal scroll.** Drag autoscroll across a now-horizontally-scrolling
  container must still resolve drop targets correctly. Mitigate by keeping fixed grid
  tracks (no transform) and verifying drag onto off-screen columns.
- **Worst-offender severity ordering** is a product judgment; getting the ranking
  wrong erodes trust. Mitigate by keeping the full chip set reachable (non-lossy) so
  the badge is an *index*, not a *replacement*.
- **localStorage blob proliferation.** Three keys per project; mitigate by reusing the
  `collapsedLanes` versioned-wrapper helper and honoring ADR-0086 `schema_version`.
- **E2E surface.** Many board specs assert on layout/structure; the grid refactor will
  touch `board.spec.ts` and siblings. Grep `packages/web/e2e/` before committing.

## Implementation Notes
- **P3M layer:** Operations / Programs and Projects (single-project board).
- **Affected packages:** `web` only.
- **Migration required:** **No.**
- **API changes:** **No.** Worst-offender badge reads already-hydrated serializer
  fields (ADR-0115/0152). No new endpoints, serializers, or fields.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). Boundary verified clean.

### Screens/states to design in Claude Design (DesignSync import)
1. **Fixed-width board, default** — desktop ≥md, normal zoom, 3–5 phase lanes ×
   5 columns; show the horizontal scrollbar and a partially-scrolled state with the
   phase sidebar + column header pinned (the sticky corner visible).
2. **Zoom small / large** — same board at the two other zoom widths.
3. **Collapsed column stub** — one or two columns collapsed to stubs (status dot,
   vertical label, count badge), including an over-WIP (red) and at-WIP (amber) stub;
   plus the "N columns collapsed · Expand all" sticky banner; plus the tappable
   WIP-breach popover listing breaching columns.
4. **Phase-lane focus mode** — one lane focused, others hidden, "Focused on: {phase}
   · Exit focus" sticky banner; show the focus control affordance on a lane header.
5. **Worst-offender card badge** — card collapsed (single primary badge with count)
   and expanded (hover/focus disclosure showing the full chip set), at comfortable and
   detailed densities, for: blocked, over-SLA/stalled, critical-path, at-risk EVM, and
   on-track variants.
6. **(Optional, #285)** column/phase resize affordance (drag handle on column/lane
   edge) and the resized state.

### Durable Execution
1. **Broker-down behaviour:** N/A — feature has zero async side effects; it is a
   frontend read-path + client-persisted UI state change. No `.delay()`, no outbox.
2. **Drain task:** N/A — no async work introduced.
3. **Orphan window:** N/A — no DB writes, no `on_commit` callbacks.
4. **Service layer:** N/A — no backend dispatch. (Worst-offender severity is computed
   client-side from existing hydrated fields; no `services.py` change.)
5. **API response on best-effort dispatch:** N/A — no new endpoint; no mutation.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** N/A — no tasks. View-state writes are last-write-wins localStorage
   sets, inherently idempotent; URL `?focus=` is declarative.
8. **Dead-letter / failure handling:** N/A — no tasks. localStorage write failure
   (quota/private mode) degrades gracefully to in-memory state for the session
   (mirror the existing `collapsedLanes` try/catch).
