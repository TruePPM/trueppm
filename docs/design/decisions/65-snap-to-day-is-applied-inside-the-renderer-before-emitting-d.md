# Rule 65 — Snap-to-day is applied inside the renderer before emitting drag-task-move

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Interaction*

**Snap-to-day is applied inside the renderer before emitting `drag-task-move`.**
The `left` value in the event payload is always snapped to the nearest UTC
midnight boundary. Holding Shift suspends snap (free-drag). `useDragCpm` must
not snap independently — do not double-snap.
