# ADR-0284: Board backlog stays project-level; reject phase-column backlog (collapse clarifications)

## Status
Accepted — amends [ADR-0192](0192-board-viewability-overhaul.md) (Board Viewability Overhaul).

> **Note on numbering.** This decision was filed as issue #1698 under the provisional
> label "ADR-0277". That number was taken by the schedule-PDF risk-border ADR before
> this one was written; the decision is recorded here as **ADR-0284** (reserved for the
> #1698 worktree). No content changed — only the number.

## Context

Issue #1698 is part of #1457 (Board viewability overhaul) and follows the shipped
column-collapse-to-stub work (#1459, ADR-0192). The imported Claude Design file
**"Board Column Collapse-to-Stub"** (project TruePPM, via DesignSync) drew **Backlog as
`BV_COLS[0]` — a normal collapsible grid column**.

Because the board grid is **phase-rows × status-columns**
(`packages/web/src/features/board/BoardView.tsx`), a Backlog *column* implies a
**phase-level backlog**: one backlog cell per WBS swimlane. That contradicts shipped
behavior — [ADR-0057](0057-board-backlog-band-and-progress-gates.md) makes Backlog a **project-level rail**
pulled out of the phase grid (`BacklogBand`) — and it was rejected by all three review
gates before any code was written.

**VoC panel — unanimous 🔴 on phase-fragmentation** (Jordan/PO, Alex/SM, Morgan/Coach,
Sarah/PM, Marcus/PMO). Fragmenting the single ranked intake pool into N per-WBS-phase
pools is a backlog-ownership / team-autonomy violation: the PM's WBS would gate a
PO/team-owned artifact, and it is strictly worse for portfolio-level unscheduled-demand
rollup. The three backlog scopes that already exist are correctly separated and owned by
different people:

- **Sprint backlog** — `Task.sprint` (Scrum Master / team, per sprint).
- **Program intake pool** — `BacklogItem` ([ADR-0069](0069-dual-level-backlog-program-backlog-item-and-project-backlog.md), Product
  Owner, ranked).
- **Project delivery board** — the phase×status grid (PM).

A third, phase-scoped backlog home is not wanted. Phase-based backlog triage, if it is
ever wanted, is a **filter over the pool**, never a structural re-home of it.

The design file also schematized "3 open columns widen to fill" on collapse, which
conflicts with ADR-0192's fixed-width sticky-grid model.

## Decision

Record four clarifications amending ADR-0192; formally reject the design's phase-column
backlog.

1. **Backlog stays project-level.** The `BacklogBand` rail (ADR-0057) is a peer region
   **outside** the phase×status grid. The design's phase-column backlog
   (`Backlog = BV_COLS[0]`) is rejected. Backlog is never a status column.

2. **Collapse / view-state persistence stays client-side.** Per-user, per-project
   `localStorage` (house convention: web-rule 199, ADR-0192, `schema_version` per
   [ADR-0086](0086-schema-version-convention-for-user-saved-json-state.md)). `BoardColumnConfig`
   (project-shared) must **never** carry per-user collapse state. Cross-device server
   sync of view state is a possible **future** follow-up, explicitly **out of 0.4**.

3. **Width-reclaim stays fixed-px tracks.** Collapsing a column removes horizontal
   overflow; open columns do **not** widen-to-fill. The design's "columns widen to fill"
   schematic is a non-goal — it would undermine ADR-0192's fixed-width sticky-grid,
   pinned-header, and zoom model.

4. **WIP breach is always-on for stubs** (see #1695): a collapsed column that breaches its
   WIP limit still surfaces the breach on its stub. The backlog rail's collapsed strip
   shows an always-visible live count.

**Durable execution: N/A** — pure client-side UI. No async work, no writes, no broadcasts.

**Edition: OSS** — single-project board ergonomics; no enterprise / extension-point
surface.

## Consequences

- The Claude Design source ("Board Column Collapse-to-Stub") is corrected to show Backlog
  as the project-level rail rather than `BV_COLS[0]`, so future imports do not
  re-introduce the rejected structure.
- Implementers of the remaining #1457 delta set (#1695 WIP-on-stub, #1696 your-cards
  signal, #1697 hollow-0 empty stub) treat status columns as fixed-px, collapse-state as
  client-side, and Backlog as a rail — no phase-column backlog appears in any of them.
- If phase-scoped backlog triage is ever requested, it is designed as a **filter** over
  the existing single pool, and this ADR is the reference for why it is not a structural
  column.

## Follow-up (NOT 0.4)

Backlog-rail collapsed-strip "your cards here" signal (design Delta 5) is **deferred**:
the intake pool should stay free of individual-assignment pressure (Jordan/Morgan) unless
testing shows people lose pulled-but-uncommitted cards. File separately when prioritized.
