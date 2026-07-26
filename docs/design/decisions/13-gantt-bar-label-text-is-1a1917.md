# Rule 13 — Gantt bar label text is #1A1917

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Gantt-Specific Rules*

**Gantt bar label text is `#1A1917`** (`neutral-text-primary`) — the Schedule view uses a light surface. Canvas bar label: `ctx.fillStyle = COLOR.text` from `GanttRenderer.ts`. SVAR CSS var: `--wx-gantt-task-color: #1a1917`.
