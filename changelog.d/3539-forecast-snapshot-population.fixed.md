- **Project forecast snapshots described a schedule that was never computed**: the
  forecast-history capture aggregated the CPM finish date and the tightest total float
  over *every* non-deleted task, rather than over the committed set the scheduling engine
  is actually run on. Because a task groomed back to the backlog keeps whatever dates it
  carried when it was last scheduled, a single stale row could hold the project's finish
  date open or invent slack a project did not have — one project reported a finish six
  days later than its committed work, another reported 30 days of float with none in its
  plan. The same figure drives the "project end date shifted" notification, so the wrong
  population could also email a project's owners about a shift that never happened, and
  hide a real one. Snapshots (and their task counts) are now taken over the committed set.

  **On upgrade, expect one corrected end-date notification per affected project.** Every
  forecast snapshot already in your database was recorded under the old population, and
  the shift notification compares a new snapshot against the previous one — so the first
  capture after upgrading reports the correction as a shift. It is a one-time effect, the
  date it delivers is the correct one, and it does not repeat.
