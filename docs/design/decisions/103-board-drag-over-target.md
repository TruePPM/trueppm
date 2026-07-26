# Rule 103 — Board drag-over target

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Board / Kanban View Rules (Issue #21)*

**Board drag-over target** — `bg-brand-primary/5` fill + `border-l-2 border-brand-primary`
 on the column container during an active drag. Applied on `pointerenter` over the column drop
 zone; removed on `pointerleave` and `pointerup`. Never highlight the source column while a
 drag is in progress.
