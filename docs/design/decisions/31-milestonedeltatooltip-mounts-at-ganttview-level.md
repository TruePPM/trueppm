# Rule 31 — MilestoneDeltaTooltip mounts at GanttView level

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Drag Preview Rules (Issue #19)*

**MilestoneDeltaTooltip mounts at GanttView level** — not inside GanttTimeline, to escape `overflow:hidden`.
