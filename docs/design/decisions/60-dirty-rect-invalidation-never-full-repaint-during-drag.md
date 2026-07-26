# Rule 60 — Dirty-rect invalidation — never full-repaint during drag

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Canvas Rendering*

**Dirty-rect invalidation — never full-repaint during drag.** On each drag-move
only the dragged row and the rows containing CPM preview results are invalidated.
A 500-task project must repaint ≤ 11 rows per frame during a typical drag.
Full repaints are only permitted on: zoom change, scroll > 1 viewport width,
window resize, baseline mode toggle.
