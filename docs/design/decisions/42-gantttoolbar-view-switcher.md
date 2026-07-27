# Rule 42 — GanttToolbar view-switcher

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**GanttToolbar view-switcher** (Gantt · WBS · Table) uses `role="group" aria-label="View mode"` with `aria-pressed` on the active item. Action buttons (+ Task · Baseline · Monte Carlo) are plain `type="button"` elements. All toolbar buttons: `border border-neutral-border rounded h-7 px-3 text-xs font-medium`. WBS and Table render as `disabled aria-disabled="true"` until their panels are implemented.
