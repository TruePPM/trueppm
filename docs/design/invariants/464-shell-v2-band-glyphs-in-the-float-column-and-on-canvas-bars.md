# Rule 464 — On shell v2 the critical and near-critical bands are written as glyphs in the Float column and on the bar, not only as a frame color

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Schedule*. The index carries the rule's headline; this file carries its full text (#5106).

**Under `shell_v2`, the Total float cell prints `▲ 0d` for a critical task and `◆ Nd` for a near-critical one; a near-critical bar draws a `◆` at its left end; and a dependency whose two ends are both critical strokes solid critical-red. All three read the same predicate the frame and the drawer use (`isNearCriticalByFloat`), and none is drawn on v1.**

**Why.** The frame separates the bands by dash pattern and hue, and a grid column that shows only a number makes the reader cross-reference two panes. A glyph in the cell and on the bar is a second non-hue carrier (WCAG 1.4.1) and lets the grid agree with the canvas row for row. The red connector exists so the path reads as one line; on v1 connector color carries no meaning (rule 73), so the change is gated.

**How to apply.** Add a band to the canvas and the column together, from `isNearCriticalByFloat`, never from a second threshold. The cell's accessible name stays the spoken float ("Total float: 0 working days"); the glyph is decoration on top of it. Reference: `TaskFloatCell` in `TaskListRow.tsx`, `drawTaskBar` and `arrowPen` in `GanttRenderer.ts`.
