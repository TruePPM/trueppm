# Rule 105 — Board keyboard move alternative is mandatory

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Board / Kanban View Rules (Issue #21)*

**Board keyboard move alternative is mandatory** — drag-and-drop is not keyboard accessible
 (known WCAG 2.1.1 gap, parallel to Gantt rule 34). Every card's `···` overflow menu **must**
 include a "Move to…" item that opens a submenu listing the other columns. Arrow keys
 navigate the submenu; Enter commits. An `aria-live="polite"` region announces the result:
 `"{task name} moved to {column name}"`. This is not optional — it is the only keyboard path
 to change task status from the board.
