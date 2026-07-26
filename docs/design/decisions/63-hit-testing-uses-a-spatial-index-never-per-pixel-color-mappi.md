# Rule 63 — Hit testing uses a spatial index — never per-pixel color mapping

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Canvas Rendering*

**Hit testing uses a spatial index — never per-pixel color mapping.**
The `HitIndex` array is indexed by `rowIndex` and rebuilt on data change or
zoom change (O(n), < 1ms for 2,000 tasks). Hit zones per row:
- Bar body: `[barLeft, barRight]` × `[barTop, barBottom]`
- Resize handle: `[barRight - 8, barRight + 4]` logical px (expand to 20px on touch)
- Link-dot: `[barRight + 4, barRight + 16]` × full row height (expand to 44px on touch)
