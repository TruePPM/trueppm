# Rule 98 — Resource rows are sorted alphabetically by resource_name

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**Resource rows are sorted alphabetically by `resource_name`.** The API returns them
pre-sorted; the frontend must not re-sort. Unassigned task count (`unassigned_task_count`)
is displayed in the toolbar as `"{N} task(s) without resource assignment"` in
`text-semantic-at-risk` when N > 0, hidden when N = 0.
