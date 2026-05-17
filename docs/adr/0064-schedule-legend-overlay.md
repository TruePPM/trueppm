# ADR-0064: Schedule Legend Overlay

## Status
Accepted

## Context

The Schedule (Gantt) view uses several visual elements that are not self-evident to
new users: summary rollup bars, task bars with progress-fill shading, milestone
diamonds, dashed baseline lines, finish-to-start dependency arrows, and merged-trunk
convergence arrows with midpoint dots (ADR-0063). First-week users routinely ask
"what does the orange diamond mean?" or "why are some lines dashed?" — a learning
curve that a static legend resolves in seconds.

Issue #474 calls for a floating legend overlay on the schedule canvas: visible by
default, collapsible to a header chip, persisted across sessions. This ADR records
the placement, persistence, responsive, and export decisions made before
implementation.

The legend covers nine canvas elements grouped on three rows: **bar variants**
(summary rollup, task with progress fill, complete), **state markers** (critical
path, milestone, today line), and **lines and arrows** (planned baseline,
finish-to-start, merged trunk). The original issue listed six; critical path,
complete, and today were added on review because they are high-frequency canvas
elements with dedicated render paths in `GanttRenderer.ts`. SS / FF / SF
dependency arrows, cross-arrow bridge hops, and drag-preview bars are
intentionally out of scope — rare in OSS-tier projects or transient.

### Constraints from VoC (panel avg 5.0/10, no 🔴, two 🟡)

- 🟡 **PDF export inclusion must be decided now, not deferred.** Sarah (PM) blocks
  if the legend appears on client-facing PDFs; Marcus and Janet would want it on
  board-ready exports. Today the schedule has no PDF export pipeline at all
  (ADR-0062 covers only BurnChart), so the question reduces to: is the legend
  inside or outside the canvas DOM?
- 🟡 **Hide below desktop breakpoint** — small viewports risk obscuring the first
  task row.
- 🟢 localStorage per-browser is the right persistence scope.
- 🟢 Placement guardrails: must not obscure horizontal scrollbar, first task row,
  today line, or rightmost bars at narrow widths.

## Decision

### Placement

Mount as a React DOM sibling of `MilestoneDeltaTooltip` and `MilestonePulseOverlay`
at the `ScheduleView.tsx` return level — **outside** the canvas scroll container
(ADR-0040 "rule 31" pattern: overlays escape `overflow:hidden`).

Position: `absolute bottom-4 left-4`, anchored to the canvas scroll container's
parent — **bottom-left** of the canvas viewport, not bottom-right. Rationale:

- The rightmost bars are where Alex (Scrum Master) flagged risk of obscuring data
  during stand-up screen-shares.
- Today line is typically center-ish horizontally; bottom-left clears it.
- The unscheduled gutter sits below the canvas (full-width), the Monte Carlo row
  below that — so "bottom-left of the canvas" is the bottom-left of the scroll
  container itself, above the gutter.

Z-index: `z-20` — above the canvas stack (`z-0`..`z-2`) and below the
TaskDetailDrawer panel (`z-40`), tooltips/popovers (`z-50`), and modals
(`z-[51]+`). Sitting above the drawer would block clicks on drawer
`CollapsibleSection` headers in the legend's overlap zone — confirmed in
the #474 pipeline as the cause of subtasks / skill-assignment / task-drawer
E2E timeouts.

### Responsive behavior

`hidden lg:block` — fully hidden below 1024px (the Tailwind `lg` breakpoint, custom
config). Matches the existing TopBar pill collapse convention. Mobile schedule
viewing is a read-only context where the legend is least useful and obscures the
most.

### Collapsed/expanded structure

- **Expanded** (default): rounded card, `bg-neutral-surface-raised`,
  `border border-neutral-border` (no shadow per design rule 1), header chip with
  "Legend ▾" toggle, body with six rows in a 2-column grid (3 × 2).
- **Collapsed**: only the header chip remains visible (`Legend ▸`); the body is
  unmounted.
- Toggle button: `<button aria-expanded aria-controls="schedule-legend-body">`;
  body: `<div role="region" aria-labelledby="schedule-legend-chip" hidden={!isOpen}>`.
  Mirrors `CollapsibleSection.tsx` (ADR-0040 canonical pattern) but with the
  chip-and-floating-panel composition appropriate for a free-floating overlay
  rather than an in-flow section.

### Persistence

New hook `useScheduleLegendCollapsed` in `packages/web/src/hooks/`, modeled on
`useBoardToolbarPrefs` (ADR-0057 child B): inline `read()` / `write()` helpers,
`useState` init from storage, `StorageEvent` listener for cross-tab sync.

Storage key: `trueppm.schedule.legend.collapsed.v1` (scalar boolean). Single key,
not a structured prefs bag, because the only persisted preference today is the
collapsed state — promoting to a bag is premature per ADR-0056 ("extraction is a
refactor concern").

### PDF export

For v1: **the legend is outside any PDF export by default**, because no schedule
PDF export pipeline exists. The legend is a DOM sibling of the canvas, not inside
it; any future export pipeline (whether canvas `toDataURL()` for the bars or
`html-to-image` per ADR-0062) would have to explicitly include the legend's
container to capture it. Default is exclusion, which is exactly what Sarah needs.

If a future ADR adds a board-ready PDF export pipeline (Marcus/Janet need), it
can be designed to opt-in include the legend at that point — without changes
to this feature.

### Component organization

Lives in the schedule feature directory:
`packages/web/src/features/schedule/ScheduleLegend.tsx`. Not extracted to
`src/components/` because there is no second consumer today. If Alex's "reuse on
Sprint burndown" suggestion is acted on later, the extraction is a small refactor
gated by YAGNI per ADR-0051.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Floating overlay, bottom-left, lg+ only (chosen)** | Matches issue spec; discoverable on first visit; clear z-index slot; PDF-export-safe by default | Adds one more `absolute`/`fixed` element to manage; viewport guardrails needed |
| B. Toolbar-integrated toggle that opens a popover | Cleaner architecture; zero z-index complexity; matches `CollapsibleSection` and chip-popover patterns | Not visible by default → defeats the first-week-onboarding motivation; user must click to discover the legend |
| C. Static legend below the canvas (always visible, in-flow) | No overlay z-index concerns; trivially excludable from canvas exports | Consumes vertical real estate permanently; obscures the unscheduled gutter; can't collapse to recover space |
| D. Tooltip-on-hover per element (no persistent legend) | No always-on UI | Discovery requires the user to hover the right pixel to learn what it is — bad first-run experience; AC requires persistent visibility |

## Consequences

- **Easier**: New users discover Gantt visual language in seconds; product support
  questions about "what does X mean" decrease.
- **Easier**: PDF export decisions for the schedule remain open — legend is outside
  the canvas DOM by default, so any future export pipeline starts from "explicitly
  include" rather than "explicitly exclude."
- **Harder**: One more floating overlay competes for screen real estate at
  narrow-but-still-lg widths (1024px–1280px). Mitigated by bottom-left placement
  and 2-column compact layout (six rows, not a tall list).
- **Risk**: Stale legend if visual language changes. Mitigation: the rendered
  legend samples are React components that import the same color tokens / sizes
  as the renderer where possible (e.g. the diamond color comes from the same token
  as the canvas milestone draw). Where the canvas uses raw shape drawing (the bars
  themselves), the legend uses Tailwind div primitives — divergence risk noted as
  a known limitation; visual regression testing via Playwright screenshot is the
  intended safety net.

## Implementation Notes

- P3M layer: **Programs and Projects** (single project schedule view, OSS)
- Affected packages: **web** only
- Migration required: no
- API changes: no
- OSS or Enterprise: **OSS** (`packages/web` only)

### Durable Execution
1. Broker-down behaviour: **N/A** — pure frontend UI, no backend dispatch.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no DB rows or transactions.
4. Service layer: **N/A** — no API surface.
5. API response on best-effort dispatch: **N/A** — no API surface.
6. Outbox cleanup: **N/A** — no outbox writes.
7. Idempotency: **N/A on backend.** Frontend: `useScheduleLegendCollapsed` writes
   are last-write-wins per browser tab; `StorageEvent` synchronizes other tabs.
   No concurrency hazard because the value is scalar boolean and the user is the
   only writer.
8. Dead-letter / failure handling: **N/A** — `localStorage` write failures
   (quota / private-mode) degrade silently to "collapsed state not persisted";
   the in-memory `useState` continues to work for the current session. No
   user-visible error surface needed.
