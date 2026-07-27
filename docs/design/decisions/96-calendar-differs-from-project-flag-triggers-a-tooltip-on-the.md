# Rule 96 — calendar_differs_from_project flag triggers a tooltip on the resource name

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**`calendar_differs_from_project` flag triggers a tooltip on the resource name.**
When `resource.calendar_differs_from_project === true`, render a `ⓘ` icon next to
the resource name. The `CalendarMismatchTooltip` reads: "This resource uses a different
calendar than the project. Load is computed from the resource's calendar." Never
suppress this flag silently.
