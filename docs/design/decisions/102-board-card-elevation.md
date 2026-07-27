# Rule 102 — Board card elevation

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Board / Kanban View Rules (Issue #21)*

**Board card elevation** — `bg-neutral-surface border border-neutral-border rounded-md p-3`.
 No shadow (rule 1). Drag-lifted state: `ring-2 ring-brand-primary opacity-60 scale-105`
 with `motion-safe:rotate-1`. The original slot shows a dashed placeholder of equal height
 (`border-2 border-dashed border-neutral-border rounded-md`). Never animate the card on entry —
 only the lifted (drag) and snap-back (error) states animate.
