Query-count regression guard for `GET /api/v1/tasks/` — the hot Gantt fetch is
now asserted invariant to the number of tasks, closing the N+1 class on the
widest serializer in the codebase. The existing task-list guards scaled
milestones, not tasks.
