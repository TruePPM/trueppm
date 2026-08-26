- **Task creation duplicate on retry**: if a new task saved but its assignee/dependency
  sync failed, pressing Save again to retry re-created the task instead of retrying
  the failed sync, leaving a duplicate row. Retrying now reuses the already-created
  task and only retries the assignment/dependency sync.
