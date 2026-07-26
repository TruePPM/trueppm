# Rule 83 — Selection visual

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**Selection visual** — in the canvas bars layer: a 2px `COLOR.selectionRing` (**navy `#1B2A4A`** light / **reversed `#E9EDF3`** dark) inset stroke ring is drawn after the bar fill using `ctx.save()/restore()` (rule 59, canvas-bars layer only). The ring is navy INK — not sage — so it stays visible on a sage complete bar (distinguishability triad, ADR-0103 D4: complete = sage fill, selected = navy ring, today = sage line). In the task list row: `bg-brand-primary/10 border-l-2 border-brand-primary` (sage) on the selected row. Selection state is read from `engine.selectedTaskIds` (immutable Set) — never duplicated in local component state.
