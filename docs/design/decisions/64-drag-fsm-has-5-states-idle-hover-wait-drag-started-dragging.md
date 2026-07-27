# Rule 64 — Drag FSM has 5 states: IDLE → HOVER_WAIT → DRAG_STARTED → DRAGGING → DROP/CANCELLED

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Interaction*

**Drag FSM has 5 states: IDLE → HOVER_WAIT → DRAG_STARTED → DRAGGING → DROP/CANCELLED.**
The 4px movement threshold between HOVER_WAIT and DRAG_STARTED prevents
accidental drags on clicks and tap-and-hold on iPad. `setPointerCapture` is
called at DRAG_STARTED to ensure `pointermove` fires outside the canvas.
