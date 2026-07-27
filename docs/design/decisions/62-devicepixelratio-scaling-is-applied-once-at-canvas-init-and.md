# Rule 62 — devicePixelRatio scaling is applied once at canvas init and on ResizeObserver

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Canvas Rendering*

**`devicePixelRatio` scaling is applied once at canvas init and on `ResizeObserver`.**
All logical coordinates (bar positions, hit zones, font sizes) use logical pixels.
The canvas backing store is scaled by `window.devicePixelRatio`. Never scale
individual draw calls — scale the context once via `ctx.scale(dpr, dpr)`.
