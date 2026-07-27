# Rule 77 — TaskSoA (Structure of Arrays) is required at 10,000+ tasks (Phase 3)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Performance*

**`TaskSoA` (Structure of Arrays) is required at 10,000+ tasks (Phase 3).**
For Phase 1–2 (≤ 2,000 tasks), a plain `Task[]` array is acceptable.
Do not introduce SoA prematurely — the abstraction cost is not justified
below 10k tasks.
