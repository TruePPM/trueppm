# Rule 54 — GanttEngine is the sole integration boundary

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Architecture*

**`GanttEngine` is the sole integration boundary** — `GanttView`, `useDragCpm`,
`useKeyboardReschedule`, `PreviewOverlay`, and `MonteCarloTimeline` hold a
`GanttEngine | null` reference and nothing else. No component may import from
`GanttEngineImpl` or any engine sub-module directly — only through
`src/features/gantt/engine/index.ts`. Violations break the stable API contract.
