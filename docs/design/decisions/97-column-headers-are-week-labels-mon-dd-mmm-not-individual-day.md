# Rule 97 — Column headers are week labels (Mon DD MMM), not individual day labels

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**Column headers are week labels (Mon DD MMM), not individual day labels.** The grid
groups days into ISO weeks. Each column header shows the Monday of that week formatted
as `"Mon 2 Mar"`. Individual day cells are 32px wide; the week header spans 7 × 32px.
Weekends are rendered at 50% opacity — they are never working days in the default
calendar but are shown for date continuity.
