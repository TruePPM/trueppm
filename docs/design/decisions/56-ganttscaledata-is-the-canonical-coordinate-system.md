# Rule 56 — GanttScaleData is the canonical coordinate system

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Architecture*

**`GanttScaleData` is the canonical coordinate system** — `dateToLeft`,
`leftToDate`, and `parseUTCDate` from `engine/GanttScaleData.ts` are the only
permitted coordinate utilities. Do not use SVAR's `scales.diff()`, the old
`dateFromCanvasLeft`, or any millisecond-approximation math. The new functions
are DST-safe (UTC-only arithmetic).
