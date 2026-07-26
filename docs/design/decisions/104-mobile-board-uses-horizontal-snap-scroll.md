# Rule 104 — Mobile board uses horizontal snap scroll

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Board / Kanban View Rules (Issue #21)*

**Mobile board uses horizontal snap scroll** — `scroll-snap-type: x mandatory` on the board
 container; each column `scroll-snap-align: start`; column width `85vw`. A dot-strip indicator
 (`role="tablist"` with one `role="tab"` per column, `aria-selected` on the visible column)
 sits below the board and updates on scroll. Never use a column-picker dropdown on mobile — it
 hides spatial context. The mobile FAB creates a task in the currently-visible column's status,
 following the same pattern as the Risk Register FAB (rule 90).
