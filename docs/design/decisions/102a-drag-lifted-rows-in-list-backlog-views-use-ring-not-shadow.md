# Rule 102a — Drag-lifted rows in list/backlog views use ring, not shadow

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Board / Kanban View Rules (Issue #21)*

**Drag-lifted rows in list/backlog views use ring, not shadow.** A sortable row in the
 dragging state (e.g. the Product Backlog grooming view) uses `ring-2 ring-brand-primary
 opacity-60` — never `shadow-*` (rule 1). This mirrors the Board card drag treatment (rule
 102) so the shadow prohibition is not reintroduced piecemeal on each new sortable list.
 The drag handle is a `min-h-[44px] min-w-[44px]` button (rule 5 touch target) carrying the
 dnd-kit listeners, with an `aria-label` and the rule-4 `focus-visible` ring; the row stays
 clickable. Fixed-column list grids that exceed a phone's width wrap their header + rows in a
 `min-w-max` container inside an `overflow-auto` shell so columns stay aligned under
 horizontal scroll rather than compressing and misaligning.
