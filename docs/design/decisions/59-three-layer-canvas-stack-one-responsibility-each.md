# Rule 59 — Three-layer canvas stack — one responsibility each:

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Canvas Rendering*

**Three-layer canvas stack — one responsibility each:**
- `canvas-bg` (z-index 0): row bands, grid lines, today line, weekend shading. Rarely repaints.
- `canvas-bars` (z-index 1): task bars, dependency arrows, float bars, baseline ghosts. Dirty-rect per row.
- `canvas-interaction` (z-index 2): active drag shadow, resize highlight, link-creation preview. Cleared completely between frames.
Never draw task bar content on `canvas-bg` or interaction chrome on `canvas-bars`.
