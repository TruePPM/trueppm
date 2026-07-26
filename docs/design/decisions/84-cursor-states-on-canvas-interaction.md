# Rule 84 — Cursor states on canvas-interaction

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**Cursor states on canvas-interaction** — `ixCanvas.style.cursor` is set by
`GanttEngineImpl._updateCursor()` based on FSM state and hit zone type:
`grab` over bar body, `col-resize` over resize handle, `crosshair` over
link-dot, `grabbing` during active drag, `default` otherwise. Never set
cursor on bg or bars canvas layers.
