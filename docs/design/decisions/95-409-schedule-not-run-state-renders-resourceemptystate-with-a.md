# Rule 95 — 409 "schedule not run" state renders ResourceEmptyState with a scheduler CTA

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Resource Utilization View Rules (Issue #22)*

**409 "schedule not run" state renders `ResourceEmptyState` with a scheduler CTA.**
When the API returns HTTP 409, show the empty-state component with the message
"Run the scheduler to see resource utilization" and a "Run Scheduler" button that
triggers a CPM recalculation. Do not show a generic error toast for 409.
