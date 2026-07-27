# Rule 99 — Load tooltip on cell hover shows hours + task list

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**Load tooltip on cell hover shows hours + task list.** Hovering any cell with load > 0
opens `LoadTooltip` containing: total hours for that day, capacity hours, percentage,
and a bulleted list of task names contributing to the load. The tooltip is positioned
above the cell and uses `role="tooltip"` with `aria-describedby` wiring. It must
dismiss on `Escape` and on pointer-leave.
