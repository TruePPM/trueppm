# Rule 78 — Empty state on zero tasks

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**Empty state on zero tasks** — `GanttEmptyState` component renders when
`tasks.length === 0`. Uses `bg-neutral-surface` and `role="status"`
so screen readers are informed. Never render the canvas stack with no tasks.
