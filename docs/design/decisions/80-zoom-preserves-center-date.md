# Rule 80 — Zoom preserves center date

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**Zoom preserves center date** — when `engine.setZoom()` is called, the engine
computes the canvas-origin coordinate of the viewport center before zoom and
calls `container.scrollLeft` to restore it after `scales-change`. The visible
date range shifts symmetrically around the user's current view midpoint.
