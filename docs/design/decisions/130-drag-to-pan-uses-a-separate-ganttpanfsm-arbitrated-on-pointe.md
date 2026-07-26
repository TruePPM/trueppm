# Rule 130 — Drag-to-pan uses a separate GanttPanFSM arbitrated on pointerdown

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Schedule View Interaction Rules (Issues #351 / #491)*

**Drag-to-pan uses a separate `GanttPanFSM` arbitrated on pointerdown.** When Space is held OR the middle button (`e.button === 1`) is pressed, the pan FSM claims the gesture and the task-bar drag FSM (`GanttDragFSM`) is bypassed entirely; otherwise drag behaves as before. Pan moves both axes (clamp `scrollLeft`/`scrollTop` to `[0, max]`); vertical pan flows to the task list via the existing `taskListScrollRef` scroll-sync, so no extra wiring. Only the timeline canvas pans — the left task-list pane never initiates a pan, and Space there does nothing pan-related.
