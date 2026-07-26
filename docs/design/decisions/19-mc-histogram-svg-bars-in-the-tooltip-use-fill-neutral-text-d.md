# Rule 19 — MC histogram SVG bars in the tooltip use fill-neutral-text-disabled

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Monte Carlo Row Rules*

**MC histogram SVG bars in the tooltip use `fill-neutral-text-disabled`** — distribution shape is neutral; semantic colours are reserved for the P50/P80/P95 vertical rule lines inside the tooltip. The same rule applies to the histogram inside `MonteCarloSheet` (mobile) and `MCResultPanel` (TopBar P80 click).
