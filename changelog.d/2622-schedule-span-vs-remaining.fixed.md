Fixed the Schedule view drawing an in-progress task's remaining-work window
instead of its full span: a 4-day task at 83% complete rendered as a single
day, indistinguishable from the estimate itself having been cut, because the
Gantt bar's geometry and the progress fill inside it were both computed from
the same already-shrunken window (ADR-0752). The bar now keeps its full
planned length and the fill advances inside it as work progresses — the
convention most PMs already expect from other scheduling tools.

Added `scheduled_start` (and a computed `scheduled_finish`/`remaining_duration`
pair) to the task API, serializers, and sync payload: `early_start`/
`early_finish` keep naming the CPM engine's remaining-work window (unchanged
since ADR-0132), and `scheduled_start` now separately names the task's span
start, so a consumer no longer has to know a task's status to know what its
date fields mean. The task detail drawer's Duration cell gained a "Nd left"
qualifier chip that shows only once a task's remaining work has shrunk below
its full estimate.

Read-only share links (`/share/schedule/:token`) now include `scheduled_start`
so the public Gantt draws the same span the authenticated product does,
rather than a shrinking remaining-work-window bar — for an in-progress task
this is the same fact as `actual_start`, which the projection otherwise
withholds; the widening is deliberate and documented at the projection
(#2622).
