Transactional outbox for CPM recalculation: task-graph writes now insert a
`ScheduleRequest` row in the same DB transaction, so a broker outage no longer
causes 500 errors or silently drops recalculation requests. A Celery Beat drain
task dispatches pending rows every 30 seconds and recovers orphaned rows after
10 minutes. Nightly purge keeps the outbox table lean.
