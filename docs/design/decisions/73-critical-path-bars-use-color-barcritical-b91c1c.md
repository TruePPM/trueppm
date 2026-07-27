# Rule 73 — Critical path bars use COLOR.barCritical (#B91C1C)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Visual Design (Canvas)*

**Critical path bars use `COLOR.barCritical` (`#B91C1C`)** — `semantic-critical` on light surface. Complete bars use `COLOR.barComplete` (`#3E8C6D` = sage-600, brand on-track per ADR-0103; `#66B998` sage-400 on dark) — `semantic-on-track`. Both values are defined once in `GanttRenderer.ts`; update there only.
