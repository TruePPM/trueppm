# Rule 100 — ResourceGrid uses CSS Grid, not canvas

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**ResourceGrid uses CSS Grid, not canvas.** Unlike the Gantt (rule 59), the resource
 grid is a standard HTML/CSS layout: `display: grid` with `grid-template-columns`
 driven by the date window. Row virtualization is not required for the initial
 implementation (projects have ≤ 50 resources). Do not apply canvas-rendering rules
 (rules 59–85) to the resource grid.
