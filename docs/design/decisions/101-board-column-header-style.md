# Rule 101 — Board column header style

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Board / Kanban View Rules (Issue #21)*

**Board column header style** — same token as Sidebar section headers (rule 36):
 `text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary`.
 Column count badge: `ml-2 text-neutral-text-disabled`. Column headers are `<h2>`
 elements with `aria-label` matching the visible text (e.g. `aria-label="In Progress, 12 tasks"`).
