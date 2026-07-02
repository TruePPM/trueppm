`monte_carlo()` now agrees with `schedule()` on tasks marked 100% complete with no
recorded `actual_finish`: previously such a task collapsed to a single working day
in the probabilistic forecast while the deterministic schedule laid it out at full
duration, disagreeing by several working days on identical input (#1565).

`monte_carlo()` also no longer silently simulates a project with per-task calendars
(`Project.calendars`, ADR-0120) on the wrong calendar. It now raises
`InvalidScheduleInput` for such a project rather than returning P50/P80/P95 dates
that disagree with `schedule()`; per-task calendars remain fully supported by the
deterministic pass (#1566).
