- **Schedule drag preview now respects progress**: the in-browser CPM preview
  ignored ADR-0132, so rescheduling anything in or downstream of an in-flight
  chain forecast a slip the server then contradicted. Completed work with
  recorded actuals is now pinned (it never moves, and it stops the ripple the way
  the scheduler does), in-progress work contributes only its remaining duration
  rather than its full estimate, its start is floored at the day work actually
  began, and a drop in the past is floored at the project's data date. The
  milestone-impact readout during a drag or keyboard nudge now matches what the
  recalculation commits.
