- **Blocker chip queued state now visible to read-only viewers**: a task blocked
  while offline (ADR-0247) showed its "queued" age and pending-sync badge only
  in the editable blocker view. A viewer without edit rights on the task saw
  the "Blocked" badge with no age and no indication the flag hadn't reached the
  server yet. The read-only chip row now shows the same queued/pending-sync
  state as the editable one.
