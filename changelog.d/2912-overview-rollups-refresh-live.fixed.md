The project Overview's KPI cards, health chip, blocked-task rollup and critical-path
panel now refresh when a collaborator edits a task or a CPM recompute completes. They
were invalidated by no WebSocket event at all, so with a 60-second stale time and no
refetch-on-focus they sat unchanged until the route was remounted — and a stale critical
path looks exactly like a current one.
