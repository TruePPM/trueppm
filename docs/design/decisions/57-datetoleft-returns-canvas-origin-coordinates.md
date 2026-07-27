# Rule 57 — dateToLeft returns canvas-origin coordinates

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Architecture*

**`dateToLeft` returns canvas-origin coordinates** — the result is px from the
canvas x=0 origin, not viewport-relative. Subtract `engine.scrollLeft` when
positioning DOM overlay elements (e.g. `PreviewOverlay`, `MilestoneDeltaTooltip`).
Pass canvas-origin coordinates directly to CPM workers and drag event handlers.
