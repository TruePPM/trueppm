# Rule 91 — Cell display is load % bars — not task bars

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**Cell display is load % bars — not task bars.** Each cell in the resource grid shows a
single filled bar representing load as a percentage of capacity. Task bars (mini) are not
the default; they may only appear in a drill-down tooltip. Color thresholds:
- Green (`semantic-on-track`): load < 85% of capacity
- Amber (`semantic-at-risk`): 85% ≤ load ≤ 100%
- Red (`semantic-critical`): load > 100% (overallocated)
Never invert this color scheme. Red must mean overallocation without exception.
