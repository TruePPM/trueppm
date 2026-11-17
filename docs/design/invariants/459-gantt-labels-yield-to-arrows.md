# Rule 459 — A canvas Gantt label that would overdraw higher-priority geometry is suppressed, never truncated or moved

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md). The index carries the headline; this file carries the full text. Specified in [ADR-1413](../adr/1413-gantt-label-placement.md).

**On-bar task-name labels are the lowest-priority paint on the bars layer.** Priority, highest first: bars, dependency arrows (arrowheads and vertical segments that pass through the label's row), labels already drawn, then the label being placed. A label whose measured run overlaps a higher-priority keep-out is omitted for that frame. Do not truncate it to dodge the arrow, and do not slide it to another position: a half-drawn name is worse than an absent one when the outline already carries every name. A task's own exit stub is not a keep-out (it would suppress every label); the label halo handles it.

New text drawn on the bars layer goes through the same measure-and-check path (`drawTaskBarLabel` / `labelFits` in `GanttRenderer.ts`), not a bare `fillText`.
