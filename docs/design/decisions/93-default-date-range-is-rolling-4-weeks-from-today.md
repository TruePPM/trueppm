# Rule 93 — Default date range is rolling ±4 weeks from today

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**Default date range is rolling ±4 weeks from today.** On first render, `window_start` =
Monday of (today − 4 weeks) and `window_end` = Sunday of (today + 4 weeks). A
**"Fit to project"** button in the toolbar resets the range to
`[project.start_date, max(task.early_finish)]`. After "Fit to project" is clicked,
the button label changes to "Reset to today" until the user navigates away.
