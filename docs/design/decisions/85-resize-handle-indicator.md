# Rule 85 — Resize handle indicator

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**Resize handle indicator** — when hovering over a resize handle hit zone, a 1px
vertical line is drawn on canvas-interaction at `barRight - 4` px, spanning the
full bar height (`BAR_TOP_OFFSET` to `BAR_TOP_OFFSET + BAR_HEIGHT`). Color:
`COLOR.textSecondary` (`#6B6965`). This meets WCAG 1.4.11 (3:1 against `neutral-surface`). Drawn by `drawResizeIndicator()` in GanttRenderer.ts.
